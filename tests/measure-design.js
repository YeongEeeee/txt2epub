#!/usr/bin/env node
/**
 * NovelEPUB 디자인 지표 측정기 — Phase 0 기준선 / 이후 Phase 전후 비교용
 *
 *   node tests/measure-design.js          → 표 출력
 *   node tests/measure-design.js --json   → JSON 출력 (docs/baseline.md 갱신·비교용)
 *
 * 측정 항목 (모두 정적 분석 — 브라우저 없이 재현 가능)
 *   1. style.css: 고유 font-size / 색상 리터럴 / box-shadow / border-radius 값 수,
 *      @keyframes 수, 무한 반복 애니메이션 선언 수, backdrop-filter 사용 수, @media 목록
 *   2. index.html: 인라인 style 속성 수, 인라인 on* 핸들러 수, 이모지 문자 수
 *   3. JS: 마크업 문자열 안 style= 속성 수, element.style.* 직접 대입 수
 *   4. index.html에서 쓰지만 style.css에 정의가 없는 클래스
 *   5. 토큰 색 조합 명도 대비 (WCAG 2.x 상대 휘도 공식) — 라이트/다크
 *
 * 외부 라이브러리 없음 (Node 내장 fs/path만 사용)
 */
'use strict';
const fs   = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const read = f => fs.readFileSync(path.join(ROOT, f), 'utf8');
const JSON_OUT = process.argv.includes('--json');

const css  = read('style.css');
const html = read('index.html');
const JS_FILES = ['core.js', 'settings.js', 'cover-search.js', 'convert.js', 'edit.js', 'ui-state.js', 'main.js', 'parser.js', 'epub-gen.js'];
const js = Object.fromEntries(JS_FILES.map(f => [f, read(f)]));

// 주석 제거 (문자열 안의 /* 는 style.css에 없다고 가정)
const cssNoComment = css.replace(/\/\*[\s\S]*?\*\//g, '');

// ── 1. CSS 선언 값 수집 ──
function declValues(prop){
  const re = new RegExp('(?:^|[;{\\s])' + prop + '\\s*:\\s*([^;}]+)', 'g');
  const out = [];
  let m;
  while((m = re.exec(cssNoComment))) out.push(m[1].trim().replace(/\s*!important$/, '').replace(/\s+/g, ' '));
  return out;
}
const uniq = a => [...new Set(a)];

// :root / 테마 블록 안의 토큰 정의는 "정의"이므로 사용처 집계에서 분리
function stripTokenBlocks(src){
  return src.replace(/(:root(?::not\([^)]*\))?|\[data-theme=dark\])\s*\{[^{}]*\}/g, '');
}
// ★ Phase 32 보정: 스킨 블록([data-skin=…]{--accent:…})처럼 :root 밖에서 토큰만 정의하는 선언도 '정의'로 제외
//   (기준선의 '규칙 안 색상 리터럴 36종'에는 이런 토큰 정의가 섞여 있었음)
const cssUsage = stripTokenBlocks(cssNoComment).replace(/(?<=[;{\s])--[\w-]+\s*:[^;}]*;?/g, '');

function usageValues(prop){
  const re = new RegExp('(?:^|[;{\\s])' + prop + '\\s*:\\s*([^;}]+)', 'g');
  const out = [];
  let m;
  while((m = re.exec(cssUsage))) out.push(m[1].trim().replace(/\s*!important$/, '').replace(/\s+/g, ' '));
  return out;
}

const fontSizes    = usageValues('font-size');
const fontSizeLit  = fontSizes.filter(v => !/^var\(/.test(v));
const radii        = usageValues('border-radius');
// ★ Phase 32: 토큰만으로 조합한 값(예: 0 var(--radius-xs) var(--radius-xs) 0, calc(var(--radius-sm)*3))은 리터럴이 아님
//   — var(...)를 지운 뒤 남은 부분에 단위 있는 숫자(px·%·em…)나 색이 있을 때만 리터럴
const hasRawDim = v => /\d*\.?\d+(px|%|em|rem|vh|vw)\b|#[0-9a-f]{3,8}\b|rgba?\(/i.test(v.replace(/var\(--[\w-]+\)/g, ''));
const radiusLit    = radii.filter(v => v !== 'inherit' && v !== '0' && hasRawDim(v));
const shadows      = usageValues('box-shadow');
const shadowLit    = shadows.filter(v => v !== 'none' && hasRawDim(v));

// 색상 리터럴: 토큰 블록 밖(사용처)에서 직접 쓴 #hex / rgb() / rgba() / hsl()
const colorLitRe = /#[0-9a-fA-F]{3,8}\b|rgba?\([^)]*\)|hsla?\([^)]*\)/g;
const colorLitUsage = (cssUsage.replace(/@keyframes[^{]*\{(?:[^{}]*\{[^{}]*\})*[^{}]*\}/g, '').match(colorLitRe)) || [];
const colorLitAll   = cssNoComment.match(colorLitRe) || [];

const keyframes     = (cssNoComment.match(/@keyframes\s+([\w-]+)/g) || []).map(s => s.replace(/@keyframes\s+/, ''));
const animDecls     = usageValues('animation');
const infiniteDecls = animDecls.filter(v => /\binfinite\b/.test(v));
const backdrop      = (cssUsage.match(/(?:-webkit-)?backdrop-filter\s*:/g) || []).filter(s => !s.startsWith('-webkit'));
const mediaQueries  = uniq((cssNoComment.match(/@media\s*[^{]+/g) || []).map(s => s.trim()));

// ── 2. index.html ──
const inlineStyleHtml   = (html.match(/\sstyle\s*=\s*["']/g) || []).length;
const inlineHandlerHtml = (html.match(/\son[a-z]+\s*=\s*["']/g) || []).length;
// 이모지: Extended_Pictographic (숫자·# 등 키캡 기본 문자는 제외됨)
const htmlText = html.replace(/<script[\s\S]*?<\/script>/g, '').replace(/<style[\s\S]*?<\/style>/g, '');
const emojiHtml = (htmlText.match(/\p{Extended_Pictographic}/gu) || []).length;
// ★ Phase 32: 화면에 보이는 이모지만 — 주석과 챕터 감지 정규식 데이터(◆●▶★♠ 같은 기호 문자 클래스)는 제외
const htmlVisible = htmlText.replace(/<!--[\s\S]*?-->/g, '').replace(/<option[^>]*>[^<]*★[^<]*<\/option>/g, m => m.replace(/★/g, ''));
const emojiHtmlUi = (htmlVisible.match(/\p{Extended_Pictographic}/gu) || []).length;
function uiEmojiCount(src){
  const code = src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n').filter(l => !/^\s*\/\//.test(l) && !/console\.\w+\(/.test(l)).map(l => l.replace(/\s\/\/ .*$/, '')).join('\n')
    .replace(/\^\[[^\]\n]*\]/g, '')          // 정규식 '^[◆●…]' 문자 클래스
    .replace(/\[[^\]\n]*\]\$/g, '')           // '[…★☆]$' 문장 끝 문자 클래스
    .replace(/val:'[^'\n]*'/g, '')             // 프리셋 정규식 문자열
    .replace(/=\s*\/(?![\/*])[^\n]*\/[gimsuy]*\s*;/g, '=RX;');   // const _RX_… = /…/; 정규식 리터럴
  return (code.replace(/⌘/g, '').match(/\p{Extended_Pictographic}/gu) || []).length;   // ⌘는 macOS 키 이름 표기
}

// ── 3. JS ──
const jsStats = {};
for(const [f, src] of Object.entries(js)){
  jsStats[f] = {
    markupStyleAttr: (src.match(/<[a-z][^<>]*\sstyle\s*=\s*\\?["']/gi) || []).length,
    // ★ Phase 32 보정: 이전 식은 cssText를 두 번 셌음 (.style.<속성> 패턴에 이미 포함)
    styleAssign:     (src.match(/\.style\.[a-zA-Z]+\s*=(?!=)/g) || []).length,
    styleCssText:    (src.match(/\.style\.cssText\s*=/g) || []).length,
    emoji:           (src.match(/\p{Extended_Pictographic}/gu) || []).length,
    emojiUi:         uiEmojiCount(src),
  };
}

// ── 4. 미정의 클래스 ──
const htmlClasses = uniq([...html.matchAll(/\sclass\s*=\s*"([^"]*)"/g)].flatMap(m => m[1].split(/\s+/)).filter(Boolean));
const cssClassSet = new Set((cssNoComment.match(/\.(-?[_a-zA-Z][\w-]*)/g) || []).map(s => s.slice(1)));
// JS에서 상태용으로만 쓰이고 CSS 규칙이 필요 없는 마커 클래스는 여기 명시 (없으면 빈 배열)
const MARKER_ONLY = [];
const undefinedClasses = htmlClasses.filter(c => !cssClassSet.has(c) && !MARKER_ONLY.includes(c)).sort();

// ── 5. 명도 대비 ──
function tokenMap(blockRe){
  const m = cssNoComment.match(blockRe);
  const out = {};
  if(!m) return out;
  for(const d of m[0].matchAll(/--([\w-]+)\s*:\s*([^;]+);/g)) out[d[1]] = d[2].trim();
  return out;
}
const light = tokenMap(/:root\s*\{[^{}]*\}/);
const dark  = Object.assign({}, light, tokenMap(/\[data-theme=dark\]\s*\{[^{}]*\}/));
// 스킨: 라이트 = 기본 + [data-skin=x], 다크 = 다크 + [data-theme=dark][data-skin=x]
const esc = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const skinMap = (base, sel) => Object.assign({}, base, tokenMap(new RegExp('(?:^|\\n)' + esc(sel) + '\\s*\\{[^{}]*\\}')));
const SKINS = ['indigo', 'forest'];

function hexToRgb(h){
  h = h.replace('#', '');
  if(h.length === 3) h = h.split('').map(c => c + c).join('');
  if(!/^[0-9a-f]{6}$/i.test(h)) return null;
  return [0, 2, 4].map(i => parseInt(h.slice(i, i + 2), 16));
}
function lum([r, g, b]){
  const f = c => { c /= 255; return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4); };
  return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
}
function ratio(a, b){
  const A = lum(a), B = lum(b);
  return (Math.max(A, B) + 0.05) / (Math.min(A, B) + 0.05);
}
function resolve(map, name){
  let v = map[name];
  let guard = 0;
  while(v && /^var\(--([\w-]+)\)$/.test(v) && guard++ < 5) v = map[v.match(/^var\(--([\w-]+)\)$/)[1]];
  return v;
}
// 실제 화면에서 쓰이는 전경/배경 조합
const PAIRS = [
  ['text',      'bg-lifted', '본문 / 페이지 배경'],
  ['text2',     'bg-lifted', '보조 글자 / 페이지 배경'],
  ['text3',     'bg-lifted', '힌트 글자 / 페이지 배경'],
  ['text2',     'panel',     '보조 글자 / 카드'],
  ['text3',     'panel',     '힌트 글자 / 카드'],
  ['text3',     'bg-sunken', '플레이스홀더 / 입력칸'],
  ['accent',    'panel',     '강조 글자 / 카드'],
  ['accent',    'accent-bg', '강조 글자 / 강조 배경'],
  ['on-accent', 'accent',    '버튼 글자 / 강조 버튼'],
  ['on-accent', 'accent2',   '버튼 글자 / 강조 버튼 그라디언트 끝'],
  ['green',     'green-bg',  '성공 글자 / 성공 배경'],
  ['yellow',    'yellow-bg', '경고 글자 / 경고 배경'],
  ['blue',      'blue-bg',   '정보 글자 / 정보 배경'],
];
function contrastTable(map){
  return PAIRS.map(([fg, bg, label]) => {
    const f = hexToRgb(resolve(map, fg) || ''), b = hexToRgb(resolve(map, bg) || '');
    const r = f && b ? Math.round(ratio(f, b) * 100) / 100 : null;
    return { label, fg: `--${fg}`, bg: `--${bg}`, ratio: r, aa: r === null ? null : r >= 4.5, aaLarge: r === null ? null : r >= 3 };
  });
}

// ── 결과 ──
const result = {
  measuredAt: new Date().toISOString(),
  css: {
    lines: css.split('\n').length,
    fontSizeDecls: fontSizes.length,
    fontSizeLiteralDecls: fontSizeLit.length,
    uniqueFontSizeLiterals: uniq(fontSizeLit).sort(),
    uniqueFontSizeAll: uniq(fontSizes).length,
    uniqueColorLiteralsInRules: uniq(colorLitUsage.map(s => s.toLowerCase().replace(/\s+/g, ''))).length,
    colorLiteralOccurrencesInRules: colorLitUsage.length,
    uniqueColorLiteralsTotal: uniq(colorLitAll.map(s => s.toLowerCase().replace(/\s+/g, ''))).length,
    uniqueRadiusLiterals: uniq(radiusLit).sort(),
    uniqueShadowLiterals: uniq(shadowLit).length,
    keyframes: keyframes.length,
    keyframeNames: keyframes,
    animationDecls: animDecls.length,
    infiniteAnimationDecls: infiniteDecls.length,
    infiniteAnimations: infiniteDecls,
    backdropFilterRules: backdrop.length,
    mediaQueries,
  },
  html: {
    lines: html.split('\n').length,
    inlineStyleAttrs: inlineStyleHtml,
    inlineEventHandlers: inlineHandlerHtml,
    emojiChars: emojiHtml,
    emojiCharsUi: emojiHtmlUi,
    classesUsed: htmlClasses.length,
    undefinedClasses,
  },
  js: jsStats,
  contrast: Object.assign({ light: contrastTable(light), dark: contrastTable(dark) },
    ...SKINS.map(k => ({
      [`${k}-light`]: contrastTable(skinMap(light, `[data-skin=${k}]`)),
      [`${k}-dark`]:  contrastTable(skinMap(dark, `[data-theme=dark][data-skin=${k}]`)),
    }))),
};

if(JSON_OUT){
  process.stdout.write(JSON.stringify(result, null, 2) + '\n');
  process.exit(0);
}

const c = result.css, h = result.html;
const lines = [];
lines.push('── style.css ──');
lines.push(`  font-size 선언 ${c.fontSizeDecls}개 (토큰 외 리터럴 ${c.fontSizeLiteralDecls}개, 고유 리터럴 ${c.uniqueFontSizeLiterals.length}종: ${c.uniqueFontSizeLiterals.join(' ')})`);
lines.push(`  색상 리터럴(규칙 안) 고유 ${c.uniqueColorLiteralsInRules}종 / 사용 ${c.colorLiteralOccurrencesInRules}회 · 전체(토큰 포함) 고유 ${c.uniqueColorLiteralsTotal}종`);
lines.push(`  border-radius 고유 리터럴 ${c.uniqueRadiusLiterals.length}종: ${c.uniqueRadiusLiterals.join(' | ')}`);
lines.push(`  box-shadow 고유 리터럴 ${c.uniqueShadowLiterals}종`);
lines.push(`  @keyframes ${c.keyframes}개 · animation 선언 ${c.animationDecls}개 · 무한 반복 ${c.infiniteAnimationDecls}개`);
for(const a of c.infiniteAnimations) lines.push(`      ∞ ${a}`);
lines.push(`  backdrop-filter 규칙 ${c.backdropFilterRules}개`);
lines.push(`  @media: ${c.mediaQueries.join(' · ')}`);
lines.push('── index.html ──');
lines.push(`  인라인 style ${h.inlineStyleAttrs} · 인라인 on* 핸들러 ${h.inlineEventHandlers} · 이모지 ${h.emojiChars}자 (화면 ${h.emojiCharsUi}자) · 클래스 ${h.classesUsed}종`);
const uiJs = Object.values(result.js).reduce((n, s) => n + s.emojiUi, 0);
lines.push(`  화면 이모지 합계 (주석·감지 정규식 제외): HTML ${h.emojiCharsUi} + JS ${uiJs} = ${h.emojiCharsUi + uiJs}자`);
lines.push(`  style.css에 정의 없는 클래스 ${h.undefinedClasses.length}종: ${h.undefinedClasses.join(' ')}`);
lines.push('── JS ──');
for(const [f, s] of Object.entries(result.js)) lines.push(`  ${f.padEnd(16)} 마크업 style= ${s.markupStyleAttr} · .style 직접 대입 ${s.styleAssign} · 이모지 ${s.emoji}`);
for(const theme of Object.keys(result.contrast)){
  const rows = result.contrast[theme];
  const fails = rows.filter(r => r.ratio !== null && !r.aa).length;
  lines.push(`── 명도 대비 (${theme}) — 4.5:1 미달 ${fails}개 ──`);
  for(const r of rows){
    const mark = r.ratio === null ? '?' : r.aa ? 'AA' : r.aaLarge ? '큰글씨만' : '미달';
    lines.push(`  ${String(r.ratio ?? '-').padStart(5)}:1  ${mark.padEnd(5)} ${r.label} (${r.fg} on ${r.bg})`);
  }
}
console.log(lines.join('\n'));
