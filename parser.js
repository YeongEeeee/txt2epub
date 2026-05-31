// ════════════════════════════════════════════════
// parser.js — 텍스트 파싱 및 목차 추출 모듈
// NovelEPUB | TXT → EPUB3
// 
// 의존성: (없음, 순수 함수)
// 내보내는 심볼:
//   escHtml, escAttr, sanitizeLine, renderBodyHtml
//   sortKey, smartSortFiles, extractFileNum
//   PATS, checkTitleWaPattern, checkNDotPattern, bestPat
//   splitChapters, extractChNum
//   buildChaptersFromTocItems, getCachedChapters
//   previewToc, showSuspiciousToast, autoSplitByInterval
// ════════════════════════════════════════════════

/* global S, Toast, yieldToMain, _autoSplitActive, _autoSplitLines,
   _chaptersCache, _chaptersCacheKey, _fullRawLines,
   renderTocItems, tocTab, fileToText, sampleLines */

'use strict';

// ★ FIX-07: SUSP_THRESHOLD는 상수 대신 함수로만 사용 — 설정 변경이 즉시 반영됨
// ★ B4/I4: 짧은 챕터 기준 — localStorage + DOM 슬라이더 실시간 반영 (기본값 50자)
function getSuspThreshold(){
  // 1순위: DOM 슬라이더 (설정 페이지에서 드래그 중인 값)
  const slider = typeof document !== 'undefined' && document.getElementById('suspThresholdSlider');
  if(slider) { const v = parseInt(slider.value); if(!isNaN(v) && v > 0) return v; }
  // 2순위: localStorage
  try{ const v = parseInt(localStorage.getItem('novelepub_susp_threshold')||'50',10); return v||50; }catch(e){ return 50; }
}
function escHtml(s){return s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');}
// ── 공통 본문 HTML 변환 함수 (bodyToHtml · bToHtml 통합) ──
// useItalic: 대화/회상 이탤릭 여부 · maxBlank: 연속 빈줄 최대 허용 수
// ── 텍스트 정규화 (인코딩 안전 처리) ──
// U+00AD(soft hyphen) → U+2014(em dash): 대화 표시 문자로 변환
// XML 1.0 비허용 제어문자 제거 (U+0000~U+001F 중 허용 외)
// 과도한 후행 공백 제거
function sanitizeLine(s){
  if(typeof s!=='string') return '';
  // U+00AD soft hyphen → em dash
  s=s.replace(/\u00ad/g,'\u2014');
  // XML 1.0 비허용 제어문자: U+0000-U+0008, U+000B, U+000C, U+000E-U+001F, U+007F
  s=s.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g,'');
  // U+FFFE, U+FFFF, 서로게이트 쌍 범위 (XML 비허용)
  s=s.replace(/[\uFFFE\uFFFF\uD800-\uDFFF]/g,'');
  // 후행 공백 제거
  return s.trimEnd();
}

function renderBodyHtml(body, {useItalic=true, maxBlank=2}={}){
  let html='';
  let blankRun=0;
  // CRLF → LF 정규화
  const lines=body.replace(/\r\n/g,'\n').replace(/\r/g,'\n').split('\n');
  for(const line of lines){
    const t=sanitizeLine(line).trim();
    if(!t){
      blankRun++;
      // ★ LOGIC-09: blankRun < maxBlank → maxBlank개까지만 허용 (<=는 +1개 허용 버그 수정)
      if(blankRun < maxBlank) html+='<p>&#160;</p>\n';
      continue;
    }
    blankRun=0;
    if(useItalic&&/^[-\u2014\u2012\u2013─]/.test(t)){
      html+='<p class="noindent"><em class="flashback">'+escHtml(t)+'</em></p>\n';
    } else if(/^(?:【|〔|\[|≪|❰)/.test(t)&&/(?:】|〕|\]|≫|❱)\s*$/.test(t)){
      html+='<p class="noindent sysmsg"><em>'+escHtml(t)+'</em></p>\n';
    } else {
      html+='<p>'+escHtml(t)+'</p>\n';
    }
  }
  return html;
}
// handleCustomFont → main.js로 이동 (customFontFile 등 main.js 전역 변수 의존)

// showResultStats → convert.js에 정의됨 (result-stat-card 클래스 사용, 중복 제거)

// ── 스마트 파일 정렬 키 ──
// 연재 소설 특성: 001화, 1화, 1-2화, EP.001, Chapter 1 등 다양한 번호 패턴
function sortKey(name){
  const stem=name.replace(/\.[^.]+$/,'');
  // 숫자 추출: 파일명에서 첫 번째 등장하는 숫자 블록을 주 정렬 키로
  const parts=stem.split(/(\d+)/);
  return parts.map((p,i)=>{
    if(isNaN(p)||p==='') return p.toLowerCase();
    // 숫자는 zero-pad 10자리로 비교 (자연 정렬)
    return '\uffff'+parseInt(p).toString().padStart(10,'0');
  });
}

// 소설 연재 특화 스마트 정렬
// 우선순위: ① 화번호(숫자) → ② 파일명 사전순
function smartSortFiles(files){
  return [...files].sort((a,b)=>{
    // 파일명에서 첫 번째 숫자 추출
    const numA=extractFileNum(a.name);
    const numB=extractFileNum(b.name);
    // 둘 다 숫자 있으면 숫자 비교
    if(numA!==null&&numB!==null) return numA-numB;
    // 숫자 없으면 sortKey 기준 사전순
    const ka=sortKey(a.name), kb=sortKey(b.name);
    return ka<kb?-1:ka>kb?1:0;
  });
}

// 파일명에서 대표 번호 추출
// "001화_제목.txt" → 1, "EP.023_제목.txt" → 23, "제목_123.txt" → 123
function extractFileNum(name){
  const stem=name.replace(/\.txt$/i,'');
  // 화번호 패턴 우선
  let m=stem.match(/^(\d+)화/)||stem.match(/^(\d+)\s*[-._]/)||
         stem.match(/(?:EP|Ch|Chapter|화)[\.\s]*(\d+)/i)||
         stem.match(/^(\d+)/)||stem.match(/(\d+)/);
  return m?parseInt(m[1]):null;
}

// ══════════════════════════════════════════
// 🖥️ Module: VirtualScroll
// 대용량 텍스트를 스크롤 위치 기반으로 가변 렌더링
// main.js보다 먼저 로드되어도 독립 동작 보장
// ══════════════════════════════════════════
/* global createVirtualScroll */
// createVirtualScroll은 main.js에 정의됨. 없을 경우 아래 폴백 사용.
if(typeof createVirtualScroll==='undefined'){
  // eslint-disable-next-line no-global-assign, no-unused-vars
  window.createVirtualScroll=function createVirtualScroll(container, lines, lineHeight=18, visibleBuffer=60){
    if(!lines||!lines.length) return {destroy:()=>{}};

    const ITEM_H=lineHeight;
    const totalH=lines.length*ITEM_H;
    const VIEW_H=320;

    container.style.cssText='position:relative;overflow-y:auto;height:'+VIEW_H+'px';

    // ① 전체 높이 더미 spacer (스크롤바 크기 결정)
    const spacer=document.createElement('div');
    spacer.style.cssText='position:absolute;top:0;left:0;width:1px;height:'+totalH+'px;pointer-events:none';
    container.appendChild(spacer);

    // ② 실제 텍스트 렌더링 pre (절대 위치)
    const content=document.createElement('pre');
    content.className='toc-raw';
    content.style.cssText='position:absolute;top:0;left:0;right:0;margin:0;white-space:pre;font-size:11px;font-family:monospace';
    container.appendChild(content);

    let lastStart=-1, rafId=null;

    function render(){
      rafId=null;
      const scrollTop=container.scrollTop;
      const start=Math.max(0,Math.floor(scrollTop/ITEM_H)-visibleBuffer);
      const end  =Math.min(lines.length,Math.ceil((scrollTop+VIEW_H)/ITEM_H)+visibleBuffer);
      if(start===lastStart) return;
      lastStart=start;
      content.style.top=(start*ITEM_H)+'px';
      content.textContent=lines.slice(start,end)
        .map((l,i)=>String(start+i+1).padStart(5,' ')+' │ '+l)
        .join('\n');
    }

    function onScroll(){
      if(rafId) return;
      rafId=requestAnimationFrame(render);
    }

    container.addEventListener('scroll',onScroll,{passive:true});
    render();
    return {
      destroy(){
        container.removeEventListener('scroll',onScroll);
        if(rafId) cancelAnimationFrame(rafId);
      }
    };
  };
}


const PATS=[
  // ── 최우선: 명확한 형식 ──
  [/^\[(?:EP|Ep|ep)\.\d+\](?:\s*.+)?$/,               '[EP.N] 형식'],
  [/^\[(?:Prologue|Epilogue|Side|Extra|프롤로그|에필로그|외전)(?:\s*.+)?\](?:\s*.+)?$/i, '[Prologue] 형식'],
  [/^\[\s*.+\.txt\s*\]\s*$/i,                         '[ 파일명.txt ] 형식'],
  [/^\d{3,6}\s{2,}.+$/,                               'NNN  제목 형식 (zero-pad)'],
  [/^[〈<]\s*\d+\s*화\s*[〉>](?:\s*.+)?$/i,           '〈N화〉 꺽쇠 형식'],

  // ── 화/장 번호 계열 (요구사항 핵심) ──
  // 제 n 화 / 제n화 / 제 n화 (공백 유연)
  [/^제\s*\d+\s*화(?:\s*.+)?$/,                       '제N화 형식'],
  // 제 n 장 / 제n장
  [/^제\s*\d+\s*장(?:\s*.+)?$/,                       '제N장 형식'],
  // 한자 번호 대응: 제一화, 第一章 등
  [/^제\s*[一二三四五六七八九十百千\d]+\s*[화장話章](?:\s*.+)?$/, '제N화/장 (한자 번호)'],
  // n화 단독 (앞에 '제' 없이)
  [/^\d+화(?:\s*.+)?$/,                               'N화 형식'],
  // n장 단독
  [/^\d+장(?:\s*.+)?$/,                               'N장 형식'],
  // [제 n화] / [1화] 대괄호 패턴
  [/^\[\s*제?\s*\d+\s*화\s*\](?:\s*.+)?$/,            '[N화] 대괄호 형식'],
  [/^\[\s*제?\s*\d+\s*장\s*\](?:\s*.+)?$/,            '[N장] 대괄호 형식'],
  [/^#?(?:제\s*)?\d+\s*화(?:\s*.+)?$/i,               '화 번호 (#N화 포함)'],
  [/^\d+화\.\s*.+$/,                                  '화. 제목 (리디북스형)'],
  [/^={2,}\s*\[제\s*\d+\s*화\]\s*={0,}$/i,            '=== [제N화] ==='],

  // ── 챕터/파트 계열 ──
  [/^(?:chapter|part|ch)\.?\s*\d+(?:\s*.+)?$/i,       'Chapter/Part'],
  [/^(?:EP|Ch|Scene|Act)\.?\s*\d+(?:\s*.+)?$/i,       'EP/Ch/Scene N'],
  [/^[1-9]부\s+(?:\d+화|프롤로그)(?:\s*.+)?$/,         'N부 M화'],
  [/^S\d+E\d+(?:\s*.+)?$/i,                           'S1E01 형식'],

  // ── 특수 키워드 (요구사항 핵심) ──
  [/^서장(?:\s*.+)?$/,                                 '서장'],
  [/^종장(?:\s*.+)?$/,                                 '종장'],
  [/^서문(?:\s*.+)?$/,                                 '서문'],
  [/^서론(?:\s*.+)?$/,                                 '서론'],
  [/^(?:프롤로그|프롤)(?:\s*.+)?$/i,                   '프롤로그'],
  [/^(?:에필로그|에필)(?:\s*.+)?$/i,                   '에필로그'],
  [/^외전(?:\s*.+)?$/,                                 '외전'],
  [/^번외(?:\s*.+)?$/,                                 '번외'],
  [/^후기(?:\s*.+)?$/,                                 '후기'],
  [/^작가\s*후기(?:\s*.+)?$/,                          '작가 후기'],
  [/^작가의\s*말(?:\s*.+)?$/,                          '작가의 말'],
  [/^작가\s*노트(?:\s*.+)?$/,                          '작가 노트'],
  [/^(?:prologue|epilogue|afterword|author.?s?\s*note)(?:\s*.+)?$/i, '영문 특수 키워드'],

  // ── 숫자+점 형식 (1. 제목, 2. 제목) ──
  [/^\d+\.\s+.{1,60}$/,                               'N. 제목'],
  [/^#\d+\.\s+.{1,60}$/,                              '#N. 제목'],

  // ── 제목 형식 ──
  [/^.{1,60}\s*\(\d+\)\s*$/,                          '소설제목(숫자)'],
  [/^(?:제\s*\d+\s*장|第\s*\d+\s*章)(?:\s*.+)?$/,     '장 번호'],
  [/^【.+】.*$/,                                       '타이틀【】'],
  [/^#{1,3}\s*.+$/,                                   '# 제목 (Markdown)'],
  [/^[■▶◆●►▷◇★☆]\s*.{2,40}$/,                        '특수문자 제목'],
  [/^第\s*[\d一二三四五六七八九十百千]+\s*[章話话](?:\s*.+)?$/, '한자 장/화 형식'],

  // ── 기타 형식 ──
  [/^(?:EP|제|Chapter|Ch|디|Scene|Prologue)\.?\s*\d+/i,'EP/Ch/Scene N 시작'],
  [/^\d{1,3}\.\s*.+$/,                                'N. 제목 (짧은 번호)'],
  [/^\d+권(?:\s*.+)?$/,                               'N권 형식'],
  [/^.*[=\-]{3,}$/,                                   '제목+구분선(===,--)'],
  [/^[\*\-─]+\s*\d+화?\s*[\*\-─]+$/,                 '* N * 구분자'],
  [/^(?:시즌\s*\d+\s+)?\d+화(?:\s*.+)?$/,             '시즌 N화'],
  [/^\((?:외전|번외|특별편|side|bonus)\)/i,            '(외전/번외) 형식'],
  [/^(?:\s?〈\s?\d+화\s?〉|EP\.\d+|(?=\d+화)\d+화|\d+).*/, '줄 시작 통합 (꺽쇠/EP/숫자)'],
];

// N. 제목 패턴: 줄 간격 필터 포함 (본문 내 번호 목록과 구별)
// 앞뒤 줄 간격이 모두 minGap 이상인 것만 챕터로 인정
function checkTitleWaPattern(lines, minGap=50){
  const rx=/^.{2,15}\s+\d+화$/;
  const matched=[];
  const positions=[];
  lines.forEach((l,i)=>{if(l.trim()&&rx.test(l.trim())){matched.push({i,t:l.trim()});positions.push(i);}});
  if(matched.length<3) return {cnt:0,rx:null};
  const real=matched.filter(({i},j)=>{
    const pg=i-((positions[j-1]!=null?positions[j-1]:-999));
    const ng=((positions[j+1]!=null?positions[j+1]:i+999))-i;
    return Math.min(pg,ng)>=minGap;
  });
  if(real.length<3) return {cnt:0,rx:null};
  return {cnt:real.length, rx:/^.{2,15}\s+\d+화$/};
}

function checkNDotPattern(lines, minGap=50){
  const rx=/^\d+\.\s+.{1,60}$/;
  const matched=[];
  const positions=[];
  lines.forEach((l,i)=>{if(l.trim()&&rx.test(l.trim())){matched.push({i,t:l.trim()});positions.push(i);}});
  if(matched.length<3) return {cnt:0,rx:null};
  const real=matched.filter(({i},j)=>{
    const pg=i-((positions[j-1]!=null?positions[j-1]:-999));
    const ng=((positions[j+1]!=null?positions[j+1]:i+999))-i;
    return Math.min(pg,ng)>=minGap;
  });
  if(real.length<3) return {cnt:0,rx:null};
  const firstNum=parseInt(real[0].t.match(/^(\d+)\./)[1]);
  if(firstNum>5) return {cnt:0,rx:null};
  return {cnt:real.length, rx:/^\d+\.\s+.{1,60}$/};
}

// ─────────────────────────────────────────
// 특수 키워드 우선순위 그룹 (별도 관리)
// 에필로그·외전·작가 후기 등은 패턴 감지 여부와 무관하게 항상 목차로 인식
// ─────────────────────────────────────────
const KEYWORD_PATS=[
  /^(?:프롤로그|프롤)(?:\s*.+)?$/i,
  /^(?:에필로그|에필)(?:\s*.+)?$/i,
  /^외전(?:\s*.+)?$/,
  /^번외(?:\s*.+)?$/,
  /^후기(?:\s*.+)?$/,
  /^작가\s*후기(?:\s*.+)?$/,
  /^작가의\s*말(?:\s*.+)?$/,
  /^작가\s*노트(?:\s*.+)?$/,
  /^(?:side\s*story|side\s*episode|special\s*episode)(?:\s*.+)?$/i,
  /^(?:prologue|epilogue|afterword|author.?s?\s*note)(?:\s*.+)?$/i,
  /^서장(?:\s*.+)?$/,
  /^종장(?:\s*.+)?$/,
  /^서문(?:\s*.+)?$/,
];

/**
 * bestPat — 고도화된 패턴 선택 엔진
 * 
 * 개선 사항:
 * 1. 패턴 지배도 검사: 한 패턴이 전체의 75% 이상이면 단독 우선 선택
 * 2. 위치 기반 가중치: 하위 10% 구간의 짧은 숫자 매칭은 가중치 0
 * 3. 키워드 우선순위 그룹: 에필로그·외전 등은 수량 무관 항상 포함
 * 4. 지배 패턴이 없으면 혼합(OR) 결합
 */
// ─────────────────────────────────────────────────
// 전처리: 줄 앞뒤 특수문자·과도한 공백 제거 후 정규식 검사
// ─────────────────────────────────────────────────
function preprocessLine(raw){
  return raw
    .trim()
    // 앞뒤 대괄호 [ ] ( ) 제거 (내용은 보존)
    .replace(/^[\[\(\-\s]+/, '')
    .replace(/[\]\)\-\s]+$/, '')
    // 내부 연속 공백 정규화
    .replace(/\s{2,}/g, ' ')
    .trim();
}

// ─────────────────────────────────────────────────
// 연속성 체크: 숫자 시퀀스 가중치
// matched = [{line, num}] 배열에서 n→n+1 연속성 비율 계산
// ─────────────────────────────────────────────────
function calcSequenceWeight(matchedNums){
  if(matchedNums.length<2) return 0;
  let consecutive=0;
  for(let i=1;i<matchedNums.length;i++){
    const prev=matchedNums[i-1], cur=matchedNums[i];
    if(prev!=null&&cur!=null&&(cur===prev+1||cur===prev)) consecutive++;
  }
  return consecutive/(matchedNums.length-1); // 0.0~1.0
}

function bestPat(raw){
  const lines=raw.split('\n');
  const totalLines=lines.length;
  const tailStart=Math.floor(totalLines*0.90);
  let best=null,bestScore=0,bestName='';
  const mixed=[];

  // 빈 줄에 둘러싸인 줄 집합
  const blankWrapped=new Set();
  for(let i=1;i<lines.length-1;i++){
    const prevB=!lines[i-1].trim(), nextB=!lines[i+1].trim();
    const prev2B=i>=2&&!lines[i-2].trim(), next2B=i+2<lines.length&&!lines[i+2].trim();
    if(lines[i].trim()&&(prevB||prev2B)&&(nextB||next2B)) blankWrapped.add(i);
  }

  for(const[rx,name]of PATS){
    const matchedIdxs=[];
    const matchedNums=[];
    for(let i=0;i<lines.length;i++){
      // ★ 전처리 후 패턴 검사
      const t=preprocessLine(lines[i]);
      if(!t) continue;
      if(rx.test(t)){
        matchedIdxs.push(i);
        // ★ 숫자 추출 (연속성 체크용)
        const nm=t.match(/\d+/);
        matchedNums.push(nm?parseInt(nm[0]):null);
      }
    }
    const cnt=matchedIdxs.length;
    if(cnt<3) continue;

    const isNumOnly=rx.source==='^\\d+$';
    let score=matchedIdxs.reduce((acc,i)=>{
      if(i>=tailStart&&isNumOnly) return acc;
      const w=blankWrapped.has(i)?3:1;
      return acc+w;
    },0);
    if(score===0) continue;

    // ★ 연속성 가중치: n→n+1 비율이 0.6 이상이면 점수 50% 보너스
    const seqW=calcSequenceWeight(matchedNums);
    if(seqW>=0.6) score=Math.round(score*(1+seqW*0.5));

    mixed.push({rx,name,cnt,score,seqW});
    if(score>bestScore){bestScore=score;best=rx;bestName=name;}
  }

  const dynGap=Math.max(30,Math.min(200,Math.floor(totalLines/50)));

  const nDot=checkNDotPattern(lines,dynGap);
  if(nDot.cnt>0&&nDot.cnt*3>=bestScore){
    if(nDot.cnt*3>bestScore){bestScore=nDot.cnt*3;best=nDot.rx;bestName='N. 제목';}
    mixed.push({rx:nDot.rx,name:'N. 제목',cnt:nDot.cnt,score:nDot.cnt*3});
  }
  const titleWa=checkTitleWaPattern(lines,dynGap);
  if(titleWa.cnt>0&&titleWa.cnt*3>=bestScore){
    if(titleWa.cnt*3>bestScore){bestScore=titleWa.cnt*3;best=titleWa.rx;bestName='소설명+N화';}
    mixed.push({rx:titleWa.rx,name:'소설명+N화',cnt:titleWa.cnt,score:titleWa.cnt*3});
  }
  if(bestScore<3){
    const fb=/^\d+$/;
    const validCnt=lines.filter((l,i)=>i<tailStart&&preprocessLine(l)&&fb.test(preprocessLine(l))).length;
    if(validCnt>=3){bestScore=validCnt;best=fb;bestName='숫자만';}
  }

  // 패턴 지배도 검사 — 75% 이상이면 단독 선택
  if(mixed.length>1){
    const totalMatches=mixed.reduce((s,m)=>s+m.cnt,0);
    const dominant=mixed.find(m=>m.cnt/totalMatches>=0.75);
    if(dominant){
      return {rx:dominant.rx,name:dominant.name+'[지배적]',cnt:dominant.cnt,dominance:true};
    }
  }

  // 혼합 패턴 결합
  const seen=new Set();
  const uniq=mixed.filter(m=>{
    if(seen.has(m.rx.source)) return false;
    seen.add(m.rx.source); return true;
  });
  if(uniq.length>1){
    const combined=new RegExp('(?:'+uniq.map(m=>m.rx.source).join('|')+')','i');
    const uniqueMatches=[...new Set(lines.filter(l=>preprocessLine(l)&&combined.test(preprocessLine(l))).map(l=>preprocessLine(l)))];
    if(uniqueMatches.length>bestScore){
      return {rx:combined,name:'혼합('+uniq.map(m=>m.name).join('+')+')[자동]',cnt:uniqueMatches.length,isMixed:true,mixedParts:uniq};
    }
  }
  return {rx:best,name:bestName,cnt:bestScore};
}

// splitChapters: 동기 함수. 대용량은 splitChaptersAsync 권장
function splitChapters(raw, customPat, opts={}){
  const {mergeShortLines=false}=opts;

  // ── 입력 텍스트 정규화 ──
  raw=raw
    .replace(/\r\n/g,'\n')
    .replace(/\r/g,'\n')
    .replace(/\xad/g,'\u2014')
    .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F]/g,'')
    .replace(/[\uFFFE\uFFFF]/g,'');

  // ★ 지능형 문단 정합: 짧은 줄(30자 미만)이 연속 4개 이상이면 합산
  if(mergeShortLines){
    const rawLines=raw.split('\n');
    const merged=[];
    let buf='';
    for(let i=0;i<rawLines.length;i++){
      const t=rawLines[i];
      if(t.trim()&&t.trim().length<30&&!t.trim().match(/^[\-=*─]{3,}$/)){
        buf+=(buf?' ':'')+t.trim();
        // 다음 줄이 비어있거나 긴 줄이면 flush
        if(!rawLines[i+1]?.trim()||rawLines[i+1].trim().length>=30){
          merged.push(buf); buf='';
        }
      } else {
        if(buf){merged.push(buf);buf='';}
        merged.push(t);
      }
    }
    if(buf) merged.push(buf);
    raw=merged.join('\n');
  }

  // ── 패턴 결정 ──
  let rx=null;
  // 사용자 정의 패턴 우선
  if(customPat&&customPat.trim()){
    try{rx=new RegExp(customPat.trim(),'i');}catch(e){rx=null;}
  }
  if(!rx){const r=bestPat(raw);rx=r.rx;}

  // ★ 키워드 우선순위 그룹을 기본 패턴에 OR 결합
  // KEYWORD_PATS는 수량 무관 항상 목차로 인식
  // ★ L-15 FIX: rx=null (패턴 감지 실패) 시에도 KEYWORD_PATS 단독으로 사용
  if(KEYWORD_PATS && KEYWORD_PATS.length){
    const kwSrc=KEYWORD_PATS.map(k=>k.source).join('|');
    if(rx){
      try{ rx=new RegExp('(?:'+rx.source+'|'+kwSrc+')','i'); }catch(e){}
    } else {
      try{ rx=new RegExp(kwSrc,'i'); }catch(e){}
    }
  }
  // ★ LOGIC-04: 정규식은 루프 전 1회만 컴파일됨 (rx가 최종 컴파일된 RegExp 객체)

  // ── 패턴 없음 폴백: 페이지 분할 ──
  if(!rx){
    const rawLines=raw.split('\n');
    const totalLines=rawLines.length;
    const PAGE_LINES=Math.max(200,Math.min(500,Math.floor(totalLines/20)));
    const chapters=[];
    for(let i=0;i<totalLines;i+=PAGE_LINES){
      const slice=rawLines.slice(i,i+PAGE_LINES).join('\n').trim();
      if(!slice) continue;
      const pageNum=Math.floor(i/PAGE_LINES)+1;
      const totalPages=Math.ceil(totalLines/PAGE_LINES);
      chapters.push([pageNum===1&&totalPages===1?'본문':`(${pageNum}/${totalPages})`,slice]);
    }
    return chapters.length?chapters:[['본문',raw.trim()]];
  }

  const rawLines=raw.split('\n');
  const chapters=[];
  let cur=null, body=[];
  const seenHeadings=new Map();
  const sepRx=/^[-=*─━~·.‒—]{3,}\s*$|^[─━═]{2,}$/;

  for(let li=0;li<rawLines.length;li++){
    const line=rawLines[li];
    // ★ 전처리 후 패턴 검사 (원본 줄은 body에 보존)
    const t=preprocessLine(line);

    if(t&&rx.test(t)){
      // 중복 제목 → (2),(3)... 접미사
      const prevCount=seenHeadings.get(t)||0;
      seenHeadings.set(t,prevCount+1);
      const uniqueTitle=prevCount===0?t:`${t} (${prevCount+1})`;

      while(body.length&&(sepRx.test(body[body.length-1].trim())||body[body.length-1].trim()==='')) body.pop();
      if(cur===null&&body.length>0) chapters.push(['서문',body.join('\n').trim()]);
      else if(cur!==null) chapters.push([cur,body.join('\n').trim()]);
      cur=uniqueTitle; body=[];
      // 챕터 헤더 직후 구분선 스킵
      let ni=li+1;
      while(ni<rawLines.length&&sepRx.test(rawLines[ni].trim())) ni++;
      if(ni>li+1) li=ni-1;
    } else {
      body.push(line);
    }
  }
  if(cur!==null) chapters.push([cur,body.join('\n').trim()]);
  else if(body.length>0) chapters.push(['본문',body.join('\n').trim()]);

  // ★ 메모리 정리: 대용량 raw 문자열 참조 해제 유도
  raw=null;

  return chapters.length?chapters:[['본문','']];
}

function extractChNum(h){
  // [ 0002_1화. 제목.txt ] 형태 — 대괄호 안 숫자 추출
  let m=h.match(/^\[\s*\d*_?(\d+)\s*화/i);if(m)return parseInt(m[1]);
  m=h.match(/\((\d+)\)/);if(m)return parseInt(m[1]);
  m=h.match(/(\d+)\s*화/);if(m)return parseInt(m[1]);
  m=h.match(/^(\d+)$/);if(m)return parseInt(m[1]);
  m=h.match(/(?:chapter|part|ch)\s*(\d+)/i);if(m)return parseInt(m[1]);
  // [ 0002_제목.txt ] — 앞자리 0 패딩 숫자
  m=h.match(/^\[\s*0*(\d+)[_\s]/);if(m)return parseInt(m[1]);
  return null;
}

// ══════════════════════════════════════════
function escAttr(s){return s.replace(/'/g,"\\'").replace(/"/g,'&quot;');}

// 챕터 목록 캐시 (변환 전 빠른 미리보기용)
let _chaptersCache=null, _chaptersCacheKey='';
let _autoSplitLines=null; // 간격 분할 시 원문 줄 배열
// ★ L-09: 동시 다중 호출 방지 — 계산 중인 Promise 재사용
let _chaptersComputePromise=null;
function buildChaptersFromTocItems(lines, tocItems){
  // ★ enabled:true인 항목만 — UI 편집 결과 그대로 반영
  const enabled=tocItems.filter(t=>t.enabled);
  if(!enabled.length){
    // 전체 비활성화 → 전체 텍스트 단일 챕터
    return [['본문', lines.join('\n').trim()]];
  }

  const totalLines=lines.length;
  // ★ 라인 범위 검증: item.line이 실제 lines 배열 안에 있는지 확인
  const validEnabled=enabled.filter(item=>
    item.line!=null && item.line>=1 && item.line<=totalLines
  );
  if(!validEnabled.length){
    return [['본문', lines.join('\n').trim()]];
  }

  const chapters=[];

  // ★ L-02 FIX: 서문 삽입을 루프 시작 전에 처리 — autoSplit 첫 챕터와 범위 중복 방지
  // autoSplit=true 이면 headLine 자체가 본문에 포함되므로 서문 end = headLine(not headLine+1)
  const firstItem=validEnabled[0];
  const firstHeadLine=firstItem.line-1; // 0-based
  if(firstHeadLine>0){
    // autoSplit=false: 첫 챕터 헤딩줄(firstHeadLine)은 제목으로 소비되므로 서문은 0..firstHeadLine-1
    // autoSplit=true : 첫 챕터가 headLine부터 시작하므로 서문은 0..firstHeadLine-1
    const preamble=lines.slice(0, firstHeadLine).join('\n').trim();
    if(preamble) chapters.push(['서문', preamble]);
  }

  for(let i=0;i<validEnabled.length;i++){
    const item=validEnabled[i];
    const headLine=item.line-1; // 0-based
    const nextLine=i+1<validEnabled.length
      ? Math.min(validEnabled[i+1].line-1, totalLines)
      : totalLines;

    let bodyLines;
    if(item.autoSplit){
      // 간격 분할: headLine 포함 (원본 텍스트 유실 방지)
      bodyLines=lines.slice(headLine, nextLine);
    } else {
      // 일반 패턴: 헤딩 줄 제외
      bodyLines=lines.slice(headLine+1, nextLine);
    }
    // ★ 빈 챕터 필터링: 공백/빈줄만 있는 챕터 제외
    const bodyText=bodyLines.join('\n').trim();
    if(!bodyText) continue; // 빈 챕터 건너뜀
    chapters.push([item.title, bodyText]);
  }

  return chapters;
}

async function getCachedChapters(){
  if(!S.txtFiles.length) return [];

  // ★ tocItems가 있으면 항상 tocItems 기반 챕터 조립 (_autoSplitActive 무관)
  if(S.tocItems.length>0){
    const sourceLines=_autoSplitActive&&_autoSplitLines
      ? _autoSplitLines
      : (_fullRawLines&&_fullRawLines.length>0 ? _fullRawLines : null);
    if(sourceLines) return buildChaptersFromTocItems(sourceLines, S.tocItems);
  }

  // tocItems 없거나 sourceLines 없음 → 원본 텍스트 파싱 (캐시 사용)
  // ★ 캐시 키 정교화: 파일명+크기+최종수정시간+패턴+설정 해시
  const pat=document.getElementById('pattern')?.value.trim()||'';
  const optItalic = document.getElementById('optItalic')?.checked??true;
  const optMerge  = document.getElementById('optMergeShortLines')?.checked??false;
  const settingHash = `${optItalic}:${optMerge}`;
  const fileHash = S.txtFiles
    .map(f=>`${f.name}:${f.size}:${f.lastModified||0}`)
    .join('|');
  const cacheKey = `${fileHash}§${pat}§${settingHash}`;

  if(_chaptersCache && _chaptersCacheKey===cacheKey) return _chaptersCache;

  // ★ L-09 FIX: 동시 다중 호출 시 동일 Promise 재사용 → 중복 fileToText 방지
  if(_chaptersComputePromise) return _chaptersComputePromise;

  _chaptersComputePromise = (async()=>{
    try{
      const sorted=[...S.txtFiles];
      const raws=await Promise.all(sorted.map(fileToText));
      const raw=raws.join('\n\n');
      await yieldToMain();
      _chaptersCache=splitChapters(raw,pat,{mergeShortLines:optMerge});
      _chaptersCacheKey=cacheKey;
    }catch(e){
      _chaptersCache=[];
    }
    return _chaptersCache||[];
  })().finally(()=>{ _chaptersComputePromise=null; });

  return _chaptersComputePromise;
}


// ══════════════════════════════════════════
// 📋 Module: TocPreview (목차 감지·미리보기·드래그)
// ══════════════════════════════════════════
async function previewToc(){
  if(!S.txtFiles.length){Toast.warn('TXT 파일을 먼저 선택해주세요.');return;}

  // 정규식 패턴 모드로 전환 시 간격 분할 모드 해제
  _autoSplitActive=false;
  _autoSplitLines=null;

  // 전체 파일 텍스트 로드 (다중 파일 모두 합산)
  let text;
  try{
    const sorted=[...S.txtFiles]; // 사용자 정렬 순서 유지 (renderTxtFileList에서 이미 정렬됨)
    const raws=await Promise.all(sorted.map(f=>fileToText(f).catch(()=>sampleLines(f))));
    text=raws.join('\n\n');
  }catch(e){
    text=await sampleLines(S.txtFiles[0]).catch(()=>'');
  }
  _fullRawLines=text.split('\n');

  const pat=(document.getElementById('pattern')?.value||'').trim();
  let found=[],patLabel='';
  if(pat){
    try{
      const rx=new RegExp(pat,'i');
      S._detectedPat=rx;S._detectedName='입력';
      _fullRawLines.forEach((l,i)=>{if(l.trim()&&rx.test(l.trim()))found.push({line:i+1,title:l.trim()});});
      patLabel='입력 패턴: '+pat+' ('+found.length+'개 매칭)';
    }catch(e){patLabel='⚠️ 정규식 오류: '+e.message;}
  }else{
    const{rx,name,cnt,isMixed}=bestPat(text);
    patLabel='자동 선택: '+name+' ('+cnt+'개 매칭)'+(isMixed?' ⚠️ 혼합 패턴':'');
    if(rx){
      S._detectedPat=rx;S._detectedName=name;
      _fullRawLines.forEach((l,i)=>{if(l.trim()&&rx.test(l.trim()))found.push({line:i+1,title:l.trim()});});
    }else{
      S._detectedPat=null;S._detectedName='';
    }
  }

  // ★ I1+B2+B5: tocItems에 body 직접 저장 — 드래그 재정렬/병합 후에도 정확한 글자수 보장
  found = found.map((f, fi) => {
    const nextLine = found[fi+1] ? found[fi+1].line - 1 : _fullRawLines.length;
    const bodyText = _fullRawLines.slice(f.line, nextLine).join('\n').trimEnd();
    const bodyLen  = bodyText.replace(/\s/g, '').length;
    return {
      ...f,
      enabled:       true,
      body:          bodyText,
      bodyLen:       bodyLen,
      suspicious:    bodyLen < getSuspThreshold() && fi < found.length - 1,
      originalTitle: f.title,
    };
  });

  // ★ I9: 재감지 전 통계 저장 (delta 비교용)
  const _prevTotal = S.tocItems.length;
  const _prevChars = S.tocItems.reduce((s,t)=>s+(typeof t.bodyLen==='number'?t.bodyLen:(t.body||'').replace(/\s/g,'').length),0);

  S.tocItems=found;
  renderTocItems();
  updateTocEditBanner&&updateTocEditBanner(); // ★ 편집 배너 초기화

  // ★ I9: delta 표시 (이전 목차가 있었을 때만)
  if(_prevTotal > 0 && (found.length !== _prevTotal || Math.abs(_prevChars - found.reduce((s,t)=>s+t.bodyLen,0)) > 100)){
    const newChars = found.reduce((s,t)=>s+t.bodyLen,0);
    const dN = found.length - _prevTotal;
    const dC = ((newChars - _prevChars)/10000).toFixed(1);
    const dNStr = (dN>0?'+':'')+dN+'챕터';
    const dCStr = (parseFloat(dC)>0?'+':'')+dC+'만자';
    const col = dN>=0?'var(--green)':'var(--accent)';
    Toast.info(`재감지 완료 — <span style="color:${col};font-weight:600">${dNStr}</span>, <span style="color:${col};font-weight:600">${dCStr}</span>`, 4000);
  }

  // ★ I8: 연속 짧은 챕터 자동 병합 제안
  const _suspItems = found.filter(t=>t.suspicious);
  if(_suspItems.length >= 3){
    // 연속 구간 찾기
    const _suspIdxs = found.reduce((arr,t,i)=>{if(t.suspicious)arr.push(i);return arr;},[]);
    let maxRun=1, run=1;
    for(let k=1;k<_suspIdxs.length;k++){
      if(_suspIdxs[k]===_suspIdxs[k-1]+1) run++;
      else run=1;
      maxRun=Math.max(maxRun,run);
    }
    if(maxRun>=3){
      Toast.warn(
        `짧은 챕터 ${_suspItems.length}개 중 ${maxRun}개가 연속돼 있어요. 이전 챕터에 병합하거나 전체 제거를 권장해요.`,
        6000
      );
    }
  }

  // ★ I5: updateTocStat의 짧은챕터 칩 클릭 → 해당 항목 스크롤
  // ★ L-12 FIX: setTimeout(100) → double rAF — 저사양 기기 DOM 생성 전 바인딩 방지
  requestAnimationFrame(()=>requestAnimationFrame(()=>{
    document.querySelectorAll('#toc-stat [data-filter-short]').forEach(btn=>{
      btn.addEventListener('click',()=>{
        const firstSusp=document.querySelector('.toc-item .toc-char-badge[data-short]');
        firstSusp?.closest('.toc-item')?.scrollIntoView({block:'center',behavior:'smooth'});
      });
    });
  }));

  // 감지 실패 시 안내 메시지 (변환은 정상 작동)
  if(!found.length){
    const c=document.getElementById('tb0');
    c.insertAdjacentHTML('beforeend',
      '<div style="margin-top:12px;padding:12px;background:var(--blue-bg);border-radius:8px;border:1.5px solid var(--blue)">'+
      '<div style="font-size:12px;font-weight:600;color:var(--blue);margin-bottom:6px">ℹ️ 챕터 패턴을 감지하지 못했어요</div>'+
      '<div style="font-size:11px;color:var(--text2);line-height:1.7">'+
        '하지만 <b>텍스트 전체는 그대로 EPUB에 포함</b>돼요.<br>'+
        '목차 없이 변환하면 일정 줄 수 단위로 자동 페이지 분할해 저장해요.<br>'+
        '목차 이동이 필요하면 아래에서 패턴을 직접 입력하거나 간격 분할을 사용하세요.'+
      '</div>'+
      '<div style="display:flex;gap:8px;margin-top:8px">'+
        '<button class="btn btn-ghost btn-sm" data-action="tocTab" data-idx="3">✏️ 패턴 직접 입력</button>'+
        '<button class="btn btn-blue btn-sm" data-action="autoSplitByInterval">⚡ 간격 분할</button>'+
      '</div>'+
      '</div>'
    );
  }

  // ★ 가상 스크롤: 스크롤 위치 기반 가변 렌더링 (고도화)
  // ★ 수정: rawLines → _fullRawLines (previewToc 함수 내 전역변수 참조)
  const tb2=document.getElementById('tb2');
  if(tb2){
    // ★ L-18 FIX: 이전 인스턴스 destroy 후 재생성 — scroll 이벤트 리스너 누적 방지
    _vsInstTb2?.destroy(); _vsInstTb2=null;
    tb2.innerHTML='';
    if(typeof createVirtualScroll==='function'){
      _vsInstTb2=createVirtualScroll(tb2, _fullRawLines);
    } else {
      // createVirtualScroll 미로드 시 폴백 (최초 2000줄)
      const pre=document.createElement('pre');
      pre.className='toc-raw';
      pre.textContent=_fullRawLines.slice(0,2000).map((l,i)=>String(i+1).padStart(5,' ')+' │ '+l).join('\n');
      tb2.appendChild(pre);
      if(_fullRawLines.length>2000){
        const btn=document.createElement('button');
        btn.className='btn btn-ghost btn-sm';
        btn.style.cssText='margin:8px 0;width:100%;font-size:11px';
        btn.textContent=`▼ 나머지 ${(_fullRawLines.length-2000).toLocaleString()}줄 더 보기`;
        btn.onclick=()=>{
          pre.textContent=_fullRawLines.map((l,i)=>String(i+1).padStart(5,' ')+' │ '+l).join('\n');
          btn.remove();
        };
        tb2.appendChild(btn);
      }
    }
  }
  document.getElementById('patEdit')?.value !== undefined && (document.getElementById('patEdit').value=pat);
  S._rawTextFull=_fullRawLines;
  document.getElementById('tocPanel')?.classList.add('show');
  tocTab(0);
  document.getElementById('tb0')?.insertAdjacentHTML('afterbegin','<div style="font-size:11px;color:var(--text2);margin-bottom:8px;padding:0 4px">'+patLabel+'</div>');
  refreshDetectedChip();
  const splitBtn=document.querySelector('button[data-action="autoSplitByInterval"]');
  if(splitBtn){
    if(found.length>0){splitBtn.style.opacity='0.4';splitBtn.title='패턴 자동 감지 성공 — 간격 분할 불필요';}
    else{splitBtn.style.opacity='1';splitBtn.style.color='var(--blue)';splitBtn.title='패턴 감지 실패 — 줄 간격으로 자동 분할';}
  }

  // ── 본문 짧음 감지 Toast 알림 ──
  const suspCount=found.filter(t=>t.suspicious).length;
  if(suspCount>0){
    showSuspiciousToast(suspCount);
  }
}

// 본문 짧음 Toast 알림 (목차 확인 완료 후 호출)
function showSuspiciousToast(count){
  // 기존 suspicious toast 제거
  document.getElementById('susp-toast')?.remove();

  const el=document.createElement('div');
  el.id='susp-toast';
  el.style.cssText=
    'position:fixed;bottom:80px;left:50%;transform:translateX(-50%);z-index:9000;'+
    'background:var(--panel);border:1.5px solid var(--accent2);border-radius:12px;'+
    'padding:12px 18px;display:flex;align-items:center;gap:12px;'+
    'box-shadow:0 4px 24px rgba(0,0,0,.18);font-family:inherit;'+
    'animation:toastIn .25s ease;max-width:420px;width:90vw';
  el.innerHTML=
    '<span style="font-size:18px;flex-shrink:0">⚠️</span>'+
    '<div style="flex:1;min-width:0">'+
      '<div style="font-size:12px;font-weight:700;color:var(--text);margin-bottom:3px">'+
        '본문 짧음 챕터 <span id="susp-toast-count">'+count+'</span>개 감지</div>'+
      '<div style="font-size:11px;color:var(--text2);line-height:1.5">'+
        '⤵ 병합 버튼으로 다음 챕터와 합치거나 전체 제거할 수 있어요.'+
      '</div>'+
    '</div>'+
    '<div style="display:flex;flex-direction:column;gap:5px;flex-shrink:0">'+
      '<button id="susp-remove-all-btn" class="btn btn-sm" '+
        'style="font-size:11px;background:var(--accent);color:#fff;border-radius:7px;padding:5px 10px;white-space:nowrap">'+
        '전체 병합</button>'+
      '<button id="susp-toast-close" class="btn btn-ghost btn-sm" '+
        'style="font-size:11px;border-radius:7px;padding:4px 10px">'+
        '닫기</button>'+
    '</div>';

  document.body.appendChild(el);

  // 전체 병합 버튼 — suspicious 항목을 각각 다음 챕터와 병합
  el.querySelector('#susp-remove-all-btn').addEventListener('click', ()=>{
    _saveTocSnapshot();
    let mergedCount=0;
    // 뒤에서부터 순회해야 인덱스 밀림 없음
    for(let i=S.tocItems.length-1; i>=0; i--){
      const t=S.tocItems[i];
      if(!t.suspicious) continue;
      if(i+1 < S.tocItems.length){
        const next=S.tocItems[i+1];
        const mergedBody=(t.body||'')+'\n'+(next.body||'');
        S.tocItems[i]={
          ...t,
          body: mergedBody,
          bodyLen: mergedBody.replace(/\s/g,'').length,
          suspicious: false,
          _isMerged: true,
          _mergedSources:[
            {title:t.title, body:t.body||'', bodyLen:t.bodyLen||0, line:t.line},
            {title:next.title, body:next.body||'', bodyLen:next.bodyLen||0, line:next.line},
          ],
        };
        S.tocItems.splice(i+1,1);
        mergedCount++;
      } else {
        // 마지막 챕터면 suspicious만 해제
        S.tocItems[i].suspicious=false;
      }
    }
    _chaptersCache=null;_chaptersCacheKey='';
    renderTocItems();
    updateTocStat();
    el.remove();
    Toast.success('짧은 챕터 '+mergedCount+'개를 다음 챕터와 병합했어요.');
  });

  // 닫기
  el.querySelector('#susp-toast-close').addEventListener('click', ()=>el.remove());

  // 10초 후 자동 닫기
  setTimeout(()=>el?.remove(), 10000);
}

// ── 목차 Undo 스택 (최대 10개 스냅샷) ──
const _tocUndoStack=[];
const _TOC_UNDO_MAX=10;
// ★ L-06: tocExportBtn 중복 생성 방지 플래그
let _tocExportBtnCreated=false;
function _saveTocSnapshot(){
  // ★ L-20 FIX: body 문자열 제외 → 대용량(3000화+) JSON 직렬화 블로킹 방지
  // bodyLen(숫자)만 저장하고 body는 복원 시 재계산 (Undo 후 updateTocStat로 재집계)
  const slim=(S.tocItems||[]).map(t=>({
    line:          t.line,
    title:         t.title,
    enabled:       t.enabled,
    autoSplit:     t.autoSplit,
    suspicious:    t.suspicious,
    originalTitle: t.originalTitle,
    bodyLen:       typeof t.bodyLen==='number' ? t.bodyLen : 0,
  }));
  _tocUndoStack.push(slim);
  if(_tocUndoStack.length>_TOC_UNDO_MAX) _tocUndoStack.shift();
}
function undoToc(){
  if(_tocUndoStack.length===0){Toast.warn('되돌릴 내역이 없어요.');return;}
  const snap=_tocUndoStack.pop();
  S.tocItems=snap;
  _chaptersCache=null;_chaptersCacheKey='';
  renderTocItems();
  updateTocStat();
  Toast.success('되돌리기 완료 (남은 스냅샷: '+_tocUndoStack.length+'개)');
}

function renderTocItems(){
  // ══════════════════════════════════════════════════════════
  // 🗂 renderTocItems — 목차 병합 UX 전면 개선판
  // 개선 01: 선택 모드 토글 버튼 + 행 호버 퀵 선택 버튼 (발견성)
  // 개선 02: Shift+클릭 범위 선택 (효율)
  // 개선 03: 병합 즉시 제목 편집 + 프리셋 3종 (워크플로)
  // 개선 04: 병합 행에 🔓 분리 버튼 (안전성)
  // 개선 05: 선택 미니맵 + 인덱스 목록 (가시성)
  // 개선 06: ⚠ 짧은챕터 자동 선택 버튼 (자동화)
  // 개선 07: 병합 미리보기 패널 (신뢰성)
  // 개선 08: 검색 필터 중 병합 안전 확인 (안정성)
  // 개선 09: 드래그 중앙 드롭존 = 병합 (직관성)
  // 개선 10: 대량 선택 시 비동기 병합 + 진행 표시 (성능)
  // ══════════════════════════════════════════════════════════
  let _tocDragSrc=null;
  let dragSrcI=null; // ★ BUG-FIX: dragSrcI ReferenceError 방지 — renderTocItems 스코프에서 선언
  const c=document.getElementById('tb0');c.innerHTML='';
  // ★ L-06: 전체 재렌더 시 내보내기 버튼 플래그 초기화 (updateTocStat에서 재생성)
  _tocExportBtnCreated=false;
  if(!S.tocItems.length){c.innerHTML='<div class="toc-empty">⚠️ 챕터가 감지되지 않았습니다.</div>';return;}

  const total=S.tocItems.length;
  const HEAD=5, TAIL=5;
  const alwaysShow=new Set();
  for(let i=0;i<Math.min(HEAD,total);i++) alwaysShow.add(i);
  for(let i=Math.max(0,total-TAIL);i<total;i++) alwaysShow.add(i);

  // ── 다중 선택 상태 ──
  const _selectedIdxs=new Set();
  let _lastClickedIdx=null; // ★ 개선 02: Shift 범위 선택용 앵커
  let _selectModeOn=false;  // ★ 개선 01: 선택 모드 토글

  // ══ 검색/필터 바 ══
  const filterBar=document.createElement('div');
  filterBar.style.cssText='display:flex;gap:6px;align-items:center;margin-bottom:8px;flex-wrap:wrap';
  filterBar.innerHTML=
    '<input id="toc-search" class="inp" placeholder="🔍 제목 검색..." style="flex:1;min-width:120px;font-size:11px;padding:5px 8px">'+
    // ★ 개선 01: 선택 모드 토글 버튼 (항상 노출)
    '<button class="btn btn-ghost btn-sm" id="toc-select-mode-btn" title="클릭으로 다중 선택 모드 전환 (터치·모바일 친화)" style="font-size:11px;white-space:nowrap">☑ 선택 모드</button>'+
    // ★ 개선 06: 짧은챕터 자동 선택
    '<button class="btn btn-ghost btn-sm" id="toc-auto-sel-susp" title="⚠ 짧은챕터 항목 전체 선택" style="font-size:11px;white-space:nowrap;display:none">⚠ 자동 선택</button>'+
    '<button class="btn btn-ghost btn-sm" onclick="undoToc()" title="되돌리기 (최대 10단계)" style="font-size:11px">↩ Undo</button>';
  c.appendChild(filterBar);

  const searchInp=filterBar.querySelector('#toc-search');
  let _filterQ='';
  searchInp.addEventListener('input',e=>{
    _filterQ=e.target.value.toLowerCase().trim();
    c.querySelectorAll('.toc-item[data-idx]').forEach(el=>{
      const idx=parseInt(el.dataset.idx);
      const t=(S.tocItems[idx]?.title||'').toLowerCase();
      el.style.display=(!_filterQ||t.includes(_filterQ))?'':'none';
    });
    const foldBtn=c.querySelector('.toc-fold-btn');
    if(foldBtn) foldBtn.style.display=_filterQ?'none':'';
    // 검색 중 자동선택 버튼 숨김
    updateAutoSelBtn();
  });

  // ★ 개선 01: 선택 모드 토글
  const selectModeBtn=filterBar.querySelector('#toc-select-mode-btn');
  selectModeBtn.addEventListener('click',()=>{
    _selectModeOn=!_selectModeOn;
    selectModeBtn.style.background=_selectModeOn?'var(--blue)':'';
    selectModeBtn.style.color=_selectModeOn?'#fff':'';
    selectModeBtn.style.borderColor=_selectModeOn?'var(--blue)':'';
    selectModeBtn.title=_selectModeOn?'선택 모드 ON — 클릭만으로 선택됩니다 (다시 클릭해서 해제)':'선택 모드 OFF';
    // 선택 모드 해제 시 선택 초기화
    if(!_selectModeOn){
      _selectedIdxs.clear();
      c.querySelectorAll('.toc-item.multi-selected').forEach(el=>el.classList.remove('multi-selected'));
      updateMergeBar();
    }
  });

  // ★ 개선 06: 짧은챕터 자동 선택 버튼
  const autoSelBtn=filterBar.querySelector('#toc-auto-sel-susp');
  function updateAutoSelBtn(){
    const suspCount=S.tocItems.filter(t=>t.suspicious).length;
    if(autoSelBtn) autoSelBtn.style.display=(suspCount>0&&!_filterQ)?'':'none';
  }
  updateAutoSelBtn();
  autoSelBtn?.addEventListener('click',()=>{
    _saveTocSnapshot();
    S.tocItems.forEach((t,i)=>{ if(t.suspicious){ _selectedIdxs.add(i); } });
    c.querySelectorAll('.toc-item[data-idx]').forEach(el=>{
      const idx=parseInt(el.dataset.idx);
      if(_selectedIdxs.has(idx)) el.classList.add('multi-selected');
    });
    updateMergeBar();
    // 첫 번째 선택 항목으로 스크롤
    const firstSusp=c.querySelector('.toc-item.multi-selected');
    firstSusp?.scrollIntoView({block:'center',behavior:'smooth'});
    Toast.info('짧은챕터 '+_selectedIdxs.size+'개를 선택했어요. 병합 또는 제거를 선택하세요.',3000);
  });

  // ══ 병합 툴바 (★ 개선 03·05·07 포함) ══
  const toolbar=document.createElement('div');
  toolbar.id='toc-merge-bar';
  toolbar.style.cssText='display:none;flex-direction:column;gap:6px;padding:8px 10px;'+
    'background:var(--blue-bg);border-radius:8px;margin-bottom:8px;border:1px solid var(--blue)';

  // 상단 행: 카운트 + 액션 버튼들
  const toolbarTop=document.createElement('div');
  toolbarTop.style.cssText='display:flex;align-items:center;gap:8px;flex-wrap:wrap';
  toolbarTop.innerHTML=
    '<span id="toc-sel-count" style="font-size:11px;color:var(--blue);font-weight:600">0개 선택됨</span>'+
    '<button class="btn btn-sm" id="toc-merge-btn" style="font-size:11px;padding:3px 10px;background:var(--blue);color:#fff;border:none;border-radius:5px">🔗 병합</button>'+
    '<button class="btn btn-sm" id="toc-sel-clear" style="font-size:11px;padding:3px 8px;background:none;border:1.5px solid var(--blue);color:var(--blue);border-radius:5px">✕ 해제</button>'+
    // ★ 개선 05: 첫 번째 선택 항목으로 스크롤
    '<button class="btn btn-sm" id="toc-scroll-sel" title="선택한 첫 항목으로 스크롤" style="font-size:11px;padding:3px 7px;background:none;border:1.5px solid var(--blue);color:var(--blue);border-radius:5px">📍 위치</button>';
  toolbar.appendChild(toolbarTop);

  // ★ 개선 05: 미니맵 — 선택된 인덱스 나열
  const minimap=document.createElement('div');
  minimap.id='toc-sel-minimap';
  minimap.style.cssText='display:none;font-size:10px;color:var(--blue);line-height:1.6;word-break:break-all';
  toolbar.appendChild(minimap);

  // ★ 개선 07: 병합 미리보기 패널
  const previewPanel=document.createElement('div');
  previewPanel.id='toc-merge-preview';
  previewPanel.style.cssText=
    'display:none;background:var(--bg2);border:1px solid var(--blue);border-radius:6px;'+
    'padding:8px 10px;font-size:11px;color:var(--text2);line-height:1.7;max-height:120px;overflow-y:auto';
  toolbar.appendChild(previewPanel);

  // ★ 개선 03: 제목 편집 영역 (병합 직후 표시)
  const titleEditArea=document.createElement('div');
  titleEditArea.id='toc-merge-title-edit';
  titleEditArea.style.cssText='display:none;gap:6px;align-items:center;flex-wrap:wrap';
  titleEditArea.innerHTML=
    '<span style="font-size:11px;color:var(--blue);font-weight:600;flex-shrink:0">📝 제목:</span>'+
    '<input id="toc-merge-title-inp" class="inp" style="flex:1;min-width:120px;font-size:11px;padding:3px 7px">'+
    '<div style="display:flex;gap:4px;flex-shrink:0">'+
      '<button class="btn btn-sm" id="toc-mtitle-first" title="첫 챕터 제목 사용" style="font-size:10px;padding:2px 6px">첫 제목</button>'+
      '<button class="btn btn-sm" id="toc-mtitle-range" title="범위 표기 (1~N화)" style="font-size:10px;padding:2px 6px">범위</button>'+
      '<button class="btn btn-sm" id="toc-mtitle-join" title="이어붙이기" style="font-size:10px;padding:2px 6px">이어붙이기</button>'+
      '<button class="btn btn-sm" id="toc-mtitle-apply" style="font-size:10px;padding:2px 8px;background:var(--blue);color:#fff;border-radius:4px">✓ 적용</button>'+
    '</div>';
  toolbar.appendChild(titleEditArea);

  c.appendChild(toolbar);

  // ══ 병합 실행 함수 ══
  async function execMerge(){
    const idxs=[..._selectedIdxs].sort((a,b)=>a-b);
    if(idxs.length<2) return;

    // ★ 개선 08: 검색 필터 중 병합 안전 확인
    if(_filterQ){
      const ok=await Toast.confirm(
        '🔍 검색 필터가 활성 상태예요.<br>'+
        '필터된 화면에서 선택된 '+idxs.length+'개를 병합할까요?<br>'+
        '<span style="color:var(--text2);font-size:11px">숨겨진 항목은 영향을 받지 않아요.</span>'
      );
      if(!ok) return;
    }

    // ★ 개선 10: 대량(20개+) 병합 시 로딩 표시
    const mergeBtn=toolbar.querySelector('#toc-merge-btn');
    if(idxs.length>20){
      mergeBtn.textContent='⏳ 병합 중...';
      mergeBtn.disabled=true;
      await yieldToMain();
    }

    _saveTocSnapshot();
    const first=S.tocItems[idxs[0]];
    // ★ B8: 병합된 챕터들의 body/bodyLen 합산
    const mergedBody    = idxs.map(i=>S.tocItems[i].body||'').join('\n');
    const mergedBodyLen = mergedBody.replace(/\s/g,'').length;
    // 원본 항목 정보 저장 (개선 04 분리 기능용)
    const _mergedSources = idxs.map(i=>({
      title: S.tocItems[i].title,
      body:  S.tocItems[i].body||'',
      bodyLen: S.tocItems[i].bodyLen||0,
      line:  S.tocItems[i].line,
    }));
    const defaultTitle=idxs.map(i=>S.tocItems[i].title).join(' + ');
    const merged={
      ...first,
      title:         defaultTitle,
      enabled:       true,
      body:          mergedBody,
      bodyLen:       mergedBodyLen,
      suspicious:    false,
      originalTitle: first.originalTitle||first.title,
      _isMerged:     true,         // ★ 개선 04: 분리 버튼 표시용 플래그
      _mergedSources: _mergedSources, // ★ 개선 04: 원본 정보
    };
    for(let k=idxs.length-1;k>=1;k--) S.tocItems.splice(idxs[k],1);
    S.tocItems[idxs[0]]=merged;
    _selectedIdxs.clear();
    _chaptersCache=null;_chaptersCacheKey='';
    renderTocItems();
    updateTocStat();
    updateTocEditBanner&&updateTocEditBanner();

    // ★ 개선 10: 완료 토스트
    const totalWan=mergedBodyLen>=10000?(mergedBodyLen/10000).toFixed(1)+'만자':mergedBodyLen.toLocaleString()+'자';
    Toast.success(idxs.length+'개 챕터를 1개로 병합했어요 (총 '+totalWan+')',3000);
  }

  // ══ 병합 버튼 이벤트 ══
  toolbarTop.querySelector('#toc-merge-btn').addEventListener('click', execMerge);

  toolbarTop.querySelector('#toc-sel-clear').addEventListener('click',()=>{
    _selectedIdxs.clear();
    _lastClickedIdx=null;
    c.querySelectorAll('.toc-item.multi-selected').forEach(el=>el.classList.remove('multi-selected'));
    updateMergeBar();
  });

  // ★ 개선 05: 선택 위치로 스크롤
  toolbarTop.querySelector('#toc-scroll-sel').addEventListener('click',()=>{
    const firstIdx=[..._selectedIdxs].sort((a,b)=>a-b)[0];
    if(firstIdx!=null){
      const el=c.querySelector(`.toc-item[data-idx="${firstIdx}"]`);
      el?.scrollIntoView({block:'center',behavior:'smooth'});
    }
  });

  // ★ 개선 03: 제목 프리셋 버튼
  titleEditArea.querySelector('#toc-mtitle-first')?.addEventListener('click',()=>{
    const idxs=[..._selectedIdxs].sort((a,b)=>a-b);
    const inp=titleEditArea.querySelector('#toc-merge-title-inp');
    if(inp&&idxs.length) inp.value=S.tocItems[idxs[0]]?.title||'';
  });
  titleEditArea.querySelector('#toc-mtitle-range')?.addEventListener('click',()=>{
    const idxs=[..._selectedIdxs].sort((a,b)=>a-b);
    const inp=titleEditArea.querySelector('#toc-merge-title-inp');
    if(inp&&idxs.length>1){
      const t0=S.tocItems[idxs[0]]?.title||'';
      const t1=S.tocItems[idxs[idxs.length-1]]?.title||'';
      inp.value=t0+' ~ '+t1;
    }
  });
  titleEditArea.querySelector('#toc-mtitle-join')?.addEventListener('click',()=>{
    const idxs=[..._selectedIdxs].sort((a,b)=>a-b);
    const inp=titleEditArea.querySelector('#toc-merge-title-inp');
    if(inp) inp.value=idxs.map(i=>S.tocItems[i]?.title||'').join(' + ');
  });

  // ★ 개선 03: 제목 적용 버튼
  titleEditArea.querySelector('#toc-mtitle-apply')?.addEventListener('click',()=>{
    const inp=titleEditArea.querySelector('#toc-merge-title-inp');
    const newTitle=(inp?.value||'').trim();
    if(!newTitle) return;
    // 가장 최근 병합된 항목(_isMerged)에 제목 적용
    const mergedIdx=S.tocItems.findIndex(t=>t._isMerged&&!t._titleApplied);
    if(mergedIdx>=0){
      S.tocItems[mergedIdx].title=newTitle;
      S.tocItems[mergedIdx]._titleApplied=true;
      _chaptersCache=null;_chaptersCacheKey='';
      // 해당 행 제목 input만 업데이트 (전체 재렌더 없이)
      const rowInp=c.querySelector(`.toc-item[data-idx="${mergedIdx}"] .toc-title-edit`);
      if(rowInp) rowInp.value=newTitle;
      titleEditArea.style.display='none';
      Toast.success('제목을 "'+newTitle+'"으로 설정했어요.',2000);
    }
  });

  function updateMergeBar(){
    const n=_selectedIdxs.size;
    toolbar.style.display=n>0?'flex':'none';
    toolbarTop.querySelector('#toc-sel-count').textContent=n+'개 선택됨';
    toolbarTop.querySelector('#toc-merge-btn').disabled=n<2;
    toolbarTop.querySelector('#toc-merge-btn').textContent=n>=2?'🔗 병합':'🔗 병합';

    // ★ 개선 05: 미니맵 업데이트
    if(n>0){
      const sortedIdxs=[..._selectedIdxs].sort((a,b)=>a-b);
      const labels=sortedIdxs.slice(0,8).map(i=>{
        const t=S.tocItems[i]?.title||'';
        return '<span style="background:var(--blue);color:#fff;border-radius:3px;padding:0 4px;margin:1px;display:inline-block">'+
          escHtml(t.length>10?t.slice(0,10)+'…':t)+'</span>';
      });
      const more=n>8?` <span style="color:var(--blue)">+${n-8}개</span>`:'';
      minimap.innerHTML=labels.join('')+more;
      minimap.style.display='';
    } else {
      minimap.style.display='none';
    }

    // ★ 개선 07: 병합 미리보기 업데이트
    if(n>=2){
      const sortedIdxs=[..._selectedIdxs].sort((a,b)=>a-b);
      const totalChars=sortedIdxs.reduce((s,i)=>{
        const bl=typeof S.tocItems[i]?.bodyLen==='number'?S.tocItems[i].bodyLen:(S.tocItems[i]?.body||'').replace(/\s/g,'').length;
        return s+bl;
      },0);
      const totalWan=totalChars>=10000?(totalChars/10000).toFixed(1)+'만자':totalChars.toLocaleString()+'자';
      const previews=sortedIdxs.slice(0,5).map(i=>{
        const t=S.tocItems[i];
        const firstLine=(t?.body||'').split('\n').find(l=>l.trim())||'(본문 없음)';
        return `<div style="border-left:2px solid var(--blue);padding-left:6px;margin:2px 0">
          <b style="font-size:10px;color:var(--blue)">${escHtml(t?.title||'')}</b>
          <span style="font-size:10px;opacity:.7"> — ${escHtml(firstLine.slice(0,40))}${firstLine.length>40?'…':''}</span>
        </div>`;
      });
      const morePreview=n>5?`<div style="font-size:10px;color:var(--text2);margin-top:2px">외 ${n-5}개 챕터...</div>`:'';
      previewPanel.innerHTML=
        `<div style="font-weight:600;color:var(--blue);margin-bottom:4px;font-size:11px">병합하면 <b>${totalWan}</b> 챕터가 됩니다</div>`+
        previews.join('')+morePreview;
      previewPanel.style.display='';
    } else {
      previewPanel.style.display='none';
    }

    // ★ 개선 03: 제목 편집 영역은 병합 후 자동 표시 (execMerge 후 renderTocItems에서 재설정)
    titleEditArea.style.display='none';
  }

  // ══ buildTocRow — 각 행 생성 ══
  function buildTocRow(item, i, isHidden){
    const d=document.createElement('div');
    d.className='toc-item'+(item.enabled?'':' off');
    d.dataset.idx=i;
    if(isHidden) d.style.display='none';
    d.draggable=true;
    // 이미 선택된 상태 복원 (renderTocItems 재호출 시)
    if(_selectedIdxs.has(i)) d.classList.add('multi-selected');

    // 드래그 핸들 — ★ 접근성: tabindex + aria-label + role 추가
    const handle=document.createElement('span');
    handle.className='toc-drag-handle';
    handle.textContent='⠿';
    handle.title='드래그해서 순서 변경 / 중앙에 놓으면 병합';
    handle.setAttribute('tabindex','0');
    handle.setAttribute('role','button');
    handle.setAttribute('aria-label',`${item.title||''} 항목 순서 변경 핸들`);

    // 체크박스
    const chk=document.createElement('input');
    chk.type='checkbox'; chk.className='toc-chk'; chk.checked=item.enabled;
    chk.addEventListener('change',e=>{
      e.stopPropagation();
      S.tocItems[i].enabled=e.target.checked;
      // ★ DOM만 업데이트 (전체 재렌더링 없음 → 1,000화 이상 성능 개선)
      d.classList.toggle('off',!e.target.checked);
      _chaptersCache=null;_chaptersCacheKey='';
      updateTocStat();
    });

    // 줄 번호
    const num=document.createElement('span');
    num.className='toc-num'; num.textContent=item.line+'줄';

    // ★ B2+B3+B6+B9: 글자수 배지 — item.bodyLen 직접 사용 (드래그 순서 무관)
    const charBadge=document.createElement('span');
    charBadge.className='toc-char-badge';
    const _bLen = typeof item.bodyLen==='number'
      ? item.bodyLen
      : (item.body||'').replace(/\s/g,'').length;
    if(_bLen > 0 || item.body !== undefined){
      // ★ B3: Math.floor로 내림 표시, 1만자 이상은 '만자' 단위
      let _bTxt;
      if(_bLen < 1000)       _bTxt = _bLen + '자';
      else if(_bLen < 10000) _bTxt = (_bLen/1000).toFixed(1) + 'k';
      else                   _bTxt = (_bLen/10000).toFixed(1) + '만';
      charBadge.textContent = _bTxt;
      charBadge.title = '본문 글자수 (공백 제외): ' + _bLen.toLocaleString() + '자 (기준: ' + getSuspThreshold() + '자)';
      // ★ FIX-07: getSuspThreshold() 호출 시점 평가 → 설정 변경 즉시 반영
      const _suspThr = getSuspThreshold();
      const _isShort = _bLen > 0 && _bLen < _suspThr;
      // ★ FIX-04: CSS 변수로 교체 (하드코딩 색상 제거)
      charBadge.style.cssText=
        'font-size:9px;padding:1px 5px;border-radius:3px;flex-shrink:0;white-space:nowrap;cursor:default;'+
        (_isShort
          ? 'background:var(--yellow-bg);color:var(--yellow);border:1px solid var(--accent2)'
          : 'background:var(--bg2);color:var(--text2);border:1px solid var(--border)');
      if(_isShort) charBadge.dataset.short='1';

      // ★ I6: hover 시 본문 앞 3줄 팝오버 표시
      let _charPopTimer=null;
      charBadge.addEventListener('mouseenter',()=>{
        _charPopTimer=setTimeout(()=>{
          const preview=(item.body||'').split('\n').filter(l=>l.trim()).slice(0,3).join('\n')||'(본문 없음)';
          const pop=document.createElement('div');
          pop.style.cssText='position:fixed;z-index:9999;background:var(--panel);border:1.5px solid var(--border);border-radius:8px;padding:8px 10px;font-size:11px;max-width:280px;box-shadow:var(--shadow-md);pointer-events:none;color:var(--text2);line-height:1.6;white-space:pre-wrap;word-break:break-all';
          pop.textContent=preview;
          document.body.appendChild(pop);
          const rect=charBadge.getBoundingClientRect();
          pop.style.left=Math.min(rect.left,window.innerWidth-300)+'px';
          pop.style.top=(rect.bottom+4)+'px';
          charBadge._pop=pop;
        },350);
      });
      charBadge.addEventListener('mouseleave',()=>{
        clearTimeout(_charPopTimer);
        charBadge._pop?.remove(); charBadge._pop=null;
      });
    }

    // 제목 인라인 편집 input
    const titleInp=document.createElement('input');
    titleInp.className='toc-title-edit';
    titleInp.value=item.title;
    titleInp.title='클릭해서 제목 편집';
    titleInp.addEventListener('click',e=>e.stopPropagation());
    titleInp.addEventListener('change',e=>{
      const newTitle=e.target.value.trim()||item.title;
      if(!S.tocItems[i].originalTitle) S.tocItems[i].originalTitle=S.tocItems[i].title;
      S.tocItems[i].title=newTitle;
      // ★ 제목 편집 시에도 캐시 무효화
      _chaptersCache=null;_chaptersCacheKey='';
    });
    titleInp.addEventListener('keydown',e=>{
      if(e.key==='Enter'){e.target.blur();}
      if(e.key==='Escape'){e.target.value=S.tocItems[i].title;e.target.blur();}
    });

    // ★ 개선 01: 호버 퀵 선택 버튼 (+)
    const quickSelBtn=document.createElement('button');
    quickSelBtn.className='toc-quick-sel-btn';
    quickSelBtn.textContent='+';
    quickSelBtn.title='클릭해서 병합 선택에 추가 (또는 Ctrl+클릭)';
    quickSelBtn.addEventListener('click',e=>{
      e.stopPropagation();
      if(_selectedIdxs.has(i)){
        _selectedIdxs.delete(i);
        d.classList.remove('multi-selected');
      } else {
        _selectedIdxs.add(i);
        d.classList.add('multi-selected');
        _lastClickedIdx=i;
      }
      updateMergeBar();
    });

    // ★ 개선 04: 병합된 챕터에 🔓 분리 버튼
    if(item._isMerged && item._mergedSources && item._mergedSources.length>=2){
      const splitBadge=document.createElement('span');
      splitBadge.style.cssText=
        'font-size:9px;background:var(--blue-bg);color:var(--blue);border-radius:3px;'+
        'padding:1px 5px;flex-shrink:0;white-space:nowrap;cursor:default;'+
        'border:1px solid var(--blue);display:inline-flex;align-items:center;gap:3px';
      splitBadge.innerHTML='🔗 '+item._mergedSources.length+'개 병합';
      splitBadge.title='이 챕터는 '+item._mergedSources.length+'개 챕터가 병합된 상태입니다';

      const unmergeBtn=document.createElement('button');
      unmergeBtn.className='btn btn-sm';
      unmergeBtn.style.cssText=
        'font-size:9px;padding:1px 7px;flex-shrink:0;'+
        'background:var(--blue-bg);color:var(--blue);'+
        'border:1px solid var(--blue);border-radius:4px;line-height:1.5;'+
        'white-space:nowrap;transition:all .15s;cursor:pointer';
      unmergeBtn.innerHTML='🔓&nbsp;분리';
      unmergeBtn.title='병합 전 상태로 복원합니다 (Undo와 독립적)';
      unmergeBtn.addEventListener('mouseenter',()=>{unmergeBtn.style.background='var(--blue)';unmergeBtn.style.color='#fff';});
      unmergeBtn.addEventListener('mouseleave',()=>{unmergeBtn.style.background='var(--blue-bg)';unmergeBtn.style.color='var(--blue)';});
      unmergeBtn.addEventListener('click',e=>{
        e.stopPropagation();
        _saveTocSnapshot();
        const idx=S.tocItems.indexOf(item);
        if(idx<0) return;
        // 원본 소스로 복원 (line은 첫 소스 기준 연속 부여)
        const restored=item._mergedSources.map((src,si)=>({
          line:   si===0 ? item.line : (item.line+si),
          title:  src.title,
          enabled: true,
          body:   src.body,
          bodyLen: src.bodyLen,
          suspicious: src.bodyLen < getSuspThreshold() && si < item._mergedSources.length-1,
          originalTitle: src.title,
        }));
        S.tocItems.splice(idx, 1, ...restored);
        _chaptersCache=null;_chaptersCacheKey='';
        renderTocItems();
        updateTocStat();
        updateTocEditBanner&&updateTocEditBanner();
        Toast.success('챕터를 '+restored.length+'개로 분리했어요.',2500);
      });

      d.appendChild(handle);d.appendChild(chk);d.appendChild(num);
      if(charBadge.textContent) d.appendChild(charBadge);
      d.appendChild(titleInp);d.appendChild(splitBadge);d.appendChild(unmergeBtn);d.appendChild(quickSelBtn);
    } else if(item.suspicious){
      // 오감지 배지 + 제거 버튼
      const badge=document.createElement('span');
      badge.style.cssText=
        'font-size:9px;background:var(--yellow-bg);color:var(--yellow);border-radius:3px;'+
        'padding:1px 6px;flex-shrink:0;white-space:nowrap;cursor:default;'+
        'border:1px solid var(--accent2);display:inline-flex;align-items:center;gap:3px';
      badge.innerHTML='<span>⚠</span><span>본문 짧음</span>';
      badge.title='이 챕터 본문이 '+getSuspThreshold()+'자 미만이에요 — 오감지일 수 있어요';

      const removeBtn=document.createElement('button');
      removeBtn.className='btn btn-sm';
      removeBtn.style.cssText=
        'font-size:9px;padding:1px 7px;flex-shrink:0;'+
        'background:var(--accent-bg);color:var(--accent);'+
        'border:1px solid var(--accent);border-radius:4px;line-height:1.5;'+
        'white-space:nowrap;transition:all .15s';
      removeBtn.innerHTML='⤵&nbsp;병합';
      removeBtn.title='이 짧은 챕터와 다음 챕터를 병합합니다 (본문 이어붙이기)';
      removeBtn.addEventListener('mouseenter',()=>{removeBtn.style.background='var(--blue)';removeBtn.style.color='#fff';removeBtn.style.borderColor='var(--blue)';});
      removeBtn.addEventListener('mouseleave',()=>{removeBtn.style.background='var(--accent-bg)';removeBtn.style.color='var(--accent)';removeBtn.style.borderColor='var(--accent)';});
      removeBtn.addEventListener('click',e=>{
        e.stopPropagation();
        _saveTocSnapshot();
        const idx=S.tocItems.indexOf(item);
        if(idx<0) return;
        if(idx+1 < S.tocItems.length){
          // ★ BUG-FIX 04: 다음 챕터 본문을 현재 챕터에 병합 후 다음 챕터 제거
          const next=S.tocItems[idx+1];
          const mergedBody=(item.body||'')+'\n'+(next.body||'');
          const mergedBodyLen=mergedBody.replace(/\s/g,'').length;
          S.tocItems[idx]={
            ...item,
            body:          mergedBody,
            bodyLen:       mergedBodyLen,
            suspicious:    false,
            _isMerged:     true,
            _mergedSources:[
              {title:item.title, body:item.body||'', bodyLen:item.bodyLen||0, line:item.line},
              {title:next.title, body:next.body||'', bodyLen:next.bodyLen||0, line:next.line},
            ],
          };
          S.tocItems.splice(idx+1,1);
          Toast.success(`"${item.title}"에 다음 챕터를 병합했어요.`,2500);
        } else {
          // 마지막 챕터: 이전 챕터에 병합
          if(idx>0){
            const prev=S.tocItems[idx-1];
            const mergedBody=(prev.body||'')+'\n'+(item.body||'');
            const mergedBodyLen=mergedBody.replace(/\s/g,'').length;
            S.tocItems[idx-1]={
              ...prev,
              body:          mergedBody,
              bodyLen:       mergedBodyLen,
              suspicious:    false,
              _isMerged:     true,
              _mergedSources:[
                {title:prev.title, body:prev.body||'', bodyLen:prev.bodyLen||0, line:prev.line},
                {title:item.title, body:item.body||'', bodyLen:item.bodyLen||0, line:item.line},
              ],
            };
            S.tocItems.splice(idx,1);
            Toast.success(`마지막 챕터를 이전 챕터에 병합했어요.`,2500);
          } else {
            // 챕터가 1개뿐이면 그냥 suspicious 해제
            S.tocItems[idx].suspicious=false;
            Toast.info('짧은 챕터 표시를 해제했어요.',2000);
          }
        }
        _chaptersCache=null;_chaptersCacheKey='';
        renderTocItems();
        updateTocStat();
        updateTocEditBanner&&updateTocEditBanner();
        const remaining=S.tocItems.filter(t=>t.suspicious).length;
        if(remaining===0) document.getElementById('susp-toast')?.remove();
      });

      d.appendChild(handle);d.appendChild(chk);d.appendChild(num);
      if(charBadge.textContent) d.appendChild(charBadge);
      d.appendChild(titleInp);d.appendChild(badge);d.appendChild(removeBtn);d.appendChild(quickSelBtn);
    } else {
      d.appendChild(handle);d.appendChild(chk);d.appendChild(num);
      if(charBadge.textContent) d.appendChild(charBadge);
      d.appendChild(titleInp);d.appendChild(quickSelBtn);
    }

    // ★ 개선 01+02: Ctrl+클릭 / Cmd+클릭 → 다중 선택 토글 / Shift+클릭 → 범위 선택
    d.addEventListener('click',e=>{
      // 선택 모드이거나 Ctrl/Cmd+클릭
      const isSelectMode=_selectModeOn||(e.ctrlKey||e.metaKey);
      if(!isSelectMode&&!e.shiftKey) return;
      e.preventDefault();

      if(e.shiftKey && _lastClickedIdx!==null){
        // ★ 개선 02: Shift+클릭 범위 선택
        const from=Math.min(_lastClickedIdx, i);
        const to  =Math.max(_lastClickedIdx, i);
        for(let k=from;k<=to;k++){
          _selectedIdxs.add(k);
          const el=c.querySelector(`.toc-item[data-idx="${k}"]`);
          el?.classList.add('multi-selected');
        }
      } else {
        if(_selectedIdxs.has(i)){
          _selectedIdxs.delete(i);
          d.classList.remove('multi-selected');
        } else {
          _selectedIdxs.add(i);
          d.classList.add('multi-selected');
          _lastClickedIdx=i;
        }
      }
      updateMergeBar();
    });

    // ★ 개선 09: 드래그 이벤트 — 행 중앙 드롭 = 병합, 상단/하단 드롭 = 순서 변경
    d.addEventListener('dragstart',e=>{
      dragSrcI=i; _tocDragSrc=i;
      d.classList.add('dragging');
      e.dataTransfer.effectAllowed='move';
    });
    d.addEventListener('dragend',()=>{
      d.classList.remove('dragging');
      document.querySelectorAll('.toc-item.drag-over,.toc-item.drag-merge-target').forEach(el=>{
        el.classList.remove('drag-over','drag-merge-target');
      });
    });
    d.addEventListener('dragover',e=>{
      e.preventDefault();
      if(_tocDragSrc===null||_tocDragSrc===i) return;
      document.querySelectorAll('.toc-item.drag-over,.toc-item.drag-merge-target').forEach(el=>{
        el.classList.remove('drag-over','drag-merge-target');
      });
      // ★ 개선 09: 드롭 위치에 따라 순서 변경 vs 병합 구분
      const rect=d.getBoundingClientRect();
      const relY=(e.clientY-rect.top)/rect.height;
      if(relY>0.3 && relY<0.7 && !e.altKey){
        // 중앙 1/3 + Alt 없으면 병합 드롭존
        d.classList.add('drag-merge-target');
        e.dataTransfer.dropEffect='copy';
      } else {
        d.classList.add('drag-over');
        e.dataTransfer.dropEffect='move';
      }
    });
    d.addEventListener('dragleave',()=>{
      d.classList.remove('drag-over','drag-merge-target');
    });
    d.addEventListener('drop',e=>{
      e.preventDefault();
      const src=_tocDragSrc;
      if(src===null||src===i){_tocDragSrc=null;return;}

      const isMergeTarget=d.classList.contains('drag-merge-target');
      d.classList.remove('drag-over','drag-merge-target');
      _tocDragSrc=null;

      if(isMergeTarget){
        // ★ 개선 09: 드래그 병합 실행
        _saveTocSnapshot();
        const srcItem=S.tocItems[src];
        const dstItem=S.tocItems[i];
        const sortedIdxs=[src,i].sort((a,b)=>a-b);
        const mergedBody=sortedIdxs.map(idx=>S.tocItems[idx].body||'').join('\n');
        const mergedBodyLen=mergedBody.replace(/\s/g,'').length;
        const mergedSources=sortedIdxs.map(idx=>({
          title: S.tocItems[idx].title,
          body:  S.tocItems[idx].body||'',
          bodyLen: S.tocItems[idx].bodyLen||0,
          line:  S.tocItems[idx].line,
        }));
        const newItem={
          ...S.tocItems[sortedIdxs[0]],
          title: srcItem.title+' + '+dstItem.title,
          enabled: true,
          body: mergedBody,
          bodyLen: mergedBodyLen,
          suspicious: false,
          originalTitle: S.tocItems[sortedIdxs[0]].originalTitle||S.tocItems[sortedIdxs[0]].title,
          _isMerged: true,
          _mergedSources: mergedSources,
        };
        S.tocItems.splice(sortedIdxs[1],1);
        S.tocItems[sortedIdxs[0]]=newItem;
        _chaptersCache=null;_chaptersCacheKey='';
        renderTocItems();
        updateTocStat();
        updateTocEditBanner&&updateTocEditBanner();
        const totalWan=mergedBodyLen>=10000?(mergedBodyLen/10000).toFixed(1)+'만자':mergedBodyLen.toLocaleString()+'자';
        Toast.success('드래그 병합 완료 (총 '+totalWan+')',2500);
      } else {
        // 기존 순서 변경
        const moved=S.tocItems.splice(src,1)[0];
        const dest=src<i?i-1:i;
        S.tocItems.splice(dest,0,moved);
        renderTocItems();
      }
    });
    return d;
  }

  let collapsed=false;
  S.tocItems.forEach((item,i)=>{
    if(total>HEAD+TAIL&&i===HEAD&&!collapsed){
      collapsed=true;
      const mid=total-HEAD-TAIL;
      const midDiv=document.createElement('div');
      midDiv.style.cssText='text-align:center;padding:4px;font-size:11px;color:var(--text2);border:1px dashed var(--border);border-radius:5px;margin:3px 0;cursor:pointer';
      midDiv.id='toc-collapse-btn';
      midDiv.innerHTML='··· 중간 <b>'+mid+'</b>개 ··· <span style="color:var(--accent);font-size:10px">(클릭해서 펼치기)</span>';
      midDiv.onclick=()=>{
        document.getElementById('toc-collapse-btn')?.remove();
        c.querySelectorAll('[style*="display: none"]').forEach(el=>el.style.display='');
      };
      c.appendChild(midDiv);
    }
    const isEdge=alwaysShow.has(i);
    const isHidden=!isEdge&&total>HEAD+TAIL;
    c.appendChild(buildTocRow(item,i,isHidden));
  });

  const stat=document.createElement('div');
  stat.id='toc-stat';
  stat.style.cssText='margin-top:8px;display:flex;gap:6px;align-items:center;flex-wrap:wrap';
  c.appendChild(stat);
  updateTocStat();
}

function updateTocStat(){
  const stat=document.getElementById('toc-stat'); if(!stat) return;
  const total    = S.tocItems.length;
  // ★ B10: enabled 기준으로 분리 — 비활성 챕터는 통계에서 제외
  const active   = S.tocItems.filter(t=>t.enabled).length;
  const suspCount= S.tocItems.filter(t=>t.suspicious).length;

  // ★ B1+B10: 활성 챕터만 글자수 집계
  let totalChars = 0;
  S.tocItems.forEach(t=>{
    if(!t.enabled) return;
    const bl = typeof t.bodyLen==='number' ? t.bodyLen : (t.body||'').replace(/\s/g,'').length;
    totalChars += bl;
  });
  const avgChars  = active > 0 ? Math.round(totalChars / active) : 0;
  // ★ 총글자수 표시: 1만자 미만이면 '자' 단위, 이상이면 '만자' 단위
  const totalWanStr = totalChars >= 10000
    ? (totalChars / 10000).toFixed(1) + '만자'
    : totalChars.toLocaleString() + '자';
  // ★ FIX-07: getSuspThreshold() 호출 시점 평가
  const _suspThr = getSuspThreshold();
  // ★ I2: 짧은/긴 챕터 경고 집계 (B10: enabled만)
  const shortCount= S.tocItems.filter(t=>t.enabled&&(typeof t.bodyLen==='number'?t.bodyLen:(t.body||'').replace(/\s/g,'').length)<_suspThr).length;
  const longCount = S.tocItems.filter(t=>t.enabled&&(typeof t.bodyLen==='number'?t.bodyLen:(t.body||'').replace(/\s/g,'').length)>50000).length;

  // ★ I2: 통계 칩 배지 스타일
  const chip = (txt,color)=>
    `<span style="display:inline-flex;align-items:center;font-size:10px;padding:1px 7px;border-radius:99px;white-space:nowrap;background:${color.bg};color:${color.fg};border:1px solid ${color.bd}">${txt}</span>`;

  const statChips = [
    chip('총 '+totalWanStr, {bg:'var(--blue-bg)',fg:'var(--blue)',bd:'var(--blue)'}),
    chip('평균 '+avgChars.toLocaleString()+'자', {bg:'var(--bg2)',fg:'var(--text2)',bd:'var(--border)'}),
    shortCount>0 ? chip('⚠ 짧은챕터 '+shortCount+'(기준:'+_suspThr+'자)', {bg:'var(--accent-bg)',fg:'var(--accent)',bd:'var(--accent)'}) : '',
    longCount>0  ? chip('📌 긴챕터 '+longCount,    {bg:'var(--blue-bg)',fg:'var(--blue)',bd:'var(--blue)'}) : '',
  ].filter(Boolean).join('');

  // ★ I5: 짧은 챕터 배지 클릭 시 스크롤 — 이벤트 위임으로 처리
  const suspBtn=suspCount>0
    ? '<button class="btn btn-sm" data-action="removeAllSuspicious" '+
      'style="font-size:10px;background:var(--accent-bg);color:var(--accent);'+
      'border:1px solid var(--accent);border-radius:5px;display:inline-flex;align-items:center;gap:4px"'+
      ' title="본문 짧음 항목을 목차에서 모두 제거합니다">'+
      '<span>⚠</span><span>본문 짧음 '+suspCount+'개 전체 제거</span></button>'
    : '';

  stat.innerHTML=
    '<button class="btn btn-ghost btn-sm" data-action="toggleAllToc" data-val="true">전체 선택</button>'+
    '<button class="btn btn-ghost btn-sm" data-action="toggleAllToc" data-val="false">전체 해제</button>'+
    suspBtn+
    '<span style="display:flex;gap:4px;align-items:center;margin-left:auto;flex-wrap:wrap">'+
      statChips+
      '<span style="font-size:10px;color:var(--text2)">'+total+'개 중 '+active+'개 활성</span>'+
    '</span>';

  // ★ A-04: 변환 탭 버튼 배지
  const convertTab = document.querySelector('.page-tab[data-page="convert"]');
  if(convertTab){
    const badgeId = 'convertTabBadge';
    let badge = document.getElementById(badgeId);
    if(!badge){
      badge = document.createElement('sup');
      badge.id = badgeId;
      badge.style.cssText = 'margin-left:3px;font-size:9px;background:var(--accent);color:#fff;border-radius:99px;padding:0 5px;vertical-align:super;font-weight:700';
      convertTab.appendChild(badge);
    }
    badge.textContent = active > 0 ? active.toLocaleString() : total.toLocaleString();
    badge.style.display = total > 0 ? '' : 'none';
  }

  // ★ I7: 미니 차트 갱신 (main.js에 함수 정의)
  if(typeof renderTocMiniChart==='function') renderTocMiniChart();

  // ★ I10: 내보내기 버튼 동적 추가 — L-06 FIX: flag 변수로 중복 생성 방지 (DOM 조회 경합 제거)
  if(!_tocExportBtnCreated){
    _tocExportBtnCreated = true;
    const exportBtn=document.createElement('button');
    exportBtn.id='tocExportBtn';
    exportBtn.className='btn btn-ghost btn-sm';
    exportBtn.style.cssText='font-size:10px;padding:2px 8px;margin-left:4px';
    exportBtn.textContent='📋 내보내기';
    exportBtn.title='목차를 글자수 포함 TXT로 내보내기';
    exportBtn.onclick=()=>{ if(typeof exportTocWithStats==='function') exportTocWithStats(); };
    document.getElementById('toc-stat')?.appendChild(exportBtn);
  }
}
function toggleTocItem(i,v){
  S.tocItems[i].enabled=v;
  _chaptersCache=null;_chaptersCacheKey='';
  // DOM만 업데이트 (전체 재렌더링 없음)
  const el=document.querySelector(`.toc-item[data-idx="${i}"]`);
  if(el){
    el.classList.toggle('off',!v);
    const chk=el.querySelector('.toc-chk');
    if(chk) chk.checked=v;
  }
  updateTocStat();
  updateTocEditBanner&&updateTocEditBanner();
}
function toggleAllToc(v){
  _saveTocSnapshot();
  S.tocItems.forEach(t=>t.enabled=v);
  _chaptersCache=null;_chaptersCacheKey='';
  renderTocItems();
  updateTocEditBanner&&updateTocEditBanner();
}
let tocTabActive=0;
function tocTab(n){
  tocTabActive=n;
  // #tocPanel 내부로 스코프 제한 (전체 문서의 .ttab 오토글 방지)
  const panel=document.getElementById('tocPanel');
  if(panel) panel.querySelectorAll('.ttab').forEach((t,i)=>t.classList.toggle('on',i===n));
  [0,1,2,3].forEach(i=>document.getElementById('tb'+i).style.display=i===n?'':'none');
  if(n===1) renderTocPreview();
}
function applyPat(){document.getElementById('pattern').value=document.getElementById('patEdit').value;previewToc();}

// ── 스마트 패턴 변환 (smartPatConvert 등) → settings.js에 정의됨 (중복 제거) ──
// ── applySelectedChips → settings.js에 정의됨 (중복 제거) ──


// ══════════════════════════════════════════
// 🕘 Module: History (IndexedDB 영속화)
// → settings.js에 정의됨 (중복 제거)
// ══════════════════════════════════════════


// ══════════════════════════════════════════
// 👁  Module: ChapterPreview (챕터 본문 미리보기)
// ══════════════════════════════════════════
// ★ L-18: VirtualScroll 인스턴스 추적 — previewToc 재실행 시 destroy() 호출
let _vsInstTb2=null;
let _vsInstTb2b=null;

let _previewActiveIdx=-1;
let _fullRawLines=[];  // 전체 파일 원본 줄 (미리보기용)

async function renderTocPreview(){
  const c=document.getElementById('tocPreviewList');
  if(!c) return;
  const enabled=S.tocItems.filter(t=>t.enabled);
  if(!enabled.length){c.innerHTML='<div class="toc-empty">감지된 목차가 없어요.<br>정규식 탭에서 패턴을 수정하거나 자동 간격 분할을 시도해보세요.</div>';return;}

  // 전체 파일 텍스트 로드 (캐시) — 다중 파일 모두 병합 (previewToc와 동일 처리)
  // ★ L-16 FIX: _fullRawLines null 가드 추가 (startConvert 후 메모리 해제된 경우 대비)
  if((!_fullRawLines || !_fullRawLines.length)&&S.txtFiles.length){
    try{
      const sorted=[...S.txtFiles]; // 사용자 정렬 순서 유지 (renderTxtFileList에서 이미 정렬됨)
      const raws=await Promise.all(sorted.map(f=>fileToText(f).catch(()=>sampleLines(f))));
      _fullRawLines=raws.join('\n\n').split('\n');
    }catch(e){
      const raw=await sampleLines(S.txtFiles[0]).catch(()=>'');
      _fullRawLines=raw.split('\n');
    }
  }

  c.innerHTML='';
  const hint=document.createElement('div');
  hint.style.cssText='font-size:11px;color:var(--text2);margin-bottom:8px';
  hint.textContent='챕터를 클릭하면 해당 챕터 본문 앞부분을 미리볼 수 있어요.';
  c.appendChild(hint);

  enabled.forEach((item,idx)=>{
    const div=document.createElement('div');
    div.className='toc-preview-item'+(idx===_previewActiveIdx?' active':'');
    div.innerHTML=
      '<div style="display:flex;align-items:center;gap:6px">'+
      '<span style="font-size:10px;color:var(--text2);min-width:36px">'+item.line+'줄</span>'+
      '<span style="font-size:12px;font-weight:600;flex:1">'+escHtml(item.title)+'</span>'+
      '</div>'+
      (idx===_previewActiveIdx?'<div class="toc-preview-body" id="tpb_'+idx+'"></div>':'');
    div.onclick=()=>{
      _previewActiveIdx=(_previewActiveIdx===idx)?-1:idx;
      renderTocPreview();
      if(_previewActiveIdx>=0){
        // 본문 앞 30줄 표시
        const lineIdx=item.line;  // 1-based
        const nextItem=enabled[idx+1];
        const nextLineIdx=nextItem?nextItem.line-1:_fullRawLines.length;
        const bodyLines=_fullRawLines.slice(lineIdx, Math.min(lineIdx+40, nextLineIdx));
        const preview=bodyLines.filter(l=>l.trim()).slice(0,15).join('\n');
        setTimeout(()=>{
          const el=document.getElementById('tpb_'+idx);
          if(el) el.textContent=preview||'(본문 없음)';
        },50);
      }
    };
    c.appendChild(div);
  });

  // 전체 통계
  const stat=document.createElement('div');
  stat.style.cssText='margin-top:10px;font-size:11px;color:var(--text2);border-top:1px solid var(--border);padding-top:8px;text-align:center';
  stat.textContent='총 '+enabled.length+'개 챕터 · 파일 '+(_fullRawLines.length||'?')+'줄';
  c.appendChild(stat);
}

// ══════════════════════════════════════════
// ══════════════════════════════════════════
// ⚡ Module: AutoSplit (줄 간격 기반 자동 분할)
// ══════════════════════════════════════════
async function autoSplitByInterval(){
  if(!S.txtFiles.length){Toast.warn('TXT 파일을 먼저 선택해주세요.');return;}

  // 패턴이 이미 감지된 경우 경고
  if(S.tocItems.length>0){
    const ok=await Toast.confirm(
      '⚠️ 이미 '+S.tocItems.length+'개 챕터가 감지되어 있어요.<br><br>'+
      '간격 분할은 패턴 자동 감지가 실패했을 때 사용하는 기능이에요.<br>'+
      '계속하면 현재 목차가 덮어씌워져요.<br><br>'+
      '그래도 계속할까요?'
    );
    if(!ok) return;
  }

  // ★ startConvert와 동일하게 다중 파일 모두 join
  const sorted=[...S.txtFiles]; // 사용자 정렬 순서 유지 (renderTxtFileList에서 이미 정렬됨)
  const raws=await Promise.all(sorted.map(fileToText));
  const raw=raws.join('\n\n');
  const lines=raw.split('\n');
  const totalLines=lines.length;

  // 총 화수 입력
  const input=await Toast.prompt(
    '총 화수를 입력하세요.<br>파일 총 줄 수: '+totalLines+'줄<br>(비워두면 자동 추정)',
    '예: 300'
  );
  if(input===null) return;

  let totalChapters;
  if(input.trim()){
    totalChapters=parseInt(input.trim());
    if(isNaN(totalChapters)||totalChapters<1){Toast.warn('올바른 숫자를 입력해주세요.');return;}
  } else {
    totalChapters=Math.round(totalLines/300);
    if(totalChapters<1) totalChapters=1;
  }

  // 균등 간격으로 줄 번호 계산 — 제목은 "Chapter N" 고정
  // (줄 내용 기반 제목 탐색 제거 → 정확한 화수 기준 분할)
  const interval=Math.floor(totalLines/totalChapters);
  const found=[];
  const _suspThrAuto = getSuspThreshold();

  for(let ch=0;ch<totalChapters;ch++){
    const lineNum=Math.floor(ch*interval)+1; // 1-based
    // ★ L-05 FIX: 마지막 화는 totalLines를 정확히 사용 — 오버슈트 방지 및 suspicious 정확화
    const isLast = ch === totalChapters - 1;
    const nextLineNum = isLast ? totalLines : Math.floor((ch+1)*interval)+1;
    const title='Chapter '+(ch+1);
    // ★ LOGIC BUG FIX: body/bodyLen을 생성 시점에 계산 → 글자수 통계 정확화
    const bodyLines = lines.slice(lineNum, nextLineNum); // headLine 포함 (autoSplit)
    const bodyText  = bodyLines.join('\n').trim();
    const bodyLen   = bodyText.replace(/\s/g,'').length;
    found.push({
      line: lineNum,
      title,
      enabled:   true,
      autoSplit: true,
      body:      bodyText,
      bodyLen:   bodyLen,
      suspicious: bodyLen < _suspThrAuto && !isLast,
      originalTitle: title,
    });
  }

  S.tocItems=found;
  _fullRawLines=lines;

  // ★ 간격 분할 챕터를 실제 변환에 사용할 수 있도록 _chaptersCache에 직접 구성
  // tocItems 기반으로 [heading, body] 쌍 배열 생성
  _autoSplitLines=lines; // 원문 보존
  _autoSplitActive=true; // 간격 분할 모드 플래그
  _chaptersCache=null;   // 기존 캐시 무효화
  _chaptersCacheKey='';

  renderTocItems();

  const label=document.getElementById('tb0');
  const badge='<span class="toc-auto-badge">⚡ 간격 분할 ('+interval+'줄 간격, '+totalChapters+'화 추정)</span>';
  label.insertAdjacentHTML('afterbegin','<div style="font-size:11px;color:var(--text2);margin-bottom:8px;padding:0 4px">'+badge+
    '<br><span style="color:var(--accent);font-size:10px">⚠️ 제목이 부정확할 수 있어요. 목차 확인 후 불필요한 항목을 체크 해제하세요.</span></div>');

  document.getElementById('tocPanel').classList.add('show');
  tocTab(0);
  // ★ 가상 스크롤 (스크롤 위치 기반)
  const tb2b=document.getElementById('tb2');
  // ★ L-18 FIX: 이전 인스턴스 destroy
  _vsInstTb2b?.destroy(); _vsInstTb2b=null;
  tb2b.innerHTML='';
  if(typeof createVirtualScroll==='function'){
    _vsInstTb2b=createVirtualScroll(tb2b, lines);
  } else {
    const pre2=document.createElement('pre');pre2.className='toc-raw';
    pre2.textContent=lines.slice(0,2000).map((l,i)=>String(i+1).padStart(5,' ')+' │ '+l).join('\n');
    tb2b.appendChild(pre2);
    if(lines.length>2000){
      const b2=document.createElement('button');b2.className='btn btn-ghost btn-sm';
      b2.style.cssText='margin:8px 0;width:100%;font-size:11px';
      b2.textContent=`▼ 나머지 ${(lines.length-2000).toLocaleString()}줄 더 보기`;
      b2.onclick=()=>{pre2.textContent=lines.map((l,i)=>String(i+1).padStart(5,' ')+' │ '+l).join('\n');b2.remove();};
      tb2b.appendChild(b2);
    }
  }
  // 자동 분할 결과 중 본문 짧음 감지
  const _autoSuspCount=S.tocItems.filter(t=>t.suspicious).length;
  if(_autoSuspCount>0) showSuspiciousToast(_autoSuspCount);
}
