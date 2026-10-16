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
    check('[EPUB] 서문은 목차 제외', !/>서문</.test(e.nav));
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

  if(UPDATE){
    fs.writeFileSync(GOLDEN, JSON.stringify(golden, null, 2) + '\n', 'utf8');
    console.log(`golden.json 갱신: ${fixtures.length}개 픽스처`);
  }
  console.log(`\n통과 ${passed} / 실패 ${failures.length}`);
  failures.forEach(f => console.log('  ✗ ' + f));
  process.exit(failures.length ? 1 : 0);
}

main().catch(e => { console.error(e); process.exit(1); });
