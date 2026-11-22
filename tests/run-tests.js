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
 *  10. Phase 15: 스트리밍 저장 출력·Worker 재사용·API 키·인라인 핸들러 제거·CSP·innerHTML 정적 검사
 *  11. Phase 16: 앱 설치(manifest·아이콘·파일 열기)·접근성·작업 복원·기기 미리보기·StateManager 구독·유틸리티 클래스
 *  12. Phase 17: StateManager 구독 2단계(변환 진행·결과 → 버튼·다운로드 바)·인라인 style 2단계
 *  13. Phase 18: 표시 전환 = hidden 속성 단일 경로(setShown) — 인라인 display:none 제거
 *  14. Phase 19: index.html 인라인 style 0 — 원자 유틸리티·의미 클래스, 유틸리티 속성 충돌 검사
 *  15. Phase 20: JS 마크업 style 속성 0 → CSP style-src 'unsafe-inline' 제거
 *  16. Phase 21: SW 페이지 이동 ERR_FAILED 수정 — 리디렉트 응답 정리(_plain)·고장 SW 복구·SW 코드 포함 해시
 *  17. Phase 22: 커스텀 폰트 서브셋 — HarfBuzz WebAssembly 실제 실행(TTF·OTF), 제외·실패 경로, EPUB(22_font_subset.epub), 편집 탭 갱신
 *  18. Phase 23: 이미지 형식 바이트 판별(.jpg 이름의 PNG 표지), 커스텀 폰트 선택 복원 경합·미사용 폰트 미포함
 *  19. Phase 28: 설정 초기화 범위·이미지 추출 표지·일괄 패턴 다중 선택·간격 분할 목차 제목 방식
 *  20. Phase 29: 선택 정규식 3단계 파이프라인(후보 추출·오탐 필터·문맥/번호 연속성)·핵심 5종 프리셋·엄격 검증 토글
 *  21. Phase 30 (UI 정제 1단계): 미정의 클래스 0 · 단축키 단일 출처 · 토큰 대비 4.5:1 · 라벨·이름·랜드마크·표지 alt
 *  22. Phase 31 (UI 정제 2단계 — 성능): 스크립트 defer·순서 · 테마 선적용(theme-boot.js) · 목차 확인 화면 선반영 · 감지 Worker 기준 · 첫 화면 비활성 상태
 *  23. Phase 32 (UI 정제 3단계 — 디자인 축소): CSS 리터럴 0 · 무한 애니메이션 1 · 화면 이모지 0 → SVG 아이콘 · JS 인라인 스타일 → 클래스·hidden
 *  24. Phase 33 (UI 정제 4단계 — 정보 구조): 기본 경로만 펼침(분할 규칙·목차 편집·삽화 접기) · 데스크톱 2단 · 레이아웃 이동 방지
 *  25. Phase 34 (신뢰 기능): EPUB 구조 검사(생성 EPUB 통과 · 일부러 망가뜨린 11종 검출) · 실제 XHTML·CSS 미리보기 · 본문 정리 전후 비교
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
    // ★ Phase 15: JSZip 로컬 배포 + 버전 단위 원자적 캐시 (이전 검사: CDN JSZip CORS 프리캐시)
    const { assetHash, currentVersion } = require('./stamp-sw.js');
    check('[배포] SW CACHE_VERSION = 앱 자산 해시 (다르면 npm run stamp)', currentVersion(sw) === assetHash(sw), `sw.js ${currentVersion(sw)} / 계산 ${assetHash(sw)}`);
    // ★ Phase 21: addAll 대신 직접 받아 리디렉트 흔적을 지운 뒤 저장 — 하나라도 실패하면 새 캐시 삭제 후 설치 실패 (원자성 유지)
    check('[배포] SW 설치는 전체 성공 시에만 (Promise.all + cache:reload, 실패 시 새 캐시 삭제)', /await Promise\.all\(CORE_ASSETS\.map\(async u => \{/.test(sw) && /new Request\(u, \{ cache: 'reload' \}\)/.test(sw) &&
      /if \(!resp\.ok\) throw new Error/.test(sw) && /catch \(err\) \{\s*await caches\.delete\(CACHE_NAME\);\s*throw err;/.test(sw) && !/allSettled/.test(sw));
    check('[배포] 로컬 자원은 버전 캐시에서만 응답 (파일별 재검증 없음)', /_cacheFirstLocal/.test(sw) && !/_conditionalSWR|_revalidate/.test(sw));
    const libJs = fs.readFileSync(path.join(ROOT, 'lib/jszip.min.js'));
    const sri = 'sha512-' + require('crypto').createHash('sha512').update(libJs).digest('base64');
    check('[배포] JSZip 로컬 파일 = index.html SRI 해시', html.includes('src="lib/jszip.min.js" integrity="' + sri + '"'));
    const swAssets = (sw.match(/const CORE_ASSETS = \[([\s\S]*?)\];/) || [])[1] || '';
    check('[배포] JSZip CDN 의존 제거 (index.html 스크립트·SW 프리캐시·EPUB Worker)', !/<script src="https?:\/\/[^"]*jszip/.test(html) && !/https?:/.test(swAssets) && /const jszipUrl  = new URL\('lib\/jszip\.min\.js', document\.baseURI\)\.href;/.test(read('epub-gen.js')));
    const defs = ['parser.js', 'convert.js', 'main.js'].map(f => (read(f).match(/defineProperty\(window,\s*'_autoSplitActive'/g) || []).length);
    check('[구조] window._autoSplitActive 정의 1곳', defs.reduce((a, b) => a + b, 0) === 1, defs.join('/'));
  }

  const readRoot = f => fs.readFileSync(path.join(ROOT, f), 'utf8');
  // 스타일 블록 범위: 표식부터 다음 '★ Phase' 블록 주석 전까지 (이후 Phase 규칙이 섞이지 않도록)
  const cssBlock = (css, tag) => { const st = css.indexOf(tag); if(st < 0) return ''; const nx = css.indexOf('/* ★ Phase', st + tag.length); return css.slice(st, nx < 0 ? css.length : nx); };
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
    const C1 = sandbox('convert.js', ['_countChar', '_detectUtf16NoBom', '_detectEncodingFromAB', '_sliceBounds', '_nextEolByte', '_prevEolByte', '_normalizeEOL', '_withCacheBust', '_parseHttpUrl']);
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

    // 7-3b. ★ Phase 25: 줄바꿈 정규화 — CR 단독(구형 Mac)·CRLF·혼합 → LF
    const eol = vm.runInContext('_normalizeEOL', C1);
    check('[줄바꿈] CR 단독 → LF', eol('1화 시작\r\r본문\r2화 다음') === '1화 시작\n\n본문\n2화 다음');
    check('[줄바꿈] CRLF → LF (CR 중복 없음)', eol('1화\r\n\r\n본문\r\n') === '1화\n\n본문\n');
    check('[줄바꿈] 혼합 줄바꿈 통일', eol('a\r\nb\rc\nd') === 'a\nb\nc\nd');
    const lfOnly = '1화\n본문\n';
    check('[줄바꿈] LF 전용은 그대로 (같은 문자열)', eol(lfOnly) === lfOnly);
    check('[줄바꿈] fileToText·readFileSlice 출구에서 정규화',
      /text = _normalizeEOL\(text\);\s*_textCacheSet\(file, text\);/.test(read('convert.js')) &&
      /res\(_normalizeEOL\(text\)\)/.test(read('convert.js')));
    const eucCr = Buffer.from(Array.from(euc).map(b => b === 0x0A ? 0x0D : b));
    const [cs, ce] = bounds(eucCr, 5, 200, 0, 10000, 'euc-kr', 4);
    const eucCrTxt = new TextDecoder('euc-kr').decode(eucCr.subarray(cs, ce));
    check('[슬라이스] CR 단독 EUC-KR도 줄 단위 동기화', cs > 0 && eucCr[cs - 1] === 0x0D && !eucCrTxt.includes('\ufffd'));

    // 7-3c. ★ Phase 26: 이전 작업 복원 확인 끄기 옵션
    const htmlSR = read('index.html'), convSR = read('convert.js'), setSR = read('settings.js'), uiSR = read('ui-state.js');
    check('[작업복원] 설정 토글 존재·기본 켜짐', /id="optSessionRestore" data-input-action="saveSessionRestore" checked/.test(htmlSR));
    check('[작업복원] 저장·복원 (저장값 없으면 켜짐)', /sessionRestore:document\.getElementById\('optSessionRestore'\)\?\.checked!==false/.test(setSR) && /sr\.checked=s\.sessionRestore!==false/.test(setSR));
    check('[작업복원] 끄면 확인 팝업·자동 저장 생략', /if\(!_sessionRestoreEnabled\(\)\)\{ SettingsDB\.remove\(_SESSION_KEY\)/.test(convSR) && /if\(!_sessionRestoreEnabled\(\)\) return;/.test(convSR));
    check('[작업복원] 토글 액션 연결', /saveSessionRestore: \(\) => \{ typeof onSessionRestoreToggle==='function'&&onSessionRestoreToggle\(\); \}/.test(uiSR) && /function onSessionRestoreToggle\(\)/.test(convSR));

    // 7-3d. ★ Phase 27: 변환 화면 폰트 선택 — #cssFont 거울
    const htmlCF = read('index.html'), uiCF = read('ui-state.js'), setCF = read('settings.js');
    check('[변환폰트] 변환 화면 선택 상자 존재', /<select id="convFont" class="opt-select u-flex-1" data-input-action="pickConvFont"><\/select>/.test(htmlCF) && htmlCF.indexOf('id="convFont"') < htmlCF.indexOf('id="page-settings"'));
    check('[변환폰트] 커스텀 폰트 업로드는 설정에만', (htmlCF.match(/id="fontDrop"/g) || []).length === 1 && htmlCF.indexOf('id="fontDrop"') > htmlCF.indexOf('id="page-settings"'));
    check('[변환폰트] 목록 복제·id 제거·값 동기화', /function syncConvFont\(\)/.test(uiCF) && /removeAttribute\?\.\('id'\)/.test(uiCF) && /dst\.value=src\.value;/.test(uiCF));
    check('[변환폰트] 선택 → #cssFont 반영 + 저장', /src\.value=el\.value;[\s\S]{0,200}saveUserPrefs\(\)[\s\S]{0,120}saveCssSettings\(\)/.test(uiCF) && /pickConvFont: \(el\) =>/.test(uiCF));
    check('[변환폰트] 목록 재생성·요약 갱신 때 동기화', /typeof syncConvFont==='function'&&syncConvFont\(\);\n\}/.test(setCF) && /typeof syncConvFont==='function'&&syncConvFont\(\);\n  updateMiniReader/.test(uiCF));

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
    check('[UI] 파일 목록 hidden 속성 해제 (이전: [hidden]{display:none!important}로 목록이 보이지 않음)', /setShown\(listWrap,true\);/.test(conv));   // ★ Phase 18: hidden 속성 해제는 setShown 단일 경로
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

  // ── 10. Phase 15 — 성능·보안 ──
  {
    const read = readRoot;
    const APP_JS = ['parser.js', 'epub-gen.js', 'core.js', 'settings.js', 'cover-search.js', 'convert.js', 'edit.js', 'ui-state.js', 'main.js'];
    const srcs = Object.fromEntries(APP_JS.map(f => [f, read(f)]));
    const html = read('index.html'), eg = srcs['epub-gen.js'], conv = srcs['convert.js'], ui = srcs['ui-state.js'], st = srcs['settings.js'];

    // 10-1. 스트리밍 저장 — Worker가 조각(chunk)만 보내고 Blob을 만들지 않음, 조각을 이으면 정상 EPUB
    const chs = splitChapters(fs.readFileSync(path.join(FIX_DIR, '01_je_n_hwa.txt'), 'utf8'), '');
    const sp = { title: '스트리밍', author: '테스트', chapters: chs, illMapMeta: [], useItalic: true, showChTitle: true, compressionLevel: 6, lang: 'ko',
      uid: 'urn:uuid:00000000-0000-4000-8000-000000000015', today: '2026-11-03', modified: '2026-11-03T00:00:00Z', stream: true };
    const sw15 = await runWorker(epubSrc, { params: sp, imageData: { cover: null, ills: [] }, cssText: 'p{margin:0}' },
      wctx => ({ importScripts(){ vm.runInContext(jszipSrc, wctx); } }));
    const parts = sw15.msgs.filter(m => m.type === 'chunk').map(m => Buffer.from(m.data));
    const streamedBuf = Buffer.concat(parts);
    fs.writeFileSync(path.join(OUT_DIR, '15_streamed.epub'), streamedBuf);
    const sz = await JSZip.loadAsync(streamedBuf);
    check('[스트리밍] 조각 여러 개 + done(streamed, size) · Blob 없음', parts.length > 1 && sw15.last.type === 'done' && sw15.last.streamed === true && !sw15.last.blob && sw15.last.size === streamedBuf.length);
    check('[스트리밍] 이어 붙인 결과가 정상 EPUB (mimetype 첫 항목·챕터 수) → tests/out/15_streamed.epub', streamedBuf.slice(30, 38).toString() === 'mimetype' && Object.keys(sz.files).filter(f => /Text\/chapter_/.test(f)).length === chs.length);
    check('[스트리밍] 메인: 저장 위치 선택은 첫 await 전·실패/중단 시 파일 폐기', /const streamTarget=await _pickStreamTarget\(/.test(conv) && /streamTarget\.writable\?\.abort\?\.\(\)/.test(conv) && /writable\.abort\?\.\(\)/.test(eg) && /stream: !!writable/.test(eg));
    check('[스트리밍] 설정 화면·미지원 브라우저 비활성', html.includes('id="optStreamSave"') && /ss\.disabled=!ok;/.test(st) && /streamSave:document\.getElementById\('optStreamSave'\)/.test(st));

    // 10-2. EPUB Worker 재사용
    check('[Worker] 소스·Blob URL 1회 생성 + 유휴 Worker 재사용', /function _acquireEpubWorker\(jszipUrl\)/.test(eg) && /worker = _acquireEpubWorker\(jszipUrl\);/.test(eg) && !/const workerSrc  = _buildWorkerSrc\(jszipUrl\);/.test(eg));
    check('[Worker] 정상 완료만 재사용, 오류·중단은 종료', /_releaseEpubWorker\(worker, fn===resolve\);/.test(eg) && /if\(!healthy\|\|p\.idle\)\{ worker\.terminate\(\); return; \}/.test(eg));

    // 10-3. API 키
    check('[보안] API 키 입력란 password + 보기 토글', /id="geminiApiKey" type="password"/.test(html) && /id="naverClientSecret" type="password"/.test(html) && (html.match(/data-action="toggleSecret"/g) || []).length === 2 && /toggleSecret:/.test(ui));
    check('[보안] 이 기기에 키 저장 끄면 즉시 삭제', /if\(!remember\)\{ localStorage\.removeItem\('novelepub_api'\); return; \}/.test(st) && html.includes('id="optRememberApiKeys"'));

    // 10-4. 인라인 이벤트 핸들러 0 (HTML 마크업·JS가 만드는 HTML 문자열)
    const inlineRx = /\son(?:click|change|input|error|load|submit|keydown|keyup|focus|blur|mouseover|mouseout|drag\w*|drop)=\\?["']/g;
    const inline = [['index.html', html], ...Object.entries(srcs)].flatMap(([f, t]) => (t.match(inlineRx) || []).map(m => f + ':' + m.trim()));
    check('[CSP] 인라인 on* 핸들러 없음', inline.length === 0, inline.slice(0, 5).join(', '));
    const regKeys = new Set([...ui.matchAll(/^\s{2,6}([A-Za-z_]\w*)\s*:\s*(?:async\s*)?\(/gm)].map(m => m[1]));
    Object.values(srcs).forEach(t => [...t.matchAll(/EventDelegate\.register\(\s*'([^']+)'/g)].forEach(m => regKeys.add(m[1])));
    const used = name => [...new Set([html, ...Object.values(srcs)].map(t => t.replace(/^\s*\/\/.*$/gm, '')).flatMap(t => [...t.matchAll(new RegExp(name + '="([A-Za-z_]\\w*)"', 'g'))].map(m => m[1])))];
    const missAct = used('data-action').filter(a => !regKeys.has(a));
    const missInp = used('data-input-action').filter(a => !regKeys.has(a));
    check('[CSP] data-action·data-input-action 전부 등록', !missAct.length && !missInp.length, [...missAct, ...missInp].join(', '));

    // 10-5. CSP — Cloudflare _headers와 index.html meta가 같은 정책, 'unsafe-inline'·'unsafe-eval' 없는 script-src
    const headers = read('_headers');
    const hdrCsp = (headers.match(/Content-Security-Policy: (.+)/) || [])[1] || '';
    const metaCsp = (html.match(/http-equiv="Content-Security-Policy" content="([^"]+)"/) || [])[1] || '';
    // ★ Phase 22: 'wasm-unsafe-eval'만 추가 허용 (폰트 서브셋 WebAssembly 컴파일) — 'unsafe-inline'·'unsafe-eval'은 계속 금지
    check('[CSP] script-src \'self\' \'wasm-unsafe-eval\' (unsafe-inline·unsafe-eval 없음) + Blob Worker 허용', /script-src 'self' 'wasm-unsafe-eval';/.test(hdrCsp) && !/script-src[^;]*'unsafe-/.test(hdrCsp) && /worker-src 'self' blob:/.test(hdrCsp));
    check('[CSP] meta = 헤더 정책 (frame-ancestors 제외)', metaCsp && metaCsp === hdrCsp.replace(/; frame-ancestors 'none'$/, ''));
    check('[CSP] 인라인 <script> 없음 · eval/new Function 없음', !/<script(?![^>]*\bsrc=)[^>]*>/.test(html) && !Object.values(srcs).some(t => /\beval\(|new Function\(/.test(t)));
    check('[보안] 응답 헤더 nosniff·frame 차단·Referrer-Policy', /X-Content-Type-Options: nosniff/.test(headers) && /frame-ancestors 'none'/.test(headers) && /Referrer-Policy:/.test(headers));

    // 10-6. innerHTML 정적 검사 — 동적 값은 escHtml 등으로 이스케이프하거나, 검토 후 '// safe-html: 이유' 주석
    const SAFE = /^(?:escHtml|escAttr|_escAttr|_esc\w*|Number|parseInt|parseFloat|Math\.\w+|encodeURIComponent)\(|\.toFixed\(|\.toLocaleString\(|\.length$|^[A-Z0-9_]+$|^(?:i|j|k|n|idx|id|ci|fi|pct|total|active|count|len|num|cnt|w|h|W|H|x|y)$/;
    const offenders = [];
    for(const [f, src] of Object.entries(srcs)){
      const rx = /\.innerHTML\s*\+?=\s*|insertAdjacentHTML\(\s*['"][a-z]+['"]\s*,\s*/g; let m;
      while((m = rx.exec(src))){
        const lineStart = src.lastIndexOf('\n', m.index) + 1, lineEnd = src.indexOf('\n', m.index);
        if(/safe-html:/.test(src.slice(lineStart, lineEnd))) continue;
        const start = m.index + m[0].length; let end = src.indexOf(';\n', start); if(end < 0) end = src.length;
        const rhs = src.slice(start, end);
        const dyn = [...[...rhs.matchAll(/\$\{([^}]*)\}/g)].map(t => t[1].trim()), ...[...rhs.matchAll(/['"`]\s*\+\s*([^'"`+]+?)\s*\+\s*['"`]/g)].map(t => t[1].trim())];
        if(/^[A-Za-z_$][\w$.]*\s*$/.test(rhs.trim())) dyn.push(rhs.trim());
        const bad = dyn.filter(d => !SAFE.test(d));
        if(bad.length) offenders.push(f + ':' + src.slice(0, m.index).split('\n').length + ' ' + bad[0]);
      }
    }
    check('[보안] innerHTML 동적 값은 이스케이프 또는 safe-html 검토 주석', offenders.length === 0, offenders.slice(0, 6).join(' / '));
    check('[보안] 미니 리더·설정 요약 칩의 폰트 이름 이스케이프', /폰트 <strong>\$\{escHtml\(fontName\)\}<\/strong>/.test(ui) && /\$\{escHtml\(String\(val\)\)\}/.test(ui));
  }

  // ── 11. Phase 16 — UX · 유지보수 ──
  {
    const read = readRoot;
    const html = read('index.html'), sw = read('sw.js'), ui = read('ui-state.js'), conv = read('convert.js'), parser = read('parser.js'), core = read('core.js'), css = read('style.css');
    // 11-1. 앱 설치 — manifest·아이콘·.txt 파일 열기
    let mf = null; try{ mf = JSON.parse(read('manifest.webmanifest')); }catch(e){}
    const pngSize = f => { const b = fs.readFileSync(path.join(ROOT, f)); return b.slice(1, 4).toString() === 'PNG' ? [b.readUInt32BE(16), b.readUInt32BE(20)] : null; };
    check('[설치] manifest 필수 항목 (name·start_url·display·아이콘 192/512·maskable)', !!mf && mf.name && mf.start_url && mf.display === 'standalone' &&
      mf.icons.every(i => fs.existsSync(path.join(ROOT, i.src))) &&
      mf.icons.some(i => i.sizes === '192x192' && String(pngSize(i.src)) === '192,192') &&
      mf.icons.some(i => i.sizes === '512x512' && i.purpose === 'any' && String(pngSize(i.src)) === '512,512') &&
      mf.icons.some(i => i.purpose === 'maskable'));
    check('[설치] .txt 파일 열기 (file_handlers + launchQueue)', !!mf && mf.file_handlers?.[0]?.accept?.['text/plain']?.includes('.txt') && /window\.launchQueue\.setConsumer\(/.test(ui) && /_setupLaunchQueue\(\);/.test(ui));
    check('[설치] manifest 링크·theme-color·SW 프리캐시', html.includes('<link rel="manifest" href="manifest.webmanifest">') && /name="theme-color"/.test(html) &&
      ['./manifest.webmanifest', './icons/icon-192.png', './icons/icon-512.png', './icons/icon-maskable-512.png', './icons/icon.svg'].every(a => sw.includes(`'${a}'`)));
    // 11-2. 접근성
    const iconOnly = [...html.matchAll(/<button\b([^>]*)>([\s\S]*?)<\/button>/g)].filter(([, a, t]) => !/aria-label=/.test(a) && !/[A-Za-z0-9가-힣]/.test(t.replace(/<[^>]+>/g, '')));
    check('[접근성] 글자 없는 아이콘 버튼은 모두 aria-label', iconOnly.length === 0, iconOnly.map(m => m[0].slice(0, 60)).join(' / '));
    const divActs = [...html.matchAll(/<(?:div|span)\b([^>]*\bdata-action="[^"]*"[^>]*)>/g)].filter(m => !/role="button"/.test(m[1]) || !/tabindex="0"/.test(m[1]));
    check('[접근성] data-action이 달린 div·span은 role="button" + tabindex', divActs.length === 0, divActs.map(m => m[0].slice(0, 60)).join(' / '));
    check('[접근성] 진행률 progressbar·토스트 status·미리보기 dialog', /id="progBar" role="progressbar"/.test(html) && /_container\.setAttribute\('role', 'status'\)/.test(core) && /id="previewModal"[\s\S]{0,80}role="dialog" aria-modal="true"/.test(html));
    check('[접근성] 모달 포커스 이동·Tab 순환·닫으면 복귀 (전역 keydown 핸들러 1개 유지)', /function _trapModalTab\(e\)/.test(ui) && /if\(e\.key==='Tab'&&_trapModalTab\(e\)\) return;/.test(ui) && /prev\.focus\?\.\(\)/.test(ui));
    // 11-3. 작업 복원
    check('[복원] TXT·목차 편집·메타·표지 자동 저장 (SettingsDB, 300MB 상한)', /const _SESSION_KEY='session_v1';/.test(conv) && /files:\[\.\.\.S\.txtFiles\]/.test(conv) && /_SESSION_MAX_BYTES=300\*1024\*1024/.test(conv));
    check('[복원] 목차 편집·파일 목록·표지 변경 시 저장 예약', /scheduleSessionSave\(\{tocEdited:true\}\)/.test(parser) && (conv.match(/scheduleSessionSave\(\);/g) || []).length >= 3);
    check('[복원] 시작 시 복원 제안 (.txt로 실행했으면 생략)·초기화하면 삭제', /async function offerSessionRestore\(\)/.test(conv) && /if\(window\.__launchedWithFiles\|\|S\.txtFiles\.length\) return;/.test(conv) && /SettingsDB\.remove\(_SESSION_KEY\)\.catch/.test(conv) && /setupSessionAutosave\(\)/.test(ui));
    // 11-4. 기기 미리보기
    check('[미리보기] 폰·태블릿·6인치 리더 프레임', /function setReaderDevice\(dev\)/.test(ui) && /setReaderDevice:/.test(ui) && ['phone', 'tablet', 'eink'].every(d => html.includes(`data-device="${d}"`) && css.includes(`.mini-reader.dev-${d}{`)));
    // 11-5. StateManager 구독 — 파일 목록 → 하단 바
    check('[상태] 하단 바는 S.txtFiles 구독으로 갱신 (직접 호출 없음)', /if \(state\.txtFiles !== prev\?\.txtFiles\) updateBtmBar\(state\.txtFiles\);/.test(ui) && !/updateBtmBar\(S\.txtFiles\)|updateBtmBar\(\[\]\)/.test(conv));
    check('[상태] S.txtFiles 제자리 변경(splice·push) 없음 → 항상 새 배열로 교체', ![conv, ui, parser, read('settings.js'), read('edit.js')].some(t => /S\.txtFiles\.(?:splice|push|pop|shift|unshift|sort|reverse)\(/.test(t)));
    // 11-6. 인라인 스타일 → 유틸리티 클래스
    const styleAttrs = (html.match(/\sstyle="/g) || []).length;
    check('[스타일] 반복 인라인 style을 유틸리티 클래스로 (266 → 183 이하, 화면 픽셀 동일 확인)', styleAttrs <= 183 && /\.u-fs-xs\{font-size:var\(--fs-xs\)\}/.test(css), `style 속성 ${styleAttrs}개`);
    check('[스타일] 한 태그에 class 속성 중복 없음', !/<[a-z][^>]*\sclass="[^"]*"[^>]*\sclass="/i.test(html));
  }

  // ── 12. Phase 17 — StateManager 구독 2단계 · 인라인 style 2단계 ──
  {
    const read = readRoot;
    const html = read('index.html'), ui = read('ui-state.js'), conv = read('convert.js'), core = read('core.js'), css = read('style.css');
    const allJs = ['parser.js', 'epub-gen.js', 'core.js', 'settings.js', 'cover-search.js', 'convert.js', 'edit.js', 'ui-state.js', 'main.js', 'worker.js'].map(read).join('\n');
    // 12-1. 변환 진행 상태 — S.converting 단일 소스
    check('[상태] S 초기 상태에 converting:false', /converting:false,/.test(core));
    check('[상태] 모듈 변수 _convertRunning 제거 → S.converting 사용', !/_convertRunning/.test(allJs) && /if\(S\.converting\)\{Toast\.info/.test(conv) && (conv.match(/S\.converting=false;/g) || []).length >= 2);
    check('[상태] 변환 버튼 disabled·aria-busy는 S.converting 구독이 반영', /if \(state\.converting !== prev\?\.converting\)/.test(ui) && /btn\.disabled = !!state\.converting;/.test(ui) && !/convertBtn'\)[^;\n]*\.disabled\s*=/.test(conv));
    // 12-2. 변환 결과 → 다운로드 바
    check('[상태] 다운로드 바 표시·숨김은 S.epubBlob 구독에서만 호출', /if \(state\.epubBlob !== prev\?\.epubBlob\)/.test(ui) &&
      (allJs.match(/_showEpubDownloadBar\(/g) || []).length === 2 && (allJs.match(/_hideEpubDownloadBar\(/g) || []).length === 2 && /function _hideEpubDownloadBar\(\)/.test(conv));
    const iName = conv.indexOf('S.epubName=streamed?'), iBlob = conv.indexOf('S.epubBlob=blob;');
    check('[상태] 파일명(S.epubName)을 먼저 정한 뒤 S.epubBlob 설정', iName > 0 && iBlob > iName && iBlob - iName < 300);
    check('[상태] 결과 초기화는 S.epubBlob=null 한 곳에서 (바 직접 조작 없음)', /function _resetConvertResultUi\(\)\{[\s\S]{0,140}S\.epubBlob=null; S\.epubName='';/.test(conv) &&
      !/btmDownload|btmConvert/.test(extract(conv, '_resetConvertResultUi')));
    // 구독 동작 — 실제 StateManager로 epubBlob·converting 변화 → 콜백 순서 확인
    {
      const calls = [];
      // IIFE 선언이라 extract 대신 'const StateManager = (() => {' ~ '})();' 구간을 잘라 실행
      const smStart = core.indexOf('const StateManager = (() => {'), smEnd = core.indexOf('\n})();', smStart) + 6;
      const SM = vm.createContext({ EventBus: { emit(){} } });
      vm.runInContext(core.slice(smStart, smEnd) + '\nthis.StateManager = StateManager;', SM);
      const store = SM.StateManager.create('p17test', { epubBlob: null, epubName: '', converting: false });
      store.subscribe((s, p) => { if(s.epubBlob !== p?.epubBlob) calls.push(s.epubBlob ? 'show:' + s.epubName : 'hide'); if(s.converting !== p?.converting) calls.push('busy:' + s.converting); });
      store.set({converting: true}); store.set({epubName: 'a.epub'}); store.set({epubBlob: {size: 1}}); store.set({converting: false}); store.set({epubBlob: null, epubName: ''});
      check('[상태] 구독 순서: busy → 다운로드 바(새 이름) → busy 해제 → 숨김', calls.join(',') === 'busy:true,show:a.epub,busy:false,hide', calls.join(','));
    }
    // 12-3. 인라인 style 2단계
    const styleTags = [...html.matchAll(/<[a-zA-Z][a-zA-Z0-9]*\b[^<>]*\sstyle="([^"]*)"[^<>]*>/g)];
    check('[스타일] 인라인 style 2단계 (183 → 120 이하, 화면 픽셀 동일 확인)', styleTags.length <= 120 && /★ Phase 17: 인라인 style 2단계/.test(css), `style 속성 ${styleTags.length}개`);
    const cnt = {}; styleTags.forEach(m => { cnt[m[1]] = (cnt[m[1]] || 0) + 1; });
    const leftover = styleTags.filter(m => !/display:\s*none/.test(m[1]) && /\sid="[A-Za-z][\w-]*"/.test(m[0]) && cnt[m[1]] === 1);
    check('[스타일] id가 있는 요소의 1회성 style은 모두 #id 규칙으로 (display:none 토글 제외)', leftover.length === 0, leftover.map(m => m[0].slice(0, 60)).join(' / '));
    const p17 = cssBlock(css, '★ Phase 17: 인라인 style 2단계');
    const used = new Set([...html.matchAll(/\sclass="([^"]*)"/g)].flatMap(m => m[1].split(/\s+/)));
    const newCls = [...p17.matchAll(/^\.([\w-]+)\{/gm)].map(m => m[1]);
    check('[스타일] Phase 17 새 클래스는 모두 사용 중·정의 1회', newCls.length >= 10 && newCls.every(c => used.has(c)) &&
      newCls.every(c => (css.match(new RegExp('(^|[\\s,}])\\.' + c + '\\{', 'g')) || []).length === 1), newCls.filter(c => !used.has(c)).join(','));
    const p17Ids = [...p17.matchAll(/^#([\w-]+)\{/gm)].map(m => m[1]);
    check('[스타일] Phase 17 #id 규칙의 id는 모두 index.html에 1개씩 존재', p17Ids.length > 0 && p17Ids.every(id => (html.match(new RegExp('\\sid="' + id + '"', 'g')) || []).length === 1));
    check('[스타일] Phase 17 블록에 하드코딩 색상 없음 (CSS 변수만)', !/#[0-9a-fA-F]{3,8}\b(?![\w-]*\{)|rgba?\(|hsla?\(/.test(p17.replace(/^#[\w-]+\{/gm, '{')));
    check('[스타일] 한 태그에 class 속성 중복 없음 (2단계 후)', !/<[a-z][^>]*\sclass="[^"]*"[^>]*\sclass="/i.test(html));
  }

  // ── 13. Phase 18 — 표시 전환 = hidden 속성 (setShown) ──
  {
    const read = readRoot;
    const html = read('index.html'), core = read('core.js'), css = read('style.css');
    const jsFiles = ['parser.js', 'core.js', 'settings.js', 'cover-search.js', 'convert.js', 'edit.js', 'ui-state.js', 'main.js'];
    const allJs = jsFiles.map(read).join('\n');
    // 13-1. 헬퍼 동작 — hidden 토글 + 남은 인라인 display 정리 + 요소 없음 안전
    const H = sandbox('core.js', ['setShown']);
    const mk = disp => { const st = { display: disp, removeProperty(k){ if(k === 'display') this.display = ''; } }; return { hidden: false, style: st }; };
    const e1 = mk('flex'); const r1 = H.setShown(e1, false);
    const e2 = mk(''); e2.hidden = true; const r2 = H.setShown(e2, 1);
    check('[표시] setShown: hidden 토글·인라인 display 제거·반환값·null 안전', r1 === false && e1.hidden === true && e1.style.display === '' &&
      r2 === true && e2.hidden === false && H.setShown(null, true) === false && H.setShown(undefined, false) === false);
    // 13-2. 마크업 — 인라인 display:none 없음, 숨김은 hidden 속성
    const styleTags = [...html.matchAll(/<[a-zA-Z][a-zA-Z0-9]*\b[^<>]*\sstyle="([^"]*)"[^<>]*>/g)];
    check('[표시] index.html 인라인 display:none 0개 (style 속성 120 → 72 이하)', !styleTags.some(m => /display:\s*none/.test(m[1])) && styleTags.length <= 72, `style 속성 ${styleTags.length}개`);
    const hiddenIds = [...html.matchAll(/<[a-zA-Z][^<>]*\sid="([\w-]+)"[^<>]*\shidden[\s>/]/g)].map(m => m[1]);
    check('[표시] 처음에 숨는 요소 48곳 이상이 hidden 속성', hiddenIds.length >= 48, `hidden ${hiddenIds.length}개`);
    // 13-3. JS — hidden 요소를 style.display로 직접 전환하지 않음
    const direct = hiddenIds.filter(id => new RegExp(`getElementById\\(['"]${id}['"]\\)[^;\\n]{0,40}\\.style\\.display`).test(allJs));
    check('[표시] hidden 요소를 getElementById(...).style.display로 전환하는 코드 없음', direct.length === 0, direct.join(','));
    const dynIds = [...allJs.matchAll(/setShown\(document\.getElementById\('([\w-]+)'\)/g)].map(m => m[1]);
    check('[표시] setShown(getElementById(id))의 id는 모두 index.html에 존재', dynIds.length >= 15 && dynIds.every(id => html.includes(`id="${id}"`)), dynIds.filter(id => !html.includes(`id="${id}"`)).join(','));
    check('[표시] 보임 여부 판독도 hidden 기준 (편집 패널·원본 텍스트 탭)', /!document\.getElementById\('editPanel_'\+t\)\?\.hidden/.test(allJs) && /if\(tb1&&!tb1\.hidden\)\{/.test(allJs) && !/style\.display(?:!==|===)'none'/.test(read('edit.js')));
    check('[표시] 탭형 전환(목차 탭·편집 목차 탭·편집 하위 탭·하단 바)도 setShown', /setShown\(document\.getElementById\('tb'\+i\), i===n\)/.test(allJs) && /setShown\(el,i===n\);/.test(read('edit.js')) &&
      /setShown\(panel,active\);/.test(read('edit.js')) && /setShown\(document\.getElementById\('btmBatch'\), name==='batch'\);/.test(read('ui-state.js')));
    // 13-4. CSS — 보일 때의 display 값과 선택자 정리
    const p18 = cssBlock(css, '★ Phase 18:');
    check('[표시] [hidden]{display:none!important} 유지 + Phase 18 #id 규칙(보일 때 flex·block·grid)', /\[hidden\]\{display:none!important\}/.test(css) && css.includes('★ Phase 18:') &&
      ['#btmDownload{display:flex', '#convertResetBar{display:flex', '#cssImportClasses{display:grid', '#splitSec{display:block', '#txtFileList{display:block'].every(r => p18.includes(r)));
    const p18Ids = [...p18.matchAll(/^#([\w-]+)\{/gm)].map(m => m[1]);
    check('[표시] Phase 18 #id 규칙 대상은 모두 1개씩 존재·하드코딩 색상 없음', p18Ids.length >= 35 && p18Ids.every(id => (html.match(new RegExp(`\\sid="${id}"`, 'g')) || []).length === 1) &&
      !/#[0-9a-fA-F]{3,8}\b|rgba?\(|hsla?\(/.test(p18.replace(/^#[\w-]+\{/gm, '{')));
    check('[표시] 인라인 style 값에 의존하던 선택자([style*="none"]) 제거', !/\[style\*=/.test(css));
  }

  // ── 14. Phase 19 — 인라인 style 4단계 (index.html style 속성 0) ──
  {
    const read = readRoot;
    const html = read('index.html'), css = read('style.css');
    const styleAttrs = (html.match(/\sstyle="/g) || []).length;
    check('[스타일] index.html 인라인 style 속성 0개 (266 → 183 → 120 → 72 → 0, 계산된 스타일·화면 픽셀 동일 확인)', styleAttrs === 0, `style 속성 ${styleAttrs}개`);
    const p19 = cssBlock(css, '★ Phase 19:');
    const defs = [...p19.matchAll(/^\.([\w-]+)\{([^}]*)\}/gm)];
    const used = new Set([...html.matchAll(/\sclass="([^"]*)"/g)].flatMap(m => m[1].split(/\s+/)));
    check('[스타일] Phase 19 클래스는 모두 사용 중·정의 1회', css.includes('★ Phase 19:') && defs.length >= 50 && defs.every(m => used.has(m[1])) &&
      defs.every(m => (css.match(new RegExp('(^|[\\s,}])\\.' + m[1] + '\\{', 'g')) || []).length === 1), defs.filter(m => !used.has(m[1])).map(m => m[1]).join(','));
    check('[스타일] Phase 19 블록에 하드코딩 색상 없음 (CSS 변수만)', !/#[0-9a-fA-F]{3,8}\b|rgba?\(|hsla?\(/.test(p19));
    // 한 요소에 붙은 유틸리티들이 같은 속성을 동시에 지정하지 않음 (선언 순서가 아니라 CSS 정의 순서로 이기는 문제 방지)
    const utilDecl = {};
    for (const m of css.matchAll(/(?:^|\n)\.(u-[\w-]+|txt-meta-sm)\{([^}]*)\}/g)) utilDecl[m[1]] = m[2].split(';').filter(Boolean).map(d => d.split(':')[0].trim());
    const clash = [];
    for (const m of html.matchAll(/\sclass="([^"]*)"/g)) {
      const seen = {};
      for (const c of m[1].split(/\s+/)) for (const prop of (utilDecl[c] || [])) { if (seen[prop] && seen[prop] !== c) clash.push(`${seen[prop]}+${c}(${prop})`); seen[prop] = c; }
    }
    check('[스타일] 한 요소의 유틸리티 클래스끼리 같은 속성 충돌 없음', clash.length === 0, [...new Set(clash)].slice(0, 6).join(' / '));
    check('[스타일] 한 태그에 class 속성 중복 없음 (4단계 후)', !/<[a-z][^>]*\sclass="[^"]*"[^>]*\sclass="/i.test(html));
  }

  // ── 15. Phase 20 — JS 마크업 style 속성 0 → CSP style-src 'unsafe-inline' 제거 ──
  {
    const read = readRoot;
    const html = read('index.html'), css = read('style.css'), hdr = read('_headers');
    const pageJs = ['parser.js', 'convert.js', 'edit.js', 'ui-state.js', 'settings.js', 'cover-search.js', 'core.js', 'main.js'];
    const src = Object.fromEntries(pageJs.map(f => [f, read(f)]));
    const allJs = Object.values(src).join('\n');
    // 15-1. 화면에 들어가는 마크업에 style 속성 없음 (EPUB 파일 내용의 <style>은 페이지가 아니라 ZIP에 기록 — 대상 아님)
    const styleAttr = pageJs.flatMap(f => [...src[f].matchAll(/\sstyle=\\?["']/g)].map(m => f + ':' + src[f].slice(0, m.index).split('\n').length));
    check('[CSP] JS가 만드는 마크업에 style 속성 0개 (164 → 0)', styleAttr.length === 0, styleAttr.slice(0, 6).join(' / '));
    check('[CSP] style 속성을 만드는 다른 경로 없음 (setAttribute(\'style\')·페이지용 <style> 요소)', !/setAttribute\(\s*['"]style['"]/.test(allJs) && !/createElement\(\s*['"]style['"]\s*\)/.test(allJs));
    // 15-2. CSP — 헤더와 meta가 같고 style-src에 'unsafe-inline' 없음
    const hdrCsp = (hdr.match(/Content-Security-Policy:\s*([^\n]+)/) || [])[1] || '';
    const metaCsp = (html.match(/http-equiv="Content-Security-Policy" content="([^"]+)"/) || [])[1] || '';
    const styleSrc = c => (c.match(/style-src ([^;]+)/) || [])[1] || '';
    check('[CSP] style-src \'self\' + Google Fonts만 (unsafe-inline 없음, 헤더 = meta)', styleSrc(hdrCsp) === "'self' https://fonts.googleapis.com" && styleSrc(metaCsp) === styleSrc(hdrCsp) && !/'unsafe-/.test(hdrCsp) && !/'unsafe-/.test(metaCsp));
    // 15-3. Phase 20 클래스 — 정의 1회·사용 중·하드코딩 색상 없음
    const p20 = cssBlock(css, '★ Phase 20:');
    const defs = [...p20.matchAll(/^\.([\w-]+)\{/gm)].map(m => m[1]);
    const usedIn = c => allJs.includes(c) || html.includes(c) || (/^chip-/.test(c) && allJs.includes(`, '${c.slice(5)}')`));   // chip(txt,'blue') → chip-blue
    check('[CSP] Phase 20 클래스 정의 1회·모두 사용 중', defs.length >= 80 && defs.every(c => (css.match(new RegExp('(^|\\n)\\.' + c + '\\{', 'g')) || []).length === 1) && defs.every(usedIn),
      defs.filter(c => !usedIn(c)).join(','));
    check('[CSP] Phase 20 블록에 하드코딩 색상 없음 (CSS 변수만)', !/#[0-9a-fA-F]{3,8}\b(?![\w-]*[.{ ])|rgba?\(|hsla?\(/.test(p20.replace(/#[\w-]+(?=[.{ \s])/g, '')));
    // 15-4. 이전 인라인이 이기던 구체적 규칙과의 관계 유지 (검색창·단축키·삽화 행 입력)
    check('[CSP] 더 구체적인 기존 규칙 위로 이전 인라인 값 유지', ['#toc-search.u-p-5-8{', '#shortcutHelp kbd.kbd-key{', '.mill-row .inp-sm,.mill-row-top .inp-sm{'].every(r => p20.includes(r)));
    // 15-5. JS 템플릿의 정적 class 조합에서도 유틸리티끼리 같은 속성 충돌 없음
    const utilDecl = {};
    for (const m of css.matchAll(/(?:^|\n)\.(u-[\w-]+|txt-meta-sm)\{([^}]*)\}/g)) utilDecl[m[1]] = m[2].split(';').filter(Boolean).map(d => d.split(':')[0].trim());
    const clash = [];
    for (const m of allJs.matchAll(/\sclass=\\?"([^"$']*)/g)) { const seen = {};
      for (const c of m[1].split(/\s+/)) for (const prop of (utilDecl[c] || [])) { if (seen[prop] && seen[prop] !== c) clash.push(`${seen[prop]}+${c}(${prop})`); seen[prop] = c; } }
    check('[CSP] JS 템플릿 class 조합의 유틸리티 속성 충돌 없음', clash.length === 0, [...new Set(clash)].slice(0, 6).join(' / '));
    // 15-6. 템플릿에서 숨김으로 만들던 요소는 hidden + setShown
    check('[CSP] 템플릿의 처음 숨김 요소는 hidden 속성 + setShown 전환', /id="toc-auto-sel-susp"[^>]*\shidden>/.test(src['parser.js']) && /setShown\(autoSelBtn, suspCount>0&&!_tocFilterQ\);/.test(src['parser.js']) &&
      /id="bmode_'\+i\+'" class="badge-blue-line" hidden>/.test(src['convert.js']) && /\$\{active\?'':' hidden'\}>/.test(src['convert.js']) && /setShown\(document\.getElementById\('eik_'\+id\), m==='keyword'\|\|m==='title'\);/.test(src['edit.js']));
  }

  // ── 16. Phase 21 — SW 페이지 이동 ERR_FAILED (Cloudflare /index.html → / 리디렉트) ──
  {
    const read = readRoot;
    const sw = read('sw.js');
    // 16-1. 리디렉트를 거친 응답을 새 응답으로 바꾸는 _plain — 실제 동작 (Node 18+ 내장 Response)
    const P = sandbox('sw.js', ['_plain'], { Response, Blob });
    const plainOk = await (async () => {
      const body = '<!doctype html><title>x</title>';
      const red = new Response(body, { status: 200, headers: { 'Content-Type': 'text/html;charset=utf-8', 'X-T': '1' } });
      Object.defineProperty(red, 'redirected', { value: true });
      const out = await P._plain(red);
      const same = new Response('a'); const out2 = await P._plain(same);
      return out !== red && out.redirected === false && out.status === 200 && out.headers.get('X-T') === '1' && (await out.text()) === body && out2 === same && (await P._plain(null)) === null;
    })();
    check('[SW] _plain: 리디렉트 응답 → 본문·상태·헤더 같은 새 응답, 일반 응답·null은 그대로', plainOk);
    check('[SW] 프리캐시 저장 전·페이지 이동 응답 전·로컬 자원 저장 전 모두 _plain', /await cache\.put\(u, await _plain\(resp\)\);/.test(sw) && /if \(cached\) return _plain\(cached\);/.test(sw) && /_plain\(resp\.clone\(\)\)\.then\(r => cache\.put\(request, r\)\)/.test(sw) && !/cache\.addAll\(/.test(sw));
    check('[SW] 열린 화면이 없을 때만 대기 없이 활성화 (고장 난 이전 SW에서 복구, 화면이 있으면 업데이트 배너)', /const wins = await self\.clients\.matchAll\(\{ type: 'window', includeUncontrolled: true \}\);\s*if \(!wins\.length\) await self\.skipWaiting\(\);/.test(sw) && /e\.data\.type === 'SKIP_WAITING'\) self\.skipWaiting\(\)/.test(sw));
    // 16-2. CACHE_VERSION 해시에 sw.js 자체 코드 포함 — SW 로직만 바뀌어도 새 캐시 이름 (같은 이름 캐시를 실패 시 지우는 사고 방지)
    const { assetHash } = require('./stamp-sw.js');
    const swAlt = sw.replace("async function _plain(resp){", "async function _plain(resp){ /* 변경 */");
    check('[SW] CACHE_VERSION 해시에 sw.js 코드 포함 (CACHE_VERSION 줄 자체는 제외)', assetHash(sw) !== assetHash(swAlt) && assetHash(sw) === assetHash(sw.replace(/const CACHE_VERSION = '[^']+';/, "const CACHE_VERSION = 'x';")));
  }

  // ── 17. Phase 22 — 커스텀 폰트 서브셋 (HarfBuzz WebAssembly) ──
  {
    const read = readRoot;
    const eg = read('epub-gen.js'), conv = read('convert.js'), ed = read('edit.js'), st = read('settings.js'), html = read('index.html'), hdr = read('_headers');
    const wasmBuf = fs.readFileSync(path.join(ROOT, 'lib', 'harfbuzz-subset.wasm'));
    const FONT_DIR = path.join(FIX_DIR, 'fonts');
    const ttf = fs.readFileSync(path.join(FONT_DIR, 'fixture-kr.ttf')), otf = fs.readFileSync(path.join(FONT_DIR, 'fixture-kr.otf'));
    // 17-1. 엔진 파일 무결성 — epub-gen.js의 SRI = 실제 파일 sha384
    const sri = 'sha384-' + require('crypto').createHash('sha384').update(wasmBuf).digest('base64');
    check('[서브셋] lib/harfbuzz-subset.wasm 무결성 해시(SRI) = 코드의 HB_SUBSET_SRI', G('HB_SUBSET_SRI') === sri && fs.existsSync(path.join(ROOT, 'lib', 'harfbuzz-LICENSE.txt')), G('HB_SUBSET_SRI') + ' / ' + sri);
    // fetch 흉내 (요청 옵션 기록) — 브라우저에선 integrity로 변조 차단
    const fetchLog = [];
    let fetchMode = 'ok';
    app.fetch = async (url, init) => { fetchLog.push({ url: String(url), integrity: init && init.integrity });
      return fetchMode === 'ok' ? { ok: true, status: 200, arrayBuffer: async () => wasmBuf.buffer.slice(wasmBuf.byteOffset, wasmBuf.byteOffset + wasmBuf.byteLength) } : { ok: false, status: 404 }; };
    const ab = b => b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength);
    const fontOf = (buf, ext) => ({ family: '시험체', fmt: ext === 'ttf' ? 'truetype' : 'opentype', mt: 'font/' + ext, name: 'custom_font.' + ext, ab: ab(buf) });
    // 17-2. 형식·fsType 판별, cmap 읽기
    const info = G('_fontFileInfo');
    check('[서브셋] 형식 판별 (TTF·OTF·WOFF·WOFF2·TTC) + fsType 읽기', info(new Uint8Array(ttf)).kind === 'ttf' && info(new Uint8Array(otf)).kind === 'otf' &&
      info(new Uint8Array(Buffer.from('wOFF00000000'))).kind === 'woff' && info(new Uint8Array(Buffer.from('wOF200000000'))).kind === 'woff2' && info(new Uint8Array(Buffer.from('ttcf00000000'))).kind === 'ttc' &&
      info(new Uint8Array(ttf)).fsType === 0);
    const cmapOf = b => G('_fontCmapCodepoints')(new Uint8Array(b));
    const fullCmap = cmapOf(ttf);
    check('[서브셋] cmap(format 4·12) 읽기 — 픽스처 폰트 글자 수', fullCmap.size >= 700 && fullCmap.has(0xAC00 + 0) === fullCmap.has(0xAC00) && fullCmap.has(0x41) && cmapOf(otf).size === fullCmap.size, `cmap ${fullCmap.size}자`);
    // 17-3. 코드포인트 수집 — 서로게이트 쌍·제어 문자·ASCII 기본 포함
    const cps = G('_collectFontCodepoints')(['가나\n\t다', '😀', '\u0007']);
    check('[서브셋] 글자 수집: 서로게이트 결합·제어 문자 제외·ASCII 출력 문자 기본 포함', cps.has(0xAC00) && cps.has(0xB098) && cps.has(0xB2E4) && cps.has(0x1F600) && !cps.has(0xD83D) && !cps.has(0x0A) && !cps.has(0x07) && cps.has(0x41) && cps.has(0x7E));
    check('[서브셋] EPUB 템플릿 고정 문구(목차 등)도 글자 집합에 포함', /목차/.test(G('_epubTemplateText()')) && !/[\x00-\x7f]/.test(G('_epubTemplateText()')));
    // 17-4. 실제 서브셋 — TTF·OTF 모두, 쓰인 글자 전부 남고 용량 감소
    const bookText = fs.readFileSync(path.join(FIX_DIR, '01_je_n_hwa.txt'), 'utf8');
    const want = [...G('_collectFontCodepoints')([bookText])].filter(c => fullCmap.has(c));
    for (const [buf, ext] of [[ttf, 'ttf'], [otf, 'otf']]) {
      const sub = await G('_subsetCustomFont')(fontOf(buf, ext), [bookText]);
      const rep = G('takeFontSubsetReport()');
      const got = sub && sub.subset ? cmapOf(Buffer.from(sub.ab)) : new Set();
      check(`[서브셋] ${ext.toUpperCase()} 실제 서브셋: 쓰인 글자 모두 유지·용량 감소·리포트`, !!(sub && sub.subset) && want.every(c => got.has(c)) && got.size < fullCmap.size &&
        rep && rep.to < rep.from && rep.to === sub.ab.byteLength && G('_fontFileInfo')(new Uint8Array(sub.ab)).kind === ext,
        rep ? `${rep.from} → ${rep.to} bytes · 글자 ${got.size}/${fullCmap.size}` : '리포트 없음');
    }
    check('[서브셋] 엔진은 무결성 해시와 함께 한 번만 받아옴 (모듈 재사용)', fetchLog.length === 1 && fetchLog[0].integrity === sri && /lib\/harfbuzz-subset\.wasm$/.test(fetchLog[0].url));
    // 17-5. 제외·실패 경로 — 원본 그대로, 변환은 계속
    const os2 = buf => { const b = Buffer.from(buf); const n = b.readUInt16BE(4); for (let i = 0; i < n; i++) { const r = 12 + i * 16; if (b.toString('latin1', r, r + 4) === 'OS/2') { b.writeUInt16BE(0x0100, b.readUInt32BE(r + 8) + 8); return b; } } return b; };
    const noSub = fontOf(os2(ttf), 'ttf');
    const r1 = await G('_subsetCustomFont')(noSub, [bookText]); const rep1 = G('takeFontSubsetReport()');
    const woff2 = fontOf(Buffer.concat([Buffer.from('wOF2'), Buffer.alloc(60)]), 'woff2');
    const r2 = await G('_subsetCustomFont')(woff2, [bookText]); const rep2 = G('takeFontSubsetReport()');
    vm.runInContext('_hbModulePromise=null', app); fetchMode = 'fail';
    const r3 = await G('_subsetCustomFont')(fontOf(ttf, 'ttf'), [bookText]); const rep3 = G('takeFontSubsetReport()');
    fetchMode = 'ok';
    const r4 = await G('_subsetCustomFont')(fontOf(ttf, 'ttf'), [bookText]); G('takeFontSubsetReport()');
    check('[서브셋] 서브셋 금지(fsType 0x0100)·WOFF2·엔진 실패는 원본 그대로 + 이유 리포트, 실패 뒤 다시 시도', r1 === noSub && rep1.skipped === 'license' && r2 === woff2 && rep2.skipped === 'format' &&
      !r3.subset && rep3.skipped === 'error' && r4.subset === true);
    const desc = G('describeFontSubsetReport');
    check('[서브셋] 리포트 문구 — 결과는 정보(폰트:), 라이선스 제한은 경고', /^폰트: 책에 쓰인 글자 2,100자만 남겨 3\.8MB → 293KB로 줄였어요/.test(desc({ from: 4e6, to: 3e5, chars: 2100 })[0]) && /^폰트: WOFF2 형식은/.test(desc(rep2)[0]) &&
      desc({ from: 1, to: 1, restricted: true, skipped: 'nochange' }).some(t => /^폰트 라이선스/.test(t)) && /\^\(\?:본문 정리\|폰트\):/.test(conv) &&
      /^폰트: 브라우저 보안 정책\(CSP\)이 WebAssembly 실행을 막았어요 — 원본 그대로/.test(desc({ from: 2e5, skipped: 'error', error: "WebAssembly.compile(): ... 'unsafe-eval' is not an allowed source ..." })[0]) &&
      /^폰트: 서브셋 엔진 파일을 받지 못했어요/.test(desc(rep3)[0]));
    // 17-6. EPUB 생성 — 서브셋 폰트 + 표식 CSS → tests/out/22_font_subset.epub (CI epubcheck)
    const chs = [['1화 시작', bookText.slice(0, 1500)], ['2화 이어서', bookText.slice(1500, 3000)]];
    // launchEpubWorker와 같은 글자 집합: 제목·작가·시리즈·CSS·템플릿 고정 문구·챕터
    const sub = await G('_subsetCustomFont')(fontOf(ttf, 'ttf'), ['서브셋 시험', '테스트', '', G('buildCss')({ fontFace: '' }), G('_epubTemplateText()'), ...chs.flat()]); G('takeFontSubsetReport()');
    const css = G('buildCss')({ fontFace: G('_fontFaceForEpub')(sub) });
    const base = { title: '서브셋 시험', author: '테스트', illMapMeta: [], useItalic: true, showChTitle: true, compressionLevel: 6, lang: 'ko',
      uid: 'urn:uuid:00000000-0000-4000-8000-000000000022', today: '2026-11-05', modified: '2026-11-05T00:00:00Z', chapters: chs };
    const w = await runWorker(epubSrc, { params: base, imageData: { cover: null, ills: [] }, cssText: css, fontData: { name: sub.name, mt: sub.mt, ab: new Uint8Array(sub.ab).slice().buffer } },
      wctx => ({ importScripts(){ vm.runInContext(jszipSrc, wctx); } }));
    const epubBuf = Buffer.from(await w.last.blob.arrayBuffer());
    fs.writeFileSync(path.join(OUT_DIR, '22_font_subset.epub'), epubBuf);
    // 편집 탭 함수는 앱 렐름에서 ArrayBuffer를 넘기므로 같은 렐름의 JSZip으로 연다 (브라우저는 한 렐름)
    //   (앞 섹션이 app.JSZip에 메인 렐름 JSZip을 넣어 두었을 수 있음 → 앱 렐름 JSZip을 따로 만들고 원래 값 복원)
    const prevZip = app.JSZip; delete app.JSZip;
    vm.runInContext(jszipSrc, app);
    const AppJSZip = app.JSZip; app.JSZip = prevZip;
    const AppU8 = G('Uint8Array');
    const appZip = buf => AppJSZip.loadAsync(new AppU8(buf));
    const ez = await appZip(epubBuf);
    const fontIn = Buffer.from(await ez.file('OEBPS/Fonts/custom_font.ttf').async('uint8array'));
    const docText = (await Promise.all(Object.keys(ez.files).filter(p => /\.(xhtml|ncx)$/.test(p)).map(p => ez.file(p).async('string')))).join('');
    const usedInDocs = [...G('_collectFontCodepoints')([docText.replace(/<[^>]+>/g, '')])].filter(c => fullCmap.has(c));
    const inFont = cmapOf(fontIn);
    check('[서브셋] EPUB 폰트 = 서브셋 결과, 문서에 보이는 글자 모두 폰트에 있음 (tests/out/22_font_subset.epub)', fontIn.length === sub.ab.byteLength && fontIn.length < ttf.length &&
      usedInDocs.every(c => inFont.has(c)) && (await ez.file('OEBPS/Styles/style.css')?.async('string') || css).includes('/* novelepub:font-subset */@font-face{font-family:"시험체"'),
      `폰트 ${ttf.length} → ${fontIn.length} bytes, 문서 글자 ${usedInDocs.length}`);
    // 17-7. 편집 탭 — 새 글자가 생기면 원본으로 다시 서브셋 / 원본이 없으면 누락 글자 수
    const newChar = [...fullCmap].find(c => c > 0xAC00 && !inFont.has(c));
    const chapPath = Object.keys(ez.files).find(p => /Text\/chapter_0001\.xhtml$/.test(p));
    ez.file(chapPath, (await ez.file(chapPath).async('string')).replace('</body>', '<p>' + String.fromCodePoint(newChar) + '</p></body>'));
    app.customFontFace = '@font-face{font-family:"시험체";src:url("data:font/ttf;base64,' + ttf.toString('base64') + '") format("truetype");}\n';
    const fr1 = await G('refreshEpubFontSubset')(ez);
    const afterFont = Buffer.from(await ez.file('OEBPS/Fonts/custom_font.ttf').async('uint8array'));
    const zipB = await appZip(epubBuf);
    zipB.file(chapPath, (await zipB.file(chapPath).async('string')).replace('</body>', '<p>' + String.fromCodePoint(newChar) + '</p></body>'));
    app.customFontFace = '';
    const fr2 = await G('refreshEpubFontSubset')(zipB, await appZip(epubBuf));   // 편집 전 EPUB 기준 — 원래부터 없던 글자는 세지 않음
    const fr3 = await G('refreshEpubFontSubset')(await appZip(fs.readFileSync(path.join(OUT_DIR, '14_font_file.epub'))));
    check('[서브셋] 편집 탭: 원본 폰트가 있으면 다시 서브셋(새 글자 포함), 없으면 누락 글자 수, 표식 없는 폰트는 건드리지 않음',
      fr1 && fr1.resubset === true && cmapOf(afterFont).has(newChar) && fr2 && fr2.resubset === false && fr2.missing === 1 && fr3 === null,
      JSON.stringify({ fr1, fr2, fr3, newChar: newChar && newChar.toString(16), has: cmapOf(afterFont).has(newChar) }));
    // 17-8. 연결 — 변환 경로·설정·CSP
    check('[서브셋] launchEpubWorker가 폰트를 Worker에 보내기 전에 서브셋 (설정 끄면 생략)', /fontData = await _subsetCustomFont\(fontData, fontTexts\(\)\);/.test(eg) && /document\.getElementById\?\.\('optFontSubset'\)\?\.checked!==false/.test(eg) &&
      eg.indexOf('_subsetCustomFont(fontData, fontTexts())') < eg.indexOf("const cssText   = buildCss({fontFace:_fontFaceForEpub(fontData)});"));
    check('[서브셋] 설정 토글(기본 켜짐)·저장·복원, 편집 두 경로에서 갱신', /id="optFontSubset" data-input-action="saveExtraSettings" checked>/.test(html) && /fontSubset:document\.getElementById\('optFontSubset'\)\?\.checked!==false/.test(st) &&
      /fsub\.checked=s\.fontSubset!==false;/.test(st) && (ed.match(/await refreshEpubFontSubset\(newZip, E\.epubZip\)\.catch\(\(\)=>null\)/g) || []).length === 2);
    const hdrPolicy = (hdr.match(/Content-Security-Policy:\s*([^\n]+)/) || [])[1] || '', metaPolicy = (html.match(/http-equiv="Content-Security-Policy" content="([^"]+)"/) || [])[1] || '';
    check('[서브셋] CSP는 \'wasm-unsafe-eval\'만 추가 (헤더 = meta)', /script-src 'self' 'wasm-unsafe-eval';/.test(hdrPolicy) && /script-src 'self' 'wasm-unsafe-eval';/.test(metaPolicy) && !/'unsafe-(?:eval|inline)'/.test(hdrPolicy + metaPolicy));
  }

  // ── 18. Phase 23 — 실제 변환 결과에서 발견한 문제 (표지 형식·커스텀 폰트 미적용) ──
  {
    const read = readRoot;
    const conv = read('convert.js'), ui = read('ui-state.js'), eg = read('epub-gen.js');
    // 18-1. 이미지 형식은 바이트 시그니처로 — 'cover.jpg'(image/jpeg)로 저장된 PNG 표지
    const SN = sandbox('convert.js', ['_sniffImageExt'], { Blob });
    const blobOf = bytes => new Blob([Uint8Array.from(bytes)]);
    const webp = [0x52,0x49,0x46,0x46,1,2,3,4,0x57,0x45,0x42,0x50,0x56,0x50,0x38,0x20];
    const kinds = await Promise.all([
      SN._sniffImageExt(blobOf([0x89,0x50,0x4E,0x47,0x0D,0x0A,0x1A,0x0A, ...Array(8).fill(0)])),
      SN._sniffImageExt(blobOf([0xFF,0xD8,0xFF,0xE0, ...Array(12).fill(0)])),
      SN._sniffImageExt(blobOf(webp)),
      SN._sniffImageExt(blobOf([0x47,0x49,0x46,0x38,0x39,0x61, ...Array(10).fill(0)])),
      SN._sniffImageExt(blobOf([0,0,0,0x1C,0x66,0x74,0x79,0x70,0x61,0x76,0x69,0x66, 0,0,0,0])),
      SN._sniffImageExt(blobOf([0x3C,0x73,0x76,0x67, ...Array(12).fill(0x20)])),
    ]);
    check('[표지] 이미지 형식 바이트 판별 (PNG·JPEG·WebP·GIF·AVIF, 모르면 null)', kinds.join(',') === 'png,jpg,webp,gif,avif,', kinds.join(','));
    check('[표지] convertImageFile은 실제 형식 우선 → 이름이 .jpg인 PNG 표지도 JPG로 변환', /const ext=\(\(await _sniffImageExt\(file\)\)\|\|\(_name\.includes\('\.'\)/.test(conv) &&
      conv.indexOf('await _sniffImageExt(file)') < conv.indexOf("if(supportedAsIs.includes(ext)) return {blob:file, ext:'jpg', mt:'image/jpeg'};"));
    // 18-2. 커스텀 폰트 — 저장된 선택 복원 경합, 쓰는 규칙이 없으면 넣지 않음
    const stg = read('settings.js');
    check('[폰트] 글꼴 목록을 다시 만들어도 커스텀 폰트 옵션·현재/저장 선택 유지 (이전: #customFontOpt 삭제 + 새로고침마다 첫 항목)',
      /opt\.id='customFontOpt';/.test(stg) && /const want=\[prev, sel\.id==='cssFont'\?savedFont:''\]\.find/.test(stg) && /if\(want\) sel\.value=want;/.test(stg));
    check('[폰트] 페이지 로드 시 커스텀 폰트 옵션 값이 정해진 뒤 저장된 선택 복원', /if\(sel&&saved\.font===opt\.value&&sel\.value!==opt\.value\)\{ sel\.value=opt\.value;/.test(ui));
    check('[폰트] 커스텀 폰트를 쓰는 CSS 규칙이 없으면 EPUB에 넣지 않음 + 경고', /if\(fontData&&!cssProbe\.includes\(fontData\.family\)\)\{\s*_lastFontSubsetReport=\{skipped:'unused'/.test(eg) &&
      eg.indexOf("skipped:'unused'") < eg.indexOf('fontData = await _subsetCustomFont(fontData, fontTexts());'));
    const msg = G('describeFontSubsetReport')({ skipped: 'unused', family: '교보손글씨', from: 12.5 * 1024 * 1024, to: 0 });
    check('[폰트] 미사용 안내는 경고(⚠)로 표시 — \'폰트:\'로 시작하지 않음, 고를 메뉴 안내', msg.length === 1 && /^커스텀 폰트 "교보손글씨"를 쓰는 글꼴 설정이 없어 EPUB에 넣지 않았어요 \(12\.5MB\) — 변환 탭 '변환 옵션 · 스타일'의 폰트/.test(msg[0]) && !/^폰트:/.test(msg[0]));
  }

  // ── 19. Phase 28 — 설정 초기화·이미지 추출 표지·일괄 패턴 다중 선택·간격 분할 목차 제목 ──
  {
    const read = f => fs.readFileSync(path.join(ROOT, f), 'utf8');
    const st = read('settings.js'), ed = read('edit.js'), conv = read('convert.js'), ui = read('ui-state.js'), parser = read('parser.js'), css = read('style.css');
    // 19-1. 설정 초기화 — novelepub_prefs(시작 시 복원 원본)·스킨·커스텀 폰트까지
    const keys = (st.match(/const SETTINGS_RESET_KEYS=\[([\s\S]*?)\];/) || [])[1] || '';
    check('[설정초기화] 시작 시 복원 원본(novelepub_prefs)·스킨·리더 기기까지 삭제',
      ['epub_css', 'epub_extra', 'novelepub_prefs', 'novelepub_skin', 'novelepub_reader_device'].every(k => keys.includes("'" + k + "'")));
    check('[설정초기화] 기록·프리셋·API 키는 유지', !/epub_history|novelepub_css_presets|novelepub_api/.test(keys));
    check('[설정초기화] 커스텀 폰트(IndexedDB) 삭제 후 새로고침',
      /SettingsDB\.remove\('customFontFace'\), SettingsDB\.remove\('customFontName'\)[\s\S]{0,40}\n  location\.reload\(\);/.test(st));
    // 19-2. 이미지 추출 — 표지 포함, manifest 속성 순서 무관
    check('[이미지추출] 표지(cover-image / meta cover)도 추출', /properties\\s\*=\\s\*\["'\]\[\^"'\]\*\\bcover-image/.test(ed) && /chapterImages\.unshift\(\{chTitle:'표지'/.test(ed));
    check('[이미지추출] manifest 속성 순서와 무관하게 파싱', /for\(const m of opfText\.matchAll\(\/<item\\b\[\^>\]\*>\/gi\)\)/.test(ed));
    // 19-3. 일괄 변환 패턴 여러 개 — 결합 정규식이 유효하고 각 패턴을 모두 잡음
    const presets = ['^#?(?:제\\s*)?\\d+\\s*화(?:\\s*.+)?$', '^(?:chapter|part|ch)\\.?\\s*\\d+(?:\\s*.+)?$', '^\\d+$', '^\\[\\s*.+\\.txt\\s*\\]\\s*$'];
    const cU = sandbox('ui-state.js', ['buildCombinedPat']);
    vm.runInContext(extract(conv, '_combineBatchPresets'), cU);
    const cF = sandbox('convert.js', ['_combineBatchPresets']);   // buildCombinedPat 없는 경우의 대체 경로
    for(const [label, ctx] of [['buildCombinedPat', cU], ['대체 경로', cF]]){
      const comb = vm.runInContext('_combineBatchPresets', ctx)(presets);
      let rx = null; try{ rx = new RegExp(comb, 'i'); }catch(e){}
      const hits = ['제3화 시작', 'Chapter 12 The Start', '15', '[ 0001_제목.txt ]'].every(l => rx && rx.test(l));
      const miss = ['그는 15층에 살았다.', '오늘은 3월 15일이다.', 'chapter와 상관없는 문장'].every(l => rx && !rx.test(l));
      check('[일괄패턴] 4개 결합 정규식 유효·모두 감지·본문 오탐 없음 (' + label + ')', rx && hits && miss, comb);
    }
    check('[일괄패턴] 1개면 그대로, 0개면 빈 값', vm.runInContext('_combineBatchPresets', cU)([presets[2]]) === presets[2] && vm.runInContext('_combineBatchPresets', cU)([]) === '');
    check('[일괄패턴] 체크박스·직접 입력 구분 (이전: 자동으로 채운 직접 입력값이 두 번째 선택부터 우선)',
      /applyBatchPreset\(parseInt\(el\.dataset\.idx,10\), el\)/.test(ui) && /if\(srcEl&&srcEl===directEl\)\{/.test(conv) && !/\} else if\(direct&&checks\.length\)\{/.test(conv));
    check('[일괄패턴] 바깥 괄호를 떼는 깨진 결합 제거', !/\.replace\(\/\^\\\(\\\?:\/,''\)\.replace\(\/\\\)\$\/,''\)/.test(conv));
    // 19-4. 간격 분할 — 두 제목 후보·분할 줄 보관, 제목 방식 선택
    const cis = G('computeIntervalSplit');
    const L = []; for(let i = 0; i < 600; i++){ L.push(i % 50 === 0 ? '' : `문장 ${i}입니다.`); }
    const num = cis(L, 6, { titleMode: 'number', titleTemplate: '제{N}화' }), near = cis(L, 6, { titleMode: 'nearby' });
    check('[간격목차] N화 모드도 본문 줄 제목(lineTitle)·분할 줄(splitText) 보관',
      num.length === 6 && num.every(t => t.lineTitle && typeof t.splitText === 'string') && num[2].title === '제3화');
    check('[간격목차] 본문 줄 모드 제목 = lineTitle, 경계는 모드와 무관',
      near.every((t, k) => t.title === t.lineTitle && t.line === num[k].line));
    check('[간격목차] splitText = 그 화가 시작하는 첫 비어 있지 않은 줄',
      num.every(t => t.splitText === (L.slice(t.line - 1).find(l => l.trim()) || '').trim()));
    check('[간격목차] 패널: 제목 방식 저장·목차 다시 그릴 때 유지',
      /const _SPLIT_TITLE_MODE_KEY='novelepub_autosplit_titlemode';/.test(parser) && /if\(_getAutoSplitActive\(\)\)\{\n    try\{ const bar=_buildIntervalTitleBar\(\);/.test(parser) &&
      /titleMode:titlePref\.mode==='number'\?'number':'nearby'/.test(parser));
    check('[간격목차] 제목 일괄 변경 시 챕터 캐시 무효화 (_tocTouch)', /t\.originalTitle=t\.title;\n  \}\);\n  _saveSplitTitlePrefs\(mode, tpl\);[\s\S]{0,160}_tocTouch\(\);/.test(parser));
    check('[간격목차] 일괄 변환도 제목 방식 선택 (미리보기·변환 공용 옵션)',
      (conv.match(/computeIntervalSplit\(lines, [a-z]+, _batchSplitOpts\(split\)\)/g) || []).length === 2 && /id='batchIntervalTitleMode'/.test(conv));
    check('[간격목차] 화수 입력창: 추천값이 입력칸에 채워짐·서식 태그 렌더링',
      /Toast\.prompt\(promptMsg, '화수', String\(suggestVal\)\)/.test(parser) && /function prompt\(msg, placeholder = '', defaultVal = ''\)[\s\S]{0,1500}p\.innerHTML = _sanitizeHtml\(msg\);/.test(read('core.js')));
    check('[간격목차] 패널 스타일은 CSS 변수만 사용', /\.split-title-bar\{/.test(css) && !/\.split-title-[a-z-]+\{[^}]*#[0-9a-fA-F]{3,6}/.test(css));
  }

  // ── 20. Phase 29 — 선택 정규식 3단계 파이프라인 (후보 추출 → 오탐 필터 → 문맥·번호 연속성) · 핵심 5종 프리셋 · 엄격 검증 토글 ──
  {
    const read = f => fs.readFileSync(path.join(ROOT, f), 'utf8');
    const coreSrc = read('core.js'), ui = read('ui-state.js'), conv = read('convert.js'), parser = read('parser.js'), html = read('index.html'), st = read('settings.js');
    const detect = G('detectToc'), splitPat = G('_splitCombinedPattern'), pcp = G('parseCustomPattern'), describe = G('describeTocDetection');
    // 20-1. 핵심 5종 프리셋: 컴파일·ReDoS 가드 통과·예시 매칭·본문 불일치
    const pc = { console }; vm.createContext(pc);
    const ps = coreSrc.indexOf('const PAT_PRESETS = [');
    vm.runInContext(coreSrc.slice(ps, coreSrc.indexOf('\n];', ps) + 3) + '\nthis.P=PAT_PRESETS;', pc);
    const core = pc.P.filter(x => x.cat === 'core');
    check('[파이프라인] 핵심 5종 프리셋 (core 카테고리)', core.length === 5, core.map(x => x.label).join(','));
    const ex = {
      '한국어 회차/장': [['제1장 시작', '12화. 각성', '제 3 부', '2권 - 귀환'], ['10장의 카드를 뽑았다.', '3부작이었다', '제1화는']],
      '영문 챕터': [['Chapter 1', 'Part 2: The End', 'CHAPTER TWO', 'Ch.3'], ['Part of the plan', 'Chapters 3']],
      '프롤로그/외전/특외': [['프롤로그', '특별 외전 1', '특외. 그 후의 이야기', '외전 2 - 일상'], ['프롤로그는 끝났다', '후기를 남겼다']],
      '장식 기호 챕터': [['<제1장. 부활>', '[특외] 평화로운 일상', '*** 3화 ***'], ['그는 [검]을 들었다']],
      '숫자 단독/부제': [['01', '1. 붉은 달', '12 - 재회'], ['2026년 여름', '12,000원', '1.5배']],
    };
    for(const c of core){
      const r = pcp(c.val, '제1화\n본문');
      const [hit, miss] = ex[c.label] || [[], []];
      check(`[파이프라인] 프리셋 '${c.label}' 유효·가드 통과·예시 감지·본문 불일치`,
        !!r.rx && hit.every(h => r.rx.test(h)) && miss.every(m => !r.rx.test(m)), r.error || '');
    }
    // 20-2. 결합 정규식 분리 = buildCombinedPat 역변환 (OR 의미 보존)
    const cU = sandbox('ui-state.js', ['buildCombinedPat']);
    const comb = vm.runInContext('buildCombinedPat', cU)(new Set(core.map(c => c.val)));
    const parts = splitPat(comb);
    const probe = ['제1장 시작', 'Chapter 1', '프롤로그', '<제1장. 부활>', '01', '그는 걸었다.', '2026년'];
    const rxAll = new RegExp(comb, 'i'), rxParts = parts.map(x => new RegExp(x, 'i'));
    check('[파이프라인] 결합 정규식 → 개별 5개 분리, 매칭 결과 동일', parts.length === 5 && probe.every(l => rxAll.test(l) === rxParts.some(r => r.test(l))), JSON.stringify(parts));
    check('[파이프라인] 감싸지 않은 정규식·빈 대안·역참조는 쪼개지 않음',
      splitPat('^(소설명 \\d+|\\d+화|\\d+$)').length === 1 && splitPat('^(?:a|)').length === 1 && splitPat('^(?:(a)\\1|b)').length === 1 && splitPat('').length === 0);
    // 20-3. 3단계 필터 — 소설 본문 노이즈
    const novel = [
      '프롤로그', '', '본문 시작이다.', '',
      '1', '', '그는 걸었다.', '2026', '그 해 겨울이었다.', '',
      '2', '', '"1화 봤어?"', '3 명의 병사가 달려왔다.', '', '【레벨이 올랐습니다】', '', '-끝-', '',
      '3', '', '본문.', '1. 사과', '2. 배', '',
      '500', '', '본문 노이즈.', '',
      '제2부', '', '1', '', '다시 시작했다.', '',
      '2', '본문이 바로 붙음', '',
      '<제3장. 부활>', '', '본문', '',
      '[특외] 평화로운 일상', '본문 바로', '',
      '*** 3화 ***', '', '본문', '',
    ];
    const pats = core.map(c => c.val);
    const on = detect(novel, { customPats: pats }), off = detect(novel, { customPats: pats, strictContext: false });
    const titles = d => d.items.map(it => it.title);
    const T_ON = titles(on);
    check('[파이프라인] 엄격 모드: 대사·서술문·상태창·종결 표식·번호 목록·연도·금액 제외',
      !T_ON.some(t => ['"1화 봤어?"', '3 명의 병사가 달려왔다.', '【레벨이 올랐습니다】', '-끝-', '1. 사과', '2. 배', '2026', '500'].includes(t)), T_ON.join(' | '));
    check('[파이프라인] 엄격 모드: 프롤로그·숫자 1~3·제2부·부 리셋 후 1·장식 챕터 확정',
      ['프롤로그', '1', '2', '3', '제2부', '<제3장. 부활>', '[특외] 평화로운 일상', '*** 3화 ***'].every(t => T_ON.includes(t)) &&
      on.items.filter(it => it.title === '1').length === 2, T_ON.join(' | '));
    check('[파이프라인] 엄격 모드: 아래가 본문으로 붙은 숫자만 줄은 제외 (위아래 모두 빈 줄 필요)', !on.items.some(it => it.line === 36) && novel[35] === '2');
    check('[파이프라인] 엄격 끄면 빈 줄 검사만 해제 — 붙은 숫자 줄 인정, 연도·금액은 번호 흐름으로 계속 제외',
      off.items.some(it => it.line === 36 && it.title === '2') && !titles(off).includes('2026') && !titles(off).includes('500'));
    check('[파이프라인] 종류 분류: 프롤로그=kw · 제2부=vol · 특외=side', on.items.find(it => it.title === '프롤로그')?.kind === 'kw' &&
      on.items.find(it => it.title === '제2부')?.kind === 'vol' && on.items.find(it => it.title === '[특외] 평화로운 일상')?.kind === 'side');
    const pp = on.stats.pipeline;
    check('[파이프라인] 통계: 패턴별 매칭 합 ≥ 후보(lineIndex 중복 제거) · 단계별 제외 사유',
      pp && pp.patterns === 5 && pp.perPattern.reduce((a, b) => a + b, 0) >= pp.candidates && pp.rejected.sequence >= 1 && pp.rejected.ending >= 1 && pp.rejected.blank >= 1, JSON.stringify(pp));
    check('[파이프라인] 요약 문구에 후보·제외 사유 표시', /^입력 패턴 5개: 본편 \d+화.* — 후보 \d+줄 중 제외 .*번호 흐름/.test(describe(on)) && /빈 줄 검사 끔$/.test(describe(off)), describe(on));
    // 20-4. 번호 연속성 — 첫 목차 1~20, 큰 숫자 시작 제외, 파일명 범위로 기준점
    const seq = ['', '2026', '', '본문', '', '1', '', '본문', '', '2', '', '본문', '', '9', '', '본문', '', '3', '', '본문', ''];
    const sq = detect(seq, { customPat: '^\\d+$' }).items.map(it => it.title);
    check('[파이프라인] 숫자만: 2026 시작 제외 · +5 초과 점프(9) 제외 · 1→2→3 확정', JSON.stringify(sq) === JSON.stringify(['1', '2', '3']), JSON.stringify(sq));
    const r2 = detect(['', '101', '', '본문', '', '102', '', '본문', ''], { customPat: '^\\d+$', range: { start: 101, end: 200, total: 100 } });
    check('[파이프라인] 파일명 범위(101-200)면 101부터 인정', r2.items.length === 2, JSON.stringify(r2.items));
    // 20-5. 같은 줄이 여러 정규식에 맞아도 1번만 수집
    const dup = detect(['', '제1화 시작', '', '본문', '', '제2화 끝', '', '본문'], { customPats: ['^제\\s*\\d+화', '^.*\\d+화.*$', pats[0]] });
    check('[파이프라인] 중복 매칭 줄은 lineIndex 기준 1회', dup.items.length === 2 && dup.stats.pipeline.perPattern.every(n => n === 2) && dup.stats.pipeline.candidates === 2);
    // 20-6. Worker 동등성 (결합 패턴 문자열 + 엄격 옵션 — 직렬화된 파이프라인 함수 동일 동작)
    {
      const raw = novel.join('\n');
      for(const strictContext of [true, false]){
        const w = await runWorker(workerSrc, { type: 'SPLIT', id: 29, payload: { raw, customPat: comb, opts: { strictContext } } });
        check(`[파이프라인] Worker 결과 = 메인 스레드 (엄격 ${strictContext ? '켬' : '끔'})`, w.last.type === 'DONE' && eq(w.last.result, splitChapters(raw, comb, { strictContext })));
      }
    }
    // 20-7. UI·상태 연결 (StateManager 단일 기준)
    check('[파이프라인] 상태값 tocStrictContext (convert 스토어 기본 true)', /tocStrictContext:true\s+\/\/ ★ 선택 정규식 파이프라인/.test(coreSrc));
    check('[파이프라인] 토글 마크업: 체크박스·data-input-action·인라인 스타일 없음',
      /<input type="checkbox" id="optStrictTocCtx" checked data-input-action="toggleStrictTocCtx">/.test(html) && !/optStrictTocCtx[^>]*style=/.test(html));
    check('[파이프라인] 핵심 5종 탭이 기본 탭 · 초기 렌더가 마크업 탭을 따름',
      /<button class="pat-cat-tab on" data-cat="core">핵심 5종<\/button>/.test(html) && /renderChips\(_activeCat\);/.test(ui) && !/renderChips\('popular'\);/.test(ui));
    check('[파이프라인] 토글 핸들러: 상태 변경·저장·편집 보호 후 재감지', /toggleStrictTocCtx: \(el\) => \{[\s\S]{0,400}S\.tocStrictContext=next;[\s\S]{0,700}if\(edited\)\{[\s\S]{0,300}previewToc\(\);/.test(ui));
    check('[파이프라인] 상태 → 체크박스 구독 동기화', /state\.tocStrictContext !== prev\?\.tocStrictContext/.test(ui));
    check('[파이프라인] 저장·복원 (epub_extra.strictTocCtx)', /strictTocCtx:\(typeof S!=='undefined'/.test(st) && /S\.tocStrictContext=s\.strictTocCtx;/.test(st));
    check('[파이프라인] 변환·일괄·미리보기·캐시 키 모두 같은 옵션',
      (conv.match(/strictContext/g) || []).length >= 5 && /strictContext:getTocStrictContext\(\),\n  \};/.test(parser) && /\$\{getTocStrictContext\(\)\}:\$\{JSON\.stringify\(cleanOpts\)\}/.test(parser));
  }

  // ── 21. Phase 30 (UI 정제 1단계) — 측정으로 확인한 접근성·표기 버그 회귀 방지 (docs/baseline.md §7) ──
  {
    const read = f => fs.readFileSync(path.join(ROOT, f), 'utf8');
    const html = read('index.html'), css = read('style.css'), ui = read('ui-state.js'), conv = read('convert.js'), st = read('settings.js'), cs = read('cover-search.js');
    // 21-1. 디자인 지표 측정기 결과 재사용 (같은 계산을 테스트에 복제하지 않음)
    const design = JSON.parse(require('child_process').execFileSync(process.execPath, [path.join(__dirname, 'measure-design.js'), '--json'], { encoding: 'utf8' }));
    check('[정제1] index.html 클래스는 모두 style.css에 정의', design.html.undefinedClasses.length === 0, design.html.undefinedClasses.join(' '));
    for(const [theme, rows] of Object.entries(design.contrast)){
      const bad = rows.filter(r => r.ratio !== null && r.ratio < 4.5);
      check(`[정제1] 토큰 대비 4.5:1 이상 (${theme})`, bad.length === 0, bad.map(r => `${r.label} ${r.ratio}`).join(', '));
    }
    // 21-2. 단축키: 표 하나가 keydown·표기를 모두 만든다 (예전 'Ctrl+D'·'Ctrl+Enter' 오표기 재발 방지)
    check('[정제1] 마크업에 단축키 문자열 하드코딩 없음', !/Ctrl\s*\+\s*(D|Enter|Space|S)\b/.test(html.replace(/<!--[\s\S]*?-->/g, '')));
    check('[정제1] keydown은 SHORTCUTS 표로 판별', /const sc=SHORTCUTS\.find\(s=>s\.match\(e\)\);/.test(ui) && !/e\.key==='s'\|\|e\.key==='S'\)\{\s*e\.preventDefault\(\);\s*typeof downloadEpub/.test(ui));
    check('[정제1] 표기 요소가 표를 참조 (convert·download)',
      /id="convertBtn"[^>]*data-shortcut="convert"/.test(html) && /id="btmDlBtn"[^>]*data-shortcut="download"/.test(html)
      && (html.match(/data-shortcut-kbd="(convert|download)"/g) || []).length === 2 && /applyShortcutLabels\(\);/.test(ui));
    // 21-3. 이름·라벨·랜드마크
    check('[정제1] <main> 랜드마크 1개', (html.match(/<main\b/g) || []).length === 1 && /<main class="wrap">/.test(html));
    check('[정제1] 드롭존 이름 = 보이는 글자 (aria-label 없음)', /<div class="dz" id="txtDz" tabindex="0" role="button">/.test(html));
    const needName = ['histSortSel', 'cssLine', 'cssFontSize', 'cssLineSlider', 'cssFontSizeSlider', 'cssIndentSlider',
      'cssPadTopSlider', 'cssPadTop', 'cssPadBottomSlider', 'cssPadBottom', 'cssPadLeftSlider', 'cssPadLeft', 'cssPadRightSlider', 'cssPadRight'];
    const unnamed = needName.filter(id => !new RegExp(`id="${id}"[^>]*aria-label="[^"]+"`).test(html));
    check('[정제1] 설정 입력·선택 상자 이름 있음', unnamed.length === 0, unnamed.join(' '));
    check('[정제1] 라벨 for 연결 (폰트·JPG 품질)', /<label for="cssFont">/.test(html) && /<label for="optImgQuality">/.test(html));
    check('[정제1] 스크롤 영역 키보드 접근 (#regexFeedList)', /id="regexFeedList" tabindex="0" role="region" aria-label="[^"]+"/.test(html));
    check('[정제1] 프리셋 목록 자식 listitem · 이름 키보드 실행', /chip\.setAttribute\('role','listitem'\)/.test(st) && /role="listitem">저장된 프리셋 없음/.test(st) && /nameEl\?\.addEventListener\('keydown'/.test(st));
    // 21-4. 표지 썸네일 img alt (axe image-alt)
    const altSites = [
      /img=document\.createElement\('img'\); img\.alt='표지 미리보기';/.test(ui),
      /shown\.alt='표지 미리보기'/.test(conv),
      /img\.src=dataUrl; img\.alt='표지 미리보기';/.test(conv),
      /img\.src=objUrl; img\.alt='표지 미리보기'; img\.dataset\.blobUrl=objUrl;/.test(conv),
      /<img id="bthumb_'\+i\+'" src="" alt="표지">/.test(conv),
      /img\.alt='표지';img\.classList\.add\('js-convert-img'\)/.test(conv),   // Phase 32: cssText → 클래스
      /img\.alt = '표지 미리보기';\n\s*img\.dataset\.blobUrl = objUrl;/.test(cs),
    ];
    check('[정제1] 표지 썸네일 img 7곳 alt', altSites.every(Boolean), JSON.stringify(altSites));
    // 21-5. 비활성 패턴 버튼은 실제 disabled (흐림만 하던 이전 방식 금지)
    check('[정제1] setPatIdle 단일 경로 · 버튼 disabled', /function setPatIdle\(idle\)\{[\s\S]{0,300}b\.disabled=!!idle;/.test(conv)
      && !/classList\.(add|remove)\('is-idle'\)/.test(conv + ui) && /#patSection\.is-idle \.pat-actions\{pointer-events:none\}/.test(css));
    // 21-6. 터치 영역 24px
    check('[정제1] 슬라이더·작은 선택 상자 24px', /\.css-slider\{[^}]*height:24px/.test(css) && /\.pad-slider\{[^}]*height:24px/.test(css) && /\.inp-xs\{[^}]*min-height:24px/.test(css));
  }

  // ── 22. Phase 31 (UI 정제 2단계 — 성능) ──
  {
    const read = f => fs.readFileSync(path.join(ROOT, f), 'utf8');
    const html = read('index.html'), parser = read('parser.js'), conv = read('convert.js'), sw = read('sw.js');
    const bootExists = fs.existsSync(path.join(ROOT, 'theme-boot.js'));
    const boot = bootExists ? read('theme-boot.js') : '';
    check('[정제2] theme-boot.js 파일 있음', bootExists);
    // 22-1. 스크립트: theme-boot.js만 동기(head), 나머지는 defer + 원래 실행 순서 유지
    const tags = [...html.matchAll(/<script src="([^"]+)"([^>]*)><\/script>/g)].map(m => ({ src: m[1], attrs: m[2] }));
    const order = tags.map(t => t.src);
    check('[정제2] 스크립트 순서 유지', JSON.stringify(order) === JSON.stringify(['theme-boot.js', 'lib/jszip.min.js', 'parser.js', 'epub-gen.js', 'core.js', 'settings.js', 'cover-search.js', 'convert.js', 'edit.js', 'ui-state.js', 'main.js']), order.join(','));
    check('[정제2] theme-boot.js 외 전부 defer', tags.filter(t => t.src !== 'theme-boot.js').every(t => /\bdefer\b/.test(t.attrs)) && !/\bdefer\b/.test(tags[0].attrs));
    const head = html.slice(0, html.indexOf('</head>'));
    check('[정제2] theme-boot.js는 <head>, style.css 뒤', head.indexOf('<script src="theme-boot.js">') > head.indexOf('href="style.css"') && head.includes('<script src="theme-boot.js">'));
    check('[정제2] theme-boot.js SW 프리캐시', /'\.\/theme-boot\.js'/.test(sw));
    // 22-2. theme-boot 동작: 허용값만 적용, 저장소 오류에도 예외 없음
    const runBoot = store => {
      if (!bootExists) return {};
      const attrs = {};
      const ctx = { document: { documentElement: { setAttribute: (k, v) => { attrs[k] = v; } } },
        localStorage: { getItem: k => { if (store === 'throw') throw new Error('denied'); return store[k] ?? null; } } };
      vm.runInNewContext(boot, ctx);
      return attrs;
    };
    const a1 = runBoot({ novelepub_theme: 'dark', novelepub_skin: 'forest' });
    const a2 = runBoot({ novelepub_theme: '<x>', novelepub_skin: 'terracotta' });
    let threw = false; try { runBoot('throw'); } catch (e) { threw = true; }
    check('[정제2] theme-boot: 다크·포레스트 적용 / 이상값·기본 스킨 무시 / 저장소 오류 무시',
      a1['data-theme'] === 'dark' && a1['data-skin'] === 'forest' && !('data-theme' in a2) && !('data-skin' in a2) && !threw, JSON.stringify({ a1, a2, threw }));
    // 22-3. 목차 확인: 감지 중 표시 → 다음 화면 → 감지 (finally로 표시 해제)
    check('[정제2] previewToc 래퍼: 표시 → 다음 화면 → 실행 → 해제',
      /async function previewToc\(\)\{[\s\S]{0,200}return _previewTocRun\(\);\s*_setTocBusy\(true\);\s*try\{\s*await _afterNextPaint\(\);\s*return await _previewTocRun\(\);\s*\}finally\{\s*_setTocBusy\(false\);/.test(parser)
      && /async function _previewTocRun\(\)\{/.test(parser));
    // _afterNextPaint: rAF가 없거나 탭이 숨겨져도 반드시 끝남
    const anpSrc = (parser.match(/function _afterNextPaint\(\)\{[\s\S]*?\n\}/) || [''])[0];
    const anpCtx = { document: { hidden: true }, setTimeout, Promise };
    let anpDone = false;
    if (anpSrc) {
      vm.runInNewContext(anpSrc + '\nthis.f=_afterNextPaint;', anpCtx);
      anpDone = await Promise.race([anpCtx.f().then(() => true), new Promise(r => setTimeout(() => r(false), 500))]);
    }
    check('[정제2] _afterNextPaint: 숨겨진 탭·rAF 없음에서도 진행', anpSrc.length > 0 && anpDone === true);
    check('[정제2] 감지 결과 계산과 목차 렌더링 사이 양보 + 최신 요청 확인',
      /await yieldToMain\(\);\s*if\(seq!==_previewTocSeq\) return;\s*S\.tocItems=found;\s*renderTocItems\(\);/.test(parser));
    check('[정제2] 유사 목차 후보: 시작 전·1만 줄마다 양보', /if\(canYield\) await yieldToMain\(\);\s*for\(let i=0;i<n;i\+\+\)\{[\s\S]{0,260}if\(canYield&&i%10000===9999\) await yieldToMain\(\);/.test(parser));
    check('[정제2] 감지 Worker 기준 2만 줄', /const DETECT_WORKER_MIN_LINES=20000;/.test(conv) && /lines\.length<DETECT_WORKER_MIN_LINES/.test(conv) && !/lines\.length<100000\|\|typeof Worker/.test(conv));
    // 22-4. 스크립트 실행 전 첫 화면 = 초기화 후 상태 (파일 없음 → 패턴 버튼 비활성)
    check('[정제2] 첫 화면부터 패턴 버튼 비활성', /<div class="meta-block is-idle" id="patSection">/.test(html)
      && /data-action="previewToc" disabled>목차 확인<\/button><button class="btn btn-ghost btn-sm" data-action="autoSplitByInterval" disabled>/.test(html));
  }


  // ── 23. Phase 32 (UI 정제 3단계 — 디자인 축소) ──
  {
    const read = f => fs.readFileSync(path.join(ROOT, f), 'utf8');
    const html = read('index.html'), css = read('style.css'), core = read('core.js'), ui = read('ui-state.js'), parser = read('parser.js');
    const jsFiles = ['parser.js', 'epub-gen.js', 'core.js', 'settings.js', 'cover-search.js', 'convert.js', 'edit.js', 'ui-state.js', 'main.js'];
    const allJs = jsFiles.map(read).join('\n');
    // 23-1. 정적 지표 — tests/measure-design.js와 같은 계산 (기준선 dfd847b: 색 22회·반경 4종·그림자 33종·무한 11·화면 이모지 218·cssText 73)
    let m = null;
    try { m = JSON.parse(require('child_process').execFileSync(process.execPath, [path.join(ROOT, 'tests/measure-design.js'), '--json'], { encoding: 'utf8' })); } catch (e) { m = null; }
    const js = m ? Object.values(m.js) : [];
    const sum = k => js.reduce((a, v) => a + (v[k] || 0), 0);
    check('[정제3] CSS 규칙 안 색상·반경·그림자 리터럴 0 (토큰만)', !!m && m.css.colorLiteralOccurrencesInRules === 0 && m.css.uniqueRadiusLiterals.length === 0 && m.css.uniqueShadowLiterals === 0,
      m ? `색 ${m.css.colorLiteralOccurrencesInRules} · 반경 ${m.css.uniqueRadiusLiterals.join(',')} · 그림자 ${m.css.uniqueShadowLiterals}` : '측정 실패');
    check('[정제3] 무한 반복 애니메이션 1개 이하 (진행 막대 광택만)', !!m && m.css.infiniteAnimationDecls <= 1, m ? m.css.infiniteAnimations.join(' / ') : '');
    check('[정제3] 화면에 보이는 이모지 0 (HTML·JS)', !!m && m.html.emojiCharsUi === 0 && sum('emojiUi') === 0, m ? `HTML ${m.html.emojiCharsUi} · JS ${sum('emojiUi')}` : '');
    check('[정제3] JS 인라인 스타일 대입 80곳 이하 · cssText 10곳 이하 (동적 값만)', !!m && sum('styleAssign') <= 80 && sum('styleCssText') <= 10, m ? `${sum('styleAssign')} · cssText ${sum('styleCssText')}` : '');
    // 23-2. 아이콘: 스프라이트 정의 = icon() 이름표 = 실제 사용처
    const symbols = new Set([...html.matchAll(/<symbol id="i-([\w-]+)"/g)].map(x => x[1]));
    const names = new Set(((core.match(/const ICON_NAMES=new Set\(\[([^\]]*)\]\)/) || ['', ''])[1].match(/'([\w-]+)'/g) || []).map(x => x.slice(1, -1)));
    check('[정제3] SVG 스프라이트 1개 (body 첫 자식, 숨김)', /<body[^>]*>\s*(?:<!--[^]*?-->\s*)?<svg xmlns="http:\/\/www\.w3\.org\/2000\/svg" class="ico-sprite" hidden aria-hidden="true">/.test(html) && (html.match(/class="ico-sprite"/g) || []).length === 1);
    check('[정제3] icon() 이름표 = 스프라이트 심볼', names.size >= 10 && [...names].every(n => symbols.has(n)) && [...symbols].every(n => names.has(n)), [...names].filter(n => !symbols.has(n)).join(','));
    const usedHtml = [...html.matchAll(/<use href="#i-([\w-]+)"/g)].map(x => x[1]);
    const usedJs = [...allJs.matchAll(/\bicon\('([\w-]+)'/g)].map(x => x[1]);
    check('[정제3] 사용 중인 아이콘이 모두 정의됨', usedHtml.length > 0 && usedJs.length > 0 && [...usedHtml, ...usedJs].every(n => symbols.has(n)), [...usedHtml, ...usedJs].filter(n => !symbols.has(n)).join(','));
    // icon() 동작: 장식용(aria-hidden) · 모르는 이름은 빈 문자열
    const iconSrc = (core.match(/const ICON_NAMES=[^\n]*\nfunction icon\([\s\S]*?\n\}/) || [''])[0];
    const ictx = {};
    if (iconSrc) vm.runInNewContext(iconSrc + '\nthis.icon=icon;', ictx);
    check('[정제3] icon(): aria-hidden SVG · 모르는 이름은 빈 문자열', !!ictx.icon && /^<svg class="ico" aria-hidden="true" focusable="false"><use href="#i-alert"\/><\/svg>$/.test(ictx.icon('alert')) && ictx.icon('nope') === '' && /class="ico big"/.test(ictx.icon('book', 'big')));
    check('[정제3] Toast 종류별 아이콘이 모두 정의됨', /const icons = \{ info:'info', success:'check-circle', error:'x-circle', warn:'alert' \}/.test(core) && ['info', 'check-circle', 'x-circle', 'alert'].every(n => symbols.has(n)));
    check('[정제3] 테마 버튼 아이콘은 _setThemeIcon 한 곳에서', /function _setThemeIcon\(btn, ?theme\)/.test(ui) && (ui.match(/_setThemeIcon\(/g) || []).length >= 4 && !/ibtn-icon[^\n]*textContent\s*=/.test(allJs));
    // 23-3. JS 인라인 스타일 → 클래스: 추가하는 js- 클래스는 CSS에 정의, 정의한 js- 클래스는 사용
    const addedJs = new Set([...allJs.matchAll(/classList\.add\('(js-[\w-]+)'\)/g)].map(x => x[1]));
    const definedJs = new Set([...css.matchAll(/\.(js-[\w-]+)\.\1\{|#[\w-]+\.(js-[\w-]+)\{/g)].map(x => x[1] || x[2]));
    check('[정제3] JS가 붙이는 js- 클래스 = CSS 정의', addedJs.size >= 50 && [...addedJs].every(c => definedJs.has(c)) && [...definedJs].every(c => addedJs.has(c)),
      [...addedJs].filter(c => !definedJs.has(c)).concat([...definedJs].filter(c => !addedJs.has(c)).map(c => '미사용 ' + c)).slice(0, 6).join(','));
    check('[정제3] 표시 전환은 setShown(hidden) — style.display 대입 0', !/\.style\.display\s*=(?!=)/.test(allJs));
    check('[정제3] 처음 숨김인 영역은 마크업 hidden + 보일 때 display는 CSS', /<div id="progressSparkline" class="progress-sparkline" hidden>/.test(html) && /<div id="convertReport" role="status" aria-live="polite" hidden>/.test(html)
      && /#convertReport\{display:block;/.test(css) && /\.progress-sparkline\{display:block;/.test(css));
    check('[정제3] 상태 스타일은 클래스·속성으로 (패턴 검사·선택 모드·간격 분할·hover)',
      /#pattern\[data-check="ok"\]\{border-color:var\(--green\)\}/.test(css) && /#toc-select-mode-btn\.is-on\{/.test(css) && /\.btn\[data-split="patternFound"\]:not\(:disabled\)\{color:var\(--text3\)\}/.test(css)
      && !/addEventListener\('mouse(enter|leave)',\s*\(\)\s*=>\s*\{\s*\w+\.style\./.test(allJs));
    // 23-4. 흐림(opacity)으로 글자를 낮추면 대비 4.5:1 미달 — 평면 배경에서 axe가 잡아낸 2곳
    const ssb = (parser.match(/function _syncSplitBtn\(state\)\{[\s\S]*?\n\}/) || [''])[0];
    check('[정제3] 간격 분할 버튼: 인라인 opacity 없음', ssb.length > 0 && !/style\.opacity/.test(ssb) && /btn\.dataset\.split=/.test(ssb));
    check('[정제3] 요약 칩 OFF: opacity 대신 text3', /\.opt-badge\.off\{color:var\(--text3\)\}/.test(css) && !/\.opt-badge\.off\{[^}]*opacity/.test(css));
  }

  // ── 24. Phase 33 (UI 정제 4단계 — 정보 구조) ──
  {
    const read = f => fs.readFileSync(path.join(ROOT, f), 'utf8');
    const html = read('index.html'), css = read('style.css'), parser = read('parser.js'), ui = read('ui-state.js'), conv = read('convert.js');
    const conv0 = html.slice(html.indexOf('<div id="page-convert"'), html.indexOf('<!-- /page-convert -->'));
    const pos = s => conv0.indexOf(s);
    const between = (a, b, x) => { const i = pos(a), j = conv0.indexOf(b, i), k = conv0.indexOf(x, i); return i >= 0 && j > i && k > i && k < j; };
    // 24-1. 기본 경로만 펼침: 파일 → 제목·작가 → 감지 결과 → (표지·글꼴) — 나머지는 접힌 details
    check('[정제4] 감지 결과(#regexFeed)는 처음부터 자리 잡음 · 분할 규칙보다 위', /<div class="regex-feed" id="regexFeed">/.test(html) && pos('id="regexFeed"') > 0 && pos('id="regexFeed"') < pos('id="patRuleBox"'));
    check('[정제4] 정규식 입력·목차 확인·간격 분할·패턴 직접 지정은 #patRuleBox 안 (기본 접힘)',
      /<details class="adv-box" id="patRuleBox">/.test(html) && ['id="pattern"', 'data-action="autoSplitByInterval"', 'id="patAdvanced"', 'id="optStrictTocCtx"'].every(x => between('id="patRuleBox"', '<!-- /장화 분할 규칙 블록 -->', x)));
    check('[정제4] 목차 편집 패널은 #tocEditBox 안 (기본 접힘) · 머리에 검수 요약',
      /<details class="adv-box toc-edit-box" id="tocEditBox">/.test(html) && between('id="tocEditBox"', '</details>', 'id="tocPanel"') && /id="tocReviewBadge" class="toc-review-badge" hidden/.test(html)
      && /badge\.textContent=total\?\('확인할 항목 '\+total\+'건'\):'검수 이상 없음'/.test(parser));
    check('[정제4] 삽화는 접히는 섹션(#illBox) — 섹션 머리가 summary', /<details class="sec sec-fold" id="illBox">\s*<summary class="sec-hdr">/.test(html) && between('id="illBox"', '</details>', 'id="illDz"'));
    check('[정제4] 표지·글꼴·미리보기는 #convertSide 한 묶음 — 장/화 뒤, 삽화 앞 (모바일 순서)',
      ['id="coverThumb"', 'id="coverUrlInp"', 'id="convFont"', 'id="miniReaderPreview"'].every(x => between('id="convertSide"', '<!-- /cv-side -->', x))
      && pos('id="patSection"') < pos('id="convertSide"') && pos('id="convertSide"') < pos('id="illBox"') && !/id="coverThumb"[\s\S]*id="txtDz"/.test(conv0));
    // 24-2. 펼치는 경로: 사용자가 목차를 보려 할 때만 — 자동 감지는 접힌 채
    check('[정제4] previewToc 클릭(EventDelegate)만 목차 패널을 펼침 · 파일 로드 자동 감지는 펼치지 않음',
      /previewToc:\s*\(\)\s*=>\s*\{\s*typeof openTocEditor==='function'&&openTocEditor\(\);/.test(ui) && !/openTocEditor/.test(conv));
    check('[정제4] 목차 항목으로 이동·감지 실패도 펼침', /function tocScrollToIndex\(i\)\{\n  if\(!_tocVS\|\|i==null\|\|!S\.tocItems\[i\]\) return;\n  openTocEditor\(\);/.test(parser)
      && /getElementById\('patRuleBox'\)\?\.setAttribute\('open',''\);\n    document\.getElementById\('patAdvanced'\)\?\.setAttribute\('open',''\);\n    openTocEditor\(\);/.test(parser));
    // openTocEditor 동작: 접혀 있으면 펼치고 가상 목록을 한 번 다시 그림 · 이미 열려 있으면 아무것도 안 함 · 요소 없으면 안전
    const oteSrc = (parser.match(/function openTocEditor\(\)\{[\s\S]*?\n\}/) || [''])[0];
    let oteOk = false;
    if (oteSrc) {
      const box = { open: false }; let refreshed = 0; let present = true;
      const ctx = { document: { getElementById: id => (present && id === 'tocEditBox') ? box : null }, _tocVS: { refresh: () => refreshed++ } };
      vm.runInNewContext(oteSrc + '\nthis.f=openTocEditor;', ctx);
      ctx.f(); const a = box.open === true && refreshed === 1;
      ctx.f(); const b = refreshed === 1;
      present = false; let c = true; try { ctx.f(); } catch (e) { c = false; }
      oteOk = a && b && c;
    }
    check('[정제4] openTocEditor(): 펼침 + 목록 다시 그리기 1회 · 이미 열림이면 무동작 · 요소 없으면 안전', oteOk);
    check('[정제4] summary로 직접 펼쳐도 목록 다시 그림 (테스트 VM 안전 가드)', /if\(typeof document!=='undefined'\) document\.getElementById\('tocEditBox'\)\?\.addEventListener\('toggle',e=>\{ if\(e\.target\?\.open\) _tocVS\?\.refresh\?\.\(\); \}\);/.test(parser));
    check('[정제4] 목차 되돌리기 단축키는 패널이 펼쳐져 있을 때만', /id:'undoToc'[\s\S]{0,300}getElementById\('tocEditBox'\)\?\.open!==false/.test(ui));
    check('[정제4] 파일 1개면 정렬 단추 숨김', /listWrap\?\.classList\.toggle\('is-single',files\.length<2\)/.test(conv)
      && /\.file-list-wrap\.is-single \[data-action="sortTxtAuto"\],\.file-list-wrap\.is-single \[data-action="sortTxtAlpha"\]\{display:none\}/.test(css));
    // 24-3. 데스크톱 2단 — 머리·탭·하단 바는 넓은 폭 고정, 본문은 변환 탭만 넓힘
    const mq = (css.match(/@media \(min-width:1100px\)\{[\s\S]*?\n\}/) || [''])[0];
    check('[정제4] 1100px 이상: 변환 탭 2단 그리드 · 오른쪽 열 고정(sticky)',
      /#page-convert\.page\.on\{display:grid;grid-template-columns:minmax\(0,1fr\) var\(--side-w\)/.test(mq) && /#page-convert > \.cv-side\{grid-column:2;[^}]*position:sticky/.test(mq) && /\.wrap:has\(> #page-convert\.on\)\{max-width:var\(--content-max-wide\)\}/.test(mq));
    check('[정제4] 머리·탭 줄·하단 바는 --chrome-max (탭을 바꿔도 위치 고정)', (css.match(/calc\(\(100% - var\(--chrome-max\)\)\/2 \+ 16px\)/g) || []).length === 2
      && /\.btm-inner\{flex:1;max-width:var\(--chrome-max\)/.test(css) && /:root\{--chrome-max:var\(--content-max-wide\)\}/.test(mq));
    // 24-4. 레이아웃 이동 방지 (첫 화면 안으로 올라온 영역들)
    check('[정제4] 레이아웃 이동 방지: 감지 목록 높이 고정 · 파일 전 목차 상자 숨김 · 요약 칩 자리 · 드롭존 높이 즉시 · 빈 미리보기 줄 자리',
      /\.regex-feed-list\{max-height:220px;min-height:var\(--feed-min-h\)/.test(css) && /#patSection\.is-idle ~ \.toc-edit-box\{display:none\}/.test(css)
      && /\.cv-side \.opt-summary-grid\{min-height:var\(--summary-min-h\)/.test(mq) && /\.dz\.ok\{[^}]*transition:border-color var\(--dur-fast\),background var\(--dur-fast\)\}/.test(css)
      && /<div class="feed-item-preview">\$\{prevSafe\?prevSafe\+'…':'&nbsp;'\}<\/div>/.test(ui));
  }

  // ── 25. Phase 34 (신뢰 기능) ──
  {
    const read = f => fs.readFileSync(path.join(ROOT, f), 'utf8');
    const eg = read('epub-gen.js'), conv = read('convert.js'), html = read('index.html'), css = read('style.css'), ui = read('ui-state.js'), st = read('settings.js'), parser = read('parser.js');
    // 25-1. 구조 검사기 — epub-gen.js의 검사 부분만 따로 실행 (DOM 없음 → 가벼운 XML 검사 사용)
    const VC = vm.createContext({ console, JSZip, Uint8Array, decodeURIComponent, Date, Promise, Set, Map, String, Object, JSON, RegExp, Array, Number, Math });
    const vStart = eg.indexOf('// 가벼운 XML 형식 검사');
    let validate = null, wf = null, resolve = null;
    try { vm.runInContext(eg.slice(vStart), VC); validate = VC.validateEpubZip; wf = VC._xmlWellFormedLite; resolve = VC._epubResolve; } catch (e) { validate = null; }
    check('[신뢰] 구조 검사기 로드 (epub-gen.js validateEpubZip)', vStart > 0 && typeof validate === 'function');
    if (typeof validate === 'function') {
      check('[신뢰] 경로 해석: 상대·../·%인코딩·#조각', resolve('OEBPS/Text/a.xhtml', '../Images/%ED%91%9C.jpg#x') === 'OEBPS/Images/표.jpg' && resolve('OEBPS/content.opf', 'Text/a.xhtml') === 'OEBPS/Text/a.xhtml');
      const wfCases = [['<a><b/></a>', true], ['<a x="1" y=\'2\'>t &amp; &#44; &#x41;</a>', true], ['<?xml version="1.0"?><!DOCTYPE html><a><!-- c --><![CDATA[<x>]]></a>', true],
        ['<a><b></a>', false], ['<a>&nbsp;</a>', false], ['<a x=1></a>', false], ['<a></a><b></b>', false], ['<a x="1" x="2"></a>', false], ['<a>1 < 2</a>', false], ['<a>', false]];
      check('[신뢰] 가벼운 XML 형식 검사: 정상 3 · 오류 7', wfCases.every(([t, ok]) => (wf(t) === null) === ok), wfCases.filter(([t, ok]) => (wf(t) === null) !== ok).map(x => x[0]).join(' | '));
      // 이 테스트가 만든 EPUB 전부 — 9개 항목 모두 통과해야 함
      const outs = fs.readdirSync(OUT_DIR).filter(f => f.endsWith('.epub'));
      const bad = [];
      for (const f of outs) {
        const buf = fs.readFileSync(path.join(OUT_DIR, f));
        const r = await validate(await JSZip.loadAsync(buf), new Uint8Array(buf.slice(0, 128)));
        if (r.passed !== r.total) bad.push(f + ': ' + r.checks.filter(c => !c.ok).map(c => c.id + ' ' + c.issues[0]).join('; '));
      }
      check(`[신뢰] 생성한 EPUB ${outs.length}개 모두 구조 검사 9/9 통과`, outs.length >= 10 && !bad.length, bad.slice(0, 3).join(' / '));
      // 일부러 망가뜨린 EPUB — 각각 의도한 검사 항목만 실패해야 함
      const base = fs.readFileSync(path.join(OUT_DIR, '14_edited_insert.epub'));
      const opfP = 'OEBPS/content.opf';
      const firstText = z => Object.keys(z.files).find(k => /Text\/.*\.xhtml$/.test(k) && !/cover/.test(k));
      const muts = [
        ['mimetype 압축', ['mimetype'], async () => { const z = await JSZip.loadAsync(base), n = new JSZip(); for (const k of Object.keys(z.files)) { if (!z.files[k].dir) n.file(k, await z.file(k).async('uint8array'), { compression: 'DEFLATE' }); } return [n, true]; }],
        ['mimetype 첫 항목 아님', ['mimetype'], async () => { const z = await JSZip.loadAsync(base), n = new JSZip(); for (const k of Object.keys(z.files)) { if (!z.files[k].dir && k !== 'mimetype') n.file(k, await z.file(k).async('uint8array')); } n.file('mimetype', 'application/epub+zip', { compression: 'STORE' }); return [n, true]; }],
        ['본문 파일 삭제', ['manifest', 'refs'], async z => { z.remove('OEBPS/Text/chapter_0005.xhtml'); return [z]; }],
        ['manifest 밖 파일', ['manifest'], async z => { z.file('OEBPS/extra.txt', 'x'); return [z]; }],
        ['XHTML 태그 짝 오류', ['xml'], async z => { const k = firstText(z); z.file(k, (await z.file(k).async('string')).replace('</p>', '</q>')); return [z]; }],
        ['정의 안 된 엔티티', ['xml'], async z => { const k = firstText(z); z.file(k, (await z.file(k).async('string')).replace('</body>', '<p>a &nbsp; b</p></body>')); return [z]; }],
        ['media-type 불일치', ['mediatype'], async z => { z.file(opfP, (await z.file(opfP).async('string')).replace('media-type="text/css"', 'media-type="text/plain"')); return [z]; }],
        ['spine idref 없음', ['spine'], async z => { z.file(opfP, (await z.file(opfP).async('string')).replace('<spine toc="ncx">', '<spine toc="ncx"><itemref idref="nope"/>')); return [z]; }],
        ['dc:language 없음', ['opf'], async z => { z.file(opfP, (await z.file(opfP).async('string')).replace(/<dc:language>[^<]*<\/dc:language>/, '')); return [z]; }],
        ['이미지 참조 끊김', ['refs'], async z => { const k = firstText(z); z.file(k, (await z.file(k).async('string')).replace('</body>', '<img src="../Images/none.jpg" alt=""/></body>')); return [z]; }],
        ['목차 조각 id 없음', ['refs'], async z => { const k = 'OEBPS/nav.xhtml'; z.file(k, (await z.file(k).async('string')).replace(/href="(Text\/[^"#]+)"/, 'href="$1#nope"')); return [z]; }],
      ];
      const mutBad = [];
      for (const [name, expect, fn] of muts) {
        const [z, keepMime] = await fn(await JSZip.loadAsync(base));
        if (!keepMime) z.file('mimetype', 'application/epub+zip', { compression: 'STORE' });
        const buf = await z.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
        const r = await validate(await JSZip.loadAsync(buf), new Uint8Array(buf.slice(0, 128)));
        const failed = r.checks.filter(c => !c.ok).map(c => c.id).sort().join(',');
        if (failed !== expect.slice().sort().join(',')) mutBad.push(`${name}: 실패 항목 [${failed}] (기대 [${expect.join(',')}])`);
      }
      check(`[신뢰] 일부러 망가뜨린 EPUB ${muts.length}종 — 각각 의도한 항목만 실패`, !mutBad.length, mutBad.slice(0, 3).join(' / '));
    }
    check('[신뢰] 변환 직후 구조 검사 (스트리밍 저장은 생략) · 새 변환이면 이전 결과 버림',
      /_runEpubCheck\(streamed\?null:blob\);/.test(conv) && /if\(seq!==_epubCheckSeq\) return;/.test(conv) && /_epubCheckSeq\+\+;   \/\/ ★ Phase 34/.test(conv) && /<div id="epubCheckReport" role="status" aria-live="polite" hidden><\/div>/.test(html));
    check('[신뢰] 구조 검사 결과 문구는 escHtml · EPUBCheck 전체가 아님을 표시', /r\.checks\.map\(c=>`<li class="\$\{c\.ok\?'is-ok':'is-bad'\}">\$\{icon\(c\.ok\?'check':'x-circle'\)\}<span>\$\{escHtml\(c\.label\)\}/.test(conv) && /c\.issues\.map\(escHtml\)/.test(conv) && /EPUBCheck 전체 검사를 대신하지는 않아요/.test(conv));
    // 25-2. 실제 미리보기 — 스크립트 실행 없는 iframe · CSP 안에서 CSS 적용
    check('[신뢰] 미리보기 iframe: sandbox="allow-same-origin"만 (allow-scripts 없음)', /<iframe id="previewFrame" sandbox="allow-same-origin" title="[^"]+"><\/iframe>/.test(html) && !/<iframe[^>]*allow-scripts/.test(html));
    check('[신뢰] 미리보기: 생성 스타일시트(adoptedStyleSheets) · style 속성은 CSSOM · script·on* 제거 · 이미지 blob: · 글꼴 data:',
      /fdoc\.adoptedStyleSheets=cssList\.map/.test(conv) && /new fwin\.CSSStyleSheet\(\)/.test(conv) && /el\.style\.cssText=inlineStyles\[k\]/.test(conv)
      && /x\.querySelectorAll\('script'\)\.forEach\(n=>n\.remove\(\)\)/.test(conv) && /if\(\/\^on\/i\.test\(a\.name\)\) el\.removeAttribute/.test(conv)
      && /url='data:'\+mt\+';base64,'/.test(conv) && /URL\.createObjectURL\(new Blob\(\[await f\.async\('uint8array'\)\]/.test(conv) && /\/\\\.\(\?:ttf\|otf\|woff2\?\)\$\/i\.test\(p\)/.test(conv));
    check('[신뢰] 미리보기 정리: 결과 초기화 때 blob: URL 해제 · 이전/다음은 문서 단위 · 기기 단추는 미니 리더와 같은 상태',
      /_pvRelease\(\);      \/\/ ★ Phase 34/.test(conv) && /if\(_pv&&!document\.getElementById\('previewStage'\)\?\.hidden\)\{ previewShowDoc\(_pv\.idx\+\(dir<0\?-1:1\)\); return; \}/.test(conv)
      && /const pvDev=document\.getElementById\('previewDevice'\);/.test(ui) && (html.match(/data-action="setReaderDevice"/g) || []).length === 8
      && /previewPickDoc: \(el\) => \{ typeof previewShowDoc==='function'&&previewShowDoc/.test(ui));
    // 25-3. 본문 정리 전후 비교
    const Gs = e => { try { return G(e); } catch (x) { return null; } };   // 이전 코드에서는 없음 → 실패로 기록 (중단하지 않음)
    const has3 = ['alignCleanupLines', 'buildCleanupDiff', 'cleanupChangedSpan'].every(n => typeof Gs(n) === 'function');
    const align = has3 ? G('alignCleanupLines') : () => null, cdiff = has3 ? G('buildCleanupDiff') : () => ({ changed: -1, hunks: [], total: 0, truncated: 0 }), span = has3 ? G('cleanupChangedSpan') : () => null;
    const j = x => JSON.stringify(x);
    check('[신뢰] 정렬: 여러 줄→한 줄 · 지운 줄', j(align(['가나다', '다라마바', '사아', '후기'], ['가나다', '다라마바 사아'])) === j([{ t: '=', a: '가나다', b: '가나다' }, { t: '~', a: ['다라마바', '사아'], b: '다라마바 사아' }, { t: '-', a: '후기' }]));
    check('[신뢰] 정렬: 한 줄 고침 · 중간 삭제', j(align(['"안녕..."', '둘'], ['“안녕…”', '둘'])) === j([{ t: '~', a: ['"안녕..."'], b: '“안녕…”' }, { t: '=', a: '둘', b: '둘' }])
      && j(align(['a', 'x', 'b'], ['a', 'b'])) === j([{ t: '=', a: 'a', b: 'a' }, { t: '-', a: 'x' }, { t: '=', a: 'b', b: 'b' }]));
    check('[신뢰] 바뀐 가운데 구간', j(span('그는 "안녕..." 했다', '그는 “안녕…” 했다')) === j([3, 10, 8]));
    const wrapLine = '가나다라마바사아자차카타파하'.repeat(3);
    const chs = [['1화', ['가나다라마바사아자차카타파하가나다라마바사', '아자차카타파하가나다라마바사아자차카타파하', '끝.', '', '정말이야...'].join('\n')], ['2화', '바뀌지 않는 줄\n둘째 줄'], ['3화', '보통 문장\n작가의 말\n선작 부탁드려요']];
    const dOff = cdiff(chs, { noise: false, hardWrap: false, symbols: false, mergeShort: false });
    const dOn = cdiff(chs, { noise: true, noisePresets: [], noiseCustom: '^작가의 말$', hardWrap: false, symbols: true, mergeShort: false, quoteStyle: 'keep' });
    check('[신뢰] 전후 비교: 옵션 끔 → 바뀐 챕터 0', dOff.changed === 0 && dOff.hunks.length === 0 && dOff.total === 3, j(dOff).slice(0, 120));
    check('[신뢰] 전후 비교: 기호 정리·잡음 줄 → 해당 챕터만, 지운 줄은 -, 고친 줄은 + (짝 있음)',
      dOn.changed === 2 && dOn.hunks.map(h => h.title).join() === '1화,3화'
      && dOn.hunks[0].rows.some(r => r.t === '+' && r.text === '정말이야…' && r.pair === '정말이야...')
      && dOn.hunks[1].rows.some(r => r.t === '-' && r.text === '작가의 말'), j(dOn.hunks.map(h => h.rows)).slice(0, 300));
    const many = Array.from({ length: 50 }, (_, i) => [`${i + 1}화`, '그는...']);
    const dMany = cdiff(many, { symbols: true, quoteStyle: 'keep' }, { limit: 30 });
    check('[신뢰] 전후 비교: 표시 30개 제한 · 나머지는 개수', dMany.hunks.length === 30 && dMany.truncated === 20 && dMany.changed === 50);
    check('[신뢰] 전후 비교 UI: 펼쳤을 때만 계산 · 옵션·목차가 바뀌면 다시 · 본문은 escHtml · del/ins 요소',
      /<details class="adv-box" id="cleanupDiffBox">/.test(html) && /if\(!document\.getElementById\('cleanupDiffBox'\)\?\.open\) return;/.test(st) && /scheduleCleanupDiff\(\);   \/\/ ★ Phase 34/.test(st)
      && /typeof scheduleCleanupDiff==='function'&&scheduleCleanupDiff\(\);/.test(ui) && /<del class="cdiff-row is-del">/.test(st) && /<ins class="cdiff-row is-add">/.test(st)
      && !/\$\{t\}|\$\{cut\}|\$\{r\.text\}/.test(st) && /function getRawChaptersForCleanupDiff\(\)\{\n  if\(!S\.txtFiles\?\.length\|\|!S\.tocItems\?\.length\) return null;/.test(parser));
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
