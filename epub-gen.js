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
// ★ Phase 14: 리더기 프로필 — 대상 리더기에 맞춰 다크 모드 CSS·표지 최대 높이·이미지 형식을 조정
//   darkCss  : prefers-color-scheme:dark 기본색 CSS 포함 여부 (자체 테마가 있는 리더 앱은 끄는 편이 충돌이 적음)
//   coverMaxH: 표지가 이보다 크면 축소 (작으면 그대로 — 확대하지 않음)
//   forceJpg : 삽화를 항상 JPG로 변환 (WebP 지원이 불확실한 기기)
const READER_PROFILES={
  default:{label:'기본',                    darkCss:true,  coverMaxH:1200, forceJpg:false},
  ridi:   {label:'리디북스',                darkCss:false, coverMaxH:1600, forceJpg:false},
  apple:  {label:'Apple Books',             darkCss:false, coverMaxH:2400, forceJpg:false},
  kobo:   {label:'Kobo',                    darkCss:false, coverMaxH:1600, forceJpg:true},
  kindle: {label:'Kindle (Send to Kindle)', darkCss:false, coverMaxH:2560, forceJpg:true},
  play:   {label:'Google Play 북',          darkCss:false, coverMaxH:1600, forceJpg:false},
};
function getReaderProfile(){
  const key=document.getElementById('optReaderProfile')?.value||'default';
  return {key:READER_PROFILES[key]?key:'default', ...(READER_PROFILES[key]||READER_PROFILES.default)};
}
function describeReaderProfile(p){
  return '표지 최대 높이 '+p.coverMaxH+'px · 다크 모드 기본색 '+(p.darkCss?'포함':'제외')+' · 삽화 '+(p.forceJpg?'항상 JPG 변환':'설정 따름');
}

// opts.fontFace: @font-face 블록 대체값 (EPUB 패키징 시 data URI 대신 Fonts/ 파일 경로) — 생략 시 미리보기용 data URI
function buildCss(opts={}){
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
  const fontFaceBlock=opts.fontFace!=null?opts.fontFace:(typeof customFontFace!=='undefined'?customFontFace||'':'');
  const extra=document.getElementById('cssExtra')?.value||'';
  let h1Extra=`text-align:${titleStyle==='left'?'left':'center'};`;
  if(titleStyle==='underline') h1Extra+='border-bottom:2px solid currentColor;padding-bottom:0.3em;text-align:center;';
  if(titleStyle==='box') h1Extra+='border:1.5px solid currentColor;padding:0.25em 1em;border-radius:6px;display:inline-block;';
  // ★ Phase 12: 다크 모드 기본색은 글자색·배경색을 둘 다 지정하지 않았을 때만 적용
  //   (이전: 글자색만 지정하면 다크 모드에서 배경만 어둡게 바뀌어 어두운 글자 + 어두운 배경 → 읽을 수 없음,
  //    배경색만 지정하면 밝은 배경 + 밝은 글자). 하나라도 지정했다면 사용자가 고른 색 조합을 그대로 유지
  const darkBlock=(getReaderProfile().darkCss&&!textColor&&!bgColor)?'@media (prefers-color-scheme:dark){body{background-color:#1a1208;color:#e8d8c4;}}\n':'';
  return `@charset "UTF-8";\n${fontFaceBlock}\nbody{font-family:${font};line-height:${line};font-size:${size};margin:0;padding:${padTop} ${padRight} ${padBottom} ${padLeft};word-break:keep-all;overflow-wrap:break-word;text-align:${align};${textColor?'color:'+textColor+';':''}${bgColor?'background-color:'+bgColor+';':''}}\nh1{font-size:1.3em;${h1Extra}margin:1.2em 0 1.8em;font-weight:700;letter-spacing:-0.02em}\np{margin:0;padding:0.25em 0;text-indent:${useIndent?indentEm+'em':'0'}}\np.noindent{text-indent:0}\nem.flashback{font-style:italic;opacity:.85}\np.sysmsg{text-align:center;font-style:italic;opacity:.75;text-indent:0}\nhr.scene{border:0;margin:1.6em auto;text-align:center;height:1.2em;overflow:visible}\nhr.scene::after{content:"\\2042";opacity:.6;letter-spacing:.3em}\n.illust-page{display:flex;align-items:center;justify-content:center;min-height:80vh;text-align:center;padding:0}\n.illust-page img{max-width:100%;max-height:100vh;object-fit:contain}\n${darkBlock}${extra}`;
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
  const MAX_H=getReaderProfile().coverMaxH;   // ★ Phase 14: 리더기 프로필 (기본 1200)
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
      const conv = await convertImageFile(target, true);
      if(conv){   // ★ Phase 14: 변환 실패(null)는 convertImageFile이 이미 안내 — 중복 경고 없이 표지 생략
        const { blob, ext, mt } = conv;
        const ab = await fileToAB(blob);
        result.cover = { ab, ext, mt };
      }
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
          const conv = await convertImageFile(il.file, false);
          if(!conv) return null;   // ★ Phase 14: 이미 안내됨 — 중복 경고 없이 생략
          const { blob, ext, mt } = conv;
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
    const{params,imageData,cssText,fontData=null}=e.data;
    const{title,author,chapters,illMapMeta,useItalic,showChTitle,
          compressionLevel,lang,uid,today,modified,
          publisher='',series='',seriesIndex=0,
          removeBlankLines=false,sceneBreak=false}=params;
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
    // ★ Phase 14: 커스텀 폰트 파일 (WOFF/WOFF2는 이미 압축 → STORE)
    if(fontData&&fontData.ab&&fontData.name){
      oebps.folder('Fonts').file(fontData.name, fontData.ab, {compression:/\.woff2?$/.test(fontData.name)?'STORE':'DEFLATE'});
    }
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
      const body=renderBodyHtml(rawBody,{useItalic,maxBlank:2,removeBlankLines,sceneBreak});
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
    // ★ Phase 14: landmarks — 리더기의 '표지로'·'처음부터 읽기'(본문 시작) 위치
    //   본문 시작 = '서문'(첫 제목 앞 내용)이 아닌 첫 챕터, 없으면 첫 챕터
    const firstBody=tocEntries.find(t=>t.heading!=='서문')||tocEntries[0]||null;
    const landmarks=[];
    if(coverInfo) landmarks.push('<li><a epub:type="cover" href="Text/cover.xhtml">표지</a></li>');
    // (목차 landmark는 nav.xhtml이 spine 밖이라 epubcheck RSC-011 — 넣지 않음, 리더기는 nav의 epub:type="toc"를 직접 사용)
    if(firstBody) landmarks.push('<li><a epub:type="bodymatter" href="'+firstBody.href+'">본문 시작</a></li>');
    const landmarksNav='<nav epub:type="landmarks" hidden="hidden"><h2>바로가기</h2><ol>\n'+landmarks.join('\n')+'\n</ol></nav>';
    oebps.file('nav.xhtml','<?xml version="1.0" encoding="utf-8"?><!DOCTYPE html>\n<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops" xml:lang="'+langAttr+'" lang="'+langAttr+'"><head><title>'+escHtml(title)+'</title></head><body><nav epub:type="toc"><h1>목차</h1>\n'+navList(navNodes)+'</nav>\n'+landmarksNav+'</body></html>');
    // ★ 시리즈 메타: EPUB3 표준(belongs-to-collection) + Calibre/리더기 호환(calibre:series)
    const seriesMeta=series
      ? '<meta property="belongs-to-collection" id="series">'+escHtml(series)+'</meta>\n'+
        '<meta refines="#series" property="collection-type">series</meta>\n'+
        (seriesIndex>0?'<meta refines="#series" property="group-position">'+seriesIndex+'</meta>\n':'')+
        '<meta name="calibre:series" content="'+escHtml(series)+'"/>\n'+
        (seriesIndex>0?'<meta name="calibre:series_index" content="'+seriesIndex+'"/>\n':'')
      : '';
    // ★ Phase 14: 접근성 메타데이터 (EPUB Accessibility 1.1 / schema.org) — 스토어·도서관 검색, 보조기기 안내용
    const hasImages=imgStore.size>0;
    const a11yMeta=
      '<meta property="schema:accessMode">textual</meta>\n'+
      (hasImages?'<meta property="schema:accessMode">visual</meta>\n':'')+
      '<meta property="schema:accessModeSufficient">textual</meta>\n'+
      '<meta property="schema:accessibilityFeature">structuralNavigation</meta>\n'+
      '<meta property="schema:accessibilityFeature">tableOfContents</meta>\n'+
      '<meta property="schema:accessibilityFeature">readingOrder</meta>\n'+
      '<meta property="schema:accessibilityHazard">none</meta>\n'+
      '<meta property="schema:accessibilitySummary">'+escHtml('챕터별 제목 구조와 목차(nav)를 갖춘 텍스트 중심 전자책입니다.'+(hasImages?' 표지·삽화 이미지는 장식용으로 본문 이해에 필요하지 않습니다.':''))+'</meta>\n';
    const opf=['<?xml version="1.0" encoding="utf-8"?>\n<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="uid">\n<metadata xmlns:dc="http://purl.org/dc/elements/1.1/">\n<dc:title>'+escHtml(title)+'</dc:title>\n'+(String(author||'').trim()?'<dc:creator>'+escHtml(author)+'</dc:creator>\n':'')+'<dc:language>'+escHtml(lang)+'</dc:language>\n<dc:identifier id="uid">'+uid+'</dc:identifier>\n<dc:date>'+today+'</dc:date>\n<meta property="dcterms:modified">'+modified+'</meta>\n'+(publisher?'<dc:publisher>'+escHtml(publisher)+'</dc:publisher>\n':'')+seriesMeta+a11yMeta+(coverInfo?'<meta name="cover" content="cover_img"/>\n':'')+'\n</metadata>\n<manifest>\n<item id="css" href="style.css" media-type="text/css"/>\n<item id="ncx" href="toc.ncx" media-type="application/x-dtbncx+xml"/>\n<item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>\n'];
    manifestItems.forEach(it=>opf.push('<item id="'+it.id+'" href="'+it.href+'" media-type="'+it.mt+'"/>\n'));
    if(coverInfo) opf.push('<item id="cover_img" href="Images/'+coverInfo.filename+'" media-type="'+coverInfo.mt+'" properties="cover-image"/>\n');
    if(fontData&&fontData.ab&&fontData.name) opf.push('<item id="font_custom" href="Fonts/'+fontData.name+'" media-type="'+fontData.mt+'"/>\n');
    for(const[key,info]of imgStore){if(key==='cover')continue;opf.push('<item id="imgf_'+info.filename.replace(/\W/g,'_')+'" href="Images/'+info.filename+'" media-type="'+info.mt+'"/>\n');}
    opf.push('</manifest>\n<spine toc="ncx">\n');spineItems.forEach(s=>opf.push('<itemref idref="'+s+'"/>\n'));opf.push('</spine>\n</package>');
    oebps.file('content.opf',opf.join(''));
    prog(92,'압축 중...');
    // ★ Phase 15: 스트리밍 저장 — 결과 ZIP을 메모리에 모으지 않고 조각(chunk)마다 메인 스레드로 보내 파일에 바로 기록
    if(params.stream){
      let total=0, lastPct=-1;
      await new Promise((resolve,reject)=>{
        zip.generateInternalStream({type:'uint8array',mimeType:'application/epub+zip',compression:'DEFLATE',compressionOptions:{level:compressionLevel},streamFiles:true})
          .on('data',(data,meta)=>{
            const c=data.slice();   // JSZip 내부 버퍼를 분리하지 않도록 복사본을 전송
            total+=c.byteLength;
            self.postMessage({type:'chunk',data:c},[c.buffer]);
            const p=Math.floor(meta.percent);
            if(p!==lastPct){ lastPct=p; self.postMessage({type:'progress',pct:92+Math.floor(p*0.07),msg:'파일에 저장 중 '+p+'%...'}); }
          })
          .on('error',reject)
          .on('end',resolve)
          .resume();
      });
      imgStore.clear();
      self.postMessage({type:'done',streamed:true,size:total});
      return;
    }
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
    'const _RX_SCENE='+rx(_RX_SCENE)+';',   // ★ Phase 13: 장면 구분선
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

// ★ Phase 14: 커스텀 폰트를 EPUB 안의 파일(OEBPS/Fonts/)로 분리
//   이전: style.css에 수 MB짜리 base64 data URI로 박아 넣음 → 모든 챕터가 거대한 CSS를 다시 파싱,
//         data URI 글꼴을 지원하지 않는 리더기에서 폰트 미적용. manifest에도 글꼴이 드러나지 않음
const _FONT_EXT_BY_MIME={'font/ttf':'ttf','font/otf':'otf','font/woff':'woff','font/woff2':'woff2'};
function _extractCustomFont(face){
  if(typeof face!=='string'||!face) return null;
  const m=face.match(/font-family:"([^"]+)";src:url\("data:([^;]+);base64,([A-Za-z0-9+/=]+)"\) format\("([a-z0-9]+)"\)/);
  if(!m) return null;
  const [,family,mime,b64,fmt]=m;
  const ext=_FONT_EXT_BY_MIME[mime];
  if(!ext||b64.length%4!==0) return null;
  let bin;
  try{ bin=atob(b64); }catch(e){ return null; }
  const bytes=new Uint8Array(bin.length);
  for(let i=0;i<bin.length;i++) bytes[i]=bin.charCodeAt(i);
  return {family, fmt, mt:mime, name:'custom_font.'+ext, ab:bytes.buffer};
}
function _fontFaceForEpub(font){
  // ★ Phase 22: 서브셋한 폰트는 표식 주석을 앞에 붙임 → 편집 탭이 '다시 서브셋할 대상'을 알아봄
  return font?(font.subset?_FONT_SUBSET_MARK:'')+'@font-face{font-family:"'+font.family+'";src:url("Fonts/'+font.name+'") format("'+font.fmt+'");}\n':'';
}

// ════════════════════════════════════════════════
// ★ Phase 22: 커스텀 폰트 서브셋 — 책에 쓰인 글자만 남김
//   엔진: HarfBuzz (harfbuzzjs 1.6.3 dist/harfbuzz-subset.wasm · MIT/Old MIT — lib/harfbuzz-LICENSE.txt)
//   · 커스텀 폰트를 쓸 때만 받아옴(무결성 해시 확인) — 한 번 받으면 SW 캐시로 오프라인에서도 동작
//   · TTF·OTF만 (WOFF·WOFF2·TTC는 원본 그대로), OS/2 fsType '서브셋 금지(0x0100)'면 원본 그대로
//   · 어떤 이유로든 실패하면 원본 폰트를 그대로 넣음 — 폰트 때문에 변환이 실패하지 않음
//   · 글자 집합 = 제목·작가·시리즈·챕터 제목·본문 + EPUB 템플릿 고정 문구(Worker 소스의 비ASCII 문자)
//                 + CSS가 만드는 문자(장면 구분 ⁂ 등) + ASCII 출력 문자·공백류 — 실제 표시 글자의 상위 집합
//   · CSP: WebAssembly 컴파일에 script-src 'wasm-unsafe-eval' 필요 (JS eval·new Function은 계속 차단)
// ════════════════════════════════════════════════
const HB_SUBSET_WASM='lib/harfbuzz-subset.wasm';
const HB_SUBSET_SRI='sha384-cTWl+XqUqrXL27q3HoTXEGtCsjfxsxISeCA8bCiAqmQpTHD0x7kH5JjgsCfoIfE/';
const _FONT_SUBSET_MARK='/* novelepub:font-subset */';
let _hbModulePromise=null;
let _lastFontSubsetReport=null;
let _epubTemplateTextCache=null;

// 컴파일한 모듈은 재사용, 실패하면 다음 변환에서 다시 시도
function _loadHbSubset(){
  if(!_hbModulePromise){
    _hbModulePromise=(async()=>{
      if(typeof WebAssembly!=='object'||typeof fetch!=='function') throw new Error('WebAssembly를 쓸 수 없는 환경');
      const base=(typeof document!=='undefined'&&document.baseURI)||'';
      const url=base?new URL(HB_SUBSET_WASM, base).href:HB_SUBSET_WASM;
      const resp=await fetch(url, {integrity:HB_SUBSET_SRI});
      if(!resp||!resp.ok) throw new Error('서브셋 엔진을 받지 못함 (HTTP '+(resp?resp.status:'?')+')');
      return WebAssembly.compile(await resp.arrayBuffer());
    })();
    _hbModulePromise.catch(()=>{ _hbModulePromise=null; });
  }
  return _hbModulePromise;
}

// 폰트 파일 형식(sfnt 태그)과 OS/2 fsType(임베딩·서브셋 허용 표시)
function _fontFileInfo(bytes){
  const out={kind:null, fsType:0};
  if(!bytes||bytes.byteLength<12) return out;
  const dv=new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const KIND={0x00010000:'ttf', 0x74727565:'ttf', 0x4F54544F:'otf', 0x774F4646:'woff', 0x774F4632:'woff2', 0x74746366:'ttc'};
  out.kind=KIND[dv.getUint32(0)]||null;
  if(out.kind!=='ttf'&&out.kind!=='otf') return out;
  const n=dv.getUint16(4);
  for(let i=0;i<n;i++){
    const rec=12+i*16;
    if(rec+16>bytes.byteLength) break;
    if(dv.getUint32(rec)===0x4F532F32){   // 'OS/2'
      const off=dv.getUint32(rec+8);
      if(off+10<=bytes.byteLength) out.fsType=dv.getUint16(off+8);
      break;
    }
  }
  return out;
}

// cmap(format 4·12)에 들어 있는 코드포인트 — 편집 탭에서 '폰트에 없는 글자' 확인용
function _fontCmapCodepoints(bytes){
  const set=new Set();
  if(!bytes||bytes.byteLength<12) return set;
  const dv=new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const len=bytes.byteLength;
  let cmap=-1;
  const n=dv.getUint16(4);
  for(let i=0;i<n;i++){ const rec=12+i*16; if(rec+16>len) break; if(dv.getUint32(rec)===0x636D6170){ cmap=dv.getUint32(rec+8); break; } }   // 'cmap'
  if(cmap<0||cmap+4>len) return set;
  const subs=[];
  const nt=dv.getUint16(cmap+2);
  for(let i=0;i<nt;i++){
    const e=cmap+4+i*8; if(e+8>len) break;
    const pid=dv.getUint16(e), eid=dv.getUint16(e+2), off=cmap+dv.getUint32(e+4);
    if(off+4>len) continue;
    const fmt=dv.getUint16(off);
    if((pid===3&&(eid===1||eid===10))||pid===0) subs.push({fmt, off});
  }
  for(const {fmt, off} of subs){
    if(fmt===4){
      const segX2=dv.getUint16(off+6), endO=off+14, startO=endO+segX2+2, deltaO=startO+segX2, rangeO=deltaO+segX2;
      if(rangeO+segX2>len) continue;
      for(let i=0;i<segX2/2;i++){
        const end=dv.getUint16(endO+i*2), start=dv.getUint16(startO+i*2), delta=dv.getUint16(deltaO+i*2), ro=dv.getUint16(rangeO+i*2);
        for(let c=start;c<=end&&c!==0xFFFF;c++){
          let g;
          if(ro===0) g=(c+delta)&0xFFFF;
          else { const ga=rangeO+i*2+ro+(c-start)*2; if(ga+2>len) break; g=dv.getUint16(ga); if(g) g=(g+delta)&0xFFFF; }
          if(g) set.add(c);
        }
      }
    }else if(fmt===12){
      const ng=dv.getUint32(off+12);
      for(let i=0;i<ng;i++){
        const gp=off+16+i*12; if(gp+12>len) break;
        const st=dv.getUint32(gp), en=dv.getUint32(gp+4), g0=dv.getUint32(gp+8);
        for(let c=st;c<=en&&c<0x110000;c++) if(g0+(c-st)) set.add(c);
      }
    }
  }
  return set;
}

// 문자열들에 쓰인 코드포인트 (서로게이트 쌍 결합, 제어 문자 제외) + ASCII 출력 문자·공백류
//   BMP는 비트맵으로 빠르게 표시(수십 MB 원고도 한 번 훑기), 보조 평면(이모지 등)만 Set
function _collectFontCodepoints(texts){
  const bmp=new Uint8Array(0x10000);
  const extra=new Set();
  for(let c=0x20;c<0x7F;c++) bmp[c]=1;
  for(const c of [0xA0, 0x3000]) bmp[c]=1;
  for(const s of texts){
    if(typeof s!=='string') continue;
    for(let i=0;i<s.length;i++){
      const c=s.charCodeAt(i);
      if(c>=0xD800&&c<=0xDBFF&&i+1<s.length){
        const d=s.charCodeAt(i+1);
        if(d>=0xDC00&&d<=0xDFFF){ extra.add(0x10000+((c-0xD800)<<10)+(d-0xDC00)); i++; continue; }
      }
      if(c>=0x20&&(c<0x7F||c>=0xA0)) bmp[c]=1;
    }
  }
  const out=new Set(extra);
  for(let c=0;c<0x10000;c++) if(bmp[c]&&(c<0xD800||c>0xDFFF)) out.add(c);
  return out;
}

// EPUB 템플릿(Worker 소스)에 들어 있는 비ASCII 문자 — 목차·표지 등 고정 문구 (한 번만 계산)
function _epubTemplateText(){
  if(_epubTemplateTextCache===null){
    try{ _epubTemplateTextCache=_buildWorkerSrc('').replace(/[\x00-\x7f]+/g, ''); }catch(e){ _epubTemplateTextCache=''; }
  }
  return _epubTemplateTextCache;
}

// HarfBuzz로 서브셋 — 호출마다 새 인스턴스(끝나면 WebAssembly 메모리 통째로 해제), 실패하면 null
async function _hbSubsetBytes(module, bytes, codepoints){
  const inst=await WebAssembly.instantiate(module, {});
  const x=inst.exports;
  const ptr=x.malloc(bytes.byteLength);
  if(!ptr) throw new Error('서브셋 메모리 부족');
  new Uint8Array(x.memory.buffer).set(bytes, ptr);
  const blob=x.hb_blob_create(ptr, bytes.byteLength, 2/* HB_MEMORY_MODE_WRITABLE */, 0, 0);
  const face=x.hb_face_create(blob, 0);
  x.hb_blob_destroy(blob);
  const input=x.hb_subset_input_create_or_fail();
  if(!input){ x.hb_face_destroy(face); x.free(ptr); throw new Error('서브셋 입력을 만들지 못함'); }
  const uset=x.hb_subset_input_unicode_set(input);
  for(const cp of codepoints) x.hb_set_add(uset, cp);
  const sub=x.hb_subset_or_fail(face, input);
  x.hb_subset_input_destroy(input);
  let out=null;
  if(sub){
    const rb=x.hb_face_reference_blob(sub);
    const off=x.hb_blob_get_data(rb, 0), n=x.hb_blob_get_length(rb);
    if(n>0) out=new Uint8Array(x.memory.buffer).slice(off, off+n);   // 서브셋 중 메모리가 커졌을 수 있어 새 뷰에서 복사
    x.hb_blob_destroy(rb);
    x.hb_face_destroy(sub);
  }
  x.hb_face_destroy(face);
  x.free(ptr);
  return out;
}

// fontData({family, fmt, mt, name, ab}) → 서브셋한 fontData (실패·제외면 원본 그대로) — 결과는 takeFontSubsetReport()로
async function _subsetCustomFont(fontData, texts){
  _lastFontSubsetReport=null;
  if(!fontData||!fontData.ab) return fontData;
  const bytes=new Uint8Array(fontData.ab);
  const info=_fontFileInfo(bytes);
  const rep={from:bytes.byteLength, to:bytes.byteLength, kind:info.kind, restricted:(info.fsType&0x000F)===0x0002};
  if(info.kind!=='ttf'&&info.kind!=='otf'){ _lastFontSubsetReport={...rep, skipped:'format'}; return fontData; }
  if(info.fsType&0x0100){ _lastFontSubsetReport={...rep, skipped:'license'}; return fontData; }
  try{
    const cps=_collectFontCodepoints(texts);
    const out=await _hbSubsetBytes(await _loadHbSubset(), bytes, cps);
    if(!out||out.byteLength<12||out.byteLength>=bytes.byteLength){ _lastFontSubsetReport={...rep, skipped:'nochange'}; return fontData; }
    _lastFontSubsetReport={...rep, to:out.byteLength, chars:cps.size};
    return {...fontData, ab:out.buffer, subset:true};
  }catch(e){
    _lastFontSubsetReport={...rep, skipped:'error', error:String(e?.message||e)};
    return fontData;
  }
}
function takeFontSubsetReport(){ const r=_lastFontSubsetReport; _lastFontSubsetReport=null; return r; }

// 변환 리포트 문구 ('폰트:'로 시작하면 정보, 그 밖은 경고로 표시됨)
function describeFontSubsetReport(r){
  if(!r) return [];
  const kb=n=>n>=1024*1024?(n/1024/1024).toFixed(1)+'MB':Math.max(1,Math.round(n/1024))+'KB';
  const out=[];
  if(r.skipped==='unused'){
    out.push(`커스텀 폰트 "${r.family}"를 쓰는 글꼴 설정이 없어 EPUB에 넣지 않았어요 (${kb(r.from)}) — 변환 탭 '변환 옵션 · 스타일'의 폰트(또는 설정 > CSS 커스터마이징)에서 "📁 ${r.family}"를 고르면 적용돼요.`);
    return out;
  }
  if(r.skipped==='format') out.push(`폰트: ${String(r.kind||'').toUpperCase()||'이'} 형식은 서브셋하지 않고 원본 그대로 넣었어요 (${kb(r.from)}) — TTF·OTF 파일을 쓰면 쓰인 글자만 남겨 줄일 수 있어요.`);
  else if(r.skipped==='license') out.push(`폰트: 폰트에 '서브셋 금지' 표시(OS/2 fsType)가 있어 원본 그대로 넣었어요 (${kb(r.from)}).`);
  else if(r.skipped==='error'){
    const e=String(r.error||'');
    const why=/Content Security Policy|unsafe-eval|wasm-eval/i.test(e)?'브라우저 보안 정책(CSP)이 WebAssembly 실행을 막았어요'
      :/HTTP|fetch|network|받지 못함/i.test(e)?'서브셋 엔진 파일을 받지 못했어요 (오프라인에서 처음 쓰는 경우 등)'
      :/integrity|digest/i.test(e)?'서브셋 엔진 파일의 무결성 확인에 실패했어요'
      :'서브셋 엔진 오류 — '+e.slice(0,80);
    out.push(`폰트: ${why} — 원본 그대로 넣었어요 (${kb(r.from)}).`);
  }
  else if(r.skipped==='nochange') out.push(`폰트: 서브셋해도 줄지 않아 원본 그대로 넣었어요 (${kb(r.from)}).`);
  else out.push(`폰트: 책에 쓰인 글자 ${Number(r.chars||0).toLocaleString()}자만 남겨 ${kb(r.from)} → ${kb(r.to)}로 줄였어요.`);
  if(r.restricted) out.push('폰트 라이선스 표시(OS/2 fsType)가 EPUB 포함을 허용하지 않는 폰트예요 — 배포·공유용이면 라이선스를 확인하세요.');
  return out;
}

// EPUB 안에서 글자를 쓰는 문서의 텍스트 (삽입 챕터처럼 시스템 글꼴을 !important로 강제한 문서 제외, 숫자 문자 참조는 풀어서)
async function _zipFontTexts(zip){
  const texts=[];
  for(const p of Object.keys(zip.files||{}).filter(p=>!zip.files[p].dir&&/\.(xhtml|html|htm|ncx)$/i.test(p))){
    const t=await zip.file(p).async('string');
    if(t.includes('/* 커스텀 폰트 폰트 오버라이드 */')) continue;
    texts.push(t.replace(/&#x([0-9a-f]+);|&#(\d+);/gi, (m0, h, d)=>{ try{ return String.fromCodePoint(h?parseInt(h,16):parseInt(d,10)); }catch(e){ return ''; } }));
  }
  return texts;
}

// 편집 탭: 결과 EPUB의 서브셋 폰트 갱신 — 편집으로 새 글자가 생겼을 수 있음
//   설정에 같은 이름의 원본 폰트가 있으면 EPUB 전체 글자로 다시 서브셋, 없으면 '편집으로 새로 생긴 글자 중 폰트에 없는 것'의 수
//   (srcZip: 편집 전 EPUB — 원래부터 폰트에 없던 글자(이모지·드문 한자 등)는 세지 않음)
//   대상: 이 앱이 서브셋한 폰트(CSS 표식)만 — 다른 도구가 만든 EPUB의 폰트는 건드리지 않음
async function refreshEpubFontSubset(zip, srcZip){
  if(!zip||typeof zip.file!=='function') return null;
  const names=Object.keys(zip.files||{}).filter(p=>!zip.files[p].dir);
  const fontPath=names.find(p=>/(^|\/)Fonts\/custom_font\.(ttf|otf)$/.test(p));
  if(!fontPath) return null;
  let family='';
  for(const p of names.filter(p=>/\.css$/i.test(p))){
    const t=await zip.file(p).async('string');
    const m=t.indexOf(_FONT_SUBSET_MARK)>=0&&t.match(/novelepub:font-subset \*\/@font-face\{font-family:"([^"]+)"/);
    if(m){ family=m[1]; break; }
  }
  if(!family) return null;
  const texts=await _zipFontTexts(zip);
  const orig=_extractCustomFont(typeof customFontFace!=='undefined'?customFontFace:'');
  if(orig&&orig.family===family&&orig.name.split('.').pop()===fontPath.split('.').pop()){
    const sub=await _subsetCustomFont(orig, texts);
    const rep=takeFontSubsetReport();
    if(sub&&sub.subset){ zip.file(fontPath, sub.ab); return {resubset:true, from:rep.from, to:rep.to, chars:rep.chars}; }
  }
  const have=_fontCmapCodepoints(await zip.file(fontPath).async('uint8array'));
  const before=srcZip&&srcZip!==zip?_collectFontCodepoints(await _zipFontTexts(srcZip)):null;
  let missing=0;
  for(const cp of _collectFontCodepoints(texts)) if(cp>0x7E&&cp!==0xA0&&cp!==0x3000&&!have.has(cp)&&!(before&&before.has(cp))) missing++;
  return {resubset:false, missing};
}

// ★ Phase 15: EPUB Worker 재사용 — 소스 문자열·Blob URL은 1회 생성, 끝난 Worker는 30초간 유휴 보관 후 재사용
//   (이전: 변환마다 소스 생성 → Blob URL → new Worker → importScripts(JSZip) → terminate.
//    일괄 변환 100권이면 Worker 100개를 띄우고 JSZip을 100번 파싱)
//   오류·중단으로 끝난 Worker는 상태를 믿을 수 없어 재사용하지 않고 종료
const _EPUB_WORKER_IDLE_MS=30000;
const _epubWorkerPool={key:null, url:null, idle:null, idleTimer:null};
function _acquireEpubWorker(jszipUrl){
  const p=_epubWorkerPool;
  if(!p.url||p.key!==jszipUrl){
    if(p.idle){ p.idle.terminate(); p.idle=null; }
    if(p.url) URL.revokeObjectURL(p.url);
    p.url=URL.createObjectURL(new Blob([_buildWorkerSrc(jszipUrl)],{type:'application/javascript'}));
    p.key=jszipUrl;
  }
  if(p.idle){
    const w=p.idle; p.idle=null; clearTimeout(p.idleTimer);
    return w;
  }
  return new Worker(p.url);
}
function _releaseEpubWorker(worker, healthy){
  const p=_epubWorkerPool;
  worker.onmessage=null; worker.onerror=null;
  if(!healthy||p.idle){ worker.terminate(); return; }
  p.idle=worker;
  clearTimeout(p.idleTimer);
  p.idleTimer=setTimeout(()=>{
    if(p.idle){ p.idle.terminate(); p.idle=null; }
    if(p.url){ URL.revokeObjectURL(p.url); p.url=null; p.key=null; }
  }, _EPUB_WORKER_IDLE_MS);
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
  // ★ Phase 14: 커스텀 폰트는 Fonts/ 파일로 (CSS에는 상대 경로만)
  let fontData    = _extractCustomFont(typeof customFontFace!=='undefined'?customFontFace:'');
  // ★ Phase 22: 책에 쓰인 글자만 남김 (설정 '쓰인 글자만 포함' — 기본 켜짐, opts.fontSubset으로 덮어쓰기 가능)
  _lastFontSubsetReport=null;
  const subsetOn  = opts?.fontSubset ?? (typeof document==='undefined'||document.getElementById?.('optFontSubset')?.checked!==false);
  const cssProbe  = buildCss({fontFace:''});
  // ★ Phase 23: 커스텀 폰트를 쓰는 규칙(본문 글꼴·추가 CSS)이 없으면 넣지 않음 — 용량만 늘고 적용되지 않음 (리포트로 안내)
  if(fontData&&!cssProbe.includes(fontData.family)){
    _lastFontSubsetReport={skipped:'unused', family:fontData.family, from:fontData.ab.byteLength, to:0};
    fontData=null;
  }
  if(fontData&&subsetOn){
    onProgress&&onProgress(4, '폰트에서 쓰인 글자만 추리는 중...');
    const fontTexts=function*(){
      yield title; yield author; yield series; yield cssProbe; yield _epubTemplateText();
      for(const ch of chapters||[]) if(Array.isArray(ch)) for(const part of ch) yield part;
    };
    fontData = await _subsetCustomFont(fontData, fontTexts());
    if(signal?.aborted) throw abortErr();
  }
  const cssText   = buildCss({fontFace:_fontFaceForEpub(fontData)});

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

  // ② Worker 확보 (★ Phase 15: 유휴 Worker 재사용)
  // ★ Phase 15: 로컬 lib/jszip.min.js (Blob Worker의 importScripts는 절대 URL 필요)
  const jszipUrl  = new URL('lib/jszip.min.js', document.baseURI).href;
  let worker;
  try{
    worker = _acquireEpubWorker(jszipUrl);
  }catch(e){
    throw new Error('Worker 생성 실패 (CSP 또는 환경 제한): '+e.message);
  }
  // ★ Phase 15: 스트리밍 저장 대상 (FileSystemWritableFileStream) — 있으면 Worker가 조각 단위로 보냄
  const writable = opts?.writable || null;
  let writeChain = Promise.resolve();

  // ③ Worker 메시지 통신
  return new Promise((resolve, reject)=>{
    let settled=false;
    const finish=(fn, val)=>{
      if(settled) return;
      settled=true;
      // ★ Phase 15: 정상 완료만 재사용, 오류·중단은 종료 / 스트리밍 실패 시 쓰다 만 파일 폐기
      _releaseEpubWorker(worker, fn===resolve);
      if(fn!==resolve&&writable) writable.abort?.().catch?.(()=>{});
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
      if(type==='chunk'){
        const data=e.data.data;
        writeChain=writeChain.then(()=>writable.write(data));
        writeChain.catch(err=>finish(reject, new Error('파일 저장 실패: '+(err?.message||err))));
        return;
      }
      if(type==='done'){
        if(e.data.streamed){
          const size=e.data.size||0;
          writeChain.then(()=>writable.close()).then(()=>finish(resolve, {streamed:true, size}))
            .catch(err=>finish(reject, new Error('파일 저장 실패: '+(err?.message||err))));
          return;
        }
        finish(resolve, blob); return;
      }
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
    // ★ Phase 13: 장면 구분선(* * *, ◇◇◇, ----) → <hr class="scene"/>
    const sceneBreak = document.getElementById('optSceneBreak')?.checked === true;
    // ★ 설정 탭 '출판사(publisher) 태그' — 비워두면 dc:publisher 미포함
    const publisher = (document.getElementById('optPublisher')?.value || '').trim();

    // Transferable 목록 — AB는 zero-copy 이전 후 메인 스레드에서 접근 불가
    const transferables = [
      ...(imageData.cover ? [imageData.cover.ab] : []),
      ...imageData.ills.map(ill=>ill.ab),
      ...(fontData ? [fontData.ab] : []),
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
          sceneBreak,
          stream: !!writable,
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
        fontData: fontData ? {name:fontData.name, mt:fontData.mt, ab:fontData.ab} : null,
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
