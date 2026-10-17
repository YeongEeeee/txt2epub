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
    check('[EPUB] nav 2단계 중첩 ol', (e.nav.match(/<ol>/g) || []).length === 4, `ol ${(e.nav.match(/<ol>/g) || []).length}개 (기대 4 = 최상위 1 + 권 3)`);
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
    check('[EPUB] 평면 목차 ol 1개', (e.nav.match(/<ol>/g) || []).length === 1);
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

  if(UPDATE){
    fs.writeFileSync(GOLDEN, JSON.stringify(golden, null, 2) + '\n', 'utf8');
    console.log(`golden.json 갱신: ${fixtures.length}개 픽스처`);
  }
  console.log(`\n통과 ${passed} / 실패 ${failures.length}`);
  failures.forEach(f => console.log('  ✗ ' + f));
  process.exit(failures.length ? 1 : 0);
}

main().catch(e => { console.error(e); process.exit(1); });
