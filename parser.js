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
function escHtml(s){return s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');}
// ── 공통 본문 HTML 변환 함수 (bodyToHtml · bToHtml 통합) ──
// useItalic: 대화/회상 이탤릭 여부 · maxBlank: 연속 빈줄 최대 허용 수
// ── 텍스트 정규화 (인코딩 안전 처리) ──
// U+00AD(soft hyphen) → U+2014(em dash): 대화 표시 문자로 변환
// XML 1.0 비허용 제어문자 제거 (U+0000~U+001F 중 허용 외)
// 과도한 후행 공백 제거
function sanitizeLine(s){
  // U+00AD soft hyphen → em dash (소설에서 대화 표시로 사용됨)
  s=s.replace(/­/g,'—');
  // XML 1.0 비허용 제어문자 제거: U+0000-U+0008, U+000B, U+000C, U+000E-U+001F
  s=s.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g,'');
  // U+FFFE, U+FFFF 제거 (XML 비허용)
  s=s.replace(/[￾￿]/g,'');
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
      if(blankRun<=maxBlank) html+='<p>&#160;</p>\n';
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


async function handleCustomFont(files){
  const f=files[0];if(!f)return;
  customFontFile=f;
  const ext=f.name.split('.').pop().toLowerCase();
  const fontName=f.name.replace(/\.[^.]+$/,'');
  customFontName=fontName;
  // base64로 읽어서 @font-face에 임베드
  const ab=await fileToAB(f);
  const b64=btoa(String.fromCharCode(...new Uint8Array(ab)));
  const mimeMap={'ttf':'font/truetype','otf':'font/opentype','woff':'font/woff','woff2':'font/woff2'};
  const mime=mimeMap[ext]||'font/truetype';
  customFontFace='@font-face{font-family:"'+fontName+'";src:url("data:'+mime+';base64,'+b64+'") format("'+ext+'");}\n';
  // select에 커스텀 폰트 옵션 추가
  const opt=document.getElementById('customFontOpt');
  if(opt){opt.textContent='📁 '+fontName;opt.style.display='';opt.value='"'+fontName+'",serif';}
  document.getElementById('cssFont').value='"'+fontName+'",serif';
  document.getElementById('fontInfo').textContent='✅ '+f.name+' ('+( ab.byteLength/1024).toFixed(0)+'KB)';
  document.getElementById('fontDrop').classList.add('ok');
  updateCssPreview();
  saveCssSettings();
  updateSettingsSummary();
}

function showResultStats(containerId, stats){
  const c=document.getElementById(containerId);
  if(!c) return;
  c.innerHTML=stats.map(s=>
    '<div style="text-align:center"><div style="font-size:18px;font-weight:700;color:var(--green)">'+s.value+'</div>'+
    '<div style="font-size:10px;color:var(--text2);margin-top:2px">'+s.label+'</div></div>'
  ).join('');
}

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
// 📑 Module: ChapterParser (패턴 감지·챕터 분리)
// ══════════════════════════════════════════
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

function bestPat(raw){
  const lines=raw.split('\n');
  const totalLines=lines.length;
  let best=null,bestScore=0,bestName='';
  const mixed=[];

  // 빈 줄에 둘러싸인 줄 집합 (앞뒤 1~2줄 모두 빈줄이면 헤더 가능성 높음)
  const blankWrapped=new Set();
  for(let i=1;i<lines.length-1;i++){
    const prevBlank=!lines[i-1].trim();
    const nextBlank=!lines[i+1].trim();
    const prev2Blank=i>=2&&!lines[i-2].trim();
    const next2Blank=i<lines.length-2&&!lines[i+2].trim();
    if(lines[i].trim()&&(prevBlank||prev2Blank)&&(nextBlank||next2Blank)) blankWrapped.add(i);
  }

  for(const[rx,name]of PATS){
    const matchedIdxs=[];
    lines.forEach((l,i)=>{if(l.trim()&&rx.test(l.trim())) matchedIdxs.push(i);});
    const cnt=matchedIdxs.length;
    if(cnt<3) continue;
    // 가중치 점수: 빈줄 둘러싸인 경우 2배, 아니면 1배
    const score=matchedIdxs.reduce((acc,i)=>acc+(blankWrapped.has(i)?2:1),0);
    mixed.push({rx,name,cnt,score});
    if(score>bestScore){bestScore=score;best=rx;bestName=name;}
  }

  // 동적 minGap: 전체 줄 수에 비례 (최소 30, 최대 200)
  const dynGap=Math.max(30, Math.min(200, Math.floor(totalLines/50)));

  // N. 제목 패턴 (간격 검증)
  const nDot=checkNDotPattern(lines,dynGap);
  if(nDot.cnt>0&&nDot.cnt>=bestScore){
    bestScore=nDot.cnt; best=nDot.rx; bestName='N. 제목';
    mixed.push({rx:nDot.rx,name:'N. 제목',cnt:nDot.cnt,score:nDot.cnt});
  }
  // 소설명+N화 패턴 (간격 검증)
  const titleWa=checkTitleWaPattern(lines,dynGap);
  if(titleWa.cnt>0&&titleWa.cnt>=bestScore){
    bestScore=titleWa.cnt; best=titleWa.rx; bestName='소설명+N화';
    mixed.push({rx:titleWa.rx,name:'소설명+N화',cnt:titleWa.cnt,score:titleWa.cnt});
  }
  // 숫자만 폴백 (다른 패턴 없을 때만)
  if(bestScore<3){
    const fb=/^\d+$/;
    const cnt=lines.filter(l=>l.trim()&&fb.test(l.trim())).length;
    if(cnt>=3){bestScore=cnt;best=fb;bestName='숫자만';}
  }

  // 혼합 패턴 감지 — 소스 기준 중복 제거 후 결합
  const seen=new Set();
  const uniq=mixed.filter(m=>{if(seen.has(m.rx.source))return false;seen.add(m.rx.source);return true;});
  if(uniq.length>1){
    const combined=new RegExp('(?:'+uniq.map(m=>m.rx.source).join('|')+')','i');
    const uniqueMatches=[...new Set(lines.filter(l=>l.trim()&&combined.test(l.trim())).map(l=>l.trim()))];
    const combinedCnt=uniqueMatches.length;
    if(combinedCnt>bestScore){
      return {rx:combined,name:'혼합('+uniq.map(m=>m.name).join('+')+') [자동]',cnt:combinedCnt,isMixed:true,mixedParts:uniq};
    }
  }
  return {rx:best,name:bestName,cnt:bestScore};
}

// splitChapters: 동기 함수이지만 정규화 전처리가 무거울 수 있음
// 호출부에서 await yieldToMain() 후 호출 권장 (startConvert에서 처리)
function splitChapters(raw,customPat){
  // 입력 텍스트 정규화: CRLF → LF, U+00AD 변환, XML 비허용 제어문자 제거
  raw=raw
    .replace(/\r\n/g,'\n')   // CRLF 정규화
    .replace(/\r/g,'\n')      // 단독 CR 정규화
    .replace(/\xad/g,'\u2014') // U+00AD soft hyphen → em dash
    .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F]/g,'') // XML 비허용 제어문자 제거
    .replace(/[\uFFFE\uFFFF]/g,''); // XML 비허용 유니코드 제거

  let rx=null;
  if(customPat&&customPat.trim()){
    try{rx=new RegExp(customPat.trim(),'i');}catch(e){rx=null;}
  }
  if(!rx){const r=bestPat(raw);rx=r.rx;}

  // ── 패턴 없음 폴백: 일정 줄 수 단위로 페이지 분할 (텍스트 전체 보존) ──
  if(!rx){
    const rawLines=raw.split('\n');
    const totalLines=rawLines.length;
    // 파일 크기에 따라 페이지당 줄 수 조정 (작은 파일은 크게, 큰 파일은 작게)
    const PAGE_LINES=Math.max(200, Math.min(500, Math.floor(totalLines/20)));
    const chapters=[];
    for(let i=0;i<totalLines;i+=PAGE_LINES){
      const slice=rawLines.slice(i,i+PAGE_LINES).join('\n').trim();
      if(!slice) continue;
      const pageNum=Math.floor(i/PAGE_LINES)+1;
      const totalPages=Math.ceil(totalLines/PAGE_LINES);
      chapters.push([pageNum===1&&totalPages===1?'본문':`(${pageNum}/${totalPages})`, slice]);
    }
    return chapters.length?chapters:[['본문',raw.trim()]];
  }

  const rawLines=raw.split('\n');
  const chapters=[];
  let cur=null,body=[];
  // 중복 제목 카운터: 같은 제목이 여러 번 나오면 (2), (3)... 접미사 부여
  const seenHeadings=new Map(); // title → count

  // 구분선 패턴 (챕터 앞뒤 장식선)
  const sepRx=/^[-=*─━~·.‒—]{3,}\s*$|^[─━═]{2,}$/;

  for(let li=0;li<rawLines.length;li++){
    const line=rawLines[li];
    const t=line.trim();

    if(t&&rx.test(t)){
      // ★ 중복 제목 처리: 같은 제목이 또 나오면 (2), (3)... 접미사
      const prevCount=seenHeadings.get(t)||0;
      seenHeadings.set(t, prevCount+1);
      const uniqueTitle=prevCount===0 ? t : `${t} (${prevCount+1})`;

      // 직전 body 끝 구분선/빈줄 제거
      while(body.length&&(sepRx.test(body[body.length-1].trim())||body[body.length-1].trim()==='')) body.pop();
      if(cur===null&&body.length>0) chapters.push(['서문',body.join('\n').trim()]);
      else if(cur!==null) chapters.push([cur,body.join('\n').trim()]);
      cur=uniqueTitle; body=[];
      // 챕터 헤더 직후 구분선만 스킵 (빈줄은 본문에 포함)
      let ni=li+1;
      while(ni<rawLines.length&&sepRx.test(rawLines[ni].trim())) ni++;
      if(ni>li+1) li=ni-1;
    }else{
      body.push(line);
    }
  }
  if(cur!==null) chapters.push([cur,body.join('\n').trim()]);
  else if(body.length>0) chapters.push(['본문',body.join('\n').trim()]);
  return chapters.length?chapters:[['본문',raw.trim()]];
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
function buildChaptersFromTocItems(lines, tocItems){
  const enabled=tocItems.filter(t=>t.enabled);
  // enabled 항목이 없으면 페이지 분할 폴백
  if(!enabled.length){
    const raw=lines.join('\n');
    return splitChapters(raw,''); // splitChapters의 페이지 분할 폴백 사용
  }
  const chapters=[];
  for(let i=0;i<enabled.length;i++){
    const item=enabled[i];
    const headLine=item.line-1; // 0-based
    const nextLine=i+1<enabled.length?enabled[i+1].line-1:lines.length;

    let bodyLines;
    if(item.autoSplit){
      // ★ 간격 분할 모드: "Chapter N" 제목은 목차 전용
      // headLine 위치의 원본 텍스트를 그대로 본문에 포함 (텍스트 유실 방지)
      bodyLines=lines.slice(headLine, nextLine);
    } else {
      // 일반 패턴 분할: 헤딩 줄 자체는 제목이므로 body에서 제외
      bodyLines=lines.slice(headLine+1, nextLine);
    }
    chapters.push([item.title, bodyLines.join('\n').trim()]);
  }
  // 첫 챕터 앞에 내용이 있으면 서문으로
  const firstLine=enabled[0].line-1;
  if(firstLine>0){
    const preamble=lines.slice(0,firstLine).join('\n').trim();
    if(preamble) chapters.unshift(['서문',preamble]);
  }
  return chapters;
}

async function getCachedChapters(){
  if(!S.txtFiles.length) return [];

  // ★ 간격 분할 모드: tocItems 기반으로 챕터 조립
  if(_autoSplitActive&&_autoSplitLines&&S.tocItems.length>0){
    return buildChaptersFromTocItems(_autoSplitLines, S.tocItems);
  }

  const key=S.txtFiles.map(f=>f.name+f.size).join('|');
  const pat=document.getElementById('pattern')?.value.trim()||'';
  // ★ disabled 상태도 캐시 키에 포함 (체크 해제하면 캐시 무효화)
  const disabledKey=S.tocItems.filter(t=>!t.enabled).map(t=>t.title).join('|');
  const cacheKey=key+'::'+pat+'::'+disabledKey;
  if(_chaptersCache&&_chaptersCacheKey===cacheKey) return _chaptersCache;

  try{
    const sorted=[...S.txtFiles]; // 사용자 정렬 순서 유지 (renderTxtFileList에서 이미 정렬됨)
    const raws=await Promise.all(sorted.map(fileToText));
    const raw=raws.join('\n\n');
    await yieldToMain(); // 대용량 텍스트 조인 후 UI 복원
    _chaptersCache=splitChapters(raw,pat);
    _chaptersCacheKey=cacheKey;
  }catch(e){
    console.warn('getCachedChapters 실패:',e);
    _chaptersCache=[];
  }
  return _chaptersCache||[];
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

  const pat=document.getElementById('pattern').value.trim();
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

  // 최소 본문 글자 수 필터: 챕터 본문이 50자 미만이면 오감지 표시
  found=found.map((f,fi)=>{
    const nextLine=found[fi+1]?found[fi+1].line-1:_fullRawLines.length;
    const bodyLen=_fullRawLines.slice(f.line,nextLine).join('').replace(/\s/g,'').length;
    // ★ originalTitle 초기화 (인라인 편집 추적용)
    return {...f,enabled:true,suspicious:bodyLen<50&&fi<found.length-1,originalTitle:f.title};
  });

  S.tocItems=found;
  renderTocItems();

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

  document.getElementById('tb2').innerHTML='<pre class="toc-raw">'+_fullRawLines.map((l,i)=>String(i+1).padStart(4,' ')+' | '+escHtml(l)).join('\n')+'</pre>';
  document.getElementById('patEdit').value=pat;
  S._rawTextFull=_fullRawLines;
  document.getElementById('tocPanel').classList.add('show');
  tocTab(0);
  document.getElementById('tb0').insertAdjacentHTML('afterbegin','<div style="font-size:11px;color:var(--text2);margin-bottom:8px;padding:0 4px">'+patLabel+'</div>');
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
        '본문 짧음 챕터 '+count+'개 감지</div>'+
      '<div style="font-size:11px;color:var(--text2);line-height:1.5">'+
        '목차에서 ⚠ 배지를 확인하세요. 오감지일 경우 제거할 수 있어요.'+
      '</div>'+
    '</div>'+
    '<div style="display:flex;flex-direction:column;gap:5px;flex-shrink:0">'+
      '<button id="susp-remove-all-btn" class="btn btn-sm" '+
        'style="font-size:11px;background:var(--accent);color:#fff;border-radius:7px;padding:5px 10px;white-space:nowrap">'+
        '전체 제거</button>'+
      '<button id="susp-toast-close" class="btn btn-ghost btn-sm" '+
        'style="font-size:11px;border-radius:7px;padding:4px 10px">'+
        '닫기</button>'+
    '</div>';

  document.body.appendChild(el);

  // 전체 제거 버튼 — suspicious 각 항목의 '다음 항목'(오감지)을 제거
  el.querySelector('#susp-remove-all-btn').addEventListener('click', ()=>{
    // 뒤에서부터 제거해야 인덱스 밀림 없음
    const indices=[];
    S.tocItems.forEach((t,i)=>{ if(t.suspicious && i+1<S.tocItems.length) indices.push(i+1); });
    // 중복 제거 후 내림차순
    const toRemove=[...new Set(indices)].sort((a,b)=>b-a);
    toRemove.forEach(i=>S.tocItems.splice(i,1));
    renderTocItems();
    updateTocStat();
    el.remove();
    Toast.success('오감지 챕터 '+toRemove.length+'개를 목차에서 제거했어요.');
  });

  // 닫기
  el.querySelector('#susp-toast-close').addEventListener('click', ()=>el.remove());

  // 10초 후 자동 닫기
  setTimeout(()=>el?.remove(), 10000);
}

function renderTocItems(){
  let _tocDragSrc=null; // 드래그 소스 인덱스 (renderTocItems 스코프)
  const c=document.getElementById('tb0');c.innerHTML='';
  if(!S.tocItems.length){c.innerHTML='<div class="toc-empty">⚠️ 챕터가 감지되지 않았습니다.</div>';return;}

  const total=S.tocItems.length;
  const HEAD=5, TAIL=5;
  const alwaysShow=new Set();
  for(let i=0;i<Math.min(HEAD,total);i++) alwaysShow.add(i);
  for(let i=Math.max(0,total-TAIL);i<total;i++) alwaysShow.add(i);

  // ── 드래그 상태 ──
  let _dragSrcIdx=null;

  function buildTocRow(item, i, isHidden){
    const d=document.createElement('div');
    d.className='toc-item'+(item.enabled?'':' off');
    d.dataset.idx=i;
    if(isHidden) d.style.display='none';
    d.draggable=true;

    // 드래그 핸들
    const handle=document.createElement('span');
    handle.className='toc-drag-handle';
    handle.textContent='⠿';
    handle.title='드래그해서 순서 변경';

    // 체크박스
    const chk=document.createElement('input');
    chk.type='checkbox'; chk.className='toc-chk'; chk.checked=item.enabled;
    chk.addEventListener('change',e=>{e.stopPropagation();S.tocItems[i].enabled=e.target.checked;d.classList.toggle('off',!e.target.checked);updateTocStat();});

    // 줄 번호
    const num=document.createElement('span');
    num.className='toc-num'; num.textContent=item.line+'줄';

    // 제목 인라인 편집 input
    const titleInp=document.createElement('input');
    titleInp.className='toc-title-edit';
    titleInp.value=item.title;
    titleInp.title='클릭해서 제목 편집';
    titleInp.addEventListener('click',e=>e.stopPropagation());
    titleInp.addEventListener('change',e=>{
      const newTitle=e.target.value.trim()||item.title;
      // ★ 처음 편집 시 originalTitle 저장 (splitChapters 제목 매핑용)
      if(!S.tocItems[i].originalTitle) S.tocItems[i].originalTitle=S.tocItems[i].title;
      S.tocItems[i].title=newTitle;
    });
    titleInp.addEventListener('keydown',e=>{
      if(e.key==='Enter'){e.target.blur();}
      if(e.key==='Escape'){e.target.value=S.tocItems[i].title;e.target.blur();}
    });

    // 오감지 배지 + 제거 버튼
    if(item.suspicious){
      // ── 본문 짧음 경고 배지 ──
      const badge=document.createElement('span');
      badge.style.cssText=
        'font-size:9px;background:#fff3cd;color:#856404;border-radius:3px;'+
        'padding:1px 6px;flex-shrink:0;white-space:nowrap;cursor:default;'+
        'border:1px solid #f0c040;display:inline-flex;align-items:center;gap:3px';
      badge.innerHTML='<span>⚠</span><span>본문 짧음</span>';
      badge.title='이 챕터 본문이 50자 미만이에요 — 오감지일 수 있어요';

      // ── 개별 제거 버튼 ──
      const removeBtn=document.createElement('button');
      removeBtn.className='btn btn-sm';
      removeBtn.style.cssText=
        'font-size:9px;padding:1px 7px;flex-shrink:0;'+
        'background:var(--accent-bg);color:var(--accent);'+
        'border:1px solid var(--accent);border-radius:4px;line-height:1.5;'+
        'white-space:nowrap;transition:all .15s';
      removeBtn.innerHTML='✕&nbsp;제거';
      removeBtn.title='이 항목을 목차에서 제거합니다';
      removeBtn.addEventListener('mouseenter',()=>{
        removeBtn.style.background='var(--accent)';
        removeBtn.style.color='#fff';
      });
      removeBtn.addEventListener('mouseleave',()=>{
        removeBtn.style.background='var(--accent-bg)';
        removeBtn.style.color='var(--accent)';
      });
      removeBtn.addEventListener('click', e=>{
        e.stopPropagation();
        const idx=S.tocItems.indexOf(item);
        // suspicious 항목(idx) 다음 항목(idx+1)이 오감지 — 그것을 제거
        if(idx>=0 && idx+1 < S.tocItems.length) S.tocItems.splice(idx+1, 1);
        renderTocItems();
        updateTocStat();
        const remaining=S.tocItems.filter(t=>t.suspicious).length;
        if(remaining===0) document.getElementById('susp-toast')?.remove();
        else {
          const countEl=document.querySelector('#susp-toast b');
          if(countEl) countEl.textContent=remaining;
        }
      });

      d.appendChild(handle);d.appendChild(chk);d.appendChild(num);
      d.appendChild(titleInp);d.appendChild(badge);d.appendChild(removeBtn);
    } else {
      d.appendChild(handle);d.appendChild(chk);d.appendChild(num);d.appendChild(titleInp);
    }

    // 드래그 이벤트 — 상위 스코프 _tocDragSrc 사용
    d.addEventListener('dragstart',e=>{
      dragSrcI=i; _tocDragSrc=i;
      d.classList.add('dragging');
      e.dataTransfer.effectAllowed='move';
    });
    d.addEventListener('dragend',()=>{
      d.classList.remove('dragging');
      document.querySelectorAll('.toc-item.drag-over').forEach(el=>el.classList.remove('drag-over'));
    });
    d.addEventListener('dragover',e=>{
      e.preventDefault();
      if(_tocDragSrc===null||_tocDragSrc===i) return;
      document.querySelectorAll('.toc-item.drag-over').forEach(el=>el.classList.remove('drag-over'));
      d.classList.add('drag-over');
    });
    d.addEventListener('drop',e=>{
      e.preventDefault();
      const src=_tocDragSrc;
      if(src===null||src===i){_tocDragSrc=null;return;}
      const moved=S.tocItems.splice(src,1)[0];
      const dest=src<i?i-1:i;
      S.tocItems.splice(dest,0,moved);
      _tocDragSrc=null;
      renderTocItems();
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
  const total=S.tocItems.length;
  const active=S.tocItems.filter(t=>t.enabled).length;
  const suspCount=S.tocItems.filter(t=>t.suspicious).length;

  // 일괄 제거 버튼 — '본문 짧음' 항목이 있을 때만 표시
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
    '<span style="font-size:11px;color:var(--text2);margin-left:auto">총 '+total+'개 · 활성 '+active+'개</span>';
}
function toggleTocItem(i,v){S.tocItems[i].enabled=v;renderTocItems();}
function toggleAllToc(v){S.tocItems.forEach(t=>t.enabled=v);renderTocItems();}
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

// ── 스마트 패턴 변환: Gemini AI 또는 로컬 로직 ──
let _smartPatTimer=null;
let _smartPatAbort=null;   // 진행 중인 Gemini 요청 취소용
let _eSmartPatAbort=null;  // EPUB 탭용

function smartPatConvert(){
  // 디바운스: 입력 멈춘 후 600ms에 실행
  clearTimeout(_smartPatTimer);
  const include=document.getElementById('smartPatInput')?.value.trim()||'';
  const exclude=document.getElementById('smartPatExclude')?.value.trim()||'';
  if(!include){
    document.getElementById('smartPatResultBox').style.display='none';
    return;
  }
  // 이전 진행 중인 요청 취소 (병렬 중복 요청 방지)
  if(_smartPatAbort) _smartPatAbort.abort();
  _smartPatTimer=setTimeout(()=>_runSmartPat(include,exclude), 600);
}

async function _runSmartPat(include, exclude){
  const resultBox=document.getElementById('smartPatResultBox');
  const resultEl=document.getElementById('smartPatResult');
  const applyBtn=document.getElementById('smartPatApplyBtn');
  const aiLabel=document.getElementById('smartPatAiLabel');

  const apiKey=(document.getElementById('geminiApiKey')?.value||'').trim();

  // 병렬 요청 방지: 이전 실행 취소 후 새 컨트롤러 등록
  if(_smartPatAbort) _smartPatAbort.abort();
  const abortCtrl=new AbortController();
  _smartPatAbort=abortCtrl;

  if(apiKey){
    // ── Gemini API 호출 ──
    resultBox.style.display='flex';
    resultBox.style.borderColor='var(--border)';
    resultEl.textContent='⏳ AI 변환 중...';
    applyBtn.style.display='none';
    if(aiLabel) aiLabel.style.display='none';

    try{
      const rx=await _askGeminiForPattern(apiKey, include, exclude);
      if(rx){
        resultEl.textContent=rx;
        resultBox.style.borderColor='var(--accent)';
        applyBtn.style.display='';
        if(aiLabel) aiLabel.style.display='';
      } else {
        resultEl.textContent='(AI가 정규식을 생성하지 못했어요 — 다시 시도하거나 직접 입력)';
        resultBox.style.borderColor='var(--border)';
        applyBtn.style.display='none';
      }
    }catch(e){
      const msg=e.message||'';
      if(msg==='quota_exceeded'){
        Toast.warn(
          'Gemini API 할당량 초과 — 내장 변환 로직을 사용해요.<br>'+
          '<small style="opacity:.8">💡 Free Tier 일일 한도(1,500회/day) 초과 시 내일 초기화돼요.<br>'+
          '오류 메시지에 <b>limit: 0</b>이 포함되면 Google AI Studio 키인지 확인해주세요.</small>'
        );
        _applyLocalPattern(include, resultBox, resultEl, applyBtn, aiLabel);
      } else if(msg.includes('API 키가 올바르지 않아요')){
        resultBox.style.display='flex';
        resultBox.style.borderColor='var(--accent)';
        resultEl.textContent='⚠ '+msg;
        applyBtn.style.display='none';
        if(aiLabel) aiLabel.style.display='none';
      } else {
        // 네트워크 오류 등 → 로컬 fallback
        console.warn('Gemini API 오류:', e);
        _applyLocalPattern(include, resultBox, resultEl, applyBtn, aiLabel);
      }
    }
  } else {
    // ── 로컬 로직 fallback ──
    _applyLocalPattern(include, resultBox, resultEl, applyBtn, aiLabel);
  }
}

function _applyLocalPattern(include, resultBox, resultEl, applyBtn, aiLabel){
  const rx=guessPatternFromExample(include);
  resultBox.style.display='flex';
  if(aiLabel) aiLabel.style.display='none';
  if(rx){
    resultEl.textContent=rx;
    resultBox.style.borderColor='var(--accent)';
    applyBtn.style.display='';
  } else {
    resultEl.textContent='(인식 불가 — 정규식 수정 탭에서 직접 입력)';
    resultBox.style.borderColor='var(--border)';
    applyBtn.style.display='none';
  }
}

// Gemini API 모델 우선순위 목록 (앞부터 시도)
// Gemini 모델 목록 — 순서대로 fallback
// Free Tier RPM: gemini-2.0-flash 15/min, gemini-1.5-flash 15/min, gemini-1.5-flash-8b 15/min
// Free Tier RPD: gemini-2.0-flash 1500/day, gemini-1.5-flash 1500/day, gemini-1.5-flash-8b 1500/day
const GEMINI_MODELS = [
  { id: 'gemini-2.0-flash',    maxTokens: 200, tier: 'primary'   },
  { id: 'gemini-1.5-flash',    maxTokens: 200, tier: 'fallback1' },
  { id: 'gemini-1.5-flash-8b', maxTokens: 200, tier: 'fallback2' },
];

// 모델별 마지막 429 발생 시각 추적 (분당 RPM 관리)
const _geminiModelCooldown = {};;

async function _askGeminiForPattern(apiKey, include, exclude){
  // ── 프롬프트 압축 (토큰 절약) ──
  // 조건 설명을 최소화, 한국어 대신 짧은 영문 지시어 사용
  // 기존 ~220자(~55토큰) → ~120자(~30토큰) 절약
  const excPart=exclude?'\nNOT match:\n'+exclude:'';
  const prompt=
    'JS regex for novel chapter titles.\n'+
    'Match:\n'+include+excPart+
    '\nReturn regex only, no flags, no slashes, use ^$.\n'+
    'Example: ^\\d+화(?:\\s*.+)?$';

  // 예시 입력이 너무 길면 앞 3줄만 사용 (과도한 토큰 사용 방지)
  const includeLines=include.split('\n').filter(Boolean);
  const truncatedInclude=includeLines.slice(0,3).join('\n');
  const truncatedPrompt=includeLines.length>3
    ? prompt.replace(include, truncatedInclude+'\n(+'+(includeLines.length-3)+' more)')
    : prompt;

  const body=JSON.stringify({
    contents:[{parts:[{text:truncatedPrompt}]}],
    generationConfig:{temperature:0.1, maxOutputTokens:80} // 200→80: 정규식 1줄만 필요
  });

  // 모델 순서대로 시도 — cooldown 중인 모델 스킵
  for(const m of GEMINI_MODELS){
    const modelId=m.id||m; // 문자열/객체 모두 지원
    // 세션 내 영구 차단된 모델 스킵
    if(_geminiModelCooldown[modelId]===Infinity){
      console.info('[Gemini] '+modelId+' cooldown 중, 스킵');
      continue;
    }
    const url='https://generativelanguage.googleapis.com/v1beta/models/'+modelId
      +':generateContent?key='+apiKey;
    const result=await _geminiRequest(url, body, modelId);
    if(result.ok) return result.rx;
    if(result.fatal) throw new Error(result.msg);
    // quota/error → 다음 모델
  }
  throw new Error('quota_exceeded');
}

// ── Gemini 단일 요청 (지수 백오프 포함) ──
// maxRetries: 같은 모델을 재시도할 최대 횟수 (429 일시적 RPM 초과 시)
async function _geminiRequest(url, body, modelId, maxRetries=2){
  for(let attempt=0; attempt<=maxRetries; attempt++){
    let res;
    try{ res=await fetch(url,{method:'POST',headers:{'Content-Type':'application/json'},body}); }
    catch(e){ return {ok:false,fatal:false,msg:e.message}; }

    if(res.ok){
      const data=await res.json();
      const raw=(data?.candidates?.[0]?.content?.parts?.[0]?.text||'').trim();
      const cleaned=raw
        .replace(/```[\w]*/g,'').replace(/```/g,'')
        .replace(/^\/(.+)\/[gimsuy]*$/, '$1')
        .trim();
      if(!cleaned) return {ok:false,fatal:false,msg:'empty'};
      try{ new RegExp(cleaned,'i'); return {ok:true,rx:cleaned}; }
      catch(e){ return {ok:false,fatal:false,msg:'invalid_regex'}; }
    }

    const status=res.status;
    const errBody=await res.json().catch(()=>({}));
    const errMsg=errBody?.error?.message||String(status);
    const violations=errBody?.error?.details
      ?.find(d=>d['@type']?.includes('QuotaFailure'))?.violations||[];

    // 401 / 403: 키 오류 — 즉시 중단 (재시도 불필요)
    if(status===401||status===403){
      const hint=errMsg.includes('free_tier')||violations.some(v=>v.quotaId?.includes('FreeTier'))
        ? '\n\n💡 hint: limit:0 오류는 Google AI Studio 키(AIza...)가 아닌\n   Google Cloud API 키를 사용하면 발생해요.\n   https://aistudio.google.com/app/apikey 에서 발급한 키를 사용해주세요.'
        : '';
      return {ok:false,fatal:true,msg:'API 키가 올바르지 않아요.'+hint};
    }

    // 429: quota 초과 분류
    if(status===429){
      // Free Tier limit:0 → 이 모델은 이 프로젝트에서 영구 차단 상태
      // quota violations에 limit:0 확인
      const isHardLimit=errMsg.includes('limit: 0')||
        violations.some(v=>v.quotaId?.includes('FreeTier')&&
          (errMsg.match(new RegExp('model:\s*'+modelId))));

      if(isHardLimit){
        // 재시도해도 의미 없음 → 즉시 다음 모델로
        console.warn('[Gemini] '+modelId+' Free Tier 영구 한도 초과 (limit:0) — 다음 모델로 전환');
        _geminiModelCooldown[modelId]=Infinity; // 이 세션에서 이 모델 사용 안 함
        return {ok:false,fatal:false,msg:'hard_quota',model:modelId};
      }

      // 일시적 RPM 초과 → 지수 백오프 후 재시도
      // API가 알려준 retryDelay 우선, 없으면 지수 백오프
      const retryMatch=errMsg.match(/retry(?:\s*after|\s*in)?\s*([\d.]+)\s*s/i);
      const retryInfoDelay=errBody?.error?.details
        ?.find(d=>d['@type']?.includes('RetryInfo'))?.retryDelay;
      const retryInfoSec=retryInfoDelay?parseFloat(retryInfoDelay.replace('s','')):null;

      const baseWait=retryInfoSec
        ? retryInfoSec*1000                  // API 지정 시간
        : retryMatch
          ? parseFloat(retryMatch[1])*1000   // 메시지 파싱
          : 1000 * Math.pow(2, attempt);     // 지수 백오프: 1s, 2s, 4s

      // Free Tier 일일 한도 초과(RPD)는 재시도 의미 없음 → 다음 모델
      const isDailyLimit=violations.some(v=>v.quotaId?.includes('PerDay'));
      if(isDailyLimit||attempt>=maxRetries){
        console.info('[Gemini] '+modelId+' 일일/분당 한도 초과 — 다음 모델로');
        return {ok:false,fatal:false,msg:'quota_exceeded',model:modelId};
      }

      const waitMs=Math.min(baseWait, 30000); // 최대 30초 대기
      console.info('[Gemini] '+modelId+' 일시적 RPM 초과, '
        +Math.round(waitMs/1000)+'초 후 재시도 ('+attempt+'/'+maxRetries+')...');
      await new Promise(r=>setTimeout(r,waitMs));
      continue; // 같은 모델 재시도
    }

    // 404: 모델 없음 → 다음 모델
    if(status===404) return {ok:false,fatal:false,msg:'model_not_found'};

    // 500/503: 서버 오류 → 짧게 대기 후 재시도
    if(status>=500&&attempt<maxRetries){
      const waitMs=1000*(attempt+1);
      console.info('[Gemini] '+modelId+' 서버 오류('+status+'), '+waitMs/1000+'초 후 재시도...');
      await new Promise(r=>setTimeout(r,waitMs));
      continue;
    }

    return {ok:false,fatal:false,msg:errMsg};
  }
  return {ok:false,fatal:false,msg:'max_retries_exceeded'};
}

function applySmartPat(){
  const rx=document.getElementById('smartPatResult')?.textContent;
  if(!rx||rx.startsWith('(')) return;
  document.getElementById('pattern').value=rx;
  clearChipSelection('patHelper');
  document.getElementById('smartPatInput').value='';
  document.getElementById('smartPatExclude').value='';
  document.getElementById('smartPatResultBox').style.display='none';
  previewToc();
}

// 예시 문자열에서 정규식 추론
function guessPatternFromExample(ex){
  // ── 1. Zero-padded 숫자 + 공백2개 이상 + 제목 (예: 00001  제로 코드...)
  if(/^\d{3,6}\s{2,}/.test(ex)){
    const m=ex.match(/^(\d+)\s{2,}/);
    const digits=m[1].length;
    // 고정 자릿수라면 정확히 N자리, 아니면 \d+ 사용
    const numPat=m[1].startsWith('0')
      ? `\\d{${digits}}`   // zero-padded → 고정 자릿수
      : '\\d+';
    return `^${numPat}\\s{2,}.+$`;
  }

  // ── 2. [EP.001] / [EP.1] / [ep.12]
  if(/^\[(?:EP|Ep|ep)\.\d+\]/.test(ex))
    return '^\\[(?:EP|Ep|ep)\\.\\d+\\](?:\\s*.+)?$';

  // ── 3. [Prologue] / [Epilogue] / [Side Story] 등 대괄호 영문 단어
  if(/^\[[A-Za-z가-힣]/.test(ex)&&/\]/.test(ex)){
    if(!/\d/.test(ex))
      return '^\\[(?:Prologue|Epilogue|Side|Extra|프롤로그|에필로그|외전)(?:\\s*.+)?\\](?:\\s*.+)?$';
    const inner=ex.replace(/^\[/,'').replace(/\].*$/,'').trim();
    const prefix=inner.replace(/\d+.*$/,'').trim().replace(/[.*+?^${}()|[\]\\]/g,'\\$&');
    return '^\\['+prefix+'\\d+\\](?:\\s*.+)?$';
  }

  // ── 4. N화 / 제N화 / #N화
  if(/^#?(?:제\s*)?\d+\s*화/.test(ex))
    return '^#?(?:제\\s*)?\\d+\\s*화(?:\\s*.+)?$';

  // ── 5. 소설명+N화 (예: EX급 마법사의 귀환 001화) — N화보다 앞에 검사
  if(/^.{2,30}\s+\d+화/.test(ex)){
    const prefix=ex.replace(/\s+\d+화.*$/,'').trim().replace(/[.*+?^${}()|[\]\\]/g,'\\$&');
    return '^'+prefix+'\\s+\\d+화(?:\\s*.+)?$';
  }

  // ── 6. N. 제목 (숫자+점+공백)
  if(/^\d+\.\s+/.test(ex))
    return '^\\d+\\.\\s+.{1,60}$';

  // ── 7. Chapter N / Part N / Ch N
  if(/^(?:chapter|part|ch)\s*\d+/i.test(ex))
    return '^(?:chapter|part|ch)\\s*\\d+(?:\\s*.+)?$';

  // ── 8. #N. 제목
  if(/^#\d+\.\s+/.test(ex))
    return '^#\\d+\\.\\s+.{1,60}$';

  // ── 9. 숫자만 한 줄
  if(/^\d+$/.test(ex))
    return '^\\d+$';

  // ── 10. 프롤로그/에필로그류
  if(/^(?:프롤로그|에필로그|외전|후일담|prologue|epilogue)/i.test(ex))
    return '^(?:프롤로그|에필로그|외전|후일담|prologue|epilogue)(?:\\s*.+)?$';

  // ── 11. 소설(숫자) → 제목 (N)
  if(/\(\d+\)\s*$/.test(ex))
    return '^.{1,60}\\s*\\(\\d+\\)\\s*$';

  // ── 12. 숫자 + 공백1개 이상 + 제목 (일반형 — 위에서 미처리된 경우)
  if(/^\d+\s+\S/.test(ex)){
    const m=ex.match(/^(\d+)\s+/);
    const numPat=m[1].startsWith('0')&&m[1].length>1?`\\d{${m[1].length}}`:'\\d+';
    return `^${numPat}\\s+.+$`;
  }

  return null;
}

// ── 빠른 선택 칩 → 패턴 적용 ──
function applySelectedChips(){
  const sel=_chipSelected['patHelper'];
  if(!sel||!sel.size){Toast.warn('빠른 선택에서 패턴을 먼저 선택해주세요.');return;}
  const combined=buildCombinedPat(sel);
  document.getElementById('pattern').value=combined;
  previewToc();
}

// ══════════════════════════════════════════
// 🕘 Module: History (IndexedDB 영속화)
// ══════════════════════════════════════════
// blob은 메모리, 메타만 localStorage에 저장
// ══════════════════════════════════════════
// 히스토리 — IndexedDB 영속화
// 세션 만료 없이 새로고침 후에도 재다운로드 가능 (최대 20건)
// ══════════════════════════════════════════
const HIST_DB_NAME='novelepub_hist', HIST_DB_VER=1, HIST_STORE='blobs';
let _histDB=null;

function openHistDB(){
  if(_histDB) return Promise.resolve(_histDB);
  return new Promise((res,rej)=>{
    const req=indexedDB.open(HIST_DB_NAME,HIST_DB_VER);
    req.onupgradeneeded=e=>{
      const db=e.target.result;
      if(!db.objectStoreNames.contains(HIST_STORE)) db.createObjectStore(HIST_STORE);
    };
    req.onsuccess=e=>{_histDB=e.target.result;res(_histDB);};
    req.onerror=()=>rej(req.error);
  });
}
async function idbSet(key,val){
  try{
    const db=await openHistDB();
    return new Promise((res,rej)=>{
      const tx=db.transaction(HIST_STORE,'readwrite');
      tx.objectStore(HIST_STORE).put(val,key);
      tx.oncomplete=res; tx.onerror=()=>rej(tx.error);
    });
  }catch(e){console.warn('IDB set failed:',e);}
}
async function idbGet(key){
  try{
    const db=await openHistDB();
    return new Promise((res,rej)=>{
      const tx=db.transaction(HIST_STORE,'readonly');
      const req=tx.objectStore(HIST_STORE).get(key);
      req.onsuccess=()=>res((req.result!=null?req.result:null));
      req.onerror=()=>rej(req.error);
    });
  }catch(e){return null;}
}
async function idbDel(key){
  try{
    const db=await openHistDB();
    return new Promise((res,rej)=>{
      const tx=db.transaction(HIST_STORE,'readwrite');
      tx.objectStore(HIST_STORE).delete(key);
      tx.oncomplete=res; tx.onerror=()=>rej(tx.error);
    });
  }catch(e){}
}
async function idbClear(){
  try{
    const db=await openHistDB();
    return new Promise((res,rej)=>{
      const tx=db.transaction(HIST_STORE,'readwrite');
      tx.objectStore(HIST_STORE).clear();
      tx.oncomplete=res; tx.onerror=()=>rej(tx.error);
    });
  }catch(e){}
}

async function saveHistory(entry){
  const key='hist_'+Date.now();
  await idbSet(key, entry.blob);
  let metas=loadHistMetas();
  metas.unshift({key,title:entry.title,author:entry.author,chapterCount:entry.chapterCount,
    sizeMB:entry.sizeMB,elapsed:entry.elapsed,date:entry.date,name:entry.name});
  if(metas.length>20){
    metas.slice(20).forEach(m=>idbDel(m.key));
    metas=metas.slice(0,20);
  }
  try{localStorage.setItem('epub_history',JSON.stringify(metas));}catch(e){}
}
function loadHistMetas(){
  try{return JSON.parse(localStorage.getItem('epub_history')||'[]');}catch(e){return [];}
}
async function renderHistory(){
  const c=document.getElementById('histList'); if(!c) return;
  const metas=loadHistMetas();
  if(!metas.length){
    c.innerHTML='<div class="hist-empty">📭 아직 변환 기록이 없어요.<br>TXT→EPUB 탭에서 변환하면 여기에 저장돼요.</div>';
    return;
  }
  c.innerHTML='<div style="text-align:center;padding:12px 0;font-size:11px;color:var(--text2)">⏳ 로딩 중...</div>';
  const blobExists=await Promise.all(metas.map(m=>idbGet(m.key).then(b=>!!b).catch(()=>false)));
  c.innerHTML='';
  metas.forEach((m,idx)=>{
    const row=document.createElement('div');
    row.className='hist-item';
    const hasBlob=blobExists[idx];
    row.innerHTML=
      '<div class="hist-thumb">📚</div>'+
      '<div class="hist-info">'+
        '<div class="hist-title">'+escHtml(m.title)+(m.author?'<span style="font-weight:400;color:var(--text2);font-size:11px"> / '+escHtml(m.author)+'</span>':'')+'</div>'+
        '<div class="hist-meta">'+m.date+' · '+m.chapterCount+'화 · '+m.sizeMB+'MB · '+m.elapsed+'초</div>'+
      '</div>'+
      (hasBlob
        ?'<button class="btn btn-green btn-sm" data-action="histDownload" data-key="'+m.key+'" data-name="'+escHtml(m.name)+'">⬇ 다운로드</button>'
        :'<span style="font-size:11px;color:var(--text2);white-space:nowrap">파일 없음</span>')+
      '<button class="hist-del" data-action="deleteHistory" data-key="'+m.key+'" title="기록 삭제">✕</button>';
    c.appendChild(row);
  });
}
async function histDownload(key,name){
  const blob=await idbGet(key);
  if(!blob){
    document.querySelectorAll('.hist-item').forEach(row=>{
      if(row.innerHTML.includes(key)){
        const btn=row.querySelector('.btn-green');
        if(btn){btn.textContent='❌ 파일 없음';btn.disabled=true;}
      }
    });
    return;
  }
  const url=URL.createObjectURL(blob);
  const a=document.createElement('a');
  a.href=url; a.download=name; a.click();
  setTimeout(()=>URL.revokeObjectURL(url),1000);
}
async function deleteHistory(key){
  await idbDel(key);
  let metas=loadHistMetas().filter(m=>m.key!==key);
  try{localStorage.setItem('epub_history',JSON.stringify(metas));}catch(e){}
  renderHistory();
}
async function clearAllHistory(){
  if(!await Toast.confirm('모든 변환 기록을 삭제할까요?')) return;
  await idbClear();
  try{localStorage.removeItem('epub_history');}catch(e){}
  renderHistory();
}

// ══════════════════════════════════════════
// 👁  Module: ChapterPreview (챕터 본문 미리보기)
// ══════════════════════════════════════════
let _previewActiveIdx=-1;
let _fullRawLines=[];  // 전체 파일 원본 줄 (미리보기용)

async function renderTocPreview(){
  const c=document.getElementById('tocPreviewList');
  if(!c) return;
  const enabled=S.tocItems.filter(t=>t.enabled);
  if(!enabled.length){c.innerHTML='<div class="toc-empty">감지된 목차가 없어요.<br>정규식 탭에서 패턴을 수정하거나 자동 간격 분할을 시도해보세요.</div>';return;}

  // 전체 파일 텍스트 로드 (캐시) — 다중 파일 모두 병합 (previewToc와 동일 처리)
  if(!_fullRawLines.length&&S.txtFiles.length){
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

  for(let ch=0;ch<totalChapters;ch++){
    const lineNum=Math.floor(ch*interval)+1; // 1-based
    const title='Chapter '+(ch+1);
    found.push({line:lineNum, title, enabled:true, autoSplit:true});
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
  document.getElementById('tb2').innerHTML='<pre class="toc-raw">'+
    lines.map((l,i)=>String(i+1).padStart(4,' ')+' | '+escHtml(l)).join('\n')+'</pre>';
  // 자동 분할 결과 중 본문 짧음 감지
  const _autoSuspCount=S.tocItems.filter(t=>t.suspicious).length;
  if(_autoSuspCount>0) showSuspiciousToast(_autoSuspCount);
}
