#!/usr/bin/env node
/**
 * NovelEPUB 일괄 변환 '파일 상태 파악' 비용 측정기 (Phase 35)
 *
 *   측정 도구는 앱 의존성이 아니므로 package.json에 넣지 않는다. 측정할 때만 임시 설치:
 *     npm install --no-save playwright-core
 *     node tests/measure-batch.js            → 표 출력
 *     node tests/measure-batch.js --json     → JSON 출력
 *     ROOT_DIR=<다른 체크아웃> node tests/measure-batch.js   → 이전 커밋과 비교 (같은 스크립트로 측정)
 *
 *   Chrome 위치: 환경변수 CHROME_PATH가 있으면 그것을, 없으면 설치된 Chrome(channel: 'chrome')을 사용
 *
 * 조건: 모바일 390×844 · 일괄 변환 탭에 TXT 7개(실전형 5종 + 화수 어긋남 1 + 제목 없음 1)를 한 번에 넣음
 * 측정 항목
 *   1. 클릭 수 — 7개 파일 모두의 감지 상태(준비/확인 필요/실패)를 알 때까지 누른 횟수
 *      · 사전 분석이 있으면(#batchSummary) 0번 — 배지가 다 채워질 때까지 기다리기만 함
 *      · 없으면(이전 버전) 파일마다 '목차 확인'을 1번씩 눌러 패널이 뜰 때까지 기다림
 *   2. 상태를 모두 알기까지 걸린 시간 — 파일을 넣은 순간부터 (클릭 방식은 클릭 대기 시간 제외, 순수 처리 시간 합)
 *   3. 가장 긴 메인 스레드 작업(Long Task) — 분석 중 화면이 멈춘 최대 시간
 *   4. 확인 필요 파일까지의 클릭 — '확인 필요한 파일 보기' 1번으로 첫 문제 파일 패널이 열리는지
 *   5. 클릭 없이 보이는 원인 — 배지 아래 메모 줄(Phase 36)에 누락 화 번호·다음 행동이 적힌 파일 수
 *   7. 한 화면 (Phase 38) — 7개를 넣고 분석이 끝난 뒤 스크롤하지 않은 첫 화면에서: 첫 파일 행의 위치,
 *      헤더·탭과 하단 바에 가리지 않고 통째로 보이는 파일 행 수, 파일 행 평균 높이, 탭 문서 높이
 *   8. 편의 (Phase 39) — 같은 7개로: 변환 제목에서 범위·완결 표기가 사라진 파일 수(0이어야 함 — 검색어만 정리) / 표지 검색 결과가 실제 변환 표지로 들어가는지
 *      (cover-search.js의 일괄 변환 경로를 그대로 실행) / 1개를 일부러 실패시킨 뒤 되살리는 데 다시 변환한 파일 수·시간
 *   6. 줄을 눌러 고치기 (Phase 37) — 따로 2개 파일: 자동 감지가 못 잡는 제목 형식('◈ N ◈', 감지 실패)과
 *      한 화만 다른 형식('47편', 누락 의심). '목차 확인' → '확인할 줄' 한 줄 누르기로 준비(N/N화)가 되는지·몇 번 눌렀는지
 *
 * 외부 네트워크(구글 폰트·표지 검색)는 차단하고 로컬 파일만 서빙한다.
 */
'use strict';
const http = require('http');
const fs   = require('fs');
const path = require('path');

const ROOT = path.resolve(process.env.ROOT_DIR || path.join(__dirname, '..'));
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

// 측정용 파일 7개 (결정적) — 생성기는 이 체크아웃의 것을 씀 (비교 대상과 같은 입력)
function makeFiles(){
  const { generate, SPECS } = require('./gen-realistic.js');
  const files = SPECS.map(s => { const g = generate(s); return { name: g.fileName, buffer: Buffer.from(g.text) }; });
  const ch = n => Array.from({ length: n }, (_, i) => `제${i + 1}화\n\n그는 걸었다.\n\n바람이 불었다.\n`).join('\n');
  files.push({ name: '화수가 어긋난 소설 1-100 완결.txt', buffer: Buffer.from(ch(40)) });
  files.push({ name: '제목 없는 원고.txt', buffer: Buffer.from('그는 걸었다.\n바람이 불었다.\n'.repeat(200)) });
  return files.map(f => ({ ...f, mimeType: 'text/plain' }));
}

(async () => {
  const srv = await serve();
  const base = `http://127.0.0.1:${srv.address().port}/index.html`;
  const browser = await chromium.launch(process.env.CHROME_PATH
    ? { executablePath: process.env.CHROME_PATH, args: ['--no-sandbox'] }
    : { channel: 'chrome' });
  const files = makeFiles();
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, serviceWorkers: 'block' });
  await ctx.route(/^https?:\/\/(?!127\.0\.0\.1)/, r => r.abort());
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', e => errors.push(String(e)));
  await page.goto(base);
  await page.waitForTimeout(900);
  await page.click('#tab-batch');
  await page.waitForTimeout(300);
  await page.evaluate(() => {
    window.__long = 0;
    try { new PerformanceObserver(l => l.getEntries().forEach(e => { window.__long = Math.max(window.__long, e.duration); })).observe({ type: 'longtask', buffered: false }); } catch (e) {}
  });

  const hasAuto = await page.evaluate(() => !!document.getElementById('batchSummary'));
  const t0 = Date.now();
  await page.setInputFiles('#batchTxtIn', files);
  let clicks = 0, elapsed = 0, states = [], summary = '', issueOpens = null, notes = [], layout = null;
  if (hasAuto) {
    await page.waitForFunction(n => {
      const b = [...document.querySelectorAll('.batch-check')];
      return b.length === n && b.every(x => !x.hidden && ['ok', 'warn', 'fail', 'error'].includes(x.dataset.state));
    }, files.length, { timeout: 60000 });
    elapsed = Date.now() - t0;
    states = await page.evaluate(() => [...document.querySelectorAll('.batch-check')].map(x => x.dataset.state + ':' + x.textContent.trim()));
    summary = await page.textContent('#batchSummaryText');
    await page.evaluate(() => window.scrollTo(0, 0));
    await page.waitForTimeout(400);
    layout = await page.evaluate(() => {
      const vh = innerHeight;
      const top = Math.max(...[...document.querySelectorAll('.hdr, .page-tabs')].map(e => e.getBoundingClientRect().bottom), 0);
      const btm = [...document.querySelectorAll('.btm')].find(e => !e.hidden && getComputedStyle(e).display !== 'none');
      const bottom = btm ? btm.getBoundingClientRect().top : vh;
      const items = [...document.querySelectorAll('#batchList .batch-item')].filter(e => e.offsetParent);
      const r = items.map(e => e.getBoundingClientRect());
      return {
        firstRowY: r[0] ? Math.round(r[0].top + scrollY) : -1,
        rowsVisible: r.filter(x => x.top >= top - 1 && x.bottom <= bottom + 1).length,
        rowH: r.length ? Math.round(r.reduce((s, x) => s + x.height, 0) / r.length) : 0,
        docH: document.documentElement.scrollHeight,
      };
    });
    notes = await page.evaluate(() => [...document.querySelectorAll('.batch-check-note')].filter(n => !n.hidden && n.textContent.trim()).map(n => (n.closest('.batch-item')?.querySelector('.batch-title-inp')?.value ?? n.closest('.batch-item')?.querySelector('.batch-title')?.textContent ?? '').slice(0, 12) + ': ' + n.textContent.trim()));
    await page.locator('#batchListSec').screenshot({ path: path.join(__dirname, 'out', 'batch-auto-analyze-list.png') }).catch(() => {});
    // 확인 필요한 첫 파일까지 1번
    await page.click('#batchIssueBtn');
    await page.waitForTimeout(600);
    issueOpens = await page.evaluate(() => {
      const open = [...document.querySelectorAll('.batch-toc-panel.show')].map(p => p.id);
      const first = [...document.querySelectorAll('.batch-check')].findIndex(x => ['warn', 'fail', 'error'].includes(x.dataset.state));
      return open.length === 1 && open[0] === 'btp_' + first;
    });
    await page.screenshot({ path: path.join(__dirname, 'out', 'batch-auto-analyze-mobile.png'), fullPage: false }).catch(() => {});
  } else {
    await page.waitForFunction(n => document.querySelectorAll('.batch-toc-btn').length === n, files.length);
    elapsed = 0;
    for (let i = 0; i < files.length; i++) {
      const s = Date.now();
      await page.click(`#bi_${i} .batch-toc-btn`);
      clicks++;
      await page.waitForFunction(k => document.getElementById('btp_' + k)?.classList.contains('show'), i, { timeout: 60000 });
      elapsed += Date.now() - s;
      states.push(await page.evaluate(k => {
        const t = document.getElementById('btp_' + k)?.innerText || '';
        return /감지하지 못했어요/.test(t) ? 'fail' : /오차 5% 초과/.test(t) ? 'warn' : 'ok';
      }, i));
    }
  }
  const longTask = Math.round(await page.evaluate(() => window.__long || 0));
  await ctx.close();

  // ── 6. 줄을 눌러 고치기 ──
  const body = '그는 걸었다.\n\n바람이 불었다.\n\n"괜찮아?"\n\n그녀가 물었다.';
  const mk = (n, f) => Array.from({ length: n }, (_, i) => f(i + 1) + '\n\n' + body).join('\n\n');
  const fixFiles = [
    { name: '기호 제목 소설 1-30 완결.txt', buffer: Buffer.from(mk(30, n => `◈ ${n} ◈`)) },
    { name: '한 화만 다른 소설 1-60 완결.txt', buffer: Buffer.from(mk(60, n => n === 47 ? '47편' : `제${n}화 제목`)) },
  ].map(f => ({ ...f, mimeType: 'text/plain' }));
  const fix = [];
  {
    const c2 = await browser.newContext({ viewport: { width: 390, height: 844 }, serviceWorkers: 'block' });
    await c2.route(/^https?:\/\/(?!127\.0\.0\.1)/, r => r.abort());
    const p2 = await c2.newPage();
    p2.on('pageerror', e => errors.push(String(e)));
    await p2.goto(base);
    await p2.waitForTimeout(900);
    await p2.click('#tab-batch');
    await p2.setInputFiles('#batchTxtIn', fixFiles);
    await p2.waitForFunction(n => document.querySelectorAll('.batch-toc-btn').length === n, fixFiles.length);
    if (hasAuto) await p2.waitForFunction(() => [...document.querySelectorAll('.batch-check')].every(x => !x.hidden && ['ok', 'warn', 'fail', 'error'].includes(x.dataset.state)), null, { timeout: 30000 });
    for (let i = 0; i < fixFiles.length; i++) {
      const before = await p2.evaluate(k => document.getElementById('bchk_' + k)?.textContent.trim() || '-', i);
      let taps = 0;
      await p2.click(`#bi_${i} .batch-toc-btn`); taps++;
      await p2.waitForFunction(k => document.getElementById('btp_' + k)?.classList.contains('show'), i);
      await p2.locator(`#btp_${i} .batch-issue-sec`).first().screenshot({ path: path.join(__dirname, 'out', `batch-line-issues-${i}.png`) }).catch(() => {});
      const row = p2.locator(`#btp_${i} button.batch-line-row`).first();
      const rows = await p2.locator(`#btp_${i} button.batch-line-row`).count();
      let after = '고칠 줄 없음 (정규식 직접 입력 필요)';
      if (rows) {
        const rowText = (await row.textContent()).trim();
        await row.click(); taps++;
        await p2.waitForFunction(k => { const b = document.getElementById('bchk_' + k); return b && b.dataset.state === 'ok' && /^\d+\/\d+화$/.test(b.textContent.trim()) && b.textContent.trim().split('/')[0] === b.textContent.trim().split('/')[1].replace('화', ''); }, i, { timeout: 15000 }).catch(() => {});
        after = (await p2.evaluate(k => document.getElementById('bchk_' + k)?.textContent.trim() || '-', i)) + ` (누른 줄: ${rowText.slice(0, 30)})`;
      }
      fix.push({ file: fixFiles[i].name, before, after, taps });
    }
    await c2.close();
  }

  // ── 8. 편의 ──
  const conv = {};
  {
    const c3 = await browser.newContext({ viewport: { width: 390, height: 844 }, serviceWorkers: 'block' });
    await c3.route(/^https?:\/\/(?!127\.0\.0\.1)/, r => r.abort());
    const p3 = await c3.newPage();
    p3.on('pageerror', e => errors.push(String(e)));
    await p3.goto(base);
    await p3.waitForTimeout(900);
    await p3.click('#tab-batch');
    await p3.setInputFiles('#batchTxtIn', files);
    await p3.waitForFunction(n => document.querySelectorAll('#batchList .batch-item').length === n, files.length);
    // 8-1. 제목
    const titles = await p3.evaluate(() => [...document.querySelectorAll('#batchList .batch-item')].map(it => (it.querySelector('.batch-title-inp')?.value ?? it.querySelector('.batch-title')?.textContent ?? '').trim()));
    // ★ 변환 제목은 파일명의 범위·완결·연재중 표기를 그대로 — 표기가 사라진 파일 수 (0이어야 함)
    const MARK = /\d+\s*[-~]\s*\d+|완결|연재중/;
    const pairs = await p3.evaluate(() => [...document.querySelectorAll('#batchList .batch-title-inp')].map(el => [el.title, el.value]));   // 목록은 정렬될 수 있어 파일명(title 속성)과 짝지음
    conv.markedFiles = pairs.filter(([fn]) => MARK.test(fn)).length;
    conv.lostMarks = pairs.filter(([fn, v]) => MARK.test(fn) && !MARK.test(v)).length;
    conv.titles = titles;
    // 8-2. 표지 검색 결과 → 변환 표지 (cover-search.js selectSearchedCover의 일괄 변환 분기 그대로)
    conv.cover = await p3.evaluate(async () => {
      const hasFinder = !!document.getElementById('batchCoverBtn');
      if (hasFinder) document.getElementById('batchCoverBtn').click(); else document.querySelector('[data-action="openCoverModal"][data-mode="batch"]')?.click();
      await new Promise(r => setTimeout(r, 300));
      const query = document.getElementById('coverSearchQ')?.value || '';
      const label = document.getElementById('coverModalTitle')?.textContent || '';
      const fileObj = new File([new Uint8Array([0xff, 0xd8, 0xff, 0xd9])], 'cover.jpg', { type: 'image/jpeg' });
      if (typeof window.setBatchSelectedCover === 'function') window.setBatchSelectedCover(fileObj);
      else { S.batch = S.batch || {}; S.batch.coverMap = S.batch.coverMap || {}; S.batch.coverMap['selected'] = fileObj; }
      document.getElementById('coverModal')?.classList.remove('show');
      await new Promise(r => setTimeout(r, 500));
      const stems = B.txtFiles.map(f => f.name.replace(/\.txt$/i, ''));
      const withCover = stems.filter(st => B.coverMap[st] || findFuzzyCover(st) || B.urlCoverFile).length;
      const nextQuery = document.getElementById('coverModal')?.classList.contains('show') ? document.getElementById('coverSearchQ')?.value : '';
      document.getElementById('coverModal')?.classList.remove('show');
      window.clearBatchCoverTarget?.();
      return { query, label, withCover, nextQuery };
    });
    // 8-3. 1개 실패 → 되살리기
    await p3.evaluate(() => {
      const orig = window.fileToText; let failedOnce = false;
      window.__conv = 0;
      window.fileToText = async f => { window.__conv++; if (!failedOnce && /제목 없는/.test(f.name)) { failedOnce = true; throw new Error('시험용 읽기 실패'); } return orig(f); };
    });
    const done = () => p3.waitForFunction(() => !_batchRunning && document.getElementById('batchResultBox')?.classList.contains('show'), null, { timeout: 180000 });
    const runAll = async () => { const t = Date.now(); await p3.click('#btmBatch .btn-accent'); await done(); return Date.now() - t; };
    conv.firstRunMs = await runAll();
    conv.firstFailed = await p3.evaluate(() => document.querySelectorAll('#batchList .batch-item.error').length);
    await p3.evaluate(() => { window.__conv = 0; });
    const hasRetry = await p3.evaluate(() => { const b = document.getElementById('batchRetryBtn'); return !!b && !b.hidden; });
    const t1 = Date.now();
    if (hasRetry) await p3.click('#batchRetryBtn'); else await p3.click('#btmBatch .btn-accent');
    await done();
    conv.recoverMs = Date.now() - t1;
    conv.recoverMode = hasRetry ? '실패한 파일만 다시' : '전체 다시 변환';
    conv.recoverConverted = await p3.evaluate(() => window.__conv);
    conv.afterFailed = await p3.evaluate(() => document.querySelectorAll('#batchList .batch-item.error').length);
    conv.results = await p3.evaluate(() => B.results.length);
    conv.resultNames = await p3.evaluate(() => B.results.map(x => x.name));
    conv.resultMsg = await p3.textContent('#batchResultMsg');
    await c3.close();
  }

  await browser.close();
  srv.close();

  const r = { root: ROOT, mode: hasAuto ? '자동 사전 분석' : '목차 확인 직접 클릭', files: files.length, clicks, elapsedMs: elapsed, longTaskMs: longTask, states, summary, issueOpens, notes, layout, fix, conv, errors };
  if (JSON_OUT) { console.log(JSON.stringify(r, null, 2)); return; }
  console.log('| 방식 | 파일 | 상태 파악까지 클릭 | 상태 파악까지 시간 | 최장 메인 스레드 작업 | 확인 필요 파일 열기 |');
  console.log('|---|---|---|---|---|---|');
  console.log(`| ${r.mode} | ${r.files}개 | ${r.clicks}번 | ${r.elapsedMs}ms | ${r.longTaskMs}ms | ${r.issueOpens === null ? '-' : r.issueOpens ? '1번 (첫 문제 파일 패널 열림)' : '실패'} |`);
  console.log('상태: ' + r.states.join(' / '));
  if (r.summary) console.log('요약: ' + r.summary);
  console.log(`클릭 없이 보이는 원인: ${r.notes.length}개 파일` + (r.notes.length ? '\n  ' + r.notes.join('\n  ') : ''));
  if (r.layout) console.log(`한 화면: 첫 파일 행 ${r.layout.firstRowY}px · 첫 화면에 통째로 보이는 행 ${r.layout.rowsVisible}/${r.files} · 행 평균 ${r.layout.rowH}px · 탭 높이 ${r.layout.docH}px`);
  if (r.conv) {
    console.log(`변환 제목에서 범위·완결 표기가 사라진 파일: ${r.conv.lostMarks}/${r.conv.markedFiles} (표기 있는 파일 기준)`);
    console.log(`EPUB 이름: ${(r.conv.resultNames || []).join(' | ')}`);
    console.log(`표지 검색 결과 → 변환 표지: 표지 있는 파일 ${r.conv.cover.withCover}/${r.files} (검색어 '${r.conv.cover.query}' · 창 제목 '${r.conv.cover.label}'${r.conv.cover.nextQuery ? ` · 다음 파일 '${r.conv.cover.nextQuery}'` : ''})`);
    console.log(`1개 실패 되살리기: ${r.conv.recoverMode} — 다시 읽은 파일 ${r.conv.recoverConverted}개 · ${r.conv.recoverMs}ms (첫 변환 ${r.conv.firstRunMs}ms, 실패 ${r.conv.firstFailed}) → 실패 ${r.conv.afterFailed} · 결과 ${r.conv.results}개 · '${r.conv.resultMsg}'`);
  }
  console.log('줄을 눌러 고치기:');
  r.fix.forEach(f => console.log(`  ${f.file}: ${f.before} → ${f.after} · ${f.taps}번`));
  if (r.errors.length) console.log('페이지 오류: ' + r.errors.join(' / '));
})().catch(e => { console.error(e); process.exit(1); });
