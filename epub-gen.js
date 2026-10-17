// ════════════════════════════════════════════════
// epub-gen.js — EPUB3 생성 엔진 (Phase 2 리팩토링)
// NovelEPUB | TXT → EPUB3
//
// Phase 2 개선사항:
//   P2-01: renderedBodies 메모리 이중화 제거
//          renderBodyHtml/sanitizeLine/escHtml을 Worker 내부로 이식
//          → 메인 스레드에서 전체 HTML 배열 사전 생성 폐지
//          → Worker 내부에서 챕터별 즉석 렌더링 (메모리 피크 ~50% 감소)
//   P2-02: processImagesParallel Semaphore 강화
//          toBlob SecurityError(CORS taint) try-catch 추가
//   P2-03: launchEpubWorker Worker URL 누수 방지
//          new Worker 예외 시 URL.revokeObjectURL 보장
//   P2-04: Worker error 스택 트레이스 포함
//
// Phase 10:
//   · Worker 본문 렌더링 = parser.js 함수 toString() 이식 (손 복사본 폐지 — sysmsg 오분류·이모지 삭제 해결)
//   · 챕터 렌더링 1회 (삽화 키워드 검사를 위한 사전 렌더링 제거) · 삽화 매핑 Map 사전 계산
//   · 이미지 STORE(재압축 생략) · XHTML xml:lang · AbortSignal 중단 · 오류를 RecoverableError로 감싸지 않음
//
// 의존성: JSZip (CDN), parser.js (escHtml, sanitizeLine, renderBodyHtml, buildTocTree)
// 내보내는 심볼:
//   buildCss, generateTextCover, buildEpub, launchEpubWorker
//   updateProgStep
//   (xhtmlPage는 EPUB Worker 내부 전용 — 메인 스레드 사본 제거)
// ════════════════════════════════════════════════

/* global JSZip, escHtml, sanitizeLine, renderBodyHtml,
   convertImageFile, fileToAB,
   document, crypto, extractChNum, customFontFace, Toast, genUID, buildTocTree,
   _decodeHtmlEntities, _escHtmlViaDOM, _RX_AMP, _RX_LT, _RX_GT, _RX_QUOT, _RX_APOS, _RX_SANITIZE, _RX_ENTITY, _NAMED_ENTITY,
   _RX_SYSMSG_OPEN, _RX_SYSMSG_CLOSE, _RX_FLASHBACK */
/* global xhtmlPage, tocLabel, RX_AUTO_PAGE, RX_CHAPTER_N, RX_PARENS -- EPUB Worker 전역 (_buildWorkerSrc가 정의, 메인 스레드에서는 미사용) */

'use strict';

// ── toEm: em 단위 안전 처리 ──
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

// ── UI 진행률 ──
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

// ── 텍스트 표지 생성 ──
function wrapText(text, maxWidth, fontSize){
  const lines=[], words=text.split('');
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
    canvas.toBlob(b=>resolve(b||null),'image/jpeg',0.9);
  });
}

// ══════════════════════════════════════════
// P2-02: 이미지 병렬 처리 — Semaphore 강화
// ══════════════════════════════════════════
const IMG_CONCURRENCY = 4; // 동시 처리 제한 (Canvas GPU 메모리 포화 방지)

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
      // ★ P2-02: toBlob SecurityError(CORS canvas taint) try-catch
      try{
        canvas.toBlob(blob=>{
          if(!blob){resolve(file);return;}
          resolve(new File([blob],file.name||'cover.jpg',{type:'image/jpeg'}));
        },'image/jpeg',0.92);
      }catch(e){
        // canvas tainted → 원본 파일 그대로 사용
        resolve(file);
      }
    };
    img.onerror=()=>{URL.revokeObjectURL(url);resolve(file);};
    img.src=url;
  });
}

async function processImagesParallel(coverFile, illMap, signal=null){
  const result = { cover: null, ills: [] };
  const checkAbort=()=>{ if(signal?.aborted){ const err=new Error('사용자 중단'); err.name='AbortError'; throw err; } };
  if(coverFile){
    try{
      const target = await resizeCoverIfNeeded(coverFile);
      const { blob, ext, mt } = await convertImageFile(target, true);
      const ab = await fileToAB(blob);
      result.cover = { ab, ext, mt };
      // ★ 4단계 GC: 표지 blob 참조 즉시 해제 — AB만 result에 보유
      // blob 객체는 여기서 더 이상 불필요
    }catch(e){
      if(typeof Toast!=='undefined')
        Toast.warn(`표지 처리 실패 (건너뜀): ${coverFile.name||'표지'}`);
    }
  }
  const illFiles = illMap
    .map((il,i)=>({ il, file_idx: i }))
    .filter(({il})=>il&&il.file);

  // ★ Semaphore 방식: IMG_CONCURRENCY개씩 슬라이스 배치 처리
  //   - Promise.all(전체.map(...)) 금지 — 수백 장 동시 toBlob → GPU 메모리 포화
  //   - 배치 단위 await → 이전 배치 ArrayBuffer가 result.ills에 push된 뒤
  //     다음 배치 진입 전 setTimeout(0)으로 이벤트 루프에 GC 기회를 부여
  for(let i=0;i<illFiles.length;i+=IMG_CONCURRENCY){
    checkAbort();   // ★ Phase 10: 중단 시 남은 이미지 처리 생략
    const batch = illFiles.slice(i, i+IMG_CONCURRENCY);
    const batchRes = await Promise.all(
      batch.map(async ({il, file_idx})=>{
        try{
          const { blob, ext, mt } = await convertImageFile(il.file, false);
          const ab = await fileToAB(blob);
          return { ab, ext, mt, file_idx };
        }catch(e){
          if(typeof Toast!=='undefined')
            Toast.warn(`이미지 처리 실패 (건너뜀): ${il.file.name||'알 수 없는 파일'}`);
          return null;
        }
      })
    );
    result.ills.push(...batchRes.filter(Boolean));

    // ★ GC 힌트: 배치 완료 후 이벤트 루프에 제어권 반환
    //   이전 배치의 임시 Blob/Canvas 객체가 GC될 수 있도록 한 프레임 양보
    //   수백 장 처리 시 메모리 누적 억제 효과 (마지막 배치 제외)
    if(i + IMG_CONCURRENCY < illFiles.length){
      await new Promise(r => setTimeout(r, 0));
    }
  }
  result.ills.sort((a,b)=>a.file_idx-b.file_idx);
  return result;
}

// ══════════════════════════════════════════
// P2-01: Worker Blob 소스 빌더
// renderBodyHtml / sanitizeLine / escHtml 을 Worker 내부로 이식
// → launchEpubWorker에서 renderedBodies 사전 생성 불필요
// ★ Phase 10: 손으로 복사한 문자열 사본 폐지 — parser.js 함수를 toString()으로 그대로 이식 (단일 소스)
//   (이전 사본은 sysmsg 정규식 오타(\\u226a)로 '2층 [창고]' 같은 본문 줄을 시스템 메시지로 오분류,
//    서로게이트 전체 삭제로 이모지·확장 한자가 사라지는 문제를 메인 스레드와 별개로 갖고 있었음)
// ══════════════════════════════════════════

// ── EPUB Worker 본체 ──
// ★ toString()으로 Worker에 이식 — 메인 스레드에서는 호출되지 않음
//   Worker 전역 심볼만 참조: JSZip, renderBodyHtml, escHtml, buildTocTree, xhtmlPage, tocLabel, extractChNum, RX_*
async function _epubWorkerMain(e){
  // ★ P2-04: Worker 내 onmessage 전체 try-catch — 고스트 에러 방지
  let imgStore=null;
  try{
    const{params,imageData,cssText}=e.data;
    const{title,author,chapters,illMapMeta,useItalic,showChTitle,
          compressionLevel,lang,uid,today,modified,
          publisher='',series='',seriesIndex=0,
          removeBlankLines=false}=params;
    const prog=(pct,msg)=>self.postMessage({type:'progress',pct,msg});
    prog(5,'이미지 처리 중...');
    const zip=new JSZip();
    zip.file('mimetype','application/epub+zip',{compression:'STORE'});
    // ★ container.xml 네임스페이스는 OCF 표준값(urn:oasis:names:tc:opendocument:xmlns:container) — 오타 시 epubcheck RSC-003
    zip.folder('META-INF').file('container.xml','<?xml version="1.0"?><container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container"><rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles></container>');
    // ★ Images 폴더는 이미지가 있을 때만 생성 (빈 디렉터리 → epubcheck PKG-014 경고)
    const oebps=zip.folder('OEBPS'),textFolder=oebps.folder('Text');
    const imagesFolder=(imageData.cover||imageData.ills.length)?oebps.folder('Images'):null;
    oebps.file('style.css',cssText);
    // ★ Phase 10: 이미지는 이미 압축된 포맷(JPEG·PNG·WebP) → DEFLATE 재압축 없이 STORE (압축 시간 절감, 크기 차이 거의 없음)
    const IMG_OPT={compression:'STORE'};
    imgStore=new Map();let imgIdx=0;
    if(imageData.cover){const{ab,ext,mt}=imageData.cover;const dest='img_'+String(imgIdx++).padStart(4,'0')+'.'+ext;imagesFolder.file(dest,ab,IMG_OPT);imgStore.set('cover',{filename:dest,mt});}
    for(const ill of imageData.ills){const{ab,ext,mt,file_idx}=ill;const dest='img_'+String(imgIdx++).padStart(4,'0')+'.'+ext;imagesFolder.file(dest,ab,IMG_OPT);imgStore.set(file_idx,{filename:dest,mt});}
    prog(15,'챕터 생성 중...');
    const manifestItems=[],spineItems=[];
    // ★ 목차 항목은 챕터 루프에서 수집 — 루프 뒤 chapters.length=0으로 원문이 해제되므로
    //   (이전: 해제 후 chapters[origIdx]를 읽어 nav/ncx 제목이 전부 빈 문자열이던 버그)
    const tocEntries=[];
    const coverInfo=imgStore.get('cover')||null;
    if(coverInfo){textFolder.file('cover.xhtml',xhtmlPage('표지','<div class="illust-page"><img src="../Images/'+coverInfo.filename+'" alt="표지"/></div>',lang));manifestItems.push({id:'cover_xhtml',href:'Text/cover.xhtml',mt:'application/xhtml+xml'});spineItems.push('cover_xhtml');}

    // ★ Phase 10: 삽화 → 챕터 매핑을 루프 전에 1회 계산 (이전: 모든 챕터를 미리 한 번 더 렌더링해 키워드를 검사 → 렌더링 2회,
    //   챕터마다 illMapMeta 전체 filter → O(챕터×삽화))
    //   · idx(파일명 번호): '서문'(첫 제목 앞 내용)을 제외한 n번째 챕터 — 이전엔 서문이 0번이 되어 01.jpg가 서문에 붙음
    //   · ch(화 번호): 감지된 화 번호(meta.num) 우선, 없으면 제목의 'N화' 번호 — 같은 번호가 여러 개(분할 연재)면 첫 챕터
    //   · kw(키워드): 원문 기준 첫 번째 일치 챕터 (이전: 이스케이프된 HTML에서 검사 → '&'·'<' 포함 키워드 매칭 실패)
    const tot=chapters.length;
    const realToK=[];const firstKByNum=new Map();
    for(let k=0;k<tot;k++){
      const ch=chapters[k];const meta=ch[2]||null;
      if(!(meta&&meta.pre)) realToK.push(k);
      const n=(meta&&meta.num!=null)?meta.num:extractChNum(ch[0]);
      if(n!=null&&!firstKByNum.has(n)) firstKByNum.set(n,k);
    }
    const illBefore=new Map(),illAfter=new Map();
    for(const il of (illMapMeta||[])){
      let k=null;
      if(typeof il.idx==='number') k=realToK[il.idx];
      else if(typeof il.ch==='number') k=firstKByNum.get(il.ch);
      else if(il.kw){ for(let j=0;j<tot;j++){ if(String(chapters[j][1]||'').includes(il.kw)||String(chapters[j][0]||'').includes(il.kw)){k=j;break;} } }
      if(k==null||k<0||k>=tot) continue;
      const m=il.pos==='after'?illAfter:illBefore;
      if(!m.has(k)) m.set(k,[]);
      m.get(k).push(il.file_idx);
    }
    let illPageIdx=0;
    const addIllPages=(heading,list)=>{
      for(const fi_idx of (list||[])){
        const fi=imgStore.get(fi_idx);if(!fi)continue;
        const iid='ill_'+String(illPageIdx++).padStart(4,'0');const fn=iid+'.xhtml';
        textFolder.file(fn,xhtmlPage(heading+' 삽화','<div class="illust-page"><img src="../Images/'+fi.filename+'" alt="삽화"/></div>',lang));
        manifestItems.push({id:iid,href:'Text/'+fn,mt:'application/xhtml+xml'});spineItems.push(iid);
      }
    };
    for(let idx=0;idx<tot;idx++){
      // ★ 4단계: 20개마다 진행률 갱신, 100화마다 이벤트 루프 양보
      if(idx%20===0){
        prog(15+Math.floor(idx/tot*67),'챕터 생성 중 ('+idx+'/'+tot+')...');
        if(idx>0&&idx%100===0) await new Promise(r=>setTimeout(r,0));
      }
      const heading=chapters[idx][0],rawBody=chapters[idx][1];
      // ★ P2-01: 챕터별 즉석 렌더링 — 배열로 미리 만들어두지 않음 (Phase 10: 챕터당 1회)
      const body=renderBodyHtml(rawBody,{useItalic,maxBlank:2,removeBlankLines});
      const hasIll=illBefore.has(idx)||illAfter.has(idx);
      addIllPages(heading,illBefore.get(idx));
      const isAutoPage=RX_AUTO_PAGE.test(heading)||heading==='본문'||RX_CHAPTER_N.test(heading);
      const showTitle=showChTitle&&!isAutoPage;
      const chid='ch_'+String(idx).padStart(4,'0');const fname='chapter_'+String(idx).padStart(4,'0')+'.xhtml';
      textFolder.file(fname,xhtmlPage(heading,(showTitle?'<h1>'+escHtml(heading)+'</h1>\n':'')+body,lang));
      manifestItems.push({id:chid,href:'Text/'+fname,mt:'application/xhtml+xml'});
      // ★ Phase 8: '서문'(첫 제목 앞 내용)도 읽기 순서·목차에 포함 — 이전엔 spine에서 빠져 프롤로그 등이 사라졌음
      spineItems.push(chid);tocEntries.push({label:tocLabel(heading,hasIll),heading,href:'Text/'+fname});
      addIllPages(heading,illAfter.get(idx));
    }
    // ★ 4단계 GC: 챕터 루프 완료 후 chapters 참조 해제
    chapters.length=0;
    prog(82,'목차 생성 중...');
    // ★ 계층 목차: '1권/2부' 그룹이 있으면 권 > 화 2단계, 없으면 기존 평면 목차 (parser.js buildTocTree)
    const tocTree=buildTocTree(tocEntries);
    const tocDepth=tocTree.some(n=>n.children.length)?2:1;
    // NCX 규칙: 같은 문서를 가리키는 navPoint는 같은 playOrder (합성 그룹 '1부'는 첫 자식과 문서 공유)
    let order=1,npSeq=1;
    const poByHref={};
    const ncxPoints=nodes=>nodes.map(n=>{
      const po=poByHref[n.href]||(poByHref[n.href]=order++);
      return '<navPoint id="np'+(npSeq++)+'" playOrder="'+po+'"><navLabel><text>'+escHtml(n.label)+'</text></navLabel><content src="'+n.href+'"/>\n'+ncxPoints(n.children)+'</navPoint>\n';
    }).join('');
    oebps.file('toc.ncx','<?xml version="1.0" encoding="utf-8"?>\n<ncx xmlns="http://www.daisy.org/z3986/2005/ncx/" version="2005-1">\n<head><meta name="dtb:uid" content="'+uid+'"/><meta name="dtb:depth" content="'+tocDepth+'"/><meta name="dtb:totalPageCount" content="0"/><meta name="dtb:maxPageNumber" content="0"/></head>\n<docTitle><text>'+escHtml(title)+'</text></docTitle>\n<navMap>\n'+ncxPoints(tocTree)+'</navMap></ncx>');
    const navList=nodes=>'<ol>\n'+nodes.map(n=>'<li><a href="'+n.href+'">'+escHtml(n.label)+'</a>'+(n.children.length?'\n'+navList(n.children):'')+'</li>\n').join('')+'</ol>\n';
    // nav <ol>은 비어 있으면 EPUB3 위반 → 목차 항목이 없으면 첫 스파인 문서로 대체 항목 생성
    const navNodes=tocTree.length?tocTree:[{label:title,href:(manifestItems.find(it=>it.id===spineItems[0])||{href:'Text/cover.xhtml'}).href,children:[]}];
    const langAttr=escHtml(lang||'ko');
    oebps.file('nav.xhtml','<?xml version="1.0" encoding="utf-8"?><!DOCTYPE html>\n<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops" xml:lang="'+langAttr+'" lang="'+langAttr+'"><head><title>'+escHtml(title)+'</title></head><body><nav epub:type="toc">\n'+navList(navNodes)+'</nav></body></html>');
    // ★ 시리즈 메타: EPUB3 표준(belongs-to-collection) + Calibre/리더기 호환(calibre:series)
    const seriesMeta=series
      ? '<meta property="belongs-to-collection" id="series">'+escHtml(series)+'</meta>\n'+
        '<meta refines="#series" property="collection-type">series</meta>\n'+
        (seriesIndex>0?'<meta refines="#series" property="group-position">'+seriesIndex+'</meta>\n':'')+
        '<meta name="calibre:series" content="'+escHtml(series)+'"/>\n'+
        (seriesIndex>0?'<meta name="calibre:series_index" content="'+seriesIndex+'"/>\n':'')
      : '';
    const opf=['<?xml version="1.0" encoding="utf-8"?>\n<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="uid">\n<metadata xmlns:dc="http://purl.org/dc/elements/1.1/">\n<dc:title>'+escHtml(title)+'</dc:title>\n'+(String(author||'').trim()?'<dc:creator>'+escHtml(author)+'</dc:creator>\n':'')+'<dc:language>'+escHtml(lang)+'</dc:language>\n<dc:identifier id="uid">'+uid+'</dc:identifier>\n<dc:date>'+today+'</dc:date>\n<meta property="dcterms:modified">'+modified+'</meta>\n'+(publisher?'<dc:publisher>'+escHtml(publisher)+'</dc:publisher>\n':'')+seriesMeta+(coverInfo?'<meta name="cover" content="cover_img"/>\n':'')+'\n</metadata>\n<manifest>\n<item id="css" href="style.css" media-type="text/css"/>\n<item id="ncx" href="toc.ncx" media-type="application/x-dtbncx+xml"/>\n<item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>\n'];
    manifestItems.forEach(it=>opf.push('<item id="'+it.id+'" href="'+it.href+'" media-type="'+it.mt+'"/>\n'));
    if(coverInfo) opf.push('<item id="cover_img" href="Images/'+coverInfo.filename+'" media-type="'+coverInfo.mt+'" properties="cover-image"/>\n');
    for(const[key,info]of imgStore){if(key==='cover')continue;opf.push('<item id="imgf_'+info.filename.replace(/\W/g,'_')+'" href="Images/'+info.filename+'" media-type="'+info.mt+'"/>\n');}
    opf.push('</manifest>\n<spine toc="ncx">\n');spineItems.forEach(s=>opf.push('<itemref idref="'+s+'"/>\n'));opf.push('</spine>\n</package>');
    oebps.file('content.opf',opf.join(''));
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
    // ★ 4단계 GC: imgStore의 ArrayBuffer 참조 정리
    imgStore.clear();
    self.postMessage({type:'done',blob});
  }catch(err){
    // ★ P2-04: 스택 트레이스 포함 에러 전송 — 디버깅 가능
    try{ if(imgStore) imgStore.clear(); }catch(_){}
    self.postMessage({type:'error',message:(err&&(err.stack||err.message))||String(err)});
  }
}

// ── XHTML 페이지 템플릿 (Worker 전용, toString()으로 이식) ──
// ★ Phase 10: xml:lang/lang 속성 추가 (리더기 하이픈·글꼴 언어 판단, 접근성)
function _epubXhtmlPage(t,b,lang){
  const L=escHtml(lang||'ko');
  return '<?xml version="1.0" encoding="utf-8"?><!DOCTYPE html>\n<html xmlns="http://www.w3.org/1999/xhtml" xml:lang="'+L+'" lang="'+L+'"><head>\n<title>'+escHtml(t)+'</title>\n<link rel="stylesheet" type="text/css" href="../style.css"/>\n</head><body>\n'+b+'\n</body></html>';
}

// ── 목차 표시명 (Worker 전용, toString()으로 이식) ──
//   간격 분할 '(3/20)' → '3페이지' · 'Chapter 12' → '12화' · 삽화가 붙은 챕터 → '제목 삽화'
function _epubTocLabel(h,hasIll){
  if(hasIll) return h+' 삽화';
  if(RX_AUTO_PAGE.test(h)){const m=h.match(RX_PARENS);return m?m[1]+'페이지':h;}
  const m=h.match(RX_CHAPTER_N);
  return m?m[1]+'화':h;
}

// ── 제목 → 화 번호 (Worker 전용 폴백 — 감지 단계 meta.num이 없을 때만 사용) ──
// ★ Phase 10: 'N화/회/話/장' 앞 번호 우선 (이전: 첫 숫자 → '제2부 15화'가 2화로 매핑)
function _epubChNum(h){
  const s=String(h||'');
  const m=s.match(/(\d+)\s*(?:화|회|話|장|章)/)||s.match(/\d+/);
  return m?parseInt(m[1]!=null?m[1]:m[0],10):null;
}

function _buildWorkerSrc(jszipUrl){
  // ★ Phase 10: 본문 렌더링 함수는 parser.js 단일 소스 (로드 순서상 항상 먼저 정의됨)
  if(typeof renderBodyHtml!=='function'||typeof buildTocTree!=='function'||typeof _decodeHtmlEntities!=='function')
    throw new Error('EPUB Worker 소스 생성 실패 — parser.js가 epub-gen.js보다 먼저 로드되어야 합니다');
  const rx=r=>r.toString();
  return [
    "'use strict';",
    'importScripts('+JSON.stringify(jszipUrl)+');',
    // ★ P2-04: 루프 외부 정규식 사전 컴파일
    'const RX_AUTO_PAGE=/^\\(\\d+\\/\\d+\\)$/;',
    'const RX_CHAPTER_N=/^Chapter\\s+(\\d+)$/;',
    'const RX_PARENS=/\\((\\d+)\\/(\\d+)\\)/;',
    // parser.js 렌더링 상수·함수 (단일 소스)
    'const _RX_AMP='+rx(_RX_AMP)+';',
    'const _RX_LT='+rx(_RX_LT)+';',
    'const _RX_GT='+rx(_RX_GT)+';',
    'const _RX_QUOT='+rx(_RX_QUOT)+';',
    'const _RX_APOS='+rx(_RX_APOS)+';',
    'const _RX_SANITIZE='+rx(_RX_SANITIZE)+';',
    'const _RX_ENTITY='+rx(_RX_ENTITY)+';',
    'const _NAMED_ENTITY='+JSON.stringify(_NAMED_ENTITY)+';',
    'const _RX_SYSMSG_OPEN='+rx(_RX_SYSMSG_OPEN)+';',
    'const _RX_SYSMSG_CLOSE='+rx(_RX_SYSMSG_CLOSE)+';',
    'const _RX_FLASHBACK='+rx(_RX_FLASHBACK)+';',
    _escHtmlViaDOM.toString(),
    escHtml.toString(),
    sanitizeLine.toString(),
    _decodeHtmlEntities.toString(),
    renderBodyHtml.toString(),
    // ★ 계층 목차 빌더는 parser.js 단일 소유 — toString()으로 Worker에 이식 (복사본 없음)
    buildTocTree.toString(),
    'const xhtmlPage='+_epubXhtmlPage.toString()+';',
    'const tocLabel='+_epubTocLabel.toString()+';',
    'const extractChNum='+_epubChNum.toString()+';',
    'self.onmessage='+_epubWorkerMain.toString()+';',
  ].join('\n');
}

// ══════════════════════════════════════════
// P2-03: launchEpubWorker — Worker URL 누수 방지 + renderedBodies 제거
// ══════════════════════════════════════════
// ★ Phase 10: opts.signal(AbortSignal) — 중단 시 Worker 즉시 terminate + AbortError로 reject
async function launchEpubWorker({ title, author, chapters, coverFile, illMap=[], useItalic=true, series='', seriesIndex=0 }, onProgress, opts={}){
  const signal = opts?.signal || null;
  const abortErr = ()=>{ const err=new Error('사용자 중단'); err.name='AbortError'; return err; };
  if(signal?.aborted) throw abortErr();
  // ① 메인 스레드 전처리 (DOM 필요 작업)
  onProgress&&onProgress(3, '이미지 전처리 중...');
  const imageData = await processImagesParallel(coverFile, illMap, signal);
  if(signal?.aborted) throw abortErr();
  const cssText   = buildCss();

  // ★ P2-01: renderedBodies 사전 생성 폐지
  // 이전: chapters.map(([,body])=>renderBodyHtml(body,...)) → 전체 HTML 배열 메모리 점유
  //       → Worker postMessage 시 structuredClone 복사 → 메모리 2배 피크
  // 수정: chapters(원문) 그대로 Worker에 전달, Worker 내부에서 챕터별 즉석 렌더링
  //       → 메인 스레드 HTML 배열 불필요 → 메모리 피크 ~50% 감소

  const illMapMeta = illMap.map((il,i)=>({
    idx:      il.idx,
    ch:       il.ch,
    kw:       il.kw,
    pos:      il.pos,
    file_idx: i,
  }));

  // ② Blob Worker 생성
  const jszipUrl  = 'https://cdnjs.cloudflare.com/ajax/libs/jszip/3.10.1/jszip.min.js';
  const workerSrc  = _buildWorkerSrc(jszipUrl);
  const workerBlob = new Blob([workerSrc], {type:'application/javascript'});
  const workerUrl  = URL.createObjectURL(workerBlob);

  let worker;
  // ★ P2-03: new Worker 예외 시 URL 누수 방지
  try{
    worker = new Worker(workerUrl);
  }catch(e){
    URL.revokeObjectURL(workerUrl);
    throw new Error('Worker 생성 실패 (CSP 또는 환경 제한): '+e.message);
  }

  // ③ Worker 메시지 통신
  return new Promise((resolve, reject)=>{
    let settled=false;
    const finish=(fn, val)=>{
      if(settled) return;
      settled=true;
      worker.terminate();
      URL.revokeObjectURL(workerUrl);
      signal?.removeEventListener('abort', onAbort);
      fn(val);
    };
    // ★ Phase 10: 사용자 중단 → Worker 종료
    const onAbort=()=>finish(reject, abortErr());
    signal?.addEventListener('abort', onAbort, {once:true});
    worker.onmessage = function(e){
      const { type, pct, msg, blob, message } = e.data;
      if(type==='progress'){
        if(!settled) onProgress&&onProgress(pct, msg);
        return;
      }
      if(type==='done'){ finish(resolve, blob); return; }
      if(type==='error'){
        // ★ P2-04: message에 스택 트레이스 포함됨
        // ★ Phase 10: EPUB 생성 실패는 치명적 오류(일반 Error) — 호출자가 오류 박스로 표시
        //   (이전: RecoverableError로 감싸 '계속 진행합니다' 경고만 표시)
        finish(reject, new Error('EPUB 생성 실패: ' + (message||'Worker 오류')));
        return;
      }
    };
    worker.onerror = function(e){
      finish(reject, new Error('Worker 런타임 오류: '+(e.message||'알 수 없는 오류')));
    };

    // ④ 파라미터 전송
    // ★ P2-01: renderedBodies 제거 — chapters 원문만 전송
    const showChTitle    = document.getElementById('optChTitle')?.checked !== false;
    const compressionRaw = parseInt(document.getElementById('optCompression')?.value??'6',10);
    const compressionLevel = isNaN(compressionRaw)?6:Math.max(0,Math.min(9,compressionRaw));
    const lang = document.getElementById('optLang')?.value||'ko';
    // ★ Part2: 본문 공백 최적화 플래그 — optRemoveBlankLines 체크박스에서 읽음
    const removeBlankLines = document.getElementById('optRemoveBlankLines')?.checked ?? false;
    // ★ 설정 탭 '출판사(publisher) 태그' — 비워두면 dc:publisher 미포함
    const publisher = (document.getElementById('optPublisher')?.value || '').trim();

    // Transferable 목록 — AB는 zero-copy 이전 후 메인 스레드에서 접근 불가
    const transferables = [
      ...(imageData.cover ? [imageData.cover.ab] : []),
      ...imageData.ills.map(ill=>ill.ab),
    ];

    worker.postMessage(
      {
        params:{
          title, author,
          chapters,   // ★ 원문 그대로 (renderedBodies 제거)
          illMapMeta, useItalic, showChTitle,
          compressionLevel, lang,
          // ★ Part2: 본문 공백 최적화 플래그 전달
          removeBlankLines,
          publisher,
          series: String(series||'').trim(),
          seriesIndex: Math.max(0, parseInt(seriesIndex,10)||0),
          // ★ core.js genUID — crypto.randomUUID가 없는 비보안 컨텍스트(http://LAN IP 접속 등) 폴백 포함
          //   (이전: crypto.randomUUID 직접 호출 → http 환경에서 'randomUUID is not a function'으로 변환 실패)
          uid:   'urn:uuid:'+(typeof genUID==='function'?genUID():crypto.randomUUID()),
          today: new Date().toISOString().slice(0,10),
          // ★ EPUB3 필수 메타 dcterms:modified (CCYY-MM-DDThh:mm:ssZ, 밀리초 없음)
          modified: new Date().toISOString().replace(/\.\d{3}Z$/,'Z'),
          // renderedBodies: 폐지
        },
        imageData, cssText,
      },
      // Transferable: zero-copy ArrayBuffer 이전
      transferables
    );

    // ★ 4단계 GC: postMessage 직후 메인 스레드에서 imageData 참조 해제
    // Transferable로 이전된 AB는 이미 Worker 소유 — 메인 스레드 참조 null 처리
    // imageData.cover/ills는 이제 detached ArrayBuffer만 남음 → GC 수거 가능
    imageData.cover = null;
    imageData.ills = [];
  });
}

// ══════════════════════════════════════════
// buildEpub — 하위 호환 래퍼
// ★ 4단계: RecoverableError 분기 + UI 복구 안전망
// ══════════════════════════════════════════
// ★ Phase 10: 오류를 RecoverableError로 일괄 변환하지 않음 — 실패는 실패로 전파 (AbortError 포함)
//   UI 복구(진행 바 해제·중단 버튼 숨김)는 호출자(startConvert 등)의 finally가 담당
async function buildEpub(params, onProgress, opts={}){
  return launchEpubWorker(params, onProgress, opts);
}
