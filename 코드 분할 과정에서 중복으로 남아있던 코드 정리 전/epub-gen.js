// ════════════════════════════════════════════════
// epub-gen.js — EPUB3 생성 엔진
// NovelEPUB | TXT → EPUB3
//
// 의존성: JSZip (CDN), parser.js (escHtml, renderBodyHtml)
// 내보내는 심볼:
//   buildCss, generateTextCover, buildEpub
//   setProgress, xhtmlPage
// ════════════════════════════════════════════════

/* global JSZip, escHtml, renderBodyHtml, convertImageFile, fileToAB,
   document, crypto */

'use strict';
function buildCss(){
  const font=document.getElementById('cssFont')?.value||'"Noto Serif KR",serif';
  const line=document.getElementById('cssLine')?.value||'1.9';
  const size=document.getElementById('cssFontSize')?.value||'1em';

  // ★ em 단위 안전 처리: 숫자만 있으면 em 자동 부착, 이미 단위 있으면 그대로
  function toEm(val, def){
    if(!val) return def;
    const s=String(val).trim();
    if(/em$|px$|%$|rem$/.test(s)) return s;
    const n=parseFloat(s);
    return isNaN(n)?def:n+'em';
  }
  const padTop=   toEm(document.getElementById('cssPadTop')?.value    || document.getElementById('cssPadV')?.value, '1.5em');
  const padBottom=toEm(document.getElementById('cssPadBottom')?.value  || document.getElementById('cssPadV')?.value, '1.5em');
  const padLeft=  toEm(document.getElementById('cssPadLeft')?.value    || document.getElementById('cssPadH')?.value, '1.8em');
  const padRight= toEm(document.getElementById('cssPadRight')?.value   || document.getElementById('cssPadH')?.value, '1.8em');

  const textColor=document.getElementById('cssTextColor')?.value||'';
  const bgColor=  document.getElementById('cssBgColor')?.value||'';
  const align=document.querySelector('input[name="cssAlign"]:checked')?.value||'justify';
  const titleStyle=document.querySelector('input[name="cssTitleStyle"]:checked')?.value||'center';
  const indentSlider=document.getElementById('cssIndentSlider');
  const indentEm=indentSlider?parseFloat(indentSlider.value)||1.0:1.0;  // ★ NaN 방지
  const useIndent=document.getElementById('optIndent')?.checked;
  const fontFaceBlock=typeof customFontFace!=='undefined'?customFontFace||'':'';
  const extra=document.getElementById('cssExtra')?.value||'';

  let h1Extra=`text-align:${titleStyle==='left'?'left':'center'};`;
  if(titleStyle==='underline') h1Extra+='border-bottom:2px solid currentColor;padding-bottom:0.3em;text-align:center;';
  if(titleStyle==='box') h1Extra+='border:1.5px solid currentColor;padding:0.25em 1em;border-radius:6px;display:inline-block;';

  return `@charset "UTF-8";
${fontFaceBlock}
/* ── 기본 스타일 ── */
body{
  font-family:${font};
  line-height:${line};
  font-size:${size};
  margin:0;
  padding:${padTop} ${padRight} ${padBottom} ${padLeft};
  word-break:keep-all;
  overflow-wrap:break-word;
  text-align:${align};
  ${textColor?'color:'+textColor+';':''}
  ${bgColor?'background-color:'+bgColor+';':''}
}
h1{font-size:1.3em;${h1Extra}margin:1.2em 0 1.8em;font-weight:700;letter-spacing:-0.02em}
p{margin:0;padding:0.25em 0;text-indent:${useIndent?indentEm+'em':'0'}}
p.noindent{text-indent:0}
em.flashback{font-style:italic;opacity:.85}
p.sysmsg{text-align:center;font-style:italic;opacity:.75;text-indent:0}
.illust-page{display:flex;align-items:center;justify-content:center;min-height:80vh;text-align:center;padding:0}
.illust-page img{max-width:100%;max-height:100vh;object-fit:contain}

/* ★ EPUB 다크 모드 */
@media (prefers-color-scheme:dark){
  body{
    ${bgColor?'':"background-color:#1a1208;"}
    ${textColor?'':"color:#e8d8c4;"}
  }
}
${extra}`;
}


// ══════════════════════════════════════════
function setProgress(pct,msg){
  document.getElementById('progBar').style.width=pct+'%';
  document.getElementById('progMsg').textContent=msg;
}

// ══════════════════════════════════════════
// 📖 Module: EpubBuilder (EPUB3 생성 엔진)
// ══════════════════════════════════════════
// ── Canvas 텍스트 표지 생성 (이미지 없을 때 폴백) ──
async function generateTextCover(title, author){
  return new Promise(resolve=>{
    const W=800, H=1120;
    const canvas=document.createElement('canvas');
    canvas.width=W; canvas.height=H;
    const ctx=canvas.getContext('2d');

    // 배경 — 세로 그라디언트
    const isDark=document.documentElement.dataset.theme==='dark';
    const grad=ctx.createLinearGradient(0,0,0,H);
    if(isDark){
      grad.addColorStop(0,'#1a1a2e');
      grad.addColorStop(0.5,'#16213e');
      grad.addColorStop(1,'#0f3460');
    } else {
      grad.addColorStop(0,'#2c3e50');
      grad.addColorStop(0.5,'#3d5a80');
      grad.addColorStop(1,'#1a2636');
    }
    ctx.fillStyle=grad;
    ctx.fillRect(0,0,W,H);

    // 장식 원
    ctx.save();
    ctx.globalAlpha=0.08;
    ctx.fillStyle='#ffffff';
    ctx.beginPath(); ctx.arc(W*0.8,H*0.15,220,0,Math.PI*2); ctx.fill();
    ctx.beginPath(); ctx.arc(W*0.1,H*0.85,160,0,Math.PI*2); ctx.fill();
    ctx.restore();

    // 구분선
    ctx.strokeStyle='rgba(255,255,255,0.3)';
    ctx.lineWidth=1.5;
    ctx.beginPath(); ctx.moveTo(60,H*0.45); ctx.lineTo(W-60,H*0.45); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(60,H*0.47); ctx.lineTo(W-60,H*0.47); ctx.stroke();

    // 제목 (자동 줄바꿈, 최대 3줄)
    ctx.fillStyle='#ffffff';
    ctx.textAlign='center';
    ctx.textBaseline='middle';
    const maxW=W-120;
    function wrapText(text, maxWidth, fontSize){
      ctx.font=`bold ${fontSize}px "Noto Serif KR", "Malgun Gothic", serif`;
      const words=text.split('');
      let lines=[],cur='';
      for(const ch of words){
        const test=cur+ch;
        if(ctx.measureText(test).width>maxWidth&&cur){lines.push(cur);cur=ch;}
        else cur=test;
      }
      if(cur) lines.push(cur);
      return lines.slice(0,3);
    }
    const fontSize=title.length<=10?68:title.length<=20?56:44;
    const titleLines=wrapText(title,maxW,fontSize);
    const lineH=fontSize*1.35;
    const totalH=titleLines.length*lineH;
    const startY=H*0.38-totalH/2;
    titleLines.forEach((line,i)=>{
      ctx.font=`bold ${fontSize}px "Noto Serif KR","Malgun Gothic",serif`;
      ctx.fillText(line, W/2, startY+i*lineH);
    });

    // 저자
    if(author&&author!=='작자 미상'){
      ctx.font=`500 28px "Noto Sans KR","Malgun Gothic",sans-serif`;
      ctx.fillStyle='rgba(255,255,255,0.75)';
      ctx.fillText(author, W/2, H*0.56);
    }

    // 하단 로고 텍스트
    ctx.font='16px monospace';
    ctx.fillStyle='rgba(255,255,255,0.25)';
    ctx.fillText('NovelEPUB', W/2, H-36);

    canvas.toBlob(blob=>{
      if(!blob){ resolve(null); return; }
      // File 객체로 변환 (buildEpub의 addImg와 호환)
      const file=new File([blob],'_cover_generated.jpg',{type:'image/jpeg'});
      resolve(file);
    },'image/jpeg',0.92);
  });
}

async function buildEpub({title,author,chapters,coverFile,illMap=[],useItalic=true},onProgress){
  const showChTitle=document.getElementById('optChTitle')?.checked!==false;
  const zip=new JSZip();
  // ★ EPUB 표준: mimetype은 반드시 압축 없이(STORE) 첫 번째 파일로 배치
  zip.file('mimetype','application/epub+zip',{compression:'STORE',compressionOptions:{level:0}});
  zip.folder('META-INF').file('container.xml',
    '<?xml version="1.0"?><container version="1.0" xmlns="urn:oasis:schemas:container">'+
    '<rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/>'+
    '</rootfiles></container>');
  const oebps=zip.folder('OEBPS'),imagesFolder=oebps.folder('Images'),textFolder=oebps.folder('Text');
  oebps.file('style.css',buildCss());
  onProgress&&onProgress(5,'이미지 처리 중...');

  // ★ EpubCheck 통과용 ID/파일명 정제 함수
  function safeId(s){
    return s.replace(/[^a-zA-Z0-9_\-]/g,'_').replace(/^(\d)/,'id_$1').replace(/__+/g,'_').slice(0,64)||'id_unknown';
  }
  function safeFilename(s){
    return s.replace(/[^a-zA-Z0-9가-힣\-_.]/g,'_').replace(/__+/g,'_').slice(0,80)||'file';
  }

  // ★ 표지 이미지 리사이징: 세로 1200px 초과 시 Canvas로 리사이징
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

  // 이미지 추가
  const imgStore=new Map();let imgIdx=0;
  async function addImg(file, forCover=false){
    if(!file||imgStore.has(file))return;
    // 표지는 리사이징 후 변환
    const target=forCover?await resizeCoverIfNeeded(file):file;
    const {blob, ext:dext, mt}=await convertImageFile(target, forCover);
    const dest='img_'+String(imgIdx++).padStart(4,'0')+'.'+dext;
    imagesFolder.file(dest,await fileToAB(blob));
    imgStore.set(file,{filename:dest,mt});
  }
  if(coverFile) await addImg(coverFile, true);  // 표지는 항상 JPG 변환
  for(const il of illMap){if(il&&il.file) await addImg(il.file);}

  onProgress&&onProgress(15,'챕터 생성 중...');
  const manifestItems=[],spineItems=[],uid=crypto.randomUUID(),today=new Date().toISOString().slice(0,10);

  // 표지 페이지
  if(coverFile&&imgStore.has(coverFile)){
    const info=imgStore.get(coverFile);
    textFolder.file('cover.xhtml',xhtmlPage('표지','<div class="illust-page"><img src="../Images/'+info.filename+'" alt="표지"/></div>'));
    manifestItems.push({id:'cover_xhtml',href:'Text/cover.xhtml',mt:'application/xhtml+xml'});
    spineItems.push('cover_xhtml');
  }

  // 공통 renderBodyHtml 사용 (useItalic은 buildEpub 인자에서 전달)
  function bodyToHtml(body){ return renderBodyHtml(body,{useItalic,maxBlank:2}); }

  // 챕터별 삽화 매핑
  // il.idx: 파일명 기반 0-based 인덱스 매칭 (auto)
  // il.ch:  챕터 제목 숫자 기반 매칭 (manual, 기존 방식 유지)
  // il.kw:  키워드 기반 매칭 (manual)
  const chHasIll={};
  for(let idx=0;idx<chapters.length;idx++){
    const[h,b]=chapters[idx];
    const cn=extractChNum(h);
    const ills=illMap.filter(il=>
      (il.idx!==undefined ? il.idx===idx : false) ||  // 인덱스 매칭 (auto)
      (il.ch!==undefined&&il.idx===undefined ? il.ch===cn : false) || // 제목번호 매칭 (manual)
      (!il.ch&&!il.idx&&il.kw&&b.includes(il.kw))   // 키워드 매칭 (manual)
    );
    chHasIll[idx]=ills.length>0;
  }

  const tot=chapters.length;
  let illPageIdx=0;
  const _loopStart=Date.now();
  for(let idx=0;idx<tot;idx++){
    // 50챕터마다 메인 스레드에 제어권 반납 → UI 응답 유지 (500화+ 무응답 방지)
    if(idx%50===0){
      const pct=15+Math.floor(idx/tot*65);
      const elapsed=Date.now()-_loopStart;
      const eta=idx>0?Math.round((elapsed/idx)*(tot-idx)/1000):0;
      const etaStr=eta>0?` (남은 시간: ~${eta}초)`:'';
      onProgress&&onProgress(pct,'챕터 생성 중 ('+idx+'/'+tot+')'+etaStr+'...');
      await yieldToMain(); // ← 메인 스레드 제어권 반납
    }
    const[heading,body]=chapters[idx];
    const cn=extractChNum(heading);

    // 인덱스 매칭(auto) + 제목번호 매칭(manual) + 키워드 매칭(manual)
    function matchIll(il){
      if(il.idx!==undefined) return il.idx===idx;           // 파일명 인덱스
      if(il.ch!==undefined)  return il.ch===cn;             // 챕터 제목 숫자
      if(il.kw)              return body.includes(il.kw);   // 키워드
      return false;
    }
    const beforeIlls=illMap.filter(il=>matchIll(il)&&il.pos!=='after').map(il=>il.file);
    const afterIlls=illMap.filter(il=>matchIll(il)&&il.pos==='after').map(il=>il.file);

    if(heading!=='서문'){
      for(const f of beforeIlls){
        const fi=imgStore.get(f);if(!fi)continue;
        const fn='ill_'+String(illPageIdx++).padStart(4,'0')+'.xhtml';
        const iid='ill_'+String(illPageIdx-1).padStart(4,'0');
        textFolder.file(fn,xhtmlPage(heading+' 삽화','<div class="illust-page"><img src="../Images/'+fi.filename+'" alt="삽화"/></div>'));
        manifestItems.push({id:iid,href:'Text/'+fn,mt:'application/xhtml+xml'});
        spineItems.push(iid);
      }
    }

    const fname='chapter_'+String(idx).padStart(4,'0')+'.xhtml';
    const chid='ch_'+String(idx).padStart(4,'0');
    // 패턴 미감지 자동 페이지 분할 챕터는 제목 표시 안 함 (텍스트 우선)
    const isAutoPage=/^\(\d+\/\d+\)$/.test(heading)||heading==='본문'||/^Chapter\s+\d+$/.test(heading);
    const showTitle=showChTitle&&!isAutoPage;
    textFolder.file(fname,xhtmlPage(heading,(showTitle?'<h1>'+escHtml(heading)+'</h1>\n':'')+bodyToHtml(body)));
    manifestItems.push({id:chid,href:'Text/'+fname,mt:'application/xhtml+xml'});
    if(heading!=='서문') spineItems.push(chid);

    if(heading!=='서문'){
      for(const f of afterIlls){
        const fi=imgStore.get(f);if(!fi)continue;
        const fn='ill_'+String(illPageIdx++).padStart(4,'0')+'.xhtml';
        const iid='ill_'+String(illPageIdx-1).padStart(4,'0');
        textFolder.file(fn,xhtmlPage(heading+' 삽화','<div class="illust-page"><img src="../Images/'+fi.filename+'" alt="삽화"/></div>'));
        manifestItems.push({id:iid,href:'Text/'+fn,mt:'application/xhtml+xml'});
        spineItems.push(iid);
      }
    }
  }

  onProgress&&onProgress(82,'목차 생성 중...');

  function tocLabel(idx,h){
    if(chHasIll[idx]) return h+' 삽화';
    // (N/M) 자동 페이지 분할 → "N페이지"
    if(/^\(\d+\/\d+\)$/.test(h)){
      const m=h.match(/\((\d+)\/(\d+)\)/);
      return m?m[1]+'페이지':h;
    }
    // 간격 분할 "Chapter N" → NCX/Nav에는 "N화"로 표시 (본문엔 제목 없음)
    if(/^Chapter\s+\d+$/.test(h)){
      const m=h.match(/Chapter\s+(\d+)/);
      return m?m[1]+'화':h;
    }
    return h;
  }
  // NCX
  let ncx='<?xml version="1.0" encoding="utf-8"?>\n<ncx xmlns="http://www.daisy.org/z3986/2005/ncx/" version="2005-1">\n<head><meta name="dtb:uid" content="'+uid+'"/></head>\n<docTitle><text>'+escHtml(title)+'</text></docTitle>\n<navMap>\n';
  let order=1;
  for(let idx=0;idx<chapters.length;idx++){const[h]=chapters[idx];if(h==='서문')continue;ncx+='<navPoint id="np'+idx+'" playOrder="'+order+'"><navLabel><text>'+escHtml(tocLabel(idx,h))+'</text></navLabel><content src="Text/chapter_'+String(idx).padStart(4,'0')+'.xhtml"/></navPoint>\n';order++;}
  ncx+='</navMap></ncx>';
  oebps.file('toc.ncx',ncx);

  // Nav
  let nav='<?xml version="1.0" encoding="utf-8"?><!DOCTYPE html>\n<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops"><head><title>'+escHtml(title)+'</title></head><body><nav epub:type="toc"><ol>\n';
  for(let idx=0;idx<chapters.length;idx++){const[h]=chapters[idx];if(h==='서문')continue;nav+='<li><a href="Text/chapter_'+String(idx).padStart(4,'0')+'.xhtml">'+escHtml(tocLabel(idx,h))+'</a></li>\n';}
  nav+='</ol></nav></body></html>';
  oebps.file('nav.xhtml',nav);

  // OPF
  const coverInfo=coverFile&&imgStore.has(coverFile)?imgStore.get(coverFile):null;
  let opf='<?xml version="1.0" encoding="utf-8"?>\n<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="uid">\n<metadata xmlns:dc="http://purl.org/dc/elements/1.1/">\n<dc:title>'+escHtml(title)+'</dc:title>\n<dc:creator>'+escHtml(author)+'</dc:creator>\n<dc:language>'+(document.getElementById('optLang')?.value||'ko')+'</dc:language>\n<dc:identifier id="uid">'+uid+'</dc:identifier>\n<dc:date>'+today+'</dc:date>\n<dc:publisher>TXT2EPUB 변환기</dc:publisher>\n'+(coverInfo?'<meta name="cover" content="cover_img"/>':'')+'\n</metadata>\n<manifest>\n<item id="css" href="style.css" media-type="text/css"/>\n<item id="ncx" href="toc.ncx" media-type="application/x-dtbncx+xml"/>\n<item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>\n';
  manifestItems.forEach(it=>opf+='<item id="'+it.id+'" href="'+it.href+'" media-type="'+it.mt+'"/>\n');
  if(coverInfo) opf+='<item id="cover_img" href="Images/'+coverInfo.filename+'" media-type="'+coverInfo.mt+'" properties="cover-image"/>\n';
  for(const[f,info]of imgStore){if(f===coverFile)continue;opf+='<item id="imgf_'+info.filename.replace(/\W/g,'_')+'" href="Images/'+info.filename+'" media-type="'+info.mt+'"/>\n';}
  opf+='</manifest>\n<spine toc="ncx">\n';
  spineItems.forEach(s=>opf+='<itemref idref="'+s+'"/>\n');
  opf+='</spine>\n</package>';
  oebps.file('content.opf',opf);

  onProgress&&onProgress(92,'압축 중...');
  const compressionLevel=parseInt(document.getElementById('optCompression')?.value||'6');
  return zip.generateAsync({
    type:'blob',
    mimeType:'application/epub+zip',
    // ★ 파일별 compression 지정으로 mimetype은 STORE 유지 (파일 추가 시 이미 설정됨)
    compression:'DEFLATE',
    compressionOptions:{level:compressionLevel}
  }, meta=>onProgress&&onProgress(92+Math.floor(meta.percent*0.07),'압축 중 '+Math.floor(meta.percent)+'%...'));
}

function xhtmlPage(title,body){
  return '<?xml version="1.0" encoding="utf-8"?><!DOCTYPE html>\n<html xmlns="http://www.w3.org/1999/xhtml"><head>\n<title>'+escHtml(title)+'</title>\n<link rel="stylesheet" type="text/css" href="../style.css"/>\n</head><body>\n'+body+'\n</body></html>';
}

// ══════════════════════════════════════════