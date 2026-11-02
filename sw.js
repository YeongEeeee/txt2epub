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
// ════════════════════════════════════════════════
const CACHE_VERSION = 'h-281b539c7b392a66';
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
];

// 웹폰트(Google Fonts)만 외부 Cache-first — 표지 검색 등 동적 외부 요청은 가로채지 않음
const _STATIC_EXTERNAL_HOSTS = new Set(['fonts.googleapis.com', 'fonts.gstatic.com']);
function _isStaticExternal(url){
  try { return _STATIC_EXTERNAL_HOSTS.has(new URL(url).hostname); } catch (e) { return false; }
}

// ── install: 버전 캐시를 한꺼번에 채움 (전부 성공해야 설치 완료) ──
self.addEventListener('install', e => {
  e.waitUntil(
    caches.open(CACHE_NAME).then(cache =>
      cache.addAll(CORE_ASSETS.map(u => new Request(u, { cache: 'reload' })))
    )
  );
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
  if (cached) return cached;
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
    if (resp && resp.status === 200 && resp.type === 'basic') cache.put(request, resp.clone()).catch(() => {});
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
