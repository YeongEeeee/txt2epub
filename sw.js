// ★ C-03: Service Worker — NovelEPUB 오프라인/PWA 지원
const CACHE_NAME = 'novelepub-v1';
const CORE_ASSETS = [
  '/',
  '/index.html',
  '/main.js',
  '/parser.js',
  '/epub-gen.js',
  '/worker.js',
  '/style.css',
  'https://cdnjs.cloudflare.com/ajax/libs/jszip/3.10.1/jszip.min.js',
];

self.addEventListener('install', e=>{
  e.waitUntil(
    caches.open(CACHE_NAME)
      .then(cache=>cache.addAll(CORE_ASSETS.map(u=>{
        // CDN은 no-cors로 캐시
        if(u.startsWith('http')) return new Request(u,{mode:'no-cors'});
        return u;
      })))
      .catch(()=>{}) // 일부 실패해도 계속
  );
  self.skipWaiting();
});

self.addEventListener('activate', e=>{
  e.waitUntil(
    caches.keys().then(keys=>Promise.all(
      keys.filter(k=>k!==CACHE_NAME).map(k=>caches.delete(k))
    ))
  );
  self.clients.claim();
});

self.addEventListener('fetch', e=>{
  // POST/non-GET 무시
  if(e.request.method!=='GET') return;
  e.respondWith(
    caches.match(e.request).then(cached=>{
      if(cached) return cached;
      return fetch(e.request).then(resp=>{
        if(!resp||resp.status!==200&&resp.type!=='opaque') return resp;
        const clone=resp.clone();
        caches.open(CACHE_NAME).then(c=>c.put(e.request,clone)).catch(()=>{});
        return resp;
      }).catch(()=>cached||new Response('오프라인 상태입니다.',{status:503}));
    })
  );
});
