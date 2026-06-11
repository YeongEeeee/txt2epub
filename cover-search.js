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
// ── 검색용 순수 제목 추출 (권차·화수·노이즈 정제 강화) ──
function extractSearchTitle(raw) {
  if(!raw) return '';
  let t = raw
    // 1. 확장자 제거
    .replace(/\.txt$/i, '')
    // 2. 대괄호/소괄호/중괄호 안 내용 제거 (최대 20자 — ReDoS 방어)
    .replace(/[(\[{][^)\]}]{0,20}[)\]}]/g, '')
    // 3. "작가명@제목" 패턴 — @ 앞 작가명 제거
    .replace(/^.+?@\s*/, '')
    .replace(/@.+$/, '')
    // 4. 뒤에 붙는 화수/권차/부 노이즈 제거
    //    예: "웹소설제목 123화", "작품명 2권", "소설 3부", "v2.5"
    .replace(/\s*\d+\s*(?:화|권|부|부록|화차|장|편|막|v[\d.]+).*$/i, '')
    // 5. 완결·연재 표기 제거
    .replace(/\s*(?:완결?|완전판|전권|전편|번외|후일담|외전|특별판|최종화|연재중|연재|단행본|개정판|리마스터)\s*$/i, '')
    // 6. 앞뒤 비한글/비영문/비숫자 제거
    .replace(/^[^가-힣a-zA-Z\d]+/, '')
    .replace(/[^가-힣a-zA-Z\d]+$/, '')
    .trim();
  return t || raw.replace(/\.txt$/i, '').trim();
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

// ══════════════════════════════════════════════════════════════
// ★ 이미지 전용 다중 프록시 폴백 체인
//
// 문제: artmug.kr 등 Hotlinking 방지 서버가 Referer/Origin 헤더를 체크하여
//       단순 CORS 프록시(Workers)가 그대로 헤더를 전달하면 403 반환
//
// 해결: Referer 헤더 제거 또는 리라이팅이 내장된 이미지 가속 프록시를 순서대로 시도
//   1순위: images.weserv.nl   — Referer 자동 제거, 이미지 전용, 무료
//   2순위: Workers 프록시     — 자체 인프라, Referer 그대로 전달 (일부 사이트 통과)
//   3순위: 직접 fetch          — CORS 허용 서버만 통과, blob 반환
//
// ★ images.weserv.nl 쿼리스트링 규격:
//   https://images.weserv.nl/?url={원본URL} — 프로토콜 없이 인코딩
//   (https://는 자동 처리, http://도 지원)
// ══════════════════════════════════════════════════════════════

const _IMG_PROXY_CHAIN = [
  // 1순위: weserv.nl — Referer 헤더 제거 내장, Hotlinking 방지 우회
  {
    name: 'weserv',
    buildUrl(rawUrl) {
      // weserv는 프로토콜 포함 URL을 encodeURIComponent로 전달
      // https:// 또는 http:// 모두 지원
      const u = rawUrl.startsWith('//') ? 'https:' + rawUrl : rawUrl;
      return 'https://images.weserv.nl/?url=' + encodeURIComponent(u)
        + '&output=jpg&q=92';  // JPEG 출력 강제 + 품질 지정
    },
    // weserv 응답은 항상 이미지이므로 Content-Type 추가 검증 불필요
    noCredentials: true,
  },
  // 2순위: Workers 자체 프록시 (X-NovelEPUB-Token 인증 포함)
  {
    name: 'workers',
    buildUrl(rawUrl) {
      const base = (typeof CORS_PROXY_URL !== 'undefined'
        ? CORS_PROXY_URL
        : 'https://icy-frog-a6c0.tlsxo213.workers.dev/?url=');
      try { return base + encodeURIComponent(decodeURIComponent(rawUrl)); }
      catch(e) { return base + encodeURIComponent(rawUrl); }
    },
    headers: {
      'X-NovelEPUB-Token': (typeof _PROXY_TOKEN !== 'undefined'
        ? _PROXY_TOKEN : 'novelepub-secure-token'),
      'Cache-Control': 'no-cache',
    },
  },
  // 3순위: 직접 fetch (CORS 허용 서버만 통과 — 최후 수단)
  {
    name: 'direct',
    buildUrl(rawUrl) {
      return rawUrl.startsWith('//') ? 'https:' + rawUrl : rawUrl;
    },
    headers: { 'Cache-Control': 'no-cache' },
  },
];

/**
 * _fetchImgBlob — 이미지 URL을 Blob으로 가져오는 다중 프록시 폴백 함수
 * @param {string} imgUrl  원본 이미지 URL
 * @param {number} [timeout=8000]  각 프록시 시도당 타임아웃 (ms)
 * @returns {Promise<Blob>}  이미지 Blob (JPEG 또는 원본 MIME)
 */
async function _fetchImgBlob(imgUrl, timeout = 8000) {
  // data:/blob: URL은 프록시 불필요
  if(imgUrl.startsWith('data:') || imgUrl.startsWith('blob:')){
    const res = await fetch(imgUrl);
    return await res.blob();
  }

  // //로 시작하는 프로토콜 상대경로 정규화
  const normalizedUrl = imgUrl.startsWith('//') ? 'https:' + imgUrl : imgUrl;

  // ★ weserv URL이 이미 들어온 경우: 중복 래핑 방지 + 즉시 직접 fetch
  // renderCoverSearchResults에서 weservUrl을 selectSearchedCover에 전달하므로
  // 이 경우 _IMG_PROXY_CHAIN의 weserv 빌드 없이 바로 fetch
  if(normalizedUrl.startsWith('https://images.weserv.nl')){
    const ctrl  = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeout);
    try{
      const resp = await fetch(normalizedUrl, {
        signal:      ctrl.signal,
        credentials: 'omit',
        headers:     { 'Cache-Control': 'no-cache' },
      });
      clearTimeout(timer);
      if(resp.ok){
        const ab   = await resp.arrayBuffer();
        const ct   = resp.headers.get('Content-Type') || 'image/jpeg';
        const mime = ct.split(';')[0].trim();
        if(ab.byteLength >= 1024){
          return new Blob([ab], { type: mime.startsWith('image/') ? mime : 'image/jpeg' });
        }
      }
      // weserv 응답 실패 시 원본 URL 추출 후 일반 체인으로 폴백
      const m = normalizedUrl.match(/[?&]url=([^&]+)/);
      const fallbackUrl = m ? decodeURIComponent(m[1]) : normalizedUrl;
      return _fetchImgBlob(fallbackUrl, timeout);
    }catch(e){
      clearTimeout(timer);
      // 타임아웃/네트워크 오류 → 원본 URL 추출 폴백
      const m = normalizedUrl.match(/[?&]url=([^&]+)/);
      const fallbackUrl = m ? decodeURIComponent(m[1]) : normalizedUrl;
      if(fallbackUrl !== normalizedUrl) return _fetchImgBlob(fallbackUrl, timeout);
      throw e;
    }
  }

  let lastErr = null;

  for(const proxy of _IMG_PROXY_CHAIN){
    const proxyUrl = proxy.buildUrl(normalizedUrl);
    const ctrl     = new AbortController();
    const timer    = setTimeout(() => ctrl.abort(), timeout);

    try{
      const fetchOpts = {
        signal:      ctrl.signal,
        headers:     proxy.headers || {},
        credentials: proxy.noCredentials ? 'omit' : 'same-origin',
      };

      const resp = await fetch(proxyUrl, fetchOpts);
      clearTimeout(timer);

      // 403/401: Hotlinking 차단 → 다음 프록시로
      if(resp.status === 403 || resp.status === 401){
        console.warn(`[_fetchImgBlob] ${proxy.name} → ${resp.status}, 다음 프록시 시도`);
        lastErr = new Error(`${proxy.name}: HTTP ${resp.status}`);
        continue;
      }

      if(!resp.ok){
        console.warn(`[_fetchImgBlob] ${proxy.name} → ${resp.status}`);
        lastErr = new Error(`${proxy.name}: HTTP ${resp.status}`);
        continue;
      }

      // ★ 바이너리 안전 처리: arrayBuffer → Blob
      const ab   = await resp.arrayBuffer();
      const ct   = resp.headers.get('Content-Type') || 'image/jpeg';
      const mime = ct.split(';')[0].trim();

      // 최소 크기 검증: 1KB 미만이면 에러 페이지일 가능성
      if(ab.byteLength < 1024){
        console.warn(`[_fetchImgBlob] ${proxy.name} → 응답 크기 너무 작음 (${ab.byteLength}B)`);
        lastErr = new Error(`${proxy.name}: 응답 크기 미달`);
        continue;
      }

      console.info(`[_fetchImgBlob] ${proxy.name} 성공 (${(ab.byteLength/1024).toFixed(0)}KB)`);
      return new Blob([ab], { type: mime.startsWith('image/') ? mime : 'image/jpeg' });

    }catch(err){
      clearTimeout(timer);
      if(err.name === 'AbortError'){
        console.warn(`[_fetchImgBlob] ${proxy.name} → 타임아웃 (${timeout}ms)`);
        lastErr = new Error(`${proxy.name}: 타임아웃`);
        continue;
      }
      console.warn(`[_fetchImgBlob] ${proxy.name} → 오류:`, err.message);
      lastErr = err;
    }
  }

  // 모든 프록시 실패
  throw lastErr || new Error('모든 이미지 프록시 실패');
}

// ── 캔버스 중앙 크롭 가공 및 세션 전송 (Tainted Canvas 방어) ──
async function centerCropToBlob(imgUrl) {
  // ★ 1단계: 다중 프록시 폴백 체인으로 Blob 획득
  // _fetchImgBlob: weserv.nl(Referer 제거) → Workers → 직접 순서로 시도
  let blobData = null;
  let objectUrl = null;

  try{
    blobData = await _fetchImgBlob(imgUrl);
    objectUrl = URL.createObjectURL(blobData);
    blobData = null; // ★ GC: ObjectURL 생성 후 Blob 참조 해제
  }catch(fetchErr){
    // 모든 프록시 실패 시 proxyImgUrl 경유 img.src 폴백 (crossOrigin 의존)
    console.warn('[centerCropToBlob] _fetchImgBlob 모두 실패, proxyImgUrl 폴백:', fetchErr.message);
  }

  return new Promise((resolve, reject) => {
    const img = new Image();
    // ★ crossOrigin=anonymous: ObjectURL은 same-origin이므로 taint 없음
    //    proxyImgUrl 폴백 경로에서도 필요
    img.crossOrigin = 'anonymous';

    img.onload = () => {
      // ★ ObjectURL 즉시 해제 (onload 완료 시점 — 이미 메모리에 올라감)
      if(objectUrl){ URL.revokeObjectURL(objectUrl); objectUrl = null; }
      try {
        const cw = img.naturalWidth;
        const ch = img.naturalHeight;
        if (cw <= 0 || ch <= 0) {
          reject(new Error('이미지 크기가 올바르지 않습니다.')); return;
        }
        const targetW = 400, targetH = 600;
        const canvas  = document.createElement('canvas');
        canvas.width  = targetW; canvas.height = targetH;
        const ctx = canvas.getContext('2d');
        if (!ctx){ reject(new Error('Canvas 가동 실패')); return; }

        const currentRatio = cw / ch;
        const targetRatio  = targetW / targetH;
        let srcX = 0, srcY = 0, srcW = cw, srcH = ch;
        if (currentRatio > targetRatio) {
          srcW = ch * targetRatio; srcX = (cw - srcW) / 2;
        } else {
          srcH = cw / targetRatio; srcY = (ch - srcH) / 2;
        }
        ctx.drawImage(img, srcX, srcY, srcW, srcH, 0, 0, targetW, targetH);

        // ★ toBlob SecurityError(canvas taint) try-catch
        try{
          canvas.toBlob(blob => {
            if(blob) resolve(blob);
            else reject(new Error('Canvas Blob 추출 실패'));
          }, 'image/jpeg', 0.88);
        }catch(secErr){
          console.warn('[centerCropToBlob] canvas SecurityError:', secErr.message);
          reject(secErr);
        }
      } catch(err){ reject(err); }
    };

    img.onerror = () => {
      if(objectUrl){ URL.revokeObjectURL(objectUrl); objectUrl = null; }
      reject(new Error('표지 이미지 렌더링 실패 (모든 프록시 시도 후 CORS 차단)'));
    };

    // ★ ObjectURL이 있으면 사용, 없으면 proxyImgUrl 경유
    img.src = objectUrl || proxyImgUrl(imgUrl);
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
      // ★ 검색어 우선순위:
      //   1순위: #title 입력창에 사용자가 이미 입력한 책 제목
      //   2순위: S.txtFiles[0].name 에서 extractSearchTitle로 추출한 순수 제목
      //   (extractSearchTitle은 "작가명@제목.txt" → "@" 뒤 제목만 반환)
      const titleEl = document.getElementById('title');
      const manualTitle = titleEl?.value?.trim() || '';
      if(manualTitle){
        titleInput = manualTitle;
      } else {
        const files = (typeof S !== 'undefined') ? (S.txtFiles || []) : [];
        if(files.length > 0) titleInput = extractSearchTitle(files[0].name);
      }
    } else {
      // batch 탭: currentSearchTitle 또는 batch 탭 #batchTitle 입력창
      const batchTitleEl = document.getElementById('batchTitle');
      const manualBatchTitle = batchTitleEl?.value?.trim() || '';
      const batch = (typeof S !== 'undefined') ? (S.batch || {}) : {};
      titleInput = manualBatchTitle || batch.currentSearchTitle || '';
    }

    // ★ ID 확정: index.html 실제 입력창 ID = 'coverSearchQ'
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

  // ★ 구글 버튼은 index.html에 #coverGoogleBtn으로 선행 배치됨
  // JS 동적 삽입 불필요 — 마크업에 이미 존재하는 버튼에 이벤트만 1회 바인딩
  const _googleBtn = document.getElementById('coverGoogleBtn');
  if(_googleBtn && !_googleBtn.dataset.bound){
    _googleBtn.dataset.bound = '1';
    _googleBtn.addEventListener('click', () => {
      const currentQ = document.getElementById('coverSearchQ')?.value?.trim() || q;
      if(!currentQ) return;
      window.open(
        'https://www.google.com/search?q=' + encodeURIComponent(currentQ + ' 소설 표지')
        + '&tbm=isch', '_blank', 'noopener,noreferrer'
      );
    });
  }

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
  // ★ 노벨피아 이미지 URL → weserv 래핑 헬퍼
  // 노벨피아 CDN(front-img.novelpia.com 등)은 Hotlinking 방지벽이 강력하므로
  // 검색 결과 생성 단계에서부터 weserv URL로 변환하여 화면 표시/다운로드 일원화
  function wrapNovelpia(src) {
    if(!src) return '';
    // // 프로토콜 상대경로 정규화
    const abs = src.startsWith('//') ? 'https:' + src
               : src.startsWith('/')  ? 'https://novelpia.com' + src
               : src;
    if(!abs.startsWith('http')) return '';
    // 이미 weserv URL이면 그대로
    if(abs.startsWith('https://images.weserv.nl')) return abs;
    return 'https://images.weserv.nl/?url=' + encodeURIComponent(abs) + '&output=jpg&q=92';
  }

  // ── 경로 1: 노벨피아 검색 API ──
  try {
    const html = await proxyFetch(
      `https://novelpia.com/proc/search_all?search_word=${encodeURIComponent(q)}`
    );
    const doc   = new DOMParser().parseFromString(html, 'text/html');
    const items = [];

    // 셀렉터 다중 시도: .novel-box → .search-result-item → 전체 img 폴백
    const boxes = doc.querySelectorAll('.novel-box, .search-result-item, [class*="novel-item"]');

    if(boxes.length > 0){
      boxes.forEach(box => {
        const imgEl   = box.querySelector('img');
        const titleEl = box.querySelector('.novel-title, .title, h3, h4, strong');
        const rawSrc  = imgEl?.getAttribute('src') || imgEl?.getAttribute('data-src') || '';
        // 고화질 치환: /35/ → /300/, /50/ → /300/
        const hiResSrc = rawSrc.replace(/\/(?:35|50|100)\//, '/300/');
        const weservSrc = wrapNovelpia(hiResSrc);
        if(weservSrc){
          items.push({
            title: titleEl?.textContent?.trim() || q,
            image: weservSrc,
          });
        }
      });
    }

    // 경로 1 성공
    if(items.length > 0) return items.slice(0, 6);
  } catch(e) {
    console.warn('[fetchNovelpiaCover] API 실패:', e.message);
  }

  // ── 경로 2: 노벨피아 웹 검색 HTML 파싱 폴백 ──
  try {
    const html = await proxyFetch(
      `https://novelpia.com/search/novel?search_string=${encodeURIComponent(q)}`
    );
    const doc   = new DOMParser().parseFromString(html, 'text/html');
    const items = [];

    // 전체 img 태그에서 노벨피아 CDN 도메인 이미지만 추출
    doc.querySelectorAll('img').forEach(imgEl => {
      const rawSrc = imgEl.getAttribute('src') || imgEl.getAttribute('data-src') || '';
      const abs    = rawSrc.startsWith('//') ? 'https:' + rawSrc : rawSrc;
      // 노벨피아 이미지 도메인 필터
      const isNovelpiaImg = abs.includes('novelpia.com') || abs.includes('novel-img');
      if(!isNovelpiaImg || abs.includes('icon') || abs.includes('logo')) return;
      const hiResSrc  = abs.replace(/\/(?:35|50|100)\//, '/300/');
      const weservSrc = wrapNovelpia(hiResSrc);
      if(weservSrc){
        items.push({
          title: imgEl.alt || q,
          image: weservSrc,
        });
      }
    });

    return items.slice(0, 6);
  } catch(e) {
    return [];
  }
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
    if(!item.image) return;

    // ★ weserv URL 일원화: 화면 표시 + 클릭 다운로드 동일 URL
    const rawUrl = item.image.startsWith('//') ? 'https:' + item.image : item.image;
    const weservUrl = 'https://images.weserv.nl/?url=' + encodeURIComponent(rawUrl)
      + '&output=jpg&q=92';
    const thumbUrl = (rawUrl.startsWith('https://images.weserv.nl')
                   || rawUrl.startsWith('data:')
                   || rawUrl.startsWith('blob:'))
      ? rawUrl
      : weservUrl;

    const card = document.createElement('div');
    card.className = 'cover-search-card';
    // ★ 카드 레이아웃 고정: flex column + 너비 고정으로 격자 붕괴 방지
    card.style.cssText = 'display:flex;flex-direction:column;align-items:center;gap:6px;cursor:pointer;padding:8px;border-radius:8px;border:1.5px solid var(--border);background:var(--bg2);transition:border-color .15s';

    // ★ 이미지 크기 고정: 표지 표준 1:1.43 배율 (120×171px)
    // object-fit:cover → 종횡비 무관하게 잘라맞춤, 크기 불일치로 인한 UI 붕괴 방지
    const img = document.createElement('img');
    img.alt   = item.title;
    img.loading = 'lazy';
    img.style.cssText = [
      'width:120px',
      'height:171px',
      'object-fit:cover',
      'border-radius:6px',
      'background-color:var(--border)',
      'display:block',
      'flex-shrink:0',
    ].join(';');
    img.src = thumbUrl;
    img.onerror = function(){
      if(!this.dataset.fallback){
        this.dataset.fallback = '1';
        this.src = proxyImgUrl(rawUrl);
      }
    };

    const info = document.createElement('div');
    info.style.cssText = 'width:120px;text-align:center';

    const titleDiv = document.createElement('div');
    titleDiv.className = 'cover-search-card-title';
    titleDiv.style.cssText = 'font-size:11px;line-height:1.4;overflow:hidden;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;word-break:break-all';
    titleDiv.textContent = item.title;  // textContent: XSS 방어

    info.appendChild(titleDiv);
    card.appendChild(img);
    card.appendChild(info);

    // ★ hover 테두리 강조 (CSS 변수 사용)
    card.addEventListener('mouseenter', () => { card.style.borderColor = 'var(--accent)'; });
    card.addEventListener('mouseleave', () => {
      if(!card.classList.contains('selected')) card.style.borderColor = 'var(--border)';
    });

    // ★ 클릭: thumbUrl(weserv) 전달 → _fetchImgBlob 1순위에서 즉시 성공
    card.addEventListener('click', () => {
      grid.querySelectorAll('.cover-search-card')
          .forEach(c => {
            c.classList.remove('selected');
            c.style.borderColor = 'var(--border)';
          });
      card.classList.add('selected');
      card.style.borderColor = 'var(--accent)';
      selectSearchedCover(thumbUrl);
    });

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