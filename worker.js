/**
 * worker.js — NovelEPUB 텍스트 처리 전담 Web Worker
 *
 * 담당 작업:
 *   FILE_TO_TEXT : ArrayBuffer → 인코딩 추론(UTF-8 / EUC-KR / UTF-16) + 디코딩 → 문자열
 *                  (convert.js TextWorker가 5MB 이상 파일에서 사용)
 *
 * ★ 챕터 파싱은 이 파일에서 하지 않음 — parser.js가 단일 소유하며,
 *   대용량 파싱 Worker는 parser.js buildParserWorkerSource()로 생성됨
 *   (이전의 PATS·bestPat·splitChapters 복사본과 미사용 메시지 타입
 *    DETECT_ENCODING / DECODE_TEXT / PARSE_CHAPTERS / PROCESS_FILES 제거)
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
// 메시지 핸들러
// ══════════════════════════════════════════
self.onmessage = async function(e){
  // ★ W-01: Worker 내 고스트 에러 방지
  // onmessage 전체를 try-catch로 감싸는 것만으로는 부족
  // 아래 try-catch가 내부 switch 오류를 모두 포착하지만,
  // 비동기 예외(await 중 발생)도 outer try-catch로 잡힘
  const { type, id, payload } = e.data;

  try{
    switch(type){

      // ── 인코딩 감지 + 디코딩 통합 ──
      case 'FILE_TO_TEXT': {
        const enc2 = detectEncoding(payload.buffer);
        const text2 = decodeText(payload.buffer, enc2);
        // ★ W-02: 처리 완료 후 buffer 참조 해제
        payload.buffer = null;
        self.postMessage({ type:'RESULT', id, result:{ text: text2, encoding: enc2 } });
        break;
      }

      default:
        self.postMessage({
          type:'ERROR', id,
          error: `Unknown message type: ${type}`
        });
    }
  }catch(err){
    // ★ W-01: 스택 트레이스 포함 에러 전송 — 고스트 에러 방지
    // err.stack이 없는 브라우저 환경에서도 err.message 폴백 보장
    self.postMessage({
      type:'ERROR', id,
      error: err.stack || err.message || String(err)
    });
  }
};
