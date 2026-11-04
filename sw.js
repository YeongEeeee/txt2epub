// ★ Service Worker — NovelEPUB 오프라인/PWA 지원
// ════════════════════════════════════════════════
// ★ Phase 15: 버전 단위 원자적 캐시 (Atomic versioned cache)
//   이전(Phase 2~14): 로컬 자원을 파일마다 Stale-While-Revalidate로 따로 갱신
//     → 배포 직후 새 index.html + 옛 convert.js처럼 버전이 섞인 채 실행될 수 있었고,
//       CACHE_VERSION을 손으로 바꾸지 않으면 갱신 시점이 파일마다 제각각이었음
//   현재:
//     1. CACHE_VERSION = 앱 자산 내용 해시 ('npm run stamp'가 기록, 회귀 테스트가 일치 여부 검사)
//        → 자산이 바뀌면 sw.js 바이트가 바뀌고 브라우저가 새 SW를 설치
//     2. install: CORE_ASSETS 전체를 HTTP 캐시를 우회(cache:'reload')해 새 캐시에 한꺼번에 저장
//        하나라도 실패하면 설치 실패 → 기존 버전이 계속 동작 (반쪽 캐시 없음)
//     3. 로컬 자원은 현재 버전 캐시에서만 응답 (Cache-first) → 한 화면의 파일은 항상 같은 버전
//     4. 새 SW는 대기(waiting) → main.js 업데이트 배너 → SKIP_WAITING → controllerchange → 새로고침
//   JSZip은 Phase 15부터 lib/jszip.min.js로 함께 배포 (CDN 불필요 — 첫 방문 직후 오프라인 변환 가능)
// ★ Phase 21: Cloudflare Pages는 /index.html을 / 로 308 리디렉트(pretty URL)
//   → 캐시된 './index.html'이 '리디렉트를 거친 응답'이 되고, 이를 페이지 이동(navigate)에 돌려주면
//     Chrome이 네트워크 오류로 처리 → 두 번째 방문부터 ERR_FAILED ('사이트에 연결할 수 없음')
//   수정: 캐시에 넣기 전 리디렉트 흔적을 지운 새 응답으로 바꿈(_plain) + 응답 직전에도 한 번 더 확인
//   복구: 이전 SW 때문에 화면이 하나도 열리지 못한 상태라면 새 SW가 대기 없이 바로 활성화
//   CACHE_VERSION 해시에는 sw.js 자체 코드도 포함(stamp-sw.js) → SW 로직만 바뀌어도 새 캐시 이름
// ════════════════════════════════════════════════
const CACHE_VERSION = 'h-fcdad3387bc8c7f5';
const CACHE_NAME = 'novelepub-' + CACHE_VERSION;

// 해시 대상이자 프리캐시 목록 — 로컬 자원만 ('./'는 index.html과 같은 문서)
const CORE_ASSETS = [
  './',
  './index.html',
  './style.css',
  './lib/jszip.min.js',
  './parser.js',
  './epub-gen.js',
  './core.js',
  './settings.js',
  './cover-search.js',
  './convert.js',
  './edit.js',
  './ui-state.js',
  './main.js',
  './worker.js',
  './manifest.webmanifest',   // ★ Phase 16: 앱 설치
  './icons/icon.svg',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/icon-maskable-512.png',
];

// 웹폰트(Google Fonts)만 외부 Cache-first — 표지 검색 등 동적 외부 요청은 가로채지 않음
const _STATIC_EXTERNAL_HOSTS = new Set(['fonts.googleapis.com', 'fonts.gstatic.com']);
function _isStaticExternal(url){
  try { return _STATIC_EXTERNAL_HOSTS.has(new URL(url).hostname); } catch (e) { return false; }
}

// 리디렉트를 거친 응답 → 본문·상태·헤더만 담은 새 응답 (navigate 응답으로 써도 안전)
async function _plain(resp){
  if (!resp || !resp.redirected) return resp;
  return new Response(await resp.blob(), { status: resp.status, statusText: resp.statusText, headers: resp.headers });
}

// ── install: 버전 캐시를 한꺼번에 채움 (전부 성공해야 설치 완료 — 실패하면 새 캐시를 지우고 기존 버전 유지) ──
self.addEventListener('install', e => {
  e.waitUntil((async () => {
    const cache = await caches.open(CACHE_NAME);
    try {
      await Promise.all(CORE_ASSETS.map(async u => {
        const resp = await fetch(new Request(u, { cache: 'reload' }));
        if (!resp.ok) throw new Error('프리캐시 실패: ' + u + ' (' + resp.status + ')');
        await cache.put(u, await _plain(resp));
      }));
    } catch (err) {
      await caches.delete(CACHE_NAME);
      throw err;
    }
    // 열린 화면이 없으면(첫 설치·이전 SW 오류로 화면이 뜨지 못한 경우) 대기 없이 활성화 — 열린 화면이 있으면 기존처럼 업데이트 배너
    const wins = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    if (!wins.length) await self.skipWaiting();
  })());
});

// ── activate: 다른 버전 캐시 삭제 ──
self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k.startsWith('novelepub-') && k !== CACHE_NAME).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

// ── fetch ──
self.addEventListener('fetch', e => {
  if (e.request.method !== 'GET') return;
  const url = e.request.url;
  const isExternal = url.startsWith('http') && !url.startsWith(self.location.origin);

  if (isExternal) {
    if (_isStaticExternal(url)) e.respondWith(_cacheFirstExternal(e.request));
    return;
  }
  if (e.request.mode === 'navigate') {
    e.respondWith(_navigate(e.request));
    return;
  }
  e.respondWith(_cacheFirstLocal(e.request));
});

// 페이지 이동: 현재 버전의 index.html (쿼리스트링 무시) → 없으면 네트워크
async function _navigate(request){
  const cache = await caches.open(CACHE_NAME);
  const cached = await cache.match('./index.html') || await cache.match('./');
  if (cached) return _plain(cached);   // 이전 버전이 저장한 리디렉트 응답이 남아 있어도 안전
  try {
    return await fetch(request);
  } catch (e) {
    return _offline();
  }
}

// 로컬 자원: 현재 버전 캐시 → 없으면(프리캐시 목록 밖) 네트워크 후 같은 버전 캐시에 저장
async function _cacheFirstLocal(request){
  const cache = await caches.open(CACHE_NAME);
  const cached = await cache.match(request, { ignoreSearch: true });
  if (cached) return cached;
  try {
    const resp = await fetch(request);
    if (resp && resp.status === 200 && resp.type === 'basic') _plain(resp.clone()).then(r => cache.put(request, r)).catch(() => {});
    return resp;
  } catch (e) {
    return _offline();
  }
}

// 웹폰트: 캐시 → 네트워크 (opaque 응답은 CORS 요청에 돌려주지 않음)
async function _cacheFirstExternal(request){
  const cached = await caches.match(request);
  if (cached && !(cached.type === 'opaque' && request.mode === 'cors')) return cached;
  try {
    const resp = await fetch(request);
    if (resp && (resp.status === 200 || resp.type === 'opaque')) {
      const cache = await caches.open(CACHE_NAME);
      cache.put(request, resp.clone()).catch(() => {});
    }
    return resp;
  } catch (e) {
    return _offline();
  }
}

function _offline(){
  return new Response('오프라인 상태입니다.', { status: 503, headers: { 'Content-Type': 'text/plain;charset=utf-8' } });
}

// ── message: 업데이트 배너의 '지금 업데이트' → 대기 중인 새 SW 활성화 ──
self.addEventListener('message', e => {
  if (e.data && e.data.type === 'SKIP_WAITING') self.skipWaiting();
});
