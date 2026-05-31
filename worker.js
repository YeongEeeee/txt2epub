/**
 * worker.js — NovelEPUB 텍스트 처리 전담 Web Worker
 *
 * 담당 작업:
 *   1. DETECT_ENCODING  : ArrayBuffer → 인코딩 추론 (UTF-8 / EUC-KR / UTF-16)
 *   2. DECODE_TEXT      : ArrayBuffer + encoding → 문자열
 *   3. PARSE_CHAPTERS   : 텍스트 + 패턴 → [[heading, body], ...] 챕터 배열
 *
 * 메인 스레드와 통신:
 *   postMessage({ type, id, payload })   ← 요청
 *   postMessage({ type:'RESULT'|'ERROR'|'PROGRESS', id, result, error }) → 응답
 *
 * ★ 이 Worker는 main.js 없이 독립 실행됨 (DOM 접근 없음)
 */

'use strict';

// ══════════════════════════════════════════
// 1. 인코딩 감지 (detectEncoding 이식)
// ══════════════════════════════════════════
function detectEncoding(buffer){
  const bytes = new Uint8Array(buffer.slice(0, 65536));

  // BOM 체크
  if(bytes[0]===0xEF && bytes[1]===0xBB && bytes[2]===0xBF) return 'utf-8';
  if(bytes[0]===0xFF && bytes[1]===0xFE) return 'utf-16le';
  if(bytes[0]===0xFE && bytes[1]===0xFF) return 'utf-16be';

  // UTF-8 유효성 검사 (오류율 기반)
  let utf8Errors=0, totalMultibyte=0;
  let i=0;
  const limit=bytes.length-3;
  while(i<limit){
    const b=bytes[i];
    if(b<0x80){i++;continue;}
    if(b>=0xC2 && b<=0xDF){
      if((bytes[i+1]&0xC0)===0x80){totalMultibyte++;i+=2;continue;}
    } else if(b>=0xE0 && b<=0xEF){
      if((bytes[i+1]&0xC0)===0x80 && (bytes[i+2]&0xC0)===0x80){totalMultibyte++;i+=3;continue;}
    } else if(b>=0xF0 && b<=0xF4){
      if(i+3<limit&&(bytes[i+1]&0xC0)===0x80&&(bytes[i+2]&0xC0)===0x80&&(bytes[i+3]&0xC0)===0x80){
        totalMultibyte++;i+=4;continue;
      }
    }
    utf8Errors++;i++;
  }

  const errorRate=utf8Errors/Math.max(totalMultibyte,1);
  if(errorRate<0.001) return 'utf-8';

  // EUC-KR vs UTF-8 비교
  const utf8Text=new TextDecoder('utf-8',{fatal:false}).decode(bytes);
  const eucText =new TextDecoder('euc-kr',{fatal:false}).decode(bytes);
  const utf8Bad =(utf8Text.match(/\ufffd/g)||[]).length;
  const eucBad  =(eucText.match(/\ufffd/g)||[]).length;

  if(utf8Bad===0) return 'utf-8';
  return utf8Bad<=eucBad ? 'utf-8' : 'euc-kr';
}

// ══════════════════════════════════════════
// 2. 텍스트 디코딩 (fileToText 이식)
// ══════════════════════════════════════════
function decodeText(buffer, enc){
  const decoder=new TextDecoder(enc,{fatal:false});
  const text=decoder.decode(new Uint8Array(buffer));

  // UTF-8로 판정했는데 깨진 문자가 많으면 EUC-KR로 재시도
  if(enc==='utf-8'){
    const badCount=(text.match(/\ufffd/g)||[]).length;
    if(badCount>10){
      const text2=new TextDecoder('euc-kr',{fatal:false}).decode(new Uint8Array(buffer));
      const bad2=(text2.match(/\ufffd/g)||[]).length;
      return bad2<badCount ? text2 : text;
    }
  }
  return text;
}

// ══════════════════════════════════════════
// 3. 챕터 파싱 (splitChapters 경량 이식)
// ══════════════════════════════════════════
// 전처리 함수
function preprocessLine(raw){
  return raw.trim()
    .replace(/^[\[\(\-\s]+/,'').replace(/[\]\)\-\s]+$/,'')
    .replace(/\s{2,}/g,' ').trim();
}

// 연속성 가중치
function calcSequenceWeight(nums){
  if(nums.length<2) return 0;
  let c=0;
  for(let i=1;i<nums.length;i++){
    const p=nums[i-1],n=nums[i];
    if(p!=null && n!=null && (n===p+1||n===p)) c++;
  }
  return c/(nums.length-1);
}

// 키워드 패턴 — parser.js KEYWORD_PATS와 동기화
// 패턴 감지 여부와 무관하게 항상 목차로 인식해야 하는 특수 챕터들
const KEYWORD_PATS=[
  // ★ 기존
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
  // ★ 신규
  /^(?:막간|인터루드|interlude)(?:\s*[^\r\n]{0,80})?$/i,
  /^(?:공지|공지사항)(?:\s*[^\r\n]{0,80})?$/,
  /^(?:설정집|일러스트|캐릭터\s*소개|등장인물|세계관\s*설정)(?:\s*[^\r\n]{0,80})?$/,
  /^(?:특별편|스페셜|단편)(?:\s*[^\r\n]{0,80})?$/,
  /^(?:extra|bonus)(?:\s*(?:chapter|episode|story))?(?:\s*[^\r\n]{0,60})?$/i,
];

// 베스트 패턴 추론 — parser.js PATS와 동기화
// ⚠️ ReDoS 방어: 꼬리 허용자 최대 80자 고정 (?:\s*[^\r\n]{0,80})?
const PATS=[
  // ── 최우선: 명확한 형식 ──
  {rx:/^\[(?:EP|Ep|ep)\.\d+\](?:\s*.+)?$/},
  {rx:/^\[(?:Prologue|Epilogue|Side|Extra|프롤로그|에필로그|외전)(?:\s*.+)?\](?:\s*.+)?$/i},
  {rx:/^\[\s*.+\.txt\s*\]\s*$/i},
  {rx:/^\d{3,6}\s{2,}.+$/},
  {rx:/^[〈<]\s*\d+\s*화\s*[〉>](?:\s*.+)?$/i},
  // ★ 신규: 【N화】 전각 대괄호
  {rx:/^【\s*\d+\s*화\s*】(?:\s*[^\r\n]{0,80})?$/},
  // ★ 신규: ◆●★ 특수문자+N화
  {rx:/^[◆●◇○■□▶▷►◀◁★☆♠♦♣♥]\s*\d+\s*화(?:\s*[^\r\n]{0,80})?$/},
  // ★ 신규: (N화)/(N장) 소괄호
  {rx:/^\(\s*제?\s*\d+\s*[화장]\s*\)(?:\s*[^\r\n]{0,80})?$/},

  // ── 화/장 번호 계열 ──
  {rx:/^제\s*\d+\s*화(?:\s*.+)?$/},
  {rx:/^제\s*\d+\s*장(?:\s*.+)?$/},
  {rx:/^제\s*[一二三四五六七八九十百千\d]+\s*[화장話章](?:\s*.+)?$/},
  {rx:/^\d+화(?:\s*.+)?$/},
  {rx:/^\d+장(?:\s*.+)?$/},
  {rx:/^\[\s*제?\s*\d+\s*화\s*\](?:\s*.+)?$/},
  {rx:/^\[\s*제?\s*\d+\s*장\s*\](?:\s*.+)?$/},
  {rx:/^#?(?:제\s*)?\d+\s*화(?:\s*.+)?$/i},
  {rx:/^\d+화\.\s*.+$/},
  {rx:/^={2,}\s*\[제\s*\d+\s*화\]\s*={0,}$/i},
  // ★ 신규: 001화 zero-pad
  {rx:/^0+\d+화(?:\s*[^\r\n]{0,80})?$/},
  // ★ 신규: N화~N화 범위
  {rx:/^\d+화?\s*[-~]\s*\d+화(?:\s*[^\r\n]{0,80})?$/},
  // ★ 신규: 시즌N N화
  {rx:/^(?:시즌\s*\d+|S\d+)\s+\d+화(?:\s*[^\r\n]{0,80})?$/},
  // ★ 신규: 제N편 / N편
  {rx:/^제\s*\d+\s*편(?:\s*[^\r\n]{0,80})?$/},
  {rx:/^\d+편(?:\s*[^\r\n]{0,80})?$/},

  // ── 챕터/파트 계열 ──
  {rx:/^(?:chapter|part|ch)\.?\s*\d+(?:\s*.+)?$/i},
  {rx:/^(?:EP|Ch|Scene|Act)\.?\s*\d+(?:\s*.+)?$/i},
  {rx:/^[1-9]부\s+(?:\d+화|프롤로그)(?:\s*.+)?$/},
  {rx:/^S\d+E\d+(?:\s*.+)?$/i},
  // ★ 신규: Chapter One 문자 서수
  {rx:/^(?:chapter|part|ch)\s+(?:one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve)(?:\s*[^\r\n]{0,60})?$/i},
  // ★ 신규: Chap.N
  {rx:/^chap\.?\s*\d+(?:\s*[^\r\n]{0,80})?$/i},
  // ★ 신규: Book N
  {rx:/^book\s+(?:\d+|one|two|three|four|five)(?:\s*[^\r\n]{0,80})?$/i},
  // ★ 신규: Nst/nd/rd/th Story
  {rx:/^\d+(?:st|nd|rd|th)\s+(?:story|episode|chapter|part|tale)(?:\s*[^\r\n]{0,80})?$/i},
  // ★ 신규: Volume N
  {rx:/^vol(?:ume)?\.?\s*\d+(?:\s*[^\r\n]{0,80})?$/i},
  // ★ 신규: Part I 로마 숫자
  {rx:/^(?:part|section|book)\s+(?:I{1,3}|IV|VI{0,3}|IX|X{1,3}|XI{0,3}|XIV|XV|XVI{0,3}|XIX|XX{0,3}|XXX(?:I{0,3}|V|VI{0,3}|IX)?)(?:\s*[^\r\n]{0,80})?$/i},

  // ── 특수 키워드 ──
  {rx:/^서장(?:\s*.+)?$/},{rx:/^종장(?:\s*.+)?$/},
  {rx:/^서문(?:\s*.+)?$/},{rx:/^서론(?:\s*.+)?$/},
  {rx:/^(?:프롤로그|프롤)(?:\s*.+)?$/i},
  {rx:/^(?:에필로그|에필)(?:\s*.+)?$/i},
  {rx:/^외전(?:\s*.+)?$/},{rx:/^번외(?:\s*.+)?$/},
  {rx:/^후기(?:\s*.+)?$/},{rx:/^작가\s*후기(?:\s*.+)?$/},
  {rx:/^작가의\s*말(?:\s*.+)?$/},{rx:/^작가\s*노트(?:\s*.+)?$/},
  {rx:/^(?:prologue|epilogue|afterword|author.?s?\s*note)(?:\s*.+)?$/i},
  // ★ 신규: 막간/인터루드
  {rx:/^(?:막간|인터루드|interlude)(?:\s*[^\r\n]{0,80})?$/i},
  // ★ 신규: 간주/幕間
  {rx:/^(?:간주|幕間)(?:\s*[^\r\n]{0,80})?$/},
  // ★ 신규: 공지
  {rx:/^(?:공지|공지사항|작가의\s*글|작가\s*공지)(?:\s*[^\r\n]{0,80})?$/},
  // ★ 신규: 설정집/일러스트/부록류
  {rx:/^(?:설정집|일러스트|캐릭터\s*소개|등장인물|세계관\s*설정)(?:\s*[^\r\n]{0,80})?$/},
  // ★ 신규: 특별편/스페셜/단편
  {rx:/^(?:특별편|스페셜|단편|외전\s*\d*)(?:\s*[^\r\n]{0,80})?$/},
  // ★ 신규: Side Story/Extra/Bonus
  {rx:/^(?:side\s*story|extra\s*(?:chapter|episode)?|bonus\s*(?:chapter|episode)?)(?:\s*\d*)?(?:\s*[^\r\n]{0,80})?$/i},
  // ★ 신규: 첫 번째 이야기 서수형
  {rx:/^(?:첫|두|세|네|다섯|여섯|일곱|여덟|아홉|열)\s*번째\s*(?:이야기|장|화|편|챕터)(?:\s*[^\r\n]{0,60})?$/},
  // ★ 신규: 제 일/이/삼 화 한글 서수
  {rx:/^제\s*(?:일|이|삼|사|오|육|칠|팔|구|십)\s*[화장편](?:\s*[^\r\n]{0,60})?$/},

  // ── 숫자+점 형식 ──
  {rx:/^\d+\.\s+.{1,60}$/},
  {rx:/^#\d+\.\s+.{1,60}$/},
  // ★ 신규: N) 제목
  {rx:/^\d+\)\s+[^\r\n]{1,60}$/},
  // ★ 신규: 01. zero-pad 점
  {rx:/^0+\d+\.\s+[^\r\n]{1,60}$/},

  // ── 제목 형식 ──
  {rx:/^.{1,60}\s*\(\d+\)\s*$/},
  {rx:/^(?:제\s*\d+\s*장|第\s*\d+\s*章)(?:\s*.+)?$/},
  {rx:/^【.+】.*$/},
  {rx:/^#{1,3}\s*.+$/},
  {rx:/^[■▶◆●►▷◇★☆]\s*.{2,40}$/},
  {rx:/^第\s*[\d一二三四五六七八九十百千]+\s*[章話话](?:\s*.+)?$/},
  // ★ 신규: 第N幕/節
  {rx:/^第\s*[\d一二三四五六七八九十百千]+\s*[幕節](?:\s*[^\r\n]{0,80})?$/},
  // ★ 신규: ≪N화≫ 겹낫표
  {rx:/^[≪《]\s*\d+\s*화\s*[≫》](?:\s*[^\r\n]{0,80})?$/},
  // ★ 신규: 「N화」 낫표
  {rx:/^[「『]\s*\d+\s*화\s*[」』](?:\s*[^\r\n]{0,80})?$/},

  // ── 기타 형식 ──
  {rx:/^(?:EP|제|Chapter|Ch|디|Scene|Prologue)\.?\s*\d+/i},
  {rx:/^\d{1,3}\.\s*.+$/},
  {rx:/^\d+권(?:\s*.+)?$/},
  {rx:/^.*[=\-]{3,}$/},
  {rx:/^[\*\-─]+\s*\d+화?\s*[\*\-─]+$/},
  {rx:/^(?:시즌\s*\d+\s+)?\d+화(?:\s*.+)?$/},
  {rx:/^\((?:외전|번외|특별편|side|bonus)\)/i},
  {rx:/^(?:\s?〈\s?\d+화\s?〉|EP\.\d+|(?=\d+화)\d+화|\d+)[^\r\n]*/},
  // ★ 신규: - N - 대시 구분자
  {rx:/^[-─—]{1,3}\s*\d+\s*[-─—]{1,3}$/},
  // ★ 신규: ─── 제목 ─── 샌드위치
  {rx:/^[-─=]{2,}\s*[^\r\n]{1,60}\s*[-─=]{2,}$/},
  // ★ 신규: <N>/[N]/{N} 괄호 단독 숫자
  {rx:/^(?:<\d{1,6}>|\[\d{1,6}\]|\{\d{1,6}\})$/},
];

function bestPat(raw){
  const lines=raw.split('\n');
  const totalLines=lines.length;
  const tailStart=Math.floor(totalLines*0.90);
  let bestRx=null,bestScore=0,bestName='';

  for(const p of PATS){
    const matches=[];
    let score=0;
    for(let i=0;i<lines.length;i++){
      const t=preprocessLine(lines[i]);
      if(t&&p.rx.test(t)){
        const tail=i>=tailStart;
        matches.push({i,t,tail});
        score+=(tail?0.3:1);
      }
    }
    if(score>bestScore&&matches.length>=2){
      bestScore=score; bestRx=p.rx; bestName=p.rx.toString();
    }
  }
  return {rx:bestRx,name:bestName,cnt:bestScore};
}

function splitChapters(raw, customPat='', opts={}){
  const {mergeShortLines=false}=opts;

  // 정규화
  raw=raw.replace(/\r\n/g,'\n').replace(/\r/g,'\n')
    .replace(/\xad/g,'\u2014')
    .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F]/g,'')
    .replace(/[\uFFFE\uFFFF]/g,'');

  // 짧은 줄 병합
  if(mergeShortLines){
    const rawLines=raw.split('\n');
    const merged=[];let buf='';
    for(let i=0;i<rawLines.length;i++){
      const t=rawLines[i];
      if(t.trim()&&t.trim().length<30&&!t.trim().match(/^[-=*─]{3,}$/)){
        buf+=(buf?' ':'')+t.trim();
        if(!rawLines[i+1]?.trim()||rawLines[i+1].trim().length>=30){
          merged.push(buf);buf='';
        }
      }else{
        if(buf){merged.push(buf);buf='';}
        merged.push(t);
      }
    }
    if(buf) merged.push(buf);
    raw=merged.join('\n');
  }

  // 패턴 결정
  let rx=null;
  if(customPat&&customPat.trim()){
    try{rx=new RegExp(customPat.trim(),'i');}catch(e){rx=null;}
  }
  if(!rx){const r=bestPat(raw);rx=r.rx;}

  // 패턴 없음 폴백: 페이지 분할
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

  // KEYWORD_PATS OR 결합
  if(rx){
    const kwSrc=KEYWORD_PATS.map(k=>k.source).join('|');
    rx=new RegExp('(?:'+rx.source+'|'+kwSrc+')','i');
  }

  const rawLines=raw.split('\n');
  const chapters=[];
  let cur=null,body=[];
  const seenHeadings=new Map();
  const sepRx=/^[-=*─━~·.‒—]{3,}\s*$|^[─━═]{2,}$/;

  for(let li=0;li<rawLines.length;li++){
    const line=rawLines[li];
    const t=preprocessLine(line);
    if(t&&rx.test(t)){
      const prevCount=seenHeadings.get(t)||0;
      seenHeadings.set(t,prevCount+1);
      const uniqueTitle=prevCount===0?t:`${t} (${prevCount+1})`;
      while(body.length&&(sepRx.test(body[body.length-1].trim())||body[body.length-1].trim()===''))
        body.pop();
      if(cur===null&&body.length>0) chapters.push(['서문',body.join('\n').trim()]);
      else if(cur!==null) chapters.push([cur,body.join('\n').trim()]);
      cur=uniqueTitle;body=[];
      let ni=li+1;
      while(ni<rawLines.length&&sepRx.test(rawLines[ni].trim())) ni++;
      if(ni>li+1) li=ni-1;
    }else{
      body.push(line);
    }
  }
  if(cur!==null) chapters.push([cur,body.join('\n').trim()]);
  else if(body.length>0) chapters.push(['본문',body.join('\n').trim()]);

  // 빈 챕터 필터링
  const filtered=chapters.filter(([,b])=>b.trim().length>0);
  return filtered.length?filtered:[['본문','']];
}

// ══════════════════════════════════════════
// 메시지 핸들러
// ══════════════════════════════════════════
self.onmessage = async function(e){
  const { type, id, payload } = e.data;

  try{
    switch(type){

      // ── 인코딩 감지 ──
      case 'DETECT_ENCODING': {
        // payload: { buffer: ArrayBuffer }
        const enc = detectEncoding(payload.buffer);
        self.postMessage({ type:'RESULT', id, result:{ encoding: enc } });
        break;
      }

      // ── 텍스트 디코딩 ──
      case 'DECODE_TEXT': {
        // payload: { buffer: ArrayBuffer, encoding?: string }
        let enc = payload.encoding;
        if(!enc) enc = detectEncoding(payload.buffer);
        const text = decodeText(payload.buffer, enc);
        self.postMessage(
          { type:'RESULT', id, result:{ text, encoding: enc } },
          // ★ 대용량 텍스트는 Transferable로 반환하면 좋지만 string은 불가
          // → 대신 buffer는 이미 처리 완료이므로 별도 transfer 불필요
        );
        break;
      }

      // ── 인코딩 감지 + 디코딩 통합 ──
      case 'FILE_TO_TEXT': {
        // payload: { buffer: ArrayBuffer }
        // Transferable: buffer를 Worker가 소유 받음
        const enc2 = detectEncoding(payload.buffer);
        const text2 = decodeText(payload.buffer, enc2);
        self.postMessage({ type:'RESULT', id, result:{ text: text2, encoding: enc2 } });
        break;
      }

      // ── 챕터 파싱 ──
      case 'PARSE_CHAPTERS': {
        // payload: { raw: string, customPat?: string, opts?: object }
        const { raw, customPat='', opts={} } = payload;
        const total = (raw.match(/\n/g)||[]).length;
        const CHUNK = 5000;

        // 진행률 알림 (파싱 중)
        for(let i=0;i<total;i+=CHUNK){
          if(i>0){
            self.postMessage({
              type:'PROGRESS', id,
              pct: Math.floor(i/total*80),
              msg: `파싱 중... (${i}/${total}줄)`
            });
            // 비동기 yield — Worker 내부에서 메시지 큐 처리 기회
            await new Promise(r=>setTimeout(r,0));
          }
        }

        const chapters = splitChapters(raw, customPat, opts);
        self.postMessage({ type:'RESULT', id, result:{ chapters } });
        break;
      }

      // ── 파일 여러 개 통합 처리 ──
      case 'PROCESS_FILES': {
        // payload: { buffers: ArrayBuffer[], customPat?: string, opts?: object }
        const { buffers, customPat='', opts={} } = payload;
        const texts = [];

        for(let i=0;i<buffers.length;i++){
          const enc = detectEncoding(buffers[i]);
          const text = decodeText(buffers[i], enc);
          texts.push(text);
          self.postMessage({
            type:'PROGRESS', id,
            pct: Math.floor((i+1)/buffers.length*50),
            msg: `파일 읽기 중... (${i+1}/${buffers.length})`
          });
        }

        const raw = texts.join('\n\n');
        self.postMessage({ type:'PROGRESS', id, pct:55, msg:'챕터 분리 중...' });

        // 파싱
        await new Promise(r=>setTimeout(r,0));
        const chapters = splitChapters(raw, customPat, opts);

        self.postMessage({ type:'RESULT', id, result:{ chapters, raw } });
        break;
      }

      default:
        self.postMessage({
          type:'ERROR', id,
          error: `Unknown message type: ${type}`
        });
    }
  }catch(err){
    self.postMessage({ type:'ERROR', id, error: err.message||String(err) });
  }
};
