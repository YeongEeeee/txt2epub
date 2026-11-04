#!/usr/bin/env node
/**
 * 표지 검색 플랫폼 응답 형식 점검 — .github/workflows/cover-health.yml (주 1회 + 수동 실행)
 *
 *   node tests/cover-health.js
 *
 * cover-search.js의 플랫폼 어댑터가 기대하는 표식(클래스명·JSON 키)이 실제 검색 결과 HTML에 아직 있는지 확인합니다.
 * 표식이 사라지면(사이트 개편) 해당 플랫폼 표지 검색이 조용히 0건이 되므로 워크플로를 실패시켜 알림을 받습니다.
 * 네트워크 오류·차단(403/429)은 '확인 불가'로 따로 표시하고 실패로 치지 않습니다 (러너 IP 차단과 개편을 구분).
 * 의존성 없음 — Node 18+ 내장 fetch만 사용.
 */
'use strict';

const QUERY = '전지적 독자 시점';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36';

// adapter: cover-search.js 함수 이름 / marker: 어댑터가 파싱에 쓰는 표식
const CHECKS = [
  // ★ Phase 24: 리디 Next.js 개편 — __NEXT_DATA__ 안 { title, thumbnail: { xxlarge } } 객체
  { adapter: 'fetchRidiCover',        url: q => `https://ridibooks.com/search?q=${encodeURIComponent(q)}&adult_exclude=n`,
    marker: /__NEXT_DATA__[\s\S]*"thumbnail":\{[^}]*"xxlarge"/, need: '__NEXT_DATA__ … "thumbnail":{…"xxlarge"}' },
  // ★ Phase 24: 카카오페이지 CSR 전환 — bff 검색 API JSON (Workers 경유 시 403일 수 있음 → ⚠️ 처리)
  { adapter: 'fetchKakaoCover',       url: q => `https://bff-page.kakao.com/api/gateway/api/v2/search/series?keyword=${encodeURIComponent(q)}&category_uid=0&sort_type=ACCURACY&page=0&size=25`,
    headers: { Referer: 'https://page.kakao.com/' },
    marker: /"list":\[/, need: '"result":{"list":[…]} (bff 검색 API)' },
  { adapter: 'fetchNaverSeriesCover', url: q => `https://series.naver.com/search/search.nhn?t=novel&q=${encodeURIComponent(q)}`,
    marker: /lst_list[\s\S]*pstatic\.net/, need: '.lst_list li img (pstatic.net)' },
  // ★ Phase 24: 노벨피아 — POST /proc/novelsearch/{검색어} JSON
  { adapter: 'fetchNovelpiaCover',    url: q => `https://novelpia.com/proc/novelsearch/${encodeURIComponent(q)}`,
    method: 'POST', body: '', headers: { 'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8' },
    marker: /"search_result"/, need: '"data":{"search_result":[…]}' },
  { adapter: 'fetchWebFallbackCovers', url: q => `https://html.duckduckgo.com/html/?q=${encodeURIComponent(q + ' 소설 표지')}`,
    marker: /<img[^>]+src=/i, need: 'img[src]' },
];

async function check(c){
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 15000);
  try{
    const res = await fetch(c.url(QUERY), {
      method: c.method || 'GET',
      body: c.method === 'POST' ? (c.body || '') : undefined,
      headers: { 'User-Agent': UA, 'Accept-Language': 'ko-KR,ko;q=0.9', ...(c.headers || {}) },
      signal: ctrl.signal,
      redirect: 'follow',
    });
    const text = await res.text();
    if(res.status === 403 || res.status === 429 || res.status >= 500) return { ...c, state: 'skip', detail: 'HTTP ' + res.status };
    if(!res.ok) return { ...c, state: 'fail', detail: 'HTTP ' + res.status };
    return c.marker.test(text) ? { ...c, state: 'ok', detail: (text.length / 1024).toFixed(0) + 'KB' }
                               : { ...c, state: 'fail', detail: '표식 없음 — 기대: ' + c.need };
  }catch(e){
    return { ...c, state: 'skip', detail: e.name === 'AbortError' ? '시간 초과' : (e.message || String(e)) };
  }finally{
    clearTimeout(timer);
  }
}

(async () => {
  const results = await Promise.all(CHECKS.map(check));
  const icon = { ok: '✅', fail: '❌', skip: '⚠️' };
  for(const r of results) console.log(`${icon[r.state]} ${r.adapter.padEnd(24)} ${r.detail}`);
  const fails = results.filter(r => r.state === 'fail');
  if(process.env.GITHUB_STEP_SUMMARY){
    const rows = results.map(r => `| ${icon[r.state]} | \`${r.adapter}\` | ${r.detail} |`).join('\n');
    require('fs').appendFileSync(process.env.GITHUB_STEP_SUMMARY,
      `## 표지 검색 플랫폼 점검 (${QUERY})\n\n| 상태 | 어댑터 | 결과 |\n|---|---|---|\n${rows}\n\n` +
      (fails.length ? `❌ ${fails.length}개 플랫폼의 응답 형식이 바뀐 것 같아요. cover-search.js 어댑터를 확인하세요.\n` : '모든 플랫폼 정상 (⚠️는 러너에서 접속이 막힌 경우로 실패로 치지 않음)\n'));
  }
  process.exit(fails.length ? 1 : 0);
})();
