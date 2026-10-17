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

/* global S, Toast, yieldToMain,
   _chaptersCache, _chaptersCacheKey, _fullRawLines,
   renderTocItems, tocTab, fileToText, sampleLines */

'use strict';

// ════════════════════════════════════════════════════════
// ★ 간격 분할 상태 접근자 — window 단일 소유권 보장
// convert.js가 window._autoSplitActive를 먼저 정의하고,
// parser.js는 동일한 window 프로퍼티를 읽고 씁니다.
// ★ 절대로 로컬 let 변수로 섀도잉하지 마세요.
// ════════════════════════════════════════════════════════
// _autoSplitActive 접근 헬퍼 (read/write 모두 window 경유)
function _getAutoSplitActive(){ return window._autoSplitActive===true; }
function _setAutoSplitActive(v){ window._autoSplitActive=!!v; }
// ★ Phase 10: window._autoSplitActive 단일 정의 — 값은 StateManager('convert' 스토어 _autoSplitActive)에 보관
//   core.js(StateManager)는 이 파일 뒤에 로드되지만 접근은 런타임에만 일어나므로 지연 참조로 충분
//   (스토어 생성 전 접근 시 false / 쓰기는 무시)
if(!Object.getOwnPropertyDescriptor(window,'_autoSplitActive')){
  Object.defineProperty(window,'_autoSplitActive',{
    get(){ return typeof _sStore!=='undefined'&&_sStore.get()._autoSplitActive===true; },
    set(v){ if(typeof _sStore!=='undefined') _sStore.set({_autoSplitActive:!!v}); },
    configurable:true,
  });
}

// _autoSplitLines: parser.js 소유, window에도 미러
// (convert.js에서 읽어야 하는 경우 window._autoSplitLines 참조)
// _fullRawLines:   parser.js 소유, window에도 미러

// ★ FIX-07: SUSP_THRESHOLD는 상수 대신 함수로만 사용 — 설정 변경이 즉시 반영됨
// ★ B4/I4: 짧은 챕터 기준 — localStorage + DOM 슬라이더 실시간 반영 (기본값 50자)
function getSuspThreshold(){
  // 1순위: DOM 슬라이더 (설정 페이지에서 드래그 중인 값)
  const slider = typeof document !== 'undefined' && document.getElementById('suspThresholdSlider');
  if(slider) { const v = parseInt(slider.value); if(!isNaN(v) && v > 0) return v; }
  // 2순위: localStorage
  try{ const v = parseInt(localStorage.getItem('novelepub_susp_threshold')||'50',10); return v||50; }catch(e){ return 50; }
}
// ════════════════════════════════════════════════════════════
// ★ HTML 특수문자 이스케이프 유틸리티
//
// 설계 원칙 (#1~#10 전체 반영):
//   #1  Strict Escaping: & → &amp; 1순위 (#2 이중치환 방지)
//   #2  앰퍼샌드 1순위 처리: &amp;lt; 오염 원천 차단
//   #4  웹소설 특수 괄호(【】〔〕≪≫❰❱ 등) 내부 <> 동일 처리
//   #7  정규식 사전 컴파일 (루프 외부 — GC 부하 차단)
//   #8  유령 공백 정규화와 결합 (sanitizeLine에서 처리)
//   #9  목차 타이틀·본문 모두 동일 함수 사용
// ════════════════════════════════════════════════════════════

// ★ #7: 루프 외부 정규식 사전 컴파일
const _RX_AMP  = /&/g;
const _RX_LT   = /</g;
const _RX_GT   = />/g;
const _RX_QUOT = /"/g;
const _RX_APOS = /'/g;

// ★ #5: DOM 기반 안전 이스케이프 백업 폴백
function _escHtmlViaDOM(s){
  try{
    const d=document.createElement('div');
    d.textContent=String(s);
    return d.innerHTML;
  }catch(e){ return String(s); }
}

// ★ escHtml — 주 함수
// 처리 순서: & → &amp; (1순위) → < → &lt; → > → &gt; → " → &quot; → ' → &#39;
// #9: 글로벌 플래그(g)로 한 줄에 여러 번 등장해도 전부 치환 (#9 요구사항)
function escHtml(s){
  if(typeof s!=='string') return '';
  try{
    return s
      .replace(_RX_AMP,  '&amp;')   // #2: 반드시 1순위 — &lt; 재오염 방지
      .replace(_RX_LT,   '&lt;')    // #1: < → &lt;
      .replace(_RX_GT,   '&gt;')    // #1: > → &gt;
      .replace(_RX_QUOT, '&quot;')  // #4: " → &quot;
      .replace(_RX_APOS, '&#39;');  // #4: ' → &#39; (XML 속성 파괴 방지)
  }catch(e){
    // #10: 예외 시 DOM 폴백
    return _escHtmlViaDOM(s);
  }
}
// ── 공통 본문 HTML 변환 함수 (bodyToHtml · bToHtml 통합) ──
// useItalic: 대화/회상 이탤릭 여부 · maxBlank: 연속 빈줄 최대 허용 수
// ════════════════════════════════════════════════════════════
// ★ sanitizeLine — 텍스트 라인 정규화
//
// #8  유령 공백(\r, U+200B, U+FEFF 등) 제거
// #3  태그 오인 방지: <...> 형태는 escHtml이 처리하므로 여기선 XML 제어문자만 제거
// #6  잘못된 엔티티(&undefined; 등) 사전 제거
// #8  EUC-KR 디코딩 후 특수문자 주변 제로너비 공백 제거
// ════════════════════════════════════════════════════════════
// ★ Phase 10: 제거 대상 한 번에 처리 — 제로너비 문자·XML 비허용 제어문자·U+FFFE/FFFF·짝 없는 서로게이트
//   (이전: [\uD800-\uDFFF] 전체 삭제 → 정상 서로게이트 쌍인 이모지·확장 한자까지 사라짐)
//   첫 분기([고위][저위])가 정상 쌍을 먼저 소비하므로 콜백에서 길이 2는 보존, 나머지는 삭제
//   (lookbehind 미사용 — Safari 16.4 미만 구문 오류 방지)
const _RX_SANITIZE=/[\uD800-\uDBFF][\uDC00-\uDFFF]|[\u200B\u200C\u200D\uFEFF\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F\uFFFE\uFFFF\uD800-\uDFFF]/g;
function sanitizeLine(s){
  if(typeof s!=='string') return '';
  // U+00AD soft hyphen → em dash (대화 표시)
  s=s.replace(/\u00ad/g,'\u2014');
  // ★ Phase 10: NBSP(U+00A0)는 '공백'이므로 일반 공백으로 (이전: 삭제 → '단어 단어'가 '단어단어'로 붙음)
  s=s.replace(/\u00A0/g,' ');
  // ★ B-FIX-10: 제로너비 문자는 '' 로 제거 (예: "스킬이름<ZWS>표시" → "스킬이름표시")
  // XML 1.0 비허용 제어문자 · U+FFFE/FFFF · 짝 없는 서로게이트 제거 (정상 쌍은 보존)
  s=s.replace(_RX_SANITIZE, m=>m.length===2?m:'');
  // 후행 공백 제거
  return s.trimEnd();
}

// ★ Phase 10: 웹에서 긁어온 TXT의 HTML 엔티티(&amp; &lt; &#39; &nbsp; …)를 문자로 되돌린 뒤 escHtml 1회 적용
//   (이전: 엔티티가 하나라도 있으면 줄 전체 이스케이프를 건너뜀 → 같은 줄의 날것 '<'가 XHTML에 그대로 들어가
//    리더기에서 챕터 전체가 파싱 오류)
const _RX_ENTITY=/&(?:#(\d{1,7})|#[xX]([\da-fA-F]{1,6})|(amp|lt|gt|quot|apos|nbsp));/g;
const _NAMED_ENTITY={amp:'&',lt:'<',gt:'>',quot:'"',apos:'\'',nbsp:' '};
function _decodeHtmlEntities(s){
  if(typeof s!=='string'||s.indexOf('&')<0) return s;
  return s.replace(_RX_ENTITY,(m,dec,hex,name)=>{
    if(name) return _NAMED_ENTITY[name];
    const cp=dec!=null?parseInt(dec,10):parseInt(hex,16);
    // 무효 코드포인트(0·서로게이트·범위 밖)는 원문 유지 → escHtml이 &amp;로 안전 처리
    if(!cp||cp>0x10FFFF||(cp>=0xD800&&cp<=0xDFFF)) return m;
    return String.fromCodePoint(cp);
  });
}

// ════════════════════════════════════════════════════════════
// ★ renderBodyHtml — 본문 텍스트 → XHTML body HTML 변환
//
// 파이프라인: sanitizeLine → escHtml → <p> 래핑
// #1  escHtml이 모든 < > & " ' 를 이스케이프 — 순서 보장
// #5  이중 이스케이프 방지: 엔티티(&lt; 등)를 먼저 문자로 복원한 뒤 escHtml 1회 (Phase 10)
// #8  charCount(글자수)는 이스케이프 전 원본 기준 계산 (독립성 유지)
// #10 예외 격리: 챕터 전체 깨짐 방지 try-catch
// ════════════════════════════════════════════════════════════

// ★ Phase 10: renderBodyHtml은 메인 스레드·EPUB Worker 공용 단일 소스
//   epub-gen.js _buildWorkerSrc()가 toString()으로 Worker에 이식 — 외부 심볼은
//   escHtml·_escHtmlViaDOM·sanitizeLine·_decodeHtmlEntities와 _RX_* 상수만 참조할 것
//   (이전: Worker에 손으로 복사한 문자열 사본이 있었고, 그 사본의 정규식 오타(\\u226a)로
//    '2층 [창고]'처럼 숫자로 시작해 ]로 끝나는 본문 줄이 시스템 메시지 스타일이 됨)
const _RX_SYSMSG_OPEN  = /^(?:【|〔|\[|≪|❰)/;
const _RX_SYSMSG_CLOSE = /(?:】|〕|\]|≫|❱)\s*$/;
const _RX_FLASHBACK    = /^[-\u2014\u2012\u2013─]/;

function renderBodyHtml(body, {useItalic=true, maxBlank=2, removeBlankLines=false}={}){
  // #10: 예외 격리 — 이 함수가 실패해도 원본 텍스트로 폴백
  try{
    // ★ Phase 10: 문자열 += 대신 배열 join (긴 챕터에서 중간 문자열 생성 감소)
    const out=[];
    let blankRun=0;
    // CRLF → LF 정규화
    const rawLines=body.replace(/\r\n/g,'\n').replace(/\r/g,'\n').split('\n');

    // ★ Part2: 본문 공백 최적화 전처리
    // removeBlankLines=true: 3줄+ 연속 빈줄 → maxBlank줄로 압축
    // 정규식 치환 대신 라인 배열 순회로 구현 — Backtracking 부하 없음
    let lines;
    if(removeBlankLines){
      lines=[];
      let blankCount=0;
      // maxBlank가 1이면 연속 빈줄을 최대 1줄로, 2이면 최대 2줄로 압축
      const blankLimit = Math.max(1, maxBlank-1); // 실제 허용 연속 빈줄 수
      for(const l of rawLines){
        const isEmpty=!l.trim();
        if(isEmpty){
          blankCount++;
          // blankLimit 초과분은 버림 (연속 빈줄 압축)
          if(blankCount<=blankLimit) lines.push(l);
        } else {
          blankCount=0;
          lines.push(l);
        }
      }
      // ★ Part2 GC: 원본 배열 참조 해제 (대용량 소설 메모리 정체 방지)
      rawLines.length=0;
    } else {
      lines=rawLines;
    }

    for(const line of lines){
      // #8: 엔티티 복원 → sanitizeLine(유령 공백·제어문자 제거) → escHtml 1회 (이중 이스케이프·날것 '<' 모두 방지)
      const t=sanitizeLine(_decodeHtmlEntities(line)).trim();

      if(!t){
        blankRun++;
        if(blankRun < maxBlank) out.push('<p>&#160;</p>\n');
        continue;
      }
      blankRun=0;

      const escaped = escHtml(t);

      if(useItalic&&_RX_FLASHBACK.test(t)){
        // 회상/대사 이탤릭 — 전체 이스케이프 후 em 태그 래핑
        out.push('<p class="noindent"><em class="flashback">'+escaped+'</em></p>\n');
      } else if(_RX_SYSMSG_OPEN.test(t)&&_RX_SYSMSG_CLOSE.test(t)){
        // ★ #4: 웹소설 상태창/스킬창 — 시스템 메시지 스타일
        // 여는·닫는 특수 괄호 쌍이 모두 있을 때만 sysmsg 처리
        out.push('<p class="noindent sysmsg"><em>'+escaped+'</em></p>\n');
      } else {
        out.push('<p>'+escaped+'</p>\n');
      }
    }
    return out.join('');
  }catch(err){
    // #10: 예외 격리 폴백 — 원본을 escHtml만 적용해서 반환
    console.warn('[renderBodyHtml] 예외 발생, 안전 폴백 적용:', err);
    try{
      return String(body||'').split('\n').map(l=>{
        const t=sanitizeLine(_decodeHtmlEntities(l)).trim();
        return t ? '<p>'+escHtml(t)+'</p>\n' : '';
      }).join('');
    }catch(e2){
      // 최후 폴백: 원본 텍스트를 escHtml 처리 후 단일 p로 반환
      return '<p>'+escHtml(String(body||''))+'</p>\n';
    }
  }
}
// handleCustomFont → settings.js (customFontName/customFontFace 전역 상태 소유)

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
/* createVirtualScroll — ui-state.js 단일 정의 (★ 이전 parser.js 폴백 사본은 ui-state.js 로드 시 항상 덮어써져 실행되지 않는 코드였음) */


// ════════════════════════════════════════════════════════════════════════
// 📌 PATS — 챕터 감지 정규식 패턴 집합
//
// ⚠️ ReDoS 방어 설계 원칙 (전 패턴 공통 적용)
//   1. 줄 앞에 반드시 ^ 앵커 — 전체 줄 미매칭 시 O(1)로 즉시 실패(fail-fast)
//   2. .*/.+ 수량자를 독립 그룹 끝 꼬리 위치에만 허용 — 절대 중첩 금지
//      ✅ 안전: /^키워드(?:\s*.+)?$/  (꼬리 단 한 곳에만 .+)
//      ❌ 위험: /^(.+화)+.+$/        (중첩 수량자 → 지수 백트래킹)
//   3. 문자 클래스 [一-龥]처럼 범위가 큰 것은 필요한 목록으로 명시
//   4. 숫자 파트: \d+ 는 단독 사용 — (\d+)+ 형태 금지
//   5. 꼬리 제목 허용자 (?:\s*[^\r\n]{0,80})? 를 .* 대신 사용
//      — 최대 80자로 상한을 고정해 백트래킹 폭발 원천 차단
//
// 📐 구성 규칙
//   • 기존 48종 패턴은 원래 순서·내용 그대로 100% 유지 (★ 기존 표시)
//   • 신규 패턴은 각 그룹 끝에 추가 (★ 신규 표시)
//   • 꼬리 허용자는 (?:\s*[^\r\n]{0,80})? 를 각 정규식에 직접 기입 (ReDoS-safe tail)
// ════════════════════════════════════════════════════════════════════════

const PATS=[
  // ════════════════════════════════════════════════════════════════
  // ★ 기존 그룹 1: 최우선 — 명확한 형식
  // ════════════════════════════════════════════════════════════════

  // ★ 기존: [EP.001] / [EP.1] — 대괄호+EP+점+숫자 형식
  // 예) "[EP.001] 새벽의 검사"
  [/^\[(?:EP|Ep|ep)\.\d+\](?:\s*.+)?$/,               '[EP.N] 형식'],

  // ★ 기존: [Prologue] / [프롤로그] 등 특수 키워드 대괄호 형식
  // 예) "[Prologue] 시작"  "[외전] 번외편"
  [/^\[(?:Prologue|Epilogue|Side|Extra|프롤로그|에필로그|외전)(?:\s*.+)?\](?:\s*.+)?$/i, '[Prologue] 형식'],

  // ★ 기존: [ 파일명.txt ] — 다중 파일 병합 시 삽입되는 파일명 구분자
  // 예) "[ 0001_어떤소설.txt ]"
  [/^\[\s*.+\.txt\s*\]\s*$/i,                         '[ 파일명.txt ] 형식'],

  // ★ 기존: 001  제목 (영어 zero-pad + 2칸 이상 공백 + 제목)
  // 예) "001  서막"  "0023  제목"
  [/^\d{3,6}\s{2,}.+$/,                               'NNN  제목 형식 (zero-pad)'],

  // ★ 기존: 〈N화〉 / <N화> 꺽쇠 형식
  // 예) "〈1화〉 어둠의 서막"  "<12화>"
  [/^[〈<]\s*\d+\s*화\s*[〉>](?:\s*.+)?$/i,           '〈N화〉 꺽쇠 형식'],

  // ★ 신규: 【N화】 전각 대괄호 꺽쇠 형식 (문피아 등에서 자주 등장)
  // 예) "【1화】" "【001화】어둠의 서막"
  [/^【\s*\d+\s*화\s*】(?:\s*[^\r\n]{0,80})?$/,       '【N화】 전각 대괄호 형식'],

  // ★ 신규: ◆ N화 / ● N화 등 특수문자+숫자+화 조합 (시리즈·카카오페이지 일부)
  // 예) "◆ 1화" "● 12화 타이틀"
  [/^[◆●◇○■□▶▷►◀◁★☆♠♦♣♥]\s*\d+\s*화(?:\s*[^\r\n]{0,80})?$/, '특수문자+N화 형식'],

  // ★ 신규: (N화) / (N장) 소괄호 형식
  // 예) "(1화)" "(제12화) 어둠의 서막"
  [/^\(\s*제?\s*\d+\s*[화장]\s*\)(?:\s*[^\r\n]{0,80})?$/, '(N화) 소괄호 형식'],


  // ════════════════════════════════════════════════════════════════
  // ★ 기존 그룹 2: 화/장 번호 계열 (핵심)
  // ════════════════════════════════════════════════════════════════

  // ★ 기존: 제N화 / 제 N 화 (공백 유연)
  // 예) "제1화" "제 12 화 - 타이틀"
  [/^제\s*\d+\s*화(?:\s*.+)?$/,                       '제N화 형식'],

  // ★ 기존: 제N장 / 제 N 장
  // 예) "제1장" "제 3 장 어둠"
  [/^제\s*\d+\s*장(?:\s*.+)?$/,                       '제N장 형식'],

  // ★ 기존: 제一화 / 第一章 등 한자 숫자 혼용
  // 예) "제一화" "第三章 서막"
  [/^제\s*[一二三四五六七八九十百千\d]+\s*[화장話章](?:\s*.+)?$/, '제N화/장 (한자 번호)'],

  // ★ 기존: N화 단독
  // 예) "1화" "120화 어둠의 기사"
  [/^\d+화(?:\s*.+)?$/,                               'N화 형식'],

  // ★ 기존: N장 단독
  // 예) "1장" "5장 결말"
  [/^\d+장(?:\s*.+)?$/,                               'N장 형식'],

  // ★ 기존: [N화] / [제N화] 대괄호 형식
  // 예) "[1화]" "[제12화] 제목"
  [/^\[\s*제?\s*\d+\s*화\s*\](?:\s*.+)?$/,            '[N화] 대괄호 형식'],

  // ★ 기존: [N장] / [제N장] 대괄호 형식
  // 예) "[1장]" "[제3장]"
  [/^\[\s*제?\s*\d+\s*장\s*\](?:\s*.+)?$/,            '[N장] 대괄호 형식'],

  // ★ 기존: #N화 / N화 통합 (#해시태그 포함)
  // 예) "#1화" "제3화" "1화 - 서막"
  [/^#?(?:제\s*)?\d+\s*화(?:\s*.+)?$/i,               '화 번호 (#N화 포함)'],

  // ★ 기존: N화. 제목 (리디북스 스타일)
  // 예) "1화. 어둠의 시작"
  [/^\d+화\.\s*.+$/,                                  '화. 제목 (리디북스형)'],

  // ★ 기존: === [제N화] === 구분선 스타일
  // 예) "==[제1화]==" "====[제12화]"
  [/^={2,}\s*\[제\s*\d+\s*화\]\s*={0,}$/i,            '=== [제N화] ==='],

  // ★ 신규: N화 앞에 0-패딩 허용 (001화, 0001화 등) — 노벨피아·조아라
  // 예) "001화" "0023화 제목" (기존 \d+화 패턴에서 이미 처리되나,
  //     zero-pad 명시적 패턴으로 가중치 우선화)
  [/^0+\d+화(?:\s*[^\r\n]{0,80})?$/,                  '001화 zero-pad 형식'],

  // ★ 신규: N화-N화 연속 범위 형식 (연재분 묶음)
  // 예) "1화~3화" "11화 - 13화" "001-003화"
  [/^\d+화?\s*[-~]\s*\d+화(?:\s*[^\r\n]{0,80})?$/,    'N화~N화 범위 형식'],

  // ★ 신규: 시즌N N화 / S2 1화 (시즌제 웹소설 — 시리즈·카카오)
  // 예) "시즌2 1화" "S2 12화 서막"
  [/^(?:시즌\s*\d+|S\d+)\s+\d+화(?:\s*[^\r\n]{0,80})?$/, '시즌N N화 형식'],

  // ★ 신규: 제N편 (편 단위 분류 — 단행본·문학 계열)
  // 예) "제1편" "제 3 편 결말부"
  [/^제\s*\d+\s*편(?:\s*[^\r\n]{0,80})?$/,            '제N편 형식'],

  // ★ 신규: N편 단독
  // 예) "1편" "3편 어둠"
  [/^\d+편(?:\s*[^\r\n]{0,80})?$/,                    'N편 형식'],


  // ════════════════════════════════════════════════════════════════
  // ★ 기존 그룹 3: 챕터/파트 계열
  // ════════════════════════════════════════════════════════════════

  // ★ 기존: Chapter N / Part N / Ch.N 영문 챕터
  // 예) "Chapter 1" "Part 12 The Dark" "Ch.3"
  [/^(?:chapter|part|ch)\.?\s*\d+(?:\s*.+)?$/i,       'Chapter/Part'],

  // ★ 기존: EP.N / Ch.N / Scene N / Act N
  // 예) "EP.001" "Scene 3" "Act IV"
  [/^(?:EP|Ch|Scene|Act)\.?\s*\d+(?:\s*.+)?$/i,       'EP/Ch/Scene N'],

  // ★ 기존: N부 M화 / N부 프롤로그
  // 예) "1부 1화" "2부 프롤로그"
  [/^[1-9]부\s+(?:\d+화|프롤로그)(?:\s*.+)?$/,         'N부 M화'],

  // ★ 기존: S1E01 TV 에피소드 형식
  // 예) "S1E01" "S2E12 제목"
  [/^S\d+E\d+(?:\s*.+)?$/i,                           'S1E01 형식'],

  // ★ 신규: CHAPTER ONE / PART TWO — 영문 문자 서수 (대/소문자 통합)
  // 예) "CHAPTER ONE" "Chapter Two - The Darkness" "chapter three"
  // ReDoS 방어: 문자 서수를 고정 목록으로 제한 (.*없이 대체자만)
  [/^(?:chapter|part|ch)\s+(?:one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve)(?:\s*[^\r\n]{0,60})?$/i, 'Chapter One 문자 서수'],

  // ★ 신규: Chap.N / CHAP.N / chap N (약어 변형 대응)
  // 예) "Chap.1" "CHAP.12 - The Start"
  [/^chap\.?\s*\d+(?:\s*[^\r\n]{0,80})?$/i,           'Chap.N 약어 형식'],

  // ★ 신규: Book N / Book One — 단행본 권/편 구분
  // 예) "Book 1" "Book One: The Beginning"
  [/^book\s+(?:\d+|One|Two|Three|Four|Five)(?:\s*[^\r\n]{0,80})?$/i, 'Book N 형식'],

  // ★ 신규: Nst/Nd/Rd/Th Story — 영문 서수 이야기 형식
  // 예) "1st Story" "2nd Episode" "3rd Chapter"
  [/^\d+(?:st|nd|rd|th)\s+(?:story|episode|chapter|part|tale)(?:\s*[^\r\n]{0,80})?$/i, 'Nst Story 서수 형식'],

  // ★ 신규: Volume N / Vol.N — 단행본 볼륨 형식
  // 예) "Volume 1" "Vol.12" "Vol. 3 - 어둠의 계곡"
  [/^vol(?:ume)?\.?\s*\d+(?:\s*[^\r\n]{0,80})?$/i,    'Volume N 형식'],

  // ★ 신규: Part I / Part II / Part III — 로마 숫자 파트 (단행본·해외 번역)
  // ReDoS 방어: 로마 숫자 최대 39(XXXIX)까지만 허용하는 유한 목록 사용
  [/^(?:part|section|book)\s+(?:I{1,3}|IV|VI{0,3}|IX|X{1,3}|XI{0,3}|XIV|XV|XVI{0,3}|XIX|XX{0,3}|XXX(?:I{0,3}|V|VI{0,3}|IX)?)(?:\s*[^\r\n]{0,80})?$/i, 'Part I 로마 숫자 형식'],


  // ════════════════════════════════════════════════════════════════
  // ★ 기존 그룹 4: 특수 키워드 (비숫자 예외 챕터)
  // ════════════════════════════════════════════════════════════════

  // ★ 기존: 서장 (소설 첫 장)
  [/^서장(?:\s*.+)?$/,                                 '서장'],
  // ★ 기존: 종장 (소설 마지막 장)
  [/^종장(?:\s*.+)?$/,                                 '종장'],
  // ★ 기존: 서문
  [/^서문(?:\s*.+)?$/,                                 '서문'],
  // ★ 기존: 서론
  [/^서론(?:\s*.+)?$/,                                 '서론'],
  // ★ 기존: 프롤로그 / 프롤
  [/^(?:프롤로그|프롤)(?:\s*.+)?$/i,                   '프롤로그'],
  // ★ 기존: 에필로그 / 에필
  [/^(?:에필로그|에필)(?:\s*.+)?$/i,                   '에필로그'],
  // ★ 기존: 외전
  [/^외전(?:\s*.+)?$/,                                 '외전'],
  // ★ 기존: 번외
  [/^번외(?:\s*.+)?$/,                                 '번외'],
  // ★ 기존: 후기
  [/^후기(?:\s*.+)?$/,                                 '후기'],
  // ★ 기존: 작가 후기
  [/^작가\s*후기(?:\s*.+)?$/,                          '작가 후기'],
  // ★ 기존: 작가의 말
  [/^작가의\s*말(?:\s*.+)?$/,                          '작가의 말'],
  // ★ 기존: 작가 노트
  [/^작가\s*노트(?:\s*.+)?$/,                          '작가 노트'],
  // ★ 기존: prologue/epilogue/afterword/author's note 영문
  [/^(?:prologue|epilogue|afterword|author.?s?\s*note)(?:\s*.+)?$/i, '영문 특수 키워드'],

  // ★ 신규: 막간 (챕터 사이 짧은 삽화)
  // 예) "막간" "막간 - 두 사람의 이야기"
  [/^막간(?:\s*[^\r\n]{0,80})?$/,                      '막간'],

  // ★ 신규: 인터루드 / Interlude (영문 막간)
  // 예) "인터루드" "Interlude 1" "Interlude - 그날의 기억"
  [/^(?:인터루드|interlude)(?:\s*[^\r\n]{0,80})?$/i,   '인터루드/Interlude'],

  // ★ 신규: 간주 / 幕間 (일본어 번역 소설에서 막간 표기)
  // 예) "간주" "幕間" "幕間 - 그녀의 선택"
  [/^(?:간주|幕間)(?:\s*[^\r\n]{0,80})?$/,             '간주/幕間'],

  // ★ 신규: 공지 / 안내 / 작가의 글 (플랫폼 공지 구분)
  // 예) "공지" "공지사항" "작가의 글"
  [/^(?:공지|공지사항|작가의\s*글|작가\s*공지)(?:\s*[^\r\n]{0,80})?$/, '공지/작가의 글'],

  // ★ 신규: 설정집 / 일러스트 / 캐릭터 소개 (부록류)
  // 예) "설정집" "일러스트" "캐릭터 소개"
  [/^(?:설정집|일러스트|캐릭터\s*소개|등장인물|세계관\s*설정)(?:\s*[^\r\n]{0,80})?$/, '설정집/일러스트 부록'],

  // ★ 신규: 특별편 / 스페셜 / 단편 (단독 단편·특집)
  // 예) "특별편" "스페셜" "단편 - 그날의 기억"
  [/^(?:특별편|스페셜|단편|외전\s*\d*)(?:\s*[^\r\n]{0,80})?$/, '특별편/스페셜/단편'],

  // ★ 신규: Side Story N / Extra N 영문 외전 형식
  // 예) "Side Story 1" "Extra Chapter" "Bonus Episode"
  [/^(?:side\s*story|extra\s*(?:chapter|episode)?|bonus\s*(?:chapter|episode)?)(?:\s*\d*)?(?:\s*[^\r\n]{0,80})?$/i, 'Side Story/Extra 영문 외전'],

  // ★ 신규: 첫 번째 이야기 / 두 번째 장 — 한국어 서수 표현
  // 예) "첫 번째 이야기" "두 번째 장"
  // ReDoS 방어: 서수 목록을 고정 교체자로 열거 (.*없이 bounded)
  [/^(?:첫|두|세|네|다섯|여섯|일곱|여덟|아홉|열)\s*번째\s*(?:이야기|장|화|편|챕터)(?:\s*[^\r\n]{0,60})?$/, '첫 번째 이야기 서수형'],

  // ★ 신규: 제 일 장 / 제 이 화 — 한자 문자 서수 한글 표기
  // 예) "제 일 장" "제이화"
  // ReDoS 방어: 문자 숫자 고정 목록
  [/^제\s*(?:일|이|삼|사|오|육|칠|팔|구|십)\s*[화장편](?:\s*[^\r\n]{0,60})?$/, '제 일/이/삼 화 한글 서수'],


  // ════════════════════════════════════════════════════════════════
  // ★ 기존 그룹 5: 숫자+점 형식
  // ════════════════════════════════════════════════════════════════

  // ★ 기존: N. 제목 (긴 번호용)
  // 예) "1. 서막" "12. 어둠의 계곡"
  [/^\d+\.\s+.{1,60}$/,                               'N. 제목'],

  // ★ 기존: #N. 제목
  // 예) "#1. 서막"
  [/^#\d+\.\s+.{1,60}$/,                              '#N. 제목'],

  // ★ 신규: N) 제목 — 소괄호 닫음+공백+제목 형식 (일부 단행본)
  // 예) "1) 서막" "12) 어둠의 시작"
  [/^\d+\)\s+[^\r\n]{1,60}$/,                         'N) 제목 형식'],

  // ★ 신규: 01. 제목 / 001. 제목 — zero-pad 점 형식
  // 예) "01. 서막" "001. 어둠"
  [/^0+\d+\.\s+[^\r\n]{1,60}$/,                       '01. zero-pad 점 형식'],


  // ════════════════════════════════════════════════════════════════
  // ★ 기존 그룹 6: 제목 형식 (장식·기호형)
  // ════════════════════════════════════════════════════════════════

  // ★ 기존: 소설제목(숫자) — 소설 이름 + 괄호 숫자
  // 예) "어둠의 기사(1)" "드래곤 헌터(123)"
  [/^.{1,60}\s*\(\d+\)\s*$/,                          '소설제목(숫자)'],

  // ★ 기존: 제N장 / 第N章 한자 장 번호
  // 예) "第1章 서막"
  [/^(?:제\s*\d+\s*장|第\s*\d+\s*章)(?:\s*.+)?$/,     '장 번호'],

  // ★ 기존: 【제목】 타이틀 형식
  // 예) "【서막】" "【어둠의 기사】"
  [/^【.+】.*$/,                                       '타이틀【】'],

  // ★ 기존: # 제목 (Markdown H1/H2/H3)
  // 예) "# 1장" "## Chapter 1"
  [/^#{1,3}\s*.+$/,                                   '# 제목 (Markdown)'],

  // ★ 기존: 특수문자 시작 제목 (■▶◆● 등)
  // 예) "■ 1화" "★ 서막"
  [/^[■▶◆●►▷◇★☆]\s*.{2,40}$/,                        '특수문자 제목'],

  // ★ 기존: 第N章/話 한자 장/화 형식
  // 예) "第1章" "第三話" "第12話 서막"
  [/^第\s*[\d一二三四五六七八九十百千]+\s*[章話话](?:\s*.+)?$/, '한자 장/화 형식'],

  // ★ 신규: 第N幕 / 第N節 — 한자 막/절 형식 (희곡·단행본 번역)
  // 예) "第1幕" "第三節 어둠의 시작"
  [/^第\s*[\d一二三四五六七八九十百千]+\s*[幕節](?:\s*[^\r\n]{0,80})?$/, '第N幕/節 한자 막/절'],

  // ★ 신규: ≪N화≫ / 《N화》 — 겹낫표 형식 (일부 번역 소설)
  // 예) "≪1화≫" "《12화》 어둠의 서막"
  [/^[≪《]\s*\d+\s*화\s*[≫》](?:\s*[^\r\n]{0,80})?$/, '≪N화≫ 겹낫표 형식'],

  // ★ 신규: 「N화」 / 『N화』 — 일본식 낫표 형식 (번역 웹소설)
  // 예) "「1화」" "『12화』 서막"
  [/^[「『]\s*\d+\s*화\s*[」』](?:\s*[^\r\n]{0,80})?$/, '「N화」 낫표 형식'],


  // ════════════════════════════════════════════════════════════════
  // ★ 기존 그룹 7: 기타 형식
  // ════════════════════════════════════════════════════════════════

  // ★ 기존: EP./Chapter/Scene 등으로 시작하는 줄
  // 예) "EP.001" "Chapter12"
  [/^(?:EP|제|Chapter|Ch|디|Scene|Prologue)\.?\s*\d+/i,'EP/Ch/Scene N 시작'],

  // ★ 기존: N. 제목 (짧은 번호 1~3자리)
  [/^\d{1,3}\.\s*.+$/,                                'N. 제목 (짧은 번호)'],

  // ★ 기존: N권 형식
  // 예) "1권" "12권 어둠의 시대"
  [/^\d+권(?:\s*.+)?$/,                               'N권 형식'],

  // ★ 기존: 제목+구분선 (=== 또는 ---로 끝나는 형식)
  // 예) "서막===" "어둠---"
  [/^.*[=\-]{3,}$/,                                   '제목+구분선(===,--)'],

  // ★ 기존: * N * / --- N --- 구분자 사이 숫자
  // 예) "*** 1화 ***" "--- 12 ---"
  [/^[\*\-─]+\s*\d+화?\s*[\*\-─]+$/,                 '* N * 구분자'],

  // ★ 기존: 시즌 N화 (기존 버전)
  // 예) "시즌1 1화" "1화"
  [/^(?:시즌\s*\d+\s+)?\d+화(?:\s*.+)?$/,             '시즌 N화'],

  // ★ 기존: (외전) / (번외) / (특별편) / (side) / (bonus)
  // 예) "(외전)" "(side)"
  [/^\((?:외전|번외|특별편|side|bonus)\)/i,            '(외전/번외) 형식'],

  // ★ 기존: 〈N화〉 / EP.N / N화 / N 줄 시작 통합 (꺽쇠/EP/숫자)
  // 예) "〈1화〉..." "EP.001..." "1화..." "12..."
  [/^(?:\s?〈\s?\d+화\s?〉|EP\.\d+|(?=\d+화)\d+화|\d+).*/, '줄 시작 통합 (꺽쇠/EP/숫자)'],

  // ★ 신규: - N - / — N — 대시 사이 숫자 구분자 (단행본 챕터 구분)
  // 예) "- 1 -" "— 12 —"
  // ReDoS 방어: 대시 구체적 문자 클래스로 고정
  [/^[-─—]{1,3}\s*\d+\s*[-─—]{1,3}$/,               '- N - 대시 구분자'],

  // ★ 신규: ─── 제목 ─── 구분선+제목 샌드위치 형식
  // 예) "─── 서막 ───"  "=== 어둠의 시작 ==="
  // ReDoS 방어: 제목 부분 최대 60자 고정 (.{1,60})
  [/^[-─=]{2,}\s*[^\r\n]{1,60}\s*[-─=]{2,}$/,        '─── 제목 ─── 샌드위치'],

  // ★ 신규: <N> / [N] / {N} — 괄호 단독 숫자 (단순 번호 구분자)
  // 예) "<1>" "[12]" "{3}"
  // ReDoS 방어: \d{1,6}으로 숫자 길이 고정
  [/^(?:<\d{1,6}>|\[\d{1,6}\]|\{\d{1,6}\})$/,        '<N> 괄호 단독 숫자'],
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
// splitChapters에서 bestPat 결과와 OR 결합되어 최종 rx에 항상 포함됨
// ─────────────────────────────────────────
const KEYWORD_PATS=[
  // ★ 기존: 프롤로그/프롤
  /^(?:프롤로그|프롤)(?:\s*.+)?$/i,
  // ★ 기존: 에필로그/에필
  /^(?:에필로그|에필)(?:\s*.+)?$/i,
  // ★ 기존: 외전
  /^외전(?:\s*.+)?$/,
  // ★ 기존: 번외
  /^번외(?:\s*.+)?$/,
  // ★ 기존: 후기
  /^후기(?:\s*.+)?$/,
  // ★ 기존: 작가 후기
  /^작가\s*후기(?:\s*.+)?$/,
  // ★ 기존: 작가의 말
  /^작가의\s*말(?:\s*.+)?$/,
  // ★ 기존: 작가 노트
  /^작가\s*노트(?:\s*.+)?$/,
  // ★ 기존: side story / side episode / special episode (영문)
  /^(?:side\s*story|side\s*episode|special\s*episode)(?:\s*.+)?$/i,
  // ★ 기존: prologue / epilogue / afterword / author's note (영문)
  /^(?:prologue|epilogue|afterword|author.?s?\s*note)(?:\s*.+)?$/i,
  // ★ 기존: 서장
  /^서장(?:\s*.+)?$/,
  // ★ 기존: 종장
  /^종장(?:\s*.+)?$/,
  // ★ 기존: 서문
  /^서문(?:\s*.+)?$/,

  // ★ 신규: 막간 / 인터루드 — 챕터 사이 짧은 삽화 (항상 인식)
  // 예) "막간" "인터루드" "Interlude"
  /^(?:막간|인터루드|interlude)(?:\s*[^\r\n]{0,80})?$/i,

  // ★ 신규: 공지 / 공지사항 — 플랫폼 공지를 챕터로 인식
  // 예) "공지" "공지사항 - 연재 일정 변경"
  /^(?:공지|공지사항)(?:\s*[^\r\n]{0,80})?$/,

  // ★ 신규: 설정집 / 일러스트 / 캐릭터 소개 (부록류 항상 인식)
  /^(?:설정집|일러스트|캐릭터\s*소개|등장인물|세계관\s*설정)(?:\s*[^\r\n]{0,80})?$/,

  // ★ 신규: 특별편 / 스페셜 / 단편
  /^(?:특별편|스페셜|단편)(?:\s*[^\r\n]{0,80})?$/,

  // ★ 신규: extra / bonus chapter 영문 — 항상 인식
  /^(?:extra|bonus)(?:\s*(?:chapter|episode|story))?(?:\s*[^\r\n]{0,60})?$/i,
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
    // 전각 숫자(１２３) → 반각 — 패턴 감지(bestPat)와 매칭이 같은 기준으로 동작하도록
    .replace(/[\uFF10-\uFF19]/g, c=>String.fromCharCode(c.charCodeAt(0)-0xFF10+0x30))
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

// ══════════════════════════════════════════════════════════════
// ★ 파싱 유틸리티 레이어 — 신규 (#3/#5/#7)
// ══════════════════════════════════════════════════════════════

// ─── #3: False Positive Guard ───
// 제목 후보 줄이 실제로 챕터 제목인지 판별
// 조건: (a) 30자 이하, (b) 위아래 공백 밀도 ≥ blankThreshold
function _isLikelyChapterTitle(lines, idx, blankThreshold=0.3){
  const line=lines[idx]||'';
  const t=line.trim();
  // (a) 글자수 가드: 30자 초과이면 제목이 아닐 가능성 높음
  if(t.length>30) return false;
  // (b) 상하 공백 밀도 체크 (window=5줄)
  const win=5;
  const start=Math.max(0,idx-win);
  const end  =Math.min(lines.length-1,idx+win);
  let blank=0, total=0;
  for(let i=start;i<=end;i++){
    if(i===idx) continue;
    total++;
    if(!(lines[i]||'').trim()) blank++;
  }
  const density=total>0?blank/total:0;
  return density>=blankThreshold;
}

// ─── #5: 인덱스 도약 보정 ───
// [{title, num}] 배열에서 도약(갭>3)이나 중복 감지 → 경고 배열 반환
// 호출자는 이 정보를 Toast 경고 등에 활용
function _checkIndexJump(chapters){
  const result={jumps:[],dups:[]};
  const nums=chapters.map(([h])=>{
    const m=(h||'').match(/(\d+)/);
    return m?parseInt(m[1]):null;
  }).filter(n=>n!==null);
  for(let i=1;i<nums.length;i++){
    const gap=nums[i]-nums[i-1];
    if(gap>3)    result.jumps.push({from:nums[i-1],to:nums[i],gap});
    if(gap===0)  result.dups.push(nums[i]);
  }
  return result;
}

// ─── #4: 본문 번호 목록 가드 ───
// '1. 검' / '2) 방패'처럼 번호 목록 줄이 바로 위·아래 줄과 연속되면 챕터 제목이 아니라 본문 목록으로 판단
// (실제 챕터 제목은 번호 목록 형식의 다른 줄과 빈 줄 없이 붙어 있지 않음)
const _LIST_ITEM_RX=/^\s*\d{1,3}\s*[.)]\s+\S/;
function _isListItemLine(lines, idx){
  if(!_LIST_ITEM_RX.test(lines[idx]||'')) return false;
  return _LIST_ITEM_RX.test(lines[idx-1]||'') || _LIST_ITEM_RX.test(lines[idx+1]||'');
}

// ─── 제목 줄 매칭 (목차 미리보기용) ───
// splitChapters와 같은 기준: 전처리·정규화 문자열 또는 원문 중 하나라도 매칭
// (이전 previewToc는 원문만 검사 → '[1화] 시작'처럼 bestPat이 찾은 패턴이 미리보기에선 0개로 보이고
//  실제 변환에서는 잡히는 불일치)
function _matchHeading(rx, line){
  const raw=String(line||'').trim();
  if(!raw||!rx) return false;
  const t=_normalizeTitleStr(preprocessLine(raw));
  return (!!t&&rx.test(t))||rx.test(raw);
}

// ─── #7: ReDoS 타임아웃 가드 ───
// 커스텀 정규식을 제한 시간(ms) 내에 테스트
// 초과 시 null 반환 (호출자가 패턴을 폐기)
function _safeRegexTest(rx, str, timeoutMs=200){
  if(!rx) return false;
  try{
    const start=Date.now();
    // 짧은 샘플(최대 2000자)로 타임아웃 사전 감지
    const sample=str.slice(0,2000);
    const result=rx.test(sample);
    if(Date.now()-start>timeoutMs){
      console.warn('[parser] ReDoS 의심 패턴 감지 — 타임아웃:',rx.source);
      return null; // null = 타임아웃 신호
    }
    return result;
  }catch(e){
    return false;
  }
}

/**
 * parseCustomPattern — 커스텀 정규식 컴파일 + ReDoS 사전 검사 (#7/#9)
 * @param {string} pat 사용자 입력 패턴 문자열
 * @param {string} [sample] ReDoS 검사용 샘플 텍스트 (없으면 짧은 테스트)
 * @returns {{ rx: RegExp|null, error: string|null, reDosSuspect: boolean }}
 */
function parseCustomPattern(pat, sample=''){
  if(!pat||!pat.trim()) return {rx:null,error:'빈 패턴',reDosSuspect:false};
  let rx;
  try{ rx=new RegExp(pat.trim(),'i'); }
  catch(e){ return {rx:null,error:e.message,reDosSuspect:false}; }
  // ReDoS 사전 감지: 중첩 수량자 패턴 정적 검사
  const reDosSigns=[/\(\.\*\)\+/,/\(\.\+\)\*/,/(\+|\*)\{/,/\[.*\]\+\[.*\]\*/];
  const reDosSuspect=reDosSigns.some(s=>s.test(pat));
  if(reDosSuspect){
    return {rx:null,error:'ReDoS 의심 패턴 (중첩 수량자)',reDosSuspect:true};
  }
  // 런타임 타임아웃 테스트
  const testStr=sample||'제1화 서막\n제2화 어둠\n1화\n2화\n'.repeat(10);
  const timedOut=_safeRegexTest(rx,testStr,200)===null;
  if(timedOut){
    return {rx:null,error:'실행 시간 초과 — 너무 복잡한 패턴',reDosSuspect:true};
  }
  return {rx,error:null,reDosSuspect:false};
}

// ─── #8/#10: 공백 관용·유사 기호 보정용 정규화 ───
// '제 1 화' → '제1화', '화ʼ(우측 쉼표형 어퍼스트로피) → '화' 등
function _normalizeTitleStr(s){
  return s
    .replace(/\u2019|\u02bc|\u0060/g,'\'')   // 유사 어퍼스트로피 정규화
    .replace(/[\uFF10-\uFF19]/g,c=>String.fromCharCode(c.charCodeAt(0)-0xFF10+0x30)) // 전각숫자 → 반각 (★ 이전: [] 누락으로 미동작)
    .replace(/\u3007/g,'0')                   // 〇 → 0
    .replace(/\s*([화장편막권])\s*/g,'$1')     // 화/장 앞뒤 공백 제거
    .replace(/제\s+/g,'제')                   // '제 1화' → '제1화'
    .trim();
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

  // ★ Phase 10: 전처리 1회 캐시 — 이전엔 패턴 79종마다 모든 줄을 다시 preprocessLine(정규식 5회)
  //   → 패턴 없는 30만 줄 TXT 감지 8.5초 → 0.9초
  const pre=new Array(lines.length);
  for(let i=0;i<lines.length;i++) pre[i]=preprocessLine(lines[i]);
  for(const[rx,name]of PATS){
    const matchedIdxs=[];
    const matchedNums=[];
    for(let i=0;i<lines.length;i++){
      // ★ 전처리 후 패턴 검사
      const t=pre[i];
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
    let validCnt=0; for(let i=0;i<tailStart;i++){ if(pre[i]&&fb.test(pre[i])) validCnt++; }
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
    const uniqueMatches=[...new Set(pre.filter(t=>t&&combined.test(t)))];
    if(uniqueMatches.length>bestScore){
      return {rx:combined,name:'혼합('+uniq.map(m=>m.name).join('+')+')[자동]',cnt:uniqueMatches.length,isMixed:true,mixedParts:uniq};
    }
  }
  return {rx:best,name:bestName,cnt:bestScore};
}

// ══════════════════════════════════════════
// 🧭 Module: TocEngine (복합 패턴 통합 목차 감지)
// ══════════════════════════════════════════
// 패턴 '하나'를 고르던 방식(bestPat)의 한계 — 형식이 섞인 연재본에서 숫자로 시작하는 본문 줄까지 잡거나(오탐),
// 반대로 한 형식만 잡아 나머지를 놓침 — 을 해결하기 위한 다단계 엔진:
//   ① 후보 수집  : 줄마다 제목 형식 계열(N화·제N화·<N화>·소설명 N화·N. 제목·숫자만·Chapter·키워드·외전·권)을 판별
//   ② 제목다움   : 문장 종결·대사·길이·앞뒤 빈 줄·번호 목록·카운트다운으로 가중치 산정 (0 이하 = 본문)
//   ③ 번호 사슬  : 화 번호가 앞에서 뒤로 자연스럽게 이어지는 최대 가중 경로를 DP로 선택
//                 (형식이 바뀌어도 번호가 이어지면 한 사슬 → 복합 패턴 동시 탐지 / 흐름에 안 맞는 숫자 줄은 탈락)
//   ④ 화수 보정  : 파일명 범위('1-201 완결', '0-853')가 있으면 범위 밖 번호 제거 + 오차가 5%를 넘으면 매개변수 변형 재탐색
//   ⑤ 후처리     : 키워드·외전·권 추가, 두 줄 제목 결합, 반복 머리줄 제거, 같은 화 분할 합치기(옵션), 파일 경계
// ★ 모든 함수는 외부 DOM 의존 없음 — buildParserWorkerSource()로 Worker에 그대로 이식됨

// 파일명 화수 범위: '소설 1-201 완결' → {start:1,end:201,total:201} / '0-853' → total 854 / '…200화' → 1..200
function parseChapterRange(name){
  const stem=String(name||'').replace(/\.[a-z0-9]{2,4}$/i,'');
  const re=/(?:^|[^\d])(\d{1,5})\s*[-~]\s*(\d{1,5})(?!\d)(?!\s*권)/g;
  let m, last=null;
  while((m=re.exec(stem))) last=m;
  if(last){
    const s=parseInt(last[1],10), e=parseInt(last[2],10);
    if(e>=s && e-s<20000) return {start:s, end:e, total:e-s+1};
  }
  const m2=stem.match(/(\d{2,5})\s*화/);
  if(m2){ const e=parseInt(m2[1],10); return {start:1, end:e, total:e}; }
  return null;
}

// 숫자 토큰 → 정수 (아라비아·전각·한자·한글 수사)
function _parseNumToken(tok){
  if(tok==null) return null;
  const s=String(tok).replace(/[０-９]/g,c=>String.fromCharCode(c.charCodeAt(0)-0xFF10+0x30));
  if(/^\d+$/.test(s)) return parseInt(s,10);
  const MAP={'일':1,'이':2,'삼':3,'사':4,'오':5,'육':6,'칠':7,'팔':8,'구':9,'一':1,'二':2,'三':3,'四':4,'五':5,'六':6,'七':7,'八':8,'九':9};
  const UNIT={'십':10,'十':10,'백':100,'百':100,'천':1000,'千':1000};
  let total=0, cur=0, ok=false;
  for(const ch of s){
    if(MAP[ch]!=null){ cur=MAP[ch]; ok=true; }
    else if(UNIT[ch]!=null){ total+=(cur||1)*UNIT[ch]; cur=0; ok=true; }
    else return null;
  }
  return ok?total+cur:null;
}

// 화 번호 제목 형식 계열: [이름, 정규식(번호 캡처), 기본 가중치]
function _tocFamilies(){
  const E='(?=$|[\\s.:,)\\]\\-–—~!?(』」》〉>])';
  return [
    ['괄호N화', new RegExp('^[<〈《≪【\\[「『(]\\s*(?:제\\s*)?(\\d{1,5})\\s*(?:화|話|회)\\s*(?:\\(\\d{1,2}\\))?\\s*[>〉》≫】\\]」』)]'), 3],
    ['제N화',   new RegExp('^제\\s*(\\d{1,5})\\s*(?:화|話|회)'+E), 3],
    ['N화',     new RegExp('^(\\d{1,5})\\s*(?:화|話|회)'+E), 3],
    ['N장',     new RegExp('^(?:제\\s*)?(\\d{1,4})\\s*(?:장|章)'+E), 2.5],
    ['第N章',   /^第\s*([\d一二三四五六七八九十百千]+)\s*[章話话回幕節]/, 3],
    ['제일화',  /^제\s*([일이삼사오육칠팔구십백]+)\s*(?:화|장)(?=$|[\s.:,)\]\-–—~!?(])/, 2.5],
    ['Chapter', new RegExp('^(?:chapter|chap\\.?|ch\\.?|episode|ep\\.?|part|scene)\\s*(\\d{1,5})'+E,'i'), 3],
    ['소설명N화', /^(.{2,40}?)\s+(\d{1,5})\s*(?:화|話|회)(?:\s*\(\d{1,2}\))?\s*$/, 3],
    ['#N',      new RegExp('^#\\s*(\\d{1,5})'+E), 2],
    ['-N-',     /^[-=*─━~·]{1,6}\s*(\d{1,5})\s*(?:화)?\s*[-=*─━~·]{1,6}$/, 2],
    ['(N)',     /^[<\[(〈【{]\s*(\d{1,5})\s*[>\])〉】}]$/, 2],
    ['N.제목',  /^(\d{1,4})\s*[.)]\s*(?=\S)/, 1.5],
    ['숫자만',  /^(\d{1,5})$/, 1.2],
  ];
}

// 한 줄의 제목 후보 정보 → {s, kind:'ch'|'kw'|'side'|'vol', fam, num, base, bare, part} | null
function _tocLineInfo(raw, fams){
  let s=String(raw||'').trim();
  if(!s||s.length>90) return null;
  const orig=s.replace(/\s{2,}/g,' ');   // 표시용 원문 (전각 숫자 등 원래 글자 유지)
  s=s.replace(/[０-９]/g,c=>String.fromCharCode(c.charCodeAt(0)-0xFF10+0x30)).replace(/\s{2,}/g,' ');
  // 빠른 거르기: 숫자·한자/한글 수사·키워드 시작이 없으면 제목 후보 아님
  // ★ Phase 10: 모든 형식 계열은 줄 앞부분(괄호·'제'·'Chapter' 등 접두 포함 24자 이내)에 번호가 오고,
  //   예외인 '소설명 N화'는 줄 끝이 'N화'로 끝남 → 숫자가 문장 중간에만 있는 본문 줄은 정규식 13종 검사 없이 탈락
  if(!/[\d一二三四五六七八九十百千]/.test(s.slice(0,24)) &&
     !/\d\s*(?:화|話|회)(?:\s*\(\d{1,2}\))?\s*$/.test(s) &&
     !/^[\s[(<〈《【「『]*제\s*[일이삼사오육칠팔구십백]/.test(s) &&
     !/^[\s[(<〈《【「『]*(?:프롤|에필|서장|종장|서문|서론|후기|작가|막간|인터|공지|외전|번외|특별편|스페셜|prolog|epilog|interlude|afterword|author|side|extra)/i.test(s)) return null;
  const inner=s.replace(/^[[(<〈《【「『]\s*/,'');
  if(/^(?:프롤로그|프롤|에필로그|에필|서장|종장|서문|서론|후기|작가\s*후기|작가의\s*말|작가\s*노트|작가\s*공지|막간|인터루드|공지사항|공지|prologue|epilogue|interlude|afterword|author'?s?\s*note)(?=$|[\s.:)\]\-–—~,!』」】>〉])/i.test(inner))
    return {s, orig, kind:'kw', fam:'키워드', num:null, base:2.5, bare:false, part:null};
  let m=inner.match(/^(?:외전|번외|특별편|스페셜|side\s*story|extra\s*(?:story|episode)?)\s*(?:(\d{1,4})\s*(?:화|편|話|회)?)?(?=$|[\s.:)\]\-–—~,!(』」】>〉])/i);
  if(m) return {s, orig, kind:'side', fam:'외전', num:m[1]?parseInt(m[1],10):null, base:2.5, bare:false, part:null};
  m=inner.match(/^(?:제\s*)?(\d{1,3})\s*(?:권|부)(?=$|[\s.:)\]\-–—~,』」】>〉])/)||inner.match(/^(?:vol(?:ume)?|book)\.?\s*(\d{1,3})(?=$|[\s.:)\]\-–—~,])/i);
  if(m && !/\d\s*(?:화|話|회|장)/.test(inner.slice(m[0].length))) return {s, orig, kind:'vol', fam:'권', num:parseInt(m[1],10), base:2.5, bare:false, part:null};
  for(const cand of (inner===s?[s]:[s,inner])){
    for(const [fam,rx,base] of fams){
      const mm=cand.match(rx);
      if(!mm) continue;
      const num=_parseNumToken(fam==='소설명N화'?mm[2]:mm[1]);
      if(num==null) continue;
      const rest=cand.slice(mm[0].length).trim();
      // 분할 표기 '(1)'·'(2)': 제목 뒤(rest) 또는 괄호 안('<120화 (1)>')
      const pm=rest.match(/\((\d{1,2})\)\s*$/)||(fam==='괄호N화'?mm[0].match(/\((\d{1,2})\)\s*[>〉》≫】\]」』)]\s*$/):null);
      return {s, orig, kind:'ch', fam, num, base, bare:!rest||/^\(\d{1,2}\)$/.test(rest), part:pm?parseInt(pm[1],10):null};
    }
  }
  return null;
}

// 제목다움 가중치 — 0 이하이면 본문으로 간주
function _tocWeight(lines, i, info){
  const blank=k=>k<0||k>=lines.length||!String(lines[k]).trim();
  const s=info.s;
  let w=info.base;
  if(/^["“”'‘’「『]/.test(s)&&info.kind==='ch'&&info.fam!=='괄호N화') w-=5;              // 대사
  if(/[가-힣][.。]["”'’」』]?$/.test(s)) w-=4;                                             // 한국어 문장 종결 '…다.'
  else if(/[.。]$/.test(s)&&info.fam!=='N.제목') w-=1.5;
  else if(/[가-힣][!?]["”'’」』]?$/.test(s)&&s.length>18) w-=1;                           // 긴 감탄·의문 문장
  if(s.length>60) w-=1.5; else if(s.length>40) w-=0.5;
  const pb=blank(i-1)||/^[-=*─━~·#◆◇■□★☆]{3,}\s*$/.test(String(lines[i-1]||'').trim());
  const nb=blank(i+1)||/^[-=*─━~·#◆◇■□★☆]{3,}\s*$/.test(String(lines[i+1]||'').trim());
  // 두 줄 제목('1화' 다음 줄 부제, 그 뒤 빈 줄)도 '뒤가 비어 있음'으로 취급
  const nl=String(lines[i+1]||'').trim();
  const nbSub=!nb&&info.bare&&nl.length<=40&&!/[.。]["”'’」』]?$/.test(nl)&&!/^["“”'‘’「『]/.test(nl)&&blank(i+2);
  if(pb) w+=0.5;
  if(nb||nbSub) w+=0.5;
  if(info.fam==='N.제목' && _isListItemLine(lines,i)) w-=4;
  if(info.fam==='숫자만'||info.fam==='(N)'){
    // 카운트다운·나열('3' '2' '1'): 가까운 줄에 다른 숫자만 줄이 있으면 본문
    for(const d of [-3,-2,-1,1,2,3]){
      const t=String(lines[i+d]||'').trim();
      if(/^\d{1,5}$/.test(t)&&Math.abs(parseInt(t,10)-info.num)<=1){ w-=3; break; }   // 1씩 변하는 이웃 숫자 = 카운트다운
    }
    if(!pb||!nb) w-=1;
  }
  return w;
}

// 화 번호 사슬 DP — 줄 순서대로 번호가 같거나(분할 연재) 조금씩 커지는(누락 허용) 최대 가중 경로
function _tocChain(cands, p, volLines){
  const n=cands.length, score=new Array(n).fill(-Infinity), prev=new Array(n).fill(-1);
  const bestByNum=new Map();
  let bestIdx=-1, vi=0, lastVol=-1;
  const vols=volLines||[];
  for(let k=0;k<n;k++){
    const c=cands[k];
    while(vi<vols.length&&vols[vi]<c.i) lastVol=vols[vi++];
    if(c.w<=p.minW) continue;
    let sc=c.w-(p.start!=null?Math.min(4,Math.abs(c.num-p.start)*0.5):0), pv=-1;
    for(let d=0; d<=p.maxGap; d++){
      const j=bestByNum.get(c.num-d);
      if(j===undefined) continue;
      let t=score[j]+c.w+(cands[j].fam===c.fam?0.3:-0.2);
      // 같은 번호 반복: 분할 표기('(1)·(2)')면 정상 / 부제가 붙은 제목이면 소폭 감점 /
      //   번호만 있는 줄('1화')이면 점수가 늘지 않게 — 본문 속 'N화' 언급이 사슬을 장악하는 것 차단
      if(d===0) t-=(c.part||cands[j].part)?0.1:(c.info.bare?c.w+0.5:1.0);
      else if(d>1) t-=(d-1)*0.35;
      if(t>sc){ sc=t; pv=j; }
    }
    // 권·부마다 1화부터 다시 시작: 사이에 'N권/N부' 제목이 있으면 싸게, 없으면 비싸게(다음 화들이 이어져야 이득)
    if(c.num<=1 && bestIdx>=0){
      const volBetween=lastVol>cands[bestIdx].i;
      const t=score[bestIdx]+c.w-(volBetween?0.5:4);
      if(t>sc){ sc=t; pv=bestIdx; }
    }
    score[k]=sc; prev[k]=pv;
    const cur=bestByNum.get(c.num);
    if(cur===undefined||score[cur]<sc) bestByNum.set(c.num,k);   // 동점이면 앞선 줄 유지 (뒤의 본문 속 언급보다 실제 제목 우선)
    if(bestIdx<0||sc>score[bestIdx]) bestIdx=k;
  }
  const out=[];
  for(let k=bestIdx;k>=0;k=prev[k]) out.push(cands[k]);
  return out.reverse();
}

// 후보(화 제목 줄)와 권 줄 — 매개변수와 무관하므로 detectToc에서 1회만 계산해 변형 재탐색에 재사용
function _tocCandidates(lines, infos){
  const cands=[], vols=[];
  for(const [i,info] of infos){
    if(info.kind==='ch') cands.push({i, num:info.num, fam:info.fam, part:info.part, w:_tocWeight(lines,i,info), info});
    else if(info.kind==='vol') vols.push(i);
  }
  return {cands, vols};
}

function _detectAuto(lines, infos, p, pre){
  // ★ Phase 10: 가중치는 변형(완화·엄격·간격 축소)마다 다시 계산하지 않음 (이전: 최대 4회 중복 계산)
  const {cands, vols}=pre||_tocCandidates(lines, infos);
  let chain=_tocChain(cands, p, vols);
  // 화수 범위 밖 번호 제거 (파일명 범위가 있을 때)
  if(p.range){
    const slack=Math.max(3, Math.round(p.range.total*0.05));
    chain=chain.filter(c=>c.num>=p.range.start-1 && c.num<=p.range.end+slack);
  }
  // 사슬 안에서 비중이 아주 작은 형식 계열 제거 (엄격 모드)
  if(p.familyMinShare){
    const cnt={}; chain.forEach(c=>{cnt[c.fam]=(cnt[c.fam]||0)+1;});
    chain=chain.filter(c=>cnt[c.fam]/chain.length>=p.familyMinShare||c.w>=3);
  }
  return chain;
}

/**
 * detectToc — 줄 배열에서 목차 감지 (미리보기·변환·Worker 공통 단일 진입점)
 * @param {string[]} lines
 * @param {{customPat?:string, range?:{start,end,total}, fileBreaks?:{line:number,name:string}[], mergeParts?:boolean}} opts
 * @returns {{items:{line,title,num,kind,fam,autoSplit?}[], dropLines:number[], rx:RegExp|null, name:string, stats:object}}
 *   items.line은 1-based, dropLines는 본문에서 뺄 0-based 줄(두 줄 제목의 부제·반복 머리줄·합친 분할 제목)
 */
function detectToc(lines, opts={}){
  const range=opts.range||null;
  const fams=_tocFamilies();
  const infos=[];
  for(let i=0;i<lines.length;i++){ const info=_tocLineInfo(lines[i], fams); if(info) infos.push([i,info]); }
  const drop=new Set();
  let items=[], mode='auto', chain=[], customRx=null;

  if(opts.customPat&&String(opts.customPat).trim()){
    // ── 사용자 정의 패턴: 사용자가 지정한 형식을 신뢰 (번호 목록만 제외) + 제목다운 키워드 줄
    const {rx}=parseCustomPattern(String(opts.customPat).trim(), lines.slice(0,500).join('\n'));
    if(rx){
      customRx=rx; mode='custom';
      for(let i=0;i<lines.length;i++){
        // ★ Phase 10: 제목은 짧음 — 150자 넘는 본문 줄은 사용자 정규식에 넣지 않음
        //   (_safeRegexTest는 실행이 끝난 뒤 시간을 재므로 폭주를 끊을 수 없음 → 입력 길이 상한이 실질적 ReDoS 방어)
        if(String(lines[i]||'').length>150) continue;
        if(_matchHeading(rx,lines[i])&&!_isListItemLine(lines,i)){
          const info=_tocLineInfo(lines[i],fams);
          items.push({line:i+1, title:String(lines[i]).trim().replace(/\s{2,}/g,' '), num:info&&info.kind==='ch'?info.num:null, kind:'ch', fam:'입력'});
        }
      }
    }
  }
  if(mode==='auto'){
    const base={maxGap:30, minW:0, start:range?range.start:null, range};
    const pre=_tocCandidates(lines, infos);
    chain=_detectAuto(lines, infos, base, pre);
    let usedVariant='기본';
    // ★ 파일명 화수 대비 오차가 5%를 넘으면 매개변수를 바꿔 재탐색 — 오차가 가장 작은 결과 채택
    if(range){
      const err=ch=>Math.abs(new Set(ch.map(c=>c.num)).size-range.total)/range.total;
      if(err(chain)>0.05){
        const variants=[
          ['완화', {...base, maxGap:80, minW:-0.75}],
          ['엄격', {...base, minW:1.5, familyMinShare:0.03}],
          ['간격 축소', {...base, maxGap:8}],
        ];
        for(const [label,v] of variants){
          const alt=_detectAuto(lines, infos, v, pre);
          if(err(alt)<err(chain)){ chain=alt; usedVariant=label; }
        }
      }
    }
    chain._variant=usedVariant;
    // ── 같은 화 분할 합치기(옵션): '120화 (1)'·'120화 (2)' → 하나로
    let mainChain=chain;
    if(opts.mergeParts){
      mainChain=[];
      for(const c of chain){
        const last=mainChain[mainChain.length-1];
        if(last&&last.num===c.num&&(c.part||last.part)){ drop.add(c.i); continue; }
        mainChain.push(c);
      }
    }
    items=mainChain.map(c=>({line:c.i+1, title:c.info.orig, num:c.num, kind:'ch', fam:c.fam, bare:c.info.bare, part:c.part}));
    if(opts.mergeParts) items.forEach(it=>{ if(it.part) it.title=it.title.replace(/\s*\(\d{1,2}\)(\s*[>〉》≫】\]」』)])?\s*$/,'$1'); });
    // ── 키워드·외전·권: 제목다운 것만, 같은 문구가 3번 이상 반복되면(매 화 '작가의 말' 등) 본문으로 둠
    const kwCount={};
    infos.forEach(([,info])=>{ if(info.kind==='kw') kwCount[info.s]=(kwCount[info.s]||0)+1; });
    const chainLines=new Set(chain.map(c=>c.i));
    for(const [i,info] of infos){
      if(info.kind==='ch'||chainLines.has(i)) continue;
      if(info.kind==='kw'&&kwCount[info.s]>=3) continue;
      const w=_tocWeight(lines,i,info);
      if(w<=0||info.s.length>40) continue;
      items.push({line:i+1, title:info.orig, num:info.num, kind:info.kind, fam:info.fam});
    }
    items.sort((a,b)=>a.line-b.line);
    // 감지가 거의 없으면 기존 단일 패턴 방식(bestPat)으로 폴백 — 번호 없는 특수 형식('【제목】' 등) 보존
    if(chain.length<3){   // (분할 합치기 전 사슬 기준 — 합친 뒤 개수로 판단하면 폴백이 잘못 발동)
      const legacy=bestPat(lines.join('\n'));
      if(legacy.rx){
        const leg=[];
        for(let i=0;i<lines.length;i++){
          const t=_normalizeTitleStr(preprocessLine(String(lines[i])));
          if(t&&(legacy.rx.test(t)||legacy.rx.test(String(lines[i]).trim()))&&_isLikelyChapterTitle(lines,i,0.2)&&!_isListItemLine(lines,i))
            leg.push({line:i+1, title:String(lines[i]).trim().replace(/\s{2,}/g,' '), num:null, kind:'ch', fam:legacy.name});
        }
        if(leg.length>=3){ items=leg; mode='legacy'; customRx=legacy.rx; }
      }
    }
  }

  // ── 두 줄 제목: 번호만 있는 제목 다음 줄의 짧은 부제를 결합 (같은 계열에서 30% 이상 반복될 때만)
  const bare=items.filter(it=>it.kind==='ch'&&it.bare);
  const subOf=it=>{
    let j=it.line; while(j<lines.length&&j<it.line+2&&!String(lines[j]).trim()) j++;
    const t=String(lines[j]||'').trim();
    if(!t||j>=lines.length||t.length>40||_tocLineInfo(t,fams)) return null;
    if(/^["“”'‘’「『(]/.test(t)||/[.。]["”'’」』]?$/.test(t)||/^[-=*─━~·#◆◇■□★☆]{3,}/.test(t)) return null;
    const after=String(lines[j+1]||'').trim();
    if(after&&after.length<t.length) return null;   // 부제 뒤에 더 짧은 줄이 이어지면 본문 시작으로 판단
    return {j,t};
  };
  if(bare.length>=3){
    const subs=bare.map(subOf);
    if(subs.filter(Boolean).length>=bare.length*0.3){
      bare.forEach((it,k)=>{ const s=subs[k]; if(s){ it.title=it.title+' '+s.t; drop.add(s.j); } });
    }
  }

  // ── 반복 머리줄: 여러 제목 바로 위·아래에 같은 줄이 반복(작품명·사이트명) → 본문에서 제거
  const heads=items.filter(it=>it.kind==='ch');
  if(heads.length>=5){
    const near=new Map();
    for(const it of heads){
      const seen=new Set();
      for(let d=-4; d<=3; d++){
        if(d===0) continue;
        const k=it.line-1+d, t=String(lines[k]||'').trim();
        if(!t||t.length>40||seen.has(t)) continue;
        seen.add(t);
        if(!near.has(t)) near.set(t,[]);
        near.get(t).push(k);
      }
    }
    for(const [t,ks] of near){
      if(ks.length>=Math.max(3,heads.length*0.3)&&!_tocLineInfo(t,fams)&&!/^[-=*─━~·#◆◇■□★☆]{3,}\s*$/.test(t)) ks.forEach(k=>drop.add(k));
    }
  }

  // ── 파일 경계: 여러 TXT를 합칠 때 파일 시작 근처에 제목이 없으면 파일명을 제목으로 (본문은 그 줄부터 포함)
  const fb=Array.isArray(opts.fileBreaks)?opts.fileBreaks:[];
  if(fb.length>=3){
    for(const b of fb){
      let k=b.line-1; while(k<lines.length&&!String(lines[k]).trim()) k++;
      if(k>=lines.length) continue;
      const hasHead=items.some(it=>it.line-1>=k&&it.line-1<=k+5);
      if(!hasHead) items.push({line:k+1, title:String(b.name||'').replace(/\.[^.]+$/,''), num:null, kind:'file', fam:'파일', autoSplit:true});
    }
    items.sort((a,b)=>a.line-b.line);
  }

  // ── 요약
  const main=items.filter(it=>it.kind==='ch');
  const famCnt={}; main.forEach(it=>{famCnt[it.fam]=(famCnt[it.fam]||0)+1;});
  const mainDistinct=new Set(main.filter(it=>it.num!=null).map(it=>it.num)).size||main.length;
  const extra=items.length-main.length;
  const famStr=Object.entries(famCnt).sort((a,b)=>b[1]-a[1]).map(([f,c])=>f+' '+c).join(' · ');
  const err=range?(mainDistinct-range.total)/range.total:null;
  let rx=customRx;
  if(!rx&&mode==='auto'){
    const used=new Set(Object.keys(famCnt));
    const srcs=fams.filter(([f])=>used.has(f)).map(([,r])=>r.source);
    if(items.some(it=>it.kind==='kw')) srcs.push('^(?:프롤로그|에필로그|서장|종장|후기|작가의\\s*말|공지)');
    if(items.some(it=>it.kind==='side')) srcs.push('^(?:외전|번외)');
    try{ rx=srcs.length?new RegExp('(?:'+srcs.join('|')+')','i'):null; }catch(e){ rx=null; }
  }
  const name=mode==='custom'?'입력 패턴':mode==='legacy'?(main[0]?.fam||'패턴'):
    (Object.keys(famCnt).length>1?'복합('+famStr+')':(famStr||'감지 없음'));
  return {
    items, dropLines:[...drop].sort((a,b)=>a-b), rx, name,
    stats:{mode, main:mainDistinct, extra, families:famCnt, range, errorRate:err, variant:chain._variant||null},
  };
}

// 감지 요약 문구 (미리보기 상단)
function describeTocDetection(det){
  const s=det.stats;
  let t=(s.mode==='custom'?'입력 패턴':'자동 감지')+': '+det.name+' — 본편 '+s.main+'화'+(s.extra?' + 기타 '+s.extra+'개':'');
  if(s.range){
    const pct=(s.errorRate*100);
    t+=' · 파일명 기준 '+s.range.total+'화 대비 '+(pct>=0?'+':'')+pct.toFixed(1)+'%';
  }
  return t;
}

// 여러 TXT를 '\n\n'으로 합치며 각 파일 시작 줄(1-based) 기록
function joinTextsWithBreaks(raws, names){
  const breaks=[]; let offset=0;
  raws.forEach((r,k)=>{ breaks.push({line:offset+1, name:(names&&names[k])||''}); offset+=String(r).split('\n').length+1; });
  return {text:raws.join('\n\n'), fileBreaks:breaks};
}

// 여러 파일의 화수 범위 합산 (모두 범위를 가질 때만)
function rangeForFiles(names){
  const rs=(names||[]).map(parseChapterRange);
  if(!rs.length||rs.some(r=>!r)) return rs.length===1?rs[0]:null;
  if(rs.length===1) return rs[0];
  return {start:Math.min(...rs.map(r=>r.start)), end:Math.max(...rs.map(r=>r.end)), total:rs.reduce((a,r)=>a+r.total,0)};
}

// 감지 결과 → [[제목, 본문], ...]  (splitChapters·buildChaptersFromTocItems 공용)
//  - 첫 제목 앞 내용은 '서문'으로 보존 (★ 이전: EPUB spine에서 제외돼 읽을 수 없었음)
//  - 본문 없는 제목도 보존 ('1권'처럼 바로 다음 줄에 '1화'가 오는 경우 — 계층 목차용)
//  - autoSplit 항목은 제목 줄도 본문에 포함 (간격 분할·파일 경계)
function assembleChapters(lines, items, dropLines, {dedupe=true}={}){
  const drop=dropLines instanceof Set?dropLines:new Set(dropLines||[]);
  const sepRx=/^[-=*─━~·.‒—]{3,}\s*$|^[─━═]{2,}$/;
  const total=lines.length;
  const sorted=[...items].filter(it=>it.line>=1&&it.line<=total).sort((a,b)=>a.line-b.line);
  const chapters=[], seen=new Map();
  const bodyOf=(a,b)=>{
    const out=[];
    for(let k=a;k<b;k++) if(!drop.has(k)) out.push(lines[k]);
    while(out.length&&(sepRx.test(String(out[0]).trim())||!String(out[0]).trim())) out.shift();
    while(out.length&&(sepRx.test(String(out[out.length-1]).trim())||!String(out[out.length-1]).trim())) out.pop();
    return out.join('\n').trim();
  };
  if(!sorted.length) return chapters;
  const pre=bodyOf(0, sorted[0].line-1);
  // ★ Phase 10: 3번째 요소 meta — 서문 표시·감지된 화 번호 (EPUB 삽화 매핑용, 기존 [제목, 본문] 구조분해와 호환)
  if(pre) chapters.push(['서문', pre, {pre:true}]);
  sorted.forEach((it,k)=>{
    const head=it.line-1;
    const next=k+1<sorted.length?sorted[k+1].line-1:total;
    const body=bodyOf(it.autoSplit?head:head+1, next);
    let title=it.title;
    if(dedupe){
      const key=_normalizeTitleStr(preprocessLine(title));
      const c=seen.get(key)||0; seen.set(key,c+1);
      if(c) title=title+' ('+(c+1)+')';
    }
    chapters.push([title, body, {num:it.num!=null?it.num:null, kind:it.kind||null}]);
  });
  return chapters;
}

// 패턴이 전혀 없을 때: 장면 구분자(***) 경계에서 200~500줄 단위 페이지로, 구분자도 없으면 고정 줄 수로
function fallbackPageSplit(lines){
  const total=lines.length;
  const PAGE=Math.max(200,Math.min(500,Math.floor(total/20)));
  const sepRx=/^\s*(?:[*＊◇◆○●□■☆★#=~\-─━·]\s*){3,}$/;
  const seps=[];
  lines.forEach((l,i)=>{ if(sepRx.test(String(l))) seps.push(i); });
  const cuts=[0];
  if(seps.length>=3){
    let last=0;
    for(const s of seps){ if(s-last>=PAGE){ cuts.push(s+1); last=s+1; } }
  }else{
    for(let i=PAGE;i<total;i+=PAGE) cuts.push(i);
  }
  const pages=[];
  for(let k=0;k<cuts.length;k++){
    const body=lines.slice(cuts[k], k+1<cuts.length?cuts[k+1]:total).join('\n').trim();
    if(body) pages.push(body);
  }
  if(pages.length<=1) return [['본문', lines.join('\n').trim()]];
  return pages.map((b,k)=>['('+(k+1)+'/'+pages.length+')', b]);
}

// ── 문단 정합: 30자 미만 짧은 줄이 이어지면 한 줄(문단)로 합침 — 제목 후보·구분선 줄은 유지 ──
// ★ Phase 10: 루프 밖에서 만든 형식 계열(fams) 재사용 (이전: 짧은 줄마다 정규식 13개 재생성)
function _mergeShortLineArray(rawLines, fams){
  const merged=[];
  let buf='';
  for(let i=0;i<rawLines.length;i++){
    const t=rawLines[i];
    const tt=t.trim();
    if(tt&&tt.length<30&&!/^[-=*─]{3,}$/.test(tt)&&!_tocLineInfo(t,fams)){
      buf+=(buf?' ':'')+tt;
      const nx=rawLines[i+1];
      if(!(nx&&nx.trim())||nx.trim().length>=30){ merged.push(buf); buf=''; }
    } else {
      if(buf){merged.push(buf);buf='';}
      merged.push(t);
    }
  }
  if(buf) merged.push(buf);
  return merged;
}

// ★ Phase 10: '문단 정합' 옵션을 조립된 챕터 본문에 적용 — 목차 줄 번호에 영향 없음
//   (이전: getCachedChapters 경로에서만 원문 전체에 적용되고 실제 변환(startConvert)에는 전달되지 않아 옵션이 무시됨)
function applyParagraphMerge(chapters){
  if(!Array.isArray(chapters)) return chapters;
  const fams=_tocFamilies();
  return chapters.map(c=>{
    const o=[c[0], _mergeShortLineArray(String(c[1]||'').split('\n'), fams).join('\n')];
    if(c.length>2) o.push(c[2]);
    return o;
  });
}

// splitChapters: 동기 함수. 대용량은 splitChaptersAsync(Worker) 권장
// ★ Phase 8: 패턴 하나(bestPat)로 줄을 자르던 방식 → detectToc(복합 패턴·번호 사슬·화수 보정) + assembleChapters
//   미리보기(previewToc)와 같은 감지 함수를 쓰므로 "미리보기에 보이는 목차 = 변환 결과"
// opts: {mergeShortLines, onProgress, range, fileBreaks, mergeParts}
function splitChapters(raw, customPat, opts={}){
  const {mergeShortLines=false, onProgress=null}=opts;

  // ── 입력 텍스트 정규화 ──
  raw=String(raw||'')
    .replace(/\r\n/g,'\n')
    .replace(/\r/g,'\n')
    .replace(/\xad/g,'—')
    .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F]/g,'')
    .replace(/[￾￿]/g,'');

  // ★ 지능형 문단 정합: 짧은 줄(30자 미만)이 연속되면 합산
  if(mergeShortLines){
    raw=_mergeShortLineArray(raw.split('\n'), _tocFamilies()).join('\n');
  }

  onProgress&&onProgress(15,'② 목차 감지 중...');
  const lines=raw.split('\n');
  raw=null; // ★ 메모리 정리
  const det=detectToc(lines,{customPat, range:opts.range||null, fileBreaks:opts.fileBreaks||null, mergeParts:!!opts.mergeParts});
  if(customPat&&det.stats.mode!=='custom'&&typeof Toast!=='undefined') Toast.warn('⚠️ 정규식 오류 — 자동 감지로 진행해요');
  onProgress&&onProgress(70,'② 챕터 조립 중... ('+det.items.length+'개)');
  const chapters=det.items.length?assembleChapters(lines, det.items, det.dropLines):fallbackPageSplit(lines);
  onProgress&&onProgress(92,'② 챕터 분리 완료');

  // ★ #5: 인덱스 도약 보정 경고
  _warnIndexJump(chapters);
  return chapters.length?chapters:[['본문','']];
}

// ★ #5: 화수 도약 경고 — splitChapters(메인) / splitChaptersAsync(Worker 결과 수신 후) 공용
// Worker 안에서는 Toast가 없으므로 자동으로 건너뜀
function _warnIndexJump(chapters){
  if(!Array.isArray(chapters)||chapters.length<=2) return;
  const jump=_checkIndexJump(chapters);
  if(jump.jumps.length>0&&typeof Toast!=='undefined'){
    const warn=jump.jumps.slice(0,3).map(j=>`${j.from}→${j.to}(+${j.gap})`).join(', ');
    Toast.warn(`⚠️ 화수 도약 감지: ${warn} — 중간에 누락된 화가 있을 수 있어요.`,5000);
  }
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
// 📚 Module: SeriesMeta (파일명 → 시리즈명·권 번호)
// ══════════════════════════════════════════
// '전지적 독자 시점 3권'            → {series:'전지적 독자 시점', index:3}
// '[작가] 나 혼자 레벨업 제2권 각성' → {series:'나 혼자 레벨업', index:2}
// 'Overlord Vol.4'                  → {series:'Overlord', index:4}
// '소설 1-3권'(합본 범위)·권 표기 없음 → null
function parseSeriesFromName(name){
  let s=String(name||'').replace(/\.(?:txt|epub)$/i,'').trim();
  // [작가] 제목 / 제목 @ 작가 → 제목만 (handleTxt 메타 자동 채우기 규칙과 동일)
  let m=s.match(/^\[(.+?)\]\s*(.+)$/);
  if(m) s=m[2].trim();
  else{ m=s.match(/^(.+?)\s*@\s*(.+)$/); if(m) s=m[1].trim(); }
  if(/\d\s*[-~]\s*\d+\s*권/.test(s)) return null; // 합본 범위 표기는 단일 권이 아님
  const rxs=[
    /^(.+?)[\s_\-]*(?:제\s*)?(\d{1,3})\s*권(?=$|[\s_\-.(\[])/,
    /^(.+?)[\s_\-]*(?:vol(?:ume)?|book)\.?\s*(\d{1,3})(?=$|[\s_\-.(\[])/i,
  ];
  for(const rx of rxs){
    const mm=s.match(rx);
    if(!mm) continue;
    const series=mm[1].replace(/[\s_\-·:]+$/,'').trim();
    const index=parseInt(mm[2],10);
    if(series&&index>0) return {series, index};
  }
  return null;
}

// ══════════════════════════════════════════
// 🌲 Module: TocTree (평면 목차 → 권/부 2단계 목차)
// ══════════════════════════════════════════
// items: [{label, href, heading}]  heading=원문 챕터 제목, label=목차 표시명
// 반환: [{label, href, children:[{label, href, children:[]}]}]
// 규칙:
//   ① '1권' '제2부' 'Vol.3' 'Book 4'처럼 권/부만 있는 제목 → 상위 노드 (자기 페이지 링크)
//   ② '1부 3화'처럼 권/부 + 화 표지가 함께 있는 제목 → 같은 권/부 그룹의 자식
//      (앞에 그 권/부 제목 페이지가 없으면 '1부' 그룹 노드를 합성, 링크는 첫 자식)
//   ③ 그 외 제목 → 직전 권/부 그룹의 자식, 첫 그룹 이전이면 최상위
//   권/부 그룹이 2개 미만이거나 중첩된 자식이 없으면 기존과 같은 평면 목차를 반환
// ★ epub-gen.js EPUB Worker에 toString()으로 이식됨 — 외부 심볼 참조 금지
function buildTocTree(items){
  const VOL_RX=/^(?:제\s*)?(\d{1,4}|[일이삼사오육칠팔구십]{1,3}|[一二三四五六七八九十]{1,3})\s*(권|부)(?=$|[\s.:·\-–—)\]】」』>,])/;
  const VOL_EN_RX=/^(vol(?:ume)?|book)\.?\s*(\d{1,4}|[ivxlc]{1,6})(?=$|[\s.:\-–—)\]])/i;
  const CH_MARK_RX=/(?:\d+|[일이삼사오육칠팔구십백]+)\s*(?:화|장|話|章|편)|chapter|ch\.\s*\d|ep\.?\s*\d|episode|프롤로그|에필로그|외전|번외|막간/i;
  const list=Array.isArray(items)?items:[];
  const flat=list.map(it=>({label:it.label, href:it.href, children:[]}));
  const volInfo=h=>{
    const t=String(h||'').trim();
    let m=t.match(VOL_RX);
    if(m) return {key:m[2]+':'+m[1], label:m[0].trim(), rest:t.slice(m[0].length)};
    m=t.match(VOL_EN_RX);
    if(m) return {key:'v:'+m[2].toLowerCase(), label:m[0].trim(), rest:t.slice(m[0].length)};
    return null;
  };
  const nodes=[];
  let cur=null, groups=0, nested=0;
  for(const it of list){
    const v=volInfo(it.heading!=null?it.heading:it.label);
    const leaf={label:it.label, href:it.href, children:[]};
    if(v&&!CH_MARK_RX.test(v.rest)){
      cur={label:it.label, href:it.href, key:v.key, children:[]};
      nodes.push(cur); groups++;
      continue;
    }
    if(v){
      if(!cur||cur.key!==v.key){
        cur={label:v.label, href:it.href, key:v.key, children:[]};
        nodes.push(cur); groups++;
      }
      cur.children.push(leaf); nested++;
      continue;
    }
    if(cur){ cur.children.push(leaf); nested++; }
    else nodes.push(leaf);
  }
  if(groups<2||nested===0) return flat;
  nodes.forEach(n=>{ delete n.key; });
  return nodes;
}

// ══════════════════════════════════════════
// ⚡ Module: ParserWorkerSource (대용량 파싱 Worker 소스 — 단일 진실의 원천)
// ══════════════════════════════════════════
// PATS·KEYWORD_PATS·bestPat·splitChapters를 Function.prototype.toString / RegExp 직렬화로 그대로 이식
// → 메인 스레드 splitChapters와 Worker 파싱 결과가 항상 동일 (별도 복사본 없음)
// convert.js createParserWorker가 이 소스로 Blob Worker를 생성
function buildParserWorkerSource(){
  const fns=[
    preprocessLine, calcSequenceWeight, checkTitleWaPattern, checkNDotPattern, bestPat,
    _normalizeTitleStr, _isLikelyChapterTitle, _isListItemLine, _matchHeading, _checkIndexJump, _warnIndexJump,
    _safeRegexTest, parseCustomPattern,
    // TocEngine (Phase 8)
    _parseNumToken, _tocFamilies, _tocLineInfo, _tocWeight, _tocChain, _tocCandidates, _detectAuto, detectToc,
    _mergeShortLineArray, assembleChapters, fallbackPageSplit, splitChapters,
  ];
  const rxLit=rx=>'new RegExp('+JSON.stringify(rx.source)+','+JSON.stringify(rx.flags)+')';
  const patsSrc='const PATS=[\n'+PATS.map(([rx,name])=>'['+rxLit(rx)+','+JSON.stringify(name)+']').join(',\n')+'\n];';
  const kwSrc='const KEYWORD_PATS=[\n'+KEYWORD_PATS.map(rxLit).join(',\n')+'\n];';
  const constsSrc='const _LIST_ITEM_RX='+_LIST_ITEM_RX.toString()+';';
  const handler=[
    'self.onmessage=function(e){',
    '  const d=e.data||{};',
    '  const id=d.id;',
    // ★ Phase 10: DETECT — 미리보기 목차 감지(detectToc)만 Worker에서 (대용량 TXT 미리보기 중 화면 멈춤 방지)
    "  if(d.type==='DETECT'){",
    '    try{',
    '      const p=d.payload||{};',
    "      const det=detectToc(String(p.raw||'').split('\\n'), p.opts||{});",
    "      self.postMessage({type:'DONE',id:id,result:det});",
    "    }catch(err){ self.postMessage({type:'ERROR',id:id,error:(err&&err.message)||String(err)}); }",
    '    return;',
    '  }',
    "  if(d.type!=='SPLIT') return;",
    '  try{',
    '    const p=d.payload||{};',
    '    let last=-1;',
    '    const result=splitChapters(p.raw, p.customPat, Object.assign({}, p.opts||{}, {',
    "      onProgress:function(pct,msg){ if(pct!==last){ last=pct; self.postMessage({type:'PROGRESS',id:id,pct:pct,msg:msg}); } }",
    '    }));',
    "    self.postMessage({type:'DONE',id:id,result:result});",
    '  }catch(err){',
    "    self.postMessage({type:'ERROR',id:id,error:(err&&err.message)||String(err)});",
    '  }',
    '};',
  ].join('\n');
  return ["'use strict';", patsSrc, kwSrc, constsSrc, ...fns.map(f=>f.toString()), handler].join('\n\n');
}

// ══════════════════════════════════════════
function escAttr(s){return s.replace(/'/g,"\\'").replace(/"/g,'&quot;');}

// ─── 챕터 캐시 ───
let _chaptersCache=null, _chaptersCacheKey='';
// 감지 단계에서 본문에서 뺄 줄 (0-based, _fullRawLines 기준) — previewToc가 갱신
let _tocDropLines=[];
// ─── 간격 분할 원문 줄 배열 (parser.js 소유) ───
let _autoSplitLines=null;
// ★ B-FIX-04(치명): window 미러 재정의 레이스 가드
// 동일 파일을 두 번 실행하거나 SW 업데이트 후 eval 경로에서
// defineProperty가 두 번 호출되면 TypeError 발생 → 1회만 정의
if(!Object.getOwnPropertyDescriptor(window,'_autoSplitLines')){
  Object.defineProperty(window,'_autoSplitLines',{
    get(){ return _autoSplitLines; },
    set(v){ _autoSplitLines=v; },
    configurable:true,
  });
}
// ★ L-09: 동시 다중 호출 방지 — 계산 중인 Promise 재사용
let _chaptersComputePromise=null;
// 목차 항목(미리보기·편집 결과) → [[제목, 본문], ...]
// ★ Phase 8: assembleChapters 공용 — 이전엔 본문 없는 제목을 버려 '1권' 같은 상위 제목이 사라짐
//   dropLines: 감지 단계에서 본문에서 뺄 줄(두 줄 제목의 부제·반복 머리줄) — 같은 원문 배열일 때만 적용
// ★ Phase 10: 줄 범위 모델(assembleTocChapters) — 병합 세그먼트·목차 순서(드래그 이동)를 출력에 반영
function buildChaptersFromTocItems(lines, tocItems, dropLines=(lines===_fullRawLines?_tocDropLines:null)){
  const enabled=(tocItems||[]).filter(t=>t.enabled&&t.line!=null&&t.line>=1&&t.line<=lines.length);
  if(!enabled.length) return [['본문', lines.join('\n').trim()]];
  // 사용자가 편집한 제목은 그대로 (중복 접미사 미부여)
  return assembleTocChapters(lines, enabled, dropLines);
}

// ══════════════════════════════════════════
// 🧩 Module: TocModel (목차 항목 ↔ 원문 줄 범위) — Phase 10
// ══════════════════════════════════════════
// 목차 항목(S.tocItems)은 본문 문자열을 들고 있지 않고 '원문 줄 범위'만 가리킴 → 미리보기·통계·EPUB 출력이 같은 기준
//   (이전: 감지 시 항목마다 body 문자열을 복사해 원문이 메모리에 2벌, 병합은 body 문자열만 이어 붙여
//    떨어진 항목끼리 병합하거나 드래그로 순서를 바꾸면 미리보기와 실제 EPUB이 달랐음)
//   · 세그먼트: {line(1-based 제목 줄), autoSplit} — 기본은 항목 자신 1개, 병합 항목은 원본 세그먼트를 순서대로 보유(_segs)
//   · 세그먼트 본문: 제목 다음 줄(간격 분할·파일 경계·병합된 두 번째 이후 세그먼트는 제목 줄 포함) ~ 다음 경계 직전
//   · 출력 경계: '활성' 항목의 세그먼트 줄 — 비활성 항목의 내용은 줄 순서상 앞 챕터에 이어짐(기존 동작 유지)
//   · 통계 경계: 활성·비활성 모든 항목 — 항목 각자의 글자수
//   · 출력 순서: 목차 순서 (드래그 순서 변경 반영) · 첫 경계 앞 내용은 '서문'
function _tocSegs(it){
  if(it&&Array.isArray(it._segs)&&it._segs.length) return it._segs;
  return [{line:it?it.line:0, autoSplit:!!(it&&it.autoSplit)}];
}
function _tocBoundaries(items, total){
  const set=new Set();
  for(const it of items){ for(const s of _tocSegs(it)) if(s.line>=1&&s.line<=total) set.add(s.line); }
  return Float64Array.from(set).sort();
}
// 경계 배열에서 line보다 큰 첫 경계 (없으면 total+1)
function _tocNextBoundary(bounds, line, total){
  let lo=0, hi=bounds.length;
  while(lo<hi){ const mid=(lo+hi)>>1; if(bounds[mid]<=line) lo=mid+1; else hi=mid; }
  return lo<bounds.length?bounds[lo]:total+1;
}
// 세그먼트 → 0-based [from, to)
function _tocSegRange(seg, segIdx, bounds, total){
  const head=seg.line-1;
  const from=(seg.autoSplit||segIdx>0)?head:head+1;
  const to=_tocNextBoundary(bounds, seg.line, total)-1;
  return [from, Math.max(from, to)];
}
// [a,b) 줄 → 본문 (dropLines 제외, 앞뒤 빈 줄·구분선 정리 — assembleChapters와 같은 규칙)
const _TOC_SEP_RX=/^[-=*─━~·.‒—]{3,}\s*$|^[─━═]{2,}$/;
function _tocBodyOf(lines, a, b, drop){
  let s=a, e=b;
  const skip=k=>drop&&drop.has(k);
  const edge=k=>{ const t=String(lines[k]==null?'':lines[k]).trim(); return !t||_TOC_SEP_RX.test(t); };
  while(s<e&&(skip(s)||edge(s))) s++;
  while(e>s&&(skip(e-1)||edge(e-1))) e--;
  const out=[];
  for(let k=s;k<e;k++) if(!skip(k)) out.push(lines[k]);
  return out.join('\n').trim();
}
// 현재 목차가 가리키는 원문 줄 배열 (간격 분할 활성 시 그 원문)
function _tocSourceLines(){
  if(_getAutoSplitActive()&&_autoSplitLines&&_autoSplitLines.length) return _autoSplitLines;
  return (_fullRawLines&&_fullRawLines.length)?_fullRawLines:null;
}
function _tocDropSetFor(lines){
  return (lines&&lines===_fullRawLines&&_tocDropLines&&_tocDropLines.length)?new Set(_tocDropLines):null;
}

/**
 * assembleTocChapters — 편집된 목차(S.tocItems) → [[제목, 본문, meta], ...]
 * meta: {num, kind} / 서문은 {pre:true} — EPUB Worker가 삽화를 화 번호·순번으로 매핑할 때 사용
 */
function assembleTocChapters(lines, items, dropLines){
  const total=lines.length;
  const drop=dropLines instanceof Set?dropLines:(dropLines&&dropLines.length?new Set(dropLines):null);
  const enabled=(items||[]).filter(t=>t&&t.enabled&&t.line!=null&&t.line>=1&&t.line<=total);
  if(!enabled.length) return [];
  const bounds=_tocBoundaries(enabled, total);
  const out=[];
  const pre=_tocBodyOf(lines, 0, bounds[0]-1, drop);
  if(pre) out.push(['서문', pre, {pre:true}]);
  const used=new Set();   // 같은 줄을 가리키는 세그먼트가 여러 개면 첫 항목만 본문을 가짐 (중복 출력 방지)
  for(const it of enabled){
    const parts=[];
    _tocSegs(it).forEach((seg,si)=>{
      if(seg.line<1||seg.line>total||used.has(seg.line)) return;
      used.add(seg.line);
      const [a,b]=_tocSegRange(seg, si, bounds, total);
      const t=_tocBodyOf(lines, a, b, drop);
      if(t) parts.push(t);
    });
    out.push([it.title, parts.join('\n\n'), {num:it.num!=null?it.num:null, kind:it.kind||null}]);
  }
  return out;
}

// 줄별 '공백 제외 글자수' 누적합 (원문 배열·dropLines가 같으면 재사용)
let _tocPrefixCache={lines:null, dropKey:'', pre:null};
function _tocCharPrefix(lines, drop){
  const dropKey=drop?drop.size+':'+(_tocDropLines[0]||0)+':'+(_tocDropLines[_tocDropLines.length-1]||0):'';
  if(_tocPrefixCache.lines===lines&&_tocPrefixCache.pre&&_tocPrefixCache.pre.length===lines.length+1&&_tocPrefixCache.dropKey===dropKey) return _tocPrefixCache.pre;
  const pre=new Float64Array(lines.length+1);
  for(let i=0;i<lines.length;i++){
    const l=lines[i];
    pre[i+1]=pre[i]+((drop&&drop.has(i))||!l?0:String(l).replace(/\s+/g,'').length);
  }
  _tocPrefixCache={lines, dropKey, pre};
  return pre;
}

/**
 * _recalcTocStats — 항목별 bodyLen(공백 제외 글자수)·suspicious(짧은 챕터) 계산 — O(줄 수 + 항목 log 항목)
 *   권·키워드 제목('1권', '작가의 말')과 마지막 항목은 짧아도 경고하지 않음
 */
function _recalcTocStats(items, lines=_tocSourceLines(), thr=getSuspThreshold()){
  if(!Array.isArray(items)||!items.length) return items;
  if(!lines||!lines.length){ items.forEach(t=>{ if(typeof t.bodyLen!=='number') t.bodyLen=0; }); return items; }
  const total=lines.length;
  const drop=_tocDropSetFor(lines);
  const pre=_tocCharPrefix(lines, drop);
  const bounds=_tocBoundaries(items, total);
  items.forEach((it,idx)=>{
    let len=0;
    _tocSegs(it).forEach((seg,si)=>{
      if(seg.line<1||seg.line>total) return;
      const [a,b]=_tocSegRange(seg, si, bounds, total);
      len+=pre[b]-pre[a];
    });
    it.bodyLen=len;
    it.suspicious=len<thr&&idx<items.length-1&&it.kind!=='vol'&&it.kind!=='kw';
  });
  return items;
}

// 항목 본문 앞부분 (툴팁·미리보기용) — 전체 본문을 만들지 않고 필요한 글자 수만 읽음
function _tocItemText(item, maxChars=Infinity){
  const lines=_tocSourceLines();
  if(!item||!lines) return '';
  const total=lines.length;
  const bounds=_tocBoundaries(S.tocItems.length?S.tocItems:[item], total);
  const drop=_tocDropSetFor(lines);
  const out=[]; let n=0;
  const segs=_tocSegs(item);
  for(let si=0;si<segs.length&&n<maxChars;si++){
    const seg=segs[si];
    if(seg.line<1||seg.line>total) continue;
    const [a,b]=_tocSegRange(seg, si, bounds, total);
    for(let k=a;k<b&&n<maxChars;k++){
      if(drop&&drop.has(k)) continue;
      const l=String(lines[k]==null?'':lines[k]);
      if(!out.length&&!l.trim()) continue;
      out.push(l); n+=l.length+1;
    }
  }
  const s=out.join('\n').trim();
  return Number.isFinite(maxChars)?s.slice(0,maxChars):s;
}

/**
 * _tocMergeItems — idxs 항목을 하나로 병합 (가장 앞 위치에 남김)
 *   세그먼트는 목차 순서대로 이어 붙이고, 원본 항목 정보(_mergedSources)는 평탄화해 보관 → 🔓 분리로 정확히 복원
 * @returns {{merged, index}|null}
 */
function _tocMergeItems(idxs, title){
  const list=S.tocItems;
  const sorted=[...new Set(idxs)].filter(i=>list[i]).sort((a,b)=>a-b);
  if(sorted.length<2) return null;
  const items=sorted.map(i=>list[i]);
  const first=items[0];
  const segs=[], sources=[];
  for(const it of items){
    _tocSegs(it).forEach(s=>segs.push({line:s.line, autoSplit:!!s.autoSplit}));
    if(it._isMerged&&Array.isArray(it._mergedSources)) sources.push(...it._mergedSources.map(s=>({...s})));
    else sources.push({line:it.line, title:it.title, autoSplit:!!it.autoSplit, num:it.num!=null?it.num:null,
      kind:it.kind||'ch', originalTitle:it.originalTitle||it.title, enabled:it.enabled!==false});
  }
  const merged={
    ...first,
    title:         title||items.map(t=>t.title).join(' + '),
    enabled:       true,
    suspicious:    false,
    originalTitle: first.originalTitle||first.title,
    _isMerged:     true,          // ★ 개선 04: 분리 버튼 표시용 플래그
    _segs:         segs,
    _mergedSources:sources,       // ★ 개선 04: 원본 정보
  };
  for(let k=sorted.length-1;k>=1;k--) list.splice(sorted[k],1);
  list[sorted[0]]=merged;
  _recalcTocStats(list);
  return {merged, index:sorted[0]};
}

// 목차 데이터만 바뀜(제목·체크) — 캐시 무효화 + 상태 구독자(regexFeed·미니 리더) 알림
function _tocTouch(){
  _chaptersCache=null; _chaptersCacheKey='';
  if(typeof _sStore!=='undefined') _sStore.set({tocItems:S.tocItems});
}
// 목차 구조가 바뀜(병합·분리·이동·Undo) — 통계 재계산 + 다시 그리기
function _tocCommit(){
  _tocTouch();
  renderTocItems();
  typeof updateTocEditBanner==='function'&&updateTocEditBanner();
}

async function getCachedChapters(){
  if(!S.txtFiles.length) return [];

  // ★ tocItems가 있으면 항상 tocItems 기반 챕터 조립 (_autoSplitActive 무관)
  // ★ window._autoSplitActive: 간격 분할 원문 참조
  const optMerge  = document.getElementById('optMergeShortLines')?.checked??false;
  if(S.tocItems.length>0){
    const sourceLines=_tocSourceLines();
    if(sourceLines){
      const chs=buildChaptersFromTocItems(sourceLines, S.tocItems);
      return optMerge?applyParagraphMerge(chs):chs;
    }
  }

  // tocItems 없거나 sourceLines 없음 → 원본 텍스트 파싱 (캐시 사용)
  // ★ 캐시 키 정교화: 파일명+크기+최종수정시간+패턴+설정 해시
  const pat=document.getElementById('pattern')?.value.trim()||'';
  const optItalic = document.getElementById('optItalic')?.checked??true;
  const settingHash = `${optItalic}:${optMerge}:${document.getElementById('optMergeParts')?.checked===true}`;
  const fileHash = S.txtFiles
    .map(f=>`${f.name}:${f.size}:${f.lastModified||0}`)
    .join('|');
  // ★ B-FIX-09: 캐시 키 정교화 — tocItems 편집(병합/드래그) 후 캐시 무효화 보장
  // 이전: 패턴 문자열만 → tocItems 변경 후에도 캐시 히트 → 이전 병합 전 챕터로 변환
  // 수정: tocItems 개수 + 첫 번째 line 값을 키에 포함 → 편집 후 자동 무효화
  const tocChecksum = S.tocItems.length > 0
    ? `${S.tocItems.length}:${S.tocItems[0]?.line||0}:${S.tocItems[S.tocItems.length-1]?.line||0}`
    : '0';
  const cacheKey = `${fileHash}§${pat}§${settingHash}§${tocChecksum}`;

  if(_chaptersCache && _chaptersCacheKey===cacheKey) return _chaptersCache;

  // ★ L-09 FIX: 동시 다중 호출 시 동일 Promise 재사용 → 중복 fileToText 방지
  if(_chaptersComputePromise) return _chaptersComputePromise;

  _chaptersComputePromise = (async()=>{
    try{
      const sorted=[...S.txtFiles];
      const raws=await Promise.all(sorted.map(fileToText));
      const {text:raw, fileBreaks}=joinTextsWithBreaks(raws, sorted.map(f=>f.name));
      await yieldToMain();
      const chs=splitChapters(raw,pat,{
        fileBreaks,
        range:rangeForFiles(sorted.map(f=>f.name)),
        mergeParts:document.getElementById('optMergeParts')?.checked===true,
      });
      _chaptersCache=optMerge?applyParagraphMerge(chs):chs;
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
let _previewTocSeq=0;
async function previewToc(){
  if(!S.txtFiles.length){Toast.warn('TXT 파일을 먼저 선택해주세요.');return;}
  // ★ Phase 10: 연속 호출(패턴 칩 연타 등) 시 늦게 끝난 이전 감지 결과가 최신 결과를 덮어쓰지 않도록
  const seq=++_previewTocSeq;

  // ════════════════════════════════════════════════════════
  // ★ 최우선 가드: 간격 분할 활성 상태면 패턴 분석 완전 우회
  // — 어떤 경우에도 간격 분할 결과를 덮어쓰지 않음
  // ════════════════════════════════════════════════════════
  if(_getAutoSplitActive()){
    // 기존 tocItems가 간격 분할 결과임 — 그대로 렌더링만 갱신
    renderTocItems();
    updateTocStat&&updateTocStat();
    document.getElementById('tocPanel')?.classList.add('show');
    tocTab(0);
    // 원문 가상 스크롤 유지 (이미 _fullRawLines가 설정되어 있음)
    const tb2=document.getElementById('tb2');
    if(tb2&&_fullRawLines.length>0&&!tb2.querySelector('.vs-container,pre')){
      tb2.innerHTML='';
      if(typeof createVirtualScroll==='function'){
        _vsInstTb2?.destroy(); _vsInstTb2=null;
        _vsInstTb2=createVirtualScroll(tb2,_fullRawLines);
      }
    }
    // ★ 간격 분할 활성 상태 — 재분할 버튼 표시
    _syncSplitBtn('active');
    Toast.info('⚡ 간격 분할 모드 활성 — 패턴 감지를 건너뜁니다.', 2500);
    return; // ← 여기서 완전 종료, 아래 패턴 분석 코드 실행 안 됨
  }

  // ★ 패턴 입력이 있으면 간격 분할 모드 해제
  const _patInput=(document.getElementById('pattern')?.value||'').trim();
  if(_patInput){
    // ★ #7/#9: ReDoS 가드 + 실시간 유효성 검사
    if(_patInput){
      const sample=(_fullRawLines.slice(0,50).join('\n'))||_patInput;
      const {error,reDosSuspect}=parseCustomPattern(_patInput, sample);
      if(reDosSuspect||error){
        // #10: 입력 칸 흔들기 애니메이션
        const patEl=document.getElementById('pattern');
        if(patEl){
          patEl.style.animation='shakeInput .4s ease';
          patEl.style.boxShadow='0 0 0 2px var(--accent)';
          setTimeout(()=>{ patEl.style.animation=''; patEl.style.boxShadow=''; },500);
        }
        Toast.warn('⚠️ 정규식 오류: '+(error||'패턴 불가'));
        return;
      }
    }
    _setAutoSplitActive(false);
    _autoSplitLines=null;
  }

  // 전체 파일 텍스트 로드 (다중 파일 모두 합산)
  let text, fileBreaks=[];
  try{
    const sorted=[...S.txtFiles];
    const raws=await Promise.all(sorted.map(f=>fileToText(f).catch(()=>sampleLines(f))));
    ({text, fileBreaks}=joinTextsWithBreaks(raws, sorted.map(f=>f.name)));
  }catch(e){
    text=await sampleLines(S.txtFiles[0]).catch(()=>'');
  }
  if(seq!==_previewTocSeq) return;
  const lines=text.split('\n');

  const pat=_patInput;
  let found=[],patLabel='';
  // ★ Phase 8: splitChapters와 같은 detectToc 사용 — 미리보기 목차 = 변환 결과
  //   (이전: 미리보기는 bestPat 단일 패턴만 써서 프롤로그·외전·에필로그가 빠지고, 첫 제목 앞 내용은 '서문'으로 묶여 EPUB에서 읽을 수 없었음)
  // ★ Phase 10: 10만 줄 이상은 Worker에서 감지 (detectTocAsync — convert.js)
  if(lines.length>=100000) Toast.info('대용량 파일 — 목차를 감지하는 중이에요...',2000);
  const detOpts={
    customPat:pat, fileBreaks,
    range:rangeForFiles(S.txtFiles.map(f=>f.name)),
    mergeParts:document.getElementById('optMergeParts')?.checked===true,
  };
  const det=typeof detectTocAsync==='function'?await detectTocAsync(lines, text, detOpts):detectToc(lines, detOpts);
  if(!det||seq!==_previewTocSeq) return;
  text=null;
  _fullRawLines=lines;
  if(pat&&det.stats.mode!=='custom') Toast.warn('⚠️ 정규식 오류 — 자동 감지 결과를 보여드려요');
  S._detectedPat=det.rx; S._detectedName=det.rx?det.name:'';
  _tocDropLines=det.dropLines;
  found=det.items.map(it=>({line:it.line, title:it.title, num:it.num, kind:it.kind, autoSplit:!!it.autoSplit}));
  patLabel=describeTocDetection(det);
  // 파일명 화수와 5% 넘게 다르면 안내
  if(det.stats.range&&Math.abs(det.stats.errorRate)>0.05)
    Toast.warn(`파일명 기준 ${det.stats.range.total}화와 감지 결과(${det.stats.main}화)가 ${(Math.abs(det.stats.errorRate)*100).toFixed(1)}% 달라요. 목차를 확인해 주세요.`,6000);

  // ★ Phase 10: 항목은 원문 줄 범위만 가리킴 (본문 문자열 복사 없음 → 원문 메모리 1벌)
  //   글자수(bodyLen)·짧은 챕터(suspicious)는 _recalcTocStats가 줄 범위에서 계산 — 출력(assembleTocChapters)과 같은 기준
  //   (이전: 감지 직후 항목마다 body를 slice해 저장 — dropLines·파일 경계 규칙이 빠져 통계와 출력이 달랐음)
  found = found.map(f => ({ ...f, enabled:true, originalTitle:f.title }));
  _recalcTocStats(found, _fullRawLines);

  // ★ I9: 재감지 전 통계 저장 (delta 비교용)
  const _prevTotal = S.tocItems.length;
  const _prevChars = S.tocItems.reduce((s,t)=>s+(t.bodyLen||0),0);

  S.tocItems=found;
  renderTocItems();
  updateTocStat&&updateTocStat();
  updateTocEditBanner&&updateTocEditBanner();

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

  // ★ I5: updateTocStat의 짧은챕터 칩 클릭 → 첫 짧은 챕터로 스크롤 (가상 목록 — 화면 밖 행도 이동)
  requestAnimationFrame(()=>requestAnimationFrame(()=>{
    document.querySelectorAll('#toc-stat [data-filter-short]').forEach(btn=>{
      btn.addEventListener('click',()=>{
        const i=S.tocItems.findIndex(t=>t.suspicious);
        if(i>=0) tocScrollToIndex(i);
      });
    });
  }));

  // 감지 실패 시 안내 메시지
  if(!found.length){
    // ★ 접혀 있던 고급 패턴 도구(#patAdvanced)를 자동으로 펼쳐 바로 지정할 수 있게
    document.getElementById('patAdvanced')?.setAttribute('open','');
    const c=document.getElementById('tb0');
    c?.insertAdjacentHTML('beforeend',
      '<div style="margin-top:12px;padding:12px;background:var(--blue-bg);border-radius:var(--radius-sm);border:1.5px solid var(--blue)">'+
      '<div style="font-size:var(--fs-sm);font-weight:600;color:var(--blue);margin-bottom:6px">ℹ️ 챕터 패턴을 감지하지 못했어요</div>'+
      '<div style="font-size:var(--fs-xs);color:var(--text2);line-height:1.7">'+
        '하지만 <b>텍스트 전체는 그대로 EPUB에 포함</b>돼요.<br>'+
        '목차 없이 변환하면 일정 줄 수 단위로 자동 페이지 분할해 저장해요.<br>'+
        '목차 이동이 필요하면 아래에서 패턴을 직접 입력하거나 간격 분할을 사용하세요.'+
      '</div>'+
      '<div style="display:flex;gap:8px;margin-top:8px">'+
        '<button class="btn btn-ghost btn-sm" data-action="tocTab" data-idx="3">패턴 직접 입력</button>'+
        '<button class="btn btn-blue btn-sm" data-action="autoSplitByInterval">간격 분할</button>'+
      '</div>'+
      '</div>'
    );
  }

  // ★ 가상 스크롤 — 이전 인스턴스 destroy 후 재생성
  const tb2=document.getElementById('tb2');
  if(tb2){
    _vsInstTb2?.destroy(); _vsInstTb2=null;
    tb2.innerHTML='';
    if(typeof createVirtualScroll==='function'){
      _vsInstTb2=createVirtualScroll(tb2, _fullRawLines);
    } else {
      const pre=document.createElement('pre');
      pre.className='toc-raw';
      pre.textContent=_fullRawLines.slice(0,2000).map((l,i)=>String(i+1).padStart(5,' ')+' │ '+l).join('\n');
      tb2.appendChild(pre);
      if(_fullRawLines.length>2000){
        const btn=document.createElement('button');
        btn.className='btn btn-ghost btn-sm';
        btn.style.cssText='margin:8px 0;width:100%;font-size:var(--fs-xs)';
        btn.textContent=`▼ 나머지 ${(_fullRawLines.length-2000).toLocaleString()}줄 더 보기`;
        btn.onclick=()=>{
          pre.textContent=_fullRawLines.map((l,i)=>String(i+1).padStart(5,' ')+' │ '+l).join('\n');
          btn.remove();
        };
        tb2.appendChild(btn);
      }
    }
  }
  const patEditEl=document.getElementById('patEdit');
  if(patEditEl&&patEditEl.value!==undefined) patEditEl.value=pat;
  S._rawTextFull=_fullRawLines;
  document.getElementById('tocPanel')?.classList.add('show');
  tocTab(0);
  document.getElementById('tb0')?.insertAdjacentHTML('afterbegin',
    '<div id="tocDetectLabel" style="font-size:var(--fs-xs);color:var(--text2);margin-bottom:8px;padding:0 4px">'+escHtml(patLabel)+'</div>');
  refreshDetectedChip();

  // ★ 유사 목차 후보 검색 — PAT_PRESETS 전체 점수화 (yield 포함 비동기, 메인 스레드 블로킹 방지)
  if(typeof renderTocSuggest==='function') renderTocSuggest(found).catch(()=>{});

  // ★ splitBtn 상태 동기화 — _syncSplitBtn으로 단일 관리
  // ★ 핵심: found.length > 0이어도 disabled 설정하지 않음 (교착 방지)
  if(found.length>0){
    _syncSplitBtn('patternFound');
    _renderHybridSuggestBtn(found.length);
    // ★ #9: 매칭률 스코어 Toast
    const matchRate=_fullRawLines.length>0
      ? Math.round(found.length/_fullRawLines.length*100*10)/10
      : 0;
    const safeLevel = matchRate>=5?'안전':matchRate>=1?'보통':'주의';
    const safeColor = matchRate>=5?'var(--green)':matchRate>=1?'var(--accent)':'var(--red)';
    Toast.info(
      `매칭률 <b style="color:${safeColor}">${matchRate}%</b> — `+
      `<b style="color:${safeColor}">${safeLevel}</b> · ${found.length}개 목차 감지`,
      3500
    );
  } else {
    _syncSplitBtn('patternMissing');
  }

  // ── 본문 짧음 감지 Toast 알림 ──
  const suspCount=found.filter(t=>t.suspicious).length;
  if(suspCount>0) showSuspiciousToast(suspCount);
}

// ★ B5/L1: 감지 성공 후 하이브리드 보완 버튼 렌더
// 감지 챕터 수가 적거나(10개 미만) 의심스러울 때 "간격 분할로 보완" 버튼 제안
function _renderHybridSuggestBtn(foundCount){
  // 기존 버튼 제거 (중복 방지)
  document.getElementById('hybrid-suggest-btn')?.remove();
  // ★ L8: 감지 결과가 충분하지 않을 때만 보완 버튼 표시 (10개 미만 또는 suspicious 50% 이상)
  const suspRatio = foundCount > 0
    ? S.tocItems.filter(t=>t.suspicious).length / foundCount
    : 0;
  if(foundCount >= 10 && suspRatio < 0.5) return;
  const btn=document.createElement('button');
  btn.id='hybrid-suggest-btn';
  btn.className='btn btn-blue btn-sm';
  btn.style.cssText='font-size:var(--fs-xs);margin-top:6px;display:block';
  btn.textContent='🔀 간격 분할로 보완하기';
  btn.title='감지 결과가 부족한 구간을 간격 분할로 자동 채웁니다 (하이브리드 모드)';
  btn.addEventListener('click', ()=>autoSplitByInterval(true));
  document.getElementById('tb0')?.insertAdjacentElement('beforebegin', btn);
}

// ══════════════════════════════════════════
// 🔎 Module: TocSuggest (가장 유사한 목차 후보 검색)
// ══════════════════════════════════════════
// TXT 로드 → previewToc(bestPat 자동 적용) 직후 실행
// PAT_PRESETS 전체를 원문과 대조해 '목차다운' 정도를 bestPat과 같은 척도로 점수화:
//   점수 = Σ(빈 줄에 감싸인 줄 3점 / 일반 줄 1점) × (1 + 연속성×0.5, 연속성 ≥ 0.6일 때)
// 오탐 방지:
//   - 120자 초과 줄은 본문으로 간주해 검사 제외 (목차 줄은 짧음)
//   - 매칭이 비어있지 않은 줄의 20% 초과면 본문 패턴으로 보고 제외
//   - 같은 줄 집합을 잡는 후보는 최고점 1개만 유지
// ★ parser.js 핵심 감지 로직(bestPat/PATS)은 건드리지 않는 읽기 전용 보조 레이어
let _tocSuggestSeq=0;

async function rankTocCandidates(lines, topN=4){
  if(!Array.isArray(lines)||!lines.length||typeof PAT_PRESETS==='undefined') return [];
  const n=lines.length;
  const pre=new Array(n), blank=new Array(n);
  let nonEmpty=0;
  for(let i=0;i<n;i++){
    const raw=lines[i]||'';
    blank[i]=!raw.trim();
    if(!blank[i]) nonEmpty++;
    pre[i]=(!blank[i]&&raw.length<=120)?preprocessLine(raw):'';
  }
  const isWrapped=i=>(blank[i-1]===true||blank[i-2]===true)&&(blank[i+1]===true||blank[i+2]===true);

  const out=[];
  for(let pi=0;pi<PAT_PRESETS.length;pi++){
    const p=PAT_PRESETS[pi];
    let rx;
    try{ rx=new RegExp(p.val,'i'); }catch(e){ continue; }
    let cnt=0, score=0, first=-1, last=-1;
    const nums=[];
    for(let i=0;i<n;i++){
      const t=pre[i];
      if(!t||!rx.test(t)) continue;
      cnt++;
      if(first<0) first=i;
      last=i;
      score+=isWrapped(i)?3:1;
      const nm=t.match(/\d+/);
      nums.push(nm?parseInt(nm[0],10):null);
    }
    if(cnt>=3&&cnt<=nonEmpty*0.2){
      const seqW=calcSequenceWeight(nums);
      if(seqW>=0.6) score=Math.round(score*(1+seqW*0.5));
      out.push({label:p.label, val:p.val, desc:p.desc||'', cnt, score, seqW, first, last});
    }
    // 4개 패턴마다 메인 스레드 양보 (대용량 TXT 대응)
    if(pi%4===3&&typeof yieldToMain==='function') await yieldToMain();
  }

  out.sort((a,b)=>b.score-a.score||b.seqW-a.seqW);
  const seen=new Set();
  const uniq=out.filter(c=>{
    const sig=c.cnt+':'+c.first+':'+c.last;
    if(seen.has(sig)) return false;
    seen.add(sig); return true;
  });
  return uniq.slice(0, topN);
}

async function renderTocSuggest(found){
  const seq=++_tocSuggestSeq;
  const lines=_fullRawLines;
  if(!document.getElementById('tb0')||!lines?.length) return;
  const cands=await rankTocCandidates(lines, 4);
  // 그 사이 새 목차 확인이 시작됐으면 오래된 결과 폐기
  if(seq!==_tocSuggestSeq) return;
  const host=document.getElementById('tb0');
  if(!host) return;
  document.getElementById('tocSuggestBar')?.remove();

  const curPat=(document.getElementById('pattern')?.value||'').trim();
  const range=rangeForFiles((S.txtFiles||[]).map(f=>f.name));
  // ★ Phase 8: 파일명 화수 대비 오차 표시 — 단일 패턴 후보는 복합 형식 소설에서 크게 어긋나므로 판단 근거 제공
  const dev=cnt=>range?((cnt-range.total)/range.total*100):null;
  const devStr=cnt=>{ const d=dev(cnt); return d==null?'':' ('+(d>=0?'+':'')+d.toFixed(0)+'%)'; };
  // 본편 화수 = 서로 다른 화 번호 수 (분할 연재 '(1)·(2)'는 한 화로) — 감지 요약 문구와 같은 기준
  const mainCh=Array.isArray(found)?found.filter(f=>f.kind==='ch'):[];
  const mainCnt=new Set(mainCh.filter(f=>f.num!=null).map(f=>f.num)).size||mainCh.length;

  const bar=document.createElement('div');
  bar.id='tocSuggestBar';
  bar.className='toc-suggest-bar';
  const head=document.createElement('span');
  head.className='toc-suggest-head';
  head.textContent='목차 후보';
  bar.appendChild(head);

  // 첫 칩: 자동 감지(복합 엔진) 결과 — 패턴 입력이 비어 있으면 적용 중
  const autoChip=document.createElement('button');
  autoChip.type='button';
  autoChip.className='pat-chip toc-suggest-chip'+(curPat?'':' detected');
  autoChip.textContent=(curPat?'':'✅ ')+'자동 감지 · 본편 '+mainCnt+'개'+devStr(mainCnt);
  autoChip.title='여러 제목 형식을 함께 찾고 화 번호 흐름으로 걸러낸 결과';
  autoChip.addEventListener('click',()=>applyTocSuggestion(''));
  bar.appendChild(autoChip);

  cands.forEach(c=>{
    const isApplied=curPat===c.val;
    const chip=document.createElement('button');
    chip.type='button';
    chip.className='pat-chip toc-suggest-chip'+(isApplied?' detected':'');
    chip.textContent=(isApplied?'✅ ':'')+c.label+' · '+c.cnt+'개'+devStr(c.cnt);
    const sample=String(lines[c.first]||'').trim().slice(0,40);
    chip.title=(c.desc?c.desc+' — ':'')+'단일 패턴 · 연속성 '+Math.round(c.seqW*100)+'% · 첫 매칭 '+(c.first+1)+'행: '+sample;
    chip.addEventListener('click',()=>applyTocSuggestion(c.val));
    bar.appendChild(chip);
  });
  host.insertAdjacentElement('afterbegin', bar);
}

// 후보 칩 클릭 → 챕터 정규식 입력에 반영 후 목차 재확인
function applyTocSuggestion(val){
  const inp=document.getElementById('pattern');
  if(!inp) return;
  inp.value=val||'';   // 빈 값 = 자동 감지로 되돌리기
  const clr=document.getElementById('patternClearBtn');
  if(clr) clr.style.display=val?'':'none';
  typeof previewToc==='function'&&previewToc();
}

// ════════════════════════════════════════════════════════
// ★ _syncSplitBtn — splitBtn 상태 단일 관리 유틸
//
// ★ 핵심 규칙: 텍스트 데이터가 존재하는 한 disabled는 절대 설정하지 않음
//   - 'nofile'        → disabled (파일 없음, 유일한 disabled 허용 케이스)
//   - 'active'        → 활성 + "재분할" (간격 분할 완료 상태)
//   - 'patternFound'  → 활성 + opacity 낮춤 (패턴 감지 성공, but 클릭 허용)
//   - 'patternMissing'→ 강조 활성 (패턴 감지 실패)
//   - 'reset'         → 기본 활성 (파일 초기화 후)
// ════════════════════════════════════════════════════════
function _syncSplitBtn(state){
  const btn=document.querySelector('button[data-action="autoSplitByInterval"]');
  if(!btn) return;
  switch(state){
    case 'nofile':
      btn.disabled=true;
      btn.style.opacity='0.35';
      btn.style.pointerEvents='none';
      btn.style.color='';
      btn.textContent='간격 분할';
      btn.title='TXT 파일을 먼저 추가해주세요';
      break;
    case 'active':
      btn.disabled=false;
      btn.style.opacity='0.85';
      btn.style.pointerEvents='';
      btn.style.color='';
      btn.textContent='재분할';
      btn.title='간격 분할 활성 — 클릭해서 재분할';
      break;
    case 'patternFound':
      // ★ disabled 절대 금지 — 패턴이 감지돼도 사용자는 간격 분할 선택 가능
      btn.disabled=false;
      btn.style.opacity='0.55';
      btn.style.pointerEvents='';
      btn.style.color='';
      btn.textContent='간격 분할';
      btn.title='패턴 감지 성공 — 원하면 간격 분할도 사용 가능합니다';
      break;
    case 'patternMissing':
      btn.disabled=false;
      btn.style.opacity='1';
      btn.style.pointerEvents='';
      btn.style.color='var(--blue)';
      btn.textContent='간격 분할';
      btn.title='패턴 감지 실패 — 줄 간격으로 자동 분할';
      break;
    case 'reset':
    default:
      btn.disabled=false;
      btn.style.opacity='1';
      btn.style.pointerEvents='';
      btn.style.color='';
      btn.textContent='간격 분할';
      btn.title='';
      break;
  }
}

// ─── 파일 로드 직후 splitBtn 즉시 활성화 (convert.js handleTxt에서 호출) ───
// previewToc 실행 전에 버튼이 먼저 열려있어야 교착 상태 방지
function _activateSplitBtnOnFileLoad(){
  const btn=document.querySelector('button[data-action="autoSplitByInterval"]');
  if(!btn) return;
  if(btn.disabled){
    // 일단 활성화 — previewToc 완료 후 patternFound/patternMissing으로 재조정됨
    btn.disabled=false;
    btn.style.pointerEvents='';
    btn.style.opacity='0.8';
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
    'background:var(--panel);border:1.5px solid var(--accent2);border-radius:var(--radius-sm);'+
    'padding:12px 18px;display:flex;align-items:center;gap:12px;'+
    'box-shadow:var(--shadow-lg);font-family:inherit;'+
    'animation:toastIn .25s ease;max-width:420px;width:90vw';
  el.innerHTML=
    '<span style="font-size:var(--fs-lg);flex-shrink:0">⚠️</span>'+
    '<div style="flex:1;min-width:0">'+
      '<div style="font-size:var(--fs-sm);font-weight:700;color:var(--text);margin-bottom:3px">'+
        '본문 짧음 챕터 <span id="susp-toast-count">'+count+'</span>개 감지</div>'+
      '<div style="font-size:var(--fs-xs);color:var(--text2);line-height:1.5">'+
        '⤵ 병합 버튼으로 다음 챕터와 합치거나 전체 제거할 수 있어요.'+
      '</div>'+
    '</div>'+
    '<div style="display:flex;flex-direction:column;gap:5px;flex-shrink:0">'+
      '<button id="susp-remove-all-btn" class="btn btn-sm" '+
        'style="font-size:var(--fs-xs);background:var(--accent);color:var(--on-accent);border-radius:var(--radius-xs);padding:5px 10px;white-space:nowrap">'+
        '전체 병합</button>'+
      '<button id="susp-toast-close" class="btn btn-ghost btn-sm" '+
        'style="font-size:var(--fs-xs);border-radius:var(--radius-xs);padding:4px 10px">'+
        '닫기</button>'+
    '</div>';

  document.body.appendChild(el);

  // 전체 병합 버튼 — suspicious 항목을 각각 다음 챕터와 병합
  el.querySelector('#susp-remove-all-btn').addEventListener('click', ()=>{
    _saveTocSnapshot();
    let mergedCount=0;
    // 뒤에서부터 순회해야 인덱스 밀림 없음 — 각 짧은 챕터를 다음 챕터와 병합 (제목은 짧은 챕터 유지)
    //   (판정은 시작 시점 기준 — 병합 결과로 다시 계산된 suspicious에 연쇄 반응하지 않음)
    const targets=S.tocItems.map((t,i)=>t.suspicious&&i+1<S.tocItems.length?i:-1).filter(i=>i>=0);
    for(let k=targets.length-1;k>=0;k--){
      const i=targets[k];
      if(_tocMergeItems([i,i+1], S.tocItems[i].title)) mergedCount++;
    }
    _tocCommit();
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

// ★ B-FIX-06: _selectedIdxs를 모듈 스코프로 분리
// 이전: renderTocItems() 내부 const → 매 재렌더마다 초기화되어 선택 상태 증발
// 수정: 모듈 스코프 유지 → renderTocItems 재호출 후에도 선택 상태 보존
let _tocSelectedIdxs = new Set();
let _tocLastClickedIdx = null;
let _tocSelectModeOn = false;
// ★ B-FIX-07: dragSrcI도 모듈 스코프로 분리 (클로저 경합 방지)
let _tocDragSrc = null;
// ★ Phase 10: 가상 스크롤 인스턴스 · 검색어(재렌더 후에도 유지) · 병합 직후 제목 편집 대상
let _tocVS = null;
let _tocFilterQ = '';
let _tocPendingTitleIdx = null;

// ★ B-FIX-08: getSuspThreshold 캐싱 — renderTocItems 내 수천 회 DOM 쿼리 방지
// renderTocItems 진입 시 한 번만 평가하고 내부에서 재사용
let _suspThresholdCached = 50;
function _refreshSuspThreshold(){
  _suspThresholdCached = getSuspThreshold();
}

function _saveTocSnapshot(){
  // ★ L-20 FIX: 항목은 본문 문자열을 갖지 않음(Phase 10 줄 범위 모델) → 얕은 복사로 충분
  //   ★ Phase 10: 병합 세그먼트·원본 정보·화 번호도 보존 (이전: 누락 → Undo 후 병합 분리 불가, 출력 경계 손실)
  const slim=(S.tocItems||[]).map(t=>({
    ...t,
    _segs:          Array.isArray(t._segs)?t._segs.map(s=>({...s})):undefined,
    _mergedSources: Array.isArray(t._mergedSources)?t._mergedSources.map(s=>({...s})):undefined,
  }));
  _tocUndoStack.push(slim);
  if(_tocUndoStack.length>_TOC_UNDO_MAX) _tocUndoStack.shift();
}
function undoToc(){
  if(_tocUndoStack.length===0){Toast.warn('되돌릴 내역이 없어요.');return;}
  const snap=_tocUndoStack.pop();
  S.tocItems=snap;
  _tocSelectedIdxs.clear(); _tocPendingTitleIdx=null;
  _tocCommit();
  Toast.success('되돌리기 완료 (남은 스냅샷: '+_tocUndoStack.length+'개)');
}

function renderTocItems(){
  // ══════════════════════════════════════════════════════════
  // 🗂 renderTocItems — 목차 편집 목록 (Phase 10: 가상 스크롤)
  // ★ Phase 10: 화면에 보이는 행(약 40개)만 DOM으로 생성
  //   이전: 2만 화면 2만 행(행마다 리스너 10개+)을 display:none으로 모두 만들고, 체크 하나에도 전체 재생성
  //   → 접기/펼치기 버튼 제거 (펼치기가 [style*="display: none"] 선택자로 병합 툴바·검색 필터 행까지 드러내던 문제 해소)
  // ★ B-FIX-06: 선택 상태는 모듈 스코프 (재렌더 시 보존)
  // ★ B-FIX-08: getSuspThreshold 진입 시 1회 캐싱
  // ══════════════════════════════════════════════════════════
  _refreshSuspThreshold();
  const c=document.getElementById('tb0');
  if(!c) return;
  _tocVS?.destroy(); _tocVS=null;
  // ★ PERF-GC: innerHTML='' 대신 replaceChildren() 사용
  c.replaceChildren();
  // ★ L-06: 전체 재렌더 시 내보내기 버튼 플래그 초기화 (updateTocStat에서 재생성)
  _tocExportBtnCreated=false;
  if(!S.tocItems.length){c.innerHTML='<div class="toc-empty">⚠️ 챕터가 감지되지 않았습니다.</div>';return;}
  // 글자수·짧은 챕터 표시는 원문 줄 범위로 다시 계산 (병합·분리·Undo 후에도 출력과 같은 기준)
  _recalcTocStats(S.tocItems);

  const _selectedIdxs = _tocSelectedIdxs;   // 참조 공유 (동일 Set 객체)

  // ══ 검색/필터 바 ══
  const filterBar=document.createElement('div');
  filterBar.style.cssText='display:flex;gap:6px;align-items:center;margin-bottom:8px;flex-wrap:wrap';
  filterBar.innerHTML=
    '<input id="toc-search" class="inp" placeholder="🔍 제목 검색..." style="flex:1;min-width:120px;font-size:var(--fs-xs);padding:5px 8px">'+
    // ★ 개선 01: 선택 모드 토글 버튼 (항상 노출)
    '<button class="btn btn-ghost btn-sm" id="toc-select-mode-btn" title="클릭으로 다중 선택 모드 전환 (터치·모바일 친화)" style="font-size:var(--fs-xs);white-space:nowrap">☑ 선택 모드</button>'+
    // ★ 개선 06: 짧은챕터 자동 선택
    '<button class="btn btn-ghost btn-sm" id="toc-auto-sel-susp" title="⚠ 짧은챕터 항목 전체 선택" style="font-size:var(--fs-xs);white-space:nowrap;display:none">⚠ 자동 선택</button>'+
    '<button class="btn btn-ghost btn-sm" onclick="undoToc()" title="되돌리기 (최대 10단계)" style="font-size:var(--fs-xs)">↩ Undo</button>';
  c.appendChild(filterBar);

  const searchInp=filterBar.querySelector('#toc-search');
  if(searchInp) searchInp.value=_tocFilterQ;
  searchInp?.addEventListener('input',e=>{
    _tocFilterQ=e.target.value.toLowerCase().trim();
    vs.setFilter(_tocFilterQ);
    // 검색 중 자동선택 버튼 숨김
    updateAutoSelBtn();
  });

  // ★ 개선 01: 선택 모드 토글
  const selectModeBtn=filterBar.querySelector('#toc-select-mode-btn');
  const paintSelectMode=()=>{
    if(!selectModeBtn) return;
    selectModeBtn.style.background=_tocSelectModeOn?'var(--blue)':'';
    selectModeBtn.style.color=_tocSelectModeOn?'var(--on-accent)':'';
    selectModeBtn.style.borderColor=_tocSelectModeOn?'var(--blue)':'';
    selectModeBtn.title=_tocSelectModeOn?'선택 모드 ON — 클릭만으로 선택됩니다 (다시 클릭해서 해제)':'선택 모드 OFF';
  };
  paintSelectMode();
  selectModeBtn?.addEventListener('click',()=>{
    _tocSelectModeOn=!_tocSelectModeOn;
    paintSelectMode();
    // 선택 모드 해제 시 선택 초기화
    if(!_tocSelectModeOn){
      _selectedIdxs.clear();
      vs.refresh();
      updateMergeBar();
    }
  });

  // ★ 개선 06: 짧은챕터 자동 선택 버튼
  const autoSelBtn=filterBar.querySelector('#toc-auto-sel-susp');
  function updateAutoSelBtn(){
    const suspCount=S.tocItems.filter(t=>t.suspicious).length;
    if(autoSelBtn) autoSelBtn.style.display=(suspCount>0&&!_tocFilterQ)?'':'none';
  }
  updateAutoSelBtn();
  autoSelBtn?.addEventListener('click',()=>{
    let first=-1;
    S.tocItems.forEach((t,i)=>{ if(t.suspicious){ _selectedIdxs.add(i); if(first<0) first=i; } });
    vs.refresh();
    updateMergeBar();
    // 첫 번째 선택 항목으로 스크롤
    if(first>=0) tocScrollToIndex(first);
    Toast.info('짧은챕터 '+_selectedIdxs.size+'개를 선택했어요. 병합 또는 제거를 선택하세요.',3000);
  });

  // ══ 병합 툴바 (★ 개선 03·05·07 포함) ══
  const toolbar=document.createElement('div');
  toolbar.id='toc-merge-bar';
  toolbar.style.cssText='display:none;flex-direction:column;gap:6px;padding:8px 10px;'+
    'background:var(--blue-bg);border-radius:var(--radius-sm);margin-bottom:8px;border:1px solid var(--blue)';

  // 상단 행: 카운트 + 액션 버튼들
  const toolbarTop=document.createElement('div');
  toolbarTop.style.cssText='display:flex;align-items:center;gap:8px;flex-wrap:wrap';
  toolbarTop.innerHTML=
    '<span id="toc-sel-count" style="font-size:var(--fs-xs);color:var(--blue);font-weight:600">0개 선택됨</span>'+
    '<button class="btn btn-sm" id="toc-merge-btn" style="font-size:var(--fs-xs);padding:3px 10px;background:var(--blue);color:var(--on-accent);border:none;border-radius:var(--radius-xs)">🔗 병합</button>'+
    '<button class="btn btn-sm" id="toc-sel-clear" style="font-size:var(--fs-xs);padding:3px 8px;background:none;border:1.5px solid var(--blue);color:var(--blue);border-radius:var(--radius-xs)">✕ 해제</button>'+
    // ★ 개선 05: 첫 번째 선택 항목으로 스크롤
    '<button class="btn btn-sm" id="toc-scroll-sel" title="선택한 첫 항목으로 스크롤" style="font-size:var(--fs-xs);padding:3px 7px;background:none;border:1.5px solid var(--blue);color:var(--blue);border-radius:var(--radius-xs)">📍 위치</button>';
  toolbar.appendChild(toolbarTop);

  // ★ 개선 05: 미니맵 — 선택된 인덱스 나열
  const minimap=document.createElement('div');
  minimap.id='toc-sel-minimap';
  minimap.style.cssText='display:none;font-size:var(--fs-xs);color:var(--blue);line-height:1.6;word-break:break-all';
  toolbar.appendChild(minimap);

  // ★ 개선 07: 병합 미리보기 패널
  const previewPanel=document.createElement('div');
  previewPanel.id='toc-merge-preview';
  previewPanel.style.cssText=
    'display:none;background:var(--bg2);border:1px solid var(--blue);border-radius:var(--radius-xs);'+
    'padding:8px 10px;font-size:var(--fs-xs);color:var(--text2);line-height:1.7;max-height:120px;overflow-y:auto';
  toolbar.appendChild(previewPanel);

  // ★ 개선 03: 제목 편집 영역 — 병합 직후 표시 (Phase 10: 이전엔 표시하는 코드가 없어 항상 숨겨져 있었음)
  const titleEditArea=document.createElement('div');
  titleEditArea.id='toc-merge-title-edit';
  titleEditArea.style.cssText='display:none;gap:6px;align-items:center;flex-wrap:wrap';
  titleEditArea.innerHTML=
    '<span style="font-size:var(--fs-xs);color:var(--blue);font-weight:600;flex-shrink:0">📝 제목:</span>'+
    '<input id="toc-merge-title-inp" class="inp" style="flex:1;min-width:120px;font-size:var(--fs-xs);padding:3px 7px">'+
    '<div style="display:flex;gap:4px;flex-shrink:0">'+
      '<button class="btn btn-sm" id="toc-mtitle-first" title="첫 챕터 제목 사용" style="font-size:var(--fs-xs);padding:2px 6px">첫 제목</button>'+
      '<button class="btn btn-sm" id="toc-mtitle-range" title="범위 표기 (1~N화)" style="font-size:var(--fs-xs);padding:2px 6px">범위</button>'+
      '<button class="btn btn-sm" id="toc-mtitle-join" title="이어붙이기" style="font-size:var(--fs-xs);padding:2px 6px">이어붙이기</button>'+
      '<button class="btn btn-sm" id="toc-mtitle-apply" style="font-size:var(--fs-xs);padding:2px 8px;background:var(--blue);color:var(--on-accent);border-radius:var(--radius-xs)">✓ 적용</button>'+
      '<button class="btn btn-sm" id="toc-mtitle-close" title="닫기" style="font-size:var(--fs-xs);padding:2px 6px">✕</button>'+
    '</div>';
  toolbar.appendChild(titleEditArea);

  c.appendChild(toolbar);

  // ══ 병합 실행 함수 ══
  async function execMerge(){
    const idxs=[..._selectedIdxs].sort((a,b)=>a-b);
    if(idxs.length<2) return;

    // ★ 개선 08: 검색 필터 중 병합 안전 확인
    if(_tocFilterQ){
      const ok=await Toast.confirm(
        '🔍 검색 필터가 활성 상태예요.<br>'+
        '필터된 화면에서 선택된 '+idxs.length+'개를 병합할까요?<br>'+
        '<span style="color:var(--text2);font-size:var(--fs-xs)">숨겨진 항목은 영향을 받지 않아요.</span>'
      );
      if(!ok) return;
    }

    // ★ 개선 10: 대량(20개+) 병합 시 로딩 표시
    const mergeBtn=toolbar.querySelector('#toc-merge-btn');
    if(idxs.length>20&&mergeBtn){
      mergeBtn.textContent='⏳ 병합 중...';
      mergeBtn.disabled=true;
      await yieldToMain();
    }

    _saveTocSnapshot();
    // ★ Phase 10: 병합 = 원문 줄 범위(세그먼트)를 한 챕터로 묶기 → 떨어진 항목끼리 병합해도 EPUB 출력과 일치
    const res=_tocMergeItems(idxs);
    _selectedIdxs.clear();
    if(!res) return;
    _tocPendingTitleIdx=res.index;   // ★ 개선 03: 병합 직후 제목 편집 영역 표시
    _tocCommit();

    // ★ 개선 10: 완료 토스트
    const len=res.merged.bodyLen||0;
    const totalWan=len>=10000?(len/10000).toFixed(1)+'만자':len.toLocaleString()+'자';
    Toast.success(idxs.length+'개 챕터를 1개로 병합했어요 (총 '+totalWan+')',3000);
  }

  // ══ 병합 버튼 이벤트 ══
  toolbarTop.querySelector('#toc-merge-btn')?.addEventListener('click', execMerge);

  toolbarTop.querySelector('#toc-sel-clear')?.addEventListener('click',()=>{
    _selectedIdxs.clear();
    _tocLastClickedIdx=null;
    vs.refresh();
    updateMergeBar();
  });

  // ★ 개선 05: 선택 위치로 스크롤
  toolbarTop.querySelector('#toc-scroll-sel')?.addEventListener('click',()=>{
    const firstIdx=[..._selectedIdxs].sort((a,b)=>a-b)[0];
    if(firstIdx!=null) tocScrollToIndex(firstIdx);
  });

  // ★ 개선 03: 제목 프리셋 버튼 — 방금 병합한 항목의 원본 제목 기준
  const pendingSources=()=>{
    const it=_tocPendingTitleIdx!=null?S.tocItems[_tocPendingTitleIdx]:null;
    return (it&&Array.isArray(it._mergedSources))?it._mergedSources:[];
  };
  const titleInpEl=titleEditArea.querySelector('#toc-merge-title-inp');
  titleEditArea.querySelector('#toc-mtitle-first')?.addEventListener('click',()=>{
    const src=pendingSources(); if(titleInpEl&&src.length) titleInpEl.value=src[0].title||'';
  });
  titleEditArea.querySelector('#toc-mtitle-range')?.addEventListener('click',()=>{
    const src=pendingSources(); if(titleInpEl&&src.length>1) titleInpEl.value=(src[0].title||'')+' ~ '+(src[src.length-1].title||'');
  });
  titleEditArea.querySelector('#toc-mtitle-join')?.addEventListener('click',()=>{
    const src=pendingSources(); if(titleInpEl) titleInpEl.value=src.map(s=>s.title||'').join(' + ');
  });
  titleEditArea.querySelector('#toc-mtitle-close')?.addEventListener('click',()=>{
    _tocPendingTitleIdx=null; updateMergeBar();
  });

  // ★ 개선 03: 제목 적용 버튼
  titleEditArea.querySelector('#toc-mtitle-apply')?.addEventListener('click',()=>{
    const newTitle=(titleInpEl?.value||'').trim();
    const it=_tocPendingTitleIdx!=null?S.tocItems[_tocPendingTitleIdx]:null;
    if(!newTitle||!it) return;
    it.title=newTitle;
    _tocPendingTitleIdx=null;
    _tocTouch();
    vs.refresh();
    updateMergeBar();
    Toast.success('제목을 "'+newTitle+'"으로 설정했어요.',2000);
  });

  function updateMergeBar(){
    const n=_selectedIdxs.size;
    const pendingItem=_tocPendingTitleIdx!=null?S.tocItems[_tocPendingTitleIdx]:null;
    if(!pendingItem) _tocPendingTitleIdx=null;
    toolbar.style.display=(n>0||pendingItem)?'flex':'none';
    const cnt=toolbarTop.querySelector('#toc-sel-count');
    if(cnt) cnt.textContent=n>0?n+'개 선택됨':'병합 완료';
    const mb=toolbarTop.querySelector('#toc-merge-btn');
    if(mb){ mb.disabled=n<2; mb.textContent='🔗 병합'; mb.style.display=n>0?'':'none'; }
    ['#toc-sel-clear','#toc-scroll-sel'].forEach(sel=>{ const b=toolbarTop.querySelector(sel); if(b) b.style.display=n>0?'':'none'; });

    // ★ 개선 05: 미니맵 업데이트
    if(n>0){
      const sortedIdxs=[..._selectedIdxs].sort((a,b)=>a-b);
      const labels=sortedIdxs.slice(0,8).map(i=>{
        const t=S.tocItems[i]?.title||'';
        return '<span style="background:var(--blue);color:var(--on-accent);border-radius:var(--radius-xs);padding:0 4px;margin:1px;display:inline-block">'+
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
      const totalChars=sortedIdxs.reduce((s,i)=>s+(S.tocItems[i]?.bodyLen||0),0);
      const totalWan=totalChars>=10000?(totalChars/10000).toFixed(1)+'만자':totalChars.toLocaleString()+'자';
      const previews=sortedIdxs.slice(0,5).map(i=>{
        const t=S.tocItems[i];
        const firstLine=_tocItemText(t,200).split('\n').find(l=>l.trim())||'(본문 없음)';
        return `<div style="border-left:2px solid var(--blue);padding-left:6px;margin:2px 0">
          <b style="font-size:var(--fs-xs);color:var(--blue)">${escHtml(t?.title||'')}</b>
          <span style="font-size:var(--fs-xs);opacity:.7"> — ${escHtml(firstLine.slice(0,40))}${firstLine.length>40?'…':''}</span>
        </div>`;
      });
      const morePreview=n>5?`<div style="font-size:var(--fs-xs);color:var(--text2);margin-top:2px">외 ${n-5}개 챕터...</div>`:'';
      previewPanel.innerHTML=
        `<div style="font-weight:600;color:var(--blue);margin-bottom:4px;font-size:var(--fs-xs)">병합하면 <b>${totalWan}</b> 챕터가 됩니다</div>`+
        previews.join('')+morePreview;
      previewPanel.style.display='';
    } else {
      previewPanel.style.display='none';
    }

    // ★ 개선 03: 병합 직후에만 제목 편집 영역 표시
    titleEditArea.style.display=pendingItem?'flex':'none';
    if(pendingItem&&titleInpEl&&document.activeElement!==titleInpEl) titleInpEl.value=pendingItem.title||'';
  }

  // ══ buildTocRow — 각 행 생성 (화면에 보이는 행만 호출됨) ══
  function buildTocRow(item, i){
    const d=document.createElement('div');
    d.className='toc-item'+(item.enabled?'':' off');
    d.dataset.idx=i;
    if(item._isMerged) d.dataset.merged='1';
    d.draggable=true;
    // 이미 선택된 상태 복원
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
    chk.setAttribute('aria-label',(item.title||'')+' 포함');
    chk.addEventListener('change',e=>{
      e.stopPropagation();
      const it=S.tocItems[i]; if(!it) return;
      it.enabled=e.target.checked;
      // ★ DOM만 업데이트 (전체 재렌더링 없음)
      d.classList.toggle('off',!e.target.checked);
      _tocTouch();
      updateTocStat();
    });

    // 줄 번호
    const num=document.createElement('span');
    num.className='toc-num'; num.textContent=item.line+'줄';

    // ★ B2+B3+B6+B9: 글자수 배지 — item.bodyLen (원문 줄 범위 기준, Phase 10)
    const charBadge=document.createElement('span');
    charBadge.className='toc-char-badge';
    const _bLen = item.bodyLen||0;
    {
      // ★ B3: 1만자 이상은 '만자' 단위
      let _bTxt;
      if(_bLen < 1000)       _bTxt = _bLen + '자';
      else if(_bLen < 10000) _bTxt = (_bLen/1000).toFixed(1) + 'k';
      else                   _bTxt = (_bLen/10000).toFixed(1) + '만';
      charBadge.textContent = _bTxt;
      charBadge.title = '본문 글자수 (공백 제외): ' + _bLen.toLocaleString() + '자 (기준: ' + _suspThresholdCached + '자)';
      const _isShort = _bLen > 0 && _bLen < _suspThresholdCached;
      // ★ FIX-04: CSS 변수로 교체 (하드코딩 색상 제거)
      charBadge.style.cssText=
        'font-size:var(--fs-xs);padding:1px 5px;border-radius:var(--radius-xs);flex-shrink:0;white-space:nowrap;cursor:default;'+
        (_isShort
          ? 'background:var(--yellow-bg);color:var(--yellow);border:1px solid var(--accent2)'
          : 'background:var(--bg2);color:var(--text2);border:1px solid var(--border)');
      if(_isShort) charBadge.dataset.short='1';

      // ★ I6: hover 시 본문 앞 3줄 팝오버 표시 (본문은 원문 줄에서 필요한 만큼만 읽음)
      let _charPopTimer=null;
      charBadge.addEventListener('mouseenter',()=>{
        _charPopTimer=setTimeout(()=>{
          const preview=_tocItemText(item,600).split('\n').filter(l=>l.trim()).slice(0,3).join('\n')||'(본문 없음)';
          const pop=document.createElement('div');
          pop.style.cssText='position:fixed;z-index:9999;background:var(--panel);border:1.5px solid var(--border);border-radius:var(--radius-sm);padding:8px 10px;font-size:var(--fs-xs);max-width:280px;box-shadow:var(--shadow-md);pointer-events:none;color:var(--text2);line-height:1.6;white-space:pre-wrap;word-break:break-all';
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
    titleInp.setAttribute('aria-label','챕터 제목');
    titleInp.addEventListener('click',e=>e.stopPropagation());
    titleInp.addEventListener('change',e=>{
      const it=S.tocItems[i]; if(!it) return;
      const newTitle=e.target.value.trim()||it.title;
      if(!it.originalTitle) it.originalTitle=it.title;
      it.title=newTitle;
      // ★ 제목 편집 시에도 캐시 무효화 + 상태 구독자 알림
      _tocTouch();
      updateTocEditBanner&&updateTocEditBanner();
    });
    titleInp.addEventListener('keydown',e=>{
      if(e.key==='Enter'){e.target.blur();}
      if(e.key==='Escape'){e.target.value=S.tocItems[i]?.title||'';e.target.blur();}
    });

    // ★ 개선 01: 호버 퀵 선택 버튼 (+)
    const quickSelBtn=document.createElement('button');
    quickSelBtn.className='toc-quick-sel-btn';
    quickSelBtn.textContent='+';
    quickSelBtn.title='클릭해서 병합 선택에 추가 (또는 Ctrl+클릭)';
    quickSelBtn.setAttribute('aria-label',(item.title||'')+' 병합 선택');
    quickSelBtn.addEventListener('click',e=>{
      e.stopPropagation();
      if(_selectedIdxs.has(i)){
        _selectedIdxs.delete(i);
        d.classList.remove('multi-selected');
      } else {
        _selectedIdxs.add(i);
        d.classList.add('multi-selected');
        _tocLastClickedIdx=i;
      }
      updateMergeBar();
    });

    d.appendChild(handle);d.appendChild(chk);d.appendChild(num);
    d.appendChild(charBadge);
    d.appendChild(titleInp);

    // ★ 개선 04: 병합된 챕터에 🔓 분리 버튼
    if(item._isMerged && item._mergedSources && item._mergedSources.length>=2){
      const splitBadge=document.createElement('span');
      splitBadge.style.cssText=
        'font-size:var(--fs-xs);background:var(--blue-bg);color:var(--blue);border-radius:var(--radius-xs);'+
        'padding:1px 5px;flex-shrink:0;white-space:nowrap;cursor:default;'+
        'border:1px solid var(--blue);display:inline-flex;align-items:center;gap:3px';
      splitBadge.textContent='🔗 '+item._mergedSources.length+'개 병합';
      splitBadge.title='이 챕터는 '+item._mergedSources.length+'개 챕터가 병합된 상태입니다';

      const unmergeBtn=document.createElement('button');
      unmergeBtn.className='btn btn-sm';
      unmergeBtn.style.cssText=
        'font-size:var(--fs-xs);padding:1px 7px;flex-shrink:0;'+
        'background:var(--blue-bg);color:var(--blue);'+
        'border:1px solid var(--blue);border-radius:var(--radius-xs);line-height:1.5;'+
        'white-space:nowrap;transition:all .15s;cursor:pointer';
      unmergeBtn.innerHTML='🔓&nbsp;분리';
      unmergeBtn.title='병합 전 상태로 복원합니다 (Undo와 독립적)';
      unmergeBtn.addEventListener('mouseenter',()=>{unmergeBtn.style.background='var(--blue)';unmergeBtn.style.color='var(--on-accent)';});
      unmergeBtn.addEventListener('mouseleave',()=>{unmergeBtn.style.background='var(--blue-bg)';unmergeBtn.style.color='var(--blue)';});
      unmergeBtn.addEventListener('click',e=>{
        e.stopPropagation();
        _saveTocSnapshot();
        const idx=S.tocItems.indexOf(item);
        if(idx<0) return;
        // ★ Phase 10: 원본 줄 번호(src.line)로 복원 (이전: item.line+si로 임의 부여 → 분리 후 본문 경계가 1줄씩 어긋남)
        const restored=item._mergedSources.map(src=>({
          line:          src.line,
          title:         src.title,
          enabled:       src.enabled!==false,
          autoSplit:     !!src.autoSplit,
          num:           src.num!=null?src.num:null,
          kind:          src.kind||'ch',
          originalTitle: src.originalTitle||src.title,
        }));
        // 첫 원본은 병합 항목 자리에, 나머지는 줄 번호 순서상 원래 자리에 다시 끼움
        //   (떨어진 항목끼리 병합했던 경우 — 이전 위치(사이 항목들 뒤)로 정확히 복원)
        const list=S.tocItems;
        list.splice(idx, 1, restored[0]);
        for(const r of restored.slice(1)){
          let at=list.findIndex((t,k)=>k>idx&&t.line>r.line);
          if(at<0) at=list.length;
          list.splice(at, 0, r);
        }
        _tocCommit();
        Toast.success('챕터를 '+restored.length+'개로 분리했어요.',2500);
      });
      d.appendChild(splitBadge);d.appendChild(unmergeBtn);
    } else if(item.suspicious){
      // 오감지 배지 + 병합 버튼
      const badge=document.createElement('span');
      badge.style.cssText=
        'font-size:var(--fs-xs);background:var(--yellow-bg);color:var(--yellow);border-radius:var(--radius-xs);'+
        'padding:1px 6px;flex-shrink:0;white-space:nowrap;cursor:default;'+
        'border:1px solid var(--accent2);display:inline-flex;align-items:center;gap:3px';
      badge.innerHTML='<span>⚠</span><span>본문 짧음</span>';
      badge.title='이 챕터 본문이 '+_suspThresholdCached+'자 미만이에요 — 오감지일 수 있어요';

      const removeBtn=document.createElement('button');
      removeBtn.className='btn btn-sm';
      removeBtn.style.cssText=
        'font-size:var(--fs-xs);padding:1px 7px;flex-shrink:0;'+
        'background:var(--accent-bg);color:var(--accent);'+
        'border:1px solid var(--accent);border-radius:var(--radius-xs);line-height:1.5;'+
        'white-space:nowrap;transition:all .15s';
      removeBtn.innerHTML='⤵&nbsp;병합';
      removeBtn.title='이 짧은 챕터와 다음 챕터를 병합합니다 (본문 이어붙이기)';
      removeBtn.addEventListener('mouseenter',()=>{removeBtn.style.background='var(--blue)';removeBtn.style.color='var(--on-accent)';removeBtn.style.borderColor='var(--blue)';});
      removeBtn.addEventListener('mouseleave',()=>{removeBtn.style.background='var(--accent-bg)';removeBtn.style.color='var(--accent)';removeBtn.style.borderColor='var(--accent)';});
      removeBtn.addEventListener('click',e=>{
        e.stopPropagation();
        const idx=S.tocItems.indexOf(item);
        if(idx<0) return;
        _saveTocSnapshot();
        if(idx+1 < S.tocItems.length){
          // ★ BUG-FIX 04: 다음 챕터를 현재 챕터에 병합 (제목은 현재 챕터 유지)
          _tocMergeItems([idx,idx+1], item.title);
          Toast.success(`"${item.title}"에 다음 챕터를 병합했어요.`,2500);
        } else if(idx>0){
          // 마지막 챕터: 이전 챕터에 병합
          _tocMergeItems([idx-1,idx], S.tocItems[idx-1].title);
          Toast.success('마지막 챕터를 이전 챕터에 병합했어요.',2500);
        } else {
          Toast.info('병합할 다른 챕터가 없어요.',2000);
          return;
        }
        _tocCommit();
        const remaining=S.tocItems.filter(t=>t.suspicious).length;
        if(remaining===0) document.getElementById('susp-toast')?.remove();
      });
      d.appendChild(badge);d.appendChild(removeBtn);
    }
    d.appendChild(quickSelBtn);

    // ★ 개선 01+02: Ctrl+클릭 / Cmd+클릭 → 다중 선택 토글 / Shift+클릭 → 범위 선택
    d.addEventListener('click',e=>{
      const isSelectMode=_tocSelectModeOn||(e.ctrlKey||e.metaKey);
      if(!isSelectMode&&!e.shiftKey) return;
      e.preventDefault();

      if(e.shiftKey && _tocLastClickedIdx!==null){
        // ★ 개선 02: Shift+클릭 범위 선택 (검색 필터 중이면 보이는 항목만)
        const from=Math.min(_tocLastClickedIdx, i);
        const to  =Math.max(_tocLastClickedIdx, i);
        for(let k=from;k<=to;k++){ if(vs.isVisibleIdx(k)) _selectedIdxs.add(k); }
        vs.refresh();
      } else if(_selectedIdxs.has(i)){
        _selectedIdxs.delete(i);
        d.classList.remove('multi-selected');
      } else {
        _selectedIdxs.add(i);
        d.classList.add('multi-selected');
        _tocLastClickedIdx=i;
      }
      updateMergeBar();
    });

    // ★ 개선 09: 드래그 이벤트 — 행 중앙 드롭 = 병합, 상단/하단 드롭 = 순서 변경
    d.addEventListener('dragstart',e=>{
      _tocDragSrc=i;
      d.classList.add('dragging');
      e.dataTransfer.effectAllowed='move';
      try{ e.dataTransfer.setData('text/plain', String(i)); }catch(_){}   // Firefox: setData 없으면 드래그 시작 안 됨
    });
    d.addEventListener('dragend',()=>{
      d.classList.remove('dragging');
      _tocDragSrc=null;
      c.querySelectorAll('.toc-item.drag-over,.toc-item.drag-merge-target').forEach(el=>{
        el.classList.remove('drag-over','drag-merge-target');
      });
    });
    d.addEventListener('dragover',e=>{
      e.preventDefault();
      if(_tocDragSrc===null||_tocDragSrc===i) return;
      c.querySelectorAll('.toc-item.drag-over,.toc-item.drag-merge-target').forEach(el=>{
        el.classList.remove('drag-over','drag-merge-target');
      });
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
      _tocDragSrc=null;
      const isMergeTarget=d.classList.contains('drag-merge-target');
      d.classList.remove('drag-over','drag-merge-target');
      if(src===null||src===i||!S.tocItems[src]) return;

      _saveTocSnapshot();
      if(isMergeTarget){
        // ★ 개선 09: 드래그 병합 실행 (세그먼트 결합 — 출력과 일치)
        const res=_tocMergeItems([src,i], S.tocItems[src].title+' + '+S.tocItems[i].title);
        _selectedIdxs.clear();
        _tocCommit();
        const len=res?.merged?.bodyLen||0;
        const totalWan=len>=10000?(len/10000).toFixed(1)+'만자':len.toLocaleString()+'자';
        Toast.success('드래그 병합 완료 (총 '+totalWan+')',2500);
      } else {
        // 순서 변경 — ★ Phase 10: EPUB 출력도 목차 순서를 따름 (이전: 줄 번호로 재정렬되어 무시됨)
        const moved=S.tocItems.splice(src,1)[0];
        const dest=src<i?i-1:i;
        S.tocItems.splice(dest,0,moved);
        _selectedIdxs.clear();
        _tocCommit();
      }
    });
    return d;
  }

  // ══ 가상 스크롤 목록 ══
  const host=document.createElement('div');
  host.className='toc-vlist';
  host.setAttribute('role','list');
  c.appendChild(host);
  const vs=_createTocVirtualList(c, host, buildTocRow);
  _tocVS=vs;
  vs.setFilter(_tocFilterQ);

  const stat=document.createElement('div');
  stat.id='toc-stat';
  stat.style.cssText='margin-top:8px;display:flex;gap:6px;align-items:center;flex-wrap:wrap';
  c.appendChild(stat);
  updateMergeBar();
  updateTocStat();
}

// ── 목차 가상 스크롤 (tb0 스크롤 컨테이너 안의 host에 보이는 행만 렌더) ──
//   행 높이는 첫 행을 그려 실측 (탭이 숨겨져 0이면 마지막 실측값 사용)
let _tocRowH=34;
function _createTocVirtualList(scroller, host, buildRow){
  const BUF=12;
  let view=[];              // 표시 대상 tocItems 인덱스 (검색 필터 적용)
  let viewPos=new Map();    // tocItems 인덱스 → view 위치
  let lastStart=-1,lastEnd=-1,raf=0;
  const measure=()=>{
    const first=host.firstElementChild;
    const h=first?first.getBoundingClientRect().height:0;
    if(h>4&&Math.abs(h-_tocRowH)>0.5){ _tocRowH=h; host.style.height=(view.length*_tocRowH)+'px'; return true; }
    return false;
  };
  const hostTop=()=>host.getBoundingClientRect().top-scroller.getBoundingClientRect().top+scroller.scrollTop;
  function render(force){
    raf=0;
    const top=Math.max(0, scroller.scrollTop-hostTop());
    const viewH=scroller.clientHeight||280;
    const start=Math.max(0, Math.floor(top/_tocRowH)-BUF);
    const end=Math.min(view.length, Math.ceil((top+viewH)/_tocRowH)+BUF);
    if(!force&&start===lastStart&&end===lastEnd) return;
    lastStart=start; lastEnd=end;
    const frag=document.createDocumentFragment();
    for(let k=start;k<end;k++){
      const i=view[k], item=S.tocItems[i];
      if(!item) continue;
      const row=buildRow(item,i);
      row.style.top=(k*_tocRowH)+'px';
      row.setAttribute('role','listitem');
      frag.appendChild(row);
    }
    host.replaceChildren(frag);
    if(measure()) render(true);
  }
  const onScroll=()=>{ if(!raf) raf=requestAnimationFrame(()=>render(false)); };
  scroller.addEventListener('scroll', onScroll, {passive:true});
  return {
    setFilter(q){
      view=[]; viewPos=new Map();
      S.tocItems.forEach((t,i)=>{ if(!q||String(t.title||'').toLowerCase().includes(q)){ viewPos.set(i,view.length); view.push(i); } });
      host.style.height=(view.length*_tocRowH)+'px';
      render(true);
    },
    refresh(){ render(true); },
    isVisibleIdx(i){ return viewPos.has(i); },
    scrollTo(i){
      if(!viewPos.has(i)) return false;
      const k=viewPos.get(i);
      scroller.scrollTop=Math.max(0, hostTop()+k*_tocRowH-(scroller.clientHeight||280)/2+_tocRowH/2);
      render(true);
      return true;
    },
    destroy(){ scroller.removeEventListener('scroll', onScroll); if(raf) cancelAnimationFrame(raf); },
  };
}

// 목차 목록에서 특정 항목으로 스크롤 + 잠깐 강조 (차트·짧은 챕터 칩·선택 위치 버튼 공용)
function tocScrollToIndex(i){
  if(!_tocVS||i==null||!S.tocItems[i]) return;
  if(!_tocVS.isVisibleIdx(i)){
    // 검색 필터에 가려진 항목이면 필터 해제 후 이동
    _tocFilterQ='';
    const inp=document.getElementById('toc-search'); if(inp) inp.value='';
    _tocVS.setFilter('');
  }
  _tocVS.scrollTo(i);
  const row=document.querySelector('#tb0 .toc-item[data-idx="'+i+'"]');
  if(row){
    row.classList.add('toc-focus');
    setTimeout(()=>row.classList.remove('toc-focus'),1200);
  }
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
    totalChars += t.bodyLen||0;
  });
  const avgChars  = active > 0 ? Math.round(totalChars / active) : 0;
  // ★ 총글자수 표시: 1만자 미만이면 '자' 단위, 이상이면 '만자' 단위
  const totalWanStr = totalChars >= 10000
    ? (totalChars / 10000).toFixed(1) + '만자'
    : totalChars.toLocaleString() + '자';
  // ★ FIX-07: getSuspThreshold() 호출 시점 평가
  const _suspThr = getSuspThreshold();
  // ★ I2: 짧은/긴 챕터 경고 집계 (B10: enabled만)
  const shortCount= S.tocItems.filter(t=>t.enabled&&(t.bodyLen||0)<_suspThr).length;
  const longCount = S.tocItems.filter(t=>t.enabled&&(t.bodyLen||0)>50000).length;

  // ★ I2: 통계 칩 배지 스타일
  const chip = (txt,color)=>
    `<span style="display:inline-flex;align-items:center;font-size:var(--fs-xs);padding:1px 7px;border-radius:99px;white-space:nowrap;background:${color.bg};color:${color.fg};border:1px solid ${color.bd}">${txt}</span>`;

  const statChips = [
    chip('총 '+totalWanStr, {bg:'var(--blue-bg)',fg:'var(--blue)',bd:'var(--blue)'}),
    chip('평균 '+avgChars.toLocaleString()+'자', {bg:'var(--bg2)',fg:'var(--text2)',bd:'var(--border)'}),
    shortCount>0 ? chip('⚠ 짧은챕터 '+shortCount+'(기준:'+_suspThr+'자)', {bg:'var(--accent-bg)',fg:'var(--accent)',bd:'var(--accent)'}) : '',
    longCount>0  ? chip('📌 긴챕터 '+longCount,    {bg:'var(--blue-bg)',fg:'var(--blue)',bd:'var(--blue)'}) : '',
  ].filter(Boolean).join('');

  // ★ I5: 짧은 챕터 배지 클릭 시 스크롤 — 이벤트 위임으로 처리
  const suspBtn=suspCount>0
    ? '<button class="btn btn-sm" data-action="removeAllSuspicious" '+
      'style="font-size:var(--fs-xs);background:var(--accent-bg);color:var(--accent);'+
      'border:1px solid var(--accent);border-radius:var(--radius-xs);display:inline-flex;align-items:center;gap:4px"'+
      ' title="본문 짧음 항목을 목차에서 모두 제거합니다">'+
      '<span>⚠</span><span>본문 짧음 '+suspCount+'개 전체 제거</span></button>'
    : '';

  stat.innerHTML=
    '<button class="btn btn-ghost btn-sm" data-action="toggleAllToc" data-val="true">전체 선택</button>'+
    '<button class="btn btn-ghost btn-sm" data-action="toggleAllToc" data-val="false">전체 해제</button>'+
    suspBtn+
    '<span style="display:flex;gap:4px;align-items:center;margin-left:auto;flex-wrap:wrap">'+
      statChips+
      '<span style="font-size:var(--fs-xs);color:var(--text2)">'+total+'개 중 '+active+'개 활성</span>'+
    '</span>';

  // ★ A-04: 변환 탭 버튼 배지
  const convertTab = document.querySelector('.page-tab[data-page="convert"]');
  if(convertTab){
    const badgeId = 'convertTabBadge';
    let badge = document.getElementById(badgeId);
    if(!badge){
      badge = document.createElement('sup');
      badge.id = badgeId;
      badge.style.cssText = 'margin-left:3px;font-size:var(--fs-xs);background:var(--accent);color:var(--on-accent);border-radius:99px;padding:0 5px;vertical-align:super;font-weight:700';
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
    exportBtn.style.cssText='font-size:var(--fs-xs);padding:2px 8px;margin-left:4px';
    exportBtn.textContent='📋 내보내기';
    exportBtn.title='목차를 글자수 포함 TXT로 내보내기';
    exportBtn.onclick=()=>{ if(typeof exportTocWithStats==='function') exportTocWithStats(); };
    document.getElementById('toc-stat')?.appendChild(exportBtn);
  }
}
function toggleAllToc(v){
  _saveTocSnapshot();
  S.tocItems.forEach(t=>t.enabled=v);
  _tocCommit();
}
function tocTab(n){
  // #tocPanel 내부로 스코프 제한 (전체 문서의 .ttab 오토글 방지)
  const panel=document.getElementById('tocPanel');
  if(panel) panel.querySelectorAll('.ttab').forEach((t,i)=>t.classList.toggle('on',i===n));
  [0,1,2,3].forEach(i=>{ const el=document.getElementById('tb'+i); if(el) el.style.display=i===n?'':'none'; });
  if(n===0) _tocVS?.refresh();   // ★ Phase 10: 숨겨진 상태에서 그린 가상 목록을 실제 높이로 다시 계산
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
// ★ B-FIX-04: 재정의 레이스 가드 — 이미 정의된 경우 건너뜀
if(!Object.getOwnPropertyDescriptor(window,'_fullRawLines')){
  Object.defineProperty(window,'_fullRawLines',{
    get(){ return _fullRawLines; },
    set(v){ _fullRawLines=v||[]; },
    configurable:true,
  });
}

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
  hint.style.cssText='font-size:var(--fs-xs);color:var(--text2);margin-bottom:8px';
  hint.textContent='챕터를 클릭하면 해당 챕터 본문 앞부분을 미리볼 수 있어요.';
  c.appendChild(hint);

  enabled.forEach((item,idx)=>{
    const div=document.createElement('div');
    div.className='toc-preview-item'+(idx===_previewActiveIdx?' active':'');
    div.innerHTML=
      '<div style="display:flex;align-items:center;gap:6px">'+
      '<span style="font-size:var(--fs-xs);color:var(--text2);min-width:36px">'+item.line+'줄</span>'+
      '<span style="font-size:var(--fs-sm);font-weight:600;flex:1">'+escHtml(item.title)+'</span>'+
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
  stat.style.cssText='margin-top:10px;font-size:var(--fs-xs);color:var(--text2);border-top:1px solid var(--border);padding-top:8px;text-align:center';
  stat.textContent='총 '+enabled.length+'개 챕터 · 파일 '+(_fullRawLines.length||'?')+'줄';
  c.appendChild(stat);
}

// ══════════════════════════════════════════
// ⚡ Module: AutoSplitByInterval — Fail-safe 간격 분할 엔진
// ══════════════════════════════════════════

// ── L2: 빈 줄 군집 간격의 중앙값으로 화수 추정 (보조 함수) ──
// 실패하면 null 반환 — 호출자가 폴백 처리
function _estimateTotalByBlankClusters(lines){
  try{
    const boundaries=[];
    let blankRun=0;
    for(let i=0;i<lines.length;i++){
      if(!lines[i].trim()){ blankRun++; }
      else { if(blankRun>=2) boundaries.push(i); blankRun=0; }
    }
    if(boundaries.length<3) return null;
    const gaps=[];
    for(let k=1;k<boundaries.length;k++) gaps.push(boundaries[k]-boundaries[k-1]);
    gaps.sort((a,b)=>a-b);
    const medianGap=gaps[Math.floor(gaps.length/2)];
    if(!medianGap||medianGap<10) return null;
    const estimated=Math.round(lines.length/medianGap);
    return {estimated, medianGap};
  }catch(e){ return null; }
}

// ── L3: interval 위치 주변 ±10줄에서 제목 후보 탐색 (보조 함수) ──
// 실패하면 null 반환 — 호출자가 기본 제목으로 폴백
function _findNearbyTitle(lines, centerIdx, windowSize=10){
  try{
    const start=Math.max(0, centerIdx-windowSize);
    const end  =Math.min(lines.length-1, centerIdx+windowSize);
    let best=null, bestScore=Infinity;
    for(let i=start;i<=end;i++){
      const l=(lines[i]||'').trim();
      if(!l||l.length<2||l.length>40) continue;
      if(/[.,，。、]$/.test(l)) continue;
      if(/^[""\u201C\u201D'""]/.test(l)) continue;
      if(/[은는이가을를에서으로]$/.test(l)&&l.length>15) continue;
      const score=Math.abs(i-centerIdx)*2+l.length;
      if(score<bestScore){ bestScore=score; best=l; }
    }
    return best;
  }catch(e){ return null; }
}

// ── L6: 분할 품질 점수 계산 ──
function _calcSplitQuality(tocItems){
  if(!tocItems.length) return {score:0, avgLen:0, suspRatio:0};
  const lens=tocItems.map(t=>t.bodyLen||0);
  const avg=lens.reduce((s,v)=>s+v,0)/lens.length;
  const variance=lens.reduce((s,v)=>s+(v-avg)**2,0)/lens.length;
  const cv=avg>0?Math.sqrt(variance)/avg:1;
  const score=Math.max(0,Math.round((1-Math.min(cv,1))*100));
  const suspRatio=tocItems.filter(t=>t.suspicious).length/tocItems.length;
  return {score, avgLen:Math.round(avg), suspRatio};
}

// ── L8: 하이브리드 병합 — 패턴 anchor + 간격 보완 ──
function _mergeHybrid(anchorItems, intervalItems, totalLines){
  if(!anchorItems.length) return intervalItems;
  if(!intervalItems.length) return anchorItems;
  const avgAnchorGap=totalLines/Math.max(anchorItems.length,1);
  const result=[...anchorItems];
  for(let ai=0;ai<anchorItems.length-1;ai++){
    const gapStart=anchorItems[ai].line;
    const gapEnd  =anchorItems[ai+1].line;
    if(gapEnd-gapStart < avgAnchorGap*2) continue;
    const fills=intervalItems.filter(iv=>iv.line>gapStart&&iv.line<gapEnd);
    fills.forEach(f=>result.push({...f, _hybridFill:true}));
  }
  result.sort((a,b)=>a.line-b.line);
  return result;
}

// ── L7: 제목 일괄 변경 툴바 ──
function _renderTitleTemplateBar(){
  document.getElementById('title-template-bar')?.remove();
  const bar=document.createElement('div');
  bar.id='title-template-bar';
  bar.style.cssText=
    'display:flex;align-items:center;gap:6px;flex-wrap:wrap;'+
    'padding:6px 8px;background:var(--bg2);border-radius:var(--radius-xs);margin:4px 0 8px;';
  bar.innerHTML=
    '<span style="font-size:var(--fs-xs);color:var(--text2);flex-shrink:0">📝 제목 일괄:</span>'+
    '<button class="btn btn-ghost btn-sm" data-tpl="제{N}화" style="font-size:var(--fs-xs)">제{N}화</button>'+
    '<button class="btn btn-ghost btn-sm" data-tpl="Chapter {N}" style="font-size:var(--fs-xs)">Chapter {N}</button>'+
    '<button class="btn btn-ghost btn-sm" data-tpl="{N}화" style="font-size:var(--fs-xs)">{N}화</button>'+
    '<input class="inp" id="title-tpl-custom" placeholder="직접 입력 ({N}=번호)" '+
      'style="flex:1;min-width:80px;font-size:var(--fs-xs);padding:3px 7px">'+
    '<button class="btn btn-accent btn-sm" id="title-tpl-apply" style="font-size:var(--fs-xs)">적용</button>'+
    '<button class="btn btn-ghost btn-sm" id="title-tpl-close" style="font-size:var(--fs-xs);padding:2px 6px">✕</button>';
  bar.querySelectorAll('[data-tpl]').forEach(btn=>{
    btn.addEventListener('click',()=>{
      const el=document.getElementById('title-tpl-custom');
      if(el) el.value=btn.dataset.tpl;
    });
  });
  bar.querySelector('#title-tpl-apply')?.addEventListener('click',()=>{
    const tpl=(document.getElementById('title-tpl-custom')?.value||'').trim();
    if(!tpl){Toast.warn('템플릿을 입력하세요. 예: 제{N}화');return;}
    _saveTocSnapshot();
    S.tocItems.forEach((t,i)=>{
      if(t.autoSplit||t._autoGenerated){
        t.title=tpl.replace(/\{N\}/g,String(i+1));
        t.originalTitle=t.title;
      }
    });
    document.querySelectorAll('#tb0 .toc-item[data-idx]').forEach(el=>{
      const idx=parseInt(el.dataset.idx);
      const t=S.tocItems[idx];
      if(t&&(t.autoSplit||t._autoGenerated)){
        const inp=el.querySelector('.toc-title-edit');
        if(inp) inp.value=t.title;
      }
    });
    Toast.success('제목 템플릿 적용 완료 ('+S.tocItems.filter(t=>t.autoSplit||t._autoGenerated).length+'개)', 2000);
  });
  bar.querySelector('#title-tpl-close')?.addEventListener('click',()=>bar.remove());
  document.getElementById('tb0')?.insertAdjacentElement('afterbegin', bar);
}

// ════════════════════════════════════════════════════════════
// ★ _snapToBoundary v2 — 가중치 점수제 기반 문맥 경계 보정
//
// 10가지 보정 방안 전체 구현:
//   #1  Zero-Loss: title 추출이 body에서 줄을 삭제하지 않음 (autoSplitByInterval에서 보장)
//   #2  가중치 기반 경계 점수제 — 각 줄에 점수 부여 후 최고점 선택
//   #3  대사 가로채기 방지 가드 — 열린 따옴표 줄 분할 제외
//   #4  공백 줄 우선권 스캔 (+100점)
//   #5  문장 부호 완결성 검사 (+50점)
//   #6  탐색 윈도우 Max 30줄 제한
//   #7  인덱스 역전·영역 침범 차단
//   #8  기본값 폴백 안전장치 (예외 시 수학값 반환)
//   #9  유령 공백(\r, 제로너비 등) 정규식 스크리닝
//   #10 웹소설 연속 2줄+ 공백 최우선권 (+120점)
//   #11 보정 상태 console.warn 로깅
//
// 파라미터:
//   lines      : 전체 줄 배열
//   mathIdx    : 수학적 균등 분할 지점 (0-based)
//   lowerBound : 탐색 하한 (이 챕터 전용 범위)
//   upperBound : 탐색 상한 (이웃 화 침범 불가)
//   maxRange   : 위아래 최대 탐색 줄 수 (기본 30)
// 반환: 보정된 경계 인덱스 [lowerBound, upperBound) 범위 내 보장
// ════════════════════════════════════════════════════════════
function _snapToBoundary(lines, mathIdx, lowerBound, upperBound, maxRange=30){
  try{
    // #7: 입력 유효성 클램핑
    const safeIdx   = Math.max(lowerBound, Math.min(mathIdx,   upperBound-1));
    const scanStart = Math.max(lowerBound, safeIdx - maxRange); // #6
    const scanEnd   = Math.min(upperBound, safeIdx + maxRange); // #6

    if(scanStart >= scanEnd){
      // 탐색 범위 없으면 즉시 폴백 (#8)
      return safeIdx;
    }

    // #2·#4·#5·#9·#10: 가중치 점수 계산
    let bestScore = -Infinity;
    let bestIdx   = safeIdx; // #8 기본값 = 수학적 위치

    // #3: 대사 감지용 따옴표 집합
    const OPEN_QUOTES  = ['"', '\u201C', '\u2018', "'"];
    const CLOSE_QUOTES = ['"', '\u201D', '\u2019', "'"];

    for(let i = scanStart; i < scanEnd; i++){
      // #9: 유령 공백 정규화
      const rawLine  = (lines[i]   || '').replace(/[\r\u200B\uFEFF\u00A0]/g, '').trim();
      const prevLine = (i > 0 ? lines[i-1] : '') /* B-FIX-02: i=0 경계 가드 */.replace(/[\r\u200B\uFEFF\u00A0]/g, '').trim();

      let score = 0;

      // #10: 웹소설 연속 2줄+ 공백 — 최우선권 (+120)
      if(!rawLine && !prevLine){
        score += 120;
      }
      // #4: 단일 공백 줄 — 높은 우선권 (+100)
      else if(!rawLine){
        score += 100;
      }
      // #5: 이전 줄이 문장 부호 완결 (+50)
      if(prevLine && /[.?!…。！？]$/.test(prevLine)){
        score += 50;
      }
      // #5: 이전 줄이 말줄임표 변형 (+30)
      if(prevLine && /\.{2,}$/.test(prevLine)){
        score += 30;
      }

      // 수학적 위치 거리 페널티 (균등도 유지)
      score -= Math.abs(i - safeIdx) * 2;

      // #3: 대사 흐름 가로채기 방지
      // 현재 줄이 열린 따옴표로 시작하고 닫히지 않으면 분할 제외
      const startsOpen = OPEN_QUOTES.some(q => rawLine.startsWith(q))
                       && !CLOSE_QUOTES.some(q => rawLine.endsWith(q));
      if(startsOpen) score -= 999;

      if(score > bestScore){
        bestScore = score;
        bestIdx   = i;
      }
    }

    // #7: 최종 범위 안전 클램핑
    const finalIdx = Math.max(lowerBound, Math.min(bestIdx, upperBound - 1));

    // #11: 보정 상태 로깅
    const delta = finalIdx - mathIdx;
    if(delta !== 0){
      console.warn(
        `[autoSplit] 경계 보정: ${mathIdx+1}줄 → ${finalIdx+1}줄 `+
        `(${delta > 0 ? '+' : ''}${delta}줄, 점수=${bestScore})`
      );
    }

    return finalIdx;

  }catch(err){
    // #8: 예외 발생 시 수학값 클램핑 폴백
    console.warn('[autoSplit] _snapToBoundary 예외, 폴백:', err);
    return Math.max(lowerBound, Math.min(mathIdx, upperBound - 1));
  }
}

// ════════════════════════════════════════════════════════════
// ⚡ autoSplitByInterval — 메인 진입점
// hybridMode=true: 기존 패턴 감지 결과를 anchor로 보완
// ════════════════════════════════════════════════════════════
async function autoSplitByInterval(hybridMode=false){
  if(!S.txtFiles.length){Toast.warn('TXT 파일을 먼저 선택해주세요.');return;}

  // 하이브리드: 기존 tocItems 스냅샷 (순수 분할 실행 전에 미리 저장)
  const existingItems=hybridMode&&S.tocItems.length>0 ? [...S.tocItems] : [];

  // 비하이브리드 + 기존 목차 있을 때만 확인 요청
  if(!hybridMode&&S.tocItems.length>0){
    const ok=await Toast.confirm(
      '⚠️ 이미 '+S.tocItems.length+'개 챕터가 감지되어 있어요.<br>'+
      '계속하면 현재 목차가 덮어씌워져요. 계속할까요?'
    );
    if(!ok) return;
  }

  // ─── 텍스트 로드 ───
  const sorted=[...S.txtFiles];
  let raw='';
  try{ raw=(await Promise.all(sorted.map(fileToText))).join('\n\n'); }
  catch(e){ Toast.error('파일 읽기 실패: '+e.message); return; }
  if(!raw.trim()){Toast.warn('파일 내용이 비어있어요.');return;}

  const lines=raw.split('\n');
  const totalLines=lines.length;

  // ─── L2: 화수 자동 추정 (보조, 실패해도 폴백) ───
  let autoEstimate=Math.round(totalLines/300)||1;
  try{
    const cr=_estimateTotalByBlankClusters(lines);
    if(cr&&cr.estimated>=1) autoEstimate=cr.estimated;
  }catch(e){}
  const clampedEstimate=Math.max(1,Math.min(autoEstimate,9999));

  // ─── L9: 마지막 설정값 ───
  let lastTotal=0;
  try{ lastTotal=parseInt(localStorage.getItem('novelepub_autosplit_total')||'0')||0; }catch(e){}
  const suggestVal=lastTotal>0?lastTotal:clampedEstimate;

  const promptMsg=
    '총 화수를 입력하세요.<br>'+
    `파일 총 줄 수: <b>${totalLines.toLocaleString()}줄</b>  ·  자동 추정: 약 <b>${clampedEstimate}화</b><br>`+
    (lastTotal>0?`<span style="font-size:var(--fs-xs);color:var(--blue)">마지막 설정: ${lastTotal}화</span>`:'');

  const input=await Toast.prompt(promptMsg, String(suggestVal));
  if(input===null) return; // 취소

  // ─── 입력 검증 ───
  const n=Number((input||'').trim());
  if(!Number.isFinite(n)||!Number.isInteger(n)||n<1||n>9999){
    Toast.warn('1~9999 사이의 정수를 입력해주세요.');
    return;
  }
  const totalChapters=n;

  // ─── 설정 저장 ───
  try{ localStorage.setItem('novelepub_autosplit_total',String(totalChapters)); }catch(e){}

  // ═══════════════════════════════════════════════════════════
  // ★★★ 핵심: 순수 균등 분할 + 문맥 보정
  //
  // STEP 1: 수학적 균등 경계 배열 확정 (chapterStarts[])
  //         _snapToBoundary v2 (가중치 점수제)로 각 챕터 독립 보정
  //         → 실패 시 수학값 폴백 (#8)
  //
  // STEP 2: 확정된 경계로 body 구성
  //   ★ #1 Zero-Loss Guarantee:
  //     startIdx ~ nextIdx-1 줄 전체를 body로 사용
  //     title 추출이 body 줄을 제거하거나 슬라이스하지 않음
  //     body 첫 줄 = 원본 텍스트 분할 경계 줄 그대로 보존
  //
  // STEP 3: 제목 탐색 — body와 완전 분리
  //         title 필드만 설정, body 불변
  // ═══════════════════════════════════════════════════════════

  // STEP 1: 수학적 균등 경계 배열 확정
  const chapterStarts=new Array(totalChapters);
  for(let ch=0;ch<totalChapters;ch++){
    const mathIdx=Math.floor(ch*totalLines/totalChapters);

    // 이 챕터 전용 탐색 경계 — 이웃 화 침범 원천 차단 (#7)
    const prevMath=ch>0 ? Math.floor((ch-1)*totalLines/totalChapters) : 0;
    const nextMath=ch+1<totalChapters ? Math.floor((ch+1)*totalLines/totalChapters) : totalLines;
    const lowerBound=ch>0 ? Math.ceil((prevMath+mathIdx)/2) : 0;
    const upperBound=Math.floor((mathIdx+nextMath)/2)+1;
    const safeLower=Math.max(0, lowerBound);
    const safeUpper=Math.min(totalLines, upperBound);

    // _snapToBoundary v2: 가중치 점수제 보정 (최대 30줄 탐색)
    const snapped=_snapToBoundary(lines, mathIdx, safeLower, safeUpper, 30);

    // 최종 검증: 범위 내 값이면 채택, 아니면 수학값 (#8)
    chapterStarts[ch]=(snapped>=safeLower && snapped<safeUpper)
      ? snapped
      : Math.max(safeLower, Math.min(mathIdx, safeUpper-1));
  }

  // STEP 2: 확정된 경계로 found 배열 구성
  const found=[];

  for(let ch=0;ch<totalChapters;ch++){
    const startIdx=chapterStarts[ch];
    // #7: 역전·중복 방지 — 보정 결과 앞 경계와 같은 줄이면 빈 챕터가 되므로 건너뜀
    if(ch>0&&startIdx<=chapterStarts[ch-1]) continue;

    // STEP 3: 제목 탐색 — title만 설정, body 불변 (#1 Zero-Loss)
    let title='[간격 분할] '+(ch+1)+'화'; // 기본 제목 (#8)
    try{
      const hint=_findNearbyTitle(lines, startIdx, 10);
      if(hint&&hint.trim().length>=2) title=hint.trim();
    }catch(e){}

    // ★ #1 Zero-Loss Body: autoSplit 항목은 startIdx(경계 줄)부터 다음 경계 직전까지 본문으로 사용
    //   title에 사용된 줄이어도 본문에서 제거하지 않음 (Phase 10: 줄 범위 모델 — 본문 문자열은 저장하지 않음)
    found.push({
      line:           startIdx+1,  // 1-based (표시용)
      title,
      enabled:        true,
      autoSplit:      true,
      _autoGenerated: true,
      originalTitle:  undefined,
      kind:           'ch',
    });
  }

  // ★ Fail-safe 최종 검증 (#8): 비어있으면 수학적 폴백 강제 생성
  if(!found.length){
    console.warn('[autoSplit] found 배열 비어있음 — 수학적 폴백 실행');
    const fallbackInterval=Math.max(1,Math.floor(totalLines/totalChapters));
    for(let ch=0;ch<totalChapters;ch++){
      const si=ch*fallbackInterval;
      const ni=Math.min(si+fallbackInterval, totalLines);
      if(si>=ni) continue;
      found.push({
        line:si+1, title:'[간격 분할] '+(ch+1)+'화',
        enabled:true, autoSplit:true, _autoGenerated:true, originalTitle:undefined, kind:'ch',
      });
    }
  }

  // ─── L8: 하이브리드 보완 (순수 분할 완료 후 적용) ───
  let finalItems=found;
  if(hybridMode&&existingItems.length>0){
    try{ finalItems=_mergeHybrid(existingItems,found,totalLines); }
    catch(e){
      console.warn('[autoSplit] 하이브리드 병합 실패, 순수 분할 사용:', e);
      finalItems=found;
    }
  }

  // ─── 상태 반영 ───
  _fullRawLines=lines;
  _autoSplitLines=totalLines<=200000?lines:null;
  _setAutoSplitActive(true);
  // ★ Phase 10: 간격 분할 원문(_fullRawLines)에는 감지 단계 dropLines가 해당되지 않음
  _tocDropLines=[];
  _recalcTocStats(finalItems, lines);
  S.tocItems=finalItems;
  _chaptersCache=null;
  _chaptersCacheKey='__autoSplit__';

  // ─── UI 업데이트 ───
  renderTocItems();
  updateTocStat&&updateTocStat();
  updateTocEditBanner&&updateTocEditBanner();

  // L6: 품질 배지
  const quality=_calcSplitQuality(finalItems);
  const avgWan=quality.avgLen>=10000?(quality.avgLen/10000).toFixed(1)+'만자':quality.avgLen.toLocaleString()+'자';
  const interval=Math.floor(totalLines/totalChapters);
  const modeLabel=hybridMode?'🔀 하이브리드':'⚡ 간격 분할';
  document.getElementById('tb0')?.insertAdjacentHTML('afterbegin',
    `<div style="font-size:var(--fs-xs);color:var(--text2);margin-bottom:8px;padding:0 4px">
      <span class="toc-auto-badge">${modeLabel} (${interval}줄 간격, ${finalItems.length}화)</span>
      <span style="margin-left:6px;font-size:var(--fs-xs)">균등도 ${quality.score}% · 평균 ${avgWan}/화</span>
      <br><span style="color:var(--accent);font-size:var(--fs-xs)">⚠️ 제목이 부정확할 수 있어요. 목차에서 확인 후 수정하세요.</span>
    </div>`
  );

  _renderTitleTemplateBar();
  document.getElementById('tocPanel')?.classList.add('show');
  tocTab(0);

  // 가상 스크롤 — 이전 인스턴스 destroy 후 재생성
  const tb2b=document.getElementById('tb2');
  _vsInstTb2b?.destroy(); _vsInstTb2b=null;
  if(tb2b){
    tb2b.innerHTML='';
    if(typeof createVirtualScroll==='function'){
      _vsInstTb2b=createVirtualScroll(tb2b,lines);
    } else {
      const pre2=document.createElement('pre'); pre2.className='toc-raw';
      pre2.textContent=lines.slice(0,2000).map((l,i)=>String(i+1).padStart(5,' ')+' │ '+l).join('\n');
      tb2b.appendChild(pre2);
      if(lines.length>2000){
        const b2=document.createElement('button');
        b2.className='btn btn-ghost btn-sm';
        b2.style.cssText='margin:8px 0;width:100%;font-size:var(--fs-xs)';
        b2.textContent=`▼ 나머지 ${(lines.length-2000).toLocaleString()}줄 더 보기`;
        b2.onclick=()=>{pre2.textContent=lines.map((l,i)=>String(i+1).padStart(5,' ')+' │ '+l).join('\n');b2.remove();};
        tb2b.appendChild(b2);
      }
    }
  }

  _syncSplitBtn('active');
  document.getElementById('hybrid-suggest-btn')?.remove();

  const suspCount=finalItems.filter(t=>t.suspicious).length;
  if(suspCount>0) showSuspiciousToast(suspCount);

  Toast.success(`${modeLabel} 완료 — ${finalItems.length}화 · 균등도 ${quality.score}% · 평균 ${avgWan}`, 4000);
}