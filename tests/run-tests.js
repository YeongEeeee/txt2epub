#!/usr/bin/env node
/**
 * NovelEPUB 회귀 테스트 러너 — 빌드 도구 없이 Node 내장 vm으로 브라우저 스크립트를 그대로 로드
 *
 *   npm test              → 전체 검사
 *   npm run test:update   → tests/golden.json 재생성 (패턴 감지 결과를 의도적으로 바꿨을 때만)
 *
 * 검사 항목
 *   1. 골든: fixtures/*.txt → splitChapters 결과(챕터 제목 전체)·감지 패턴·계층 목차 형태가 golden.json과 일치
 *   2. Worker 동등성: buildParserWorkerSource()로 만든 파싱 Worker 결과 === 메인 스레드 splitChapters 결과
 *   3. parseSeriesFromName / buildTocTree 단위 케이스
 *   4. EPUB 빌드: epub-gen.js Worker 소스를 실제 실행 → OPF 필수 메타·시리즈·nav/ncx 계층·빈 목차 제목 검사
 *      생성된 EPUB은 tests/out/ 에 저장 → CI에서 epubcheck로 표준 검증
 *   7. Phase 12: 커스텀 폰트 base64·인코딩 감지(UTF-16 무BOM)·슬라이스 경계·URL 표지·Gemini·EPUB 편집 메타
 *   8. Phase 13: 본문 정리(잡음 줄·줄바꿈 병합·기호)·장면 구분선·검수 리포트·인코딩 직접 지정
 *   9. Phase 14: 폰트 파일 분리·landmarks·접근성 메타·리더기 프로필·TXT 삽입 편집 EPUB(→ CI epubcheck)
 */
'use strict';
const fs   = require('fs');
const path = require('path');
const vm   = require('vm');

const ROOT    = path.resolve(__dirname, '..');
const FIX_DIR = path.join(__dirname, 'fixtures');
const GOLDEN  = path.join(__dirname, 'golden.json');
const OUT_DIR = path.join(__dirname, 'out');
const UPDATE  = process.argv.includes('--update');

let passed = 0;
const failures = [];
function check(name, cond, detail){
  if(cond) passed++;
  else failures.push(name + (detail ? '\n      ' + detail : ''));
}
const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);

// ── 브라우저 전역 최소 스텁 + 앱 스크립트 로드 ──
function makeAppContext(){
  const noop = () => {};
  const toasts = [];
  const ctx = {
    console, setTimeout, clearTimeout, setImmediate, TextDecoder, TextEncoder, Blob, URL, structuredClone,
    Toast: { info: m => toasts.push(['info', m]), warn: m => toasts.push(['warn', m]),
             success: m => toasts.push(['success', m]), error: m => toasts.push(['error', m]) },
    document: { getElementById: () => null, querySelector: () => null, querySelectorAll: () => [],
                createElement: () => ({ style: {}, appendChild: noop, setAttribute: noop }),
                addEventListener: noop, body: { appendChild: noop } },
    localStorage: { getItem: () => null, setItem: noop, removeItem: noop },
    navigator: { hardwareConcurrency: 4 },
    requestAnimationFrame: f => setTimeout(f, 0),
  };
  ctx.window = ctx; ctx.self = ctx;
  vm.createContext(ctx);
  ctx.__toasts = toasts;
  return ctx;
}
function loadScript(ctx, file){
  vm.runInContext(fs.readFileSync(path.join(ROOT, file), 'utf8'), ctx, { filename: file });
}

// ── Worker 소스를 별도 컨텍스트에서 실행하고 메시지 1회 왕복 ──
// extra: 추가 전역 객체 또는 (wctx) => 추가 전역 객체 (importScripts처럼 컨텍스트 참조가 필요한 경우)
function runWorker(src, message, extra = {}){
  return new Promise((resolve, reject) => {
    const msgs = [];
    const wctx = {
      console, setTimeout, clearTimeout, setImmediate, TextDecoder, TextEncoder, Blob, URL,
      postMessage(m){
        msgs.push(m);
        if(['DONE', 'done', 'ERROR', 'error'].includes(m.type)) resolve({ last: m, msgs });
      },
    };
    Object.assign(wctx, typeof extra === 'function' ? extra(wctx) : extra);
    wctx.self = wctx;
    vm.createContext(wctx);
    try{
      vm.runInContext(src, wctx, { filename: 'worker-src.js' });
      // 브라우저 postMessage처럼 ArrayBuffer를 Worker 렐름 객체로 복사 (JSZip의 instanceof 검사 통과용)
      const WAB = vm.runInContext('ArrayBuffer', wctx), WU8 = vm.runInContext('Uint8Array', wctx);
      const toRealm = v => {
        if(v instanceof ArrayBuffer){ const ab = new WAB(v.byteLength); new WU8(ab).set(new Uint8Array(v)); return ab; }
        if(Array.isArray(v)) return v.map(toRealm);
        if(v && typeof v === 'object'){ const o = {}; for(const k of Object.keys(v)) o[k] = toRealm(v[k]); return o; }
        return v;
      };
      Promise.resolve(wctx.onmessage({ data: toRealm(message) })).catch(reject);
    }catch(e){ reject(e); }
  });
}

async function main(){
  const app = makeAppContext();
  loadScript(app, 'parser.js');
  loadScript(app, 'epub-gen.js');
  const G = expr => vm.runInContext(expr, app);
  const splitChapters  = G('splitChapters');
  const bestPat        = G('bestPat');
  const buildTocTree   = G('buildTocTree');
  const parseSeries    = G('parseSeriesFromName');
  const workerSrc      = G('buildParserWorkerSource()');

  const fixtures = fs.readdirSync(FIX_DIR).filter(f => f.endsWith('.txt')).sort();
  const golden = UPDATE ? {} : JSON.parse(fs.readFileSync(GOLDEN, 'utf8'));
  const treeShape = tree => tree.filter(n => n.children.length).map(n => n.label + ':' + n.children.length);

  // ═══ 1. 골든 + 2. Worker 동등성 ═══
  for(const f of fixtures){
    const raw = fs.readFileSync(path.join(FIX_DIR, f), 'utf8');
    const chapters = splitChapters(raw, '');
    const headings = chapters.map(c => c[0]);
    const tree = buildTocTree(headings.filter(h => h !== '서문').map(h => ({ label: h, heading: h, href: '#' })));
    const actual = { pattern: bestPat(raw).name || '', count: chapters.length, headings, tree: treeShape(tree) };

    if(UPDATE){ golden[f] = actual; }
    else{
      const exp = golden[f];
      check(`[골든] ${f} 등록 여부`, !!exp, 'golden.json에 없음 — npm run test:update 필요');
      if(exp){
        check(`[골든] ${f} 챕터 수`, exp.count === actual.count, `기대 ${exp.count} / 실제 ${actual.count}`);
        check(`[골든] ${f} 챕터 제목`, eq(exp.headings, actual.headings),
          `첫 차이: ${exp.headings.find((h, i) => h !== actual.headings[i]) ?? '(길이 차이)'}`);
        check(`[골든] ${f} 감지 패턴`, exp.pattern === actual.pattern, `기대 ${exp.pattern} / 실제 ${actual.pattern}`);
        check(`[골든] ${f} 계층 목차`, eq(exp.tree, actual.tree), `기대 ${exp.tree} / 실제 ${actual.tree}`);
      }
    }

    const w = await runWorker(workerSrc, { type: 'SPLIT', id: 1, payload: { raw, customPat: '' } });
    check(`[Worker] ${f} 응답 타입`, w.last.type === 'DONE', w.last.error);
    check(`[Worker] ${f} 결과 = 메인 스레드`, eq(w.last.result, chapters));
  }

  // 대용량(10만 줄+) — 실제 splitChaptersAsync 경로에 해당
  {
    const big = fixtures.slice(0, 4).map(f => fs.readFileSync(path.join(FIX_DIR, f), 'utf8')).join('\n').repeat(260);
    const lines = (big.match(/\n/g) || []).length;
    const t0 = Date.now();
    const main = splitChapters(big, '');
    const t1 = Date.now();
    const w = await runWorker(workerSrc, { type: 'SPLIT', id: 9, payload: { raw: big, customPat: '' } });
    check(`[Worker] 대용량 ${lines.toLocaleString()}줄 결과 = 메인 스레드`, w.last.type === 'DONE' && eq(w.last.result, main));
    check('[Worker] 대용량 진행률 메시지 발송', w.msgs.some(m => m.type === 'PROGRESS'));
    console.log(`  · 대용량 파싱 ${lines.toLocaleString()}줄 / ${main.length}챕터 / 메인 ${t1 - t0}ms`);
  }

  // 사용자 정의 패턴 경로
  {
    const raw = fs.readFileSync(path.join(FIX_DIR, '02_n_hwa_keywords.txt'), 'utf8');
    const pat = '^\\d+화$';
    const w = await runWorker(workerSrc, { type: 'SPLIT', id: 2, payload: { raw, customPat: pat } });
    check('[Worker] 사용자 패턴 결과 = 메인 스레드', eq(w.last.result, splitChapters(raw, pat)));
  }

  // ═══ 3. 단위 케이스 ═══
  const seriesCases = [
    ['전지적 독자 시점 3권.txt',               { series: '전지적 독자 시점', index: 3 }],
    ['[홍길동] 나 혼자 레벨업 제2권 각성.txt',  { series: '나 혼자 레벨업', index: 2 }],
    ['괴담 수집가_12권.txt',                   { series: '괴담 수집가', index: 12 }],
    ['Overlord Vol.4.txt',                     { series: 'Overlord', index: 4 }],
    ['검술명가 막내아들 @작가 5권.txt',         null],  // @작가 뒤 '5권'은 작가 쪽 → 제목엔 권 없음
    ['소설 1-3권 합본.txt',                    null],
    ['단편집.txt',                              null],
  ];
  for(const [name, exp] of seriesCases){
    const got = parseSeries(name);
    check(`[시리즈] ${name}`, eq(got, exp), `기대 ${JSON.stringify(exp)} / 실제 ${JSON.stringify(got)}`);
  }

  const T = hs => treeShape(buildTocTree(hs.map(h => ({ label: h, heading: h, href: '#' }))));
  check('[트리] 평면 목차 유지', eq(T(['1화', '2화', '3화']), []));
  check('[트리] 권 > 화', eq(T(['프롤로그', '1권', '1화', '2화', '2권', '3화']), ['1권:2', '2권:1']));
  check('[트리] N부 N화 합성 그룹', eq(T(['1부 1화', '1부 2화', '2부 1화']), ['1부:2', '2부:1']));
  check('[트리] 권만 나열(자식 없음) → 평면', eq(T(['1권', '2권', '3권']), []));
  check('[트리] 그룹 1개뿐 → 평면', eq(T(['1권', '1화', '2화']), []));
  check('[트리] Vol. 영문', eq(T(['Vol.1', 'Chapter 1', 'Vol.2', 'Chapter 2']), ['Vol.1:1', 'Vol.2:1']));
  check('[트리] 프롤로그는 최상위', buildTocTree([{label:'프롤로그',href:'#'},{label:'1권',href:'#'},{label:'1화',href:'#'},{label:'2권',href:'#'},{label:'2화',href:'#'}])[0].children.length === 0);

  // 파싱 보조 판별
  const matchHeading = G('_matchHeading'), isListItem = G('_isListItemLine');
  check('[파싱] 미리보기 매칭: 대괄호 제목 [1화]', matchHeading(/^\d+화(?:\s*.+)?$/i, '[1화] 시작'));
  check('[파싱] 미리보기 매칭: 전각 숫자 제１화', matchHeading(/^제\s*\d+\s*화(?:\s*.+)?$/, '제１화 시작'));
  check('[파싱] 번호 목록 연속 줄은 목록', isListItem(['준비물', '1. 검', '2. 방패'], 1));
  check('[파싱] 단독 번호 제목은 목록 아님', !isListItem(['', '1. 서막', ''], 1));
  check('[파싱] 제목 공백 보존', splitChapters('\n제1화 만남\n\n본문\n본문\n\n제2화 이별\n\n본문\n본문\n\n제3화 끝\n\n본문\n', '').some(c => c[0] === '제1화 만남'));

  // ═══ 3-2. 실전형 정확도 (사용자 예시 파일명 5종 — 복합 패턴·잡음) ═══
  //  기준: 파일명 화수 대비 본편 화수 오차 ≤ 5%, 제목 줄 정밀도·재현율 ≥ 98%
  {
    const { generate, SPECS } = require('./gen-realistic.js');
    const detectToc = G('detectToc'), parseRange = G('parseChapterRange');
    for(const spec of SPECS){
      const g = generate(spec);
      const lines = g.text.split('\n');
      const range = parseRange(g.fileName);
      const t0 = Date.now();
      const det = detectToc(lines, { range });
      const ms = Date.now() - t0;
      const truth = new Set(g.truth.map(t => t.line)), got = new Set(det.items.map(i => i.line));
      const tp = [...got].filter(l => truth.has(l)).length;
      const precision = tp / Math.max(1, got.size), recall = tp / Math.max(1, truth.size);
      const err = Math.abs(det.stats.errorRate);
      const short = spec.name.slice(0, 14);
      check(`[실전] ${short} 화수 범위 해석`, range && range.total === spec.range[1] - spec.range[0] + 1, JSON.stringify(range));
      check(`[실전] ${short} 오차 ≤ 5%`, err <= 0.05, `감지 ${det.stats.main} / 파일명 ${range.total} (${(det.stats.errorRate*100).toFixed(1)}%)`);
      check(`[실전] ${short} 정밀도 ≥ 98%`, precision >= 0.98, (precision*100).toFixed(1)+'%');
      check(`[실전] ${short} 재현율 ≥ 98%`, recall >= 0.98, (recall*100).toFixed(1)+'%');
      // 화수 정보가 없어도(파일명 범위 없이) 같은 품질
      const noRange = detectToc(lines, {});
      check(`[실전] ${short} 파일명 없이도 동일`, noRange.items.length === det.items.length);
      console.log(`  · ${short.padEnd(14)} 본편 ${det.stats.main}/${range.total} (${(det.stats.errorRate*100).toFixed(1)}%) · 정밀도 ${(precision*100).toFixed(1)}% · 재현율 ${(recall*100).toFixed(1)}% · ${ms}ms · ${det.name}`);
    }
    // 실전형 최대 파일(4만 줄)로 Worker 동등성 + 범위 옵션 전달
    const g = generate(SPECS[3]);
    const opts = { range: parseRange(g.fileName) };
    const w = await runWorker(workerSrc, { type: 'SPLIT', id: 7, payload: { raw: g.text, customPat: '', opts } });
    check('[실전] Worker 결과 = 메인 스레드 (범위 옵션 포함)', w.last.type === 'DONE' && eq(w.last.result, splitChapters(g.text, '', opts)));
  }

  // ═══ 3-3. 이전에 실패하던 형식 9종 ═══
  {
    const B = ['그는 걸었다.', '', '바람이 불었다.', '', '"괜찮아?"', '', '그녀가 물었다.'];
    const mk = (hs, body = B) => hs.map(h => h + '\n\n' + body.join('\n')).join('\n\n');
    const H = raw => splitChapters(raw, '').map(c => c[0]);
    const long = H(mk(['제1화 회귀한 마법사는 오늘도 도서관 지하에서 금서를 읽는다', '제2화 회귀한 마법사는 오늘도 도서관 지하에서 금서를 찾는다', '제3화 회귀한 마법사는 오늘도 도서관 지하에서 금서를 태운다', '제4화 짧은 제목']));
    check('[형식] 30자 넘는 긴 제목', long.length === 4, long.join(' / '));
    const digit = H(mk(['1화', '2화', '3화', '4화'], ['3년이 지났다.', '', '100명의 병사가 몰려왔다.', '', '2층으로 올라갔다.']));
    check('[형식] 숫자로 시작하는 본문 줄 무시', eq(digit, ['1화', '2화', '3화', '4화']), digit.join(' / '));
    const two = H(mk(['1화\n시작의 날', '2화\n두 번째 만남', '3화\n결전', '4화\n끝']));
    check('[형식] 두 줄 제목 결합', eq(two, ['1화 시작의 날', '2화 두 번째 만남', '3화 결전', '4화 끝']), two.join(' / '));
    const compact = H(['1화', '그는 걸었다.', '바람이 불었다.', '2화', '그는 걸었다.', '3화', '그녀가 물었다.', '4화', '끝이었다.'].join('\n'));
    check('[형식] 빈 줄 없는 TXT', compact.length === 4, compact.join(' / '));
    const hdrRaw = ['작품명', '', '1화 시작', '', ...B, '', '작품명', '', '2화 만남', '', ...B, '', '작품명', '', '3화 끝', '', ...B, '', '작품명', '', '4화 재회', '', ...B, '', '작품명', '', '5화 이별', '', ...B].join('\n');
    const hdr = splitChapters(hdrRaw, '');
    check('[형식] 반복 머리줄 제거', hdr.length === 5 && hdr.every(([, b]) => !b.includes('작품명')), hdr.map(c => c[0]).join(' / '));
    const mention = H(mk(['제1화 시작', '제2화 만남', '제3화 이별', '제4화 재회'], ['그는 말했다.', '', '1화', '', '라는 단어가 떠올랐다.']));
    check('[형식] 본문 속 \'1화\' 언급 무시', eq(mention, ['제1화 시작', '제2화 만남', '제3화 이별', '제4화 재회']), mention.join(' / '));
    const scenes = splitChapters(Array.from({ length: 30 }, () => Array(40).fill('그는 걸었다.').join('\n') + '\n\n***\n').join('\n'), '');
    check('[형식] 장면 구분자 경계 페이지 분할', scenes.length > 1 && scenes.every(([, b]) => !b.startsWith('***')), scenes.length + '페이지');
    const partsRaw = mk(['120화 (1)', '120화 (2)', '121화 (1)', '121화 (2)']);
    check('[형식] 같은 화 분할 인식', H(partsRaw).length === 4);
    const merged = splitChapters(partsRaw, '', { mergeParts: true }).map(c => c[0]);
    check('[형식] 같은 화 분할 합치기 옵션', eq(merged, ['120화', '121화']), merged.join(' / '));
    const kwRaw = ['프롤로그', '', ...B, '', '1화', '', ...B, '', '2화', '', ...B, '', '3화', '', ...B, '', '외전 1', '', ...B, '', '에필로그', '', ...B].join('\n');
    const detK = G('detectToc')(kwRaw.split('\n'), {});
    check('[형식] 미리보기에도 프롤로그·외전·에필로그', eq(detK.items.map(i => i.title), ['프롤로그', '1화', '2화', '3화', '외전 1', '에필로그']), detK.items.map(i => i.title).join(' / '));
    // 서문·본문 없는 제목 보존 (buildChaptersFromTocItems 경로)
    const lines2 = ['작품 소개', '', '1권', '1화', '본문', '', '2화', '본문'];
    const built = G('buildChaptersFromTocItems')(lines2, [{ line: 3, title: '1권', enabled: true }, { line: 4, title: '1화', enabled: true }, { line: 7, title: '2화', enabled: true }], null);
    check('[형식] 서문·본문 없는 제목 보존', eq(built.map(c => c[0]), ['서문', '1권', '1화', '2화']), built.map(c => c[0]).join(' / '));
    // 여러 파일: 파일 시작에 제목이 없으면 파일명이 제목
    const { text, fileBreaks } = G('joinTextsWithBreaks')(['본문 가', '본문 나', '본문 다'], ['001_시작.txt', '002_전개.txt', '003_결말.txt']);
    const fb = G('detectToc')(text.split('\n'), { fileBreaks });
    check('[형식] 파일 경계 → 파일명 제목', eq(fb.items.map(i => i.title), ['001_시작', '002_전개', '003_결말']), fb.items.map(i => i.title).join(' / '));
  }

  // ═══ 3-4. v3 이식 (917b27b → Phase 10 엔진) — 형식 3종 · 간격 분할 엔진 · 일괄 프리셋 ═══
  {
    const para = n => Array.from({ length: 6 }, (_, j) => `그는 ${n}번째 장면 ${j}에서 천천히 걸어갔다.`).join('\n');
    const noise = ['3장이 남았다', '10화를 봤다', '5회째 실패', '2막이 올랐다', '1: 0으로 끝났다', '12 - 3 = 9', '7장의 카드'];
    const mkN = (head, blank) => { let s = ''; for(let i = 1; i <= 30; i++){ const g = blank ? '\n\n' : '\n'; s += head(i) + g + para(i) + g + noise[i % noise.length] + g + para(i) + g; } return s; };
    const H = raw => splitChapters(raw, '').map(c => c[0]).filter(h => h !== '서문');
    for(const [label, head] of [['[N] 제목', i => `[${i}] 그날`], ['N - 제목', i => `${i} - 그날`], ['N: 제목', i => `${i}: 그날`], ['제N막', i => `제${i}막`]]){
      for(const blank of [true, false]){
        const h = H(mkN(head, blank));
        check(`[v3] ${label}${blank ? '' : ' (빈 줄 없음)'} 30화 · 본문 오탐 0`, h.length === 30 && !h.some(t => noise.includes(t)), h.length + '개: ' + h.filter(t => noise.includes(t)).join(', '));
      }
    }
    const ideo = H(Array.from({ length: 5 }, (_, i) => `제　${i + 1}　화\n\n${para(i)}`).join('\n\n'));
    check('[v3] 전각 공백 제목 → 일반 공백', ideo[0] === '제 1 화' && ideo.length === 5, ideo.join(' / '));

    // 간격 분할 엔진
    const computeIntervalSplit = G('computeIntervalSplit'), toCh = G('intervalItemsToChapters'), est = G('estimateIntervalTotal');
    const L = [], heads = [];
    for(let i = 1; i <= 40; i++){ heads.push(L.length); L.push(`${i}화`, ''); for(let k = 0; k < 20 + (i * 37) % 180; k++) L.push(`문장 ${i}-${k}이다.`); L.push(''); }
    const items = computeIntervalSplit(L, 40, { titleMode: 'number', titleTemplate: '제{N}화' });
    const starts = items.map(t => t.line - 1);
    check('[간격] 화수 = 제목 줄 수면 모든 경계가 제목 줄', items.length === 40 && starts.every((s, k) => s === heads[k]), starts.filter((s, k) => s !== heads[k]).length + '개 어긋남');
    check('[간격] 제목 템플릿', items[0].title === '제1화' && items[39].title === '제40화');
    const outCh = toCh(L, items);
    const nb = a => a.filter(l => String(l).trim()).length;
    check('[간격] Zero-Loss (원문 비공백 줄 = 출력)', nb(L) === outCh.reduce((s, c) => s + nb(c[1].split('\n')), 0) && outCh[0][0] === '제1화');
    const P = []; for(let i = 0; i < 3000; i++){ P.push(`문장 ${i}입니다.`); if(i % 7 === 6) P.push(''); }
    const pit = computeIntervalSplit(P, 25, { titleMode: 'number' });
    check('[간격] 제목 없는 원고 — 첫 화 1줄·단조 증가·화수', pit.length === 25 && pit[0].line === 1 && pit.every((t, k) => !k || t.line > pit[k - 1].line));
    check('[간격] 줄 수보다 큰 화수·빈 원문', computeIntervalSplit(['a', 'b', 'c'], 10).length === 3 && computeIntervalSplit([], 5).length === 0);
    check('[간격] 화수 추정: 파일명 범위 우선', est(P, '소설_1-277.txt') === 277);
    check('[간격] 화수 추정: 감지된 목차 수', est(L, '') === 40);
  }

  // ═══ 4. EPUB 빌드 ═══
  const JSZip = require('jszip');
  const jszipSrc = fs.readFileSync(require.resolve('jszip/dist/jszip.min.js'), 'utf8');
  const epubSrc = G("_buildWorkerSrc('jszip')");
  fs.mkdirSync(OUT_DIR, { recursive: true });

  // 1×1 PNG (zlib로 즉석 생성 — 바이너리 픽스처 없이 표지·삽화 경로 검사)
  function tinyPng(){
    const zlib = require('zlib');
    const crc = buf => { let c, t = []; for(let n = 0; n < 256; n++){ c = n; for(let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; }
      let x = 0xFFFFFFFF; for(const b of buf) x = t[(x ^ b) & 0xFF] ^ (x >>> 8); return (x ^ 0xFFFFFFFF) >>> 0; };
    const chunk = (type, data) => { const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
      const td = Buffer.concat([Buffer.from(type), data]); const c = Buffer.alloc(4); c.writeUInt32BE(crc(td)); return Buffer.concat([len, td, c]); };
    const ihdr = Buffer.from([0,0,0,1, 0,0,0,1, 8, 2, 0, 0, 0]);
    const png = Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]), chunk('IHDR', ihdr),
      chunk('IDAT', zlib.deflateSync(Buffer.from([0, 200, 100, 50]))), chunk('IEND', Buffer.alloc(0))]);
    return png.buffer.slice(png.byteOffset, png.byteOffset + png.length);
  }

  async function buildEpubFor(fixture, meta){
    const raw = fs.readFileSync(path.join(FIX_DIR, fixture), 'utf8');
    const chapters = splitChapters(raw, '');
    const params = {
      // runWorker가 메시지를 Worker 렐름으로 복제하므로 Worker의 chapters.length=0 해제가 원본에 영향 없음
      title: meta.title, author: '테스트 작가', chapters, illMapMeta: [], useItalic: true, showChTitle: true,
      compressionLevel: 6, lang: 'ko', uid: 'urn:uuid:00000000-0000-4000-8000-000000000000',
      today: '2026-10-17', modified: '2026-10-17T00:00:00Z',
      publisher: meta.publisher || '', series: meta.series || '', seriesIndex: meta.seriesIndex || 0,
      removeBlankLines: false,
    };
    const imageData = meta.withImages
      ? { cover: { ab: tinyPng(), ext: 'png', mt: 'image/png' }, ills: [{ ab: tinyPng(), ext: 'png', mt: 'image/png', file_idx: 0 }] }
      : { cover: null, ills: [] };
    if(meta.withImages) params.illMapMeta = [{ idx: 2, pos: 'before', file_idx: 0 }];
    const w = await runWorker(epubSrc, { params, imageData, cssText: 'p{text-indent:1em}' },
      wctx => ({ importScripts(){ vm.runInContext(jszipSrc, wctx); } }));
    if(w.last.type !== 'done') throw new Error('EPUB Worker 실패: ' + w.last.message);
    const buf = Buffer.from(await w.last.blob.arrayBuffer());
    fs.writeFileSync(path.join(OUT_DIR, fixture.replace(/\.txt$/, '.epub')), buf);
    const zip = await JSZip.loadAsync(buf);
    const read = p => zip.file(p).async('string');
    return { zip, buf, opf: await read('OEBPS/content.opf'), nav: await read('OEBPS/nav.xhtml'), ncx: await read('OEBPS/toc.ncx'), chapters };
  }

  // 4-1. 기본 + 출판사 + 시리즈 + 계층 목차
  {
    const e = await buildEpubFor('08_volume_hier.txt', { title: '계층 테스트', publisher: '테스트 출판', series: '테스트 시리즈', seriesIndex: 2 });
    check('[EPUB] mimetype 첫 항목·무압축', e.buf.slice(30, 38).toString() === 'mimetype' && e.buf.readUInt16LE(8) === 0);
    check('[EPUB] container.xml OCF 네임스페이스', (await e.zip.file('META-INF/container.xml').async('string')).includes('xmlns="urn:oasis:names:tc:opendocument:xmlns:container"'));
    check('[EPUB] dcterms:modified 존재', /<meta property="dcterms:modified">\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ<\/meta>/.test(e.opf));
    check('[EPUB] dc:publisher 설정값 반영', e.opf.includes('<dc:publisher>테스트 출판</dc:publisher>'));
    check('[EPUB] belongs-to-collection', e.opf.includes('<meta property="belongs-to-collection" id="series">테스트 시리즈</meta>'));
    check('[EPUB] group-position', e.opf.includes('<meta refines="#series" property="group-position">2</meta>'));
    check('[EPUB] calibre:series(_index)', e.opf.includes('<meta name="calibre:series" content="테스트 시리즈"/>') && e.opf.includes('<meta name="calibre:series_index" content="2"/>'));
    check('[EPUB] dc:identifier urn:uuid', e.opf.includes('<dc:identifier id="uid">urn:uuid:'));
    const navLabels = [...e.nav.matchAll(/<a href="[^"]+">([^<]*)<\/a>/g)].map(m => m[1]);
    const ncxLabels = [...e.ncx.matchAll(/<text>([^<]*)<\/text>/g)].map(m => m[1]).slice(1); // [0]=docTitle
    check('[EPUB] nav 목차 제목이 비어있지 않음', navLabels.length > 0 && navLabels.every(Boolean), `빈 제목 ${navLabels.filter(l => !l).length}개`);
    check('[EPUB] ncx 목차 제목이 비어있지 않음', ncxLabels.length > 0 && ncxLabels.every(Boolean));
    const tocNav = e.nav.split('epub:type="landmarks"')[0];   // ★ Phase 14: landmarks nav의 ol 제외
    check('[EPUB] nav 2단계 중첩 ol', (tocNav.match(/<ol>/g) || []).length === 4, `ol ${(tocNav.match(/<ol>/g) || []).length}개 (기대 4 = 최상위 1 + 권 3)`);
    check('[EPUB] ncx dtb:depth=2', e.ncx.includes('<meta name="dtb:depth" content="2"/>'));
    const orders = [...e.ncx.matchAll(/playOrder="(\d+)"/g)].map(m => +m[1]);
    check('[EPUB] ncx playOrder 1..N 연속', orders.every((o, i) => o === i + 1), orders.join(','));
    check('[EPUB] nav 항목 수 = 서문 제외 챕터 수', navLabels.length === e.chapters.filter(c => c[0] !== '서문').length);
  }
  // 4-2. 출판사·시리즈 미입력 → 태그 생략, 평면 목차
  {
    const e = await buildEpubFor('01_je_n_hwa.txt', { title: '평면 테스트' });
    check('[EPUB] 출판사 비우면 dc:publisher 생략', !e.opf.includes('<dc:publisher>'));
    check('[EPUB] 시리즈 비우면 컬렉션 메타 생략', !e.opf.includes('belongs-to-collection') && !e.opf.includes('calibre:series'));
    check('[EPUB] 평면 목차 ol 1개', (e.nav.split('epub:type="landmarks"')[0].match(/<ol>/g) || []).length === 1);
    check('[EPUB] 평면 ncx dtb:depth=1', e.ncx.includes('<meta name="dtb:depth" content="1"/>'));
    check('[EPUB] 서문도 읽기 순서·목차에 포함', />서문</.test(e.nav) && /<itemref idref="ch_0000"\/>/.test(e.opf));
    // 앱 UI용 CSS 토큰(var(--…))이 EPUB 본문·스타일로 새어 나가지 않았는지 (리더기는 앱 변수를 모름)
    const texts = await Promise.all(Object.keys(e.zip.files).filter(n => /\.(xhtml|css|opf|ncx)$/.test(n)).map(n => e.zip.file(n).async('string')));
    check('[EPUB] 앱 CSS 변수 미유출', texts.every(t => !t.includes('var(--')));
  }
  // 4-3. 표지 + 삽화
  {
    const e = await buildEpubFor('03_angle_hwa.txt', { title: '이미지 테스트', withImages: true });
    check('[EPUB] 표지 cover-image 속성', /<item id="cover_img" href="Images\/img_0000\.png" media-type="image\/png" properties="cover-image"\/>/.test(e.opf));
    check('[EPUB] 표지 페이지 스파인 첫 항목', /<spine toc="ncx">\n<itemref idref="cover_xhtml"\/>/.test(e.opf));
    check('[EPUB] 삽화 페이지 생성', !!e.zip.file('OEBPS/Text/ill_0000.xhtml'));
    check('[EPUB] 삽화는 목차에 미포함', !/삽화<\/a>/.test(e.nav) || /〈3화〉[^<]*삽화<\/a>/.test(e.nav));
  }
  // 4-4. 나머지 픽스처도 EPUB 생성 (CI epubcheck 대상)
  for(const f of ['02_n_hwa_keywords.txt', '09_part_hwa.txt', '11_no_pattern.txt']){
    const e = await buildEpubFor(f, { title: f });
    check(`[EPUB] ${f} 생성`, e.buf.length > 0);
    if(f === '09_part_hwa.txt'){
      // 합성 그룹 노드는 첫 자식과 같은 문서 → 같은 playOrder (NCX 규칙)
      const pts = [...e.ncx.matchAll(/playOrder="(\d+)"><navLabel><text>[^<]*<\/text><\/navLabel><content src="([^"]+)"/g)];
      const byHref = {};
      check('[EPUB] 같은 문서 navPoint는 같은 playOrder', pts.every(([, po, href]) => (byHref[href] ??= po) === po));
    }
  }

  // ── 5. 배포·보안 정적 검사 (Phase 9) ──
  {
    const read = f => fs.readFileSync(path.join(ROOT, f), 'utf8');
    const html = read('index.html'), sw = read('sw.js'), mainJs = read('main.js'), ui = read('ui-state.js');
    // 5-1. index.html이 읽는 로컬 스크립트·스타일과 worker.js가 모두 SW 프리캐시 목록에 있어야 오프라인 동작
    const coreBlock = (sw.match(/const CORE_ASSETS = \[([\s\S]*?)\];/) || [])[1] || '';
    const cached = new Set([...coreBlock.matchAll(/'([^']+)'/g)].map(m => m[1].replace(/^\.\//, '')));
    const needed = [...html.matchAll(/<script src="([^"]+)"/g), ...html.matchAll(/<link[^>]+href="([^"]+\.css)"/g)]
      .map(m => m[1]).filter(u => !/^https?:/.test(u)).concat(['worker.js']);
    const missing = needed.filter(u => !cached.has(u));
    check('[배포] SW CORE_ASSETS가 index.html 로컬 자원을 모두 포함', missing.length === 0, missing.join(', '));
    // 5-2. 캐시 버전 문자열은 sw.js 한 곳에만 (main.js 하드코딩 금지)
    check('[배포] main.js에 캐시 버전 하드코딩 없음', !/novelepub-\d{4}-/.test(mainJs));
    check('[배포] sw.js에 캐시 전체 삭제 CHECK_CACHE 경로 없음', !/e\.data\.type === 'CHECK_CACHE'/.test(sw));
    // 5-3. 표지 검색 등 동적 외부 요청은 Cache-first 대상이 아님
    check('[배포] 외부 요청 Cache-first는 정적 자원 한정', /if \(_isStaticExternal\(url\)\) e\.respondWith/.test(sw));
    // 5-4. 전역 단축키 keydown 핸들러는 1개
    const kd = (mainJs.match(/document\.addEventListener\(\s*'keydown'/g) || []).length
             + (ui.match(/document\.addEventListener\(\s*'keydown'/g) || []).length;
    check('[UI] 전역 단축키 핸들러 단일화', kd === 1, `document keydown ${kd}개`);
    // 5-5. 챕터 제목이 들어가는 차트 툴팁은 innerHTML 미사용
    check('[보안] 목차 차트 툴팁 innerHTML 미사용', !/_tipEl\.innerHTML|Tip\w*\.innerHTML/.test(read('convert.js')));
    check('[보안] Toast/confirm은 _sanitizeHtml 경유', !/parseFromString\(msg/.test(read('core.js')) && /function _sanitizeHtml/.test(read('core.js')));
  }

  // ── 6. Phase 10 회귀 (본문 렌더링·목차 줄 범위 모델·삽화 매핑·성능·Worker 감지) ──
  {
    // 6-1. 본문 렌더링: 메인 스레드 = EPUB Worker (단일 소스) + 손실·오분류 없음
    const renderMain = G('renderBodyHtml');
    const wctx = { console }; wctx.self = wctx; vm.createContext(wctx);
    vm.runInContext(epubSrc.replace(/^importScripts\(.*\);$/m, ''), wctx);
    const cases = ['2층 [창고]', '6시 방향 [적]', '≪상태창≫', '【스킬】 화염', '[퀘스트 완료]', '웃음😀 𠀀한자', '단어 단어',
      'HP &amp; MP <강화>', '&lt;시스템&gt; 알림', '&#128512; ok', 'bad &#0; &#xD800;', '\uD800짝없음', '— 회상', 'a​b'];
    check('[렌더] 메인 스레드 = EPUB Worker', cases.every(c => renderMain(c) === wctx.renderBodyHtml(c)));
    const R = c => renderMain(c).trim();
    check('[렌더] 숫자로 시작해 ]로 끝나는 본문은 일반 문단', R('2층 [창고]') === '<p>2층 [창고]</p>' && R('6시 방향 [적]') === '<p>6시 방향 [적]</p>');
    check('[렌더] ≪≫ 상태창은 sysmsg', R('≪상태창≫').includes('sysmsg'));
    check('[렌더] 이모지·확장 한자 보존', R('웃음😀 𠀀한자') === '<p>웃음😀 𠀀한자</p>');
    check('[렌더] NBSP는 공백', R('단어 단어') === '<p>단어 단어</p>');
    check('[렌더] 엔티티+날것 < 혼재 → 모두 이스케이프', R('HP &amp; MP <강화>') === '<p>HP &amp; MP &lt;강화&gt;</p>');
    check('[렌더] 짝 없는 서로게이트 제거', R('\uD800짝없음') === '<p>짝없음</p>');
    check('[렌더] 무효 숫자 엔티티는 문자열로 안전 처리', R('bad &#0; &#xD800;') === '<p>bad &amp;#0; &amp;#xD800;</p>');
    // XHTML 파싱 가능 여부 (날것 <, & 없음)
    const xh = cases.map(R).join('');
    check('[렌더] 출력에 날것 < 또는 미이스케이프 & 없음', !/<(?!\/?(p|em)\b)/.test(xh) && !/&(?!(amp|lt|gt|quot|#\d+|#39);)/.test(xh));

    // 6-2. 목차 줄 범위 모델 — 순서 변경·떨어진 병합·분리·비활성·통계
    const L = ['머리말', '', '1화', 'A1', 'A2', '', '2화', 'B1', '', '3화', 'C1', 'C2', 'C3', '', '4화', 'D1'];
    const mk = () => [{ line: 3, title: '1화', enabled: true, num: 1, kind: 'ch' }, { line: 7, title: '2화', enabled: true, num: 2, kind: 'ch' },
                      { line: 10, title: '3화', enabled: true, num: 3, kind: 'ch' }, { line: 15, title: '4화', enabled: true, num: 4, kind: 'ch' }];
    const build = G('buildChaptersFromTocItems');
    app.S = { tocItems: mk() };
    let out = build(L, app.S.tocItems, null);
    check('[목차] 기본 조립 + 서문 meta', eq(out.map(c => c[0]), ['서문', '1화', '2화', '3화', '4화']) && out[0][2]?.pre === true && out[1][2]?.num === 1);
    const moved = mk(); moved.unshift(moved.splice(2, 1)[0]);   // 3화를 맨 앞으로
    out = build(L, moved, null);
    check('[목차] 드래그 순서 변경이 출력에 반영', eq(out.map(c => c[0]), ['서문', '3화', '1화', '2화', '4화']) && out[1][1] === 'C1\nC2\nC3');
    app.S = { tocItems: mk() };
    const res = G('_tocMergeItems')([0, 2]);   // 1화 + 3화 (떨어진 항목)
    out = build(L, app.S.tocItems, null);
    check('[목차] 떨어진 항목 병합 = 두 범위만 결합', res && eq(out.map(c => c[0]), ['서문', '1화 + 3화', '2화', '4화']) &&
      out[1][1] === 'A1\nA2\n\n3화\nC1\nC2\nC3' && out[2][1] === 'B1', JSON.stringify(out));
    check('[목차] 병합 원본 줄 번호 보존(분리용)', eq(app.S.tocItems[0]._mergedSources.map(s => s.line), [3, 10]));
    const stats = G('_recalcTocStats')(mk(), L, 50);
    check('[목차] 글자수 통계 = 줄 범위', eq(stats.map(t => t.bodyLen), [4, 2, 6, 2]), stats.map(t => t.bodyLen).join(','));
    check('[목차] 짧은 챕터 판정(마지막 제외)', eq(stats.map(t => t.suspicious), [true, true, true, false]));
    const dis = mk(); dis[1].enabled = false;
    out = build(L, dis, null);
    check('[목차] 비활성 항목 내용은 앞 챕터에 이어짐', out.find(c => c[0] === '1화')[1].includes('2화\nB1'));
    const dup = mk(); dup.push({ line: 7, title: '2화 중복', enabled: true });
    out = build(L, dup, null);
    check('[목차] 같은 줄 항목 중복 출력 없음', out.filter(c => c[1] === 'B1').length === 1);
    // 문단 정합 옵션은 조립 후 본문에 적용 (목차 줄 번호 무관)
    const pm = G('applyParagraphMerge')([['1화', '짧은 줄\n또 짧은 줄\n\n' + '긴 줄 '.repeat(10), { num: 1 }]]);
    check('[목차] 문단 정합 적용 + meta 유지', pm[0][1].startsWith('짧은 줄 또 짧은 줄') && pm[0][2]?.num === 1);

    // 6-3. Worker 미리보기 감지(DETECT) = 메인 스레드 detectToc
    const raw = fs.readFileSync(path.join(FIX_DIR, '02_n_hwa_keywords.txt'), 'utf8');
    const wd = await runWorker(workerSrc, { type: 'DETECT', id: 11, payload: { raw, opts: {} } });
    const md = G('detectToc')(raw.split('\n'), {});
    check('[Worker] DETECT 결과 = 메인 스레드', wd.last.type === 'DONE' && eq(wd.last.result.items, md.items) && eq(wd.last.result.dropLines, md.dropLines));

    // 6-4. 성능: 패턴 없는 대용량 TXT (이전 8~11초)
    const big = Array.from({ length: 200000 }, (_, i) => i % 7 ? '그는 천천히 고개를 들어 하늘을 바라보았다. 바람이 불었다 ' + (i % 13) : '').join('\n');
    const t0 = Date.now(); splitChapters(big, ''); const ms = Date.now() - t0;
    check('[성능] 패턴 없는 20만 줄 감지 < 4초', ms < 4000, ms + 'ms');
    console.log(`  · 패턴 없는 20만 줄 감지 ${ms}ms`);

    // 6-5. EPUB 삽화 매핑: 순번은 서문 제외 · 화 번호는 감지 번호(meta.num) · 키워드는 원문 기준
    const chs = [['서문', '소개글', { pre: true }], ['제1부 1화', '첫 화 & 시작', { num: 1 }], ['제2부 15화', '열다섯', { num: 15 }], ['외전', '외전 본문', { num: null }]];
    const params = { title: '삽화', author: 'a', chapters: chs, useItalic: true, showChTitle: true, compressionLevel: 1, lang: 'ko',
      uid: 'urn:uuid:00000000-0000-4000-8000-000000000001', today: '2026-10-17', modified: '2026-10-17T00:00:00Z',
      illMapMeta: [{ idx: 0, pos: 'before', file_idx: 0 }, { ch: 15, pos: 'after', file_idx: 1 }, { kw: '& 시작', pos: 'after', file_idx: 2 }] };
    const imageData = { cover: null, ills: [0, 1, 2].map(i => ({ ab: tinyPng(), ext: 'png', mt: 'image/png', file_idx: i })) };
    const we = await runWorker(epubSrc, { params, imageData, cssText: '' }, w => ({ importScripts(){ vm.runInContext(jszipSrc, w); } }));
    check('[EPUB] 삽화 Worker 성공', we.last.type === 'done', we.last.message);
    if(we.last.type === 'done'){
      const z = await JSZip.loadAsync(Buffer.from(await we.last.blob.arrayBuffer()));
      const opf = await z.file('OEBPS/content.opf').async('string');
      const spine = [...opf.matchAll(/<itemref idref="([^"]+)"\/>/g)].map(m => m[1]);
      check('[EPUB] 01.jpg → 서문이 아닌 첫 챕터 앞', eq(spine, ['ch_0000', 'ill_0000', 'ch_0001', 'ill_0001', 'ch_0002', 'ill_0002', 'ch_0003']) ||
        eq(spine.slice(0, 3), ['ch_0000', 'ill_0000', 'ch_0001']), spine.join(','));
      const ill1 = await z.file('OEBPS/Text/ill_0001.xhtml').async('string');
      const ill2 = await z.file('OEBPS/Text/ill_0002.xhtml').async('string');
      check('[EPUB] 화 번호 15 → \'제2부 15화\' (첫 숫자 2가 아님)', ill1.includes('<title>제1부 1화 삽화</title>') ? ill2.includes('제2부 15화') : ill1.includes('제2부 15화'));
      check('[EPUB] 키워드 매칭은 원문 기준(& 포함)', spine.indexOf('ch_0001') >= 0 && spine[spine.indexOf('ch_0001') + 1] && spine[spine.indexOf('ch_0001') + 1].startsWith('ill_'));
      // 중앙 디렉터리에서 이미지 항목의 압축 방식(0=STORE) 확인
      const zbuf = Buffer.from(await we.last.blob.arrayBuffer());
      const methods = {};
      for(let o = zbuf.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02])); o >= 0; o = zbuf.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]), o + 4)){
        const nameLen = zbuf.readUInt16LE(o + 28);
        methods[zbuf.slice(o + 46, o + 46 + nameLen).toString()] = zbuf.readUInt16LE(o + 10);
      }
      const imgs = Object.keys(methods).filter(n => n.startsWith('OEBPS/Images/') && !n.endsWith('/'));
      check('[EPUB] 이미지는 재압축 없이 STORE', imgs.length === 3 && imgs.every(n => methods[n] === 0), JSON.stringify(methods));
      check('[EPUB] 본문은 DEFLATE', methods['OEBPS/Text/chapter_0001.xhtml'] === 8);
      const ch1 = await z.file('OEBPS/Text/chapter_0001.xhtml').async('string');
      check('[EPUB] XHTML xml:lang', ch1.includes('xml:lang="ko"'));
    }

    // 6-6. 정적 검사 — 상태·저장·배포
    const read = f => fs.readFileSync(path.join(ROOT, f), 'utf8');
    const core = read('core.js'), settings = read('settings.js'), html = read('index.html'), sw = read('sw.js');
    const setBody = ((core.match(/function set\(patch\) \{([\s\S]*?)\n    \}/) || [])[1] || '').replace(/\/\/.*$/gm, '');
    check('[상태] StateManager.set이 기존 배열을 비우지 않음', setBody && !/\.length\s*=\s*0/.test(setBody));
    check('[저장] idbSet은 await + onabort 처리', /async function idbSet[\s\S]*?await new Promise[\s\S]*?tx\.onabort/.test(settings));
    check('[보안] JSZip SRI integrity', /jszip\.min\.js" integrity="sha512-[A-Za-z0-9+/=]+" crossorigin="anonymous"/.test(html));
    check('[배포] SW 외부 자원 CORS 프리캐시', /mode: 'cors'/.test(sw));
    const defs = ['parser.js', 'convert.js', 'main.js'].map(f => (read(f).match(/defineProperty\(window,\s*'_autoSplitActive'/g) || []).length);
    check('[구조] window._autoSplitActive 정의 1곳', defs.reduce((a, b) => a + b, 0) === 1, defs.join('/'));
  }

  const readRoot = f => fs.readFileSync(path.join(ROOT, f), 'utf8');
  // 앱 파일에서 최상위 function/const 선언 하나를 원문 그대로 잘라냄 (DOM 의존 파일을 통째로 로드하지 않기 위함)
  const extract = (src, name) => {
    const m = new RegExp('(?:^|\\n)((?:async\\s+)?function\\s+' + name + '\\s*\\(|const\\s+' + name + '\\s*=)').exec(src);
    if(!m) throw new Error('선언을 찾지 못함: ' + name);
    const start = m.index + (m[0].startsWith('\n') ? 1 : 0);
    const body = start + m[1].length;
    // 한 줄짜리 const (객체·배열 리터럴이 아님) → 줄 끝까지
    if(m[1].startsWith('const') && !/^\s*[{[]/.test(src.slice(body, body + 8))) return src.slice(start, src.indexOf('\n', start));
    // 함수는 매개변수 기본값(opts={})의 중괄호를 건너뛰고 ') {' 뒤 본문부터
    const pm = m[1].startsWith('const') ? null : /\)\s*\{/.exec(src.slice(body));
    let i = pm ? body + pm.index + pm[0].length - 1 : src.indexOf('{', body), depth = 0;
    for(; i < src.length; i++){ if(src[i] === '{') depth++; else if(src[i] === '}' && --depth === 0) break; }
    return src.slice(start, i + 1) + (m[1].startsWith('const') ? ';' : '');
  };
  const sandbox = (file, names, extra = {}) => {
    const c = Object.assign({ console, TextDecoder, URL, btoa, Buffer }, extra);
    vm.createContext(c);
    const src = readRoot(file);
    vm.runInContext(names.map(n => extract(src, n)).join('\n'), c, { filename: file + ':extract' });
    return c;
  };


  // ── 7. Phase 12 회귀 (테스트 밖 경로에서 발견된 버그: 폰트·인코딩·URL 표지·Gemini·편집) ──
  {
    const read = f => fs.readFileSync(path.join(ROOT, f), 'utf8');
    // 7-1. 커스텀 폰트 — base64가 표준 인코딩과 바이트 단위로 일치 (이전: 8192바이트 청크마다 중간 '=' 패딩)
    const S1 = sandbox('settings.js', ['_FONT_FORMATS', '_B64_CHUNK', '_bytesToBase64', '_isValidFontFace', '_safeFontName']);
    const lens = [0, 1, 2, 3, 8189, 8190, 8191, 8192, 20000, 100003];
    const b64ok = lens.every(n => { const b = new Uint8Array(n).map((_, i) => (i * 131 + 7) & 255);
      return vm.runInContext('_bytesToBase64', S1)(b) === Buffer.from(b).toString('base64'); });
    check('[폰트] base64 청크 인코딩 = 표준 base64 (0~100KB)', b64ok);
    const face = fmt => '@font-face{font-family:"X";src:url("data:font/ttf;base64,' + Buffer.from(new Uint8Array(30000).fill(9)).toString('base64') + '") format("' + fmt + '");}\n';
    const isValid = vm.runInContext('_isValidFontFace', S1);
    let broken = ''; for(let i = 0; i < 30000; i += 8192) broken += Buffer.from(new Uint8Array(Math.min(8192, 30000 - i)).fill(9)).toString('base64');
    check('[폰트] 정상 @font-face 검증 통과', isValid(face('truetype')) && isValid(face('woff2')));
    check('[폰트] 이전 버전 손상 데이터·format("ttf") 감지', !isValid(face('ttf')) &&
      !isValid('@font-face{font-family:"X";src:url("data:font/truetype;base64,' + broken + '") format("truetype");}'));
    check('[폰트] 폰트 이름의 따옴표·역슬래시 제거', vm.runInContext('_safeFontName', S1)('나눔"명조\\체') === '나눔명조체');
    check('[폰트] format()은 표준 키워드 사용', !/format\("'\+ext\+'"\)/.test(read('settings.js')) && /format\("'\+fontInfo\.fmt\+'"\)/.test(read('settings.js')));

    // 7-2. 인코딩 감지 (단일 소스) — UTF-16 무BOM·UTF-8·EUC-KR
    const C1 = sandbox('convert.js', ['_countChar', '_detectUtf16NoBom', '_detectEncodingFromAB', '_sliceBounds', '_withCacheBust', '_parseHttpUrl']);
    const det = buf => vm.runInContext('_detectEncodingFromAB', C1)(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.length));
    const ko = ('제1화 시작\n그는 문을 열었다. "누구세요?" 대답이 없었다.\n' ).repeat(80);
    const le = Buffer.from(ko, 'utf16le');
    const be = Buffer.from(le); be.swap16();
    // EUC-KR 바이트: 가(B0A1) 나(B3AA) 다(B4D9) + 공백·줄바꿈
    const euc = Buffer.from(Array.from({ length: 600 }, (_, i) => i % 7 === 6 ? [0x0A] : i % 4 === 3 ? [0x20] : [[0xB0,0xA1],[0xB3,0xAA],[0xB4,0xD9]][i % 3]).flat());
    check('[인코딩] BOM 없는 UTF-16LE 감지', det(le) === 'utf-16le');
    check('[인코딩] BOM 없는 UTF-16BE 감지', det(be) === 'utf-16be');
    check('[인코딩] UTF-8 한글은 UTF-8', det(Buffer.from(ko, 'utf8')) === 'utf-8');
    check('[인코딩] EUC-KR 바이트는 euc-kr', det(euc) === 'euc-kr');
    check('[인코딩] worker.js 감지 복사본 제거', !/function detectEncoding/.test(read('worker.js')));
    check('[인코딩] 파일 목록 감지는 앞 64KB만 읽음', /fileToAB\(file\.slice\(0,65536\)\)/.test(read('convert.js')));

    // 7-3. 슬라이스 경계 — EUC-KR은 줄 단위, UTF-16은 짝수 오프셋, UTF-8은 문자 시작
    const bounds = vm.runInContext('_sliceBounds', C1);
    const [es, ee] = bounds(euc, 5, 200, 0, 10000, 'euc-kr', 4);
    const eucTxt = new TextDecoder('euc-kr').decode(euc.subarray(es, ee));
    check('[슬라이스] EUC-KR 중간 시작도 깨진 글자 없음', es > 0 && euc[es - 1] === 0x0A && !eucTxt.includes('\ufffd'));
    const [us] = bounds(le, 3, 101, 0, 10000, 'utf-16le', 4);
    check('[슬라이스] UTF-16 짝수 오프셋 정렬', us % 2 === 0);
    const u8 = Buffer.from('가나다라마바사', 'utf8');
    const [s8, e8] = bounds(u8, 1, 8, 0, u8.length, 'utf-8', 4);
    check('[슬라이스] UTF-8 연속 바이트 건너뜀', !new TextDecoder().decode(u8.subarray(s8, e8)).includes('\ufffd'));

    // 7-4. URL 표지 — 기존 쿼리 보존·http(s)만 허용·inline onclick 주입 제거
    const bust = vm.runInContext('_withCacheBust', C1)('https://img.cdn.com/a.jpg?type=w500');
    check('[URL표지] 캐시 우회 쿼리가 기존 쿼리를 깨지 않음', bust.split('?').length === 2 && bust.includes('type=w500') && /[&]_nvt=\d+/.test(bust));
    const P = vm.runInContext('_parseHttpUrl', C1);
    check('[URL표지] http(s)만 허용', !P('javascript:alert(1)') && !P('httpx://a.com') && !!P("https://a.com/x'y.jpg"));
    const conv = read('convert.js');
    check('[URL표지] URL을 inline onclick에 넣지 않음', !/window\.open\('\$\{url\}'/.test(conv) && !/url\+'\?'\+\(Date\.now\(\)\)/.test(conv));
    check('[URL표지] 암묵 전역 event 미사용 + 버튼 전달', !/const btn=event\.target;/.test(conv) && /applyCoverUrl\(el\.dataset\.inp,el\.dataset\.thumb,el\.dataset\.name,el\.dataset\.mode,el\)/.test(read('ui-state.js')));
    check('[URL표지] canvas 실패 시 이미지 프록시 체인 경유', /typeof _fetchImgBlob==='function'/.test(conv));

    // 7-5. Gemini — 종료 모델 제거·키는 헤더로·요청 취소 연결
    const st = read('settings.js');
    const models = (st.match(/const GEMINI_MODELS = \[([\s\S]*?)\];/) || [])[1] || '';
    check('[Gemini] 서비스 종료 모델 미사용', models && !/gemini-(2\.0|1\.5)-/.test(models));
    check('[Gemini] API 키는 URL이 아닌 헤더', !/generateContent\?key=/.test(st) && /'x-goog-api-key':apiKey/.test(st));
    check('[Gemini] fetch에 AbortSignal 연결', /body,signal\}\)/.test(st) && /_askGeminiForPattern\(apiKey, include, exclude, abortCtrl\.signal\)/.test(st));
    check('[Gemini] 모델 없음은 할당량 초과와 구분', /'model_unavailable'/.test(st));

    // 7-6. EPUB CSS 다크 모드 — 글자색만 지정하면 다크 배경을 강제하지 않음
    const cssWith = vals => {
      const c = makeAppContext();
      c.document.getElementById = id => (id in vals ? { value: vals[id], checked: false } : null);
      vm.runInContext(read('epub-gen.js'), c, { filename: 'epub-gen.js' });
      return vm.runInContext('buildCss()', c);
    };
    check('[CSS] 색 미지정 시 다크 모드 기본색 유지', /prefers-color-scheme:dark\)\{body\{background-color:#1a1208;color:#e8d8c4;\}\}/.test(cssWith({})));
    check('[CSS] 글자색만 지정하면 다크 모드 배경 강제 안 함', !/prefers-color-scheme/.test(cssWith({ cssTextColor: '#333333' })));

    // 7-7. EPUB 편집 — OPF 경로(container.xml)·dcterms:modified 갱신·mimeType
    const ed = read('edit.js');
    const EC = sandbox('edit.js', ['_epubOpfPath', '_touchOpfModified']);
    const opf3 = '<?xml version="1.0"?><package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="u"><metadata><meta property="dcterms:modified">2020-01-01T00:00:00Z</meta></metadata></package>';
    const opf3n = opf3.replace(/<meta property[^/]+\/meta>/, '');
    const opf2 = '<package version="2.0"><metadata></metadata></package>';
    const z = new JSZip();
    z.file('META-INF/container.xml', '<container><rootfiles><rootfile full-path="OPS/book.opf"/></rootfiles></container>');
    z.file('OPS/book.opf', opf3); z.file('OPS/x.opf', opf2); z.file('OPS/n.opf', opf3n);
    check('[편집] OPF 경로는 container.xml rootfile', await vm.runInContext('_epubOpfPath', EC)(z) === 'OPS/book.opf');
    const touch = vm.runInContext('_touchOpfModified', EC);
    await touch(z, 'OPS/book.opf'); await touch(z, 'OPS/x.opf'); await touch(z, 'OPS/n.opf');
    const t3 = await z.file('OPS/book.opf').async('string'), t2 = await z.file('OPS/x.opf').async('string'), tn = await z.file('OPS/n.opf').async('string');
    check('[편집] dcterms:modified 갱신 (EPUB3)', !t3.includes('2020-01-01') && /dcterms:modified">\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ</.test(t3));
    check('[편집] dcterms:modified 없으면 추가, EPUB2는 그대로', /dcterms:modified">\d{4}-/.test(tn) && t2 === opf2);
    check('[편집] EPUB 결과 Blob mimeType 지정', (ed.match(/newZip\.generateAsync\(\{type:'blob',(?!mimeType)/g) || []).length === 0);
  }

  // ── 8. Phase 13 — 본문 정리 · 장면 구분선 · 검수 리포트 · 인코딩 직접 지정 ──
  {
    const read = f => fs.readFileSync(path.join(ROOT, f), 'utf8');
    const clean = G('applyTextCleanup'), hw = G('detectHardWrap'), sym = G('normalizeSymbolsLine'), review = G('buildTocReview');
    const body = (...ls) => ls.join('\n');

    // 8-1. 잡음 줄 제외
    const story = '그는 친구에게 이 식당을 추천했다. 오래된 집이었지만 음식 맛만큼은 누구에게나 자신 있게 권할 수 있었다. 그날도 사람이 많았다.';
    const ch = [['1화', body('작가의 말', '첫 줄', story, '선작과 추천 부탁드립니다!', 'https://example.com/novel/123', '[공지] 다음 주는 휴재합니다', '※ 무단 전재 금지', '중간 줄', '마지막 본문', '', '작가의 말', '감사합니다 여러분', '다음 화도 기대해 주세요')]];
    const r1 = clean(ch, { noise: true, noisePresets: ['author', 'promo', 'url', 'notice'], noiseCustom: '^※' }).chapters[0][1].split('\n');
    check('[정리] 잡음 줄(선작 부탁·URL·공지·사용자 정규식) 제거', !r1.some(l => /선작과|example\.com|\[공지\]|※/.test(l)));
    check('[정리] 뒤쪽 절반 작가의 말부터 끝까지 제거, 앞쪽 머리줄·본문 속 추천 문장은 유지', !r1.includes('감사합니다 여러분') && r1[0] === '작가의 말' && r1.includes(story) && r1.includes('마지막 본문'));
    const off = [['1화', 'a']];
    check('[정리] 옵션이 모두 꺼져 있으면 원본 그대로', clean(off, {}).chapters === off);

    // 8-2. 줄바꿈 병합 — 글자 수 고정(30자) / 단어 경계 줄바꿈 / 일반 원고 미감지
    const words = ['오래된', '골목을', '지나', '낡은', '서점', '앞에서', '그는', '잠시', '멈춰', '섰다가', '조용히', '문을', '밀고', '들어갔고', '먼지', '냄새가', '코끝을', '스쳤다'];
    const paras = Array.from({ length: 40 }, (_, i) => '그날 밤 ' + (i + 1) + '번째 ' + Array.from({ length: 12 + (i % 5) }, (_, k) => words[(i * 7 + k * 3) % words.length]).join(' ') + '.');
    const charWrap = paras.map(p => p.match(/.{1,30}/g).join('\n')).join('\n\n');
    const w1 = hw([charWrap.split('\n')]);
    const m1 = clean([['1화', charWrap]], { hardWrap: true });
    check('[정리] 30자 고정 줄바꿈 감지(글자 단위)', w1 && w1.width === 30 && w1.charWrap === true);
    check('[정리] 글자 단위 줄바꿈 병합 = 원래 문단', m1.chapters[0][1].split('\n').filter(Boolean).join('|') === paras.join('|'));
    const wordWrap = paras.map(p => { const out = []; let cur = ''; for(const w of p.split(' ')){ if((cur + ' ' + w).trim().length > 30){ out.push(cur.trim()); cur = w; } else cur += ' ' + w; } out.push(cur.trim()); return out.join('\n'); }).join('\n\n');
    const m2 = clean([['1화', wordWrap]], { hardWrap: true });
    check('[정리] 단어 경계 줄바꿈 병합 = 원래 문단 (공백 복원)', m2.stats.wrapInfo && m2.stats.wrapInfo.charWrap === false && m2.chapters[0][1].split('\n').filter(Boolean).join('|') === paras.join('|'));
    const mergeHW = G('_mergeHardWrapLines'), famsHW = G('_tocFamilies()');
    const ell = mergeHW(['그는 한참 동안 아무 말도 하지 않고 창밖만 바라보았다.', '.. 그리고 고개를 저었다.', '', '오래 기다린 끝에 마침내 그녀가 입을 열었다 하지만...', '그 말은 끝내 이어지지 않았다.'], { width: 30, charWrap: true }, famsHW)[0];
    check('[정리] 말줄임표가 줄 끝·줄 앞에서 잘려도 한 문단으로', ell[0] === '그는 한참 동안 아무 말도 하지 않고 창밖만 바라보았다... 그리고 고개를 저었다.' && ell[2] === '오래 기다린 끝에 마침내 그녀가 입을 열었다 하지만...그 말은 끝내 이어지지 않았다.');
    const normal = fs.readFileSync(path.join(FIX_DIR, '01_je_n_hwa.txt'), 'utf8');
    check('[정리] 일반 원고는 고정 폭 줄바꿈으로 감지하지 않음', hw([normal.split('\n')]) === null);

    // 8-3. 기호 정리
    check('[정리] 말줄임표 통일 (공백 보존)', sym('그래... 알았어') === '그래… 알았어' && sym('음. . .') === '음…' && sym('......') === '……' && sym('‥') === '…');
    check('[정리] 둥근 따옴표·「」 변환, 영어 아포스트로피 유지', sym('"안녕" 그가 말했다', 'curly') === '“안녕” 그가 말했다' && sym('「네」', 'curly') === '“네”' && sym("don't", 'curly') === "don't");
    check('[정리] 곧은 따옴표 변환', sym('“네” 『책』', 'straight') === '"네" \'책\'');
    check('[정리] 숫자 목록·소수점은 그대로', sym('1. 2. 3.') === '1. 2. 3.' && sym('3.14') === '3.14');

    // 8-4. 장면 구분선 (메인 = EPUB Worker)
    const renderMain = G('renderBodyHtml');
    const wctx2 = { console }; wctx2.self = wctx2; vm.createContext(wctx2);
    vm.runInContext(epubSrc.replace(/^importScripts\(.*\);$/m, ''), wctx2);
    const sceneSrc = body('앞 장면', '* * *', '◇◇◇', '----', '═══', '***강조***', '뒤 장면');
    const hrs = (renderMain(sceneSrc, { sceneBreak: true }).match(/<hr class="scene"\/>/g) || []).length;
    check('[장면] 기호만으로 된 줄 4개 → <hr class="scene"/>, 글자가 섞인 줄은 문단', hrs === 4 && renderMain(sceneSrc, { sceneBreak: true }).includes('<p>***강조***</p>'));
    check('[장면] 옵션 꺼짐 = 기존 렌더링', !renderMain(sceneSrc).includes('<hr'));
    check('[장면] 메인 스레드 = EPUB Worker', renderMain(sceneSrc, { sceneBreak: true }) === wctx2.renderBodyHtml(sceneSrc, { sceneBreak: true }));
    const sceneEpub = await (async () => {
      const chapters = [['1화', body('첫 장면 문장.', '* * *', '둘째 장면 문장.')], ['2화', body('본문', '◇◇◇', '끝')]];
      const params = { title: '장면 구분', author: '테스트', chapters, illMapMeta: [], useItalic: true, showChTitle: true, compressionLevel: 6, lang: 'ko',
        uid: 'urn:uuid:00000000-0000-4000-8000-000000000013', today: '2026-11-03', modified: '2026-11-03T00:00:00Z', sceneBreak: true };
      const w = await runWorker(epubSrc, { params, imageData: { cover: null, ills: [] }, cssText: read('epub-gen.js').includes('hr.scene') ? 'hr.scene{border:0}' : '' },
        wctx => ({ importScripts(){ vm.runInContext(jszipSrc, wctx); } }));
      const buf = Buffer.from(await w.last.blob.arrayBuffer());
      fs.writeFileSync(path.join(OUT_DIR, '13_scene_break.epub'), buf);
      return (await JSZip.loadAsync(buf)).file('OEBPS/Text/chapter_0000.xhtml').async('string');
    })();
    check('[장면] EPUB 본문에 <hr class="scene"/> (tests/out/13_scene_break.epub → CI epubcheck)', sceneEpub.includes('<hr class="scene"/>'));
    check('[장면] EPUB CSS에 hr.scene 스타일', /hr\.scene\{/.test(read('epub-gen.js')) && /'const _RX_SCENE='\+rx\(_RX_SCENE\)/.test(read('epub-gen.js')));

    // 8-5. 검수 리포트
    const it = (num, len, extra = {}) => ({ num, bodyLen: len, enabled: true, kind: 'ch', title: num + '화', ...extra });
    const rv = review([it(1, 3000), it(2, 3000), it(3, 10), it(5, 3000), it(6, 3000), it(6, 2900), it(8, 0), it(9, 60000), it(10, 5, { enabled: false }), it(11, 20)], 50);
    check('[검수] 누락 화수 4·7', JSON.stringify(rv.missing.map(m => [m.from, m.to])) === '[[4,4],[7,7]]');
    check('[검수] 중복 6화', rv.dups.length === 1 && rv.dups[0].num === 6 && rv.dups[0].idxs.join() === '4,5');
    check('[검수] 짧은 챕터(마지막 제외)·빈 챕터·긴 챕터·비활성 제외', rv.short.join() === '2' && rv.empty.join() === '6' && rv.long.join() === '7');
    check('[검수] 분할 연재(같은 번호·다른 part)는 중복 아님', review([it(3, 900, { part: 1 }), it(3, 900, { part: 2 })], 50).dups.length === 0);

    // 8-6. 연결 — 변환·일괄 변환·미리보기가 같은 정리 함수 사용, 설정 저장, 인코딩 직접 지정
    const conv = read('convert.js'), html = read('index.html'), parser = read('parser.js'), st = read('settings.js'), ui = read('ui-state.js');
    check('[연결] 변환·일괄 변환·미리보기 모두 applyTextCleanup', (conv.match(/applyTextCleanup\(/g) || []).length >= 2 && (parser.match(/applyTextCleanup\(chs, cleanOpts\)/g) || []).length === 2);
    const ids = ['optHardWrap', 'optNormalizeSymbols', 'optQuoteStyle', 'optSceneBreak', 'optNoiseFilter', 'optNoise_author', 'optNoise_promo', 'optNoise_url', 'optNoise_notice', 'optNoiseCustom', 'tocReview'];
    check('[연결] 본문 정리·검수 리포트 화면 요소', ids.every(id => html.includes('id="' + id + '"')));
    check('[연결] 본문 정리 옵션 저장·복원', /cleanup:_readCleanupSettings\(\)/.test(st) && /_applyCleanupSettings\(s\.cleanup\)/.test(st));
    check('[연결] data-action/data-input-action 등록', /tocReviewJump:/.test(ui) && /saveCleanupNoise:/.test(ui));
    const D = sandbox('convert.js', ['_countChar', '_decodeFromAB'], { setTimeout, clearTimeout });
    const eucBuf = Buffer.from(Array.from({ length: 400 }, (_, i) => i % 5 === 4 ? [0x20] : [[0xB0,0xA1],[0xB3,0xAA],[0xB4,0xD9]][i % 3]).flat());
    const eucAB = eucBuf.buffer.slice(eucBuf.byteOffset, eucBuf.byteOffset + eucBuf.length);
    const dec = vm.runInContext('_decodeFromAB', D);
    check('[인코딩] 직접 지정(strict)은 UTF-8 자동 보정을 건너뜀', (await dec(eucAB, 'utf-8', true)).includes('\ufffd') && (await dec(eucAB, 'utf-8', false)).startsWith('가나다'));
    check('[인코딩] Worker 디코딩도 strict 전달', /decodeViaWorker\(ab, enc, _encOverride\.has\(key\)\)/.test(conv) && /decodeText\(payload\.buffer, enc2, payload\.strict===true\)/.test(read('worker.js')));
    check('[UI] 파일 목록 hidden 속성 해제 (이전: [hidden]{display:none!important}로 목록이 보이지 않음)', /listWrap\.hidden=false/.test(conv));
    check('[인코딩] 직접 지정이 자동 감지보다 우선', /let enc = _encOverride\.get\(key\) \|\| _encCacheGet\(file\);/.test(conv) && /function setTxtEncoding\(file, enc\)/.test(conv) && /const ov=_encOverride\.get\(_fileKey\(file\)\);\n  if\(ov\) return ov;/.test(conv));
  }

  // ── 9. Phase 14 — EPUB 호환 ──
  {
    const read = readRoot;
    const eg = read('epub-gen.js'), conv = read('convert.js'), html = read('index.html'), st = read('settings.js'), ui = read('ui-state.js');
    app.atob = atob;
    // 9-1. 커스텀 폰트 → OEBPS/Fonts/ 파일 + manifest, CSS는 상대 경로
    const fakeFont = Buffer.from(Array.from({ length: 3000 }, (_, i) => (i * 37 + 11) & 255));
    const face = '@font-face{font-family:"테스트체";src:url("data:font/ttf;base64,' + fakeFont.toString('base64') + '") format("truetype");}\n';
    const font = G('_extractCustomFont')(face);
    check('[폰트] data URI → 바이트·이름·형식 추출', font && font.name === 'custom_font.ttf' && font.mt === 'font/ttf' && font.fmt === 'truetype' && Buffer.from(font.ab).equals(fakeFont));
    check('[폰트] 손상·비지원 데이터는 추출하지 않음', G('_extractCustomFont')(face.replace('font/ttf', 'font/truetype')) === null && G('_extractCustomFont')('') === null);
    const epubCss = G('buildCss')({ fontFace: G('_fontFaceForEpub')(font) });
    check('[폰트] EPUB CSS는 Fonts/ 상대 경로 (data URI 없음)', epubCss.includes('url("Fonts/custom_font.ttf") format("truetype")') && !epubCss.includes('data:font'));
    const buildWith = async (name, params, imageData, fontData) => {
      const base = { title: '호환 테스트', author: '테스트', illMapMeta: [], useItalic: true, showChTitle: true, compressionLevel: 6, lang: 'ko',
        uid: 'urn:uuid:00000000-0000-4000-8000-000000000014', today: '2026-11-03', modified: '2026-11-03T00:00:00Z' };
      const w = await runWorker(epubSrc, { params: { ...base, ...params }, imageData, cssText: fontData ? epubCss : G('buildCss')({ fontFace: '' }), fontData },
        wctx => ({ importScripts(){ vm.runInContext(jszipSrc, wctx); } }));
      if(w.last.type !== 'done') throw new Error('EPUB Worker 실패: ' + w.last.message);
      const buf = Buffer.from(await w.last.blob.arrayBuffer());
      fs.writeFileSync(path.join(OUT_DIR, name), buf);
      const zip = await JSZip.loadAsync(buf);
      return { zip, buf, opf: await zip.file('OEBPS/content.opf').async('string'), nav: await zip.file('OEBPS/nav.xhtml').async('string') };
    };
    const chs = [['서문', '머리말'], ['1화', '본문 하나'], ['2화', '본문 둘']];
    const fe = await buildWith('14_font_file.epub', { chapters: chs }, { cover: { ab: tinyPng(), ext: 'png', mt: 'image/png' }, ills: [] },
      { name: font.name, mt: font.mt, ab: new Uint8Array(font.ab).slice().buffer });   // app 렐름 → 메인 렐름 ArrayBuffer (runWorker 복제용)
    check('[폰트] EPUB에 Fonts/custom_font.ttf + manifest font/ttf (tests/out/14_font_file.epub)',
      !!fe.zip.file('OEBPS/Fonts/custom_font.ttf') && fe.opf.includes('<item id="font_custom" href="Fonts/custom_font.ttf" media-type="font/ttf"/>'));
    // 9-2. landmarks — 표지·본문 시작('서문' 제외), 목차 landmark 없음(nav는 spine 밖)
    check('[landmarks] 표지·본문 시작', /epub:type="landmarks"/.test(fe.nav) && fe.nav.includes('epub:type="cover" href="Text/cover.xhtml"') && fe.nav.includes('epub:type="bodymatter" href="Text/chapter_0001.xhtml"'));
    check('[landmarks] spine 밖 nav.xhtml을 가리키지 않음 (RSC-011)', !/landmarks[\s\S]*href="nav\.xhtml"/.test(fe.nav));
    // 9-3. 접근성 메타
    check('[접근성] accessMode·Feature·Hazard·Summary', ['schema:accessMode">textual', 'schema:accessMode">visual', 'schema:accessModeSufficient">textual', 'structuralNavigation', 'tableOfContents', 'schema:accessibilityHazard">none', 'schema:accessibilitySummary'].every(s => fe.opf.includes(s)));
    const ne = await buildWith('14_no_images.epub', { chapters: chs.slice(1) }, { cover: null, ills: [] }, null);
    check('[접근성] 이미지가 없으면 visual 없음, landmarks에 표지 없음', !ne.opf.includes('accessMode">visual') && !ne.nav.includes('epub:type="cover"') && !ne.opf.includes('font_custom'));
    // 9-4. 리더기 프로필
    const cssFor = profile => {
      const c = makeAppContext();
      c.document.getElementById = id => (id === 'optReaderProfile' ? { value: profile } : null);
      vm.runInContext(eg, c, { filename: 'epub-gen.js' });
      return { css: vm.runInContext('buildCss()', c), prof: vm.runInContext('getReaderProfile()', c) };
    };
    check('[프로필] 기본은 다크 모드 기본색 포함, 리더 앱 프로필은 제외', /prefers-color-scheme/.test(cssFor('default').css) && !/prefers-color-scheme/.test(cssFor('ridi').css) && !/prefers-color-scheme/.test(cssFor('kindle').css));
    check('[프로필] Kindle 표지 2560px·JPG 강제, 알 수 없는 값은 기본', cssFor('kindle').prof.coverMaxH === 2560 && cssFor('kindle').prof.forceJpg === true && cssFor('xyz').prof.key === 'default' && cssFor('xyz').prof.coverMaxH === 1200);
    check('[프로필] 표지 축소·삽화 변환이 프로필을 따름', /const MAX_H=getReaderProfile\(\)\.coverMaxH;/.test(eg) && /getReaderProfile\(\)\.forceJpg/.test(conv));
    check('[프로필] 화면 요소·저장·복원·핸들러', html.includes('id="optReaderProfile"') && /readerProfile:document\.getElementById\('optReaderProfile'\)/.test(st) && /saveReaderProfile:/.test(ui));
    check('[이미지] EPUB 핵심 형식이 아니면 항상 JPG 변환 (BMP·TIFF·AVIF·HEIC)', /const nonCore=!\['png','gif','webp','svg'\]\.includes\(ext\);/.test(conv) && /if\(nonCore\) throw new Error/.test(conv));
    // 9-5. TXT 삽입 편집 (edit.js buildInsertedEpub — startEditEpub에서 분리한 순수 함수) → CI epubcheck
    app.JSZip = JSZip;
    const edSrc = read('edit.js');
    vm.runInContext(['_epubOpfPath', '_touchOpfModified', '_cloneEpubZip', 'findMainNcx', 'findNavXhtml', 'buildInsertedEpub'].map(n => extract(edSrc, n)).join('\n'), app, { filename: 'edit.js:extract' });
    const src = await JSZip.loadAsync(fs.readFileSync(path.join(OUT_DIR, '01_je_n_hwa.epub')));
    const ins = [['삽입 1화', '삽입한 첫 본문.\n* * *\n장면 전환 뒤.'], ['삽입 2화', '삽입한 둘째 본문.']];
    const res = await G('buildInsertedEpub')(src, ins, { selHref: 'OEBPS/Text/chapter_0005.xhtml', insPos: 'after', sceneBreak: true });
    await G('_touchOpfModified')(res.newZip, res.opfPath);
    const edBuf = Buffer.from(await res.newZip.generateAsync({ type: 'nodebuffer', mimeType: 'application/epub+zip', compression: 'DEFLATE' }));
    fs.writeFileSync(path.join(OUT_DIR, '14_edited_insert.epub'), edBuf);
    const ed = await JSZip.loadAsync(edBuf);
    const edOpf = await ed.file('OEBPS/content.opf').async('string'), edNav = await ed.file('OEBPS/nav.xhtml').async('string');
    const spine = [...edOpf.matchAll(/<itemref idref="([^"]+)"/g)].map(m => m[1]);
    const at = spine.indexOf('ch_0005');
    check('[편집] 선택 챕터 뒤에 삽입 (spine 순서)', at >= 0 && spine[at + 1] && /^ins_ch_/.test(spine[at + 1]) && /^ins_ch_/.test(spine[at + 2]) && spine[at + 3] === 'ch_0006');
    check('[편집] nav·ncx에 삽입 챕터 (선택 위치 다음)', /chapter_0005\.xhtml[^]*?삽입 1화[^]*?삽입 2화[^]*?chapter_0006\.xhtml/.test(edNav) && (await ed.file('OEBPS/toc.ncx').async('string')).includes('삽입 2화'));
    const insFile = Object.keys(ed.files).find(f => /Text\/chapter_\d+\.xhtml$/.test(f) && !src.file(f));
    check('[편집] 삽입 본문에 장면 구분선·mimetype 첫 항목 (tests/out/14_edited_insert.epub)', insFile && (await ed.file(insFile).async('string')).includes('<hr class="scene"/>') && edBuf.slice(30, 38).toString() === 'mimetype');
    const res2 = await G('buildInsertedEpub')(src, ins, { selHref: '' });
    const nav2 = await res2.newZip.file('OEBPS/nav.xhtml').async('string');
    check('[편집] 기준 챕터가 없으면 맨 끝에 추가 (이전: 첫 navPoint 기준으로 끼어듦)', nav2.indexOf('삽입 1화') > nav2.lastIndexOf('chapter_0025.xhtml') && nav2.indexOf('삽입 1화') < nav2.indexOf('epub:type="landmarks"'));
  }

  if(UPDATE){
    fs.writeFileSync(GOLDEN, JSON.stringify(golden, null, 2) + '\n', 'utf8');
    console.log(`golden.json 갱신: ${fixtures.length}개 픽스처`);
  }
  console.log(`\n통과 ${passed} / 실패 ${failures.length}`);
  failures.forEach(f => console.log('  ✗ ' + f));
  process.exit(failures.length ? 1 : 0);
}

main().catch(e => { console.error(e); process.exit(1); });
