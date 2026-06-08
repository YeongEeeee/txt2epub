// ════════════════════════════════════════════════
// edit.js — EPUB 편집 탭, 삽화 삽입, 직접 편집
// NovelEPUB | TXT → EPUB3
//
// 의존성: core.js → settings.js → convert.js → parser.js → epub-gen.js
// ════════════════════════════════════════════════

/* global Toast, S, B, E, EI, _eStore, _eiStore, yieldToMain, RecoverableError,
   escHtml, escAttr, buildEpub, JSZip, fileToText, fileToAB, convertImageFile,
   buildCombinedPat, clearChipSelection, _chipSelected, bestPat, PAT_PRESETS,
   previewCoverUrl, applyCoverUrl, handleIllFiles, addManualIllRow,
   _askGeminiForPattern, guessPatternFromExample, getCssVar,
   saveCssSettings, saveExtraSettings, updateCssPreview, updateSettingsSummary,
   renderTocItems, updateTocStat */

'use strict';

// ══════════════════════════════════════════
// ✏️  Module: EditEpub (EPUB 편집 진입)
// ══════════════════════════════════════════
// epubDrop 이벤트는 setupDz에서 처리

// ══════════════════════════════════════════
// 🔧 Module: EpubStructure (OPF·NCX 파싱)
// ══════════════════════════════════════════

// OPF spine toc 속성 → manifest → href 순서로 메인 NCX를 정확히 찾음
// bookN_toc.ncx 같은 챕터별 NCX를 잘못 잡는 버그 방지
function findMainNcx(zipFiles, opfText, opfBase){
  const keys=Object.keys(zipFiles);
  // 1순위: spine toc="id" → manifest에서 해당 id의 href
  const tocIdM=opfText.match(/<spine[^>]+toc="([^"]+)"/);
  if(tocIdM){
    const esc=tocIdM[1].replace(/[.*+?^${}()|[\]\\]/g,'\\$&');
    const tocHrefM=opfText.match(new RegExp('<item[^>]+id="'+esc+'"[^>]+href="([^"]+)"'));
    if(tocHrefM){
      const full=(opfBase+tocHrefM[1]).replace(/\/\//g,'/');
      if(keys.find(f=>f===full)) return full;
    }
  }
  // 2순위: 파일명이 정확히 'toc.ncx'
  const exact=keys.find(f=>f.endsWith('/toc.ncx')||f==='toc.ncx');
  if(exact) return exact;
  // 3순위: 단 하나의 .ncx만 있으면 그게 메인
  const allNcx=keys.filter(f=>f.endsWith('.ncx'));
  if(allNcx.length===1) return allNcx[0];
  // 4순위: 경로 가장 짧은 .ncx (루트에 가까운 것)
  if(allNcx.length>1) return allNcx.sort((a,b)=>a.length-b.length||a.localeCompare(b))[0];
  return null;
}

// OPF manifest에서 nav.xhtml을 정확히 찾음
function findNavXhtml(zipFiles, opfText, opfBase){
  const keys=Object.keys(zipFiles);
  // 1순위: manifest에서 properties="nav" 항목
  const m1=opfText.match(/<item[^>]+properties="[^"]*\bnav\b[^"]*"[^>]+href="([^"]+)"/);
  const m2=opfText.match(/<item[^>]+href="([^"]+)"[^>]+properties="[^"]*\bnav\b[^"]*"/);
  const navHref=(m1||m2||[])[1];
  if(navHref){
    const full=(opfBase+navHref).replace(/\/\//g,'/');
    if(keys.find(f=>f===full)) return full;
  }
  // 2순위: 파일명이 정확히 'nav.xhtml'
  return keys.find(f=>f.endsWith('/nav.xhtml')||f==='nav.xhtml')||null;
}

// 챕터별 NCX 구조 감지 (bookN_toc.ncx 패턴)
function detectPerChapterNcx(zipFiles, opfText, opfBase){
  const keys=Object.keys(zipFiles);
  const perNcx=keys.filter(f=>/book\d+_toc\.ncx/.test(f));
  if(perNcx.length<2) return null;
  const rel=perNcx[0].replace(opfBase,'');
  if(!opfText.includes(`href="${rel}"`)) return null;
  return {type:'per-chapter', opfBase};
}

async function loadEpub(file){
  if(!file||!file.name.endsWith('.epub'))return;
  E.epubFile=file;
  document.getElementById('epubDrop')?.classList.add('ok');
  document.getElementById('epubInfo').style.display='block';
  document.getElementById('epubInfo').textContent='로딩 중...';
  document.getElementById('editResetBar').style.display='flex';
  const ab=await fileToAB(file);
  E.epubZip=await JSZip.loadAsync(ab);
  const container=await E.epubZip.file('META-INF/container.xml').async('text');
  const opfPath=container.match(/full-path="([^"]+)"/)[1];
  const opfBase=opfPath.replace(/[^/]+$/,'');
  const opfText=await E.epubZip.file(opfPath).async('text');
  const manifestMap={};
  for(const m of opfText.matchAll(/<item[^>]+id="([^"]+)"[^>]+href="([^"]+)"/g)) manifestMap[m[1]]=m[2];
  const spineIds=[...opfText.matchAll(/<itemref[^>]+idref="([^"]+)"/g)].map(m=>m[1]);
  E.spineOrder=spineIds.map(id=>opfBase+manifestMap[id]).filter(Boolean);
  const titleMap={};
  const ncxFile=findMainNcx(E.epubZip.files,opfText,opfBase);
  E.perChapterNcx=detectPerChapterNcx(E.epubZip.files,opfText,opfBase);
  if(ncxFile){
    const ncxText=await E.epubZip.file(ncxFile).async('text');
    for(const m of ncxText.matchAll(/<navPoint[^>]*>[\s\S]*?<text>([^<]+)<\/text>[\s\S]*?<content src="([^"#]+)/g)){
      const href=(opfBase+m[2]).replace(/\/\//g,'/');
      titleMap[href]=m[1].trim();
    }
  }
  // titleMap의 제목이 'Chapter N' 형식이면 실제 xhtml <h1>에서 재취득
  const chapterNTitle=/^Chapter\s+\d+$/i;
  E.chapters=await Promise.all(
    E.spineOrder
      .filter(href=>!href.includes('cover')&&!href.includes('nav'))
      .map(async(href,idx)=>{
        let title=titleMap[href]||'';
        if(!title||chapterNTitle.test(title)){
          try{
            const raw=await E.epubZip.file(href).async('text');
            const h1=raw.match(/<h[12][^>]*>([^<]+)<\/h[12]>/);
            if(h1) title=h1[1].trim();
          }catch(e){}
        }
        if(!title) title=href.split('/').pop().replace('.xhtml','');
        return {idx,href,title};
      })
  );
  document.getElementById('epubInfo').textContent='✅ '+file.name+' ('+E.chapters.length+'개 챕터)';
  // 이미지 추출 버튼 표시
  const extractBar=document.getElementById('extractImgBar');
  if(extractBar) extractBar.style.display='block';
  document.getElementById('extractImgInfo').textContent=
    `EPUB 내 이미지를 챕터명으로 추출해요 (${E.chapters.length}개 챕터 로드됨)`;
  // 기본값: 마지막 챕터 뒤
  E.selectedChIdx=E.chapters.length-1;
  document.querySelector('input[name="insPos"][value="after"]').checked=true;
  renderChList();
  document.getElementById('editSec').style.display='block';
  document.getElementById('insertSec').style.display='block';
  // 직접 편집 섹션 표시 + 목차 초기화
  document.getElementById('epubDirectEditSec').style.display='block';
  renderDirectEditToc();
  // EPUB 전체 텍스트 추출 (목차 재생성용)
  extractEpubRawText();
  // 메타데이터 초기화 (기존 값 가져오기)
  try{
    const opfXml=await E.epubZip.file(
      Object.keys(E.epubZip.files).find(f=>f.endsWith('.opf'))
    ).async('text');
    const doc=new DOMParser().parseFromString(opfXml,'text/xml');
    const existTitle=doc.querySelector('title,dc\\:title')?.textContent||'';
    const existAuthor=doc.querySelector('creator,dc\\:creator')?.textContent||'';
    document.getElementById('directEditTitle').placeholder=existTitle||'변경할 제목 (비워두면 유지)';
    document.getElementById('directEditAuthor').placeholder=existAuthor||'변경할 작가명 (비워두면 유지)';
  }catch(e){}
  // 삽입 위치 표시 업데이트
  if(E.chapters.length>0){
    const lastCh=E.chapters[E.chapters.length-1];
    document.getElementById('insertPos').innerHTML=
      '📍 <b>'+escHtml(lastCh.title)+'</b> <span style="color:var(--accent)">뒤</span>에 삽입 <span style="font-size:10px;color:var(--text2)">(기본값 - 클릭해서 변경)</span>';
  }
}

// ══════════════════════════════════════════
// 🖼  Module: ImageExtract (EPUB 이미지 추출)
// ══════════════════════════════════════════
async function extractEpubImages(){
  if(!E.epubZip||!E.chapters.length){
    Toast.warn('EPUB 파일을 먼저 불러주세요.');return;
  }

  const btn=document.getElementById('extractImgBtn');
  const progress=document.getElementById('extractImgProgress');
  const progBar=document.getElementById('extractProgBar');
  const progMsg=document.getElementById('extractProgMsg');
  const infoEl=document.getElementById('extractImgInfo');

  btn.disabled=true;
  btn.textContent='추출 중...';
  progress.style.display='block';
  progBar.style.width='0%';

  try{
    // ── 1. OPF에서 이미지 파일 목록 수집 ──
    const container=await E.epubZip.file('META-INF/container.xml').async('text');
    const opfPath=container.match(/full-path="([^"]+)"/)[1];
    const opfBase=opfPath.replace(/[^/]+$/,'');
    const opfText=await E.epubZip.file(opfPath).async('text');

    // manifest에서 이미지 항목만 추출
    const imgManifest={}; // id → href
    for(const m of opfText.matchAll(/<item[^>]+id="([^"]+)"[^>]+href="([^"]+)"[^>]+media-type="(image\/[^"]+)"/g)){
      imgManifest[m[1]]={href:opfBase+m[2], mt:m[3]};
    }
    // href를 절대경로 키로 역매핑
    const imgByHref={};
    for(const[id,info] of Object.entries(imgManifest)){
      imgByHref[info.href.replace(/\/\//g,'/')]={id,mt:info.mt};
    }

    // ── 2. 각 챕터 xhtml에서 img src 추출 → 챕터 매핑 ──
    // chapterImages: [{chTitle, imgHref}]
    const chapterImages=[]; // {chTitle, imgHref, ext}

    progMsg.textContent='챕터 분석 중...';
    for(let ci=0;ci<E.chapters.length;ci++){
      progBar.style.width=Math.round(ci/E.chapters.length*50)+'%';
      const ch=E.chapters[ci];
      let xhtml='';
      try{ xhtml=await E.epubZip.file(ch.href).async('text'); }catch(e){ continue; }

      // img src 추출 (src="..." or src='...')
      const imgRefs=[...xhtml.matchAll(/(?:src|xlink:href)=["']([^"']+\.(jpe?g|png|gif|webp|svg|avif))["']/gi)];
      for(const m of imgRefs){
        // 상대경로 → 절대경로
        const srcRel=m[1];
        let absHref;
        if(srcRel.startsWith('http')){
          absHref=srcRel;
        } else {
          const chDir=ch.href.replace(/[^/]+$/,'');
          absHref=(chDir+srcRel).replace(/[^/]+\/\.\.\//g,'').replace(/\/\//g,'/');
        }
        // 이 href가 실제 EPUB 내부 이미지인지 확인
        if(E.epubZip.file(absHref)||imgByHref[absHref]){
          const ext=srcRel.split('.').pop().toLowerCase();
          chapterImages.push({chTitle:ch.title, imgHref:absHref, ext});
        }
      }
    }

    if(!chapterImages.length){
      infoEl.textContent='⚠️ 이미지를 찾지 못했어요 (표지·내부 삽화 없음)';
      progress.style.display='none';
      btn.disabled=false;
      btn.textContent='📦 이미지 추출';
      return;
    }

    progMsg.textContent=`${chapterImages.length}개 이미지 압축 중...`;
    progBar.style.width='55%';

    // ── 3. 챕터별 이미지 번호 카운터 ──
    const chCounter={};
    const fileEntries=[]; // {filename, href}

    for(const{chTitle, imgHref, ext} of chapterImages){
      // 파일명에 사용할 수 없는 문자 제거
      const safeTitle=chTitle
        .replace(/[\\/:*?"<>|]/g,'_')
        .replace(/\s+/g,' ')
        .trim()
        .slice(0,60); // 최대 60자

      if(!(safeTitle in chCounter)) chCounter[safeTitle]=0;
      chCounter[safeTitle]++;

      // 첫 번째 이미지는 그냥 제목, 2번째부터 _N 붙임
      const cnt=chCounter[safeTitle];
      const filename=cnt===1
        ? `${safeTitle}.${ext}`
        : `${safeTitle}_${cnt}.${ext}`;

      fileEntries.push({filename, href:imgHref});
    }

    // ── 4. 중복 파일명 처리 ──
    // (같은 제목의 챕터가 여러 개면 번호 카운터가 이미 처리함)
    // 단, 아예 동일한 imgHref가 중복 등록된 경우 제거
    const seenHrefs=new Set();
    const uniqueEntries=fileEntries.filter(e=>{
      if(seenHrefs.has(e.href)) return false;
      seenHrefs.add(e.href);
      return true;
    });

    // ── 5. JSZip으로 압축 ──
    const outZip=new JSZip();
    let done=0;
    for(const{filename, href} of uniqueEntries){
      progBar.style.width=(55+Math.round(done/uniqueEntries.length*40))+'%';
      progMsg.textContent=`이미지 추출 중 (${done+1}/${uniqueEntries.length}): ${filename}`;
      try{
        const blob=await E.epubZip.file(href).async('arraybuffer');
        outZip.file(filename, blob);
      }catch(e){
      }
      done++;
    }

    progBar.style.width='97%';
    progMsg.textContent='ZIP 생성 중...';

    const zipBlob=await outZip.generateAsync({
      type:'blob',
      compression:'STORE' // 이미지는 이미 압축됨
    });

    progBar.style.width='100%';

    // ── 6. 다운로드 ──
    const epubName=(E.epubFile?.name||'epub').replace(/\.epub$/i,'');
    const a=document.createElement('a');
    a.href=URL.createObjectURL(zipBlob);
    a.download=epubName+'_images.zip';
    a.click();
    setTimeout(()=>URL.revokeObjectURL(a.href),3000);

    const totalImgs=uniqueEntries.length;
    infoEl.textContent=`✅ ${totalImgs}개 이미지 추출 완료 (${(zipBlob.size/1024).toFixed(0)}KB)`;
    progMsg.textContent=`완료! ${totalImgs}개 이미지가 ZIP으로 다운로드됩니다.`;

  }catch(e){
    progMsg.textContent='❌ 오류: '+e.message;
    infoEl.textContent='⚠️ 이미지 추출 중 오류 발생';
  }finally{
    btn.disabled=false;
    btn.textContent='📦 이미지 추출';
    progBar.style.width='100%';
  }
}

function renderChList(){
  const c=document.getElementById('chList');c.innerHTML='';
  E.chapters.forEach((ch,i)=>{
    const d=document.createElement('div');
    const isSel=E.selectedChIdx===i;
    const isLast=i===E.chapters.length-1;
    d.className='ch-item'+(isSel?' sel':'');
    d.innerHTML='<span class="ch-idx">'+(i+1)+'</span>'+
      '<span class="ch-title">'+escHtml(ch.title)+'</span>'+
      (isLast?'<span class="ch-badge" style="background:var(--green-bg);color:var(--green)">마지막</span>':
               '<span class="ch-badge badge-existing">기존</span>');
    d.onclick=()=>selectCh(i);
    c.appendChild(d);
  });
  // 선택된 항목으로 스크롤
  if(E.selectedChIdx!==null){
    const sel=c.children[E.selectedChIdx];
    if(sel) setTimeout(()=>sel.scrollIntoView({block:'nearest'}),50);
  }
}

function selectCh(i){
  E.selectedChIdx=i;
  renderChList();
  const pos=document.querySelector('input[name="insPos"]:checked').value;
  const ch=E.chapters[i];
  document.getElementById('insertPos').innerHTML=
    '📍 <b>'+escHtml(ch.title)+'</b> '+
    (pos==='before'?'<span style="color:var(--accent)">앞</span>에':'<span style="color:var(--accent)">뒤</span>에')+' 삽입';
}

async function handleInsTxt(files){
  const txts=Array.from(files).filter(f=>f.name.endsWith('.txt'));
  if(!txts.length)return;
  E.insTxtFiles=txts;
  const info=document.getElementById('insTxtInfo');
  info.style.display='block';info.textContent='📖 분석 중...';
  document.getElementById('insTxtDrop')?.classList.add('ok');
  const pat=document.getElementById('insPattern')?.value.trim();
  const sorted=[...txts].sort((a,b)=>sortKey(a.name)<sortKey(b.name)?-1:1);
  const raws=await Promise.all(sorted.map(fileToText));
  const raw=raws.join('\n\n');
  const chapters=splitChapters(raw,pat);
  // 텍스트 파일에서 뽑아온 순서(splitChapters 인덱스)를 정렬 기준으로 사용
  // 번호 기반 재정렬 제거: "1화"와 "외전 1화"가 동일 chNum=1로 충돌하는 문제 해결
  const mapped=chapters.map((ch,i)=>({
    idx:i,
    title:ch[0],
    body:ch[1],
    enabled:true,
    chNum:_extractTocNum(ch[0])  // 중복 감지·연결점 표시용으로만 유지
  }));
  E.insTxtChapters=mapped;
  info.textContent='✅ '+txts.length+'개 파일 · '+chapters.length+'개 챕터 감지';
  renderInsTocList();
  document.getElementById('insTocSec').style.display='block';
  document.getElementById('editIllSec').style.display='block';
}

async function reloadInsToc(){
  if(!E.insTxtFiles.length){Toast.warn('TXT 파일을 먼저 선택해주세요.');return;}
  await handleInsTxt(E.insTxtFiles);
}

function renderInsTocList(){
  const c=document.getElementById('insTocList');c.innerHTML='';
  const items=E.insTxtChapters||[];
  if(!items.length){
    c.innerHTML='<div class="toc-empty">TXT 파일을 로드해주세요.</div>';
    updateInsTocCount();
    return;
  }

  const epubLastNum=_getEpubLastChNum();
  // ① EPUB에 이미 있는 챕터 키 집합 (ns:num 복합키 — 본편/외전 구분)
  const epubKeys=new Set((E.chapters||[]).map(ch=>_tocKey(ch.title)));

  let dupCount=0;
  items.forEach((ch,i)=>{
    const d=document.createElement('div');
    d.className='ch-item'+(ch.enabled?'':' off');
    d.style.transition='opacity .15s';

    const chk=document.createElement('input');
    chk.type='checkbox'; chk.className='toc-chk'; chk.checked=ch.enabled;
    chk.addEventListener('change',e=>{
      e.stopPropagation();
      toggleInsTocItem(i,chk.checked);
      d.classList.toggle('off',!chk.checked);
    });

    const num=document.createElement('span');
    num.className='ch-idx'; num.textContent=(i+1);

    const title=document.createElement('span');
    title.className='ch-title'; title.textContent=ch.title;

    // ns:num 복합키로 중복 감지 — "1화"(main:1)와 "외전 1화"(extra:1)는 다른 키
    const parsed=_parseTocTitle(ch.title);
    const chKey=_tocKey(ch.title);
    const chNum=parsed.num;
    const isDup=chNum>0&&epubKeys.has(chKey);
    // 연결점: 본편(main) 기준으로만 판정
    const isNext=parsed.ns==='main'&&epubLastNum>0&&chNum===epubLastNum+1;

    if(isDup){ dupCount++; }

    if(isDup){
      const dupBadge=document.createElement('span');
      dupBadge.style.cssText='font-size:9px;background:var(--yellow-bg);color:var(--yellow);border:1px solid var(--accent2);border-radius:3px;padding:1px 5px;flex-shrink:0';
      dupBadge.textContent='중복';
      dupBadge.title='EPUB에 이미 있는 챕터예요 ('+chKey+')';
      d.appendChild(chk); d.appendChild(num); d.appendChild(title); d.appendChild(dupBadge);
    } else if(isNext){
      const marker=document.createElement('span');
      marker.style.cssText='font-size:9px;background:var(--blue);color:#fff;border-radius:3px;padding:1px 5px;flex-shrink:0';
      marker.textContent='← 연결점';
      marker.title='EPUB 마지막('+epubLastNum+'화) 바로 다음 챕터';
      const newBadge=document.createElement('span');
      newBadge.className='ch-badge badge-new'; newBadge.textContent='신규';
      d.appendChild(chk); d.appendChild(num); d.appendChild(title);
      d.appendChild(marker); d.appendChild(newBadge);
    } else {
      const newBadge=document.createElement('span');
      newBadge.className='ch-badge badge-new'; newBadge.textContent='신규';
      d.appendChild(chk); d.appendChild(num); d.appendChild(title); d.appendChild(newBadge);
    }
    c.appendChild(d);
  });

  // 중복 카운트 표시
  const dupCountEl=document.getElementById('insTocDupCount');
  if(dupCountEl){
    if(dupCount>0){
      dupCountEl.textContent='⚠ 중복 '+dupCount+'개';
      dupCountEl.style.display='';
    }else{
      dupCountEl.style.display='none';
    }
  }

  updateInsTocCount();
  syncInsTocRefSelect();
  _showEpubConnectInfo();
  // ② 연속성 검증
  _checkTocContinuity();
}

// ② 연속성 검증 — 누락 화수 감지
function _checkTocContinuity(){
  const warnEl=document.getElementById('insTocGapWarn');
  if(!warnEl) return;
  const epubLastNum=_getEpubLastChNum();
  const items=E.insTxtChapters||[];
  if(epubLastNum<=0||!items.length){ warnEl.style.display='none'; return; }

  // 활성화된 TXT 챕터 중 본편(main)만 추출 — 외전/번외는 연속성 계산 제외
  const enabledNums=items
    .filter(ch=>ch.enabled)
    .filter(ch=>_parseTocTitle(ch.title).ns==='main') // 본편만
    .map(ch=>_extractTocNum(ch.title))
    .filter(n=>n>0);
  if(!enabledNums.length){ warnEl.style.display='none'; return; }

  const minTxtNum=Math.min(...enabledNums);
  const gaps=[];

  // EPUB 마지막과 TXT 최솟값 사이 공백
  if(minTxtNum>epubLastNum+1){
    for(let n=epubLastNum+1;n<minTxtNum;n++) gaps.push(n);
  }

  if(gaps.length>0){
    const gapStr=gaps.length<=5?gaps.join(', ')+'화':gaps[0]+'화~'+gaps[gaps.length-1]+'화 ('+gaps.length+'개)';
    // ★ XSS 방지: gapStr은 숫자 배열 기반이지만 방어적 escHtml 적용
    warnEl.innerHTML='⚠️ <b>연속성 경고</b>: EPUB 마지막('+escHtml(String(epubLastNum))+'화)과 TXT 시작('+escHtml(String(minTxtNum))+'화) 사이 <b>'+escHtml(gapStr)+'</b>가 누락되어 있어요.';
    warnEl.style.display='block';
  }else{
    warnEl.style.display='none';
  }
}

// EPUB 마지막 챕터 번호 추출
function _getEpubLastChNum(){
  if(!E.chapters||!E.chapters.length) return -1;
  const last=E.chapters[E.chapters.length-1];
  return _extractTocNum(last.title);
}
// 챕터 제목에서 번호 추출 (중복 감지·연결점 표시용)
// 외전/번외/프롤로그는 본편과 충돌하지 않도록 별도 네임스페이스 부여
// 반환 형식: {num, ns}
//   num: 정수 번호 (없으면 -1)
//   ns:  'main'(본편) | 'extra'(외전/번외) | 'special'(프롤로그/에필로그 등)
function _parseTocTitle(t){
  const s=(t||'').trim();
  // 외전/번외/사이드/특별편 키워드 — 본편과 별도 ns
  if(/(?:^|\s)(?:외전|번외|사이드|side|특별편|bonus|extra)/i.test(s)){
    const m=s.match(/(\d+)/);
    return {num: m?parseInt(m[1]):-1, ns:'extra'};
  }
  // 후일담/에필로그/종장
  if(/(?:^|\s)(?:후일담|에필로그|epilogue|종장)/i.test(s)){
    const m=s.match(/(\d+)/);
    return {num: m?parseInt(m[1]):-1, ns:'special'};
  }
  // 프롤로그/서장 — 본편 앞
  if(/^(?:프롤로그|서장|prologue)/i.test(s))
    return {num:0, ns:'special'};
  // 일반 본편
  const m=s.match(/(\d+)/);
  return {num: m?parseInt(m[1]):-1, ns:'main'};
}

// 하위 호환용 — 번호만 반환
function _extractTocNum(t){
  return _parseTocTitle(t).num;
}

// 중복 감지에 사용: ns + num 복합 키 반환
function _tocKey(t){
  const {num,ns}=_parseTocTitle(t);
  return ns+':'+num;
}

// EPUB 연결 정보 표시
function _showEpubConnectInfo(){
  const infoEl=document.getElementById('insTocEpubInfo');
  const textEl=document.getElementById('insTocEpubInfoText');
  if(!infoEl||!textEl) return;
  if(!E.chapters||!E.chapters.length){infoEl.style.display='none';return;}
  const lastCh=E.chapters[E.chapters.length-1];
  const lastNum=_getEpubLastChNum();
  // ★ XSS 방어: lastNum은 parseInt 결과(숫자)이나 방어적 escHtml 적용
  const numText=lastNum>0?` (${escHtml(String(lastNum))}화)`:'';
  textEl.innerHTML=
    `현재 EPUB 마지막 챕터: <b>${escHtml(lastCh.title)}</b>${numText} — `+
    `<b>${E.chapters.length}번째</b> 위치<br>`+
    `<span style="color:var(--accent);font-size:10px">➡ 아래에서 이 이후 챕터들을 선택해 삽입하세요</span>`;
  infoEl.style.display='block';
}

// TXT 챕터 목록을 기준 챕터 select에 동기화 (TXT 기준으로 변경)
function syncInsTocRefSelect(){
  const sel=document.getElementById('insTocRefChapter');
  if(!sel) return;
  const items=E.insTxtChapters||[];
  if(!items.length){ sel.innerHTML='<option value="">— TXT 기준 챕터 선택 —</option>'; return; }

  const prev=sel.value;
  sel.innerHTML='<option value="">— TXT 기준 챕터 선택 —</option>';

  // EPUB 마지막 챕터 번호를 기준으로 기본 선택값 계산
  const epubLastNum=_getEpubLastChNum();
  let defaultIdx=-1;

  items.forEach((ch,i)=>{
    const opt=document.createElement('option');
    opt.value=i;
    const chNum=_extractTocNum(ch.title);
    // EPUB 마지막 화 다음 챕터를 기본값으로
    if(epubLastNum>0&&chNum===epubLastNum+1&&defaultIdx<0) defaultIdx=i;
    opt.textContent=(i+1)+'. '+ch.title;
    sel.appendChild(opt);
  });

  // 기본값: EPUB 이후 첫 챕터, 없으면 맨 처음
  if(prev!==''){ sel.value=prev; }
  else if(defaultIdx>=0){ sel.value=defaultIdx; }
  else if(items.length){ sel.value=0; }
}

// TXT 챕터 기준 이전/이후 + 빠른 선택
function applyInsTocRange(mode){
  const sel=document.getElementById('insTocRefChapter');
  const items=E.insTxtChapters||[];
  if(!items.length) return;

  const infoEl=document.getElementById('insTocRangeInfo');
  const epubLastNum=_getEpubLastChNum();
  // 챕터 키 집합 (ns:num 복합키 — 본편/외전 구분)
  const epubKeys=new Set((E.chapters||[]).map(ch=>_tocKey(ch.title)));

  if(mode==='reset'){
    items.forEach(ch=>ch.enabled=true);
    infoEl.textContent=''; renderInsTocList(); return;
  }

  // EPUB 이후만: 본편 기준 (외전은 번호 무관하게 항상 포함)
  if(mode==='epubAfter'){
    if(epubLastNum<=0){ Toast.warn('EPUB 파일을 먼저 불러와주세요.'); return; }
    let cnt=0;
    items.forEach(ch=>{
      const {num,ns}=_parseTocTitle(ch.title);
      // 본편은 epubLastNum 초과만, 외전/특별편은 무조건 포함, 번호 없으면 포함
      ch.enabled=(ns!=='main'||num>epubLastNum||num<=0);
      if(ch.enabled) cnt++;
    });
    infoEl.textContent='EPUB 이후('+epubLastNum+'화 초과) '+cnt+'개 선택';
    renderInsTocList(); return;
  }

  // EPUB 이전만: 본편 기준
  if(mode==='epubBefore'){
    if(epubLastNum<=0){ Toast.warn('EPUB 파일을 먼저 불러와주세요.'); return; }
    let cnt=0;
    items.forEach(ch=>{
      const {num,ns}=_parseTocTitle(ch.title);
      ch.enabled=(ns==='main'&&num>0&&num<=epubLastNum);
      if(ch.enabled) cnt++;
    });
    infoEl.textContent='EPUB 이전('+epubLastNum+'화 이하) '+cnt+'개 선택';
    renderInsTocList(); return;
  }

  // 중복 제외: ns:num 복합키 기준 — "1화"와 "외전 1화"를 별개로 판정
  if(mode==='dedupe'){
    let deduped=0;
    items.forEach(ch=>{
      const key=_tocKey(ch.title);
      const {num}=_parseTocTitle(ch.title);
      if(num>0&&epubKeys.has(key)){ ch.enabled=false; deduped++; }
    });
    infoEl.textContent=deduped>0?'중복 '+deduped+'개 해제됨':'중복 챕터 없음';
    renderInsTocList(); return;
  }

  // 기준 챕터 선택 필요
  const refIdx=sel&&sel.value!==''?parseInt(sel.value):-1;
  if(refIdx<0){ Toast.warn('기준 챕터를 먼저 선택해주세요.'); return; }

  const refTitle=items[refIdx]?.title||'';
  let enabledCount=0;

  if(mode==='before'){
    items.forEach((ch,i)=>{ ch.enabled=(i<=refIdx); if(ch.enabled) enabledCount++; });
    infoEl.textContent='"'+refTitle+'" 포함 이전 '+enabledCount+'개 선택 (1~'+(refIdx+1)+'번째)';
  } else if(mode==='after'){
    items.forEach((ch,i)=>{ ch.enabled=(i>=refIdx); if(ch.enabled) enabledCount++; });
    infoEl.textContent='"'+refTitle+'" 포함 이후 '+enabledCount+'개 선택 ('+(refIdx+1)+'~'+items.length+'번째)';
  }

  renderInsTocList();
}

function toggleInsTocItem(i,v){if(E.insTxtChapters)E.insTxtChapters[i].enabled=v;updateInsTocCount();}
function toggleAllInsToc(v){if(E.insTxtChapters)E.insTxtChapters.forEach(ch=>ch.enabled=v);renderInsTocList();}
function updateInsTocCount(){
  const items=E.insTxtChapters||[];
  const on=items.filter(ch=>ch.enabled).length;
  document.getElementById('insTocCount').textContent=on+'/'+items.length+'개 선택됨';
}

async function startEditEpub(){
  if(!E.epubZip){Toast.warn('EPUB 파일을 먼저 불러와주세요.');return;}
  if(!E.insTxtFiles.length){Toast.warn('삽입할 TXT 파일을 선택해주세요.');return;}
  // selectedChIdx는 epub 로드 시 마지막 챕터로 기본 설정됨
  document.getElementById('editProgWrap')?.classList.add('show');
  document.getElementById('editResultBox')?.classList.remove('show');
  document.getElementById('editErrBox')?.classList.remove('show');
  function ep(pct,msg){document.getElementById('editProgBar').style.width=pct+'%';document.getElementById('editProgMsg').textContent=msg;}
  try{
    ep(5,'TXT 읽는 중...');
    let newChapters;
    if(E.insTxtChapters&&E.insTxtChapters.length>0){
      newChapters=E.insTxtChapters.filter(ch=>ch.enabled).map(ch=>[ch.title,ch.body]);
    }else{
      const sorted=[...E.insTxtFiles].sort((a,b)=>sortKey(a.name)<sortKey(b.name)?-1:1);
      const raws=await Promise.all(sorted.map(fileToText));
      newChapters=splitChapters(raws.join('\n\n'),document.getElementById('insPattern')?.value.trim());
    }
    newChapters=newChapters.filter(([h])=>h!=='서문'||newChapters.length===1);
    if(!newChapters.length)throw new Error('삽입할 챕터가 없습니다.');
    ep(15,'EPUB 복제 중...');
    const newZip=new JSZip();
    for(const[name,f]of Object.entries(E.epubZip.files)){
      if(f.dir)continue;
      newZip.file(name,await f.async('arraybuffer'));
    }
    const containerXml=await E.epubZip.file('META-INF/container.xml').async('text');
    const opfPath=containerXml.match(/full-path="([^"]+)"/)[1];
    const opfBase=opfPath.replace(/[^/]+$/,'');
    let opfText=await E.epubZip.file(opfPath).async('text');
    const keepCss=document.getElementById('keepOrigCss')?.checked!==false;
    const cssMatch=opfText.match(/href="([^"]*style[^"]*\.css)"/i);
    const cssHref=cssMatch?cssMatch[1]:'style.css';
    // 원본 CSS 유지 OFF시 새 스타일 주입
    if(!keepCss&&cssMatch){
      const origCssPath=opfBase+cssHref;
      if(newZip.file(origCssPath)) newZip.file(origCssPath,buildCss());
    }
    ep(25,'챕터 파일 생성 중...');
    const existingNums=Object.keys(E.epubZip.files).filter(f=>f.includes('chapter_'))
      .map(f=>{const m=f.match(/chapter_(\d+)/);return m?parseInt(m[1]):-1;});
    let nextNum=(existingNums.length?Math.max(...existingNums):0)+1;
    const newManifestItems=[],newSpineIds=[],newNcxItems=[];
    const useItalic=true;
    // 챕터별 NCX 구조 감지 (bookN_toc.ncx 패턴)
    const perChNcx=E.perChapterNcx;
    // 공통 renderBodyHtml 사용 (시스템창 처리·빈줄 제한 포함)
    // ★ bToHtml 제거 — renderBodyHtml 직접 사용으로 표준화
    function makeChNcx(id,title,contentSrc){
      return '<?xml version="1.0" encoding="UTF-8"?>\n'+
        '<ncx xmlns="http://www.daisy.org/z3986/2005/ncx/" version="2005-1">\n'+
        '  <head><meta name="dtb:uid" content="urn:uuid:'+id+'"/><meta name="dtb:depth" content="1"/>'+
        '<meta name="dtb:totalPageCount" content="0"/><meta name="dtb:maxPageNumber" content="0"/></head>\n'+
        '  <docTitle><text>'+escHtml(title)+'</text></docTitle>\n'+
        '  <navMap>\n    <navPoint id="navPoint-1" playOrder="1">\n'+
        '      <navLabel><text>'+escHtml(title)+'</text></navLabel>\n'+
        '      <content src="'+contentSrc+'"/>\n    </navPoint>\n  </navMap>\n</ncx>';
    }
    for(let i=0;i<newChapters.length;i++){
      if(i%20===0) ep(25+Math.floor(i/newChapters.length*40),'챕터 생성 중 ('+i+'/'+newChapters.length+')...');
      const[heading,body]=newChapters[i];
      const fname='chapter_'+String(nextNum).padStart(4,'0')+'.xhtml';
      const fullPath=opfBase+'Text/'+fname;
      const chid='ins_ch_'+String(nextNum).padStart(4,'0');
      // keepOrigCss=true이면 원본 CSS의 커스텀 폰트가 적용됨
// 커스텀 폰트(NF_Library 등)가 !important로 지정된 경우 새 챕터 한글이 깨짐
// → 새 챕터 body에 시스템 폰트를 !important 인라인으로 강제 지정
const inlineFont=keepCss
  ? ' style="font-family: \'Noto Serif KR\',\'Malgun Gothic\',\'Apple SD Gothic Neo\',\'나눔고딕\',sans-serif !important"'
  : '';
newZip.file(fullPath,'<?xml version="1.0" encoding="utf-8"?><!DOCTYPE html>\n<html xmlns="http://www.w3.org/1999/xhtml"><head>\n<title>'+escHtml(heading)+'</title>\n<link rel="stylesheet" type="text/css" href="../'+cssHref+'"/>\n'+
  '<style>/* 커스텀 폰트 폰트 오버라이드 */\np,h1,h2,h3,h4,h5,span,a{font-family:\'Noto Serif KR\',\'Malgun Gothic\',\'Apple SD Gothic Neo\',sans-serif!important}</style>\n'+
  '</head><body>\n<h1>'+escHtml(heading)+'</h1>\n'+renderBodyHtml(body,{useItalic,maxBlank:2})+'</body></html>');
      newManifestItems.push({id:chid,href:'Text/'+fname,mt:'application/xhtml+xml'});
      // 챕터별 NCX 구조이면 개별 ncx 파일도 생성
      if(perChNcx){
        const ncxFname='chapter_'+String(nextNum).padStart(4,'0')+'_toc.ncx';
        const ncxPath=opfBase+'Text/'+ncxFname;
        newZip.file(ncxPath, makeChNcx(chid, heading, fname));
        newManifestItems.push({id:chid+'_ncx',href:'Text/'+ncxFname,mt:'application/x-dtbncx+xml'});
      }
      newSpineIds.push(chid);
      newNcxItems.push({id:chid,title:heading,src:'Text/'+fname});
      nextNum++;
    }
    ep(70,'OPF 업데이트 중...');
    const manifestInsert=newManifestItems.map(it=>'<item id="'+it.id+'" href="'+it.href+'" media-type="'+it.mt+'"/>').join('\n');
    opfText=opfText.replace('</manifest>',manifestInsert+'\n</manifest>');
    const selHref=E.chapters[E.selectedChIdx].href;
    const selHrefRel=selHref.replace(opfBase,'');
    const insPos=document.querySelector('input[name="insPos"]:checked').value;
    // manifest에서 선택 챕터의 id 찾기
    const manifestIdMatch=opfText.match(new RegExp('<item[^>]+id="([^"]+)"[^>]+href="'+selHrefRel.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')+'"'));
    const selId=manifestIdMatch?manifestIdMatch[1]:'';
    const newSpineRefs=newSpineIds.map(id=>'<itemref idref="'+id+'"/>').join('\n');
    if(selId&&insPos==='before'){
      opfText=opfText.replace('<itemref idref="'+selId+'"/>',newSpineRefs+'\n<itemref idref="'+selId+'"/>');
    }else if(selId&&insPos==='after'){
      opfText=opfText.replace('<itemref idref="'+selId+'"/>','<itemref idref="'+selId+'"/>\n'+newSpineRefs);
    }else{
      opfText=opfText.replace('</spine>',newSpineRefs+'\n</spine>');
    }
    newZip.file(opfPath,opfText);
    // NCX + nav.xhtml 목차 업데이트
    ep(82,'목차 업데이트 중...');
    const selFilename=selHrefRel.split('/').pop();
    const escSelFn=selFilename.replace(/[.*+?^${}()|[\]\\]/g,'\\$&');

    // NCX 업데이트
    const ncxFile=findMainNcx(E.epubZip.files,opfText,opfBase);
    if(ncxFile){
      let ncxText=await E.epubZip.file(ncxFile).async('text');
      const maxOrder=Math.max(...[...ncxText.matchAll(/playOrder="(\d+)"/g)].map(m=>parseInt(m[1])),0);
      const newNavPoints=newNcxItems.map((it,i)=>
        '<navPoint id="'+it.id+'" playOrder="'+(maxOrder+i+1)+'">'+
        '<navLabel><text>'+escHtml(it.title)+'</text></navLabel>'+
        '<content src="'+it.src+'"/></navPoint>'
      ).join('\n');
      // ✅ 핵심 수정: (?:(?!</navPoint>)[\s\S])*? 로 navPoint 경계를 절대 넘지 않음
      const ncxSafeRx=new RegExp(
        '<navPoint[^>]*>(?:(?!</navPoint>)[\\s\\S])*?<content src="[^"]*'
        +escSelFn+'[^"]*"/>(?:(?!</navPoint>)[\\s\\S])*?</navPoint>'
      );
      const ncxM=ncxText.match(ncxSafeRx);
      if(ncxM){
        if(insPos==='before') ncxText=ncxText.replace(ncxM[0],newNavPoints+'\n'+ncxM[0]);
        else ncxText=ncxText.replace(ncxM[0],ncxM[0]+'\n'+newNavPoints);
      }else{
        ncxText=ncxText.replace('</navMap>',newNavPoints+'\n</navMap>');
      }
      newZip.file(ncxFile,ncxText);
    }

    // nav.xhtml 업데이트 (EPUB3 리더 우선 사용)
    const navFile=findNavXhtml(E.epubZip.files,opfText,opfBase);
    if(navFile){
      let navText=await E.epubZip.file(navFile).async('text');
      const newNavLis=newNcxItems.map(it=>'<li><a href="'+it.src+'">'+escHtml(it.title)+'</a></li>').join('\n');
      const navM=navText.match(new RegExp('<li><a href="[^"]*'+escSelFn+'[^"]*">[^<]*</a></li>'));
      if(navM){
        if(insPos==='before') navText=navText.replace(navM[0],newNavLis+'\n'+navM[0]);
        else navText=navText.replace(navM[0],navM[0]+'\n'+newNavLis);
      }else{
        navText=navText.replace('</ol>',newNavLis+'\n</ol>');
      }
      newZip.file(navFile,navText);
    }
    // 삽화 삽입
    if(EI.files.length>0){
      ep(88,'삽화 삽입 중...');
      const illEntries=buildIllEntries(E.chapters,opfBase);
      if(illEntries.length>0) await insertIllsToEpub(newZip,opfPath,opfBase,illEntries);
    }
    ep(92,'압축 중...');
    const blob=await newZip.generateAsync({type:'blob',mimeType:'application/epub+zip',compression:'DEFLATE',compressionOptions:{level:parseInt(document.getElementById('optCompression')?.value||'6')}},
      meta=>ep(92+Math.floor(meta.percent*0.07),'압축 중 '+Math.floor(meta.percent)+'%...'));
    E.resultBlob=blob;
    E.resultName=E.epubFile.name.replace('.epub','')+'_편집.epub';
    ep(100,'완료!');
    document.getElementById('editResultMsg').textContent=E.resultName+' ('+(blob.size/1024/1024).toFixed(1)+'MB)';
    document.getElementById('editResultBox')?.classList.add('show');
  }catch(e){
    document.getElementById('editProgWrap')?.classList.remove('show');
    document.getElementById('editErrBox').textContent='❌ '+friendlyError(e);
    document.getElementById('editErrBox')?.classList.add('show');
  }
}

// ══════════════════════════════════════════
// 🖼  Module: IllustInsert (삽화 삽입·매핑)
// ══════════════════════════════════════════

// editIllDrop / insIllDrop 이벤트는 setupEventListeners에서 처리

// handleEditIll / handleInsIll → 공통 handleIllFiles 사용
function handleEditIll(files){ handleIllFiles(files,EI.files,'editIllDrop',renderEditIllTags); }
function handleInsIll(files){
  handleIllFiles(files,EI.files,'insIllDrop',renderEditIllTags);
}

// EPUB 편집 탭 삽화 태그 렌더링 (editIllTags + insIllTags 동시 갱신)
function renderEditIllTags(){
  ['editIllTags','insIllTags'].forEach(cid=>{
    const c=document.getElementById(cid);if(!c)return;
    c.innerHTML='';
    EI.files.forEach((f,i)=>{
      const t=document.createElement('div');t.className='tag';
      // ★ XSS 방어: onclick 인라인 핸들러 제거 → addEventListener 교체
      const nameSpan=document.createElement('span');
      nameSpan.textContent=f.name;
      const xBtn=document.createElement('span');
      xBtn.className='x';xBtn.textContent='✕';
      xBtn.addEventListener('click',()=>removeEditIll(i));
      t.appendChild(nameSpan);
      t.appendChild(document.createTextNode(' '));
      t.appendChild(xBtn);
      c.appendChild(t);
    });
  });
}
function removeEditIll(i){EI.files.splice(i,1);renderEditIllTags();}

function addInsManualIll(){ addManualIllRow('insManualIlls'); }

function addEditIllRow(){
  const id=EI.manualRows++;
  const c=document.getElementById('editIllManualList');
  const r=document.createElement('div');r.className='mill-row';r.id='eir_'+id;
  r.innerHTML=
    '<input placeholder="파일명 (예: 16.jpg)" id="eif_'+id+'" style="flex:2;min-width:100px">'+
    '<button class="btn btn-ghost btn-sm" onclick="browseEditIll('+id+')">찾기</button>'+
    '<select id="eim_'+id+'" onchange="toggleEIM('+id+')"><option value="chapter">화 번호</option><option value="keyword">키워드</option><option value="title">챕터 제목 포함</option></select>'+
    '<input type="number" placeholder="화 번호" id="eic_'+id+'" style="width:78px" min="1">'+
    '<input placeholder="키워드/제목" id="eik_'+id+'" style="flex:1;min-width:80px;display:none">'+
    '<select id="eip_'+id+'"><option value="before">챕터 앞</option><option value="after">챕터 뒤</option></select>'+
    '<button class="btn btn-sm" style="background:var(--accent-bg);color:var(--accent)" data-action="removeEditIllRow" data-row-id="eir_'+id+'">✕</button>';
  c.appendChild(r);
}
function toggleEIM(id){
  const m=document.getElementById('eim_'+id).value;
  document.getElementById('eic_'+id).style.display=m==='chapter'?'':'none';
  document.getElementById('eik_'+id).style.display=(m==='keyword'||m==='title')?'':'none';
}
function browseEditIll(id){
  const inp=document.createElement('input');inp.type='file';inp.accept='.jpg,.jpeg,.png,.gif,.webp,.bmp,.tiff,.tif,.avif';
  inp.onchange=()=>{if(inp.files[0]){EI.files.push(inp.files[0]);renderEditIllTags();document.getElementById('eif_'+id).value=inp.files[0].name;}};
  inp.click();
}

// 삽화를 epub zip에 추가하고 OPF/NCX/nav 업데이트
async function insertIllsToEpub(newZip, opfPath, opfBase, illEntries){
  if(!illEntries.length) return;

  let opfText=await newZip.file(opfPath).async('text');
  const ncxFile=findMainNcx(newZip.files,opfText,opfBase);
  const navFile=findNavXhtml(newZip.files,opfText,opfBase);
  let ncxText=ncxFile?await newZip.file(ncxFile).async('text'):'';
  let navText=navFile?await newZip.file(navFile).async('text'):'';

  // 기존 manifest에서 최대 이미지 인덱스 파악
  const existImgNums=Object.keys(newZip.files).filter(f=>/img_\d+/.test(f))
    .map(f=>{const m=f.match(/img_(\d+)/);return m?parseInt(m[1]):-1;});
  let imgIdx=(existImgNums.length?Math.max(...existImgNums):0)+1;

  // 기존 ill 페이지 인덱스
  const existIllNums=Object.keys(newZip.files).filter(f=>/ill_\d+\.xhtml/.test(f))
    .map(f=>{const m=f.match(/ill_(\d+)/);return m?parseInt(m[1]):-1;});
  let illIdx=(existIllNums.length?Math.max(...existIllNums):0)+1;

  // 기존 CSS href
  const cssMatch=opfText.match(/href="([^"]*style[^"]*\.css)"/i);
  const cssHref=cssMatch?cssMatch[1]:'style.css';

  const maxNcxOrder=ncxText?Math.max(...[...ncxText.matchAll(/playOrder="(\d+)"/g)].map(m=>parseInt(m[1])),0):0;
  let ncxOrderOffset=0;

  for(const entry of illEntries){
    const{file, targetHref, pos}=entry;
    if(!file||!targetHref) continue;

    // 이미지 저장 (convertImageFile로 통일 — 설정에 따라 JPG 변환 or 원본 유지)
    const {blob:imgBlob, ext:dext, mt}=await convertImageFile(file);
    const imgDest=opfBase+'Images/ill_img_'+String(imgIdx).padStart(4,'0')+'.'+dext;
    const imgRelHref='Images/ill_img_'+String(imgIdx).padStart(4,'0')+'.'+dext;
    newZip.file(imgDest,await fileToAB(imgBlob));
    const imgId='edit_img_'+String(imgIdx).padStart(4,'0');
    opfText=opfText.replace('</manifest>','<item id="'+imgId+'" href="'+imgRelHref+'" media-type="'+mt+'"/>\n</manifest>');
    imgIdx++;

    // ill xhtml 페이지 생성
    const illFname='ill_edit_'+String(illIdx).padStart(4,'0')+'.xhtml';
    const illFullPath=opfBase+'Text/'+illFname;
    const illRelHref='Text/'+illFname;
    const illId='ill_edit_'+String(illIdx).padStart(4,'0');
    const illTitle='삽화';
    newZip.file(illFullPath,'<?xml version="1.0" encoding="utf-8"?><!DOCTYPE html>\n'+
      '<html xmlns="http://www.w3.org/1999/xhtml"><head><title>'+illTitle+'</title>\n'+
      '<link rel="stylesheet" type="text/css" href="../'+cssHref+'"/></head>\n'+
      '<body><div class="illust-page"><img src="../'+imgRelHref+'" alt="삽화"/></div></body></html>');

    // manifest에 ill xhtml 추가
    opfText=opfText.replace('</manifest>','<item id="'+illId+'" href="'+illRelHref+'" media-type="application/xhtml+xml"/>\n</manifest>');

    // spine에 삽입 (targetHref 기준)
    const targetRel=targetHref.replace(opfBase,'');
    const manifestMatch=opfText.match(new RegExp('<item[^>]+id="([^"]+)"[^>]+href="'+targetRel.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')+'"'));
    const targetId=manifestMatch?manifestMatch[1]:'';
    const newItemRef='<itemref idref="'+illId+'"/>';
    if(targetId){
      if(pos==='before') opfText=opfText.replace('<itemref idref="'+targetId+'"/>',newItemRef+'\n<itemref idref="'+targetId+'"/>');
      else opfText=opfText.replace('<itemref idref="'+targetId+'"/>','<itemref idref="'+targetId+'"/>\n'+newItemRef);
    }else{
      opfText=opfText.replace('</spine>',newItemRef+'\n</spine>');
    }

    // NCX 업데이트
    if(ncxFile&&ncxText){
      const selFn=targetRel.split('/').pop();
      const escFn=selFn.replace(/[.*+?^${}()|[\]\\]/g,'\\$&');
      const newNavPt='<navPoint id="'+illId+'" playOrder="'+(maxNcxOrder+ncxOrderOffset+1)+'">'+
        '<navLabel><text>'+illTitle+'</text></navLabel>'+
        '<content src="'+illRelHref+'"/></navPoint>';
      ncxOrderOffset++;
      const ncxSafeRx=new RegExp('<navPoint[^>]*>(?:(?!</navPoint>)[\\s\\S])*?<content src="[^"]*'+escFn+'[^"]*"/>(?:(?!</navPoint>)[\\s\\S])*?</navPoint>');
      const ncxM=ncxText.match(ncxSafeRx);
      if(ncxM){
        if(pos==='before') ncxText=ncxText.replace(ncxM[0],newNavPt+'\n'+ncxM[0]);
        else ncxText=ncxText.replace(ncxM[0],ncxM[0]+'\n'+newNavPt);
      }else{
        ncxText=ncxText.replace('</navMap>',newNavPt+'\n</navMap>');
      }
    }

    // nav.xhtml 업데이트
    if(navFile&&navText){
      const selFn=targetRel.split('/').pop();
      const escFn=selFn.replace(/[.*+?^${}()|[\]\\]/g,'\\$&');
      const newLi='<li><a href="'+illRelHref+'">'+illTitle+'</a></li>';
      const navM=navText.match(new RegExp('<li><a href="[^"]*'+escFn+'[^"]*">[^<]*</a></li>'));
      if(navM){
        if(pos==='before') navText=navText.replace(navM[0],newLi+'\n'+navM[0]);
        else navText=navText.replace(navM[0],navM[0]+'\n'+newLi);
      }else{
        navText=navText.replace('</ol>',newLi+'\n</ol>');
      }
    }
    illIdx++;
  }

  // 업데이트된 파일들 저장
  newZip.file(opfPath,opfText);
  if(ncxFile&&ncxText) newZip.file(ncxFile,ncxText);
  if(navFile&&navText) newZip.file(navFile,navText);
}



function downloadEditEpub(){
  if(!E.resultBlob)return;
  const a=document.createElement('a');a.href=URL.createObjectURL(E.resultBlob);a.download=E.resultName;a.click();
  setTimeout(()=>URL.revokeObjectURL(a.href),1000);
}

// ══════════════════════════════════════════
// ✏️ Module: DirectEditEpub (EPUB 직접 편집)
// ══════════════════════════════════════════
let _directEditResult=null; // {blob, name}
let _directEditIllFiles=[];  // 삽화 파일 목록
let _directEditTocItems=[];  // 목차 편집 상태

// ── EPUB 텍스트 추출 (목차 재생성용) ──
let _epubRawText='';     // 전체 텍스트 (줄 배열 아님)
let _epubRawLines=[];    // 줄 배열
let _eTocItems=[];       // 감지된 목차 아이템
let _eSmartPatTimer=null;

async function extractEpubRawText(){
  if(!E.epubZip||!E.chapters.length){ _epubRawText=''; _epubRawLines=[]; return; }
  // EPUB 각 챕터 xhtml → 텍스트 추출 후 합치기
  const parts=[];
  for(const ch of E.chapters){
    try{
      const xhtml=await E.epubZip.file(ch.href)?.async('text')||'';
      const doc=new DOMParser().parseFromString(xhtml,'text/html');
      // body 텍스트만 추출 (태그 제거)
      const body=doc.body?.innerText||doc.body?.textContent||'';
      parts.push(body.trim());
    }catch(e){}
  }
  _epubRawText=parts.join('\n\n');
  _epubRawLines=_epubRawText.split('\n');
  // 원본 텍스트 탭 갱신
  const tb1=document.getElementById('eTb1');
  if(tb1&&tb1.style.display!=='none'){
    tb1.innerHTML='<pre class="toc-raw">'+
      _epubRawLines.map((l,i)=>String(i+1).padStart(4,' ')+' | '+escHtml(l)).join('\n')+'</pre>';
  }
}

// ── 목차 확인 (EPUB 버전) ──
async function previewEpubToc(){
  if(!_epubRawText){ Toast.warn('EPUB 파일을 먼저 불러와주세요.'); return; }
  const pat=document.getElementById('eTocPattern')?.value.trim();
  const tb0=document.getElementById('eTb0');
  const tb1=document.getElementById('eTb1');
  tb0.innerHTML='<div style="font-size:12px;color:var(--text2);padding:8px">🔍 감지 중...</div>';

  // 원본 텍스트 탭 내용 채우기
  tb1.innerHTML='<pre class="toc-raw">'+
    _epubRawLines.map((l,i)=>String(i+1).padStart(4,' ')+' | '+escHtml(l)).join('\n')+'</pre>';

  // 패턴 또는 자동 감지
  let found=[];
  if(pat){
    try{
      const rx=new RegExp(pat,'i');
      _epubRawLines.forEach((l,i)=>{
        if(l.trim()&&rx.test(l.trim())) found.push({line:i+1,title:l.trim(),enabled:true});
      });
    }catch(e){
      tb0.innerHTML='<div style="color:var(--accent);padding:8px;font-size:12px">⚠️ 정규식 오류: '+escHtml(e.message)+'</div>';
      return;
    }
  }else{
    // 자동 감지 — 기존 bestPat 활용
    const {rx}=bestPat(_epubRawText);
    if(rx){
      _epubRawLines.forEach((l,i)=>{
        if(l.trim()&&rx.test(l.trim())) found.push({line:i+1,title:l.trim(),enabled:true});
      });
      document.getElementById('eTocPattern').value=rx.source;
    }
  }

  _eTocItems=found;
  renderETocItems();

  // 칩 감지 결과 갱신
  refreshEDetectedChip();
}

function renderETocItems(){
  const tb0=document.getElementById('eTb0');
  if(!_eTocItems.length){
    tb0.innerHTML='<div class="toc-empty">⚠️ 챕터가 감지되지 않았어요. 정규식을 수정해보세요.</div>';
    return;
  }
  tb0.innerHTML='';
  const stat=document.createElement('div');
  stat.style.cssText='margin-bottom:6px;display:flex;gap:6px;align-items:center;flex-wrap:wrap';
  stat.innerHTML='<span style="font-size:11px;color:var(--text2)">총 <b>'+_eTocItems.length+'</b>개 감지</span>'+
    '<button class="btn btn-ghost btn-sm" data-action="eToggleAllToc" data-val="true">전체 선택</button>'+
    '<button class="btn btn-ghost btn-sm" data-action="eToggleAllToc" data-val="false">전체 해제</button>';
  tb0.appendChild(stat);

  _eTocItems.forEach((item,i)=>{
    const d=document.createElement('div');
    d.className='toc-item'+(item.enabled?'':' off');

    const chk=document.createElement('input');
    chk.type='checkbox'; chk.className='toc-chk'; chk.checked=item.enabled;
    chk.onchange=e=>{ _eTocItems[i].enabled=chk.checked; d.classList.toggle('off',!chk.checked); };

    const num=document.createElement('span');
    num.className='toc-num'; num.textContent=item.line+'줄';

    const title=document.createElement('input');
    title.className='toc-title-edit'; title.value=item.title;
    title.onchange=()=>{ _eTocItems[i].title=title.value.trim()||item.title; };

    d.appendChild(chk); d.appendChild(num); d.appendChild(title);
    tb0.appendChild(d);
  });
}

function eToggleAllToc(v){ _eTocItems.forEach(t=>t.enabled=v); renderETocItems(); }

// ── 정규식 탭 ──
function eTocTab(n){
  const panel=document.getElementById('eTocPanel');
  if(panel) panel.querySelectorAll('.ttab').forEach((t,i)=>t.classList.toggle('on',i===n));
  [0,1,2].forEach(i=>{
    const el=document.getElementById('eTb'+i);
    if(el) el.style.display=i===n?'':'none';
  });
  if(n===1&&_epubRawLines.length){
    document.getElementById('eTb1').innerHTML='<pre class="toc-raw">'+
      _epubRawLines.map((l,i)=>String(i+1).padStart(4,' ')+' | '+escHtml(l)).join('\n')+'</pre>';
  }
}
function applyEPat(){
  const v=document.getElementById('eTocPatEdit')?.value.trim();
  if(v){ document.getElementById('eTocPattern').value=v; previewEpubToc(); }
}

// ── 빠른 선택 칩 ──
function refreshEDetectedChip(){
  const pat=document.getElementById('eTocPattern')?.value.trim();
  if(!pat) return;
  const allChips=document.querySelectorAll('#eTocPatHelper .pat-chip');
  allChips.forEach(chip=>{
    chip.classList.remove('detected','active');
    try{
      const rx=new RegExp(chip.dataset.pat,'i');
      if(rx.source===new RegExp(pat,'i').source){ chip.classList.add('detected','active'); }
    }catch(e){}
  });
}
function applyETocSelectedChips(){
  const sel=_chipSelected['eTocPatHelper'];
  if(!sel||!sel.size){ Toast.warn('패턴을 먼저 선택해주세요.'); return; }
  const combined=buildCombinedPat(sel);
  document.getElementById('eTocPattern').value=combined;
  clearChipSelection('eTocPatHelper');
  document.getElementById('eTocPatApplyBar').style.display='none';
  previewEpubToc();
}

// ── AI 스마트 패턴 (EPUB 버전) ──
function eSmartPatConvert(){
  clearTimeout(_eSmartPatTimer);
  const include=document.getElementById('eSmartPatInput')?.value.trim()||'';
  const exclude=document.getElementById('eSmartPatExclude')?.value.trim()||'';
  if(!include){ document.getElementById('eSmartPatResultBox').style.display='none'; return; }
  _eSmartPatTimer=setTimeout(()=>_eRunSmartPat(include, exclude), 600);
}
async function _eRunSmartPat(include, exclude){
  const resultBox=document.getElementById('eSmartPatResultBox');
  const resultEl=document.getElementById('eSmartPatResult');
  const aiLabel=document.getElementById('eSmartPatAiLabel');
  const applyBtn=resultBox.querySelector('button');
  const apiKey=(document.getElementById('geminiApiKey')?.value||'').trim();
  resultBox.style.display='flex'; resultBox.style.borderColor='var(--border)';
  resultEl.textContent='⏳ 변환 중...'; applyBtn.style.display='none';
  if(aiLabel) aiLabel.style.display='none';
  try{
    let rx=null;
    if(apiKey){
      rx=await _askGeminiForPattern(apiKey, include, exclude);
    }
    if(!rx) rx=guessPatternFromExample(include);
    if(rx){
      resultEl.textContent=rx;
      resultBox.style.borderColor='var(--accent)';
      applyBtn.style.display='';
      if(apiKey&&aiLabel) aiLabel.style.display='';
    }else{
      resultEl.textContent='(인식 불가 — 정규식 수정 탭에서 직접 입력)';
      resultBox.style.borderColor='var(--border)';
    }
  }catch(e){
    const msg=e.message||'';
    if(msg==='quota_exceeded'){
      Toast.warn(
        'Gemini API 할당량 초과 — 내장 변환 로직을 사용해요.<br>'+
        '<small style="opacity:.8">💡 오류에 <b>limit: 0</b>이 있으면 Google AI Studio 키인지 확인해주세요.<br>'+
        'https://aistudio.google.com/app/apikey</small>'
      );
    } else if(msg.includes('API 키가 올바르지 않아요')){
      resultEl.textContent='⚠ '+msg;
      resultBox.style.borderColor='var(--accent)';
      resultBox.style.display='flex';
      applyBtn.style.display='none';
      return;
    } else {
    }
    const rx2=guessPatternFromExample(include);
    if(rx2){ resultEl.textContent=rx2; resultBox.style.borderColor='var(--accent)'; applyBtn.style.display=''; }
    else{ resultEl.textContent='(변환 실패 — 정규식 수정 탭에서 직접 입력)'; resultBox.style.borderColor='var(--border)'; }
  }
}
function applyESmartPat(){
  const rx=document.getElementById('eSmartPatResult')?.textContent;
  if(!rx||rx.startsWith('(')) return;
  document.getElementById('eTocPattern').value=rx;
  document.getElementById('eSmartPatInput').value='';
  document.getElementById('eSmartPatExclude').value='';
  document.getElementById('eSmartPatResultBox').style.display='none';
  previewEpubToc();
}

// ── 탭 전환 ──
function switchEditTab(name){
  ['toc','ill','css'].forEach(t=>{
    const btn=document.getElementById('editTab_'+t);
    const panel=document.getElementById('editPanel_'+t);
    const active=t===name;
    // ★ FIX-05: classList 토글 방식으로 변경 (style.css .edit-tab.on 클래스 사용)
    if(btn) btn.classList.toggle('on', active);
    if(panel) panel.style.display=active?'block':'none';
  });
  // 삽화 탭 열 때 드롭존 이벤트 초기화
  if(name==='ill') setupDirectEditIllDrop();
}

// ── 목차 렌더 ──
function renderDirectEditToc(){
  if(!E.chapters.length) return;
  // 초기화: chapters 기반으로 tocItems 생성
  if(!_directEditTocItems.length||_directEditTocItems.length!==E.chapters.length){
    _directEditTocItems=E.chapters.map(ch=>({
      href:ch.href, title:ch.title, enabled:true
    }));
  }
  const list=document.getElementById('directEditTocList');
  if(!list) return;
  list.innerHTML='';
  _directEditTocItems.forEach((item,i)=>{
    const d=document.createElement('div');
    d.className='ch-item';
    d.draggable=true;
    d.style.cssText='display:flex;align-items:center;gap:8px;cursor:default;'+(item.enabled?'':'opacity:.4');
    d.dataset.idx=i;

    const chk=document.createElement('input');
    chk.type='checkbox'; chk.className='toc-chk'; chk.checked=item.enabled;
    chk.onchange=()=>{ _directEditTocItems[i].enabled=chk.checked; d.style.opacity=chk.checked?'1':'0.4'; };

    const num=document.createElement('span');
    num.className='ch-idx'; num.textContent=(i+1);

    const title=document.createElement('input');
    title.className='toc-title-edit'; title.value=item.title;
    title.onchange=()=>{ _directEditTocItems[i].title=title.value.trim()||item.title; };

    // 드래그
    d.addEventListener('dragstart',()=>{ d.style.opacity='0.35'; d._dragIdx=i; });
    d.addEventListener('dragend',()=>{ d.style.opacity=item.enabled?'1':'0.4'; });
    d.addEventListener('dragover',e=>{ e.preventDefault(); d.classList.add('drag-over'); });
    d.addEventListener('dragleave',()=>{ d.classList.remove('drag-over'); });
    d.addEventListener('drop',e=>{
      e.preventDefault(); d.classList.remove('drag-over');
      const src=parseInt(list.querySelector('[style*="0.35"]')?.dataset.idx??'-1');
      if(src<0||src===i) return;
      const moved=_directEditTocItems.splice(src,1)[0];
      _directEditTocItems.splice(i,0,moved);
      renderDirectEditToc();
    });

    d.appendChild(chk); d.appendChild(num); d.appendChild(title);
    list.appendChild(d);
  });
}

function directEditTocCheckAll(v){
  _directEditTocItems.forEach(it=>it.enabled=v);
  renderDirectEditToc();
}
function directEditTocMoveUp(){
  // 선택된 체크된 항목 중 첫 번째를 한 칸 위로
  const focused=document.querySelector('#directEditTocList input[type="checkbox"]:checked');
  if(!focused) return;
  const idx=parseInt(focused.closest('[data-idx]')?.dataset.idx??'-1');
  if(idx<=0) return;
  [_directEditTocItems[idx-1],_directEditTocItems[idx]]=[_directEditTocItems[idx],_directEditTocItems[idx-1]];
  renderDirectEditToc();
}
function directEditTocMoveDown(){
  const focused=document.querySelector('#directEditTocList input[type="checkbox"]:checked');
  if(!focused) return;
  const idx=parseInt(focused.closest('[data-idx]')?.dataset.idx??'-1');
  if(idx<0||idx>=_directEditTocItems.length-1) return;
  [_directEditTocItems[idx],_directEditTocItems[idx+1]]=[_directEditTocItems[idx+1],_directEditTocItems[idx]];
  renderDirectEditToc();
}

// ── 삽화 드롭존 ──
function setupDirectEditIllDrop(){
  const dz=document.getElementById('directEditIllDrop');
  const inp=document.getElementById('directEditIllIn');
  if(!dz||dz._ready) return;
  dz._ready=true;
  dz.onclick=()=>inp.click();
  dz.ondragover=e=>{e.preventDefault();dz.classList.add('over');};
  dz.ondragleave=()=>dz.classList.remove('over');
  dz.ondrop=e=>{e.preventDefault();dz.classList.remove('over');handleDirectEditIll(e.dataTransfer.files);};
  inp.onchange=e=>handleDirectEditIll(e.target.files);
  // 수동 매핑 라디오
  document.querySelectorAll('input[name="directEditIllMode"]').forEach(r=>{
    r.onchange=()=>{
      document.getElementById('directEditIllManual').style.display=r.value==='manual'?'block':'none';
    };
  });
}
function handleDirectEditIll(files){
  [...files].forEach(f=>{
    if(!_directEditIllFiles.find(x=>x.name===f.name)) _directEditIllFiles.push(f);
  });
  renderDirectEditIllTags();
}
function renderDirectEditIllTags(){
  const c=document.getElementById('directEditIllTags'); c.innerHTML='';
  _directEditIllFiles.forEach((f,i)=>{
    const stem=f.name.replace(/\.[^.]+$/,'');
    const mi=stem.match(/^(\d+)(?:_(\d+))?/);
    const badge=mi?`<span style="font-size:9px;background:var(--accent-bg);color:var(--accent);border-radius:3px;padding:1px 5px;font-weight:700">${parseInt(mi[1])}번째${mi[2]?'-'+parseInt(mi[2]):''}</span>`:'';
    const t=document.createElement('div');
    t.className='tag';
    t.innerHTML=`<span style="font-size:11px;max-width:120px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${escHtml(f.name)}</span>${badge}<span class="x" onclick="removeDirectEditIll(${i})">✕</span>`;
    c.appendChild(t);
  });
}
function removeDirectEditIll(i){ _directEditIllFiles.splice(i,1); renderDirectEditIllTags(); }
function addDirectEditIllRow(){
  const list=document.getElementById('directEditIllManualList');
  const id=typeof genUID==='function'?genUID():Date.now();
  const div=document.createElement('div');
  div.className='mill-row'; div.id='deir_'+id;
  div.style.marginBottom='8px';
  div.innerHTML=
    '<div style="display:flex;gap:6px;align-items:center;flex-wrap:wrap">'+
    '<select id="deif_'+id+'" style="flex:2;min-width:100px;font-size:12px;padding:5px 8px;border:1.5px solid var(--border);border-radius:6px;background:var(--bg);color:var(--text);font-family:inherit">'+
    '<option value="">파일 선택</option>'+
    _directEditIllFiles.map(f=>`<option value="${escHtml(f.name)}">${escHtml(f.name)}</option>`).join('')+
    '</select>'+
    '<input type="number" id="deich_'+id+'" placeholder="챕터 번호(1-based)" min="1" style="width:130px;font-size:12px;padding:5px 8px;border:1.5px solid var(--border);border-radius:6px;background:var(--bg);color:var(--text)">'+
    '<select id="deip_'+id+'" style="font-size:12px;padding:5px 8px;border:1.5px solid var(--border);border-radius:6px;background:var(--bg);color:var(--text);font-family:inherit"><option value="before">챕터 앞</option><option value="after">챕터 뒤</option></select>'+
    '<button class="btn btn-sm" style="background:var(--accent-bg);color:var(--accent)" data-action="removeDirectIllRow" data-row-id="deir_'+id+'">✕</button>'+
    '</div>';
  list.appendChild(div);
}

// ── CSS 프리셋 ──
function directEditCssPreset(type){
  const ta=document.getElementById('directEditCssInput');
  const presets={
    indent:'p { text-indent: 1em; margin: 0; }\nbody { padding: 1em 1.5em; }',
    line:'body { line-height: 1.9; }\np { margin-bottom: 0.4em; }',
    font:"body { font-size: 1.05em; font-family: 'Noto Serif KR', serif; }",
    reset:'* { margin: 0; padding: 0; box-sizing: border-box; }\nbody { font-size: 1em; line-height: 1.8; padding: 1em; }'
  };
  ta.value=(ta.value?ta.value+'\n\n':'')+presets[type];
}

// ── 적용 ──
async function applyDirectEdit(){
  if(!E.epubZip){ Toast.warn('EPUB 파일을 먼저 불러와주세요.'); return; }

  const activeTab=['toc','ill','css'].find(t=>document.getElementById('editPanel_'+t).style.display!=='none')||'toc';
  const progWrap=document.getElementById('directEditProgWrap');
  const progBar=document.getElementById('directEditProgBar');
  const progMsg=document.getElementById('directEditProgMsg');
  const errBox=document.getElementById('directEditErrBox');
  const resultBox=document.getElementById('directEditResultBox');

  progWrap.classList.add('show'); errBox.classList.remove('show'); resultBox.style.display='none';
  function ep(pct,msg){ progBar.style.width=pct+'%'; progMsg.textContent=msg; }

  try{
    ep(5,'EPUB 복제 중...');
    const newZip=new JSZip();
    for(const[name,f] of Object.entries(E.epubZip.files)){
      if(f.dir) continue;
      newZip.file(name, await f.async('arraybuffer'));
    }

    const containerXml=await E.epubZip.file('META-INF/container.xml').async('text');
    const opfPath=containerXml.match(/full-path="([^"]+)"/)[1];
    const opfBase=opfPath.replace(/[^/]+$/,'');

    // ── 목차 재생성 ──
    if(activeTab==='toc'){
      ep(20,'목차 재생성 중...');
      // 감지된 새 목차 사용 (_eTocItems), 없으면 기존 목차 편집 결과 사용
      let enabledItems;
      if(_eTocItems.length>0){
        // 패턴 감지로 새로 생성된 목차 → href를 텍스트 내 줄 번호로 가장 가까운 챕터에 매핑
        enabledItems=_eTocItems.filter(it=>it.enabled).map(item=>{
          // _epubRawLines에서 item.line 기준으로 어느 챕터 xhtml에 해당하는지 계산
          // 챕터 전체 텍스트 합산 줄 수 기반으로 해당 챕터 href 찾기
          let accLines=0;
          let targetHref=E.chapters[0]?.href||'';
          for(const ch of E.chapters){
            const chLines=_epubRawLines.filter((_,i)=>i>=accLines&&i<accLines+9999).length;
            // 챕터당 평균 줄수로 어느 챕터인지 근사
            const chLineCount=Math.ceil(_epubRawLines.length/E.chapters.length);
            const chIdx=Math.min(Math.floor((item.line-1)/Math.max(1,chLineCount)), E.chapters.length-1);
            targetHref=E.chapters[chIdx]?.href||E.chapters[0]?.href;
            break;
          }
          return {href:targetHref, title:item.title, enabled:true};
        });
        // href 중복 제거 (같은 챕터에 여러 제목이 매핑되면 첫 번째만)
        const seen=new Set();
        enabledItems=enabledItems.filter(it=>{ if(seen.has(it.href))return false; seen.add(it.href); return true; });
      }else{
        enabledItems=_directEditTocItems.filter(it=>it.enabled);
      }
      if(!enabledItems.length) throw new Error('활성화된 챕터가 없어요. 먼저 목차 확인을 눌러주세요.');

      // OPF 읽기
      let opfXml=await E.epubZip.file(opfPath).async('text');

      // 메타데이터 수정
      const newTitle=document.getElementById('directEditTitle')?.value.trim();
      const newAuthor=document.getElementById('directEditAuthor')?.value.trim();
      if(newTitle) opfXml=opfXml.replace(/<dc:title>[^<]*<\/dc:title>/,`<dc:title>${escHtml(newTitle)}</dc:title>`);
      if(newAuthor) opfXml=opfXml.replace(/<dc:creator[^>]*>[^<]*<\/dc:creator>/,`<dc:creator>${escHtml(newAuthor)}</dc:creator>`);

      // Spine 재생성 (활성화된 챕터 순서로)
      // 새 목차(_eTocItems)일 경우: 기존 모든 챕터 순서 유지 + 제목만 갱신
      const spineItems=(_eTocItems.length>0
        ? E.chapters.map(ch=>ch.href)   // 원본 순서 유지
        : enabledItems.map(it=>it.href) // 편집 순서 적용
      ).map(href=>{
        const relHref=href.replace(opfBase,'');
        const id=relHref.replace(/[^a-zA-Z0-9_-]/g,'_').replace(/^_+/,'ch_');
        return `<itemref idref="${id}"/>`;
      }).join('\n    ');
      opfXml=opfXml.replace(/<spine[^>]*>[\s\S]*?<\/spine>/,
        `<spine toc="ncx">\n    ${spineItems}\n  </spine>`);
      newZip.file(opfPath, opfXml);

      // NCX 재생성
      ep(50,'NCX 목차 재생성 중...');
      const ncxPath=opfBase+(opfXml.match(/href="([^"]*\.ncx)"/)?.[1]||'toc.ncx');
      const navPoints=enabledItems.map((it,idx)=>`
    <navPoint id="np${idx+1}" playOrder="${idx+1}">
      <navLabel><text>${escHtml(it.title)}</text></navLabel>
      <content src="${it.href.replace(opfBase,'')}"/>
    </navPoint>`).join('');
      const ncxXml=`<?xml version="1.0" encoding="UTF-8"?>
<ncx xmlns="http://www.daisy.org/z3986/2005/ncx/" version="2005-1">
  <head><meta name="dtb:depth" content="1"/></head>
  <docTitle><text>${escHtml(newTitle||E.chapters[0]?.title||'')}</text></docTitle>
  <navMap>${navPoints}
  </navMap>
</ncx>`;
      newZip.file(ncxPath, ncxXml);

      // Nav HTML 재생성 (EPUB3)
      const navPath=Object.keys(E.epubZip.files).find(f=>f.includes('nav') && f.endsWith('.xhtml'));
      if(navPath){
        const navItems=enabledItems.map(it=>
          `<li><a href="${it.href.replace(opfBase,'')}">${escHtml(it.title)}</a></li>`
        ).join('\n      ');
        const navHtml=`<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE html>
<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops">
<head><meta charset="UTF-8"/><title>목차</title></head>
<body><nav epub:type="toc"><ol>
      ${navItems}
</ol></nav></body></html>`;
        newZip.file(navPath, navHtml);
      }
      ep(80,'완료 중...');
    }

    // ── 삽화 추가 ──
    else if(activeTab==='ill'){
      ep(20,'삽화 매핑 중...');
      if(!_directEditIllFiles.length) throw new Error('삽화 파일을 먼저 추가해주세요.');

      const mode=document.querySelector('input[name="directEditIllMode"]:checked').value;
      // buildIllEntries와 동일한 인덱스 매핑 로직 사용
      const illEntries=buildIllEntries(E.chapters, opfBase, _directEditIllFiles, mode);
      if(!illEntries.length) throw new Error('삽입할 삽화를 매핑하지 못했어요. 파일명을 확인해주세요.');

      ep(40,'삽화 삽입 중...');
      await insertIllsToEpub(newZip, opfPath, opfBase, illEntries);
      ep(80,'완료 중...');
    }

    // ── CSS 추가 ──
    else if(activeTab==='css'){
      ep(20,'CSS 파일 찾는 중...');
      const userCss=document.getElementById('directEditCssInput')?.value.trim();
      if(!userCss) throw new Error('추가할 CSS를 입력해주세요.');
      const append=document.getElementById('directEditCssAppend')?.checked;

      // EPUB 내 CSS 파일 찾기
      const cssFiles=Object.keys(E.epubZip.files).filter(f=>f.endsWith('.css'));
      if(!cssFiles.length) throw new Error('EPUB 내 CSS 파일을 찾지 못했어요.');

      ep(40,'CSS 수정 중...');
      for(const cssFile of cssFiles){
        const orig=append ? (await E.epubZip.file(cssFile).async('text'))+'\n\n/* === 추가된 CSS === */\n'+userCss : userCss;
        newZip.file(cssFile, orig);
      }
      ep(80,'완료 중...');
    }

    ep(90,'EPUB 생성 중...');
    const blob=await newZip.generateAsync({type:'blob',compression:'DEFLATE',compressionOptions:{level:6}});
    const origName=(E.epubFile?.name||'edited').replace(/\.epub$/i,'');
    const suffix=activeTab==='toc'?'_목차수정':activeTab==='ill'?'_삽화추가':'_CSS추가';
    _directEditResult={blob, name:origName+suffix+'.epub'};
    ep(100,'완료!');
    document.getElementById('directEditResultMsg').textContent=_directEditResult.name;
    resultBox.style.display='block';
    Toast.success('EPUB 편집이 완료됐어요.');
  }catch(e){
    errBox.textContent='❌ '+e.message; errBox.classList.add('show');
    progWrap.classList.remove('show');
  }
}

function downloadDirectEditEpub(){
  if(!_directEditResult) return;
  const a=document.createElement('a');
  a.href=URL.createObjectURL(_directEditResult.blob);
  a.download=_directEditResult.name; a.click();
  setTimeout(()=>URL.revokeObjectURL(a.href),1000);
}

// buildIllEntries 오버로드: directEdit용 파일 목록 지원
function buildIllEntries(epubChapters, opfBase, illFilesOverride, modeOverride){
  const files=illFilesOverride||EI.files;
  const mode=modeOverride||(document.querySelector('input[name="editIllMode"]:checked')?.value||'auto');
  const entries=[];
  const overflowWarnings=[];

  if(mode==='auto'){
    const autoEntries=[];
    for(const f of files){
      const stem=f.name.replace(/\.[^.]+$/,'');
      const m=stem.match(/^(\d+)(?:_(\d+))?/);
      if(!m) continue;
      const chIdx=parseInt(m[1])-1;
      const order=parseInt(m[2]||'1');
      let ch=null;
      if(chIdx>=0&&chIdx<epubChapters.length){
        ch=epubChapters[chIdx];
      }else if(epubChapters.length>0){
        ch=epubChapters[epubChapters.length-1];
        overflowWarnings.push(f.name);
      }
      if(ch) autoEntries.push({file:f, targetHref:ch.href, pos:'before', order});
    }
    autoEntries.sort((a,b)=>a.order-b.order);
    entries.push(...autoEntries);
  }else{
    // 수동: 기존 eir_ 또는 deir_ 행 파싱
    const prefix=illFilesOverride?'deir_':'eir_';
    document.querySelectorAll('[id^="'+prefix+'"]').forEach(row=>{
      const id=row.id.replace(prefix,'');
      const fname=document.getElementById((illFilesOverride?'deif_':'eif_')+id)?.value.trim();
      if(!fname) return;
      const file=files.find(f=>f.name===fname);
      if(!file) return;
      const chNum=parseInt(document.getElementById((illFilesOverride?'deich_':'eic_')+id)?.value||'0');
      const pos=document.getElementById((illFilesOverride?'deip_':'eip_')+id)?.value||'before';
      const chIdx=chNum-1;
      const ch=chIdx>=0&&chIdx<epubChapters.length?epubChapters[chIdx]:null;
      if(ch) entries.push({file,targetHref:ch.href,pos});
    });
  }

  // 기존 editIll 경로에서만 overflow 경고 표시
  if(!illFilesOverride){
    const warnEl=document.getElementById('editIllOverflowWarn');
    if(warnEl){
      if(overflowWarnings.length>0){
        warnEl.textContent='⚠️ 목차 수('+epubChapters.length+'화)를 초과하는 삽화 '+overflowWarnings.length+'개가 마지막 챕터에 배치되었습니다: '+overflowWarnings.join(', ');
        warnEl.style.display='block';
      }else{ warnEl.style.display='none'; }
    }
  }
  return entries;
}


// ══════════════════════════════════════════
// 🔍 Module: CoverSearch (표지 검색 모달)
// ══════════════════════════════════════════
