#!/usr/bin/env node
/**
 * NovelEPUB 런타임 지표 측정기 — 실제 Chrome에서 사용자 흐름을 재생하며 측정
 *
 *   측정 도구는 앱 의존성이 아니므로 package.json에 넣지 않는다. 측정할 때만 임시 설치:
 *     npm install --no-save playwright-core axe-core
 *     node tests/measure-runtime.js            → 표 출력
 *     node tests/measure-runtime.js --json     → JSON 출력
 *
 *   Chrome 위치: 환경변수 CHROME_PATH가 있으면 그것을, 없으면 설치된 Chrome(channel: 'chrome')을 사용
 *
 * 측정 항목
 *   1. 상호작용 지연 (Event Timing API, durationThreshold 16ms)
 *      - 각 단계별 최대 지연, 전체 최댓값 = INP 근사치 (상호작용 50회 미만이면 INP = 최악값)
 *      - CPU 제약 없음 / CPU 4배 감속(중급 모바일 근사) 두 조건
 *   2. CLS — 세션 전체 layout-shift 누적 (hadRecentInput 제외)
 *   3. axe-core 접근성 위반 — 5개 탭 × 라이트/다크
 *   4. 콘솔 오류 / 페이지 예외 수
 *
 * 외부 네트워크(구글 폰트·표지 검색)는 측정 환경마다 달라 결과를 흔들므로 차단하고 로컬 파일만 서빙한다.
 */
'use strict';
const http = require('http');
const fs   = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const JSON_OUT = process.argv.includes('--json');

let chromium, axeSource;
try {
  ({ chromium } = require('playwright-core'));
  axeSource = fs.readFileSync(require.resolve('axe-core/axe.min.js'), 'utf8');
} catch (e) {
  console.error('측정 도구가 없습니다. 먼저 실행: npm install --no-save playwright-core axe-core');
  process.exit(2);
}

// ── 의존성 없는 정적 서버 ──
const MIME = { '.html':'text/html; charset=utf-8', '.js':'text/javascript; charset=utf-8', '.css':'text/css; charset=utf-8',
  '.json':'application/json', '.webmanifest':'application/manifest+json', '.svg':'image/svg+xml', '.png':'image/png',
  '.wasm':'application/wasm', '.txt':'text/plain; charset=utf-8' };
function serve(){
  return new Promise(resolve => {
    const srv = http.createServer((req, res) => {
      let p = decodeURIComponent(new URL(req.url, 'http://x').pathname);
      if (p === '/') p = '/index.html';
      const f = path.join(ROOT, path.normalize(p));
      if (!f.startsWith(ROOT) || !fs.existsSync(f) || fs.statSync(f).isDirectory()) { res.writeHead(404); return res.end(); }
      res.writeHead(200, { 'Content-Type': MIME[path.extname(f)] || 'application/octet-stream' });
      fs.createReadStream(f).pipe(res);
    });
    srv.listen(0, '127.0.0.1', () => resolve(srv));
  });
}

// ── 측정용 TXT: 2,000화 · 화당 약 40줄 (결정적 생성) ──
function makeNovel(chapters = 2000){
  const S = ['그는 천천히 고개를 들었다.', '바람이 불어와 머리카락을 흩트렸다.', '"정말 괜찮은 거야?"', '멀리서 종소리가 울려 퍼졌다.',
             '시스템 창이 눈앞에 떠올랐다.', '그녀가 조용히 물었다.', '3년이 지났다.', '...그래, 알겠어.'];
  const out = ['측정용 소설', '작가: 테스트', ''];
  for (let i = 1; i <= chapters; i++) {
    out.push(`${i}화`, '');
    for (let j = 0; j < 40; j++) out.push(S[(i * 7 + j * 3) % S.length]);
    out.push('');
  }
  return out.join('\n');
}

// 페이지에 심는 계측 스크립트 — 로드 전에 등록해야 첫 상호작용부터 잡힌다
const INSTRUMENT = `
  window.__m = { events: [], cls: 0, shifts: 0, mark: '' };
  try {
    new PerformanceObserver(l => { for (const e of l.getEntries()) {
      if (e.interactionId) window.__m.events.push({ name: e.name, d: e.duration, step: window.__m.mark });
    }}).observe({ type: 'event', durationThreshold: 16, buffered: true });
    new PerformanceObserver(l => { for (const e of l.getEntries()) {
      if (!e.hadRecentInput) { window.__m.cls += e.value; window.__m.shifts++; }
    }}).observe({ type: 'layout-shift', buffered: true });
  } catch (e) {}
`;

async function run(throttle){
  const srv = await serve();
  const base = `http://127.0.0.1:${srv.address().port}/index.html`;
  const launchOpts = { headless: true, args: ['--no-sandbox'] };
  if (process.env.CHROME_PATH) launchOpts.executablePath = process.env.CHROME_PATH; else launchOpts.channel = 'chrome';
  const browser = await chromium.launch(launchOpts);
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 }, serviceWorkers: 'block' });
  await ctx.route(/^https?:\/\/(?!127\.0\.0\.1)/, r => r.abort());
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', e => errors.push('pageerror: ' + e.message));
  // 측정 환경에서 일부러 차단한 외부 요청의 실패 로그는 앱 오류가 아니므로 따로 센다
  const blocked = [];
  page.on('requestfailed', r => { if (!r.url().startsWith('http://127.0.0.1')) blocked.push(r.url()); });
  page.on('console', m => {
    if (m.type() !== 'error') return;
    const loc = m.location()?.url || '';
    if (/Failed to load resource/.test(m.text()) && loc && !loc.startsWith('http://127.0.0.1')) return;
    errors.push('console: ' + m.text() + (loc ? ' @ ' + loc : ''));
  });
  await page.addInitScript(INSTRUMENT);
  if (throttle > 1) {
    const cdp = await ctx.newCDPSession(page);
    await cdp.send('Emulation.setCPUThrottlingRate', { rate: throttle });
  }
  await page.goto(base, { waitUntil: 'load' });
  await page.waitForTimeout(800);

  const step = async (name, fn) => {
    await page.evaluate(n => { window.__m.mark = n; }, name);
    await fn();
    await page.waitForTimeout(400);
  };
  const tabs = ['edit', 'batch', 'history', 'settings', 'convert'];

  for (const t of tabs) await step('탭 전환', () => page.click(`#tab-${t}`));
  await step('테마 전환', () => page.click('#themeBtn'));
  await step('테마 전환', () => page.click('#themeBtn'));

  const txtPath = path.join(require('os').tmpdir(), 'novelepub-measure-2000.txt');
  fs.writeFileSync(txtPath, makeNovel());
  await step('TXT 투입', async () => {
    await page.setInputFiles('#txtIn', txtPath);
    await page.waitForTimeout(1500);
  });
  await step('목차 확인', async () => {
    await page.click('button[data-action="previewToc"] >> nth=0');
    await page.waitForTimeout(1500);
  });
  await step('제목 입력', async () => {
    await page.click('#title');
    await page.keyboard.type('측정용 소설', { delay: 30 });
  });
  await step('변환', async () => {
    await page.click('#convertBtn');
    await page.waitForSelector('#resultBox:not([hidden])', { timeout: 120000 }).catch(() => {});
    await page.waitForTimeout(800);
  });

  const m = await page.evaluate(() => window.__m);
  // 흐름이 실제로 끝까지 갔는지 확인 (측정이 중간에 멈췄는데 수치만 좋게 나오는 것을 막음)
  const flow = await page.evaluate(() => ({
    resultShown: !!document.getElementById('resultBox') && !document.getElementById('resultBox').hidden,
    detectBadge: document.getElementById('detectBadge')?.textContent?.trim() || '',
    title: document.getElementById('title')?.value || '',
  }));

  // axe — 탭 × 테마. 숨겨진 탭은 axe가 건너뛰므로 탭을 실제로 연다
  const axe = [];
  // 앱 CSP가 인라인 스크립트를 막으므로 addScriptTag 대신 DevTools 평가로 주입 (페이지 CSP는 그대로 유지)
  await page.evaluate(axeSource);
  for (const theme of ['light', 'dark']) {
    await page.evaluate(th => document.documentElement.setAttribute('data-theme', th), theme);
    for (const t of tabs) {
      await page.click(`#tab-${t}`);
      await page.waitForTimeout(300);
      const r = await page.evaluate(async () => {
        const res = await window.axe.run(document, { runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'] } });
        return res.violations.map(v => ({ id: v.id, impact: v.impact, nodes: v.nodes.length }));
      });
      axe.push({ theme, tab: t, violations: r });
    }
  }
  await browser.close();
  srv.close();
  fs.unlinkSync(txtPath);

  const byStep = {};
  for (const e of m.events) {
    const s = byStep[e.step] ||= { count: 0, max: 0, worst: '' };
    s.count++;
    if (e.d > s.max) { s.max = e.d; s.worst = e.name; }
  }
  return {
    cpuThrottle: throttle,
    inpApproxMs: m.events.reduce((a, e) => Math.max(a, e.d), 0),
    interactionsOver16ms: m.events.length,
    byStep,
    cls: Math.round(m.cls * 1000) / 1000,
    layoutShifts: m.shifts,
    axe,
    errors,
    blockedExternal: blocked.length,
    flow,
  };
}

(async () => {
  const results = [];
  for (const t of [1, 4]) results.push(await run(t));
  if (JSON_OUT) { process.stdout.write(JSON.stringify({ measuredAt: new Date().toISOString(), results }, null, 2) + '\n'); return; }
  for (const r of results) {
    console.log(`── CPU ${r.cpuThrottle}배 ──`);
    console.log(`  INP 근사(최악 상호작용) ${Math.round(r.inpApproxMs)}ms · 16ms 넘는 이벤트 ${r.interactionsOver16ms}개 · CLS ${r.cls} (이동 ${r.layoutShifts}회)`);
    for (const [s, v] of Object.entries(r.byStep)) console.log(`    ${s.padEnd(8)} 최대 ${Math.round(v.max)}ms (${v.worst}, ${v.count}건)`);
    console.log(`  흐름 완료: 결과 카드 ${r.flow.resultShown ? '표시' : '미표시'} · 감지 배지 "${r.flow.detectBadge}"`);
    console.log(`  콘솔 오류 ${r.errors.length}건${r.errors.length ? ': ' + r.errors.slice(0, 5).join(' | ') : ''} · 차단한 외부 요청 ${r.blockedExternal}건`);
  }
  const axe = results[0].axe;
  console.log('── axe 위반 (CPU 1배 실행 기준) ──');
  for (const a of axe) {
    const total = a.violations.reduce((n, v) => n + v.nodes, 0);
    console.log(`  ${a.theme.padEnd(5)} ${a.tab.padEnd(8)} 규칙 ${a.violations.length}종 · 노드 ${total}개  ${a.violations.map(v => `${v.id}(${v.nodes})`).join(' ')}`);
  }
})().catch(e => { console.error(e); process.exit(1); });
