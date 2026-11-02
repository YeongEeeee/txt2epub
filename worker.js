/**
 * worker.js — NovelEPUB 텍스트 처리 전담 Web Worker
 *
 * 담당 작업:
 *   FILE_TO_TEXT : ArrayBuffer + 인코딩(payload.enc, 메인 스레드가 감지) → 디코딩 → 문자열
 *                  (convert.js TextWorker가 5MB 이상 파일에서 사용)
 *                  ★ Phase 12: 인코딩 감지는 convert.js 단일 소스 — 이 파일의 복사본 제거
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
// 1. 인코딩 감지 — ★ Phase 12: 제거 (단일 소스 = convert.js _detectEncodingFromAB)
//   메인 스레드(fileToText)가 항상 감지한 인코딩(payload.enc)을 함께 보냄.
//   이전에는 같은 감지 로직이 여기와 convert.js에 두 벌 있어 한쪽만 고치면 결과가 달라질 위험이 있었음.
//   enc가 없는 예외 상황은 UTF-8로 디코딩 후 decodeText()의 EUC-KR 재시도가 보정.
// ══════════════════════════════════════════

// ★ Phase 10: 개수만 필요 — match(/x/g)처럼 일치 배열을 만들지 않음
function countChar(text, ch){
  let n=0, i=-1;
  while((i=text.indexOf(ch,i+1))!==-1) n++;
  return n;
}

// ══════════════════════════════════════════
// 2. 텍스트 디코딩 (fileToText 이식)
// ══════════════════════════════════════════
function decodeText(buffer, enc){
  const decoder=new TextDecoder(enc,{fatal:false});
  const text=decoder.decode(new Uint8Array(buffer));

  // UTF-8로 판정했는데 깨진 문자가 많으면 EUC-KR로 재시도
  if(enc==='utf-8'){
    const badCount=countChar(text,'\ufffd');
    if(badCount>10){
      const text2=new TextDecoder('euc-kr',{fatal:false}).decode(new Uint8Array(buffer));
      const bad2=countChar(text2,'\ufffd');
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
        // ★ Phase 12: 인코딩은 메인 스레드가 감지해 전달 (없으면 UTF-8 → decodeText가 EUC-KR 재시도)
        const enc2 = payload.enc || 'utf-8';
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
