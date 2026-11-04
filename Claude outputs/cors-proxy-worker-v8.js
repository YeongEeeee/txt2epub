// NovelEPUB CORS 프록시 Worker v8
// v8 (Phase 24 — 표지 검색 카카오페이지 복구):
//   - 검색 사이트 허용 목록에 bff-page.kakao.com 추가
//     카카오페이지 검색 페이지가 완전 CSR로 바뀌어 결과는 bff 검색 API(JSON)로만 옴
//     v7의 'page.kakao.com' 항목은 '*.page.kakao.com'만 통과 → 'bff-page.kakao.com'은 403(허용되지 않은 도메인)
//   - bff-page.kakao.com 요청은 GET이어도 Referer/Origin을 page.kakao.com으로 전송
//     (v7: page.kakao.com POST 요청에만 적용)
// v6 기능 유지:
//   - 요청 크기 제한 (1MB)
//   - 입력 URL 검증 (http/https만)
//   - 이미지 CDN / 검색 사이트 분리 처리
//   - 커스텀 헤더 (_h_ prefix)
//   - POST 지원 (_method, _body)
// v7 보안 강화 (Phase 12):
//   - 도메인 허용 목록 비교 버그 수정: endsWith('naver.net')이 'evilnaver.net'도 통과시키던 문제
//     → 정확히 같거나 '.도메인'으로 끝나는 경우만 허용
//   - Origin 허용 목록: 다른 사이트의 페이지가 이 프록시를 쓰지 못하게 차단
//     · Origin 헤더가 없는 요청(<img src> 썸네일·주소창 직접 접근)은 이미지 CDN만 허용
//   - CORS 응답 헤더를 '*' 대신 허용된 Origin으로 반사
//   - 리다이렉트 후 최종 주소도 허용 목록·내부 주소 검사
//   - 이미지 전용 CDN 응답은 image/*만 중계 (SVG 제외 — 스크립트 포함 가능)
//   - 응답 크기 상한 15MB, 원본 서버 응답 대기 10초 제한
//   - IP 리터럴·localhost·비표준 포트 차단
//   - 검색 사이트와 이미지 CDN에 모두 있는 호스트(novelpia.com)는 검색 사이트 경로로 처리
//     (v6: 이미지 경로로 먼저 빠져 검색 HTML을 이미지용 Accept 헤더로 요청)
//   - (선택) Rate Limiting 바인딩 RATE_LIMITER가 있으면 IP당 요청 수 제한

// ── 허용 Origin ──
const ALLOWED_ORIGINS = [
  'https://novel2epub.pages.dev',
];
const ALLOWED_ORIGIN_SUFFIXES = ['.novel2epub.pages.dev'];           // Pages 미리보기 배포
const DEV_ORIGIN_RX = /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/;  // 로컬 개발 서버

// ── 이미지 CDN 허용 목록 (하위 도메인 포함) ──
const IMAGE_CDNS = [
  'kakaoentcdn.com',
  'kakaopagecdn.com',
  'kakaocdn.net',
  'dn-img-page.kakao.com',
  'ridicdn.net',
  'naver.net',
  'pstatic.net',
  'an2-img.amz.wtchn.net',
  'img.munpia.com',
  'hibook.co.kr',
  'novelpia.com',
  'pinimg.com',
  'webtoonguide.com',
];

// ── 검색 사이트 허용 목록 (하위 도메인 포함) ──
const SEARCH_SITES = [
  'series.naver.com', 'openapi.naver.com', 'search.naver.com',
  'ridibooks.com',
  'page.kakao.com', 'bff-page.kakao.com', 'dapi.kakao.com', 'search.daum.net',
  'novelpia.com',
  'www.bing.com', 'duckduckgo.com',
  'www.google.com',
];

const MAX_REQUEST_BYTES  = 1_000_000;         // 요청 본문 상한 (v6 동일)
const MAX_RESPONSE_BYTES = 15 * 1024 * 1024;  // 응답 상한
const UPSTREAM_TIMEOUT_MS = 10_000;

export default {
  async fetch(request, env) {
    const origin = request.headers.get('Origin') || '';
    const originOk = isAllowedOrigin(origin);

    // CORS preflight
    if (request.method === 'OPTIONS') {
      if (!originOk) return text('허용되지 않은 Origin', 403);
      return new Response(null, { status: 204, headers: corsHeaders(origin) });
    }

    // 다른 사이트에서 온 요청 차단 (Origin이 있는데 허용 목록에 없음)
    if (origin && !originOk) return text('허용되지 않은 Origin', 403);

    // (선택) IP당 요청 수 제한 — wrangler.toml에 RATE_LIMITER 바인딩이 있을 때만
    if (env && env.RATE_LIMITER && typeof env.RATE_LIMITER.limit === 'function') {
      const ip = request.headers.get('CF-Connecting-IP') || 'unknown';
      const { success } = await env.RATE_LIMITER.limit({ key: ip });
      if (!success) return text('요청이 너무 많습니다', 429, origin);
    }

    // 요청 크기 제한
    const contentLength = parseInt(request.headers.get('content-length') || '0', 10);
    if (contentLength > MAX_REQUEST_BYTES) {
      return text('요청이 너무 큽니다 (최대 1MB)', 413, origin);
    }

    const reqUrl = new URL(request.url);
    const target = reqUrl.searchParams.get('url');
    if (!target) return text('url 파라미터 필요', 400, origin);

    // URL 형식 검증
    let parsed;
    try {
      parsed = new URL(target);
    } catch {
      return text('잘못된 URL 형식', 400, origin);
    }
    if (isForbiddenTarget(parsed)) return text('허용되지 않는 주소', 400, origin);
    const targetHost = parsed.hostname;

    const isSearchSite = hostMatches(targetHost, SEARCH_SITES);
    const isImageCdn   = !isSearchSite && hostMatches(targetHost, IMAGE_CDNS);

    if (!isImageCdn && !isSearchSite) {
      return text('허용되지 않은 도메인: ' + targetHost, 403, origin);
    }
    // Origin 없는 요청(<img src> 등)은 이미지만 — 검색 사이트 HTML은 앱 페이지에서 온 요청만 중계
    if (!origin && isSearchSite) {
      return text('검색 사이트 중계는 앱에서만 사용할 수 있습니다', 403);
    }

    // ── 이미지 CDN 처리 ──
    if (isImageCdn) {
      try {
        const res = await fetchWithTimeout(parsed.href, {
          headers: {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
            'Referer': 'https://www.google.com/',
            'Accept': 'image/webp,image/apng,image/*,*/*;q=0.8',
          },
        });
        const redirectErr = checkFinalUrl(res, h => hostMatches(h, IMAGE_CDNS));
        if (redirectErr) return text(redirectErr, 403, origin);

        const ct = (res.headers.get('Content-Type') || '').toLowerCase();
        if (res.ok && (!ct.startsWith('image/') || ct.includes('svg'))) {
          return text('이미지가 아닌 응답은 중계하지 않습니다: ' + (ct || '알 수 없음'), 415, origin);
        }
        const body = await readLimited(res);
        if (!body) return text('응답이 너무 큽니다', 413, origin);
        return new Response(body, {
          status: res.status,
          headers: {
            ...corsHeaders(origin),
            'Content-Type': ct || 'image/jpeg',
            'Cache-Control': 'public, max-age=3600',
            'X-Content-Type-Options': 'nosniff',
          },
        });
      } catch (e) {
        return text('이미지 프록시 오류: ' + errMsg(e), e && e.name === 'AbortError' ? 504 : 502, origin);
      }
    }

    // ── 검색 사이트 처리 ──
    // _h_ prefix → 커스텀 헤더 (네이버 API Key 등 전달용)
    const customHeaders = {};
    for (const [key, val] of reqUrl.searchParams.entries()) {
      if (key.startsWith('_h_')) {
        const headerName = key.slice(3);
        // 헤더 이름 안전 검증 + 호스트·쿠키 등 위험 헤더 덮어쓰기 금지
        if (/^[a-zA-Z0-9\-_]+$/.test(headerName) && !/^(host|cookie|origin|content-length|cf-.*|x-forwarded-.*)$/i.test(headerName)) {
          customHeaders[headerName] = val;
        }
      }
    }

    const method  = (reqUrl.searchParams.get('_method') || 'GET').toUpperCase();
    if (method !== 'GET' && method !== 'POST') return text('허용되지 않는 메서드', 405, origin);
    const rawBody = reqUrl.searchParams.get('_body') || undefined;
    const ct      = customHeaders['Content-Type'] || customHeaders['content-type'] || '';
    const isJson  = ct.includes('application/json');
    // ★ v8: bff-page.kakao.com(검색 API)은 메서드와 관계없이 카카오페이지 Referer/Origin 필요
    const isKakao = (hostMatches(targetHost, ['page.kakao.com']) && method === 'POST')
                 || hostMatches(targetHost, ['bff-page.kakao.com']);
    const isBing  = hostMatches(targetHost, ['bing.com']);

    const referer = isKakao ? 'https://page.kakao.com/'
                  : isBing  ? 'https://www.bing.com/'
                  : hostMatches(targetHost, ['duckduckgo.com']) ? 'https://duckduckgo.com/'
                  : 'https://www.google.com/';

    try {
      const res = await fetchWithTimeout(parsed.href, {
        method,
        headers: {
          'User-Agent': isBing
            ? 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36 Edg/120.0.0.0'
            : 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36',
          'Accept': 'text/html,application/xhtml+xml,application/json,*/*;q=0.9',
          'Accept-Language': 'ko-KR,ko;q=0.9,en;q=0.8',
          'Referer': referer,
          ...(isKakao ? { 'Origin': 'https://page.kakao.com' } : {}),
          ...(method === 'POST' && !isJson ? { 'Content-Type': 'application/x-www-form-urlencoded' } : {}),
          ...(isJson ? { 'Content-Type': 'application/json' } : {}),
          ...customHeaders,
        },
        body: method === 'POST' ? rawBody : undefined,
      });
      // 검색 사이트에서 이미지 CDN으로 리다이렉트되는 경우(썸네일 링크)는 허용
      const redirectErr = checkFinalUrl(res, h => hostMatches(h, SEARCH_SITES) || hostMatches(h, IMAGE_CDNS));
      if (redirectErr) return text(redirectErr, 403, origin);

      const resBody = await readLimited(res);
      if (!resBody) return text('응답이 너무 큽니다', 413, origin);
      const resCt = res.headers.get('Content-Type') || 'text/plain; charset=utf-8';
      if (/svg/i.test(resCt)) return text('SVG 응답은 중계하지 않습니다', 415, origin);
      return new Response(resBody, {
        status: res.status,
        headers: {
          ...corsHeaders(origin),
          'Content-Type': resCt,
          'X-Proxied-Status': String(res.status),
          'X-Content-Type-Options': 'nosniff',
          'Cache-Control': 'no-store',
        },
      });
    } catch (e) {
      return text('프록시 오류: ' + errMsg(e), e && e.name === 'AbortError' ? 504 : 502, origin);
    }
  },
};

// ── 도우미 ──

function isAllowedOrigin(origin) {
  if (!origin) return false;
  if (ALLOWED_ORIGINS.includes(origin) || DEV_ORIGIN_RX.test(origin)) return true;
  try {
    const u = new URL(origin);
    return u.protocol === 'https:' && ALLOWED_ORIGIN_SUFFIXES.some(s => u.hostname.endsWith(s));
  } catch {
    return false;
  }
}

// 정확히 같은 호스트이거나 '.도메인'으로 끝나는 하위 도메인만 허용
function hostMatches(host, list) {
  const h = String(host || '').toLowerCase();
  return list.some(d => h === d || h.endsWith('.' + d));
}

function isForbiddenTarget(u) {
  if (!['http:', 'https:'].includes(u.protocol)) return true;   // file://, javascript: 등 차단
  if (u.port && u.port !== '80' && u.port !== '443') return true;
  const h = u.hostname.toLowerCase();
  if (h === 'localhost' || h.endsWith('.localhost') || h.endsWith('.local') || h.endsWith('.internal')) return true;
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(h)) return true;           // IPv4 리터럴
  if (h.startsWith('[') || h.includes(':')) return true;        // IPv6 리터럴
  return false;
}

function checkFinalUrl(res, isAllowedHost) {
  if (!res.url) return null;
  try {
    const u = new URL(res.url);
    if (isForbiddenTarget(u)) return '리다이렉트 대상이 허용되지 않는 주소입니다';
    if (!isAllowedHost(u.hostname)) return '리다이렉트 대상이 허용되지 않은 도메인입니다: ' + u.hostname;
  } catch {
    return '리다이렉트 대상 URL 오류';
  }
  return null;
}

async function fetchWithTimeout(url, init) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), UPSTREAM_TIMEOUT_MS);
  try {
    return await fetch(url, { ...init, redirect: 'follow', signal: ctrl.signal });
  } finally {
    clearTimeout(timer);
  }
}

// 응답 크기 상한 — 초과 시 null
async function readLimited(res) {
  const declared = parseInt(res.headers.get('Content-Length') || '0', 10);
  if (declared > MAX_RESPONSE_BYTES) return null;
  const buf = await res.arrayBuffer();
  return buf.byteLength > MAX_RESPONSE_BYTES ? null : buf;
}

function errMsg(e) {
  return (e && e.message) || String(e);
}

function text(message, status, origin = '') {
  return new Response(message, {
    status,
    headers: { ...corsHeaders(origin), 'Content-Type': 'text/plain; charset=utf-8', 'X-Content-Type-Options': 'nosniff' },
  });
}

function corsHeaders(origin) {
  return {
    // 허용된 Origin은 그대로 반사, Origin 없는 이미지 요청(<img src>)은 '*'
    'Access-Control-Allow-Origin': isAllowedOrigin(origin) ? origin : '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'X-NovelEPUB-Token, Cache-Control, Content-Type, Accept',
    'Access-Control-Max-Age': '86400',
    'Vary': 'Origin',
  };
}
