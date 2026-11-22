#!/usr/bin/env node
/**
 * NovelEPUB 정보 구조(IA) 지표 측정기 — 변환 탭에서 사용자가 '보고·지나가야 하는 양'을 잰다 (Phase 33)
 *
 *   측정 도구는 앱 의존성이 아니므로 package.json에 넣지 않는다. 측정할 때만 임시 설치:
 *     npm install --no-save playwright-core
 *     node tests/measure-ia.js            → 표 출력
 *     node tests/measure-ia.js --json     → JSON 출력
 *
 *   Chrome 위치: 환경변수 CHROME_PATH가 있으면 그것을, 없으면 설치된 Chrome(channel: 'chrome')을 사용
 *
 * 조건: 데스크톱 1440×900 · 모바일 390×844 × (첫 화면 / 200화 TXT 1개를 넣은 직후)
 * 측정 항목 (모두 결정적 — 반복해도 같은 값)
 *   1. 보이는 조작 요소 수 — #page-convert 안의 button·input·select·summary 등 중 화면에 그려진 것 (접힌 details 안은 제외)
 *   2. Tab 횟수 — 페이지 맨 앞에서 Tab을 눌러 'EPUB 변환 시작'(#convertBtn)에 닿을 때까지 (최대 400)
 *   3. 문서 높이 · 화면 몇 장 — document.scrollHeight, 그 값 ÷ 화면 높이
 *   4. 감지 결과 위치 — 파일을 넣은 뒤 '챕터 감지 결과'(#regexFeed) 윗변의 문서 y좌표 (첫 화면 안이면 스크롤 없이 보임)
 *   5. 보이는 글자 수 — #page-convert innerText (공백 제외)
 *
 * 외부 네트워크(구글 폰트·표지 검색)는 차단하고 로컬 파일만 서빙한다.
 */
'use strict';
const http = require('http');
const fs   = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const JSON_OUT = process.argv.includes('--json');

let chromium;
try {
  ({ chromium } = require('playwright-core'));
} catch (e) {
  console.error('측정 도구가 없습니다. 먼저 실행: npm install --no-save playwright-core');
  process.exit(2);
}

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

// 측정용 TXT: 200화 · 화당 20줄 (결정적 생성)
function makeNovel(chapters = 200){
  const S = ['그는 천천히 고개를 들었다.', '바람이 불어와 머리카락을 흩트렸다.', '"정말 괜찮은 거야?"', '멀리서 종소리가 울려 퍼졌다.'];
  const out = ['측정용 소설', '작가: 테스트', ''];
  for (let i = 1; i <= chapters; i++) {
    out.push(`${i}화`, '');
    for (let j = 0; j < 20; j++) out.push(S[(i + j) % S.length]);
    out.push('');
  }
  return out.join('\n');
}

// 화면에 그려진 조작 요소 — 접힌 details 안(summary 제외)·hidden·크기 0은 제외
const COUNT = `(() => {
  const pg = document.getElementById('page-convert');
  const shown = e => {
    const r = e.getBoundingClientRect();
    if (!r.width || !r.height) return false;
    if (getComputedStyle(e).visibility === 'hidden') return false;
    for (let x = e.parentElement; x; x = x.parentElement) {
      if (x.tagName === 'DETAILS' && !x.open && !(e.tagName === 'SUMMARY' && e.parentElement === x)) return false;
    }
    return true;
  };
  const ctrls = [...pg.querySelectorAll('button, input:not([type=file]), select, textarea, summary, a[href], [tabindex="0"]')].filter(shown);
  const feed = document.getElementById('regexFeed');
  const fr = feed && !feed.hidden ? feed.getBoundingClientRect() : null;
  return {
    controls: ctrls.length,
    pageH: document.documentElement.scrollHeight,
    feedY: fr ? Math.round(fr.top + scrollY) : null,
    chars: pg.innerText.replace(/\\s+/g, '').length,
  };
})()`;

async function tabsToConvert(page){
  await page.evaluate(() => { document.activeElement?.blur?.(); window.scrollTo(0, 0); });
  await page.focus('body').catch(() => {});
  for (let n = 1; n <= 400; n++) {
    await page.keyboard.press('Tab');
    const hit = await page.evaluate(() => document.activeElement?.id === 'convertBtn');
    if (hit) return n;
  }
  return null;
}

(async () => {
  const srv = await serve();
  const base = `http://127.0.0.1:${srv.address().port}/index.html`;
  const browser = await chromium.launch(process.env.CHROME_PATH
    ? { executablePath: process.env.CHROME_PATH, args: ['--no-sandbox'] }
    : { channel: 'chrome' });
  const txt = { name: '측정용 소설.txt', mimeType: 'text/plain', buffer: Buffer.from(makeNovel()) };
  const out = [];
  for (const [w, h, dev] of [[1440, 900, '데스크톱'], [390, 844, '모바일']]) {
    const ctx = await browser.newContext({ viewport: { width: w, height: h }, serviceWorkers: 'block' });
    await ctx.route(/^https?:\/\/(?!127\.0\.0\.1)/, r => r.abort());
    const page = await ctx.newPage();
    await page.goto(base);
    await page.waitForTimeout(900);
    const empty = await page.evaluate(COUNT);
    await page.setInputFiles('#txtIn', txt);
    await page.waitForFunction(() => typeof S !== 'undefined' && (S.tocItems?.length || 0) > 0, null, { timeout: 30000 });   // S는 const 전역 — window 속성 아님
    await page.waitForTimeout(1200);
    await page.evaluate(() => document.querySelectorAll('.toast, #susp-toast').forEach(t => t.remove()));
    const loaded = await page.evaluate(COUNT);
    const tabs = await tabsToConvert(page);
    out.push({ device: dev, viewport: `${w}x${h}`, empty, loaded: { ...loaded, screens: +(loaded.pageH / h).toFixed(2) }, tabsToConvert: tabs });
    await ctx.close();
  }
  await browser.close();
  srv.close();
  if (JSON_OUT) { console.log(JSON.stringify({ results: out }, null, 2)); return; }
  console.log('| 조건 | 보이는 조작 요소 (첫 화면 → 파일 후) | Tab 횟수 → 변환 버튼 | 문서 높이 (화면 장수) | 감지 결과 y | 보이는 글자 |');
  console.log('|---|---|---|---|---|---|');
  for (const r of out) {
    console.log(`| ${r.device} ${r.viewport} | ${r.empty.controls} → ${r.loaded.controls} | ${r.tabsToConvert ?? '400+'} | ${r.loaded.pageH}px (${r.loaded.screens}) | ${r.loaded.feedY ?? '-'}px | ${r.loaded.chars} |`);
  }
})().catch(e => { console.error(e); process.exit(1); });
