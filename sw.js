// ★ C-03: Service Worker — NovelEPUB 오프라인/PWA 지원
// ★ FIX-SW: CACHE_NAME에 버전 타임스탬프 삽입 → 배포 시 자동 캐시 무효화
// ★ 배포할 때마다 아래 CACHE_VERSION 값을 갱신하면 구버전 캐시가 자동으로 삭제됩니다.
const CACHE_VERSION = '2025-05-31T00:00:00';
const CACHE_NAME = 'novelepub-' + CACHE_VERSION;

// ★ FIX-SW: '/' → './' 로 변경 (상대경로 안전성 — 서브경로 배포 및 로컬 환경 대응)
const CORE_ASSETS = [
  './',
  './index.html',
  './main.js',
  './parser.js',
  './epub-gen.js',
  './worker.js',
  './style.css',
  'https://cdnjs.cloudflare.com/ajax/libs/jszip/3.10.1/jszip.min.js',
];

// ★ FIX-SW: install — 핵심 에셋 프리캐싱 (일부 실패해도 SW 등록은 계속)
// ★ FIX-SW: skipWaiting() 제거 → activate 완료 전 강제 교체로 인한 탭 불일치 방지
//            새 버전 교체는 message 이벤트(SKIP_WAITING)로 main.js에서 선택적으로 제어
self.addEventListener('install', e => {
  e.waitUntil(
    caches.open(CACHE_NAME)
      .then(cache => cache.addAll(CORE_ASSETS.map(u => {
        // CDN(외부) 리소스는 no-cors로 캐시 (opaque response 허용)
        if (u.startsWith('http')) return new Request(u, { mode: 'no-cors' });
        return u;
      })))
      .catch(() => {}) // 일부 실패해도 계속
  );
});

// ★ FIX-SW: activate — 구버전 캐시 전부 삭제 후 clients.claim()으로 즉시 제어권 획득
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

// ★ FIX-SW: fetch — 로컬 에셋은 Stale-While-Revalidate 전략
//   • 캐시 HIT → 즉시 반환 + 백그라운드에서 최신 버전으로 갱신
//   • 캐시 MISS → 네트워크 응답 반환 + 캐시에 저장
//   → 배포 후 다음 방문 시 최신 파일이 자동 반영됨
//   외부 CDN 리소스는 기존 Cache-first 전략 유지 (트래픽 절감)
self.addEventListener('fetch', e => {
  // POST / non-GET 요청은 SW 개입 없이 그대로 통과
  if (e.request.method !== 'GET') return;

  const url = e.request.url;
  const isExternal = url.startsWith('http') &&
    !url.startsWith(self.location.origin);

  // ── 외부 CDN: Cache-first (네트워크 비용 절감) ──
  if (isExternal) {
    e.respondWith(
      caches.match(e.request).then(cached => {
        if (cached) return cached;
        return fetch(e.request).then(resp => {
          // opaque response(no-cors)는 status=0이므로 type으로만 판별
          if (!resp || (resp.status !== 200 && resp.type !== 'opaque')) return resp;
          const clone = resp.clone();
          caches.open(CACHE_NAME)
            .then(c => c.put(e.request, clone))
            .catch(() => {});
          return resp;
        }).catch(() =>
          new Response('오프라인 상태입니다.', { status: 503 })
        );
      })
    );
    return;
  }

  // ── 로컬 에셋: Stale-While-Revalidate ──
  e.respondWith(
    caches.open(CACHE_NAME).then(cache =>
      cache.match(e.request).then(cached => {
        // 백그라운드 갱신 — 캐시 히트 여부 무관하게 항상 네트워크 재요청
        const networkFetch = fetch(e.request)
          .then(resp => {
            if (resp && resp.status === 200) {
              cache.put(e.request, resp.clone()).catch(() => {});
            }
            return resp;
          })
          .catch(() => null);

        // 캐시 있으면 즉시 반환 (백그라운드 갱신은 계속 진행)
        // 캐시 없으면 네트워크 응답 대기
        if (cached) return cached;
        return networkFetch.then(resp =>
          resp || new Response('오프라인 상태입니다.', { status: 503 })
        );
      })
    )
  );
});

// ★ FIX-SW: message 이벤트 — main.js에서 SKIP_WAITING 메시지를 보내면 즉시 활성화
//   사용 예) navigator.serviceWorker.controller?.postMessage({ type: 'SKIP_WAITING' })
self.addEventListener('message', e => {
  if (e.data && e.data.type === 'SKIP_WAITING') {
    self.skipWaiting();
  }
});
