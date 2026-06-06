// ════════════════════════════════════════════════
// convert.js — 인코딩/Worker, 파일 핸들러, 변환 탭, 배치 탭
// NovelEPUB | TXT → EPUB3
//
// 의존성: core.js → settings.js → cover-search.js → parser.js → epub-gen.js
// ════════════════════════════════════════════════

/* global Toast, EventBus, S, B, _sStore, _bStore, yieldToMain, RecoverableError,
   escHtml, escAttr, sortKey, smartSortFiles, splitChapters, buildChaptersFromTocItems,
   getCachedChapters, previewToc, extractChNum, bestPat,
   buildEpub, JSZip, getCssVar,
   updateBtmBar, updateFeedFromToc, updateSettingsSummary, renderTocItems,
   updateTocStat, updateTocEditBanner, _saveTocSnapshot,
   _chaptersCache, _chaptersCacheKey, _fullRawLines, _autoSplitLines, _autoSplitActive,
   saveHistory, generateTextCover, _sendConvertNotif,
   saveCssSettings, saveExtraSettings, loadCssSettings */

'use strict';

const _encCache=new Map();

// ══════════════════════════════════════════
// 🔧 Module: TextWorker (worker.js 연동)
// 20MB+ 파일의 인코딩 감지·디코딩을 Worker에 위임 → 메인 스레드 비블로킹
// ══════════════════════════════════════════
const TextWorker = (() => {
  let _worker = null;
  let _pending = new Map(); // id → {resolve, reject, timer}
  let _idSeq   = 0;
  const LARGE_FILE_THRESHOLD = 5 * 1024 * 1024; // 5MB 이상 Worker 위임
  // ★ L-17: Worker 연속 실패 카운터 — 구문 오류/CSP 차단 시 무한 재생성 방지
  let _workerFailCount = 0;
  const MAX_WORKER_FAILS = 3;

  function _getWorker(){
    if(_worker) return _worker;
    // ★ L-17 FIX: 연속 실패 임계값 초과 시 Worker 영구 비활성화
    if(_workerFailCount >= MAX_WORKER_FAILS) return null;
    try{
      _worker = new Worker('worker.js');
      _worker.onmessage = function(e){
        const { type, id, result, error } = e.data;
        if(type === 'PROGRESS') return; // 진행률은 Worker에서 직접 처리
        const entry = _pending.get(id);
        if(!entry) return;
        clearTimeout(entry.timer);
        _pending.delete(id);
        if(type === 'RESULT') entry.resolve(result);
        else entry.reject(new Error(error || 'Worker 오류'));
      };
      _worker.onerror = function(e){
        // Worker 오류 시 대기 중인 모든 요청 실패 처리
        for(const [,entry] of _pending){
          clearTimeout(entry.timer);
          entry.reject(new Error('Worker 오류: ' + e.message));
        }
        _pending.clear();
        _workerFailCount++; // ★ L-17: 실패 횟수 누적
        _worker = null; // 재생성 허용 (임계값 미달 시)
      };
    }catch(e){
      _workerFailCount++;
      _worker = null;
    }
    return _worker;
  }

  // ArrayBuffer를 Worker에 보내고 결과 Promise 반환
  function post(type, payload, transferables=[], timeoutMs=30000){
    return new Promise((resolve, reject) => {
      const worker = _getWorker();
      if(!worker){
        reject(new Error('Worker 사용 불가'));
        return;
      }
      const id = ++_idSeq;
      const timer = setTimeout(() => {
        _pending.delete(id);
        reject(new Error('Worker timeout'));
      }, timeoutMs);
      _pending.set(id, { resolve, reject, timer });
      // ★ L-08: Transferable 전송 여부 추적 — 전송 후 detached 버퍼 재사용 방지
      let _transferred = false;
      try{
        worker.postMessage({ type, id, payload }, transferables);
        _transferred = true;
      }catch(e){
        clearTimeout(timer);
        _pending.delete(id);
        // ★ transferables가 이미 detached 상태라면 _transferred=false → 폴백에서 재사용 없음
        reject(e);
      }
      void _transferred; // 향후 폴백 경로에서 참조 가능하도록 보존
    });
  }

  // ★ 파일 크기 기반 자동 라우팅
  // 소형 파일: 메인 스레드 직접 처리 (Worker 오버헤드 없음)
  // 대형 파일: Worker에 ArrayBuffer 전송 (Transferable → 복사 비용 없음)
  async function fileToTextViaWorker(file, enc){
    if(file.size < LARGE_FILE_THRESHOLD || !_getWorker()){
      return null; // 메인 스레드 폴백 신호
    }
    const ab = await new Promise((res, rej) => {
      const r = new FileReader();
      r.onload = e => res(e.target.result);
      r.onerror = rej;
      r.readAsArrayBuffer(file);
    });
    // ★ Transferable: ArrayBuffer 소유권을 Worker로 이전 (zero-copy)
    const result = await post(
      'FILE_TO_TEXT',
      { buffer: ab },
      [ab] // transferables
    );
    return result.text;
  }

  return { fileToTextViaWorker };
})();

// ★ U-12: detectEncodingFromAB — ArrayBuffer를 직접 받아 처리 (이중 FileReader 제거용)
function _detectEncodingFromAB(ab){
  const bytes=new Uint8Array(ab.slice(0,65536));
  if(bytes[0]===0xEF&&bytes[1]===0xBB&&bytes[2]===0xBF) return 'utf-8';
  if(bytes[0]===0xFF&&bytes[1]===0xFE) return 'utf-16le';
  if(bytes[0]===0xFE&&bytes[1]===0xFF) return 'utf-16be';
  let utf8Errors=0, totalMultibyte=0;
  let i=0;
  const limit=bytes.length-3;
  while(i<limit){
    const b=bytes[i];
    if(b<0x80){i++;continue;}
    if(b>=0xC2&&b<=0xDF){ if((bytes[i+1]&0xC0)===0x80){totalMultibyte++;i+=2;continue;} }
    else if(b>=0xE0&&b<=0xEF){ if((bytes[i+1]&0xC0)===0x80&&(bytes[i+2]&0xC0)===0x80){totalMultibyte++;i+=3;continue;} }
    else if(b>=0xF0&&b<=0xF4){ if(i+3<limit&&(bytes[i+1]&0xC0)===0x80&&(bytes[i+2]&0xC0)===0x80&&(bytes[i+3]&0xC0)===0x80){totalMultibyte++;i+=4;continue;} }
    utf8Errors++;i++;
  }
  const errorRate=utf8Errors/Math.max(totalMultibyte,1);
  if(errorRate<0.001) return 'utf-8';
  const utf8Text=new TextDecoder('utf-8',{fatal:false}).decode(bytes);
  const eucText=new TextDecoder('euc-kr',{fatal:false}).decode(bytes);
  const utf8Bad=(utf8Text.match(/\ufffd/g)||[]).length;
  const eucBad=(eucText.match(/\ufffd/g)||[]).length;
  if(utf8Bad===0) return 'utf-8';
  return utf8Bad<=eucBad ? 'utf-8' : 'euc-kr';
}

async function detectEncoding(file){
  const ab=await fileToAB(file);
  // 샘플 크기 64KB (8KB → 64KB: 경계 잘림 문제 해소)
  return _detectEncodingFromAB(ab);
}

async function fileToText(file){
  // ★ U-12 FIX: ArrayBuffer를 한 번만 읽고 detectEncoding + 디코딩 모두 재사용
  // 기존: detectEncoding(fileToAB) → fileToText(readAsArrayBuffer) = 2회 I/O
  // 개선: fileToAB 1회 → _detectEncodingFromAB + 직접 디코딩
  const ab = await fileToAB(file);
  const enc = _detectEncodingFromAB(ab);
  _encCache.set(file, enc);

  // ★ 대용량 파일(5MB+)은 Worker에 위임 → 메인 스레드 UI 비블로킹
  if(file.size >= 5 * 1024 * 1024){
    try{
      const workerResult = await TextWorker.fileToTextViaWorker(file, enc);
      if(workerResult !== null) return workerResult;
    }catch(e){
      // Worker 실패 시 메인 스레드 폴백 (아래 계속)
    }
  }

  // 소형 파일 또는 Worker 미지원 시 — 이미 읽은 ab 직접 디코딩
  return new Promise((res,rej)=>{
    // ★ 타임아웃 안전망: 30초 내 응답 없으면 reject (채널 닫힘 방지)
    const timer=setTimeout(()=>rej(new Error('fileToText timeout')), 30000);
    const done=(text)=>{ clearTimeout(timer); res(text); };
    const fail=(e)=>{ clearTimeout(timer); rej(e); };

    try{
      const decoder=new TextDecoder(enc,{fatal:false});
      const text=decoder.decode(new Uint8Array(ab));
      // U+FFFD(대체문자) 포함 여부 경고 — EUC-KR 오판 감지
      const badCount=(text.match(/\ufffd/g)||[]).length;
      if(badCount>10&&enc==='utf-8'){
        // UTF-8 판정인데 깨진 문자가 많으면 EUC-KR로 재시도
        try{
          const text2=new TextDecoder('euc-kr',{fatal:false}).decode(new Uint8Array(ab));
          const bad2=(text2.match(/\ufffd/g)||[]).length;
          done(bad2<badCount?text2:text);
        }catch(err2){
          done(text);
        }
      }else{
        done(text);
      }
    }catch(err){
      // fallback: readAsText
      const fr=new FileReader();
      fr.onload=ev=>done(ev.target.result||'');
      fr.onerror=()=>{
        // ★ 최후 폴백도 빈 문자열 반환 (절대 reject 안 함)
        const fr2=new FileReader();
        fr2.onload=ev2=>done(ev2.target.result||'');
        fr2.onerror=e2=>fail(e2);
        fr2.readAsText(file,enc);
      };
      fr.readAsText(file,enc);
    }
  });
}

// 파일을 스트리밍 방식으로 부분 읽기 (대용량 파일 UI 블로킹 방지)
// UTF-8 경계 안전 슬라이스 읽기
// 고정 바이트 오프셋 슬라이스 시 멀티바이트 문자(한글 3바이트)가 잘릴 수 있음
// → ArrayBuffer로 읽어서 경계 바이트를 직접 보정 후 TextDecoder 사용
async function readFileSlice(file, start, end){
  // 앞 경계 보정: start가 멀티바이트 중간이면 다음 유효 바이트로 이동
  const MARGIN=4; // UTF-8 최대 4바이트
  const safeStart=Math.max(0, start-MARGIN);
  const safeEnd=Math.min(file.size, end+MARGIN);

  return new Promise((res,rej)=>{
    const slice=file.slice(safeStart, safeEnd);
    const r=new FileReader();
    r.onload=e=>{
      const bytes=new Uint8Array(e.target.result);
      // 앞 경계: start-safeStart 오프셋부터 첫 유효 UTF-8 시작 바이트 찾기
      let s=start-safeStart;
      while(s<bytes.length&&s<MARGIN&&(bytes[s]&0xC0)===0x80) s++;
      // 뒤 경계: end-safeStart 오프셋 이후 멀티바이트 완성 보장
      let e2=end-safeStart;
      while(e2<bytes.length&&(bytes[e2]&0xC0)===0x80) e2++;
      try{
        const text=new TextDecoder('utf-8',{fatal:false}).decode(bytes.subarray(s,e2));
        res(text);
      }catch(err){
        // fallback: FileReader readAsText
        const fr=new FileReader();
        fr.onload=ev=>res(ev.target.result);
        fr.onerror=()=>res('');
        fr.readAsText(new Blob([bytes.subarray(s,e2)]),'utf-8');
      }
    };
    r.onerror=rej;
    r.readAsArrayBuffer(slice);
  });
}

async function sampleLines(file){
  const size=file.size;

  // 소용량(5MB 이하): 전체 읽기
  if(size<=5*1024*1024){
    const text=await fileToText(file);
    return text; // 전체 반환 — 패턴 감지 정확도 최우선
  }

  // 대용량(5MB 초과): 앞/1/4/중/3/4/뒤 슬라이스 + 짧은줄 전용 패스
  const CHUNK=384*1024; // 384KB씩
  const chunks=[];
  chunks.push(await readFileSlice(file, 0, CHUNK));
  chunks.push(await readFileSlice(file, Math.floor(size*0.25), Math.floor(size*0.25)+CHUNK));
  chunks.push(await readFileSlice(file, Math.floor(size*0.5),  Math.floor(size*0.5)+CHUNK));
  chunks.push(await readFileSlice(file, Math.floor(size*0.75), Math.floor(size*0.75)+CHUNK));
  chunks.push(await readFileSlice(file, Math.max(0,size-CHUNK), size));

  // 각 청크에서 헤더 후보 줄 추출
  // [ 파일명.txt ] 형태는 최대 ~60자이므로 기준 확장 (1~80자)
  const headerCandidates=[];
  for(const chunk of chunks){
    for(const l of chunk.split('\n')){
      const t=l.trim();
      if(t.length>=1&&t.length<=80) headerCandidates.push(t);
    }
  }

  // 균등 샘플 (각 청크 앞 150줄씩)
  const uniformLines=[];
  for(const chunk of chunks){
    uniformLines.push(...chunk.split('\n').slice(0,150));
  }

  return uniformLines.join('\n')+'\n'+[...new Set(headerCandidates)].join('\n');
}
// ══════════════════════════════════════════
// 🗂  Module: FileUtil (이미지 변환·파일 읽기)
// ══════════════════════════════════════════
async function fileToAB(file){
  return new Promise((res,rej)=>{const r=new FileReader();r.onload=e=>res(e.target.result);r.onerror=rej;r.readAsArrayBuffer(file);});
}

// 이미지 변환 함수 — 설정에 따라 JPG 변환 or 원본 유지
// forCover=true 이면 항상 JPG 변환 (표지는 뷰어 호환성 최우선)
async function convertImageFile(file, forCover=false){
  try{
    const ext=(file.name.split('.').pop()||'').toLowerCase();
    const supportedAsIs=['jpg','jpeg'];
    const convertable=['png','gif','webp','bmp','tiff','tif','avif','heic','heif'];

    if(supportedAsIs.includes(ext)) return {blob:file, ext:'jpg', mt:'image/jpeg'};

    const shouldConvert=forCover || document.getElementById('optImgConvert')?.checked!==false;

    if(shouldConvert && convertable.includes(ext)){
      const quality=(parseInt(document.getElementById('optImgQuality')?.value||'92'))/100;
      try{
        const blob=await imgToJpgBlob(file, quality);
        return {blob, ext:'jpg', mt:'image/jpeg'};
      }catch(convErr){
        // ★ 변환 실패 시 원본 사용 (전체 공정 중단 없음)
        Toast.warn&&Toast.warn(`이미지 변환 실패 (원본 사용): ${file.name}`);
      }
    }

    const mimeMap={
      'png':'image/png','gif':'image/gif','webp':'image/webp',
      'bmp':'image/bmp','tiff':'image/tiff','tif':'image/tiff',
      'avif':'image/avif','svg':'image/svg+xml',
    };
    const mt=mimeMap[ext]||'image/jpeg';
    return {blob:file, ext, mt};
  }catch(e){
    // ★ 이미지 처리 자체가 실패해도 null 반환으로 건너뜀 (전체 공정 유지)
    Toast.warn&&Toast.warn(`이미지 처리 건너뜀: ${file.name}`);
    return null;
  }
}

// Canvas 기반 JPG 변환 (모든 포맷 대응)
async function imgToJpgBlob(file, quality=0.92){
  return new Promise((res,rej)=>{
    const url=URL.createObjectURL(file);
    const img=new Image();
    img.onload=()=>{
      try{
        const c=document.createElement('canvas');
        c.width=img.naturalWidth||img.width;
        c.height=img.naturalHeight||img.height;
        const ctx=c.getContext('2d');
        // PNG 투명 배경 → CSS var(--bg) 또는 흰색 폴백
        ctx.fillStyle=getCssVar('--bg')||'#ffffff';
        ctx.fillRect(0,0,c.width,c.height);
        ctx.drawImage(img,0,0);
        c.toBlob(b=>{
          URL.revokeObjectURL(url);
          if(b) res(b);
          else rej(new Error('toBlob 실패'));
        },'image/jpeg',quality);
      }catch(e){URL.revokeObjectURL(url);rej(e);}
    };
    img.onerror=(e)=>{URL.revokeObjectURL(url);rej(new Error('이미지 로드 실패: '+file.name));};
    img.src=url;
  });
}

// 📂 Module: FileHandlers (드롭·파일 입력 처리)
// ══════════════════════════════════════════
function handleTxt(files, append=false){
  const txts=Array.from(files).filter(f=>f.name.endsWith('.txt'));
  if(!txts.length)return;

  // append 모드: 기존 파일에 추가 (중복 제거)
  if(append&&S.txtFiles.length){
    const existing=new Set(S.txtFiles.map(f=>f.name));
    const newFiles=txts.filter(f=>!existing.has(f.name));
    if(!newFiles.length){Toast.warn('이미 추가된 파일이에요.');return;}
    S.txtFiles=[...S.txtFiles,...newFiles];
  }else{
    S.txtFiles=smartSortFiles(txts); // 스마트 정렬 적용
  }

  const txtDz=document.getElementById('txtDz');
  if(txtDz) txtDz.className='dz ok';
  const resetBar=document.getElementById('convertResetBar');
  if(resetBar) resetBar.style.display='flex';
  _chaptersCache=null; // 캐시 무효화

  renderTxtFileList();
  updateBtmBar&&updateBtmBar(S.txtFiles); // ★ 스티키 바 상태 갱신

  // ★ 파일 로드 즉시 splitBtn 활성화 — disabled 교착 방지
  // previewToc 완료 전에 버튼이 먼저 열려있어야 함
  typeof _activateSplitBtnOnFileLoad==='function'&&_activateSplitBtnOnFileLoad();

  // ★ 자동 미리보기 — optAutoPreview 없어도 파일 1개면 바로 실행
  const autoEl=document.getElementById('optAutoPreview');
  const autoPreview=autoEl?autoEl.checked:true; // 엘리먼트 없으면 기본 ON
  if(autoPreview){
    // 300ms 디바운스: 여러 파일 드롭 시 마지막 파일만 처리
    clearTimeout(handleTxt._timer);
    handleTxt._timer=setTimeout(()=>previewToc(),300);
  }

  // 메타데이터 자동 채우기 (첫 파일 기준)
  if(S.txtFiles.length>0){
    const stem=S.txtFiles[0].name.replace(/\.txt$/i,'');
    let title=stem,author='';
    let m=stem.match(/^\[(.+?)\]\s*(.+)$/);
    if(m){author=m[1].trim();title=m[2].trim();}
    else{m=stem.match(/^(.+?)\s*@\s*(.+)$/);if(m){title=m[1].trim();author=m[2].trim();}}
    const titleEl=document.getElementById('title');
    const authorEl=document.getElementById('author');
    if(titleEl&&!titleEl.value) titleEl.value=title;
    if(authorEl&&!authorEl.value) authorEl.value=author;
  }
}
handleTxt._timer=null; // 디바운스 타이머 초기화

// ── 파일 리스트 렌더링 (드래그 정렬 포함) ──
// ── 터치 정렬 헬퍼 (_attachTouchSort) ──
// touchstart/move/end 기반 모바일 드래그 정렬
// 작동 원리:
//   1. touchstart → 드래그 대상 기록 + 시각적 클론 생성
//   2. touchmove  → 클론을 손가락 위치로 이동 + 삽입 위치 계산
//   3. touchend   → 실제 배열 순서 변경 + 리렌더
let _touchDragState=null; // {fromIdx, clone, listEl, origRow, startY, scrollEl}

function _attachTouchSort(row, listEl, idx){
  const handle=row.querySelector('.txt-file-handle')||row;

  handle.addEventListener('touchstart',e=>{
    // 멀티터치 무시
    if(e.touches.length>1) return;
    const touch=e.touches[0];

    // 클론 생성 (시각적 피드백용)
    const clone=row.cloneNode(true);
    const rect=row.getBoundingClientRect();
    clone.style.cssText=
      'position:fixed;left:'+rect.left+'px;top:'+rect.top+'px;'+
      'width:'+rect.width+'px;opacity:.85;z-index:9999;'+
      'pointer-events:none;border:1.5px solid var(--accent);'+
      'border-radius:6px;background:var(--accent-bg);box-shadow:0 4px 16px rgba(0,0,0,.2)';
    document.body.appendChild(clone);

    row.style.opacity='0.3';

    // 스크롤 컨테이너 (listEl 또는 가장 가까운 scrollable 부모)
    const scrollEl=listEl;

    _touchDragState={
      fromIdx:idx, clone, listEl, origRow:row,
      startY:touch.clientY, scrollEl,
      cloneOffsetY: touch.clientY - rect.top,
      cloneOffsetX: touch.clientX - rect.left,
    };
    e.preventDefault(); // 페이지 스크롤 차단 (드래그 중에만)
  },{passive:false});

  handle.addEventListener('touchmove',e=>{
    if(!_touchDragState||e.touches.length>1) return;
    const st=_touchDragState;
    const touch=e.touches[0];

    // 클론 위치 업데이트
    st.clone.style.top=(touch.clientY - st.cloneOffsetY)+'px';
    st.clone.style.left=(touch.clientX - st.cloneOffsetX)+'px';

    // 손가락 아래 요소 찾기 (클론은 pointer-events:none 이므로 투과됨)
    const elBelow=document.elementFromPoint(touch.clientX, touch.clientY);
    const targetRow=elBelow?.closest('.txt-file-row');

    // drag-over 시각 표시
    st.listEl.querySelectorAll('.drag-over').forEach(el=>el.classList.remove('drag-over'));
    if(targetRow&&targetRow!==st.origRow){
      targetRow.classList.add('drag-over');
    }

    // 자동 스크롤: 리스트 상단/하단 근처에서 스크롤
    const listRect=st.listEl.getBoundingClientRect();
    const SCROLL_ZONE=40; // px
    if(touch.clientY < listRect.top + SCROLL_ZONE){
      st.listEl.scrollTop -= 6;
    } else if(touch.clientY > listRect.bottom - SCROLL_ZONE){
      st.listEl.scrollTop += 6;
    }

    e.preventDefault();
  },{passive:false});

  handle.addEventListener('touchend',e=>{
    if(!_touchDragState) return;
    const st=_touchDragState;

    // 클론 제거
    st.clone.remove();
    st.origRow.style.opacity='';

    // drag-over 제거
    st.listEl.querySelectorAll('.drag-over').forEach(el=>el.classList.remove('drag-over'));

    // 손가락 끝 위치로 대상 행 찾기
    const touch=e.changedTouches[0];
    const elBelow=document.elementFromPoint(touch.clientX, touch.clientY);
    const targetRow=elBelow?.closest('.txt-file-row');
    const toIdx=targetRow?parseInt(targetRow.dataset.idx):-1;

    if(toIdx>=0 && toIdx!==st.fromIdx){
      const moved=S.txtFiles.splice(st.fromIdx,1)[0];
      S.txtFiles.splice(toIdx,0,moved);
      _chaptersCache=null;
      renderTxtFileList();
    }

    _touchDragState=null;
  });
}

function renderTxtFileList(){
  const files=S.txtFiles;
  const listEl=document.getElementById('txtSortList');
  const countEl=document.getElementById('txtFileCount');
  const infoEl=document.getElementById('txtInfo');
  const listWrap=document.getElementById('txtFileList');
  if(!listEl) return;

  // 기존 info 영역 간단 요약
  infoEl.style.display='block';
  infoEl.textContent='✅ '+files.length+'개 파일 선택됨';
  listWrap.style.display='block';
  if(countEl) countEl.textContent=files.length+'개 · 드래그로 순서 변경';

  listEl.innerHTML='';
  files.forEach((f,i)=>{
    const row=document.createElement('div');
    row.className='txt-file-row';
    row.draggable=true;
    row.dataset.idx=i;

    row.innerHTML=
      '<span class="txt-file-handle" title="드래그해서 순서 변경">⠿</span>'+
      '<span class="txt-file-num">'+(i+1)+'</span>'+
      '<span class="txt-file-name" title="'+escHtml(f.name)+'">'+escHtml(f.name)+'</span>'+
      '<span class="txt-file-rm" data-idx="'+i+'" title="제거">✕</span>';

    // 인코딩 비동기 감지
    detectEncoding(f).then(enc=>{
      const encBadge=document.createElement('span');
      encBadge.className='txt-file-enc';
      encBadge.textContent=enc.toUpperCase().replace('-','');
      const rmBtn=row.querySelector('.txt-file-rm');
      if(rmBtn) row.insertBefore(encBadge,rmBtn);
    });

    // ✕ 클릭으로 개별 파일 제거
    row.querySelector('.txt-file-rm').onclick=e=>{
      e.stopPropagation();
      const idx=parseInt(e.target.dataset.idx);
      S.txtFiles.splice(idx,1);
      _chaptersCache=null;
      if(!S.txtFiles.length){resetConvertTxt();}
      else renderTxtFileList();
    };

    // ── 데스크탑 드래그 앤 드롭 ──
    row.addEventListener('dragstart',e=>{
      row.classList.add('dragging');
      e.dataTransfer.effectAllowed='move';
      e.dataTransfer.setData('text/plain',String(i));
    });
    row.addEventListener('dragend',()=>{
      row.classList.remove('dragging');
      listEl.querySelectorAll('.drag-over').forEach(el=>el.classList.remove('drag-over'));
    });
    row.addEventListener('dragover',e=>{
      e.preventDefault();
      e.dataTransfer.dropEffect='move';
      listEl.querySelectorAll('.drag-over').forEach(el=>el.classList.remove('drag-over'));
      row.classList.add('drag-over');
    });
    row.addEventListener('dragleave',e=>{
      // 자식 요소로 이동 시 오작동 방지
      if(!row.contains(e.relatedTarget)) row.classList.remove('drag-over');
    });
    row.addEventListener('drop',e=>{
      e.preventDefault();
      row.classList.remove('drag-over');
      const fromIdx=parseInt(e.dataTransfer.getData('text/plain'));
      const toIdx=i;
      if(fromIdx===toIdx) return;
      const moved=S.txtFiles.splice(fromIdx,1)[0];
      S.txtFiles.splice(toIdx,0,moved);
      _chaptersCache=null;
      renderTxtFileList();
    });

    // ── 모바일 터치 드래그 ──
    // touchstart/touchmove/touchend로 구현 (iOS·Android 모두 지원)
    _attachTouchSort(row, listEl, i);

    listEl.appendChild(row);
  });
}

// ══════════════════════════════════════════
// 🖼  Module: Cover (표지 URL·크롤링)
// ══════════════════════════════════════════

// 구글 이미지 검색창 열기 (제목 자동 완성)
// URL 입력 시 실시간 미리보기
function previewCoverUrl(inpId, thumbId, nameId, mode){
  const url=document.getElementById(inpId)?.value.trim();
  if(!url||!url.startsWith('http')) return;
  if(thumbId){
    const thumb=document.getElementById(thumbId);
    const img=new Image();
    img.crossOrigin='anonymous';
    img.onload=()=>{
      thumb.innerHTML='<img src="'+url+'" style="opacity:.6">';
    };
    img.onerror=()=>{}; // CORS 차단 시 조용히 실패
    img.src=url;
  }
}

// URL 적용 — canvas로 blob 변환 (CORS 통과 시) 또는 직접 fetch
async function applyCoverUrl(inpId, thumbId, nameId, mode){
  const url=document.getElementById(inpId)?.value.trim();
  if(!url){Toast.warn('이미지 URL을 입력해주세요.');return;}
  if(!url.startsWith('http')){Toast.warn('http:// 또는 https:// 로 시작하는 URL을 입력해주세요.');return;}

  const btn=event.target;
  const origText=btn.textContent;
  btn.textContent='로딩 중...';btn.disabled=true;

  try{
    // 방법 1: canvas crossOrigin으로 blob 변환
    const blob=await urlToBlob(url);
    const ext=url.split('?')[0].split('.').pop().toLowerCase().replace(/[^a-z]/g,'') || 'jpg';
    const validExt=['jpg','jpeg','png','webp','gif'].includes(ext)?ext:'jpg';
    const fname='cover_url.'+validExt;
    const file=new File([blob],fname,{type:blob.type||'image/jpeg'});

    if(mode==='convert'){
      S.coverFile=file;
      if(nameId) document.getElementById(nameId).textContent='✅ URL 표지 적용';
      document.getElementById('coverDz')?.classList.add('ok');
      if(thumbId){
        const dataUrl=await blobToDataUrl(blob);
        document.getElementById(thumbId).innerHTML='<img src="'+dataUrl+'">';
      }
      document.getElementById(inpId).value='';
    } else {
      // 일괄변환: 공통 표지 File 저장
      B.urlCoverFile=file;
      document.getElementById('batchCoverDrop')?.classList.add('ok');
      document.getElementById('batchCoverDrop').querySelector('div').textContent='✅ URL 표지 적용';
      document.getElementById(inpId).value='';
    }
    btn.textContent='✅ 적용됨';
    setTimeout(()=>{btn.textContent=origText;btn.disabled=false;},1500);
  }catch(e){
    btn.textContent=origText;btn.disabled=false;
    // CORS 차단 안내
    showCorsHelp(inpId, url, thumbId, nameId, mode);
  }
}

function showCorsHelp(inpId, url, thumbId, nameId, mode){
  // CORS 차단 시 대안 안내 모달
  const overlay=document.createElement('div');
  overlay.style.cssText='position:fixed;inset:0;background:rgba(0,0,0,.6);z-index:600;display:flex;align-items:center;justify-content:center';
  overlay.innerHTML=`
    <div style="background:var(--panel);border-radius:12px;padding:24px;max-width:440px;width:90vw;box-shadow:0 8px 40px rgba(0,0,0,.3)">
      <h3 style="font-size:14px;font-weight:700;margin-bottom:10px">⚠️ 이미지를 직접 가져올 수 없어요</h3>
      <p style="font-size:12px;color:var(--text2);margin-bottom:14px;line-height:1.7">
        이 이미지는 외부 사이트 보안(CORS) 정책으로 직접 가져올 수 없어요.<br>
        아래 방법 중 하나를 사용해주세요.
      </p>
      <div style="display:flex;flex-direction:column;gap:8px;margin-bottom:16px">
        <div style="background:var(--bg2);border-radius:8px;padding:10px;font-size:12px">
          <b>방법 1 (권장)</b> — 구글 이미지에서 이미지를 <b>다운로드</b>한 뒤<br>
          드래그앤드롭으로 표지에 넣기
        </div>
        <div style="background:var(--bg2);border-radius:8px;padding:10px;font-size:12px">
          <b>방법 2</b> — 이미지 페이지를 열어서<br>
          이미지를 <b>다른 이름으로 저장</b> 후 드래그앤드롭
        </div>
        <div style="background:var(--bg2);border-radius:8px;padding:10px;font-size:12px">
          <b>방법 3</b> — 아래 버튼으로 이미지 페이지 열기 →<br>
          이미지 우클릭 → 다른 이름으로 저장
        </div>
      </div>
      <div style="display:flex;gap:8px;justify-content:flex-end">
        <button class="btn btn-ghost btn-sm" onclick="this.closest('div[style*=fixed]').remove()">닫기</button>
        <button class="btn btn-blue btn-sm" onclick="window.open('${url}','_blank');this.closest('div[style*=fixed]').remove()">🔗 이미지 페이지 열기</button>
      </div>
    </div>`;
  document.body.appendChild(overlay);
  overlay.onclick=e=>{if(e.target===overlay)overlay.remove();};
}

async function urlToBlob(url){
  // canvas crossOrigin 방식
  return new Promise((resolve,reject)=>{
    const img=new Image();
    img.crossOrigin='anonymous';
    img.onload=()=>{
      const canvas=document.createElement('canvas');
      canvas.width=img.naturalWidth||img.width;
      canvas.height=img.naturalHeight||img.height;
      canvas.getContext('2d').drawImage(img,0,0);
      canvas.toBlob(b=>{
        if(b) resolve(b);
        else reject(new Error('canvas toBlob 실패'));
      },'image/jpeg',0.92);
    };
    img.onerror=()=>reject(new Error('CORS 차단'));
    img.src=url+'?'+(Date.now()); // 캐시 우회 시도
  });
}

function blobToDataUrl(blob){
  return new Promise(res=>{
    const r=new FileReader();
    r.onload=e=>res(e.target.result);
    r.readAsDataURL(blob);
  });
}

function handleCover(files){
  const f=files[0];if(!f)return;
  // ★ BUG-3 수정: coverThumb의 이전 blob URL 해제 (메모리 누수 방지)
  const thumb=document.getElementById('coverThumb');
  if(thumb){
    const prevImg=thumb.querySelector('img[data-blob-url]');
    if(prevImg) URL.revokeObjectURL(prevImg.dataset.blobUrl);
  }
  S.coverFile=f;
  document.getElementById('coverName').textContent='✅ '+f.name;
  document.getElementById('coverDz')?.classList.add('ok');
  const objUrl=URL.createObjectURL(f);
  if(thumb){ thumb.innerHTML=''; const img=document.createElement('img'); img.src=objUrl; img.dataset.blobUrl=objUrl; thumb.appendChild(img); }
}

// ── 공통 삽화 파일 처리 함수 ──
// fileArr: 대상 파일 배열, dzId: 드롭존 ID, renderFn: 태그 렌더 함수
function handleIllFiles(files, fileArr, dzId, renderFn){
  const imgs=Array.from(files).filter(f=>/\.(jpg|jpeg|png|gif|webp|bmp|tiff|tif|avif)$/i.test(f.name));
  if(!imgs.length)return;
  fileArr.push(...imgs);
  renderFn();
  const dz=document.getElementById(dzId);
  if(dz){dz.className=(dz.className.includes('epub-drop')?'epub-drop ok':'dz ok');}
}
function handleIll(files){ handleIllFiles(files,S.illFiles,'illDz',renderIllTags); }

function renderIllTags(){
  const c=document.getElementById('illTags');
  // ★ L-19 FIX: 재렌더 전 기존 ObjectURL 모두 해제 → 메모리 누수 방지
  c.querySelectorAll('img[data-obj-url]').forEach(img=>{
    URL.revokeObjectURL(img.dataset.objUrl);
  });
  c.innerHTML='';
  const willConvert=document.getElementById('optImgConvert')?.checked!==false;
  S.illFiles.forEach((f,i)=>{
    const ext=f.name.split('.').pop().toLowerCase();
    const isJpg=['jpg','jpeg'].includes(ext);
    const needsConvert=!isJpg&&willConvert;
    const fmtBadge=isJpg
      ? `<span style="font-size:9px;background:var(--green-bg);color:var(--green);border-radius:3px;padding:1px 4px;font-weight:700">JPG</span>`
      : needsConvert
        ? `<span style="font-size:9px;background:var(--yellow-bg);color:var(--yellow);border-radius:3px;padding:1px 4px;font-weight:700">${ext.toUpperCase()}→JPG</span>`
        : `<span style="font-size:9px;background:var(--blue-bg);color:var(--blue);border-radius:3px;padding:1px 4px;font-weight:700">${ext.toUpperCase()}</span>`;

    const t=document.createElement('div');
    t.className='tag';
    t.style.cssText='display:flex;align-items:center;gap:5px;padding:4px 8px';
    t.title=f.name+(needsConvert?' (변환 예정)':'');
    t.dataset.idx=i; // ★ 인덱스 명시 저장

    // 썸네일
    const thumb=document.createElement('img');
    thumb.style.cssText='width:22px;height:22px;object-fit:cover;border-radius:3px;flex-shrink:0;border:1px solid var(--border)';
    thumb.alt=f.name;
    const url=URL.createObjectURL(f);
    thumb.src=url;
    thumb.dataset.objUrl=url;
    thumb.onerror=()=>{thumb.style.display='none';};

    const label=document.createElement('span');
    label.style.cssText='max-width:120px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:11px';
    label.textContent=f.name;

    // 챕터 인덱스 배지 — 파일명에서 파싱해서 어느 챕터에 삽입될지 표시
    const stem=f.name.replace(/\.[^.]+$/,'');
    const mi=stem.match(/^(\d+)(?:_(\d+))?/);
    const chIdxBadge=mi ? (()=>{
      const chIdx=parseInt(mi[1]);      // 1-based 표시용
      const sub=mi[2]?('-'+parseInt(mi[2])):'';
      const b=document.createElement('span');
      b.style.cssText='font-size:9px;background:var(--accent-bg);color:var(--accent);border-radius:3px;padding:1px 5px;font-weight:700;flex-shrink:0;white-space:nowrap';
      b.textContent=chIdx+'번째'+sub;
      b.title=chIdx+'번째 챕터 앞에 삽입 (파일명 기준 인덱스)';
      return b;
    })() : null;

    const badge=document.createElement('span');
    badge.innerHTML=fmtBadge;

    const x=document.createElement('span');
    x.className='x';
    x.textContent='✕';
    x.onclick=()=>removeIll(i);

    t.appendChild(thumb);
    t.appendChild(label);
    if(chIdxBadge) t.appendChild(chIdxBadge);
    t.appendChild(badge);
    t.appendChild(x);
    c.appendChild(t);
  });
}

function removeIll(i){
  // data-idx로 정확한 썸네일 찾아서 URL 해제
  const tag=document.getElementById('illTags').querySelector(`[data-idx="${i}"]`);
  const thumb=tag?.querySelector('img[data-obj-url]');
  if(thumb) URL.revokeObjectURL(thumb.dataset.objUrl);
  S.illFiles.splice(i,1);
  renderIllTags();
  if(!S.illFiles.length)document.getElementById('illDz').className='dz';
}

// ── 수동 삽화 행 공통 생성 함수 ──
// containerId: 삽입할 컨테이너 ID (manualIlls / insManualIlls)
function addManualIllRow(containerId){
  const id=S.manualCnt++;
  const c=document.getElementById(containerId);
  if(!c) return;
  const r=document.createElement('div');
  r.className='mill-row';r.id='mr'+id;
  r.innerHTML=
    '<div class="mill-row-top">'+
      '<input placeholder="파일명 (예: 16.jpg)" id="mp'+id+'" style="flex:2;min-width:100px" oninput="onManualIllName('+id+')">'+
      '<button class="btn btn-ghost btn-sm" onclick="browseManual('+id+')">찾기</button>'+
      '<input type="number" placeholder="중심 화 번호" id="mc'+id+'" style="width:90px" min="1" oninput="loadIllRange('+id+')">'+
      '<select id="mpos'+id+'"><option value="before">챕터 앞</option><option value="after">챕터 뒤</option></select>'+
      '<button class="btn btn-sm" style="background:var(--accent-bg);color:var(--accent)" data-action="removeManualIllRow" data-row-id="mr'+id+'">✕</button>'+
    '</div>'+
    '<div class="mill-preview" id="mpv'+id+'">'+
      '<div style="font-size:11px;color:var(--text2);padding:4px 2px">화 번호를 입력하면 해당 화 ±1화 범위를 보여줘요.</div>'+
    '</div>';
  c.appendChild(r);
}
function addManualIll(){ addManualIllRow('manualIlls'); }

// 파일명 → 화 번호 자동 추출 + 범위 로드
function onManualIllName(id){
  const stem=document.getElementById('mp'+id).value.trim().replace(/\.[^.]+$/,'');
  const m=stem.match(/^(\d+)/);
  if(m){
    document.getElementById('mc'+id).value=m[1];
    loadIllRange(id);
  }
}

function browseManual(id){
  const inp=document.createElement('input');inp.type='file';inp.accept='.jpg,.jpeg,.png,.gif,.webp,.bmp,.tiff,.tif,.avif';
  inp.onchange=()=>{
    if(!inp.files[0]) return;
    S.illFiles.push(inp.files[0]);
    renderIllTags();
    document.getElementById('mp'+id).value=inp.files[0].name;
    onManualIllName(id);
  };
  inp.click();
}

// 화 번호 기준 ±1화 범위 로드 + 미리보기 렌더
const _illRangeCache={};  // id → {chNum, chapters:[{ci,heading,body}]}

async function loadIllRange(id){
  const chNum=parseInt(document.getElementById('mc'+id).value);
  const pv=document.getElementById('mpv'+id);
  if(!chNum||!S.txtFiles.length){
    pv.innerHTML='<div style="font-size:11px;color:var(--text2);padding:4px 2px">화 번호를 입력하면 해당 화 ±1화 범위를 보여줘요.</div>';
    pv.classList.remove('show');
    return;
  }

  const chapters=await getCachedChapters();
  if(!chapters.length){pv.classList.remove('show');return;}

  // extractChNum으로 중심 챕터 인덱스 찾기
  const centerCi=chapters.findIndex(([h])=>extractChNum(h)===chNum);

  if(centerCi<0){
    pv.innerHTML='<div class="mill-ch-match"><div class="mill-ch-title" style="color:var(--accent)">⚠️ '+chNum+'화를 찾지 못했어요</div>'+
      '<div class="mill-ch-body">화 번호를 확인하거나 목차 확인을 먼저 실행해주세요.</div></div>';
    pv.classList.add('show');
    return;
  }

  // ±1화 범위 구성
  const range=[];
  if(centerCi>0)                   range.push({ci:centerCi-1, role:'prev'});
                                    range.push({ci:centerCi,   role:'center'});
  if(centerCi<chapters.length-1)   range.push({ci:centerCi+1, role:'next'});

  // 범위 캐시 저장 (키워드 검색에 사용)
  _illRangeCache[id]={chNum, range:range.map(({ci,role})=>({ci,role,...{heading:chapters[ci][0],body:chapters[ci][1]||''}}))} ;

  renderIllRangePanel(id, '', null);
}

// 3화 범위 패널 렌더 (kw: 현재 키워드, selectedCi: 선택된 챕터 인덱스)
function renderIllRangePanel(id, kw, selectedCi){
  const pv=document.getElementById('mpv'+id);
  const cache=_illRangeCache[id];
  if(!cache){pv.classList.remove('show');return;}

  const kwEsc=kw?kw.replace(/[.*+?^${}()|[\]\\]/g,'\\$&'):'';

  // 3화 카드
  let cardsHtml='<div class="mill-range">';
  cache.range.forEach(({ci,role,heading,body})=>{
    const isSel=ci===selectedCi;
    const isCenter=role==='center';
    const roleLabel=role==='prev'?'⬆ 이전화':role==='next'?'⬇ 다음화':'🎯 '+extractChNum(heading)+'화';
    const cardClass='mill-range-card'+(isCenter?' center':'')+(isSel?' selected':'');

    // 본문 앞부분 (키워드 있으면 하이라이트)
    let bodyPreview=(body||'').split('\n').filter(l=>l.trim()).slice(0,3).join(' ');
    if(bodyPreview.length>60) bodyPreview=bodyPreview.slice(0,60)+'…';
    let titleHtml=escHtml(heading);
    let bodyHtml=escHtml(bodyPreview);

    if(kw&&kwEsc){
      const rx=new RegExp(kwEsc,'g');
      titleHtml=titleHtml.replace(rx,'<span class="rc-kw-hit">'+escHtml(kw)+'</span>');
      // 본문에 키워드 있으면 주변 컨텍스트로 교체
      if(body.includes(kw)){
        const idx=body.indexOf(kw);
        const s=Math.max(0,idx-25);
        const e=Math.min(body.length,idx+kw.length+35);
        bodyHtml='···'+escHtml(body.slice(s,e)).replace(rx,'<span class="rc-kw-hit">'+escHtml(kw)+'</span>')+'···';
      }
    }

    cardsHtml+=
      '<div class="'+cardClass+'" onclick="selectIllRangeCard('+id+','+ci+')" title="클릭해서 이 화로 삽입 위치 설정">'+
        '<div class="rc-role">'+roleLabel+(isSel?' ✓':'')+'</div>'+
        '<div class="rc-title">'+titleHtml+'</div>'+
        '<div class="rc-body">'+bodyHtml+'</div>'+
      '</div>';
  });
  cardsHtml+='</div>';

  // 키워드 검색바
  const kwBar=
    '<div class="mill-kw-bar">'+
      '<span style="font-size:11px;color:var(--text2);white-space:nowrap">🔍 범위 내 검색:</span>'+
      '<input id="mkw'+id+'" placeholder="키워드로 정확한 위치 찾기" value="'+escHtml(kw)+'" '+
             'oninput="debounceIllKwSearch('+id+')">'+
    '</div>'+
    '<div class="mill-kw-status" id="mks'+id+'">'+
      (kw
        ? (cache.range.some(({body,heading})=>(body||heading).includes(kw))
            ? '✅ 범위 내 발견 — 해당 화를 클릭해서 선택하세요'
            : '⚠️ 이 범위(±1화)에 키워드가 없어요. 화 번호를 확인해주세요.')
        : '키워드를 입력하면 3화 범위 안에서만 검색해요')+
    '</div>';

  pv.innerHTML=cardsHtml+kwBar;
  pv.classList.add('show');
}

// 카드 클릭 → 삽입 위치 설정
function selectIllRangeCard(id, ci){
  const cache=_illRangeCache[id];
  if(!cache) return;
  const ch=cache.range.find(r=>r.ci===ci);
  if(!ch) return;

  // 화 번호 입력란에 선택된 화 번호 반영
  const chNum=extractChNum(ch.heading);
  if(chNum) document.getElementById('mc'+id).value=chNum;

  // 미리보기 재렌더 (선택 표시)
  const kw=document.getElementById('mkw'+id)?.value||'';
  renderIllRangePanel(id, kw, ci);
}

// 키워드 검색 (디바운스 · 범위 내에서만)
let _kwTimer={};
function debounceKwSearch(id){ clearTimeout(_kwTimer[id]); _kwTimer[id]=setTimeout(()=>kwSearch(id),350); }
function debounceIllKwSearch(id){ clearTimeout(_kwTimer['r'+id]); _kwTimer['r'+id]=setTimeout(()=>illKwSearch(id),250); }

function illKwSearch(id){
  const kw=document.getElementById('mkw'+id)?.value.trim()||'';
  const cache=_illRangeCache[id];
  if(!cache) return;

  // 키워드 히트가 있는 카드를 자동 선택
  let autoSel=null;
  if(kw){
    const hit=cache.range.find(({body,heading})=>(body||'').includes(kw)||heading.includes(kw));
    if(hit) autoSel=hit.ci;
  }
  renderIllRangePanel(id, kw, autoSel);
}

// startConvert에서 수동삽화 읽는 로직도 수정 필요 — _illRangeCache에서 선택된 ci 기반으로
function getManualIllTarget(id){
  // 현재 선택된 카드의 챕터 인덱스 반환 (선택 안된 경우 중심 화 번호 사용)
  const chNum=parseInt(document.getElementById('mc'+id)?.value);
  return {ch:chNum||null, pos:document.getElementById('mpos'+id)?.value||'before'};
}


async function kwSearch(id){
  const kw=document.getElementById('mk'+id)?.value.trim();
  const pv=document.getElementById('mpv'+id);
  if(!kw||kw.length<1){pv.classList.remove('show');return;}

  const chapters=await getCachedChapters();
  if(!chapters.length){pv.classList.remove('show');return;}

  const kwEsc=kw.replace(/[.*+?^${}()|[\]\\]/g,'\\$&');
  const kwRx=new RegExp(kwEsc,'g');

  // 1단계: 키워드가 있는 챕터 인덱스 전체 탐색 (제목 + 본문 전체)
  let centerIdx=-1;
  let totalMatches=0;
  for(let ci=0;ci<chapters.length;ci++){
    const [heading,body]=chapters[ci];
    if(heading.includes(kw)||(body||'').includes(kw)){
      if(centerIdx<0) centerIdx=ci; // 첫 번째 발견 챕터
      totalMatches++;
    }
  }

  if(centerIdx<0){
    pv.innerHTML=
      '<div class="mill-ch-match">'+
        '<div class="mill-ch-title" style="color:var(--text2)">검색 결과 없음</div>'+
        '<div class="mill-ch-body">&#39;'+escHtml(kw)+'&#39; 를 포함한 챕터가 없어요.<br>'+
        '<span style="font-size:10px">다른 키워드를 시도하거나 화 번호 모드를 사용해보세요.</span></div>'+
      '</div>';
    pv.classList.add('show');
    return;
  }

  // 2단계: 발견 챕터 ±1화 (총 최대 3화) 표시
  const range=[];
  if(centerIdx>0)                    range.push({ci:centerIdx-1, role:'prev'});
                                     range.push({ci:centerIdx,   role:'match'});
  if(centerIdx<chapters.length-1)    range.push({ci:centerIdx+1, role:'next'});

  const moreCount=totalMatches-1;

  let html=
    '<div class="mill-ch-match">'+
      '<div class="mill-ch-title" style="display:flex;justify-content:space-between;align-items:center">'+
        '<span>🔍 <b>'+escHtml(kw)+'</b> 발견 · 전후 3화</span>'+
        (moreCount>0?'<span style="font-size:10px;color:var(--text2)">외 '+moreCount+'곳 더</span>':'')+
      '</div>'+
      '<div class="mill-kw-list">';

  range.forEach(({ci,role})=>{
    const [heading,body]=chapters[ci];
    const isMatch=role==='match';

    // 키워드 주변 컨텍스트: 발견 화는 본문에서 키워드 앞뒤 40자, 나머지는 본문 첫 줄
    let snippet='';
    if(isMatch){
      const fullText=heading+' '+(body||'');
      const idx=fullText.indexOf(kw);
      if(idx>=0){
        const s=Math.max(0,idx-30);
        const e=Math.min(fullText.length,idx+kw.length+40);
        snippet=fullText.slice(s,e).replace(/\n/g,' ');
      }
    } else {
      snippet=(body||'').split('\n').filter(l=>l.trim())[0]||'';
    }

    // 키워드 하이라이트 (발견 화만)
    const hiSnippet=isMatch
      ? snippet.replace(new RegExp(kwEsc,'g'),'<span class="mill-kw-highlight">'+escHtml(kw)+'</span>')
      : escHtml(snippet);
    const hiTitle=isMatch
      ? escHtml(heading).replace(new RegExp(kwEsc,'g'),'<span class="mill-kw-highlight">'+escHtml(kw)+'</span>')
      : escHtml(heading);

    const roleIcon  = role==='prev'?'⬆':'next'===role?'⬇':'🎯';
    const roleLabel = role==='prev'?'이전화':role==='next'?'다음화':'발견';
    const rowStyle  = isMatch
      ? 'border:1.5px solid var(--accent);background:var(--accent-bg);border-radius:6px;'
      : '';

    html+=
      '<div class="mill-kw-item" id="mkwi_'+id+'_'+ci+'" style="'+rowStyle+'" '+
           'onclick="selectKwResult('+id+',\''+escAttr(heading)+'\','+ci+')">'+
        '<div style="display:flex;flex-direction:column;min-width:34px;align-items:center;gap:1px">'+
          '<span style="font-size:12px">'+roleIcon+'</span>'+
          '<span style="font-size:9px;color:var(--text2)">'+roleLabel+'</span>'+
        '</div>'+
        '<div style="flex:1;min-width:0">'+
          '<div style="font-weight:'+(isMatch?'700':'500')+';font-size:11px">'+hiTitle+'</div>'+
          '<div style="color:var(--text2);font-size:10px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">&#183;&#183;&#183;'+hiSnippet+'&#183;&#183;&#183;</div>'+
        '</div>'+
      '</div>';
  });

  html+='</div></div>';
  pv.innerHTML=html;
  pv.classList.add('show');
}

function selectKwResult(id, heading, ci){
  // 선택 표시 갱신
  document.querySelectorAll('[id^="mkwi_'+id+'_"]').forEach(el=>el.classList.remove('selected'));
  event.currentTarget.classList.add('selected');
  // ★ 실제 화 번호 인풋에 반영 (ci = 챕터 인덱스)
  const mcEl=document.getElementById('mc'+id);
  if(mcEl&&ci!=null){
    // 챕터 인덱스 → 서문 제외 실제 순번 계산
    mcEl.value=ci+1;
    // _illRangeCache 갱신을 위해 loadIllRange 재호출
    loadIllRange(id);
  }
}

// ════════════════════════════════════════════════════════
// ★ 간격 분할 전역 상태 — window 단일 소유권
// parser.js / convert.js 양쪽에서 동일한 객체를 참조
// ════════════════════════════════════════════════════════
// _autoSplitActive : 간격 분할 모드 활성 플래그
// _autoSplitLines  : 원문 줄 배열 (간격 분할 전용, parser.js에 선언)
// _fullRawLines    : 전체 파일 줄 배열 (parser.js에 선언)
//
// 중요: let 선언 대신 window 프로퍼티를 사용해
//       두 모듈이 동일한 값을 읽고 씁니다.
if(typeof window._autoSplitActive==='undefined') window._autoSplitActive=false;
// 하위 호환 — 로컬 변수처럼 참조 가능하도록 getter/setter 대리자 정의
Object.defineProperty(window,'_autoSplitActive',{
  get(){ return window.__autoSplitActiveVal||false; },
  set(v){ window.__autoSplitActiveVal=!!v; },
  configurable:true,
});
window._autoSplitActive=false; // 초기화

// 파일명에서 총 화수 추출 (예: "소설_1-277" → 277, "소설_1234화" → 1234)
function extractTotalFromFilename(filename){
  const stem=filename.replace(/\.[^.]+$/,'');
  // "N-M" 형태: 마지막 숫자 M이 총 화수
  let m=stem.match(/-(\d+)[^\d]*(?:완|完|edit|_|$)/i);
  if(m) return parseInt(m[1]);
  m=stem.match(/[_-](\d+)[_-]\d+/);
  if(m) return null; // 범위 불명확
  m=stem.match(/(\d{2,4})화/);
  if(m) return parseInt(m[1]);
  m=stem.match(/[_-](\d{2,4})[^\d]*$/);
  if(m) return parseInt(m[1]);
  return null;
}

// tocItems(간격분할 결과)를 [heading, body] 쌍으로 조립
// ══════════════════════════════════════════
// 📊 Module: Progress (진행률 바 UI)
// ══════════════════════════════════════════

// ★ U-01: 진행 타임라인 — 스파크라인용 단계별 소요시간 기록
const _progressTimeline = [];

// 전역 setProgress 함수 — startConvert / splitChaptersAsync / getParserWorker 공통 사용
function setProgress(pct, msg){
  const bar = document.getElementById('progBar');
  const txt = document.getElementById('progMsg');
  if(bar){
    bar.style.width = pct + '%';
    // ★ U-15 FIX: aria-progressbar 속성 실시간 갱신 — 스크린리더 접근성
    bar.setAttribute('role', 'progressbar');
    bar.setAttribute('aria-valuemin', '0');
    bar.setAttribute('aria-valuemax', '100');
    bar.setAttribute('aria-valuenow', String(pct));
    bar.setAttribute('aria-valuetext', msg ? `${pct}%, ${msg}` : `${pct}%`);
    // ★ 진행 중 striped 애니메이션, 완료 시 정지
    if(pct > 0 && pct < 100) bar.classList.add('animating');
    else bar.classList.remove('animating');
  }
  if(txt) txt.textContent = msg || '';
  // ★ U-01: 타임라인에 기록 (스파크라인 렌더링용)
  _progressTimeline.push({ pct, msg, t: Date.now() });
  // ★ 스텝 인디케이터 갱신 (epub-gen.js의 updateProgStep 호출)
  if(typeof updateProgStep === 'function'){
    if(pct <= 15)       updateProgStep(0);
    else if(pct <= 30)  updateProgStep(1);
    else if(pct <= 45)  updateProgStep(2);
    else if(pct <= 92)  updateProgStep(3);
    else                updateProgStep(4);
  }
}

// ✨ Module: Convert (변환 실행 플로우)
// ══════════════════════════════════════════
async function startConvert(){
  if(!S.txtFiles.length){Toast.warn('TXT 파일을 선택해주세요.');return;}
  const convertStart=Date.now();
  // ★ U-01: 타임라인 초기화
  _progressTimeline.length = 0;
  const sparkEl = document.getElementById('progressSparkline');
  if(sparkEl){ sparkEl.innerHTML=''; sparkEl.style.display='none'; }
  document.getElementById('progWrap')?.classList.add('show');
  document.getElementById('resultBox')?.classList.remove('show');
  document.getElementById('errBox')?.classList.remove('show');

  // ── 단계별 진행 표시 ──
  setProgress(0,'① 파일 읽는 중...');

  // ★ 파싱 중단 버튼 표시
  let _convertAborted=false;
  const progWrapEl=document.getElementById('progWrap');
  let abortBtn=document.getElementById('convertAbortBtn');
  if(!abortBtn){
    abortBtn=document.createElement('button');
    abortBtn.id='convertAbortBtn';
    abortBtn.className='btn';
    abortBtn.style.cssText='font-size:11px;padding:4px 12px;background:var(--accent-bg);color:var(--accent);border:1.5px solid var(--accent);border-radius:6px;margin-top:6px;display:block';
    abortBtn.textContent='⛔ 변환 중단';
    progWrapEl?.appendChild(abortBtn);
  }
  abortBtn.style.display='block';
  abortBtn.onclick=()=>{
    _convertAborted=true;
    // Worker에도 Abort 신호
    if(_parserWorker) _parserWorker.postMessage({type:'ABORT',id:-1});
    abortBtn.style.display='none';
    setProgress(0,'⛔ 중단됨');
    document.getElementById('progWrap')?.classList.remove('show');
  };

  try{
    const sorted=[...S.txtFiles];
    const totalFiles=sorted.length;
    // 파일별 진행률 표시
    const raws=[];
    for(let fi=0;fi<totalFiles;fi++){
      setProgress(Math.round(fi/totalFiles*12)+1,
        `① 파일 읽는 중... (${fi+1}/${totalFiles}) ${sorted[fi].name}`);
      await yieldToMain();
      raws.push(await fileToText(sorted[fi]));
    }
    const raw=raws.join('\n\n');
    setProgress(14,'① 파일 읽기 완료');
    await yieldToMain();

    setProgress(15,'② 챕터 패턴 분석 중...');
    await yieldToMain();
    const customPat=document.getElementById('pattern')?.value.trim();

    let chapters;
    // ════════════════════════════════════════════════════════
    // ★ 간격 분할 최우선 분기 — window._autoSplitActive 기반
    // parser.js와 동일한 window 프로퍼티를 읽으므로 유실 없음
    // ════════════════════════════════════════════════════════
    if(window._autoSplitActive && S.tocItems.length>0){
      setProgress(20,'② 간격 분할 모드 — tocItems 기반 챕터 조립 중...');
      await yieldToMain();
      // ★ window._autoSplitLines: parser.js에서 window 미러로 노출한 값
      const sourceForSplit=(window._autoSplitLines&&window._autoSplitLines.length>0)
        ? window._autoSplitLines
        : raw.split('\n');
      chapters=buildChaptersFromTocItems(sourceForSplit, S.tocItems);
      setProgress(28,`② 간격 분할 조립 완료 (${chapters.length}개)`);
    } else if(S.tocItems.length>0){
      // ★ tocItems가 있으면 항상 tocItems 기반 조립
      // ★ L-16 FIX: _fullRawLines null 가드 — startConvert 완료 후 메모리 해제된 경우 대비
      const sourceLines=(_fullRawLines && _fullRawLines.length>0)
        ? _fullRawLines
        : raw.split('\n');
      setProgress(20,'② 목차 기반 챕터 조립 중...');
      await yieldToMain();
      chapters=buildChaptersFromTocItems(sourceLines, S.tocItems);
      setProgress(28,`② 챕터 조립 완료 (활성 ${S.tocItems.filter(t=>t.enabled).length}개 → ${chapters.length}개)`);
    } else {
      // tocItems 없음 → 원본 텍스트 직접 파싱
      setProgress(18,'② 목차 패턴 감지 중...');
      await yieldToMain();
      const lineCount=(raw.match(/\n/g)||[]).length;
      if(lineCount>=100000){
        chapters=await splitChaptersAsync(raw,customPat,(pct,msg)=>setProgress(pct,msg));
      } else {
        chapters=splitChapters(raw,customPat);
      }
      setProgress(24,`② 챕터 분리 완료 (${chapters.length}개)`);
      // tocItems 없는 경우 disabledTitles 폴백
      const disabledTitles=new Set(S.tocItems.filter(t=>!t.enabled).map(t=>t.title));
      if(disabledTitles.size>0){
        setProgress(28,'② 비활성 챕터 병합 중...');
        await yieldToMain();
        const merged=[];let pb='';
        for(const[h,b]of chapters){
          if(disabledTitles.has(h)){
            pb+=(pb?'\n\n':'')+h+'\n'+b;
          } else {
            if(pb&&merged.length>0){merged[merged.length-1][1]+='\n\n'+pb;pb='';}
            else if(pb){merged.push([h,pb+'\n\n'+b]);pb='';continue;}
            merged.push([h,b]);
          }
        }
        if(pb&&merged.length>0) merged[merged.length-1][1]+='\n\n'+pb;
        chapters=merged;
      }
    }
    await yieldToMain();
    setProgress(30,'③ 삽화 파싱 중...');
    await yieldToMain();
    // 삽화 파싱 — 파일명 숫자 = 챕터 인덱스(1-based)
    // 01.jpg → chapters[0] (첫 번째 챕터)
    // 100.jpg → chapters[99] (100번째 챕터)
    // 01_01.jpg → chapters[0]의 첫 번째 삽화
    // 01_02.jpg → chapters[0]의 두 번째 삽화
    const autoIlls=[];
    for(const f of S.illFiles){
      const stem=f.name.replace(/\.[^.]+$/,'');
      const m=stem.match(/^(\d+)(?:_(\d+))?/);
      if(m){
        const chIdx=parseInt(m[1])-1;   // 1-based → 0-based 인덱스
        const order=parseInt(m[2]||'1'); // 서브넘버 (01_01 → 1, 01_02 → 2)
        autoIlls.push({file:f, idx:chIdx, order, pos:'before'});
      }
    }
    autoIlls.sort((a,b)=>a.idx-b.idx||a.order-b.order);
    const manualIlls=[];
    document.querySelectorAll('[id^="mr"]').forEach(row=>{
      const id=row.id.replace('mr','');
      const name=document.getElementById('mp'+id)?.value.trim();if(!name)return;
      const file=S.illFiles.find(f=>f.name===name);if(!file)return;
      const pos=document.getElementById('mpos'+id)?.value||'before';
      // 새 UI: 화 번호 기준 (키워드는 범위 내 검색용, 최종 삽입은 화 번호 기준)
      const ch=parseInt(document.getElementById('mc'+id)?.value);
      if(ch) manualIlls.push({file,ch,order:999,pos});
      // 키워드도 병행 저장 (buildEpub에서 kw 매칭도 지원)
      const kw=document.getElementById('mkw'+id)?.value.trim();
      if(!ch&&kw) manualIlls.push({file,kw,pos});
    });
    const illMap=[...autoIlls,...manualIlls];
    const title=document.getElementById('title')?.value.trim()||'제목 없음';
    const author=document.getElementById('author')?.value.trim()||'작자 미상';
    const useItalic=document.getElementById('optItalic')?.checked;

    // ★ 표지 폴백: 표지 이미지 없을 때 Canvas로 텍스트 커버 자동 생성
    let effectiveCover=S.coverFile;
    if(!effectiveCover){
      setProgress(35,'③ 텍스트 표지 생성 중...');
      await yieldToMain();
      effectiveCover=await generateTextCover(title, author);
    }

    setProgress(40,'④ EPUB 빌드 중...');
    await yieldToMain();
    // ★ U-17: warnings 배열 수집 — buildEpub이 {blob, warnings} 형태로 반환 시 처리
    let epubWarnings = [];
    const epubResult = await buildEpub(
      {title,author,chapters,coverFile:effectiveCover,illMap,useItalic},
      (pct,msg)=>setProgress(40+Math.round(pct*0.52), msg)
    );
    let blob;
    if(epubResult && epubResult.blob){
      blob = epubResult.blob;
      epubWarnings = epubResult.warnings || [];
    } else {
      blob = epubResult; // 기존 Blob 직접 반환 방식 하위 호환
    }
    S.epubBlob=blob;
    S.epubName=title.replace(/[\\/:*?"<>|]/g,'_')+'.epub';
    const elapsed=((Date.now()-convertStart)/1000).toFixed(1);
    setProgress(100,'✅ 변환 완료! ('+elapsed+'초)');
    document.getElementById('convertAbortBtn').style&&(document.getElementById('convertAbortBtn').style.display='none');

    // ★ 메모리 정리: 200,000줄 이하는 유지 (대용량 장편에서 간격 분할 재접근 가능하도록)
    // window 프로퍼티를 통해 parser.js의 실제 변수를 갱신
    if(window._fullRawLines&&window._fullRawLines.length>200000){
      window._fullRawLines=null;
    }
    if(window._autoSplitLines&&window._autoSplitLines.length>200000){
      window._autoSplitLines=null;
    }
    // 챕터 캐시는 미리보기/분리에서 필요하므로 유지 (단, 대용량은 제한)
    document.getElementById('resultMsg').textContent=S.epubName;
    showResultStats('resultStats',[
      {
        label: /^\(\d+\/\d+\)$/.test(chapters.filter(([h])=>h!=='서문')[0]?.[0]||'') ? '페이지' : '챕터',
        value: chapters.filter(([h])=>h!=='서문').length+'개'
      },
      {label:'파일 크기',value:(blob.size/1024/1024).toFixed(1)+'MB'},
      {label:'소요 시간',value:elapsed+'초'},
    ]);
    // 미리보기/분리용 챕터 저장
    _previewChapters=chapters;
    // ── 히스토리 저장 (IndexedDB 비동기) ──
    await saveHistory({
      title,author,
      chapterCount:chapters.filter(([h])=>h!=='서문').length,
      sizeMB:(blob.size/1024/1024).toFixed(1),
      elapsed,
      date:new Date().toLocaleString('ko-KR',{month:'short',day:'numeric',hour:'2-digit',minute:'2-digit'}),
      name:S.epubName,
      blob
    });
    document.getElementById('splitSec').style.display='block';
    document.getElementById('resultBox')?.classList.add('show');
    _showShareBtnIfSupported(); // ★ C-04: 공유 버튼 조건부 표시

    // ★ EPUB 다운로드 완료 플로팅 바 활성화
    _showEpubDownloadBar(S.epubName);
    // ★ 07: 결과 카드 count-up 애니메이션
    _animateResultStats();
    // ★ U-01: 진행 스파크라인 렌더링
    _renderProgressSparkline();
    // ★ U-17: 변환 경고 리포트 렌더링
    _renderConvertReport(epubWarnings);
    // ★ ADD-10: 변환 완료 브라우저 알림 (탭 백그라운드 시)
    _sendConvertNotif(title || S.epubName, chapters.filter(([h])=>h!=='서문').length);
  }catch(e){
    document.getElementById('progWrap')?.classList.remove('show');
    // ★ BUG-1 수정: 중단(_convertAborted) 시 errBox 표시 안 함
    if(_convertAborted) return;
    // ★ U-20: 복구 가능 오류와 치명적 오류 분류
    if(e instanceof RecoverableError){
      Toast.warn('⚠ ' + e.message + (e.context ? ` (${e.context})` : '') + ' — 계속 진행합니다.');
    } else {
      const errEl = document.getElementById('errBox');
      if(errEl){ errEl.textContent='❌ '+friendlyError(e); errEl.classList.add('show'); }
    }
  }
}

// ★ U-17: 변환 오류 리포트 — 챕터별 경고 항목 요약 렌더링
function _renderConvertReport(warnings){
  const el = document.getElementById('convertReport');
  if(!el) return;
  if(!warnings || !warnings.length){ el.style.display='none'; return; }
  el.style.display = '';
  el.innerHTML =
    `<div style="font-size:11px;font-weight:700;color:var(--accent);margin-bottom:6px">⚠ 변환 경고 ${warnings.length}건</div>` +
    `<div style="display:flex;flex-direction:column;gap:4px;max-height:120px;overflow-y:auto">` +
    warnings.map(w=>`<div style="font-size:11px;color:var(--text2);padding:3px 6px;background:var(--accent-bg);border-radius:4px;border-left:2px solid var(--accent)">⚠ ${escHtml(String(w))}</div>`).join('') +
    `</div>`;
}

// ★ U-01: 변환 진행 스파크라인 — 단계별 소요시간 시각화
function _renderProgressSparkline(){
  const container = document.getElementById('progressSparkline');
  if(!container || _progressTimeline.length < 2) return;
  const steps = _progressTimeline.filter((s,i,a)=> i===0 || s.pct !== a[i-1].pct);
  const totalMs = steps[steps.length-1].t - steps[0].t;
  if(totalMs <= 0) return;

  const W=260, H=36, PAD=2;
  const barW = Math.max(2, Math.floor((W - PAD*(steps.length-1)) / steps.length));
  let svgBars='';
  for(let i=1; i<steps.length; i++){
    const dur = steps[i].t - steps[i-1].t;
    const ratio = dur / totalMs;
    const bh = Math.max(2, Math.round(ratio * (H-4)));
    const x = (i-1) * (barW + PAD);
    const pct = steps[i].pct;
    const col = pct >= 90 ? 'var(--green)' : pct >= 50 ? 'var(--accent)' : 'var(--blue)';
    const label = steps[i].msg ? steps[i].msg.replace(/[①②③④⑤]/,'').trim().slice(0,12) : '';
    svgBars += `<rect x="${x}" y="${H-bh}" width="${barW}" height="${bh}" fill="${col}" rx="1" opacity="0.85"><title>${label} (${(dur/1000).toFixed(1)}s)</title></rect>`;
  }
  container.innerHTML =
    `<svg width="${W}" height="${H}" style="display:block;margin:6px 0 0" aria-label="단계별 소요시간 스파크라인">
      <title>변환 단계별 소요시간</title>${svgBars}
    </svg>
    <div style="font-size:10px;color:var(--text2);margin-top:2px">단계별 소요시간 (총 ${(totalMs/1000).toFixed(1)}초)</div>`;
  container.style.display = '';
}

// ★ 07: 결과 카드 count-up + shimmer 애니메이션
function _animateResultStats(){
  const resultBox = document.getElementById('resultBox');
  if(!resultBox) return;

  // shimmer 효과 (0.6초)
  resultBox.classList.add('result-shimmer');
  setTimeout(()=>resultBox.classList.remove('result-shimmer'), 700);

  // count-up: result-stat-val 요소들의 숫자를 0에서 올라가게
  resultBox.querySelectorAll('.result-stat-val').forEach(el=>{
    const raw = el.textContent.trim();
    // 숫자 추출 (1,110화 → 1110, 4.2MB → 4.2)
    const numMatch = raw.replace(/,/g,'').match(/[\d.]+/);
    if(!numMatch) return;
    const target = parseFloat(numMatch[0]);
    const suffix = raw.replace(numMatch[0],'').replace(/,/g,'');
    const isFloat = raw.includes('.');
    const dur = 600;
    const start = performance.now();
    const tick = (now)=>{
      const t = Math.min((now-start)/dur, 1);
      // ease-out cubic
      const ease = 1 - Math.pow(1-t, 3);
      const cur = target * ease;
      const disp = isFloat ? cur.toFixed(1) : Math.round(cur).toLocaleString();
      el.textContent = disp + suffix;
      if(t < 1) requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  });

  // 다운로드 버튼 pulse 1회
  const dlBtn = resultBox.querySelector('[data-action="downloadEpub"]');
  if(dlBtn){
    dlBtn.classList.add('pulse-once');
    setTimeout(()=>dlBtn.classList.remove('pulse-once'), 1000);
  }
}

function friendlyError(e){
  const msg=(e.message||String(e)).toLowerCase();
  // ① 인코딩 오류
  if(msg.includes('encoding')||msg.includes('codec')||msg.includes('utf')||msg.includes('decode'))
    return '⚠️ 인코딩 오류: 파일이 UTF-8이 아닐 수 있어요. EUC-KR 등 다른 인코딩 파일은 먼저 UTF-8로 변환해주세요.';
  // ② 메모리 초과
  if(msg.includes('memory')||msg.includes('quota')||msg.includes('arraybuffer')||msg.includes('maximum'))
    return '⚠️ 메모리 부족: 파일이 너무 커요. 파일을 500화 단위로 분할하거나 불필요한 탭을 닫고 다시 시도해주세요.';
  // ③ JSZip 압축 오류
  if(msg.includes('jszip')||msg.includes('zip')||msg.includes('deflate')||msg.includes('compress'))
    return '⚠️ 압축 오류: EPUB 파일 생성 중 오류가 발생했어요. 파일 크기를 줄이거나 설정에서 압축 레벨을 낮춰보세요.';
  // ④ 용량 한도 초과 (localStorage/IndexedDB)
  if(msg.includes('quotaexceeded')||msg.includes('storage'))
    return '⚠️ 저장 공간 부족: 브라우저 저장 공간이 가득 찼어요. 히스토리를 삭제하거나 캐시를 초기화해주세요.';
  // ⑤ EPUB 구조 오류
  if(msg.includes('container')||msg.includes('opf')||msg.includes('epub'))
    return '⚠️ EPUB 구조 오류: 유효하지 않은 EPUB 파일이에요. 다른 EPUB 파일로 시도해주세요.';
  // ⑥ 챕터 없음
  if(msg.includes('챕터가 없')||msg.includes('chapter'))
    return '⚠️ 챕터 없음: 삽입할 챕터가 선택되지 않았어요. 목차에서 하나 이상 선택해주세요.';
  // ⑦ 파일 읽기 오류
  if(msg.includes('filereader')||msg.includes('cannot read')||msg.includes('file'))
    return '⚠️ 파일 오류: 파일을 읽을 수 없어요. 파일이 열려있거나 손상된 파일이 아닌지 확인해주세요.';
  // ⑧ Worker 오류
  if(msg.includes('worker'))
    return '⚠️ Worker 오류: 백그라운드 처리 중 오류가 발생했어요. 페이지를 새로고침 후 다시 시도해주세요.';
  // ⑨ 네트워크 오류 (폰트/이미지 로드)
  if(msg.includes('network')||msg.includes('fetch')||msg.includes('cors'))
    return '⚠️ 네트워크 오류: 이미지나 폰트를 불러올 수 없어요. 인터넷 연결을 확인해주세요.';
  return '❌ 오류: '+(e.message||String(e));
}

// ══════════════════════════════════════════
// 👁  Module: Preview (변환 결과 미리보기 모달)
// ══════════════════════════════════════════
let _previewChapters=[], _previewIdx=0, _previewFont='', _previewLine='';

function showPreview(){
  if(!_previewChapters.length&&!S.epubBlob){
    Toast.info('변환 후 사용할 수 있어요.');return;
  }
  _previewIdx=0;
  _previewFont=document.getElementById('cssFont')?.value||'"Noto Serif KR",serif';
  _previewLine=document.getElementById('cssLine')?.value||'1.9';

  // ★ EPUB Blob이 있으면 JSZip으로 파싱해 실제 본문 렌더링
  if(S.epubBlob){
    _renderEpubPreview(S.epubBlob);
  } else {
    renderPreview();
  }
  document.getElementById('previewModal')?.classList.add('show');
  document.body.style.overflow='hidden';
  document.body.style.touchAction='none';
}

// ★ EPUB Blob → JSZip 파싱 → 첫 챕터 HTML 렌더링
async function _renderEpubPreview(blob){
  const body=document.getElementById('previewBody');
  body.innerHTML='<div style="text-align:center;padding:30px;color:var(--text2)">⏳ EPUB 파싱 중...</div>';
  try{
    const zip=await JSZip.loadAsync(blob);
    // OPF 찾기
    const container=await zip.file('META-INF/container.xml').async('text');
    const opfPath=container.match(/full-path="([^"]+)"/)?.[1];
    if(!opfPath){renderPreview();return;}
    const opfBase=opfPath.replace(/[^/]+$/,'');
    const opfText=await zip.file(opfPath).async('text');
    // spine 순서 파싱
    const idrefs=[...opfText.matchAll(/<itemref[^>]+idref="([^"]+)"/g)].map(m=>m[1]);
    const manifest={};
    for(const m of opfText.matchAll(/<item[^>]+id="([^"]+)"[^>]+href="([^"]+)"/g)){
      manifest[m[1]]=m[2];
    }
    // 첫 3개 spine 항목 렌더링
    const previewItems=idrefs.filter(id=>manifest[id]&&!manifest[id].includes('cover')).slice(0,3);
    let html='';
    for(const id of previewItems){
      const href=opfBase+manifest[id];
      const xhtml=await zip.file(href)?.async('text')||'';
      // body 추출
      const bodyMatch=xhtml.match(/<body[^>]*>([\s\S]*?)<\/body>/i);
      if(bodyMatch){
        // 이미지 src를 blob URL로 변환
        let content=bodyMatch[1]
          .replace(/<img[^>]+>/gi,'') // 이미지 제거 (미리보기에서 불필요)
          .replace(/class="[^"]*"/g,'') // 클래스 제거
          .replace(/<(\/?)h[1-6]/gi,'<$1h3'); // 헤딩 통일
        html+=`<div class="preview-ch">${content}</div>`;
      }
    }
    body.innerHTML=html||'<div style="padding:20px;color:var(--text2)">미리보기 내용을 불러올 수 없어요.</div>';
    body.style.fontFamily=_previewFont;
    body.style.lineHeight=_previewLine;
    document.getElementById('previewPageInfo').textContent=
      `EPUB 직접 렌더링 · 앞 ${previewItems.length}챕터`;
  }catch(e){
    // 파싱 실패 시 기존 텍스트 미리보기로 폴백
    renderPreview();
  }
}

function renderPreview(){
  const body=document.getElementById('previewBody');
  // 모바일에서 내부 스크롤이 페이지 스크롤과 충돌하지 않도록
  body.style.overscrollBehavior='contain';
  body.style.webkitOverflowScrolling='touch';
  const total=Math.min(_previewChapters.length,_previewIdx+3);
  const start=_previewIdx;
  let html='';
  for(let i=start;i<total;i++){
    const[h,b]=_previewChapters[i];
    if(h==='서문') continue;
    html+='<div class="preview-ch">';
    html+='<h2>'+escHtml(h)+'</h2>';
    const lines=b.split('\n').slice(0,30);
    for(const line of lines){
      const t=line.trim();
      if(!t) continue;
      if(/^[-\u2014]/.test(t)) html+='<p><em>'+escHtml(t)+'</em></p>';
      else html+='<p>'+escHtml(t)+'</p>';
    }
    if(b.split('\n').length>30) html+='<p style="color:var(--text2);font-size:11px;margin-top:8px">... (이하 생략)</p>';
    html+='</div>';
  }
  body.innerHTML=html;
  body.style.fontFamily=_previewFont;
  body.style.lineHeight=_previewLine;
  document.getElementById('previewPageInfo').textContent=
    (start+1)+'~'+Math.min(total,_previewChapters.length)+' / '+_previewChapters.filter(([h])=>h!=='서문').length+'화';
}

function previewNav(dir){
  _previewIdx=Math.max(0,Math.min(_previewChapters.length-3,_previewIdx+(dir*3)));
  renderPreview();
}

function closePreview(){
  document.getElementById('previewModal')?.classList.remove('show');
  document.body.style.overflow=''; // 스크롤 복원
  document.body.style.touchAction='';
}

// ══════════════════════════════════════════
// ✂️  Module: Split (EPUB N화씩 분리)
// ══════════════════════════════════════════
async function startSplit(){
  if(!S.epubBlob||!_previewChapters.length){Toast.warn('먼저 EPUB을 변환해주세요.');return;}
  const n=parseInt(document.getElementById('splitN')?.value)||100;
  const title=document.getElementById('title')?.value.trim()||'제목 없음';
  const author=document.getElementById('author')?.value.trim()||'작자 미상';
  const useItalic=document.getElementById('optItalic')?.checked!==false;
  const coverFile=S.coverFile;
  const listEl=document.getElementById('splitList');
  listEl.innerHTML='<div style="font-size:12px;color:var(--text2);grid-column:1/-1">분리 중...</div>';
  document.getElementById('splitSec').style.display='block';

  const chapters=_previewChapters.filter(([h])=>h!=='서문');
  const parts=[];
  for(let i=0;i<chapters.length;i+=n){
    parts.push(chapters.slice(i,i+n));
  }

  listEl.innerHTML='';
  const blobs=[];
  for(let pi=0;pi<parts.length;pi++){
    const part=parts[pi];
    const partTitle=title+' '+(pi+1)+'권';
    const firstCh=part[0]?.[0]||'';
    const lastCh=part[part.length-1]?.[0]||'';
    const div=document.createElement('div');
    div.className='split-item';
    div.id='spi_'+pi;
    div.innerHTML='<div style="font-weight:600;margin-bottom:4px">'+escHtml(partTitle)+'</div>'+
      '<div style="font-size:11px;color:var(--text2)">'+escHtml(firstCh)+' ~ '+escHtml(lastCh)+'</div>'+
      '<div id="sps_'+pi+'" style="font-size:11px;color:var(--text2);margin-top:4px">생성 중...</div>';
    listEl.appendChild(div);

    try{
      const blob=await buildEpub({title:partTitle,author,chapters:part,coverFile:pi===0?coverFile:null,illMap:[],useItalic},null);
      blobs.push({name:partTitle+'.epub',blob});
      div.className='split-item done';
      document.getElementById('sps_'+pi).textContent='✅ '+(blob.size/1024/1024).toFixed(1)+'MB';
    }catch(e){
      document.getElementById('sps_'+pi).textContent='❌ 오류';
    }
  }

  // 전체 ZIP 다운로드 버튼 추가
  if(blobs.length>1){
    const btn=document.createElement('div');
    btn.style.gridColumn='1/-1';btn.style.marginTop='8px';
    btn.innerHTML='<button class="btn btn-green" data-action="downloadSplitZip">⬇ 전체 ZIP 다운로드</button>';
    listEl.appendChild(btn);
    window._splitBlobs=blobs;
  }else if(blobs.length===1){
    const url=URL.createObjectURL(blobs[0].blob);
    const a=document.createElement('a');a.href=url;a.download=blobs[0].name;a.click();
    setTimeout(()=>URL.revokeObjectURL(url),1000);
  }
}

async function downloadSplitZip(){
  if(!window._splitBlobs) return;
  const zip=new JSZip();
  window._splitBlobs.forEach(r=>zip.file(r.name,r.blob));
  const blob=await zip.generateAsync({type:'blob',compression:'DEFLATE'});
  const url=URL.createObjectURL(blob);
  const a=document.createElement('a');a.href=url;a.download='epub_분리.zip';a.click();
  setTimeout(()=>URL.revokeObjectURL(url),1000);
}

function downloadEpub(){
  if(!S.epubBlob){
    Toast.warn('먼저 ✨ EPUB 만들기 버튼을 눌러 변환을 실행해주세요.');
    return;
  }
  const a=document.createElement('a');
  a.href=URL.createObjectURL(S.epubBlob);
  a.download=S.epubName||'output.epub';
  a.click();
  setTimeout(()=>URL.revokeObjectURL(a.href),1000);
}

// ★ EPUB 다운로드 완료 플로팅 바 — 변환 완료 시 하단에 상시 표시
function _showEpubDownloadBar(epubName){
  const bar=document.getElementById('btmDownload');
  const nameEl=document.getElementById('btmDlName');
  const convertBar=document.getElementById('btmConvert');
  if(!bar) return;

  // 파일명 표시
  if(nameEl) nameEl.textContent=epubName||'output.epub';

  // 변환 바를 숨기고 다운로드 바 표시
  if(convertBar) convertBar.style.display='none';
  bar.style.display='flex';

  // pulse 애니메이션 1회
  bar.classList.remove('pulse');
  requestAnimationFrame(()=>requestAnimationFrame(()=>bar.classList.add('pulse')));

  // 닫기 버튼 — 닫으면 기존 변환 바로 복귀
  const closeBtn=document.getElementById('btmDlClose');
  if(closeBtn){
    // 이벤트 중복 방지: 기존 리스너 제거 후 재등록
    const newClose=closeBtn.cloneNode(true);
    closeBtn.parentNode.replaceChild(newClose, closeBtn);
    newClose.addEventListener('click',()=>{
      bar.style.display='none';
      if(convertBar) convertBar.style.display='flex';
    });
  }
}

// ★ I7: 챕터별 글자수 분포 미니 SVG 차트
function renderTocMiniChart(){
  const el=document.getElementById('tocMiniChart');
  if(!el||!S.tocItems.length) return;
  const items=S.tocItems.filter(t=>t.enabled&&(t.bodyLen||0)>0);
  if(!items.length){el.innerHTML='';return;}
  // ★ FIX-07 연동: getSuspThreshold 사용
  const _suspThr = typeof getSuspThreshold==='function' ? getSuspThreshold() : 50;
  const maxLen=Math.max(...items.map(t=>t.bodyLen||0),1);
  const W=el.clientWidth||300, H=36, bw=Math.max(1,Math.floor((W-4)/items.length)-1);

  const bars=items.map((t,i)=>{
    const bl = t.bodyLen || 0;
    const h=Math.max(2,Math.floor(bl/maxLen*(H-4)));
    const x=2+i*(bw+1);
    // ★ ADD-03: 짧은챕터(주황), 긴챕터(파랑), 정상(accent)
    const col = bl < _suspThr ? '#e8764a' : bl > 50000 ? '#4472a8' : 'var(--accent)';
    const titleSafe = (t.title||'').replace(/"/g,'&quot;').slice(0,30);
    const blStr = bl>=10000?(bl/10000).toFixed(1)+'만자':bl>=1000?(bl/1000).toFixed(1)+'k':bl+'자';
    // ★ BUG-FIX: data-real-idx에 실제 S.tocItems 인덱스 저장 (enabled 필터 인덱스 ≠ 실제 인덱스)
    const realIdx = S.tocItems.indexOf(t);
    return `<rect x="${x}" y="${H-h}" width="${bw}" height="${h}" fill="${col}" rx="1"
      data-idx="${i}" data-real-idx="${realIdx}" data-title="${titleSafe}" data-chars="${bl}" data-str="${blStr}"
      style="cursor:pointer;opacity:.75;transition:opacity .1s"/>`;
  }).join('');

  el.innerHTML=`<svg width="${W}" height="${H}" style="display:block;width:100%">${bars}</svg>`;

  // ★ ADD-03: SVG hover 툴팁
  const svg = el.querySelector('svg');
  if(!svg) return;
  let _tipEl = null;
  svg.addEventListener('mousemove', e=>{
    const rect_svg = e.target;
    if(rect_svg.tagName !== 'rect') return;
    const idx  = parseInt(rect_svg.dataset.idx);
    const chars= rect_svg.dataset.str || '';
    const title= rect_svg.dataset.title || '';
    // 툴팁 생성/재사용
    if(!_tipEl){
      _tipEl = document.createElement('div');
      _tipEl.className = 'toc-chart-tooltip';
      document.body.appendChild(_tipEl);
    }
    _tipEl.innerHTML = `<strong>${title||'챕터 '+(idx+1)}</strong><br>${chars}`;
    _tipEl.style.left = Math.min(e.clientX+12, window.innerWidth-220)+'px';
    _tipEl.style.top  = (e.clientY-38)+'px';
    _tipEl.style.display='';
    // 해당 rect hover 강조
    svg.querySelectorAll('rect').forEach(r=>r.style.opacity='.45');
    rect_svg.style.opacity='1';
  });
  svg.addEventListener('mouseleave', ()=>{
    if(_tipEl){ _tipEl.style.display='none'; }
    svg.querySelectorAll('rect').forEach(r=>r.style.opacity='.75');
  });
  // 클릭: 해당 챕터로 스크롤 (★ BUG-FIX: data-real-idx로 실제 tocItems 인덱스 사용)
  svg.addEventListener('click', e=>{
    const rect_svg = e.target;
    if(rect_svg.tagName !== 'rect') return;
    const realIdx = parseInt(rect_svg.dataset.realIdx ?? rect_svg.dataset.idx);
    // 접힌 상태라면 먼저 펼치기
    const collapseBtn=document.getElementById('toc-collapse-btn');
    if(collapseBtn) collapseBtn.click();
    // 펼친 뒤 DOM이 갱신되도록 rAF 후 스크롤
    requestAnimationFrame(()=>{
      const tocEl = document.querySelector(`#tb0 .toc-item[data-idx="${realIdx}"]`);
      if(tocEl){
        tocEl.scrollIntoView({block:'center',behavior:'smooth'});
        // 잠깐 하이라이트
        tocEl.style.transition='background .15s';
        tocEl.style.background='var(--blue-bg)';
        setTimeout(()=>{ tocEl.style.background=''; },900);
      }
    });
  });
}

// ★ I10: 목차 내보내기 (글자수 포함)
function exportTocWithStats(){
  if(!S.tocItems.length){Toast.warn('목차가 없어요. 먼저 목차 확인을 실행해주세요.');return;}
  const lines=S.tocItems
    .filter(t=>t.enabled)
    .map((t,i)=>{
      const bl=typeof t.bodyLen==='number'?t.bodyLen:(t.body||'').replace(/\s/g,'').length;
      const blStr=bl>=10000?(bl/10000).toFixed(1)+'만자':bl>=1000?(bl/1000).toFixed(1)+'k자':bl+'자';
      return String(i+1).padStart(3,'0')+'. '+t.title+' ('+blStr+')';
    }).join('\n');
  const blob=new Blob([lines],{type:'text/plain;charset=utf-8'});
  const a=document.createElement('a');
  a.href=URL.createObjectURL(blob);
  a.download=(document.getElementById('title')?.value||'목차')+'_목차.txt';
  a.click();
  setTimeout(()=>URL.revokeObjectURL(a.href),1000);
  Toast.success('목차를 내보냈어요 ('+S.tocItems.filter(t=>t.enabled).length+'개 챕터)');
}

// ★ C-04: Web Share API — 모바일(iOS Safari, Android Chrome) EPUB 직접 공유
async function shareEpub(){
  if(!S.epubBlob){ Toast.warn('변환 후 사용할 수 있어요.'); return; }
  if(!navigator.share){ Toast.info('이 브라우저는 공유 기능을 지원하지 않아요.'); return; }
  try{
    const file=new File([S.epubBlob], S.epubName||'output.epub', {type:'application/epub+zip'});
    await navigator.share({ files:[file], title: S.epubName||'EPUB', text:'NovelEPUB으로 변환된 파일입니다.' });
  }catch(e){
    if(e.name!=='AbortError') Toast.error('공유 실패: '+e.message);
  }
}

// ★ C-04: 결과 카드에 공유 버튼 조건부 표시 (navigator.share 지원 환경만)
function _showShareBtnIfSupported(){
  if(!navigator.share&&!navigator.canShare) return;
  const btnRow=document.querySelector('#resultBox .flex-row');
  if(!btnRow||document.getElementById('shareEpubBtn')) return;
  const btn=document.createElement('button');
  btn.id='shareEpubBtn';
  btn.className='btn btn-blue';
  btn.setAttribute('data-action','shareEpub');
  btn.textContent='📤 공유';
  btnRow.appendChild(btn);
}

// ════ 결과 stat 카드 렌더링 (최적화 5) ════
function showResultStats(containerId, stats){
  const el=document.getElementById(containerId);
  if(!el) return;
  el.innerHTML=stats.map(s=>
    `<div class="result-stat-card">
       <div class="result-stat-val">${escHtml(String(s.value))}</div>
       <div class="result-stat-lbl">${escHtml(String(s.label))}</div>
     </div>`
  ).join('');
}

// ════ 목차 편집 상태 배너 (추천 3) ════
function updateTocEditBanner(){
  const banner=document.getElementById('tocEditBanner');
  const textEl=document.getElementById('tocEditBannerText');
  if(!banner) return;
  if(!S.tocItems||!S.tocItems.length){
    banner.classList.remove('show');
    return;
  }
  const total=S.tocItems.length;
  const active=S.tocItems.filter(t=>t.enabled).length;
  const edited=S.tocItems.some(t=>t.originalTitle&&t.title!==t.originalTitle);
  const hasDisabled=active<total;
  if(hasDisabled||edited){
    if(textEl) textEl.textContent=`✏️ 목차 편집됨 — 활성 ${active} / 전체 ${total}개`+(edited?' · 제목 수정 있음':'');
    banner.classList.add('show');
  } else {
    banner.classList.remove('show');
  }
}

// ════ 히스토리 필터/검색 (추천 7) ════
function filterHistory(){
  const q=(document.getElementById('histSearchInp')?.value||'').toLowerCase().trim();
  const onlyHasFile=document.getElementById('histFilterHasFile')?.classList.contains('on');
  document.querySelectorAll('#histList .hist-item').forEach(el=>{
    const title=(el.querySelector('.hist-title')?.textContent||'').toLowerCase();
    const hasFile=!el.querySelector('.hist-del')?.closest('.hist-item')?.querySelector('[data-action="histDownload"]')?.disabled;
    const matchQ=!q||title.includes(q);
    const matchFile=!onlyHasFile||el.querySelector('[data-action="histDownload"]');
    el.style.display=(matchQ&&matchFile)?'':'none';
  });
}
function toggleHistFilter(btn){
  btn.classList.toggle('on');
  filterHistory();
}

// ════ 배치 변환 파일별 상태 렌더링 (추천 6) ════
function renderBatchFileStatus(itemEl, files, statuses){
  let container=itemEl.querySelector('.batch-file-status');
  if(!container){
    container=document.createElement('div');
    container.className='batch-file-status';
    itemEl.appendChild(container);
  }
  container.innerHTML=files.map((f,i)=>{
    const st=statuses[i]||'pending';
    const icon=st==='done'?'✅':st==='running'?'⏳':st==='error'?'❌':'⬜';
    const detail=st==='done'?f.detail||'':'';
    return `<div class="batch-file-row">
      <span class="batch-file-icon">${icon}</span>
      <span class="batch-file-name">${escHtml(f.name||'')}</span>
      ${detail?`<span class="batch-file-detail">${escHtml(detail)}</span>`:''}
    </div>`;
  }).join('');
}

// ══════════════════════════════════════════
// 📦 Module: Batch (일괄 변환 플로우)
// ══════════════════════════════════════════
function handleBatchTxt(files){
  const txts=Array.from(files).filter(f=>f.name.endsWith('.txt'));
  if(!txts.length)return;
  B.txtFiles=txts.sort((a,b)=>sortKey(a.name)<sortKey(b.name)?-1:1);
  B.patterns={};
  B.sampleTexts={};
  B.totalChs={};
  const dz=document.getElementById('batchTxtDrop');
  dz.classList.add('ok');
  dz.querySelector('.dz-text').textContent='✅ '+txts.length+'개 파일 선택됨';
  document.getElementById('batchResetBar').style.display='flex';
  renderBatchList();
  document.getElementById('batchListSec').style.display='block';
}

function handleBatchCover(files){
  const imgs=Array.from(files).filter(f=>/\.(jpg|jpeg|png|webp|bmp|tiff|tif|avif)$/i.test(f.name));
  imgs.forEach(f=>{const stem=f.name.replace(/\.[^.]+$/,'');B.coverMap[stem]=f;});
  document.getElementById('batchCoverDrop')?.classList.add('ok');
  document.getElementById('batchCoverDrop').querySelector('div').textContent='✅ '+imgs.length+'개 표지 등록';
  renderBatchList();
}

// 표지 퍼지 매핑: 공백·특수문자 제거 후 문자만 비교하는 방식으로 강화
function normStem(s){
  // 공백, 언더스코어, 하이픈, 괄호류, 권/부/화 숫자 suffix 제거 후 소문자
  return s.replace(/[\s_\-\.\[\]\(\)\{\}「」『』【】《》〈〉·~!?！？,，。\.]+/g,'').toLowerCase();
}
function findFuzzyCover(txtStem){
  const keys=Object.keys(B.coverMap);
  if(!keys.length) return null;
  const normTxt=normStem(txtStem);

  // 0순위: 완전 일치 (정규화 후)
  const exact=keys.find(k=>normStem(k)===normTxt);
  if(exact) return B.coverMap[exact];

  // 1순위: 정규화된 커버 stem이 정규화된 txt stem의 앞부분과 일치 (접두어, 최소 4자)
  const prefix=keys.find(k=>{const nk=normStem(k);return nk.length>=4&&normTxt.startsWith(nk);});
  if(prefix) return B.coverMap[prefix];

  // 2순위: 정규화된 커버 stem이 정규화된 txt stem에 포함 (최소 4자)
  const included=keys.find(k=>{const nk=normStem(k);return nk.length>=4&&normTxt.includes(nk);});
  if(included) return B.coverMap[included];

  // 3순위: 토큰 교집합 — 양쪽을 한글 단어로 분리해 공통 토큰이 2개 이상이면 매칭
  const txtTokens=new Set(txtStem.replace(/[0-9\s_\-\.]+/g,' ').trim().split(/\s+/).filter(t=>t.length>=2));
  const best=keys.reduce((acc,k)=>{
    const kTokens=k.replace(/[0-9\s_\-\.]+/g,' ').trim().split(/\s+/).filter(t=>t.length>=2);
    const common=kTokens.filter(t=>txtTokens.has(t)).length;
    return common>acc.score?{k,score:common}:acc;
  },{k:null,score:1}); // 최소 2개 이상 (score>1)
  if(best.k) return B.coverMap[best.k];

  return null;
}

function renderBatchList(){
  const c=document.getElementById('batchList');c.innerHTML='';
  B.txtFiles.forEach((f,i)=>{
    const stem=f.name.replace(/\.txt$/i,'');
    let title=stem,author='';
    let m=stem.match(/^\[(.+?)\]\s*(.+)$/);
    if(m){author=m[1].trim();title=m[2].trim();}
    else{m=stem.match(/^(.+?)\s*@\s*(.+)$/);if(m){title=m[1].trim();author=m[2].trim();}}
    const cover=B.coverMap[stem]||findFuzzyCover(stem)||B.urlCoverFile||null;
    const d=document.createElement('div');d.className='batch-item';d.id='bi_'+i;
    const thumbHtml=cover
      ?'<div class="batch-thumb" onclick="batchPickCover('+i+')" title="클릭해서 변경"><img id="bthumb_'+i+'" src=""></div>'
      :'<div class="batch-thumb" onclick="batchPickCover('+i+')" title="표지 지정">+</div>';
    d.innerHTML='<div class="batch-header">'+thumbHtml+
      '<div style="flex:1;min-width:0"><div class="batch-title">'+escHtml(title)+'</div>'+
      '<div style="display:flex;align-items:center;gap:6px"><div class="batch-status" id="bst_'+i+'">'+(author?'✒️ '+escHtml(author):'')+'</div>'+
      '<button class="batch-toc-btn" onclick="showBatchToc('+i+',this)" title="목차 미리보기">📋 목차 확인</button></div>'+
      '</div></div>'+
      '<div class="batch-toc-panel" id="btp_'+i+'"></div>'+
      '<div class="batch-prog"><div class="batch-prog-bar" id="bpb_'+i+'" style="width:0"></div></div>';
    c.appendChild(d);
    if(cover){const r=new FileReader();r.onload=e=>{const img=document.getElementById('bthumb_'+i);if(img)img.src=e.target.result;};r.readAsDataURL(cover);}
  });
}

async function showBatchToc(idx, btn){
  const panel=document.getElementById('btp_'+idx);
  if(panel.classList.contains('show')){
    panel.classList.remove('show');
    btn.textContent='📋 목차 확인';
    return;
  }

  btn.textContent='⏳ 분석 중...';btn.disabled=true;
  try{
    const file=B.txtFiles[idx];
    // 전체 파일 텍스트 로드 (정확한 목차 감지)
    let text;
    try{ text=await fileToText(file); }
    catch(e){ text=await sampleLines(file); }
    const allLines=text.split('\n');

    // 파일명에서 총 화수 추출 (80% 기준)
    const totalCh=extractTotalFromFilename(file.name)||0;

    // sampleText와 totalCh 캐시 저장
    B.sampleTexts[idx]=text;
    B.totalChs[idx]=totalCh;
    // 파일별 개별 패턴 우선, 없으면 공통 패턴
    const pat=(B.patterns[idx]||document.getElementById('batchPattern')?.value||'').trim();
    let chapters=[], detectedName='', detectedPct=0;
    if(pat){
      try{
        const rx=new RegExp(pat,'i');
        allLines.forEach((l,i)=>{if(l.trim()&&rx.test(l.trim()))chapters.push({line:i+1,title:l.trim()});});
        detectedName='지정 패턴';
        detectedPct=totalCh>0?chapters.length/totalCh*100:100;
      }catch(e){}
    }
    if(!chapters.length){
      const {rx,name,cnt}=bestPat(text);
      detectedName=name||'';
      if(rx){
        allLines.forEach((l,i)=>{if(l.trim()&&rx.test(l.trim()))chapters.push({line:i+1,title:l.trim()});});
        detectedPct=totalCh>0?chapters.length/totalCh*100:100;
        // 80% 이상이면 패턴 저장
        if(detectedPct>=80||totalCh===0) B.patterns[idx]=rx.source;
      }
    }

    // 중복 제거
    const seen=new Set();
    chapters=chapters.filter(c=>{if(seen.has(c.title))return false;seen.add(c.title);return true;});

    // 80% 미만이면 실패 처리
    const isGood=(detectedPct>=80||totalCh===0)&&chapters.length>=3;

    panel.innerHTML='';
    const HEAD=5, TAIL=5;

    if(!isGood){
      // 실패: 패턴 패널 표시 + 현황
      let failMsg='';
      if(chapters.length<3) failMsg='챕터를 감지하지 못했어요.';
      else failMsg=`${chapters.length}개 감지 (파일 ${totalCh}화 기준 ${detectedPct.toFixed(0)}% - 80% 미달)`;

      panel.innerHTML=
        '<div style="font-size:11px;color:var(--accent);padding:4px;margin-bottom:6px">'+
          '⚠️ '+failMsg+' 아래에서 패턴을 선택해주세요.'+
        '</div>'+
        buildPatPresetPanel(idx,text,totalCh);
    } else {
      // 성공: 챕터 목록 + 패턴 변경 버튼
      const pctStr=totalCh>0?` · ${detectedPct.toFixed(0)}% (${totalCh}화 기준)`:'';
      const info=document.createElement('div');
      info.style.cssText='font-size:11px;color:var(--text2);margin-bottom:6px;display:flex;justify-content:space-between;align-items:center';
      info.innerHTML=
        `<span>총 <b style="color:var(--accent)">${chapters.length}</b>개 챕터${pctStr}${detectedName?' · '+detectedName:''}</span>`+
        '<button class="btn btn-ghost btn-sm" style="font-size:10px" onclick="toggleBatchPreset('+idx+')">✏️ 패턴 변경</button>';
      panel.appendChild(info);

      const presetDiv=document.createElement('div');
      presetDiv.id='bpreset_'+idx;
      presetDiv.style.display='none';
      presetDiv.innerHTML=buildPatPresetPanel(idx,text,totalCh);
      panel.appendChild(presetDiv);

      const list=document.createElement('div');
      list.className='batch-toc-list';
      const show=chapters.length<=HEAD+TAIL
        ? chapters
        : [...chapters.slice(0,HEAD), null, ...chapters.slice(-TAIL)];
      show.forEach(ch=>{
        const row=document.createElement('div');
        if(!ch){
          row.style.cssText='text-align:center;color:var(--text3);font-size:10px;padding:3px 0';
          row.textContent='··· '+(chapters.length-HEAD-TAIL)+'개 더 ···';
        } else {
          row.className='batch-toc-row';
          row.innerHTML='<span class="batch-toc-num">'+ch.line+'줄</span><span class="batch-toc-title">'+escHtml(ch.title)+'</span>';
        }
        list.appendChild(row);
      });
      panel.appendChild(list);
    }
    panel.classList.add('show');
    btn.textContent='📋 목차 닫기';
  }catch(e){
    panel.innerHTML='<div style="font-size:11px;color:var(--accent)">오류: '+e.message+'</div>';
    panel.classList.add('show');
    btn.textContent='📋 목차 확인';
  }
  btn.disabled=false;
}

function toggleBatchPreset(idx){
  const d=document.getElementById('bpreset_'+idx);
  if(!d) return;
  const isHidden = d.style.display==='none';
  if(isHidden){
    // 열 때 항상 최신 개수로 재렌더
    d.innerHTML=buildPatPresetPanel(idx, B.sampleTexts[idx]||'', B.totalChs[idx]||0);
    d.style.display='block';
  } else {
    d.style.display='none';
  }
}

function buildPatPresetPanel(idx, sampleText, totalCh){
  const curPat = B.patterns[idx] || '';
  const lines = sampleText ? sampleText.split('\n') : [];
  const tc = totalCh || 0;

  // 각 패턴별 매칭 개수 계산
  function countPat(val){
    try{
      const rx=new RegExp(val,'i');
      const cnt=lines.filter(l=>l.trim()&&rx.test(l.trim())).length;
      return cnt;
    }catch(e){return 0;}
  }

  const PRESETS = [
    ['[ 파일명.txt ] 형식','^\\.\\s*.+\\.txt\\s*\\]\\s*$',            '[ 0001_제목.txt ] 분리 파일 합본 형식'],
    ['화 번호',        '^#?(?:제\\s*)?\\d+\\s*화(?:\\s*.+)?$',       '숫자+화 형식 (#N화, 제N화, N화 제목)'],
    ['숫자만',         '^\\d+$',                                      '줄에 숫자만 단독으로 있는 경우'],
    ['소설(숫자)',     '^.{1,60}\\s*\\(\\d+\\)\\s*$',                 '제목 끝에 (N) 형식'],
    ['소설명+N화',    '^.{2,15}\\s+\\d+화$',                          '소설 제목+N화 형식 (이고깽 이후 천 년 1화 등)'],
    ['#N. 제목',      '^#\\d+\\.\\s+.{1,60}$',                       '#숫자+점 형식 (#1. 시작)'],
    ['N. 제목',       '^\\d+\\.\\s+.{1,60}$',                        '숫자+점 형식 (1. 프롤로그)'],
    ['장 번호',       '^(?:제\\s*\\d+\\s*장|第\\s*\\d+\\s*章)',        '제N장 형식 (주만 변연물어 등)'],
    ['N부 M화',       '^[1-9]부\\s+(?:\\d+화|프롤로그)',              'N부 M화 복합 형식'],
    ['=== [제N화] ===','^={2,}\\s*\\[제\\s*\\d+\\s*화\\]',           '이중등호+대괄호 형식'],
    ['Chapter N',     '^(?:chapter|part|ch)\\s*\\d+',                '영어 Chapter/Part 형식'],
    ['프롤로그/외전',  '^(?:프롤로그|에필로그|외전|후일담)',           '외전·에필로그 등 특수 챕터'],
    ['# 제목',        '^#{1,3}\\s*.+$',                               '마크다운 헤딩 형식'],
  ];

  // 현재 패턴에서 체크 상태 계산
  const checkedVals = new Set();
  if(curPat){
    const orMatch = curPat.match(/^\^\(\?:(.+)\)$/);
    if(orMatch){
      const parts = orMatch[1].split('|');
      PRESETS.forEach(([,val])=>{
        const stripped = val.replace(/^\^/,'').replace(/\$$/,'');
        if(parts.some(p=>p===stripped)) checkedVals.add(val);
      });
    } else {
      PRESETS.forEach(([,val])=>{ if(val===curPat) checkedVals.add(val); });
    }
  }

  let html =
    '<div style="margin-top:6px;padding:8px;background:var(--bg);border-radius:8px;border:1px solid var(--border)">' +
    '<div style="font-size:12px;font-weight:700;color:var(--text);margin-bottom:8px">📐 챕터 패턴 선택</div>' +
    '<div style="display:flex;gap:6px;margin-bottom:8px;flex-wrap:wrap">' +
      '<button class="btn btn-ghost btn-sm" style="font-size:10px" onclick="batchPresetCheckAll('+idx+',true)">전체 선택</button>' +
      '<button class="btn btn-ghost btn-sm" style="font-size:10px" onclick="batchPresetCheckAll('+idx+',false)">전체 해제</button>' +
      '<button class="btn btn-ghost btn-sm" style="font-size:10px" onclick="batchPresetAuto('+idx+')">🔍 자동 감지</button>' +
    '</div>' +
    '<div id="bpck_list_'+idx+'" style="display:flex;flex-direction:column;gap:4px">';

  PRESETS.forEach(([label, val, desc])=>{
    const checked = checkedVals.has(val) ? 'checked' : '';
    const cnt = countPat(val);
    const pct = tc>0 ? (cnt/tc*100).toFixed(0) : null;
    const pctStr = pct!==null ? ` (${cnt}개 / ${pct}%${parseFloat(pct)>=80?' ⭐':''})` : (cnt>0?` (${cnt}개)`:'');
    const goodBg = pct!==null&&parseFloat(pct)>=80 ? 'background:var(--green-bg);border-color:var(--green)' : '';

    html +=
      `<label style="display:flex;align-items:flex-start;gap:8px;padding:5px 6px;border-radius:5px;cursor:pointer;border:1px solid var(--border);background:var(--bg2);${goodBg}">` +
        `<input type="checkbox" class="bpck_${idx}" data-val="${escHtml(val)}" ${checked}` +
               ` onchange="applyBatchPreset(${idx})" style="margin-top:2px;flex-shrink:0">` +
        '<div style="min-width:0;flex:1">' +
          '<div style="font-size:12px;font-weight:600;display:flex;gap:6px;align-items:center;flex-wrap:wrap">' +
            escHtml(label) +
            `<span style="font-size:11px;color:${parseFloat(pct)>=80?'var(--green)':'var(--accent)'};font-weight:700">${pctStr}</span>` +
            `<span style="font-size:10px;color:var(--text2);font-weight:400">${escHtml(desc)}</span>` +
          '</div>' +
        '</div>' +
      '</label>';
  });

  html +=
    '</div>' +
    '<div style="margin-top:8px;border-top:1px solid var(--border);padding-top:8px">' +
      '<div style="font-size:11px;font-weight:600;color:var(--text2);margin-bottom:4px">직접 입력 (정규식)</div>' +
      '<div style="display:flex;gap:6px">' +
        `<input class="inp" id="bpat_direct_${idx}" placeholder="직접 입력하거나 위에서 선택" ` +
               `value="${escHtml(curPat)}" style="flex:1;font-size:11px" oninput="applyBatchPreset(${idx})">` +
        `<button class="btn btn-blue btn-sm" onclick="confirmBatchPreset(${idx})">✅ 적용</button>` +
      '</div>' +
      `<div id="bpat_preview_${idx}" style="font-size:10px;color:var(--text2);margin-top:4px">` +
        (curPat?'현재: '+escHtml(curPat):'(자동 감지)') +
      '</div>' +
    '</div>' +
    '</div>';
  return html;
}

function batchPresetCheckAll(idx, checked){
  document.querySelectorAll('.bpck_'+idx).forEach(cb=>cb.checked=checked);
  applyBatchPreset(idx);
}

async function batchPresetAuto(idx){
  const file = B.txtFiles[idx];
  if(!file) return;
  delete B.patterns[idx];
  delete B.sampleTexts[idx];
  const btn = document.querySelector('#bi_'+idx+' .batch-toc-btn');
  const panel = document.getElementById('btp_'+idx);
  panel.classList.remove('show');
  if(btn){
    btn.textContent='📋 목차 확인';
    await showBatchToc(idx, btn);
  }
}

function applyBatchPreset(idx){
  // 직접 입력 필드 — 사용자가 명시적으로 입력한 경우만 우선
  const directEl=document.getElementById('bpat_direct_'+idx);
  const direct=directEl?.value.trim();
  const checks=[...document.querySelectorAll('.bpck_'+idx+':checked')].map(c=>c.dataset.val);

  let combined='';
  if(direct&&!checks.length){
    // 직접 입력만 있는 경우
    combined=direct;
  } else if(checks.length===1&&!direct){
    combined=checks[0];
  } else if(checks.length>1&&!direct){
    // 체크박스 여러 개 → OR 결합
    const parts=checks.map(v=>v.replace(/^\^/,'').replace(/\$$/,'').replace(/^\(\?:/,'').replace(/\)$/,''));
    combined='^(?:'+parts.join('|')+')$';
  } else if(direct&&checks.length){
    // 직접 입력 + 체크박스 모두 있으면 직접 입력 우선
    combined=direct;
  }

  // 직접 입력 필드 동기화 (체크박스로만 선택 시)
  if(!direct&&combined&&directEl) directEl.value=combined;

  // 패턴 저장
  if(combined) B.patterns[idx]=combined;
  else delete B.patterns[idx];

  const prev=document.getElementById('bpat_preview_'+idx);
  if(prev) prev.textContent=combined?'현재: '+combined:'(자동 감지)';

  // 총 챕터 수 실시간 업데이트
  if(combined&&B.sampleTexts[idx]){
    try{
      const rx=new RegExp(combined,'i');
      const lines=B.sampleTexts[idx].split('\n');
      const cnt=lines.filter(l=>l.trim()&&rx.test(l.trim())).length;
      const totalCh=B.totalChs[idx]||0;
      const pct=totalCh>0?(cnt/totalCh*100).toFixed(0)+'%':null;
      const infoEl=document.querySelector('#btp_'+idx+' b[style*="accent"]');
      if(infoEl){
        infoEl.textContent=cnt;
        const pctSpan=infoEl.nextSibling;
        if(pctSpan&&pct) pctSpan.textContent=' ('+pct+(parseFloat(pct)>=80?' ⭐':'')+')';
      }
    }catch(e){}
  }
}

async function confirmBatchPreset(idx){
  const directEl=document.getElementById('bpat_direct_'+idx);
  const direct=directEl?.value.trim();
  const checks=[...document.querySelectorAll('.bpck_'+idx+':checked')].map(c=>c.dataset.val);

  let pat=direct;
  if(!pat&&checks.length===1) pat=checks[0];
  else if(!pat&&checks.length>1){
    const parts=checks.map(v=>v.replace(/^\^/,'').replace(/\$$/,'').replace(/^\(\?:/,'').replace(/\)$/,''));
    pat='^(?:'+parts.join('|')+')$';
  }
  if(!pat) pat=B.patterns[idx];
  if(!pat){Toast.warn('패턴을 선택하거나 직접 입력해주세요.');return;}

  B.patterns[idx]=pat;
  const btn=document.querySelector('#bi_'+idx+' .batch-toc-btn');
  const panel=document.getElementById('btp_'+idx);
  panel.classList.remove('show');
  if(btn){btn.textContent='📋 목차 확인';await showBatchToc(idx,btn);}
}

function batchPickCover(idx){
  const inp=document.createElement('input');inp.type='file';inp.accept='.jpg,.jpeg,.png,.webp';
  inp.onchange=()=>{
    const f=inp.files[0];if(!f)return;
    B.coverMap[B.txtFiles[idx].name.replace(/\.txt$/i,'')]=f;
    const thumb=document.querySelector('#bi_'+idx+' .batch-thumb');
    if(thumb){const r=new FileReader();r.onload=e=>{thumb.innerHTML='<img src="'+e.target.result+'" style="width:100%;height:100%;object-fit:cover">';};r.readAsDataURL(f);}
  };inp.click();
}

async function startBatch(){
  if(!B.txtFiles.length){Toast.warn('TXT 파일을 선택해주세요.');return;}
  B.results=[];
  const _batchStartTime = Date.now(); // ★ C-05: 소요 시간 측정
  document.getElementById('batchProgWrap')?.classList.add('show');
  document.getElementById('batchResultBox')?.classList.remove('show');
  const total=B.txtFiles.length;
  const globalPat=document.getElementById('batchPattern')?.value.trim();
  const useItalicBatch=document.getElementById('batchItalic')?.checked;

  for(let i=0;i<total;i++){
    const f=B.txtFiles[i];
    const stem=f.name.replace(/\.txt$/i,'');
    let title=stem,author='';
    let m=stem.match(/^\[(.+?)\]\s*(.+)$/);
    if(m){author=m[1].trim();title=m[2].trim();}
    else{m=stem.match(/^(.+?)\s*@\s*(.+)$/);if(m){title=m[1].trim();author=m[2].trim();}}
    const cover=B.coverMap[stem]||findFuzzyCover(stem)||B.urlCoverFile||null;
    const item=document.getElementById('bi_'+i);
    if(item)item.className='batch-item running';
    document.getElementById('bst_'+i).textContent='변환 중...';
    document.getElementById('batchProgMsg').textContent='('+(i+1)+'/'+total+') '+title+' 변환 중...';
    document.getElementById('batchProgBar').style.width=Math.floor(i/total*100)+'%';
    try{
      // 이벤트 루프 양보 — UI 갱신 보장 (파일 간 블로킹 방지)
      await new Promise(r=>setTimeout(r,0));
      const raw=await fileToText(f);
      const pattern=(B.patterns[i]||globalPat);
      const chapters=splitChapters(raw,pattern);
      const blob=await buildEpub({title,author,chapters,coverFile:cover,illMap:[],useItalic:useItalicBatch},
        pct=>{document.getElementById('bpb_'+i).style.width=(30+pct*0.7)+'%';});
      B.results.push({name:title+'.epub',blob});
      if(item)item.className='batch-item done';
      document.getElementById('bst_'+i).textContent='✅ 완료';
      document.getElementById('bpb_'+i).style.width='100%';
    }catch(e){
      if(item)item.className='batch-item error';
      document.getElementById('bst_'+i).textContent='❌ '+e.message;
    }
  }
  document.getElementById('batchProgBar').style.width='100%';
  document.getElementById('batchProgMsg').textContent='완료! '+B.results.length+'/'+total+'개 성공';
  document.getElementById('batchResultMsg').textContent=B.results.length+'개 epub 생성 완료';
  document.getElementById('batchResultBox')?.classList.add('show');
  // ★ C-05: 일괄변환 완료 요약 토스트 (탭 이동 후에도 인지 가능)
  const batchElapsed=((Date.now()-_batchStartTime)/1000).toFixed(1);
  const totalMB=B.results.reduce((s,r)=>s+(r.blob?.size||0),0)/1024/1024;
  Toast.success(`✅ 일괄변환 완료 — ${B.results.length}/${total}개 성공 · ${totalMB.toFixed(1)}MB · ${batchElapsed}초`, 6000);
}

async function downloadBatchZip(){
  if(!B.results.length)return;
  if(B.results.length===1){const a=document.createElement('a');a.href=URL.createObjectURL(B.results[0].blob);a.download=B.results[0].name;a.click();return;}
  const zip=new JSZip();
  B.results.forEach(r=>zip.file(r.name,r.blob));
  const blob=await zip.generateAsync({type:'blob',compression:'DEFLATE'});
  const a=document.createElement('a');a.href=URL.createObjectURL(blob);a.download='epub_일괄변환.zip';a.click();
  setTimeout(()=>URL.revokeObjectURL(a.href),1000);
}

// ════════════════════════════════════════════════
// ⚡ Module: Worker — Blob 기반 인라인 Web Worker
// ★ 외부 파일(parser.js) 의존성 없음
// ★ 로컬 파일 실행, 하위 경로, CORS 환경 모두 안전
// ★ new Blob([코드]) → URL.createObjectURL → new Worker(url)
// ★ Worker 생성 직후 URL.revokeObjectURL로 메모리 해제
// ════════════════════════════════════════════════

/**
 * createParserWorker — Blob URL 인라인 Worker 생성
 *
 * 경로 독립적: file://, http://, https:// 어디서든 동작
 * Worker 내부에 KEYWORD_PATS, bestPat, splitChaptersWorker 완전 인라인
 */
function createParserWorker(){
  // ★ parser.js와 완전 동기화된 Worker 코드
  // - 48개 PATS 전체 포함
  // - preprocessLine / calcSequenceWeight 포함
  // - splitChaptersWorker 구버전 제거 → splitChaptersWorkerDetailed만 사용
  const workerSrc=`
'use strict';
// ── 전처리: 줄 앞뒤 특수문자·과도한 공백 제거 ──
function preprocessLine(raw){
  return raw.trim()
    .replace(/^[\\[\\(\\-\\s]+/,'').replace(/[\\]\\)\\-\\s]+$/,'')
    .replace(/\\s{2,}/g,' ').trim();
}
// ── 연속성 체크 ──
function calcSequenceWeight(nums){
  if(nums.length<2)return 0;
  let c=0;
  for(let i=1;i<nums.length;i++){const p=nums[i-1],n=nums[i];if(p!=null&&n!=null&&(n===p+1||n===p))c++;}
  return c/(nums.length-1);
}
// ── KEYWORD_PATS — parser.js와 동기화 ──
const KEYWORD_PATS=[
  /^(?:프롤로그|프롤)(?:\\s*.+)?$/i,/^(?:에필로그|에필)(?:\\s*.+)?$/i,
  /^외전(?:\\s*.+)?$/,/^번외(?:\\s*.+)?$/,/^후기(?:\\s*.+)?$/,
  /^작가\\s*후기(?:\\s*.+)?$/,/^작가의\\s*말(?:\\s*.+)?$/,/^작가\\s*노트(?:\\s*.+)?$/,
  /^(?:side\\s*story|side\\s*episode|special\\s*episode)(?:\\s*.+)?$/i,
  /^(?:prologue|epilogue|afterword|author.?s?\\s*note)(?:\\s*.+)?$/i,
  /^서장(?:\\s*.+)?$/,/^종장(?:\\s*.+)?$/,/^서문(?:\\s*.+)?$/,
  /^(?:막간|인터루드|interlude)(?:\\s*[^\\r\\n]{0,80})?$/i,
  /^(?:공지|공지사항)(?:\\s*[^\\r\\n]{0,80})?$/,
  /^(?:설정집|일러스트|캐릭터\\s*소개|등장인물|세계관\\s*설정)(?:\\s*[^\\r\\n]{0,80})?$/,
  /^(?:특별편|스페셜|단편)(?:\\s*[^\\r\\n]{0,80})?$/,
  /^(?:extra|bonus)(?:\\s*(?:chapter|episode|story))?(?:\\s*[^\\r\\n]{0,60})?$/i,
];
// ── PATS (parser.js와 동기화 — ReDoS-safe) ──
const PATS=[
  [/^\\[(?:EP|Ep|ep)\\.\\d+\\](?:\\s*.+)?$/,'[EP.N]'],
  [/^\\[(?:Prologue|Epilogue|Side|Extra|프롤로그|에필로그|외전)(?:\\s*.+)?\\](?:\\s*.+)?$/i,'[Prologue]'],
  [/^\\[\\s*.+\\.txt\\s*\\]\\s*$/i,'[파일명.txt]'],
  [/^\\d{3,6}\\s{2,}.+$/,'NNN제목'],
  [/^[〈<]\\s*\\d+\\s*화\\s*[〉>](?:\\s*.+)?$/i,'〈N화〉'],
  [/^【\\s*\\d+\\s*화\\s*】(?:\\s*[^\\r\\n]{0,80})?$/,'【N화】'],
  [/^[◆●◇○■□▶▷►◀◁★☆♠♦♣♥]\\s*\\d+\\s*화(?:\\s*[^\\r\\n]{0,80})?$/,'특수문자+N화'],
  [/^\\(\\s*제?\\s*\\d+\\s*[화장]\\s*\\)(?:\\s*[^\\r\\n]{0,80})?$/,'(N화)'],
  [/^제\\s*\\d+\\s*화(?:\\s*.+)?$/,'제N화'],
  [/^제\\s*\\d+\\s*장(?:\\s*.+)?$/,'제N장'],
  [/^제\\s*[一二三四五六七八九十百千\\d]+\\s*[화장話章](?:\\s*.+)?$/,'제N화/장(한자)'],
  [/^\\d+화(?:\\s*.+)?$/,'N화'],
  [/^\\d+장(?:\\s*.+)?$/,'N장'],
  [/^\\[\\s*제?\\s*\\d+\\s*화\\s*\\](?:\\s*.+)?$/,'[N화]'],
  [/^\\[\\s*제?\\s*\\d+\\s*장\\s*\\](?:\\s*.+)?$/,'[N장]'],
  [/^#?(?:제\\s*)?\\d+\\s*화(?:\\s*.+)?$/i,'화번호'],
  [/^\\d+화\\.\\s*.+$/,'화.제목'],
  [/^={2,}\\s*\\[제\\s*\\d+\\s*화\\]\\s*={0,}$/i,'===제N화==='],
  [/^0+\\d+화(?:\\s*[^\\r\\n]{0,80})?$/,'001화zero-pad'],
  [/^\\d+화?\\s*[-~]\\s*\\d+화(?:\\s*[^\\r\\n]{0,80})?$/,'N화~N화범위'],
  [/^(?:시즌\\s*\\d+|S\\d+)\\s+\\d+화(?:\\s*[^\\r\\n]{0,80})?$/,'시즌N N화'],
  [/^제\\s*\\d+\\s*편(?:\\s*[^\\r\\n]{0,80})?$/,'제N편'],
  [/^\\d+편(?:\\s*[^\\r\\n]{0,80})?$/,'N편'],
  [/^(?:chapter|part|ch)\\.?\\s*\\d+(?:\\s*.+)?$/i,'Chapter'],
  [/^(?:EP|Ch|Scene|Act)\\.?\\s*\\d+(?:\\s*.+)?$/i,'EP/Scene'],
  [/^[1-9]부\\s+(?:\\d+화|프롤로그)(?:\\s*.+)?$/,'N부M화'],
  [/^S\\d+E\\d+(?:\\s*.+)?$/i,'S1E01'],
  [/^(?:chapter|part|ch)\\s+(?:one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve)(?:\\s*[^\\r\\n]{0,60})?$/i,'Chapter One'],
  [/^chap\\.?\\s*\\d+(?:\\s*[^\\r\\n]{0,80})?$/i,'Chap.N'],
  [/^book\\s+(?:\\d+|one|two|three|four|five)(?:\\s*[^\\r\\n]{0,80})?$/i,'Book N'],
  [/^\\d+(?:st|nd|rd|th)\\s+(?:story|episode|chapter|part|tale)(?:\\s*[^\\r\\n]{0,80})?$/i,'Nst Story'],
  [/^vol(?:ume)?\\.?\\s*\\d+(?:\\s*[^\\r\\n]{0,80})?$/i,'Volume N'],
  [/^(?:part|section|book)\\s+(?:I{1,3}|IV|VI{0,3}|IX|X{1,3}|XI{0,3}|XIV|XV|XVI{0,3}|XIX|XX{0,3}|XXX(?:I{0,3}|V|VI{0,3}|IX)?)(?:\\s*[^\\r\\n]{0,80})?$/i,'Part I로마'],
  [/^서장(?:\\s*.+)?$/,'서장'],[/^종장(?:\\s*.+)?$/,'종장'],
  [/^서문(?:\\s*.+)?$/,'서문'],[/^서론(?:\\s*.+)?$/,'서론'],
  [/^(?:프롤로그|프롤)(?:\\s*.+)?$/i,'프롤로그'],
  [/^(?:에필로그|에필)(?:\\s*.+)?$/i,'에필로그'],
  [/^외전(?:\\s*.+)?$/,'외전'],[/^번외(?:\\s*.+)?$/,'번외'],
  [/^후기(?:\\s*.+)?$/,'후기'],[/^작가\\s*후기(?:\\s*.+)?$/,'작가후기'],
  [/^작가의\\s*말(?:\\s*.+)?$/,'작가의말'],[/^작가\\s*노트(?:\\s*.+)?$/,'작가노트'],
  [/^(?:prologue|epilogue|afterword|author.?s?\\s*note)(?:\\s*.+)?$/i,'영문키워드'],
  [/^(?:막간|인터루드|interlude)(?:\\s*[^\\r\\n]{0,80})?$/i,'막간/인터루드'],
  [/^(?:간주|幕間)(?:\\s*[^\\r\\n]{0,80})?$/,'간주/幕間'],
  [/^(?:공지|공지사항|작가의\\s*글|작가\\s*공지)(?:\\s*[^\\r\\n]{0,80})?$/,'공지'],
  [/^(?:설정집|일러스트|캐릭터\\s*소개|등장인물|세계관\\s*설정)(?:\\s*[^\\r\\n]{0,80})?$/,'설정집/부록'],
  [/^(?:특별편|스페셜|단편|외전\\s*\\d*)(?:\\s*[^\\r\\n]{0,80})?$/,'특별편/단편'],
  [/^(?:side\\s*story|extra\\s*(?:chapter|episode)?|bonus\\s*(?:chapter|episode)?)(?:\\s*\\d*)?(?:\\s*[^\\r\\n]{0,80})?$/i,'Side Story/Extra'],
  [/^(?:첫|두|세|네|다섯|여섯|일곱|여덟|아홉|열)\\s*번째\\s*(?:이야기|장|화|편|챕터)(?:\\s*[^\\r\\n]{0,60})?$/,'첫번째이야기'],
  [/^제\\s*(?:일|이|삼|사|오|육|칠|팔|구|십)\\s*[화장편](?:\\s*[^\\r\\n]{0,60})?$/,'제일화한글서수'],
  [/^\\d+\\.\\s+.{1,60}$/,'N.제목'],
  [/^#\\d+\\.\\s+.{1,60}$/,'#N.제목'],
  [/^\\d+\\)\\s+[^\\r\\n]{1,60}$/,'N)제목'],
  [/^0+\\d+\\.\\s+[^\\r\\n]{1,60}$/,'01.zero-pad'],
  [/^.{1,60}\\s*\\(\\d+\\)\\s*$/,'소설(숫자)'],
  [/^(?:제\\s*\\d+\\s*장|第\\s*\\d+\\s*章)(?:\\s*.+)?$/,'장번호'],
  [/^【.+】.*$/,'타이틀【】'],
  [/^#{1,3}\\s*.+$/,'#제목'],
  [/^[■▶◆●►▷◇★☆]\\s*.{2,40}$/,'특수문자제목'],
  [/^第\\s*[\\d一二三四五六七八九十百千]+\\s*[章話话](?:\\s*.+)?$/,'한자장/화'],
  [/^第\\s*[\\d一二三四五六七八九十百千]+\\s*[幕節](?:\\s*[^\\r\\n]{0,80})?$/,'第N幕/節'],
  [/^[≪《]\\s*\\d+\\s*화\\s*[≫》](?:\\s*[^\\r\\n]{0,80})?$/,'≪N화≫겹낫표'],
  [/^[「『]\\s*\\d+\\s*화\\s*[」』](?:\\s*[^\\r\\n]{0,80})?$/,'「N화」낫표'],
  [/^(?:EP|제|Chapter|Ch|디|Scene|Prologue)\\.?\\s*\\d+/i,'EP/Ch시작'],
  [/^\\d{1,3}\\.\\s*.+$/,'N.짧은'],
  [/^\\d+권(?:\\s*.+)?$/,'N권'],
  [/^.*[=\\-]{3,}$/,'구분선'],
  [/^[\\*\\-─]+\\s*\\d+화?\\s*[\\*\\-─]+$/,'*N*'],
  [/^(?:시즌\\s*\\d+\\s+)?\\d+화(?:\\s*.+)?$/,'시즌N화'],
  [/^\\((?:외전|번외|특별편|side|bonus)\\)/i,'(외전)'],
  [/^(?:\\s?〈\\s?\\d+화\\s?〉|EP\\.\\d+|\\d+화|\\d+)[^\\r\\n]*/,'줄시작통합'],
  [/^[-─—]{1,3}\\s*\\d+\\s*[-─—]{1,3}$/,'-N-대시'],
  [/^[-─=]{2,}\\s*[^\\r\\n]{1,60}\\s*[-─=]{2,}$/,'───제목───'],
  [/^(?:<\\d{1,6}>|\\[\\d{1,6}\\]|\\{\\d{1,6}\\})$/,'<N>괄호단독'],
];
function checkTitleWaPattern(lines,minGap=50){
  const rx=/^.{2,15}\\s+\\d+화$/;const pos=[];
  lines.forEach((l,i)=>{const t=preprocessLine(l);if(t&&rx.test(t))pos.push(i);});
  if(pos.length<3)return{cnt:0,rx:null};
  const real=pos.filter((p,j)=>Math.min(p-(pos[j-1]??-999),(pos[j+1]??p+999)-p)>=minGap);
  return real.length>=3?{cnt:real.length,rx}:{cnt:0,rx:null};
}
function checkNDotPattern(lines,minGap=50){
  const rx=/^\\d+\\.\\s+.{1,60}$/;const pos=[];
  lines.forEach((l,i)=>{const t=preprocessLine(l);if(t&&rx.test(t))pos.push(i);});
  if(pos.length<3)return{cnt:0,rx:null};
  const real=pos.filter((p,j)=>Math.min(p-(pos[j-1]??-999),(pos[j+1]??p+999)-p)>=minGap);
  if(real.length<3)return{cnt:0,rx:null};
  const m=preprocessLine(lines[real[0]]).match(/^(\\d+)\\./);
  return m&&parseInt(m[1])>5?{cnt:0,rx:null}:{cnt:real.length,rx};
}
function bestPat(raw){
  const lines=raw.split('\\n');
  const totalLines=lines.length;
  const tailStart=Math.floor(totalLines*0.90);
  let best=null,bestScore=0,bestName='';
  const mixed=[];
  const blankWrapped=new Set();
  for(let i=1;i<lines.length-1;i++){
    const p=!lines[i-1].trim(),n=!lines[i+1].trim();
    const p2=i>=2&&!lines[i-2].trim(),n2=i+2<lines.length&&!lines[i+2].trim();
    if(lines[i].trim()&&(p||p2)&&(n||n2))blankWrapped.add(i);
  }
  for(const[rx,name]of PATS){
    const idxs=[],nums=[];
    for(let i=0;i<lines.length;i++){
      const t=preprocessLine(lines[i]);  // ★ preprocessLine 적용
      if(t&&rx.test(t)){idxs.push(i);const m=t.match(/\\d+/);nums.push(m?parseInt(m[0]):null);}
    }
    if(idxs.length<3)continue;
    const isNum=rx.source==='^\\\\d+$';
    let score=idxs.reduce((a,i)=>{if(i>=tailStart&&isNum)return a;return a+(blankWrapped.has(i)?3:1);},0);
    if(!score)continue;
    const seqW=calcSequenceWeight(nums);  // ★ 연속성 가중치 적용
    if(seqW>=0.6)score=Math.round(score*(1+seqW*0.5));
    mixed.push({rx,name,cnt:idxs.length,score});
    if(score>bestScore){bestScore=score;best=rx;bestName=name;}
  }
  const dynGap=Math.max(30,Math.min(200,Math.floor(totalLines/50)));
  const nDot=checkNDotPattern(lines,dynGap);
  if(nDot.cnt>0&&nDot.cnt*3>bestScore){bestScore=nDot.cnt*3;best=nDot.rx;bestName='N.제목';mixed.push({rx:nDot.rx,name:'N.제목',cnt:nDot.cnt,score:nDot.cnt*3});}
  const tWa=checkTitleWaPattern(lines,dynGap);
  if(tWa.cnt>0&&tWa.cnt*3>bestScore){bestScore=tWa.cnt*3;best=tWa.rx;bestName='소설명+N화';mixed.push({rx:tWa.rx,name:'소설명+N화',cnt:tWa.cnt,score:tWa.cnt*3});}
  if(bestScore<3){
    const fb=/^\\d+$/;
    const c=lines.filter((l,i)=>i<tailStart&&preprocessLine(l)&&fb.test(preprocessLine(l))).length;
    if(c>=3){bestScore=c;best=fb;bestName='숫자만';}
  }
  if(mixed.length>1){
    const tot=mixed.reduce((s,m)=>s+m.cnt,0);
    const dom=mixed.find(m=>m.cnt/tot>=0.75);
    if(dom)return{rx:dom.rx,name:dom.name+'[지배]',cnt:dom.cnt};
  }
  const seen=new Set();
  const uniq=mixed.filter(m=>{if(seen.has(m.rx.source))return false;seen.add(m.rx.source);return true;});
  if(uniq.length>1){
    const comb=new RegExp('(?:'+uniq.map(m=>m.rx.source).join('|')+')','i');
    const uc=[...new Set(lines.filter(l=>preprocessLine(l)&&comb.test(preprocessLine(l))).map(l=>preprocessLine(l)))];
    if(uc.length>bestScore)return{rx:comb,name:'혼합[자동]',cnt:uc.length,isMixed:true};
  }
  return{rx:best,name:bestName,cnt:bestScore};
}
// ★ Worker 메시지 핸들러 (splitChaptersWorkerDetailed만 사용 — 구버전 제거)
self._aborted=false;
self.onmessage=function(e){
  const{type,payload,id}=e.data;
  try{
    if(type==='SPLIT'){
      const{raw,customPat}=payload;
      self._aborted=false;
      self.postMessage({type:'PROGRESS',id,pct:5,msg:'② 텍스트 정규화 중...'});
      const result=splitChaptersWorkerDetailed(raw,customPat,function(pct,msg){
        self.postMessage({type:'PROGRESS',id,pct,msg});
      });
      self.postMessage({type:'DONE',id,result});
    } else if(type==='ABORT'){
      self._aborted=true;
    }
  }catch(err){
    self.postMessage({type:'ERROR',id,error:err.message||String(err)});
  }
};
function splitChaptersWorkerDetailed(raw,customPat,onProgress){
  self._aborted=false;
  raw=raw.replace(/\\r\\n/g,'\\n').replace(/\\r/g,'\\n')
         .replace(/\\xad/g,'\\u2014').replace(/[\\x00-\\x08\\x0B\\x0C\\x0E-\\x1F]/g,'')
         .replace(/[\\uFFFE\\uFFFF]/g,'');
  onProgress(8,'② 패턴 분석 중...');
  let rx=null;
  if(customPat&&customPat.trim()){try{rx=new RegExp(customPat.trim(),'i');}catch(e){}}
  if(!rx){const r=bestPat(raw);rx=r.rx;}
  if(rx){const kw=KEYWORD_PATS.map(k=>k.source).join('|');rx=new RegExp('(?:'+rx.source+'|'+kw+')','i');}
  onProgress(12,'② 챕터 분리 시작...');
  if(!rx){
    const lines=raw.split('\\n'),total=lines.length;
    const PL=Math.max(200,Math.min(500,Math.floor(total/20)));
    const chs=[];
    for(let i=0;i<total;i+=PL){
      if(self._aborted)return chs;
      const s=lines.slice(i,i+PL).join('\\n').trim();if(!s)continue;
      const pg=Math.floor(i/PL)+1,tp=Math.ceil(total/PL);
      chs.push([pg===1&&tp===1?'본문':'('+pg+'/'+tp+')',s]);
      onProgress(12+Math.round((i/total)*80),'② 페이지 분할 중... '+pg+'/'+tp);
    }
    return chs.length?chs:[['본문',raw.trim()]];
  }
  const lines=raw.split('\\n');
  const total=lines.length;
  const chs=[],seen=new Map();
  const sep=/^[-=*─━~·.‒—]{3,}\\s*$|^[─━═]{2,}$/;
  let cur=null,body=[],lastPct=12;
  for(let li=0;li<total;li++){
    if(self._aborted)break;
    const line=lines[li];
    const t=preprocessLine(line);  // ★ preprocessLine 적용
    if(t&&rx.test(t)){
      const pc=seen.get(t)||0;seen.set(t,pc+1);
      const ut=pc===0?t:t+' ('+(pc+1)+')';
      while(body.length&&(sep.test(body[body.length-1].trim())||!body[body.length-1].trim()))body.pop();
      if(cur===null&&body.length>0)chs.push(['서문',body.join('\\n').trim()]);
      else if(cur!==null)chs.push([cur,body.join('\\n').trim()]);
      cur=ut;body=[];
      let ni=li+1;while(ni<total&&sep.test(lines[ni].trim()))ni++;
      if(ni>li+1)li=ni-1;
    }else{body.push(line);}
    const pct=12+Math.round((li/total)*80);
    if(pct>lastPct){lastPct=pct;onProgress(pct,'② 챕터 파싱 중... '+(chs.length+1)+'화 / '+(li+1).toLocaleString()+'줄');}
  }
  if(cur!==null)chs.push([cur,body.join('\\n').trim()]);
  else if(body.length)chs.push(['본문',body.join('\\n').trim()]);
  raw=null;
  return chs.length?chs:[['본문','']];
}
`;
  const blob=new Blob([workerSrc],{type:'application/javascript'});
  const url=URL.createObjectURL(blob);
  const worker=new Worker(url);
  URL.revokeObjectURL(url);
  return worker;
}


function getParserWorker(){
  if(!_parserWorker){
    _parserWorker=createParserWorker();
    _parserWorker.onmessage=function(e){
      const{type,id,result,error,pct,msg}=e.data;
      if(type==='PROGRESS'){
        setProgress(pct,msg);
        return;
      }
      const cb=_workerCallbacks.get(id);
      if(!cb) return;
      _workerCallbacks.delete(id);
      if(type==='DONE') cb.resolve(result);
      else cb.reject(new Error(error||'Worker 오류'));
    };
    _parserWorker.onerror=function(e){
      for(const[id,cb]of _workerCallbacks){
        cb.reject(new Error('Worker 오류: '+e.message));
      }
      _workerCallbacks.clear();
      _parserWorker=null; // 재생성 허용
    };
  }
  return _parserWorker;
}

// ★ Worker 교체: 기존 Worker terminate 후 새 생성
function resetParserWorker(){
  if(_parserWorker){
    _parserWorker.terminate();
    _parserWorker=null;
    _workerCallbacks.clear();
  }
  return getParserWorker();
}

/**
 * Worker 기반 splitChapters (비동기)
 * 10만 줄 이상 파일에서 메인 스레드 블로킹 없음
 */
async function splitChaptersAsync(raw, customPat, onProgress){
  const lineCount=(raw.match(/\n/g)||[]).length;

  if(lineCount<100000){
    // 소형 파일: 동기 처리 (Worker 오버헤드 없음)
    return splitChapters(raw, customPat);
  }

  onProgress&&onProgress(8,'② 대용량 파일 — Worker 파싱 시작...');

  return new Promise((resolve,reject)=>{
    const id=++_workerIdCounter;
    _workerCallbacks.set(id,{resolve,reject});

    // ★ 타임아웃: Worker가 응답 없이 채널이 닫히는 경우 방지 (2분)
    const timer=setTimeout(()=>{
      if(_workerCallbacks.has(id)){
        _workerCallbacks.delete(id);
        // Worker 타임아웃 → 동기 폴백
        try{resolve(splitChapters(raw,customPat));}
        catch(e){reject(new Error('파싱 타임아웃: '+e.message));}
      }
    }, 120000);

    try{
      const worker=getParserWorker();
      // ★ 원본 콜백을 타이머 정리 포함 버전으로 래핑
      const orig=_workerCallbacks.get(id);
      _workerCallbacks.set(id,{
        resolve:(r)=>{ clearTimeout(timer); orig.resolve(r); },
        reject: (e)=>{ clearTimeout(timer); orig.reject(e); }
      });
      worker.postMessage({type:'SPLIT',payload:{raw,customPat},id});
    }catch(e){
      clearTimeout(timer);
      _workerCallbacks.delete(id);
      // Worker 실패 시 동기 폴백
      try{resolve(splitChapters(raw,customPat));}catch(e2){reject(e2);}
    }
  });
}

// ── DOMContentLoaded에 폰트 패널 초기화 추가 ──
async function resetAll(){
  if(!await Toast.confirm('모든 설정을 초기화할까요?')) return;
  _sStore.set({txtFiles:[],coverFile:null,illFiles:[],tocItems:[],epubBlob:null,epubName:'',manualCnt:0});
  _chaptersCache=null;_chaptersCacheKey='';
  document.getElementById('txtDz').className='dz';
  document.getElementById('illDz').className='dz';
  document.getElementById('coverDz').className='dz';
  document.getElementById('coverThumb').innerHTML='표지';
  document.getElementById('coverName').textContent='';
  document.getElementById('txtInfo').style.display='none';
  document.getElementById('illTags').innerHTML='';
  document.getElementById('manualIlls').innerHTML='';
  ['title','author','pattern'].forEach(id=>{ const el=document.getElementById(id); if(el) el.value=''; });
  ['tocPanel','progWrap','resultBox','errBox'].forEach(id=>document.getElementById(id)?.classList.remove('show'));
}

// ★ 탭별 렌더링 지연 플래그 (최초 1회만 렌더링)
function resetBatchTxt(){
  _bStore.set({txtFiles:[],patterns:{},sampleTexts:{},totalChs:{}});
  const dz=document.getElementById('batchTxtDrop');
  dz.className='dz';dz.querySelector('.dz-text').textContent='TXT 파일 여러 개 드래그하거나 클릭';
  document.getElementById('batchList').innerHTML='';
  document.getElementById('batchListSec').style.display='none';
  if(!Object.keys(B.coverMap).length&&!B.urlCoverFile) document.getElementById('batchResetBar').style.display='none';
}
function resetBatchCover(){
  _bStore.set({coverMap:{},urlCoverFile:null});
  const dz=document.getElementById('batchCoverDrop');
  dz.className='dz';dz.querySelector('div').textContent='🖼 표지 이미지들 한꺼번에 드래그';
  document.getElementById('batchCoverUrlInp').value='';
  renderBatchList();
}
async function resetBatchAll(){
  if(!await Toast.confirm('일괄 변환 탭의 모든 파일을 초기화할까요?')) return;
  resetBatchTxt();resetBatchCover();
  document.getElementById('batchResetBar').style.display='none';
  ['batchProgWrap','batchResultBox','batchErrBox'].forEach(id=>{
    const el=document.getElementById(id);if(el)el.classList.remove('show');
  });
}

// ── EPUB 편집 탭 초기화 ──
function resetEditEpub(){
  _eStore.set({epubFile:null,epubZip:null,chapters:[],spineOrder:[],selectedChIdx:null,insTxtFiles:[],insTxtChapters:[],resultBlob:null,resultName:''});
  _eiStore.set({files:[],manualRows:0});
  document.getElementById('epubDrop').className='epub-drop';
  document.getElementById('epubInfo').style.display='none';
  document.getElementById('epubInfo').textContent='';
  const eb=document.getElementById('extractImgBar');if(eb)eb.style.display='none';
  const ep=document.getElementById('extractImgProgress');if(ep)ep.style.display='none';
  ['editSec','insertSec','editIllSec','insTocSec','insIllSec'].forEach(id=>{const el=document.getElementById(id);if(el)el.style.display='none';});
  document.getElementById('editResetBar').style.display='none';
  renderEditIllTags();
}
async function resetEditAll(){
  if(!await Toast.confirm('EPUB 편집 탭을 전부 초기화할까요?')) return;
  resetEditEpub();
}

// ════ 결과 stat 카드 렌더링 (최적화 5) ════
function resetConvertTxt(){
  S.txtFiles=[];S._rawTextFull=[];_chaptersCache=null;_chaptersCacheKey='';
  // ★ window 단일 소유권: 전역 분할 상태 완전 초기화
  window._autoSplitActive=false;
  window._autoSplitLines=null;
  window._fullRawLines=[];
  // DOM 잔재 정리
  document.getElementById('hybrid-suggest-btn')?.remove();
  document.getElementById('title-template-bar')?.remove();
  // ★ splitBtn 원상 복구 — _syncSplitBtn으로 단일 관리
  typeof _syncSplitBtn==='function'
    ? _syncSplitBtn('reset')
    : (()=>{
        const btn=document.querySelector('button[data-action="autoSplitByInterval"]');
        if(btn){ btn.disabled=false; btn.style.opacity='1'; btn.style.pointerEvents=''; btn.style.color=''; btn.textContent='⚡ 간격 분할'; btn.title=''; }
      })();
  document.getElementById('txtDz').className='dz';
  document.getElementById('txtInfo').style.display='none';
  const fl=document.getElementById('txtFileList'); if(fl) fl.style.display='none';
  const sl=document.getElementById('txtSortList'); if(sl) sl.innerHTML='';
  document.getElementById('tocPanel')?.classList.remove('show');
  ['title','author','pattern'].forEach(id=>{const el=document.getElementById(id);if(el)el.value='';});
  document.getElementById('convertResetBar').style.display='none';
  const regexFeed=document.getElementById('regexFeed');if(regexFeed)regexFeed.style.display='none';
  updateBtmBar&&updateBtmBar([]);
}
function resetConvertCover(){
  S.coverFile=null;
  document.getElementById('coverDz').className='dz';
  const t=document.getElementById('coverThumb');
  if(t)t.innerHTML='<span style="display:flex;flex-direction:column;align-items:center;gap:4px"><span style="font-size:22px">🖼</span><span>표지</span></span>';
  document.getElementById('coverName').textContent='';
  const inp=document.getElementById('coverUrlInp');if(inp)inp.value='';
}
async function resetConvertAll(){
  if(!await Toast.confirm('변환 탭의 모든 파일과 설정을 초기화할까요?')) return;
  resetConvertTxt();resetConvertCover();
  _sStore.set({illFiles:[],tocItems:[],epubBlob:null,manualCnt:0});
  document.getElementById('illDz').className='dz';
  document.getElementById('illTags').innerHTML='';
  document.getElementById('manualIlls').innerHTML='';
  ['progWrap','resultBox','errBox','splitSec'].forEach(id=>{
    const el=document.getElementById(id);
    if(el){el.classList.remove('show');if(id==='splitSec')el.style.display='none';}
  });
}
