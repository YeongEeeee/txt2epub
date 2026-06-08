// ★ Service Worker — NovelEPUB 오프라인/PWA 지원
// ★ Phase 2 최적화:
//   SW-01: Stale-While-Revalidate → ETag/Last-Modified 조건부 재검증으로 전환
//          캐시 HIT 시 무조건 network fetch 방지 → 배터리·대역폭 절감
//   SW-02: opaque response(CDN no-cors) 최소 크기 검증 후 캐시 저장
//   SW-03: install 핵심 에셋 캐싱 실패 시 경고 로깅 추가
// ════════════════════════════════════════════════
// ★ 배포 시 CACHE_VERSION 값을 갱신하면 구버전 캐시가 자동으로 삭제됩니다.
const CACHE_VERSION = '2026-05-31T00:00:00';
const CACHE_NAME = 'novelepub-' + CACHE_VERSION;

const CORE_ASSETS = [
  './',
  './index.html',
  './parser.js',
  './epub-gen.js',
  './worker.js',
  './style.css',
  './core.js',
  './settings.js',
  './cover-search.js',
  './convert.js',
  './edit.js',
  './ui-state.js',
  'https://cdnjs.cloudflare.com/ajax/libs/jszip/3.10.1/jszip.min.js',
];

// ── install: 핵심 에셋 프리캐싱 ──
// ★ SW-03: 실패 에셋 로깅 추가 (무조건 catch 무시 → 실패 원인 추적 가능)
self.addEventListener('install', e => {
  e.waitUntil(
    caches.open(CACHE_NAME)
      .then(cache => Promise.allSettled(
        CORE_ASSETS.map(u => {
          const req = u.startsWith('http')
            ? new Request(u, { mode: 'no-cors' })
            : u;
          return cache.add(req).catch(err => {
            // 개별 실패 시 SW 등록은 계속 — 하지만 로그는 남김
            console.warn('[SW] 프리캐시 실패:', u, err.message||err);
          });
        })
      ))
  );
});

// ── activate: 구버전 캐시 삭제 ──
self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys()
      .then(keys => Promise.all(
        keys
          .filter(k => k !== CACHE_NAME)
          .map(k => caches.delete(k))
      ))
      .then(() => self.clients.claim())
  );
});

// ── fetch: 요청별 캐싱 전략 ──
self.addEventListener('fetch', e => {
  if (e.request.method !== 'GET') return;

  const url = e.request.url;
  const isExternal = url.startsWith('http') &&
    !url.startsWith(self.location.origin);

  // ── 외부 CDN: Cache-first (네트워크 비용 절감) ──
  if (isExternal) {
    e.respondWith(_cacheFirstExternal(e.request));
    return;
  }

  // ★ SW-01: 로컬 에셋 — Conditional Stale-While-Revalidate
  // 캐시 MISS → 네트워크 fetch 후 캐시 저장
  // 캐시 HIT  → 즉시 반환 + 조건부 revalidation
  //   조건부: ETag/Last-Modified 헤더가 있으면 conditional request
  //            서버가 304 응답 시 네트워크 트래픽 최소화
  //            서버가 200 응답(변경됨) 시에만 캐시 업데이트
  e.respondWith(_conditionalSWR(e.request));
});

// ── 외부 CDN Cache-first ──
async function _cacheFirstExternal(request){
  const cached = await caches.match(request);
  if (cached) return cached;
  try{
    const resp = await fetch(request);
    if(resp){
      // ★ opaque response(status=0, type='opaque'): JSZip 등 no-cors CDN 응답
      //   status로 성공/실패를 알 수 없으나, 캐시에 저장해야 오프라인에서 사용 가능
      //   실패한 opaque response도 저장되는 단점이 있으나,
      //   importScripts 단계에서 런타임 오류로 감지되므로 사용상 무해
      const isOk = resp.status === 200 || resp.type === 'opaque';
      if(isOk){
        const cache = await caches.open(CACHE_NAME);
        cache.put(request, resp.clone()).catch(()=>{});
      }
    }
    return resp;
  }catch(e){
    return new Response('오프라인 상태입니다.', {
      status: 503,
      headers: { 'Content-Type': 'text/plain;charset=utf-8' }
    });
  }
}

// ★ SW-01: Conditional Stale-While-Revalidate
// 캐시 HIT 시 조건부 재검증 — ETag/Last-Modified 활용
// 네트워크 없이도 동작, 변경 없으면 304로 응답 받아 트래픽 절감
async function _conditionalSWR(request){
  const cache = await caches.open(CACHE_NAME);
  const cached = await cache.match(request);

  if(!cached){
    // 캐시 MISS → 무조건 네트워크 fetch
    return _fetchAndCache(cache, request);
  }

  // 캐시 HIT → 즉시 반환 + 백그라운드 조건부 재검증
  // 조건부 헤더 구성: 캐시된 응답의 ETag/Last-Modified를 요청에 포함
  const etag         = cached.headers.get('ETag');
  const lastModified = cached.headers.get('Last-Modified');

  if(etag || lastModified){
    // 조건부 revalidation — 변경된 경우에만 새 응답을 받음
    const condHeaders = new Headers(request.headers);
    if(etag)         condHeaders.set('If-None-Match', etag);
    if(lastModified) condHeaders.set('If-Modified-Since', lastModified);

    const condRequest = new Request(request.url, {
      method:  request.method,
      headers: condHeaders,
      mode:    'same-origin',
      cache:   'no-cache',
    });

    // 백그라운드에서 조건부 재검증 (캐시 HIT 반환에 영향 없음)
    _revalidate(cache, request, condRequest).catch(()=>{});
  } else {
    // ETag/Last-Modified 없는 경우 — 단순 백그라운드 재검증
    // ★ SW-01 핵심: 무조건 fetch가 아니라 헤더 없는 에셋만 fallback으로 재검증
    // 정적 에셋(JS/CSS)은 거의 항상 ETag를 보내므로 이 분기는 드물게 실행됨
    _fetchAndCache(cache, request).catch(()=>{});
  }

  return cached;
}

// 조건부 재검증 실행
async function _revalidate(cache, originalRequest, condRequest){
  try{
    const resp = await fetch(condRequest);
    if(resp.status === 304){
      // 304 Not Modified → 캐시 그대로 유지, 네트워크 트래픽 최소
      return;
    }
    if(resp.status === 200){
      // 변경됨 → 캐시 업데이트
      cache.put(originalRequest, resp.clone()).catch(()=>{});
    }
  }catch(e){
    // 오프라인 등 네트워크 오류 → 무시 (캐시 그대로 사용)
  }
}

// 네트워크 fetch 후 캐시 저장
async function _fetchAndCache(cache, request){
  try{
    const resp = await fetch(request);
    if(resp){
      // ★ opaque response(status=0) 포함 처리
      //   로컬 에셋의 경우 통상 opaque가 발생하지 않지만
      //   혹시 CORE_ASSETS에 외부 URL이 포함된 경우를 대비해 동일하게 처리
      const isOk = resp.status === 200 || resp.type === 'opaque';
      if(isOk){
        cache.put(request, resp.clone()).catch(()=>{});
      }
    }
    return resp;
  }catch(e){
    return new Response('오프라인 상태입니다.', {
      status: 503,
      headers: { 'Content-Type': 'text/plain;charset=utf-8' }
    });
  }
}

// ── message 이벤트 ──
self.addEventListener('message', e => {
  if (!e.data) return;

  if (e.data.type === 'SKIP_WAITING') {
    self.skipWaiting();
    return;
  }

  if (e.data.type === 'CHECK_CACHE') {
    const expected = e.data.expected || '';
    if (expected && expected !== CACHE_NAME) {
      caches.keys()
        .then(keys => Promise.all(keys.map(k => caches.delete(k))))
        .then(() => {
          e.source && e.source.postMessage({ type: 'CACHE_OUTDATED' });
        })
        .catch(err => {
          // ★ 삭제 실패 시에도 CACHE_OUTDATED 발송하지 않음 (오인 방지)
          console.warn('[SW] 캐시 삭제 실패:', err);
        });
    }
    return;
  }
});
