// ════════════════════════════════════════════════════════════
// cover-search.js — 표지 검색 모달, 플랫폼 어댑터, 프록시
// NovelEPUB | TXT → EPUB3
//
// 의존성: core.js (Toast, S, B, CORS_PROXY_URL, proxyGet, proxyGetBlob, RecoverableError)
// Phase 4 개선:
//   CS-01: PROXIES/proxyFetch를 core.js proxyGet으로 교체
//   CS-02: centerCropToBlob — proxyGetBlob 경유 + crossOrigin 강제 설정
//   CS-03: proxyImgUrl — CORS_PROXY_URL 상수 사용
// ════════════════════════════════════════════════════════════

/* global Toast, S, B, escHtml, getCssVar,
   CORS_PROXY_URL, proxyGet, proxyGetBlob, RecoverableError */

'use strict';

// ══════════════════════════════════════════
// 🌐 Module: CoverSearch (표지 검색 모달)
// ══════════════════════════════════════════
let _coverModalMode='convert';
let _searchAbortCtrl=null;

// ── 검색용 순수 제목 추출 ──
function extractSearchTitle(raw) {
  let t = raw
    .replace(/\.txt$/i, '')
    .replace(/[(\[{][^)\]}]{0,20}[)\]}]/g, '')
    .replace(/^.+?@\s*/, '')
    .replace(/@.+$/, '')
    .replace(/^[^가-힣a-zA-Z\d]+/, '')
    .replace(/[^가-힣a-zA-Z\d]+$/, '')
    .trim();
  return t || raw.replace(/\.txt$/i, '');
}

// ── 유효 이미지 확장자 검사 (.file 대응 가드 포함) ──
function isValidImg(url) {
  if(!url || typeof url !== 'string') return false;
  // ★ BUG-2 FIX: //로 시작하는 프로토콜 상대경로도 유효 이미지로 판별
  // 기존: //cdn.novelpia.com/.../cover.file → false (http로 시작 안 해서 탈락)
  if(url.startsWith('blob:') || url.startsWith('data:')) return true;
  const normalized = url.startsWith('//') ? 'https:' + url : url;
  if(!normalized.startsWith('http')) return false;
  const s = normalized.toLowerCase().split('?')[0];
  // 확장자 허용 목록 (.file 포함 — 노벨피아 등)
  if(s.endsWith('.jpg') || s.endsWith('.jpeg') || s.endsWith('.png') ||
     s.endsWith('.webp') || s.endsWith('.gif') || s.endsWith('.file')) return true;
  // 확장자 없어도 이미지 힌트 키워드 포함 시 허용
  return s.includes('cover') || s.includes('thumb') ||
         s.includes('novel') || s.includes('image');
}

// ── 안전한 프록시 이미지 URL 생성 ──
function proxyImgUrl(url) {
  if(!url) return '';
  if(url.startsWith('data:') || url.startsWith('blob:')) return url;
  // ★ BUG-1/BUG-13 FIX: CORS_PROXY_URL 자체가 이미 '?url=' 로 끝남
  // core.js: CORS_PROXY_URL = 'https://icy-frog-a6c0.tlsxo213.workers.dev/?url='
  // 따라서 여기서 추가 '?url=' 없이 바로 encodeURIComponent(url) 만 붙여야 함
  const base = (typeof CORS_PROXY_URL !== 'undefined' ? CORS_PROXY_URL
    : 'https://icy-frog-a6c0.tlsxo213.workers.dev/?url=');
  try {
    return base + encodeURIComponent(decodeURIComponent(url));
  } catch(e) {
    return base + encodeURIComponent(url);
  }
}

// ── 캔버스 중앙 크롭 가공 및 세션 전송 (Tainted Canvas 방어) ──
async function centerCropToBlob(imgUrl) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.crossOrigin = 'anonymous';

    img.onload = () => {
      try {
        const cw = img.naturalWidth;
        const ch = img.naturalHeight;
        if (cw <= 0 || ch <= 0) {
          reject(new Error('이미지 크기가 올바르지 않습니다.'));
          return;
        }
        
        let targetW = 400;
        let targetH = 600;
        
        const canvas = document.createElement('canvas');
        canvas.width = targetW;
        canvas.height = targetH;
        const ctx = canvas.getContext('2d');
        if (!ctx) {
          reject(new Error('Canvas 가동 실패'));
          return;
        }

        let srcX = 0, srcY = 0, srcW = cw, srcH = ch;
        const currentRatio = cw / ch;
        const targetRatio = targetW / targetH;

        if (currentRatio > targetRatio) {
          srcW = ch * targetRatio;
          srcX = (cw - srcW) / 2;
        } else {
          srcH = cw / targetRatio;
          srcY = (ch - srcH) / 2;
        }

        ctx.drawImage(img, srcX, srcY, srcW, srcH, 0, 0, targetW, targetH);
        
        canvas.toBlob((blob) => {
          if (blob) resolve(blob);
          else reject(new Error('Canvas Blob 추출 실패'));
        }, 'image/jpeg', 0.88);
      } catch (err) {
        reject(err);
      }
    };

    img.onerror = () => {
      reject(new Error('표지 이미지 렌더링에 실패했습니다. (CORS 가드 걸림)'));
    };

    // core.js의 proxyGetBlob을 통해 안전한 가공용 로컬 Blob ObjectURL로 우회 공급
    if (typeof proxyGetBlob === 'function') {
      proxyGetBlob(imgUrl)
        .then(blob => {
          const lUrl = URL.createObjectURL(blob);
          // ★ BUG-14 FIX: img 로드 완료 후 ObjectURL 즉시 해제 → 메모리 누수 방지
          // onload/onerror 두 경로 모두 revoke 처리
          const _origOnload = img.onload;
          const _origOnerror = img.onerror;
          img.onload = function() {
            URL.revokeObjectURL(lUrl);
            if(_origOnload) _origOnload.call(img);
          };
          img.onerror = function() {
            URL.revokeObjectURL(lUrl);
            if(_origOnerror) _origOnerror.call(img);
          };
          img.src = lUrl;
        })
        .catch(() => {
          // proxyGetBlob 실패 시 proxyImgUrl 경유로 폴백
          img.src = proxyImgUrl(imgUrl);
        });
    } else {
      img.src = proxyImgUrl(imgUrl);
    }
  });
}

// ── 모달 열기 제어 ──
function openCoverSearchModal(mode='convert') {
  try{
    _coverModalMode = mode;
    // ★ ID 확정: index.html 실제 모달 ID = 'coverModal'
    const el = document.getElementById('coverModal');
    if(!el){ console.error('[openCoverSearchModal] #coverModal 없음'); return; }
    el.classList.add('show');

    let titleInput = '';
    if(mode === 'convert') {
      const files = (typeof S !== 'undefined') ? (S.txtFiles || []) : [];
      if(files.length > 0) titleInput = extractSearchTitle(files[0].name);
    } else {
      const batch = (typeof S !== 'undefined') ? (S.batch || {}) : {};
      titleInput = batch.currentSearchTitle || '';
    }

    // ★ ID 교정: index.html 실제 입력창 ID = 'coverSearchQ'
    const qIn = document.getElementById('coverSearchQ');
    if(qIn){
      qIn.value = titleInput;
      qIn.focus();
    }

    // ★ replaceChildren(): 이전 검색 결과 GC 친화적 초기화
    // index.html 실제 결과 컨테이너 ID = 'coverModalBody'
    const grid = document.getElementById('coverModalBody');
    if(grid){
      grid.replaceChildren();
      const hint = document.createElement('div');
      hint.style.cssText = 'text-align:center;padding:40px 0;color:var(--text2);font-size:13px';
      hint.innerHTML = '소설 제목을 입력하고 검색하면<br>네이버·리디·카카오페이지·노벨피아·구글에서 동시 검색해요';
      grid.appendChild(hint);
    }

    if(titleInput) runCoverSearch();
  }catch(err){
    console.error('[openCoverSearchModal]', err);
    if(typeof Toast !== 'undefined') Toast.error('표지 검색 모달을 여는 중 오류가 발생했습니다.');
  }
}

function closeCoverSearchModal() {
  try{
    if(_searchAbortCtrl) { _searchAbortCtrl.abort(); _searchAbortCtrl = null; }
    document.getElementById('coverModal')?.classList.remove('show');
  }catch(err){
    console.error('[closeCoverSearchModal]', err);
  }
}

// ── 검색 트리거 핸들러 ──
// ★ index.html data-action="runCoverSearch" 에서 호출되는 함수
function runCoverSearch() {
  // ★ ID 교정: index.html 실제 입력창 ID = 'coverSearchQ'
  const q = document.getElementById('coverSearchQ')?.value?.trim() || '';
  if(!q) { if(typeof Toast!=='undefined') Toast.info('검색어를 입력해 주세요.'); return; }

  // ★ ID 교정: index.html 실제 결과 컨테이너 ID = 'coverModalBody'
  const grid = document.getElementById('coverModalBody');
  if(grid){
    grid.replaceChildren();
    const loadingEl = document.createElement('div');
    loadingEl.className = 'cover-search-loading';
    loadingEl.innerHTML = '<span class="spinner"></span> 소설 표지를 탐색하는 중...';
    grid.appendChild(loadingEl);
  }

  if(_searchAbortCtrl) _searchAbortCtrl.abort();
  _searchAbortCtrl = new AbortController();

  searchAllPlatforms(q)
    .then(items => {
      if(!items || items.length === 0) {
        if(grid){
          grid.replaceChildren();
          const emptyEl = document.createElement('div');
          emptyEl.className = 'cover-search-empty';
          emptyEl.innerHTML = '🔍 검색 결과가 없습니다.<br>다른 단어로 다시 시도해 보세요.';
          grid.appendChild(emptyEl);
        }
        return;
      }
      renderCoverSearchResults(items);
    })
    .catch(err => {
      if(err.name === 'AbortError') return;
      if(grid){
        grid.replaceChildren();
        const errEl = document.createElement('div');
        errEl.className = 'cover-search-empty';
        errEl.innerHTML = `⚠️ 오류가 발생했습니다.<br><span style="font-size:11px;color:var(--text3)">${escHtml(err.message)}</span>`;
        grid.appendChild(errEl);
      }
    });
}

// ★ 하위 호환 별칭 — 기존 코드에서 triggerCoverSearch()로 호출하던 경우 대응
const triggerCoverSearch = runCoverSearch;

// ── 외부 플랫폼 어댑터 종합 스캔 ──
async function searchAllPlatforms(q) {
  let results = [];
  // ★ BUG-3/17 FIX: 중단 신호 레퍼런스 캡처 — 각 await 진입 전 중단 체크
  // _searchAbortCtrl.abort() 호출 시 진행 중인 순차 await를 조기 탈출
  const _abortRef = _searchAbortCtrl;
  function _aborted(){ return _abortRef && _abortRef.signal && _abortRef.signal.aborted; }

  // 1. 플랫폼 다이렉트 패치 스케줄링
  if(!_aborted()) try {
    const ridi = await fetchRidiCover(q);
    if(ridi && ridi.length) results = results.concat(ridi);
  } catch(e){ if(e && e.name==='AbortError') return []; }

  if(!_aborted()) try {
    const kakao = await fetchKakaoCover(q);
    if(kakao && kakao.length) results = results.concat(kakao);
  } catch(e){ if(e && e.name==='AbortError') return []; }

  if(!_aborted()) try {
    const naver = await fetchNaverSeriesCover(q);
    if(naver && naver.length) results = results.concat(naver);
  } catch(e){ if(e && e.name==='AbortError') return []; }

  if(!_aborted()) try {
    const novelpia = await fetchNovelpiaCover(q);
    if(novelpia && novelpia.length) results = results.concat(novelpia);
  } catch(e){ if(e && e.name==='AbortError') return []; }

  // 2. 통합 웹 검색엔진 폴백 스캔
  if(!_aborted() && results.length < 3) {
    try {
      const web = await fetchWebFallbackCovers(q);
      if(web && web.length) results = results.concat(web);
    } catch(e){ if(e && e.name==='AbortError') return []; }
  }

  // 중복 이미지 주소 필터링
  const seen = new Set();
  return results.filter(item => {
    if(!item.image || seen.has(item.image)) return false;
    seen.add(item.image);
    return true;
  });
}

// ── 플랫폼별 상세 크롤러 구현체 ──
async function fetchRidiCover(q) {
  try {
    const html = await proxyFetch(`https://ridibooks.com/search?q=${encodeURIComponent(q)}&adult_exclude=n`);
    const doc = new DOMParser().parseFromString(html, 'text/html');
    const items = [];
    doc.querySelectorAll('.thumbnail_wrapper').forEach(div => {
      const img = div.querySelector('img.thumbnail');
      const titleEl = div.closest('.book_macro_100')?.querySelector('.title_text');
      if(img) {
        let src = img.getAttribute('data-src') || img.src || '';
        if(src.startsWith('//')) src = 'https:' + src;
        if(isValidImg(src)) {
          items.push({
            title: titleEl?.textContent?.trim() || q,
            image: src.replace('/w=110', '/w=400') // 화질 개선 고해상도 리사이징 업스케일 적용
          });
        }
      }
    });
    return items.slice(0, 6);
  } catch(e) { return []; }
}

async function fetchKakaoCover(q) {
  try {
    const html = await proxyFetch(`https://page.kakao.com/search/result?keyword=${encodeURIComponent(q)}&categoryUid=11`);
    const match = html.match(/\\"gId\\":\\"([^\\"]+)\\",\\"title\\":\\"([^\\"]+)\\",.*?\\"backgroundImage\\":\\"([^\\"]+)\\"/g);
    if(!match) return [];
    
    const items = [];
    match.forEach(m => {
      const tM = m.match(/\\"title\\":\\"([^\\"]+)\\"/);
      const iM = m.match(/\\"backgroundImage\\":\\"([^\\"]+)\\"/);
      if(tM && iM) {
        let img = iM[1].replace(/\\\\/g, '');
        if(!img.startsWith('http')) img = 'https:' + img;
        if(isValidImg(img)) {
          items.push({ title: tM[1], image: img });
        }
      }
    });
    return items.slice(0, 6);
  } catch(e) { return []; }
}

async function fetchNaverSeriesCover(q) {
  try {
    const html = await proxyFetch(`https://series.naver.com/search/search.nhn?t=novel&q=${encodeURIComponent(q)}`);
    const doc = new DOMParser().parseFromString(html, 'text/html');
    const items = [];
    doc.querySelectorAll('.lst_list li').forEach(li => {
      const img = li.querySelector('img');
      const titleEl = li.querySelector('dt a');
      if(img) {
        let src = img.src || '';
        if(isValidImg(src)) {
          items.push({
            title: titleEl?.textContent?.trim() || q,
            image: src.replace('type=m81_118', 'type=m400_600') // 네이버 고해상도 변환
          });
        }
      }
    });
    return items.slice(0, 6);
  } catch(e) { return []; }
}

async function fetchNovelpiaCover(q) {
  try {
    const html = await proxyFetch(`https://novelpia.com/proc/search_all?search_word=${encodeURIComponent(q)}`);
    const doc = new DOMParser().parseFromString(html, 'text/html');
    const items = [];
    doc.querySelectorAll('.novel-box').forEach(box => {
      const img = box.querySelector('img');
      const titleEl = box.querySelector('.novel-title');
      if(img) {
        let src = img.src || '';
        if(src.startsWith('//')) src = 'https:' + src;
        if(isValidImg(src)) {
          items.push({
            title: titleEl?.textContent?.trim() || q,
            image: src.replace('/35/', '/300/') // 고화질 주소 치환
          });
        }
      }
    });
    return items.slice(0, 6);
  } catch(e) { return []; }
}

async function fetchWebFallbackCovers(q) {
  const items = [];
  const seen = new Set();
  
  try {
    const html = await proxyFetch(`https://html.duckduckgo.com/html/?q=${encodeURIComponent(q + ' 소설 표지')}`);
    const doc = new DOMParser().parseFromString(html, 'text/html');
    if(doc.querySelectorAll('img[src]').length) {
      doc.querySelectorAll('img[src]').forEach(img => {
        const src = img.getAttribute('src') || '';
        if(!seen.has(src) && isValidImg(src) && !src.includes('bing.com/th')) {
          seen.add(src);
          items.push({ title: img.alt || q, image: src });
        }
      });
    }
    if(items.length) return items.slice(0, 12);
  } catch(e){}

  try {
    const html = await proxyFetch(`https://search.naver.com/search.naver?where=image&query=${encodeURIComponent(q + ' 소설 표지')}&sm=tab_srt&sort=0`);
    const doc = new DOMParser().parseFromString(html, 'text/html');
    const txt = doc.documentElement.innerHTML;
    const matches = txt.match(/"originalUrl":"([^"]+)"/g);
    if(matches) {
      matches.forEach(m => {
        const u = m.match(/"originalUrl":"([^"]+)"/)[1];
        if(!seen.has(u) && isValidImg(u)) {
          seen.add(u);
          items.push({ title: q, image: u });
        }
      });
    }
  } catch(e){}

  return items.slice(0, 12);
}

// ── 결과 아이템 화면 렌더링 ──
function renderCoverSearchResults(items) {
  // ★ ID 교정: index.html 실제 결과 컨테이너 ID = 'coverModalBody'
  const grid = document.getElementById('coverModalBody');
  if(!grid) return;
  grid.replaceChildren(); // GC 친화적 초기화

  items.forEach(item => {
    const card = document.createElement('div');
    card.className = 'cover-search-card';
    
    const imgWrap = document.createElement('div');
    imgWrap.className = 'cover-search-card-img';
    
    const img = document.createElement('img');
    img.alt = item.title;
    img.loading = 'lazy';
    // 로딩 시점에는 안전 프록시 포맷 바인딩
    img.src = proxyImgUrl(item.image); 

    const info = document.createElement('div');
    info.className = 'cover-search-card-info';
    info.innerHTML = `<div class=\"cover-search-card-title\">${escHtml(item.title)}</div>
                      <div class=\"cover-search-card-url\">${escHtml(item.image)}</div>`;

    imgWrap.appendChild(img);
    card.appendChild(imgWrap);
    card.appendChild(info);

    card.onclick = () => {
      const gridCards = grid.querySelectorAll('.cover-search-card');
      gridCards.forEach(c => c.classList.remove('selected'));
      card.classList.add('selected');
      
      selectSearchedCover(item.image);
    };

    grid.appendChild(card);
  });
}

// ── 최종 선택 및 수집 데이터 유기적 전달 ──
async function selectSearchedCover(imgUrl) {
  let _loadingDismiss = null;
  if(typeof Toast.info === 'function' && Toast.info.length >= 2) {
    _loadingDismiss = Toast.info('선택한 표지를 다운로드 및 크롭 가공하는 중입니다...');
  } else {
    Toast.info('선택한 표지를 다운로드 및 크롭 가공하는 중입니다...');
  }
  try {
    const blob = await centerCropToBlob(imgUrl);
    if(typeof _loadingDismiss === 'function') _loadingDismiss();

    const fileObj = new File([blob], 'cover.jpg', { type: 'image/jpeg' });

    if(_coverModalMode === 'convert') {
      // ── convert 탭: #coverThumb의 구형 Blob URL 명시적 해제 후 새 표지 적용 ──
      // window.setCoverFile은 미정의 심볼 → handleCover([])/S.coverFile 직접 경로로 폴백
      const thumb = document.getElementById('coverThumb');
      if(thumb){
        // ★ 3단계: 기존 Blob URL 명시적 해제 — 메모리 누수 방지
        const prevImg = thumb.querySelector('img[data-blob-url]');
        if(prevImg && prevImg.dataset.blobUrl){
          URL.revokeObjectURL(prevImg.dataset.blobUrl);
        }
      }
      if(typeof window.setCoverFile === 'function'){
        // convert.js에서 노출된 경우 사용
        window.setCoverFile(fileObj);
      } else if(typeof handleCover === 'function'){
        // ★ 구조적 수정: handleCover 직접 호출로 S.coverFile + coverThumb + coverDz 동기화
        handleCover([fileObj]);
      } else {
        // 최후 폴백: 상태만 직접 설정
        if(typeof S !== 'undefined') S.coverFile = fileObj;
        const objUrl = URL.createObjectURL(fileObj);
        if(thumb){
          thumb.innerHTML = '';
          const img = document.createElement('img');
          img.src = objUrl;
          img.dataset.blobUrl = objUrl;
          thumb.appendChild(img);
        }
        document.getElementById('coverDz')?.classList.add('ok');
        const coverName = document.getElementById('coverName');
        if(coverName) coverName.textContent = '✅ 검색 표지 적용';
      }
    } else {
      // ── batch 탭 경로 ──
      if(typeof window.setBatchSelectedCover === 'function') {
        window.setBatchSelectedCover(fileObj, imgUrl);
      } else {
        // ★ S.batch undefined TypeError 방어 가드
        if(typeof S !== 'undefined'){
          S.batch = S.batch || {};
          S.batch.coverMap = S.batch.coverMap || {};
          S.batch.coverMap['selected'] = fileObj;
        }
        Toast.success('일괄 변환 타깃 표지 등록 완료');
      }
    }

    closeCoverSearchModal();
    Toast.success('표지가 성공적으로 반영되었습니다.');

  } catch(err) {
    if(typeof _loadingDismiss === 'function') _loadingDismiss();
    console.error('[selectSearchedCover]', err);
    // ★ 3단계: RecoverableError 분기 — 전체 스크립트 프리징 없이 Toast로 안전 우회
    if(typeof RecoverableError !== 'undefined' && err instanceof RecoverableError){
      Toast.warn('⚠️ 표지 처리 중 복구 가능한 오류: ' + err.message);
    } else {
      Toast.error(err.message || '표지 수집 중 예외 가드가 작동했습니다.');
    }
  }
}

// ── 🌐 인프라 동기화 전용 proxyFetch 통합 리팩토링 ──
// ★ 3단계: try-catch 강화 — 네트워크 에러/CORS 차단 시 전체 스크립트 프리징 방지
async function proxyFetch(url, timeout = 9000) {
  // 1순위: core.js의 전역 proxyGet 인프라 경유
  // — core.js proxyGet이 Failover·토큰·타임아웃·이중?url= 방지 모두 처리함
  if (typeof window.proxyGet === 'function') {
    try {
      return await window.proxyGet(url, timeout);
    } catch(e) {
      // proxyGet 자체가 RecoverableError를 던지는 경우 그대로 전파
      if(typeof RecoverableError !== 'undefined' && e instanceof RecoverableError) throw e;
      // 그 외 오류는 폴백 레이어로 계속 진행
      console.warn('[proxyFetch] proxyGet 실패, 직접 폴백 시도:', e.message);
    }
  }

  // 2순위: 직접 폴백 — 이중 ?url= 방지 + AbortController 타임아웃
  // ★ BUG-15 확인: CORS_PROXY_URL 자체가 '?url='로 끝나므로 추가 ?url= 절대 붙이지 않음
  const _proxyBase = (typeof CORS_PROXY_URL !== 'undefined'
    ? CORS_PROXY_URL
    : 'https://icy-frog-a6c0.tlsxo213.workers.dev/?url=');

  // ★ URL 안전 인코딩 — 특수문자·유니코드 완전 처리 (이중 인코딩 방지)
  let _encodedUrl;
  try { _encodedUrl = encodeURIComponent(decodeURIComponent(url)); }
  catch(e) { _encodedUrl = encodeURIComponent(url); }

  const target = _proxyBase + _encodedUrl;

  // ★ AbortController 기반 타임아웃 가드
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeout);

  try {
    const res = await fetch(target, {
      signal: ctrl.signal,
      headers: {
        'X-NovelEPUB-Token': (typeof _PROXY_TOKEN !== 'undefined'
          ? _PROXY_TOKEN
          : 'novelepub-secure-token'),
        'Cache-Control': 'no-cache',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
      },
    });
    clearTimeout(timer);
    if(!res.ok){
      // ★ 4xx는 RecoverableError로 Toast 표시, 5xx는 일반 Error로 throw
      const statusMsg = `HTTP ${res.status}`;
      if(res.status >= 400 && res.status < 500){
        throw typeof RecoverableError !== 'undefined'
          ? new RecoverableError(`[CORS Proxy ${statusMsg}] ${url.slice(0,60)}`, { context: 'proxyFetch' })
          : new Error(statusMsg);
      }
      throw new Error(statusMsg);
    }
    return await res.text();
  } catch(e) {
    clearTimeout(timer);
    if(e.name === 'AbortError'){
      const timeoutErr = typeof RecoverableError !== 'undefined'
        ? new RecoverableError(`[Proxy Timeout] ${timeout}ms 초과 — ${url.slice(0,50)}`, { context: 'proxyFetch' })
        : new Error('Proxy timeout');
      throw timeoutErr;
    }
    throw e;
  }
}

// ══════════════════════════════════════════
// ★ window 명시적 노출
// const 스코프 문제 원천 차단 + ui-state.js EventDelegate 호출 이름과 100% 일치
// index.html data-action 매핑:
//   data-action="openCoverModal"   → openCoverModal()
//   data-action="closeCoverModal"  → closeCoverModal()
//   data-action="runCoverSearch"   → runCoverSearch()
//   data-action="abortCoverSearch" → abortCoverSearch()
// ══════════════════════════════════════════

// EventDelegate에서 호출하는 이름으로 노출
window.openCoverModal      = (mode) => openCoverSearchModal(mode || 'convert');
window.closeCoverModal     = closeCoverSearchModal;
window.runCoverSearch      = runCoverSearch;
window.abortCoverSearch    = () => { if(_searchAbortCtrl){ _searchAbortCtrl.abort(); _searchAbortCtrl=null; } };

// 기존 이름도 유지 (하위 호환)
window.openCoverSearchModal  = openCoverSearchModal;
window.closeCoverSearchModal = closeCoverSearchModal;
window.triggerCoverSearch    = runCoverSearch;