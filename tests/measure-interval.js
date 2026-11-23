#!/usr/bin/env node
/**
 * NovelEPUB 간격 분할(N화) 경계 정확도 측정기 — 정답을 아는 합성 원고로 (Phase 40)
 *
 *   node tests/measure-interval.js            → 표 출력
 *   node tests/measure-interval.js --json     → JSON 출력
 *   ROOT_DIR=<다른 체크아웃> node tests/measure-interval.js   → 이전 커밋과 비교 (입력은 이 체크아웃의 생성기)
 *
 * 입력: tests/gen-realistic.js 실전형 5종 × 2 (원본 · 화 길이 0.3~3배·문체 들쭉날쭉) × 3 상황 = 30개
 *   제목 그대로   — 정규식 목차 감지가 제목을 찾는 경우 (회귀 확인)
 *   낯선 제목     — 본편 제목 줄을 '◈ N ◈'로 바꿈 (정규식 목록에 없는 형식)
 *   제목 없음     — 본편 제목 줄을 지움 (빈 줄·문장 끝만 남음)
 *   화수는 정답 목차 수 그대로 넘김 (파일명 화수 추정 오차는 따로)
 *
 * 경계 판정: 정답 경계 g마다 가장 가까운 예측 경계 p와의 사이에 본문 줄이 하나도 없으면 '정확' (5줄 이내면 '5줄 이내')
 *   (빈 줄·구분선 '====='·'***'·작품명 머리줄은 어느 화에 붙어도 본문이 어긋나지 않음)
 *   다른 화로 간 본문 = 줄마다 예측 화 번호 ≠ 정답 화 번호인 본문 줄 (경계 하나가 빠지거나 더해지면 그 뒤 번호가 모두 밀림 — 엄격)
 */
'use strict';
const fs = require('fs'), path = require('path'), vm = require('vm');
const ROOT = path.resolve(process.env.ROOT_DIR || path.join(__dirname, '..'));
const JSON_OUT = process.argv.includes('--json');
const { generate, SPECS } = require('./gen-realistic.js');

function loadEngine(){
  const noop = () => {};
  const quiet = { log: noop, info: noop, warn: noop, debug: noop, error: (...a) => console.error(...a) };
  const ctx = { console: quiet, setTimeout, clearTimeout, TextDecoder, TextEncoder, Blob, URL, structuredClone,
    document: { getElementById: () => null, querySelector: () => null, querySelectorAll: () => [], createElement: () => ({ style: {}, appendChild: noop, setAttribute: noop }), addEventListener: noop, body: { appendChild: noop } },
    localStorage: { getItem: () => null, setItem: noop, removeItem: noop }, navigator: { hardwareConcurrency: 4 } };
  ctx.window = ctx; ctx.self = ctx;
  vm.createContext(ctx);
  vm.runInContext(fs.readFileSync(path.join(ROOT, 'parser.js'), 'utf8'), ctx, { filename: 'parser.js' });
  return ctx;
}

const SEP_RX = /^(?:[=\-─━*＊~·.]{3,}|\*{3})$/;
function makeCase(spec, vary, mode){
  const g = generate(vary ? { ...spec, vary: true } : spec);
  const lines = g.text.split('\n');
  const header = spec.header || null;
  const ignorable = t => { const x = String(t || '').trim(); return !x || SEP_RX.test(x) || (header && x === header); };
  const heads = g.truth.map(t => t.line - 1);
  if (mode === 'keep') return { lines, gold: heads, ignorable };
  const target = new Set(g.truth.filter(t => t.kind === 'ch' && t.num != null).map(t => t.line - 1));
  const out = [], gold = [];
  const headSet = new Set(heads);
  for (let i = 0; i < lines.length; i++) {
    if (headSet.has(i)) gold.push(out.length);
    if (target.has(i)) {
      const t = g.truth.find(x => x.line - 1 === i);
      if (mode === 'odd') out.push(`◈ ${t.num} ◈`);
      continue;   // 'none': 지움
    }
    out.push(lines[i]);
  }
  return { lines: out, gold, ignorable };
}

function score(lines, gold, starts, ignorable){
  // 정답 경계마다 가장 가까운 예측 경계와의 사이 본문 줄 수 (집합 기준 — 앞에서 하나 어긋나도 뒤 경계는 따로 셈)
  //   본문 줄 위치 누적합으로 '두 줄 사이 본문 줄 수'를 바로 계산
  const pre = new Int32Array(lines.length + 1);
  for (let i = 0; i < lines.length; i++) pre[i + 1] = pre[i] + (ignorable(lines[i]) ? 0 : 1);
  const between = (x, y) => Math.abs(pre[Math.max(x, y)] - pre[Math.min(x, y)]);
  const sp = starts.slice().sort((x, y) => x - y);
  let exact = 0, near = 0;
  for (let k = 1; k < gold.length; k++) {
    const q = gold[k];
    let lo = 0, hi = sp.length - 1;
    while (lo < hi) { const m = (lo + hi) >> 1; if (sp[m] < q) lo = m + 1; else hi = m; }
    let d = Infinity;
    for (const j of [lo - 1, lo, lo + 1]) if (j >= 0 && j < sp.length) d = Math.min(d, between(sp[j], q));
    if (d === 0) exact++;
    if (d <= 5) near++;
  }
  // 다른 화로 간 본문 줄 = 줄마다 '예측한 화 번호 ≠ 정답 화 번호'인 본문 줄 수 (전체 본문 대비, 최대 100%)
  let moved = 0, body = 0, gi = -1, pi = -1;
  for (let i = 0; i < lines.length; i++) {
    while (gi + 1 < gold.length && gold[gi + 1] <= i) gi++;
    while (pi + 1 < starts.length && starts[pi + 1] <= i) pi++;
    if (ignorable(lines[i])) continue;
    body++;
    if (gi !== pi) moved++;
  }
  return { bounds: gold.length - 1, exact, near, moved, body, found: starts.length };
}

const E = loadEngine();
const MODES = [['keep', '제목 그대로'], ['odd', '낯선 제목 (◈ N ◈)'], ['none', '제목 없음']];
const rows = [];
for (const [mode, label] of MODES) {
  const agg = { mode: label, bounds: 0, exact: 0, near: 0, moved: 0, body: 0, ms: 0, countOk: 0, cases: 0, worst: [] };
  for (const vary of [false, true]) for (const spec of SPECS) {
    const c = makeCase(spec, vary, mode);
    const t0 = process.hrtime.bigint();
    const items = E.computeIntervalSplit(c.lines, c.gold.length, { titleMode: 'number' });
    agg.ms += Number(process.hrtime.bigint() - t0) / 1e6;
    const starts = items.map(it => it.line - 1);
    const s = score(c.lines, c.gold, starts, c.ignorable);
    agg.bounds += s.bounds; agg.exact += s.exact; agg.near += s.near; agg.moved += s.moved; agg.body += s.body; agg.cases++;
    if (s.found === c.gold.length) agg.countOk++;
    agg.worst.push({ name: spec.title.slice(0, 10) + (vary ? '·들쭉' : ''), exact: +(s.exact / s.bounds * 100).toFixed(1) });
  }
  agg.worst.sort((a, b) => a.exact - b.exact);
  rows.push(agg);
}
const pct = (a, b) => (a / b * 100).toFixed(1) + '%';
if (JSON_OUT) { console.log(JSON.stringify(rows.map(r => ({ ...r, exactPct: +(r.exact / r.bounds * 100).toFixed(1), nearPct: +(r.near / r.bounds * 100).toFixed(1), movedPct: +(r.moved / r.body * 100).toFixed(2), ms: Math.round(r.ms) })), null, 2)); process.exit(0); }
console.log('| 상황 | 경계 수 | 정확 (본문 0줄 어긋남) | 5줄 이내 | 다른 화로 넘어간 본문 | 화수 맞음 | 시간 (10개 합) | 가장 낮은 파일 |');
console.log('|---|---|---|---|---|---|---|---|');
for (const r of rows) console.log(`| ${r.mode} | ${r.bounds} | ${pct(r.exact, r.bounds)} | ${pct(r.near, r.bounds)} | ${r.moved}줄 (${pct(r.moved, r.body)}) | ${r.countOk}/${r.cases} | ${Math.round(r.ms)}ms | ${r.worst[0].name} ${r.worst[0].exact}% |`);
