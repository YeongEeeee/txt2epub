// ════════════════════════════════════════════════
// epub-gen.js — EPUB3 생성 엔진 (최적화 v2)
// NovelEPUB | TXT → EPUB3
//
// 개선안 1: buildEpub 전체를 Blob Worker로 격리 (메인 스레드 비블로킹)
// 개선안 2: 이미지 처리를 Promise.all 병렬화 + 동시 처리 제한(concurrency)
// 개선안 3: JSZip streamFiles 최적화, 메모리 최소화
// 개선안 4: 루프 외부 정규식 사전 컴파일, GC 부하 최소화
//
// 의존성: JSZip (CDN), parser.js (escHtml, renderBodyHtml)
// 내보내는 심볼:
//   buildCss, generateTextCover, buildEpub, launchEpubWorker
//   setProgress, updateProgStep, xhtmlPage
// ════════════════════════════════════════════════

/* global JSZip, escHtml, renderBodyHtml, convertImageFile, fileToAB,
   document, crypto, extractChNum, customFontFace, Toast */

'use strict';

// ── toEm: em 단위 안전 처리 (모듈 레벨) ──
function toEm(val, def){
  if(!val) return def;
  const s=String(val).trim();
  if(/em$|px$|%$|rem$/.test(s)) return s;
  const n=parseFloat(s);
  return isNaN(n)?def:n+'em';
}

// ── getCssVar 헬퍼 ──
function getCssVar(name){
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}

// ── buildCss ──
function buildCss(){
  const font=document.getElementById('cssFont')?.value||'"Noto Serif KR",serif';
  const line=document.getElementById('cssLine')?.value||'1.9';
  const size=document.getElementById('cssFontSize')?.value||'1em';
  const padTop=   toEm(document.getElementById('cssPadTop')?.value,    '1.5em');
  const padBottom=toEm(document.getElementById('cssPadBottom')?.value,  '1.5em');
  const padLeft=  toEm(document.getElementById('cssPadLeft')?.value,    '1.8em');
  const padRight= toEm(document.getElementById('cssPadRight')?.value,   '1.8em');
  const textColor=document.getElementById('cssTextColor')?.value||'';
  const bgColor=  document.getElementById('cssBgColor')?.value||'';
  const align=document.querySelector('input[name="cssAlign"]:checked')?.value||'justify';
  const titleStyle=document.querySelector('input[name="cssTitleStyle"]:checked')?.value||'center';
  const indentSlider=document.getElementById('cssIndentSlider');
  const indentEm=indentSlider?parseFloat(indentSlider.value)||1.0:1.0;
  const useIndent=document.getElementById('optIndent')?.checked;
  const fontFaceBlock=typeof customFontFace!=='undefined'?customFontFace||'':'';
  const extra=document.getElementById('cssExtra')?.value||'';
  let h1Extra=`text-align:${titleStyle==='left'?'left':'center'};`;
  if(titleStyle==='underline') h1Extra+='border-bottom:2px solid currentColor;padding-bottom:0.3em;text-align:center;';
  if(titleStyle==='box') h1Extra+='border:1.5px solid currentColor;padding:0.25em 1em;border-radius:6px;display:inline-block;';
  return `@charset "UTF-8";\n${fontFaceBlock}\nbody{font-family:${font};line-height:${line};font-size:${size};margin:0;padding:${padTop} ${padRight} ${padBottom} ${padLeft};word-break:keep-all;overflow-wrap:break-word;text-align:${align};${textColor?'color:'+textColor+';':''}${bgColor?'background-color:'+bgColor+';':''}}\nh1{font-size:1.3em;${h1Extra}margin:1.2em 0 1.8em;font-weight:700;letter-spacing:-0.02em}\np{margin:0;padding:0.25em 0;text-indent:${useIndent?indentEm+'em':'0'}}\np.noindent{text-indent:0}\nem.flashback{font-style:italic;opacity:.85}\np.sysmsg{text-align:center;font-style:italic;opacity:.75;text-indent:0}\n.illust-page{display:flex;align-items:center;justify-content:center;min-height:80vh;text-align:center;padding:0}\n.illust-page img{max-width:100%;max-height:100vh;object-fit:contain}\n@media (prefers-color-scheme:dark){body{${bgColor?'':"background-color:#1a1208;"}${textColor?'':"color:#e8d8c4;"}}}\n${extra}`;
}

// ── UI 진행률 (메인 스레드 전용) ──
function setProgress(pct,msg){
  const bar=document.getElementById('progBar');
  const msgEl=document.getElementById('progMsg');
  if(bar) bar.style.width=pct+'%';
  if(msgEl) msgEl.textContent=msg;
  if(pct<=15)       updateProgStep(0);
  else if(pct<=30)  updateProgStep(1);
  else if(pct<=45)  updateProgStep(2);
  else if(pct<=92)  updateProgStep(3);
  else              updateProgStep(4);
}
function updateProgStep(activeStep){
  for(let i=0;i<=4;i++){
    const el=document.getElementById('pstep'+i); if(!el) return;
    el.classList.toggle('active', i===activeStep);
    el.classList.toggle('done', i<activeStep);
  }
  for(let i=0;i<4;i++){
    const ln=document.getElementById('pline'+i); if(!ln) return;
    ln.classList.toggle('done', i<activeStep);
  }
}

// ── 텍스트 표지 생성 (Canvas — DOM 필요) ──
function wrapText(text, maxWidth, fontSize){
  const lineH=fontSize*1.5, lines=[], words=text.split('');
  let cur='';
  for(const w of words){
    if((cur+w).length*fontSize*0.6<=maxWidth) cur+=w;
    else{ if(cur) lines.push(cur); cur=w; }
  }
  if(cur) lines.push(cur);
  return lines;
}
async function generateTextCover(title, author){
  return new Promise(resolve=>{
    const W=800, H=1120;
    const canvas=document.createElement('canvas');
    canvas.width=W; canvas.height=H;
    const ctx=canvas.getContext('2d');
    ctx.fillStyle=getCssVar('--bg')||'#fdf6ee';
    ctx.fillRect(0,0,W,H);
    ctx.fillStyle=getCssVar('--accent')||'#e05c4b';
    ctx.fillRect(0,0,W,16); ctx.fillRect(0,H-16,W,16);
    const tsz=72;
    ctx.font=`700 ${tsz}px serif`;
    ctx.fillStyle=getCssVar('--text')||'#2d1f14';
    ctx.textAlign='center';
    const tl=wrapText(title,W-120,tsz);
    const sy=(H/2)-(tl.length*tsz*1.5)/2;
    tl.forEach((l,i)=>ctx.fillText(l,W/2,sy+i*tsz*1.5));
    if(author){
      ctx.font=`400 42px serif`;
      ctx.fillStyle=getCssVar('--text2')||'#6b4f3a';
      ctx.fillText(author,W/2,sy+tl.length*tsz*1.5+60);
    }
    canvas.toBlob(b=>resolve(b),'image/jpeg',0.9);
  });
}

// ── xhtmlPage (메인 스레드 레거시 호환) ──
function xhtmlPage(title, body){
  return '<?xml version="1.0" encoding="utf-8"?><!DOCTYPE html>\n<html xmlns="http://www.w3.org/1999/xhtml"><head>\n<title>'+escHtml(title)+'</title>\n<link rel="stylesheet" type="text/css" href="../style.css"/>\n</head><body>\n'+body+'\n</body></html>';
}

// ══════════════════════════════════════════
// 개선안 2: 이미지 병렬 처리 (메인 스레드)
// ══════════════════════════════════════════
const IMG_CONCURRENCY = 4; // 동시 처리 제한

async function resizeCoverIfNeeded(file){
  const MAX_H=1200;
  return new Promise(resolve=>{
    const url=URL.createObjectURL(file);
    const img=new Image();
    img.onload=()=>{
      URL.revokeObjectURL(url);
      if(img.naturalHeight<=MAX_H){ resolve(file); return; }
      const ratio=MAX_H/img.naturalHeight;
      const canvas=document.createElement('canvas');
      canvas.width=Math.round(img.naturalWidth*ratio);
      canvas.height=MAX_H;
      const ctx=canvas.getContext('2d');
      ctx.fillStyle='#ffffff';
      ctx.fillRect(0,0,canvas.width,canvas.height);
      ctx.drawImage(img,0,0,canvas.width,canvas.height);
      canvas.toBlob(blob=>{
        if(!blob){resolve(file);return;}
        resolve(new File([blob],file.name,{type:'image/jpeg'}));
      },'image/jpeg',0.92);
    };
    img.onerror=()=>{URL.revokeObjectURL(url);resolve(file);};
    img.src=url;
  });
}

async function processImagesParallel(coverFile, illMap){
  const result = { cover: null, ills: [] };
  if(coverFile){
    try{
      const target = await resizeCoverIfNeeded(coverFile);
      const { blob, ext, mt } = await convertImageFile(target, true);
      result.cover = { ab: await fileToAB(blob), ext, mt };
    }catch(e){
      if(typeof Toast!=='undefined')
        Toast.warn(`표지 처리 실패 (건너뜀): ${coverFile.name||'표지'}`);
    }
  }
  const illFiles = illMap
    .map((il,i)=>({ il, file_idx: i }))
    .filter(({il})=>il&&il.file);

  for(let i=0;i<illFiles.length;i+=IMG_CONCURRENCY){
    const batch = illFiles.slice(i, i+IMG_CONCURRENCY);
    const batchRes = await Promise.all(
      batch.map(async ({il, file_idx})=>{
        try{
          const { blob, ext, mt } = await convertImageFile(il.file, false);
          return { ab: await fileToAB(blob), ext, mt, file_idx };
        }catch(e){
          if(typeof Toast!=='undefined')
            Toast.warn(`이미지 처리 실패 (건너뜀): ${il.file.name||'알 수 없는 파일'}`);
          return null;
        }
      })
    );
    // ★ null 제거 후 file_idx 기준 정렬 → 병렬 처리 후 순서 보장
    result.ills.push(...batchRes.filter(Boolean));
  }
  result.ills.sort((a,b)=>a.file_idx-b.file_idx);
  return result;
}

// ══════════════════════════════════════════
// 개선안 1: Worker Blob 소스 빌더
// ══════════════════════════════════════════
function _buildWorkerSrc(jszipUrl){
  // Worker 내부 코드를 안전하게 생성
  // 따옴표 충돌 없이 Worker 소스를 구성
  const esc = String.raw`
function escHtml(s){
  return s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}`;
  const body = [
    "'use strict';",
    "importScripts(" + JSON.stringify(jszipUrl) + ");",
    esc,
    // ★ 개선안 4: 루프 외부 정규식 사전 컴파일
    "const RX_AUTO_PAGE=/^\\(\\d+\\/\\d+\\)$/;",
    "const RX_CHAPTER_N=/^Chapter\\s+(\\d+)$/;",
    "const RX_PARENS=/\\((\\d+)\\/(\\d+)\\)/;",
    "function extractChNum(h){const m=h.match(/[0-9]+/);return m?parseInt(m[0],10):null;}",
    "function tocLabel(idx,h,c){if(c[idx])return h+' 삽화';if(RX_AUTO_PAGE.test(h)){const m=h.match(RX_PARENS);return m?m[1]+'페이지':h;}if(RX_CHAPTER_N.test(h)){const m=h.match(RX_CHAPTER_N);return m?m[1]+'화':h;}return h;}",
    "function makeMatchIll(idx,cn,body){return function(il){if(typeof il.idx==='number')return il.idx===idx;if(typeof il.ch==='number')return il.ch===cn;if(il.kw)return body.includes(il.kw);return false;};}",
  ].join('\n');

  const xhtmlFn = function xhtmlPage(t,b){
    return '<?xml version="1.0" encoding="utf-8"?><!DOCTYPE html>\n<html xmlns="http://www.w3.org/1999/xhtml"><head>\n<title>'+escHtml(t)+'</title>\n<link rel="stylesheet" type="text/css" href="../style.css"/>\n</head><body>\n'+b+'\n</body></html>';
  };

  const mainHandler = `
self.onmessage=async function(e){
  const{params,imageData,cssText}=e.data;
  const{title,author,chapters,illMapMeta,useItalic,showChTitle,compressionLevel,lang,uid,today,renderedBodies}=params;
  function prog(pct,msg){self.postMessage({type:'progress',pct,msg});}
  try{
    prog(5,'이미지 처리 중...');
    const zip=new JSZip();
    zip.file('mimetype','application/epub+zip',{compression:'STORE',compressionOptions:{level:0}});
    zip.folder('META-INF').file('container.xml','<?xml version="1.0"?><container version="1.0" xmlns="urn:oasis:schemas:container"><rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles></container>');
    const oebps=zip.folder('OEBPS'),imagesFolder=oebps.folder('Images'),textFolder=oebps.folder('Text');
    oebps.file('style.css',cssText);
    const imgStore=new Map();let imgIdx=0;
    if(imageData.cover){const{ab,ext,mt}=imageData.cover;const dest='img_'+String(imgIdx++).padStart(4,'0')+'.'+ext;imagesFolder.file(dest,ab);imgStore.set('cover',{filename:dest,mt});}
    for(const ill of imageData.ills){const{ab,ext,mt,file_idx}=ill;const dest='img_'+String(imgIdx++).padStart(4,'0')+'.'+ext;imagesFolder.file(dest,ab);imgStore.set(file_idx,{filename:dest,mt});}
    prog(15,'챕터 생성 중...');
    const manifestItems=[],spineItems=[];
    const coverInfo=imgStore.get('cover')||null;
    if(coverInfo){textFolder.file('cover.xhtml',xhtmlPage('표지','<div class="illust-page"><img src="../Images/'+coverInfo.filename+'" alt="표지"/></div>'));manifestItems.push({id:'cover_xhtml',href:'Text/cover.xhtml',mt:'application/xhtml+xml'});spineItems.push('cover_xhtml');}
    const chHasIll={};
    for(let idx=0;idx<chapters.length;idx++){const[h,b]=chapters[idx];const cn=extractChNum(h);const mfn=makeMatchIll(idx,cn,b);chHasIll[idx]=illMapMeta.some(mfn);}
    const tot=chapters.length;let illPageIdx=0;
    for(let idx=0;idx<tot;idx++){
      if(idx%20===0)prog(15+Math.floor(idx/tot*67),'챕터 생성 중 ('+idx+'/'+tot+')...');
      const[heading]=chapters[idx];const cn=extractChNum(heading);const body=renderedBodies[idx];
      const mfn=makeMatchIll(idx,cn,body);
      const beforeIlls=illMapMeta.filter(il=>mfn(il)&&il.pos!=='after').map(il=>il.file_idx);
      const afterIlls=illMapMeta.filter(il=>mfn(il)&&il.pos==='after').map(il=>il.file_idx);
      const isAutoPage=RX_AUTO_PAGE.test(heading)||heading==='본문'||RX_CHAPTER_N.test(heading);
      const showTitle=showChTitle&&!isAutoPage;
      if(heading!=='서문'){for(const fi_idx of beforeIlls){const fi=imgStore.get(fi_idx);if(!fi)continue;const fn='ill_'+String(illPageIdx++).padStart(4,'0')+'.xhtml';const iid='ill_'+String(illPageIdx-1).padStart(4,'0');textFolder.file(fn,xhtmlPage(heading+' 삽화','<div class="illust-page"><img src="../Images/'+fi.filename+'" alt="삽화"/></div>'));manifestItems.push({id:iid,href:'Text/'+fn,mt:'application/xhtml+xml'});spineItems.push(iid);}}
      const fname='chapter_'+String(idx).padStart(4,'0')+'.xhtml';const chid='ch_'+String(idx).padStart(4,'0');
      textFolder.file(fname,xhtmlPage(heading,(showTitle?'<h1>'+escHtml(heading)+'</h1>\\n':'')+body));
      manifestItems.push({id:chid,href:'Text/'+fname,mt:'application/xhtml+xml'});
      if(heading!=='서문')spineItems.push(chid);
      if(heading!=='서문'){for(const fi_idx of afterIlls){const fi=imgStore.get(fi_idx);if(!fi)continue;const fn='ill_'+String(illPageIdx++).padStart(4,'0')+'.xhtml';const iid='ill_'+String(illPageIdx-1).padStart(4,'0');textFolder.file(fn,xhtmlPage(heading+' 삽화','<div class="illust-page"><img src="../Images/'+fi.filename+'" alt="삽화"/></div>'));manifestItems.push({id:iid,href:'Text/'+fn,mt:'application/xhtml+xml'});spineItems.push(iid);}}
    }
    prog(82,'목차 생성 중...');
    let ncx='<?xml version="1.0" encoding="utf-8"?>\\n<ncx xmlns="http://www.daisy.org/z3986/2005/ncx/" version="2005-1">\\n<head><meta name="dtb:uid" content="'+uid+'"/></head>\\n<docTitle><text>'+escHtml(title)+'</text></docTitle>\\n<navMap>\\n';
    let order=1;
    for(let idx=0;idx<chapters.length;idx++){const[h]=chapters[idx];if(h==='서문')continue;ncx+='<navPoint id="np'+idx+'" playOrder="'+order+'"><navLabel><text>'+escHtml(tocLabel(idx,h,chHasIll))+'</text></navLabel><content src="Text/chapter_'+String(idx).padStart(4,'0')+'.xhtml"/></navPoint>\\n';order++;}
    ncx+='</navMap></ncx>';oebps.file('toc.ncx',ncx);
    let nav='<?xml version="1.0" encoding="utf-8"?><!DOCTYPE html>\\n<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops"><head><title>'+escHtml(title)+'</title></head><body><nav epub:type="toc"><ol>\\n';
    for(let idx=0;idx<chapters.length;idx++){const[h]=chapters[idx];if(h==='서문')continue;nav+='<li><a href="Text/chapter_'+String(idx).padStart(4,'0')+'.xhtml">'+escHtml(tocLabel(idx,h,chHasIll))+'</a></li>\\n';}
    nav+='</ol></nav></body></html>';oebps.file('nav.xhtml',nav);
    const coverInfoX=imgStore.get('cover')||null;
    let opf='<?xml version="1.0" encoding="utf-8"?>\\n<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="uid">\\n<metadata xmlns:dc="http://purl.org/dc/elements/1.1/">\\n<dc:title>'+escHtml(title)+'</dc:title>\\n<dc:creator>'+escHtml(author)+'</dc:creator>\\n<dc:language>'+lang+'</dc:language>\\n<dc:identifier id="uid">'+uid+'</dc:identifier>\\n<dc:date>'+today+'</dc:date>\\n<dc:publisher>TXT2EPUB 변환기</dc:publisher>\\n'+(coverInfoX?'<meta name="cover" content="cover_img"/>\\n':'')+'\\n</metadata>\\n<manifest>\\n<item id="css" href="style.css" media-type="text/css"/>\\n<item id="ncx" href="toc.ncx" media-type="application/x-dtbncx+xml"/>\\n<item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>\\n';
    manifestItems.forEach(it=>opf+='<item id="'+it.id+'" href="'+it.href+'" media-type="'+it.mt+'"/>\\n');
    if(coverInfoX)opf+='<item id="cover_img" href="Images/'+coverInfoX.filename+'" media-type="'+coverInfoX.mt+'" properties="cover-image"/>\\n';
    for(const[key,info]of imgStore){if(key==='cover')continue;opf+='<item id="imgf_'+info.filename.replace(/\\W/g,'_')+'" href="Images/'+info.filename+'" media-type="'+info.mt+'"/>\\n';}
    opf+='</manifest>\\n<spine toc="ncx">\\n';spineItems.forEach(s=>opf+='<itemref idref="'+s+'"/>\\n');opf+='</spine>\\n</package>';oebps.file('content.opf',opf);
    prog(92,'압축 중...');
    let blob;
    try{
      blob=await zip.generateAsync({type:'blob',mimeType:'application/epub+zip',compression:'DEFLATE',compressionOptions:{level:compressionLevel},streamFiles:true},
        meta=>{self.postMessage({type:'progress',pct:92+Math.floor(meta.percent*0.07),msg:'압축 중 '+Math.floor(meta.percent)+'%...'});});
    }catch(de){
      self.postMessage({type:'progress',pct:94,msg:'압축 실패, 무압축으로 재시도 중...'});
      try{
        blob=await zip.generateAsync({type:'blob',mimeType:'application/epub+zip',compression:'STORE',streamFiles:true},
          meta=>{self.postMessage({type:'progress',pct:94+Math.floor(meta.percent*0.05),msg:'무압축 패키징 '+Math.floor(meta.percent)+'%...'});});
      }catch(se){throw new Error('EPUB 압축 최종 실패: '+se.message);}
    }
    self.postMessage({type:'done',blob});
  }catch(err){self.postMessage({type:'error',message:err.message||String(err)});}
};`;

  return [body, 'const xhtmlPage=' + xhtmlFn.toString() + ';', mainHandler].join('\n');
}

// ══════════════════════════════════════════
// 개선안 2+3: 이미지 병렬 처리
// ══════════════════════════════════════════

// ══════════════════════════════════════════
// 개선안 1: launchEpubWorker — Blob Worker 격리 진입점
// ══════════════════════════════════════════
async function launchEpubWorker({ title, author, chapters, coverFile, illMap=[], useItalic=true }, onProgress){
  // ① 메인 스레드 전처리 (DOM 필요 작업)
  onProgress&&onProgress(3, '이미지 전처리 중...');
  const imageData = await processImagesParallel(coverFile, illMap);
  const cssText = buildCss();
  // renderBodyHtml은 외부 함수 의존성 → 메인 스레드에서 처리 후 직렬화
  const renderedBodies = chapters.map(([,body])=>
    renderBodyHtml(body,{useItalic,maxBlank:2})
  );
  // File 객체는 postMessage 불가 → 메타만 전달
  const illMapMeta = illMap.map((il,i)=>({
    idx:      il.idx,
    ch:       il.ch,
    kw:       il.kw,
    pos:      il.pos,
    file_idx: i,
  }));

  // ② Blob Worker 생성
  const jszipUrl = 'https://cdnjs.cloudflare.com/ajax/libs/jszip/3.10.1/jszip.min.js';
  const workerSrc  = _buildWorkerSrc(jszipUrl);
  const workerBlob = new Blob([workerSrc], {type:'application/javascript'});
  const workerUrl  = URL.createObjectURL(workerBlob);
  const worker     = new Worker(workerUrl);

  // ③ Worker 메시지 통신
  return new Promise((resolve, reject)=>{
    worker.onmessage = function(e){
      const { type, pct, msg, blob, message } = e.data;
      if(type==='progress'){
        // ★ 메인 스레드: 오직 진행률 UI 업데이트만
        onProgress&&onProgress(pct, msg);
        return;
      }
      if(type==='done'){
        worker.terminate();
        URL.revokeObjectURL(workerUrl);
        resolve(blob);
        return;
      }
      if(type==='error'){
        worker.terminate();
        URL.revokeObjectURL(workerUrl);
        reject(new Error(message||'Worker 오류'));
        return;
      }
    };
    worker.onerror = function(e){
      worker.terminate();
      URL.revokeObjectURL(workerUrl);
      reject(new Error('Worker 오류: '+e.message));
    };

    // ④ 직렬화 파라미터 전송
    const showChTitle    = document.getElementById('optChTitle')?.checked !== false;
    const compressionRaw = parseInt(document.getElementById('optCompression')?.value??'6',10);
    const compressionLevel = isNaN(compressionRaw)?6:Math.max(0,Math.min(9,compressionRaw));
    const lang = document.getElementById('optLang')?.value||'ko';

    worker.postMessage(
      {
        params:{
          title, author, chapters,
          illMapMeta, useItalic, showChTitle,
          compressionLevel, lang,
          uid:   crypto.randomUUID(),
          today: new Date().toISOString().slice(0,10),
          renderedBodies,
        },
        imageData, cssText,
      },
      // ★ Transferable: zero-copy ArrayBuffer 이전
      [
        ...(imageData.cover ? [imageData.cover.ab] : []),
        ...imageData.ills.map(ill=>ill.ab),
      ]
    );
  });
}

// ══════════════════════════════════════════
// buildEpub — 하위 호환 래퍼
// 기존 main.js startConvert()와 함수 시그니처 동일
// ══════════════════════════════════════════
async function buildEpub(params, onProgress){
  return launchEpubWorker(params, onProgress);
}
