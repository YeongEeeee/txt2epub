// ════════════════════════════════════════════════
// convert.js — 인코딩/Worker, 파일 핸들러, 변환 탭, 배치 탭
// NovelEPUB | TXT → EPUB3
//
// 의존성: core.js → settings.js → cover-search.js → parser.js → epub-gen.js
// ════════════════════════════════════════════════

/* global Toast, EventBus, S, B, _sStore, _bStore, yieldToMain, RecoverableError,
   escHtml, escAttr, sortKey, smartSortFiles, splitChapters, buildChaptersFromTocItems,
   getCachedChapters, previewToc, extractChNum, bestPat,
   buildEpub, JSZip, getCssVar,
   updateBtmBar, updateFeedFromToc, updateSettingsSummary, renderTocItems,
   updateTocStat, updateTocEditBanner, _saveTocSnapshot,
   _chaptersCache, _chaptersCacheKey, _fullRawLines, _autoSplitLines, _autoSplitActive,
   saveHistory, generateTextCover, _sendConvertNotif,
   saveCssSettings, saveExtraSettings, loadCssSettings */

'use strict';

// ════════════════════════════════════════════════════════
// ★ B-FIX-01: _encCache LRU 제한 — File 객체 키 Map 무한 증식 방지
// 이전: new Map() — File 객체 참조가 Map에 묶여 GC 불가, 배치 수백 회 누적 시 메모리 폭발
// 수정: 최대 200개 LRU + WeakRef 기반 — File GC 허용
// ════════════════════════════════════════════════════════
const _ENC_CACHE_MAX = 200;
const _encCache = new Map(); // key: file.name+'|'+file.size+'|'+file.lastModified, value: enc

function _encCacheGet(file){
  const k = `${file.name}|${file.size}|${file.lastModified||0}`;
  if(!_encCache.has(k)) return null;
  // LRU: 접근 시 맨 뒤로 이동
  const v = _encCache.get(k);
  _encCache.delete(k);
  _encCache.set(k, v);
  return v;
}

function _encCacheSet(file, enc){
  const k = `${file.name}|${file.size}|${file.lastModified||0}`;
  // LRU: 이미 있으면 제거 후 재삽입 (맨 뒤)
  if(_encCache.has(k)) _encCache.delete(k);
  // 최대 크기 초과 시 가장 오래된 항목 제거
  if(_encCache.size >= _ENC_CACHE_MAX){
    const firstKey = _encCache.keys().next().value;
    _encCache.delete(firstKey);
  }
  _encCache.set(k, enc);
}

// ══════════════════════════════════════════
// 🔧 Module: TextWorker (worker.js 연동)
// 20MB+ 파일의 인코딩 감지·디코딩을 Worker에 위임 → 메인 스레드 비블로킹
// ══════════════════════════════════════════
const TextWorker = (() => {
  let _worker = null;
  let _pending = new Map(); // id → {resolve, reject, timer}
  let _idSeq   = 0;
  const LARGE_FILE_THRESHOLD = 5 * 1024 * 1024; // 5MB 이상 Worker 위임
  // ★ L-17: Worker 연속 실패 카운터 — 구문 오류/CSP 차단 시 무한 재생성 방지
  let _workerFailCount = 0;
  const MAX_WORKER_FAILS = 3;

  function _getWorker(){
    if(_worker) return _worker;
    // ★ L-17 FIX: 연속 실패 임계값 초과 시 Worker 영구 비활성화
    if(_workerFailCount >= MAX_WORKER_FAILS) return null;
    try{
      _worker = new Worker('worker.js');
      _worker.onmessage = function(e){
        const { type, id, result, error } = e.data;
        if(type === 'PROGRESS') return; // 진행률은 Worker에서 직접 처리
        const entry = _pending.get(id);
        if(!entry) return;
        clearTimeout(entry.timer);
        _pending.delete(id);
        if(type === 'RESULT') entry.resolve(result);
        else entry.reject(new Error(error || 'Worker 오류'));
      };
      _worker.onerror = function(e){
        // Worker 오류 시 대기 중인 모든 요청 실패 처리
        for(const [,entry] of _pending){
          clearTimeout(entry.timer);
          entry.reject(new Error('Worker 오류: ' + e.message));
        }
        _pending.clear();
        _workerFailCount++; // ★ L-17: 실패 횟수 누적
        _worker = null; // 재생성 허용 (임계값 미달 시)
      };
    }catch(e){
      _workerFailCount++;
      _worker = null;
    }
    return _worker;
  }

  // ArrayBuffer를 Worker에 보내고 결과 Promise 반환
  function post(type, payload, transferables=[], timeoutMs=30000){
    return new Promise((resolve, reject) => {
      const worker = _getWorker();
      if(!worker){
        reject(new Error('Worker 사용 불가'));
        return;
      }
      const id = ++_idSeq;
      const timer = setTimeout(() => {
        _pending.delete(id);
        reject(new Error('Worker timeout'));
      }, timeoutMs);
      _pending.set(id, { resolve, reject, timer });
      // ★ L-08: Transferable 전송 여부 추적 — 전송 후 detached 버퍼 재사용 방지
      let _transferred = false;
      try{
        worker.postMessage({ type, id, payload }, transferables);
        _transferred = true;
      }catch(e){
        clearTimeout(timer);
        _pending.delete(id);
        // ★ transferables가 이미 detached 상태라면 _transferred=false → 폴백에서 재사용 없음
        reject(e);
      }
      void _transferred; // 향후 폴백 경로에서 참조 가능하도록 보존
    });
  }

  // ★ 파일 크기 기반 자동 라우팅
  // 소형 파일: 메인 스레드 직접 처리 (Worker 오버헤드 없음)
  // 대형 파일: Worker에 ArrayBuffer 전송 (Transferable → 복사 비용 없음)
  // ★ Phase 10: 이미 읽은 버퍼와 감지된 인코딩을 그대로 전달 (이전: 메인에서 읽은 뒤 Worker용으로 파일을 한 번 더 읽고,
  //   Worker는 인코딩을 다시 감지 → 대용량 파일 I/O·메모리 2배)
  //   반환 null = Worker 미사용(메인 스레드 처리) / 전송 후 버퍼는 detached → 실패 시 호출자가 다시 읽음
  // ★ Phase 13: strict — 사용자가 직접 고른 인코딩은 'UTF-8이 깨지면 EUC-KR로 재시도' 자동 보정을 하지 않음
  async function decodeViaWorker(ab, enc, strict=false){
    if(!ab || ab.byteLength < LARGE_FILE_THRESHOLD || !_getWorker()) return null;
    const result = await post('FILE_TO_TEXT', { buffer: ab, enc, strict }, [ab]);
    return result.text;
  }

  return { decodeViaWorker, LARGE_FILE_THRESHOLD };
})();

// ★ Phase 12: BOM 없는 UTF-16 감지
//   UTF-8·EUC-KR 텍스트에는 NUL(0x00)이 사실상 없고, UTF-16은 ASCII(공백·줄바꿈·숫자)마다 NUL이
//   한쪽 위치(LE=홀수, BE=짝수)에 몰림 — 한글 음절(U+AC00~D7A3)의 상위 바이트는 0이 아니고,
//   반대쪽 NUL은 하위 바이트가 0인 음절(가·대 등 U+xx00)에서만 생기므로 ASCII 쪽이 2배 이상 많음.
//   디코딩 결과의 U+FFFD 비율로 한 번 더 검증
function _detectUtf16NoBom(bytes){
  const n=bytes.length&~1;
  if(n<64) return null;
  let zEven=0, zOdd=0;
  for(let i=0;i<n;i+=2){
    if(bytes[i]===0) zEven++;
    if(bytes[i+1]===0) zOdd++;
  }
  const pairs=n/2;
  let cand=null;
  if(zEven+zOdd<pairs*0.02) return null;   // NUL이 거의 없음 → 8비트 인코딩(UTF-8·EUC-KR)
  if(zOdd>=zEven*2) cand='utf-16le';
  else if(zEven>=zOdd*2) cand='utf-16be';
  if(!cand) return null;
  const text=new TextDecoder(cand,{fatal:false}).decode(bytes.subarray(0,n));
  return _countChar(text,'\ufffd')<=text.length*0.01?cand:null;
}

// ★ U-12: detectEncodingFromAB — ArrayBuffer를 직접 받아 처리 (이중 FileReader 제거용)
// ★ Phase 12: 인코딩 감지 단일 소스 — worker.js의 복사본은 제거 (메인 스레드가 감지한 인코딩을 항상 전달)
function _detectEncodingFromAB(ab){
  const bytes=new Uint8Array(ab.slice(0,65536));
  if(bytes[0]===0xEF&&bytes[1]===0xBB&&bytes[2]===0xBF) return 'utf-8';
  if(bytes[0]===0xFF&&bytes[1]===0xFE) return 'utf-16le';
  if(bytes[0]===0xFE&&bytes[1]===0xFF) return 'utf-16be';
  const u16=_detectUtf16NoBom(bytes);
  if(u16) return u16;
  let utf8Errors=0, totalMultibyte=0;
  let i=0;
  const limit=bytes.length-3;
  while(i<limit){
    const b=bytes[i];
    if(b<0x80){i++;continue;}
    if(b>=0xC2&&b<=0xDF){ if((bytes[i+1]&0xC0)===0x80){totalMultibyte++;i+=2;continue;} }
    else if(b>=0xE0&&b<=0xEF){ if((bytes[i+1]&0xC0)===0x80&&(bytes[i+2]&0xC0)===0x80){totalMultibyte++;i+=3;continue;} }
    else if(b>=0xF0&&b<=0xF4){ if(i+3<limit&&(bytes[i+1]&0xC0)===0x80&&(bytes[i+2]&0xC0)===0x80&&(bytes[i+3]&0xC0)===0x80){totalMultibyte++;i+=4;continue;} }
    utf8Errors++;i++;
  }
  const errorRate=utf8Errors/Math.max(totalMultibyte,1);
  if(errorRate<0.001) return 'utf-8';
  const utf8Text=new TextDecoder('utf-8',{fatal:false}).decode(bytes);
  const eucText=new TextDecoder('euc-kr',{fatal:false}).decode(bytes);
  const utf8Bad=_countChar(utf8Text,'\ufffd');
  const eucBad=_countChar(eucText,'\ufffd');
  if(utf8Bad===0) return 'utf-8';
  return utf8Bad<=eucBad ? 'utf-8' : 'euc-kr';
}

// ★ Phase 10: 개수 세기용 — match(/x/g)는 일치 수만큼 배열을 만듦 (대용량 텍스트에서 수십만 개)
function _countChar(text, ch){
  let n=0, i=-1;
  while((i=text.indexOf(ch,i+1))!==-1) n++;
  return n;
}
function _countLines(text){ return text?_countChar(text,'\n'):0; }

// ══════════════════════════════════════════
// ★ Phase 10: 디코딩 결과 캐시 (LRU · 총 글자 수 상한)
//   미리보기·목차 재확인·간격 분할·변환·삽화 범위 검색이 같은 파일을 매번 다시 읽고 디코딩하던 문제
//   키: 파일명|크기|수정시간 (_encCache와 동일) · 동시 요청은 진행 중 Promise 공유
// ══════════════════════════════════════════
const _TEXT_CACHE_MAX_CHARS=48*1024*1024;   // 약 96MB(UTF-16) — 이보다 큰 단일 파일은 캐시하지 않음
const _textCache=new Map();
const _textInflight=new Map();
let _textCacheChars=0;
function _fileKey(file){ return `${file?.name}|${file?.size}|${file?.lastModified||0}`; }
function _textCacheGet(file){
  const k=_fileKey(file);
  if(!_textCache.has(k)) return null;
  const v=_textCache.get(k);
  _textCache.delete(k); _textCache.set(k,v);   // LRU 갱신
  return v;
}
function _textCacheSet(file, text){
  if(typeof text!=='string'||text.length>_TEXT_CACHE_MAX_CHARS) return;
  const k=_fileKey(file);
  if(_textCache.has(k)){ _textCacheChars-=_textCache.get(k).length; _textCache.delete(k); }
  while(_textCache.size&&_textCacheChars+text.length>_TEXT_CACHE_MAX_CHARS){
    const [ok,ov]=_textCache.entries().next().value;
    _textCache.delete(ok); _textCacheChars-=ov.length;
  }
  _textCache.set(k,text); _textCacheChars+=text.length;
}
function clearTextCache(){ _textCache.clear(); _textCacheChars=0; }
function _textCacheDelete(file){
  const k=_fileKey(file);
  if(_textCache.has(k)){ _textCacheChars-=_textCache.get(k).length; _textCache.delete(k); }
}

// ★ Phase 13: 사용자가 파일 목록에서 직접 고른 인코딩 (키: 파일명|크기|수정시간)
//   자동 감지가 틀린 원고(짧은 EUC-KR·ASCII 위주 파일 등)를 바로잡는 용도 — 변환·미리보기 모두 이 값을 우선
const _encOverride=new Map();
const _encAuto=new Map();   // 자동 감지 결과 (사용자 지정과 별개로 '자동 (…)' 표시에 사용)
const ENC_LABELS={'utf-8':'UTF-8','euc-kr':'EUC-KR','utf-16le':'UTF-16LE','utf-16be':'UTF-16BE'};

async function detectEncodingAuto(file){
  const k=_fileKey(file);
  if(_encAuto.has(k)) return _encAuto.get(k);
  // ★ Phase 12: 앞 64KB만 읽음 (감지에 쓰는 범위만)
  const ab=await fileToAB(file.slice(0,65536));
  const enc=_detectEncodingFromAB(ab);
  if(_encAuto.size>=_ENC_CACHE_MAX) _encAuto.delete(_encAuto.keys().next().value);
  _encAuto.set(k, enc);
  return enc;
}

async function detectEncoding(file){
  // ★ Phase 12: 앞 64KB만 읽음 + 감지 결과 캐시 공유
  //   (이전: 감지에 쓰는 건 64KB인데 파일 전체를 ArrayBuffer로 읽음 — 목록을 다시 그릴 때마다 모든 파일을
  //    통째로 읽어 대용량 일괄 변환에서 메모리 급증, 결과도 _encCache에 저장하지 않아 변환 때 다시 감지)
  const ov=_encOverride.get(_fileKey(file));
  if(ov) return ov;
  const hit=_encCacheGet(file);
  if(hit) return hit;
  const enc=await detectEncodingAuto(file);
  _encCacheSet(file, enc);
  return enc;
}

// ★ Phase 13: 파일 인코딩 직접 지정 ('auto' = 자동 감지로 복귀) → 디코딩 캐시를 비우고 목차를 다시 감지
function setTxtEncoding(file, enc){
  if(!file) return;
  const k=_fileKey(file);
  if(!enc||enc==='auto'){ _encOverride.delete(k); _encCache.delete(k); }
  else{
    if(!ENC_LABELS[enc]) return;
    _encOverride.set(k, enc);
    _encCacheSet(file, enc);
  }
  _textCacheDelete(file);
  _chaptersCache=null; _chaptersCacheKey='';
  renderTxtFileList();
  if(typeof previewToc==='function') previewToc();
  Toast.info((enc&&enc!=='auto'?ENC_LABELS[enc]+'(으)로 다시 읽어요':'자동 감지 인코딩으로 다시 읽어요')+' — '+file.name, 2500);
}

async function fileToText(file){
  // ★ Phase 10: 디코딩 결과 캐시 → 같은 파일은 다시 읽지 않음
  const hit=_textCacheGet(file);
  if(hit!=null) return hit;
  const key=_fileKey(file);
  if(_textInflight.has(key)) return _textInflight.get(key);
  const job=(async()=>{
    // ★ U-12 FIX: ArrayBuffer를 한 번만 읽고 인코딩 감지 + 디코딩 모두 재사용
    let ab = await fileToAB(file);
    // ★ B-FIX-01: LRU 캐시에서 인코딩 조회 (파일명+크기+수정시간 기반 키)
    // ★ Phase 13: 사용자가 지정한 인코딩이 있으면 최우선 (LRU에서 밀려나도 유지)
    let enc = _encOverride.get(key) || _encCacheGet(file);
    if(!enc){ enc = _detectEncodingFromAB(ab); _encCacheSet(file, enc); }
    let text = null;
    // ★ 대용량 파일(5MB+)은 Worker에 위임 → 메인 스레드 UI 비블로킹 (읽은 버퍼를 그대로 전송)
    if(file.size >= TextWorker.LARGE_FILE_THRESHOLD){
      try{ text = await TextWorker.decodeViaWorker(ab, enc, _encOverride.has(key)); }
      catch(e){ text = null; }
      // 전송된 버퍼는 detached — Worker 실패 시 다시 읽어 메인 스레드에서 디코딩
      if(text === null && ab.byteLength === 0) ab = await fileToAB(file);
    }
    if(text === null) text = await _decodeFromAB(ab, enc, _encOverride.has(key));
    _textCacheSet(file, text);
    return text;
  })();
  _textInflight.set(key, job);
  try{ return await job; }
  finally{ _textInflight.delete(key); }
}

// ★ B-FIX-02: ab 디코딩 로직 분리 — fileToText 재사용성 및 가독성 향상
function _decodeFromAB(ab, enc, strict=false){
  return new Promise((res,rej)=>{
    // ★ 타임아웃 안전망: 30초 내 응답 없으면 reject
    const timer=setTimeout(()=>rej(new Error('fileToText timeout')), 30000);
    const done=(text)=>{ clearTimeout(timer); res(text); };
    const fail=(e)=>{ clearTimeout(timer); rej(e); };

    try{
      const decoder=new TextDecoder(enc,{fatal:false});
      const text=decoder.decode(new Uint8Array(ab));
      // U+FFFD(대체문자) 포함 여부 — EUC-KR 오판 감지
      const badCount=enc==='utf-8'&&!strict?_countChar(text,'\ufffd'):0;
      if(badCount>10&&enc==='utf-8'){
        try{
          const text2=new TextDecoder('euc-kr',{fatal:false}).decode(new Uint8Array(ab));
          const bad2=_countChar(text2,'\ufffd');
          done(bad2<badCount?text2:text);
        }catch(err2){ done(text); }
      }else{
        done(text);
      }
    }catch(err){
      const fr=new FileReader();
      fr.onload=ev=>done(ev.target.result||'');
      fr.onerror=()=>{
        const fr2=new FileReader();
        fr2.onload=ev2=>done(ev2.target.result||'');
        fr2.onerror=e2=>fail(e2);
        fr2.readAsText(new Blob([ab]),enc); // ★ 이전: 스코프에 없는 file 참조 → ReferenceError
      };
      fr.readAsText(new Blob([ab]),enc);
    }
  });
}

// 파일을 스트리밍 방식으로 부분 읽기 (대용량 파일 UI 블로킹 방지)
// UTF-8 경계 안전 슬라이스 읽기
// 고정 바이트 오프셋 슬라이스 시 멀티바이트 문자(한글 3바이트)가 잘릴 수 있음
// → ArrayBuffer로 읽어서 경계 바이트를 직접 보정 후 TextDecoder 사용
// ★ Phase 12: 바이트 경계 보정 (순수 함수 — 테스트 대상)
//   UTF-8   : 연속 바이트(10xxxxxx)를 건너뛰어 문자 시작에 맞춤
//   UTF-16  : 파일 절대 오프셋 기준 짝수 바이트에 맞춤
//   EUC-KR  : 2바이트 문자의 둘째 바이트는 0x41 이상이라 줄바꿈(0x0A)과 겹치지 않음 → 줄 단위로 동기화
function _sliceBounds(bytes, start, end, safeStart, fileSize, enc, MARGIN){
  let s=start-safeStart, e2=Math.min(bytes.length, end-safeStart);
  if(enc==='utf-8'){
    while(s<bytes.length&&s<MARGIN&&(bytes[s]&0xC0)===0x80) s++;
    while(e2<bytes.length&&(bytes[e2]&0xC0)===0x80) e2++;
  }else if(enc==='utf-16le'||enc==='utf-16be'){
    if((safeStart+s)%2) s++;
    if((safeStart+e2)%2) e2--;
  }else{
    if(start>0){ const nl=bytes.indexOf(0x0A, s); if(nl!==-1&&nl<e2) s=nl+1; }
    if(end<fileSize){ const nl=bytes.lastIndexOf(0x0A, e2-1); if(nl>=s) e2=nl+1; }
  }
  return [s, Math.max(s, e2)];
}

// ★ Phase 12: enc 인자 — 이전엔 항상 UTF-8로 디코딩해 5MB 넘는 EUC-KR 파일의 샘플이 전부 깨짐
async function readFileSlice(file, start, end, enc='utf-8'){
  // 앞 경계 보정: start가 멀티바이트 중간이면 다음 유효 바이트로 이동
  const MARGIN=4; // UTF-8 최대 4바이트
  const safeStart=Math.max(0, start-MARGIN);
  const safeEnd=Math.min(file.size, end+MARGIN);

  return new Promise((res,rej)=>{
    const slice=file.slice(safeStart, safeEnd);
    const r=new FileReader();
    r.onload=e=>{
      const bytes=new Uint8Array(e.target.result);
      const [s,e2]=_sliceBounds(bytes, start, end, safeStart, file.size, enc, MARGIN);
      try{
        const text=new TextDecoder(enc,{fatal:false}).decode(bytes.subarray(s,e2));
        res(text);
      }catch(err){
        // fallback: FileReader readAsText
        const fr=new FileReader();
        fr.onload=ev=>res(ev.target.result);
        fr.onerror=()=>res('');
        fr.readAsText(new Blob([bytes.subarray(s,e2)]),enc);
      }
    };
    r.onerror=rej;
    r.readAsArrayBuffer(slice);
  });
}

async function sampleLines(file){
  const size=file.size;

  // 소용량(5MB 이하): 전체 읽기
  if(size<=5*1024*1024){
    const text=await fileToText(file);
    return text; // 전체 반환 — 패턴 감지 정확도 최우선
  }

  // 대용량(5MB 초과): 앞/1/4/중/3/4/뒤 슬라이스 + 짧은줄 전용 패스
  const CHUNK=384*1024; // 384KB씩
  // ★ Phase 12: 파일 인코딩으로 슬라이스 디코딩 (EUC-KR·UTF-16 대용량 파일 샘플 깨짐 수정)
  const enc=await detectEncoding(file).catch(()=>'utf-8');
  const chunks=[];
  chunks.push(await readFileSlice(file, 0, CHUNK, enc));
  chunks.push(await readFileSlice(file, Math.floor(size*0.25), Math.floor(size*0.25)+CHUNK, enc));
  chunks.push(await readFileSlice(file, Math.floor(size*0.5),  Math.floor(size*0.5)+CHUNK, enc));
  chunks.push(await readFileSlice(file, Math.floor(size*0.75), Math.floor(size*0.75)+CHUNK, enc));
  chunks.push(await readFileSlice(file, Math.max(0,size-CHUNK), size, enc));

  // 각 청크에서 헤더 후보 줄 추출
  // [ 파일명.txt ] 형태는 최대 ~60자이므로 기준 확장 (1~80자)
  const headerCandidates=[];
  for(const chunk of chunks){
    for(const l of chunk.split('\n')){
      const t=l.trim();
      if(t.length>=1&&t.length<=80) headerCandidates.push(t);
    }
  }

  // 균등 샘플 (각 청크 앞 150줄씩)
  const uniformLines=[];
  for(const chunk of chunks){
    uniformLines.push(...chunk.split('\n').slice(0,150));
  }

  return uniformLines.join('\n')+'\n'+[...new Set(headerCandidates)].join('\n');
}
// ══════════════════════════════════════════
// 🗂  Module: FileUtil (이미지 변환·파일 읽기)
// ══════════════════════════════════════════
async function fileToAB(file){
  return new Promise((res,rej)=>{const r=new FileReader();r.onload=e=>res(e.target.result);r.onerror=rej;r.readAsArrayBuffer(file);});
}

// 이미지 변환 함수 — 설정에 따라 JPG 변환 or 원본 유지
// forCover=true 이면 항상 JPG 변환 (표지는 뷰어 호환성 최우선)
async function convertImageFile(file, forCover=false){
  try{
    // ★ 이름 없는 Blob(자동 생성 텍스트 표지 등)은 MIME으로 확장자 판별
    //   이전: file.name.split() TypeError → null 반환 → 텍스트 표지가 EPUB에서 누락
    const _name=String(file?.name||'');
    const _MIME_EXT={'image/jpeg':'jpg','image/png':'png','image/webp':'webp','image/gif':'gif','image/bmp':'bmp','image/avif':'avif','image/tiff':'tiff'};
    const ext=(_name.includes('.')?_name.split('.').pop():(_MIME_EXT[file?.type]||'')).toLowerCase();
    const supportedAsIs=['jpg','jpeg'];
    const convertable=['png','gif','webp','bmp','tiff','tif','avif','heic','heif'];

    if(supportedAsIs.includes(ext)) return {blob:file, ext:'jpg', mt:'image/jpeg'};

    // ★ Phase 14: EPUB 3 핵심 이미지 형식(JPEG·PNG·GIF·WebP)이 아니면 설정과 무관하게 항상 JPG로 변환
    //   (이전: 'JPG 변환' OFF면 BMP·TIFF·AVIF·HEIC를 그대로 넣어 epubcheck RSC-032·리더기 표시 실패)
    //   리더기 프로필이 forceJpg면(Kobo·Kindle) PNG·GIF·WebP도 변환
    const nonCore=!['png','gif','webp','svg'].includes(ext);
    const profileJpg=typeof getReaderProfile==='function'&&getReaderProfile().forceJpg;
    const shouldConvert=forCover || nonCore || profileJpg || document.getElementById('optImgConvert')?.checked!==false;

    if(shouldConvert && convertable.includes(ext)){
      const quality=(parseInt(document.getElementById('optImgQuality')?.value||'92'))/100;
      try{
        const blob=await imgToJpgBlob(file, quality);
        return {blob, ext:'jpg', mt:'image/jpeg'};
      }catch(convErr){
        // 핵심 형식이 아닌 이미지는 원본을 넣으면 EPUB이 깨지므로 건너뜀 (호출자가 경고 후 생략)
        if(nonCore) throw new Error('지원하지 않는 이미지 형식이라 변환하지 못했어요: '+(file?.name||ext));
        // ★ 변환 실패 시 원본 사용 (전체 공정 중단 없음)
        Toast.warn&&Toast.warn(`이미지 변환 실패 (원본 사용): ${file?.name||'이미지'}`);
      }
    }
    if(nonCore) throw new Error('지원하지 않는 이미지 형식: '+(file?.name||ext));

    const mimeMap={
      'png':'image/png','gif':'image/gif','webp':'image/webp',
      'bmp':'image/bmp','tiff':'image/tiff','tif':'image/tiff',
      'avif':'image/avif','svg':'image/svg+xml',
    };
    const mt=mimeMap[ext]||'image/jpeg';
    return {blob:file, ext, mt};
  }catch(e){
    // ★ 이미지 처리 자체가 실패해도 null 반환으로 건너뜀 (전체 공정 유지)
    Toast.warn&&Toast.warn(`이미지 처리 건너뜀: ${file?.name||'이미지'}`);
    return null;
  }
}

// Canvas 기반 JPG 변환 (모든 포맷 대응)
async function imgToJpgBlob(file, quality=0.92){
  return new Promise((res,rej)=>{
    const url=URL.createObjectURL(file);
    const img=new Image();
    img.onload=()=>{
      try{
        const c=document.createElement('canvas');
        c.width=img.naturalWidth||img.width;
        c.height=img.naturalHeight||img.height;
        const ctx=c.getContext('2d');
        // PNG 투명 배경 → CSS var(--bg) 또는 흰색 폴백
        ctx.fillStyle=getCssVar('--bg')||'#ffffff';
        ctx.fillRect(0,0,c.width,c.height);
        ctx.drawImage(img,0,0);
        c.toBlob(b=>{
          URL.revokeObjectURL(url);
          if(b) res(b);
          else rej(new Error('toBlob 실패'));
        },'image/jpeg',quality);
      }catch(e){URL.revokeObjectURL(url);rej(e);}
    };
    img.onerror=(e)=>{URL.revokeObjectURL(url);rej(new Error('이미지 로드 실패: '+(file?.name||'이미지')));};
    img.src=url;
  });
}

// 📂 Module: FileHandlers (드롭·파일 입력 처리)
// ══════════════════════════════════════════
function handleTxt(files, append=false){
  const _all=Array.from(files||[]);
  const txts=_all.filter(f=>/\.txt$/i.test(f?.name||''));
  // ★ TXT와 함께 선택·드롭된 이미지 — 파일명 유사도로 표지 자동 매칭
  const imgs=_all.filter(f=>_IMG_EXT_RX.test(f?.name||''));
  if(!txts.length){
    // 이미지만 들어온 경우: 이미 로드된 TXT 기준으로 표지 매칭만 수행
    if(imgs.length&&S.txtFiles.length) autoMatchCoverImage(imgs, S.txtFiles);
    return;
  }

  // append 모드: 기존 파일에 추가 (중복 제거)
  if(append&&S.txtFiles.length){
    const existing=new Set(S.txtFiles.map(f=>f.name));
    const newFiles=txts.filter(f=>!existing.has(f.name));
    if(!newFiles.length){Toast.warn('이미 추가된 파일이에요.');return;}
    S.txtFiles=[...S.txtFiles,...newFiles];
  }else{
    S.txtFiles=smartSortFiles(txts); // 스마트 정렬 적용
    S.tocItems=[]; _tocDropLines=[];   // ★ 새 파일 세트 → 이전 목차 폐기 (미리보기 전 변환 시 잘못된 목차 사용 방지)
    // ★ Phase 10: 이전 파일의 EPUB 결과·간격 분할 상태도 폐기 — 하단에 옛 EPUB 다운로드 바가 남아 변환 버튼이 가려지던 문제
    _resetConvertResultUi();
    window._autoSplitActive=false; window._autoSplitLines=null;
    _tocSelectedIdxs.clear(); _tocPendingTitleIdx=null; _tocFilterQ=''; _tocUndoStack.length=0;
  }

  const txtDz=document.getElementById('txtDz');
  if(txtDz){
    txtDz.className='dz ok';
    // ★ UX-ANIM: 파일 드롭 성공 순간 테두리 플래시 애니메이션
    txtDz.classList.remove('accept-flash');
    void txtDz.offsetWidth; // reflow 강제
    txtDz.classList.add('accept-flash');
    txtDz.addEventListener('animationend', ()=>txtDz.classList.remove('accept-flash'), { once: true });
  }
  const resetBar=document.getElementById('convertResetBar');
  if(resetBar) resetBar.style.display='flex';
  // ★ UX-PD: Progressive Disclosure — 패턴 영역을 파일 로드 후 선명하게 전환
  document.getElementById('patSection')?.classList.remove('is-idle');
  _chaptersCache=null; // 캐시 무효화

  renderTxtFileList();
  // ★ Phase 16: 하단 바 상태는 StateManager 구독(ui-state.js)이 S.txtFiles 변경 시 갱신

  // ★ 파일 로드 즉시 splitBtn 활성화 — disabled 교착 방지
  // previewToc 완료 전에 버튼이 먼저 열려있어야 함
  typeof _activateSplitBtnOnFileLoad==='function'&&_activateSplitBtnOnFileLoad();

  // ★ 자동 미리보기 — optAutoPreview 없어도 파일 1개면 바로 실행
  const autoEl=document.getElementById('optAutoPreview');
  const autoPreview=autoEl?autoEl.checked:true; // 엘리먼트 없으면 기본 ON
  if(autoPreview){
    // 300ms 디바운스: 여러 파일 드롭 시 마지막 파일만 처리
    clearTimeout(handleTxt._timer);
    handleTxt._timer=setTimeout(()=>previewToc(),300);
  }

  // 메타데이터 자동 채우기 (첫 파일 기준)
  if(S.txtFiles.length>0){
    const stem=S.txtFiles[0].name.replace(/\.txt$/i,'');
    let title=stem,author='';
    let m=stem.match(/^\[(.+?)\]\s*(.+)$/);
    if(m){author=m[1].trim();title=m[2].trim();}
    else{m=stem.match(/^(.+?)\s*@\s*(.+)$/);if(m){title=m[1].trim();author=m[2].trim();}}
    const titleEl=document.getElementById('title');
    const authorEl=document.getElementById('author');
    if(titleEl&&!titleEl.value) titleEl.value=title;
    if(authorEl&&!authorEl.value) authorEl.value=author;
    // ★ 시리즈 메타 자동 채우기 ('작품 3권.txt' → 시리즈 '작품', 권 3)
    const sm=parseSeriesFromName(S.txtFiles[0].name);
    const seriesEl=document.getElementById('series');
    const seriesIdxEl=document.getElementById('seriesIdx');
    if(sm){
      if(seriesEl&&!seriesEl.value) seriesEl.value=sm.series;
      if(seriesIdxEl&&!seriesIdxEl.value) seriesIdxEl.value=String(sm.index);
    }
  }

  // ★ 이름이 유사한 이미지가 함께 들어왔으면 표지로 자동 연결
  if(imgs.length) autoMatchCoverImage(imgs, S.txtFiles);
  // ★ Phase 16: 작업 자동 저장
  scheduleSessionSave();
}
handleTxt._timer=null; // 디바운스 타이머 초기화

// ── 파일 리스트 렌더링 (드래그 정렬 포함) ──
// ── 터치 정렬 헬퍼 (_attachTouchSort) ──
// touchstart/move/end 기반 모바일 드래그 정렬
// 작동 원리:
//   1. touchstart → 드래그 대상 기록 + 시각적 클론 생성
//   2. touchmove  → 클론을 손가락 위치로 이동 + 삽입 위치 계산
//   3. touchend   → 실제 배열 순서 변경 + 리렌더
let _touchDragState=null; // {fromIdx, clone, listEl, origRow, startY, scrollEl}

function _attachTouchSort(row, listEl, idx){
  const handle=row.querySelector('.txt-file-handle')||row;

  handle.addEventListener('touchstart',e=>{
    // 멀티터치 무시
    if(e.touches.length>1) return;
    const touch=e.touches[0];

    // 클론 생성 (시각적 피드백용)
    const clone=row.cloneNode(true);
    const rect=row.getBoundingClientRect();
    clone.style.cssText=
      'position:fixed;left:'+rect.left+'px;top:'+rect.top+'px;'+
      'width:'+rect.width+'px;opacity:.85;z-index:9999;'+
      'pointer-events:none;border:1.5px solid var(--accent);'+
      'border-radius:var(--radius-xs);background:var(--accent-bg);box-shadow:var(--shadow-md)';
    document.body.appendChild(clone);

    row.style.opacity='0.3';

    // 스크롤 컨테이너 (listEl 또는 가장 가까운 scrollable 부모)
    const scrollEl=listEl;

    _touchDragState={
      fromIdx:idx, clone, listEl, origRow:row,
      startY:touch.clientY, scrollEl,
      cloneOffsetY: touch.clientY - rect.top,
      cloneOffsetX: touch.clientX - rect.left,
    };
    e.preventDefault(); // 페이지 스크롤 차단 (드래그 중에만)
  },{passive:false});

  handle.addEventListener('touchmove',e=>{
    if(!_touchDragState||e.touches.length>1) return;
    const st=_touchDragState;
    const touch=e.touches[0];

    // 클론 위치 업데이트
    st.clone.style.top=(touch.clientY - st.cloneOffsetY)+'px';
    st.clone.style.left=(touch.clientX - st.cloneOffsetX)+'px';

    // 손가락 아래 요소 찾기 (클론은 pointer-events:none 이므로 투과됨)
    const elBelow=document.elementFromPoint(touch.clientX, touch.clientY);
    const targetRow=elBelow?.closest('.txt-file-row');

    // drag-over 시각 표시
    st.listEl.querySelectorAll('.drag-over').forEach(el=>el.classList.remove('drag-over'));
    if(targetRow&&targetRow!==st.origRow){
      targetRow.classList.add('drag-over');
    }

    // 자동 스크롤: 리스트 상단/하단 근처에서 스크롤
    const listRect=st.listEl.getBoundingClientRect();
    const SCROLL_ZONE=40; // px
    if(touch.clientY < listRect.top + SCROLL_ZONE){
      st.listEl.scrollTop -= 6;
    } else if(touch.clientY > listRect.bottom - SCROLL_ZONE){
      st.listEl.scrollTop += 6;
    }

    e.preventDefault();
  },{passive:false});

  handle.addEventListener('touchend',e=>{
    if(!_touchDragState) return;
    const st=_touchDragState;

    // 클론 제거
    st.clone.remove();
    st.origRow.style.opacity='';

    // drag-over 제거
    st.listEl.querySelectorAll('.drag-over').forEach(el=>el.classList.remove('drag-over'));

    // 손가락 끝 위치로 대상 행 찾기
    const touch=e.changedTouches[0];
    const elBelow=document.elementFromPoint(touch.clientX, touch.clientY);
    const targetRow=elBelow?.closest('.txt-file-row');
    const toIdx=targetRow?parseInt(targetRow.dataset.idx):-1;

    if(toIdx>=0 && toIdx!==st.fromIdx){
      // ★ Phase 16: 제자리 splice 대신 새 배열로 교체 → StateManager 구독자(하단 바 등)에 변경 알림
      S.txtFiles=_moveItem(S.txtFiles, st.fromIdx, toIdx);
      _chaptersCache=null;
      renderTxtFileList();
    }

    _touchDragState=null;
  });
}

// ★ Phase 16: 배열 항목 이동 (원본은 그대로, 새 배열 반환)
function _moveItem(arr, from, to){
  const out=[...arr];
  const [m]=out.splice(from,1);
  out.splice(to,0,m);
  return out;
}

function renderTxtFileList(){
  const files=S.txtFiles;
  const listEl=document.getElementById('txtSortList');
  const countEl=document.getElementById('txtFileCount');
  const infoEl=document.getElementById('txtInfo');
  const listWrap=document.getElementById('txtFileList');
  if(!listEl) return;
  scheduleSessionSave();   // ★ Phase 16: 순서 변경·개별 제거도 작업 복원에 반영

  // 기존 info 영역 간단 요약
  if(infoEl){ infoEl.style.display='block'; infoEl.textContent='✅ '+files.length+'개 파일 선택됨'; }
  // ★ Phase 13: index.html의 hidden 속성 + style.css [hidden]{display:none!important} 때문에
  //   style.display='block'이 무시되어 파일 목록(순서 변경·개별 제거·정렬·인코딩 선택)이 한 번도 보이지 않던 문제
  //   (txtInfo 요약은 목록 머리의 'N개 · 드래그로 순서 변경'과 중복이라 숨김 유지)
  if(listWrap){ listWrap.hidden=false; listWrap.style.display='block'; }
  if(countEl) countEl.textContent=files.length+'개 · 드래그로 순서 변경';

  listEl.innerHTML='';
  files.forEach((f,i)=>{
    const row=document.createElement('div');
    row.className='txt-file-row';
    row.draggable=true;
    row.dataset.idx=i;

    row.innerHTML=
      '<span class="txt-file-handle" title="드래그해서 순서 변경">⠿</span>'+
      '<span class="txt-file-num">'+(i+1)+'</span>'+
      '<span class="txt-file-name" title="'+escHtml(f.name)+'">'+escHtml(f.name)+'</span>'+
      '<span class="txt-file-rm" data-idx="'+i+'" title="제거">✕</span>';

    // 인코딩 비동기 감지 (★ Phase 12: 앞 64KB만 읽고 캐시 — 실패해도 선택 상자만 생략)
    // ★ Phase 13: 배지 → 선택 상자 — 글자가 깨지면 인코딩을 직접 골라 다시 읽기
    detectEncodingAuto(f).then(auto=>{
      if(!row.isConnected) return;   // 그 사이 목록이 다시 그려졌으면 버려진 행에 붙이지 않음
      const ov=_encOverride.get(_fileKey(f));
      const sel=document.createElement('select');
      sel.className='txt-file-enc'+(ov?' is-manual':'');
      sel.draggable=false;
      sel.title='인코딩 — 글자가 깨져 보이면 직접 바꿔 보세요';
      sel.setAttribute('aria-label', f.name+' 인코딩');
      const opt=(v,t)=>{ const o=document.createElement('option'); o.value=v; o.textContent=t; sel.appendChild(o); };
      opt('auto','자동 ('+(ENC_LABELS[auto]||String(auto||'').toUpperCase())+')');
      Object.entries(ENC_LABELS).forEach(([v,t])=>opt(v,t));
      sel.value=ov||'auto';
      ['mousedown','touchstart','click','dragstart'].forEach(ev=>sel.addEventListener(ev,e=>e.stopPropagation(),{passive:ev==='touchstart'}));
      sel.addEventListener('change',()=>setTxtEncoding(f, sel.value));
      const rmBtn=row.querySelector('.txt-file-rm');
      if(rmBtn) row.insertBefore(sel,rmBtn);
    }).catch(()=>{});

    // ✕ 클릭으로 개별 파일 제거
    row.querySelector('.txt-file-rm').onclick=e=>{
      e.stopPropagation();
      const idx=parseInt(e.target.dataset.idx);
      S.txtFiles=S.txtFiles.filter((_,k)=>k!==idx);   // ★ Phase 16: 새 배열로 교체 (구독 알림)
      _chaptersCache=null;
      if(!S.txtFiles.length){resetConvertTxt();}
      else renderTxtFileList();
    };

    // ── 데스크탑 드래그 앤 드롭 ──
    row.addEventListener('dragstart',e=>{
      row.classList.add('dragging');
      e.dataTransfer.effectAllowed='move';
      e.dataTransfer.setData('text/plain',String(i));
    });
    row.addEventListener('dragend',()=>{
      row.classList.remove('dragging');
      listEl.querySelectorAll('.drag-over').forEach(el=>el.classList.remove('drag-over'));
    });
    row.addEventListener('dragover',e=>{
      e.preventDefault();
      e.dataTransfer.dropEffect='move';
      listEl.querySelectorAll('.drag-over').forEach(el=>el.classList.remove('drag-over'));
      row.classList.add('drag-over');
    });
    row.addEventListener('dragleave',e=>{
      // 자식 요소로 이동 시 오작동 방지
      if(!row.contains(e.relatedTarget)) row.classList.remove('drag-over');
    });
    row.addEventListener('drop',e=>{
      e.preventDefault();
      row.classList.remove('drag-over');
      const fromIdx=parseInt(e.dataTransfer.getData('text/plain'));
      const toIdx=i;
      if(fromIdx===toIdx) return;
      S.txtFiles=_moveItem(S.txtFiles, fromIdx, toIdx);   // ★ Phase 16: 새 배열로 교체 (구독 알림)
      _chaptersCache=null;
      renderTxtFileList();
    });

    // ── 모바일 터치 드래그 ──
    // touchstart/touchmove/touchend로 구현 (iOS·Android 모두 지원)
    _attachTouchSort(row, listEl, i);

    listEl.appendChild(row);
  });
}

// ══════════════════════════════════════════
// 🖼  Module: Cover (표지 URL·크롤링)
// ══════════════════════════════════════════

// ★ Phase 12: http(s) URL만 허용 — startsWith('http')는 'httpx:'·'http:javascript…' 같은 값도 통과시켰음
function _parseHttpUrl(raw){
  try{
    const u=new URL(String(raw||'').trim());
    return (u.protocol==='http:'||u.protocol==='https:')?u:null;
  }catch(e){ return null; }
}

// 구글 이미지 검색창 열기 (제목 자동 완성)
// URL 입력 시 실시간 미리보기
function previewCoverUrl(inpId, thumbId, nameId, mode){
  const url=document.getElementById(inpId)?.value.trim();
  if(!url||!_parseHttpUrl(url)) return;
  if(thumbId){
    const thumb=document.getElementById(thumbId);
    const img=new Image();
    img.crossOrigin='anonymous';
    img.onload=()=>{
      // ★ Phase 9: URL을 HTML 문자열에 이어붙이지 않고 DOM으로 생성 (따옴표 포함 URL의 속성 주입 방지)
      if(!thumb) return;
      const shown=document.createElement('img');
      shown.src=url; shown.style.opacity='.6';
      thumb.replaceChildren(shown);
    };
    img.onerror=()=>{}; // CORS 차단 시 조용히 실패
    img.src=url;
  }
}

// URL 적용 — canvas로 blob 변환 (CORS 통과 시) 또는 직접 fetch
// ★ Phase 12: btnEl — 이벤트 위임(ui-state.js)이 클릭된 버튼을 직접 넘김
//   (이전: 암묵 전역 window.event에 의존 → 호출 경로·브라우저에 따라 버튼을 못 찾거나 내부 요소를 잡음)
async function applyCoverUrl(inpId, thumbId, nameId, mode, btnEl){
  const url=document.getElementById(inpId)?.value.trim();
  if(!url){Toast.warn('이미지 URL을 입력해주세요.');return;}
  if(!_parseHttpUrl(url)){Toast.warn('http:// 또는 https:// 로 시작하는 URL을 입력해주세요.');return;}

  const btn=btnEl||(typeof event!=='undefined'?event?.target?.closest?.('button'):null)||null;
  const origText=btn?.textContent||'';
  if(btn){btn.textContent='로딩 중...';btn.disabled=true;}

  try{
    // 방법 1: canvas crossOrigin → 방법 2: 이미지 프록시 체인 (urlToBlob 내부)
    const blob=await urlToBlob(url);
    // ★ Phase 12: 확장자는 실제 이미지 MIME 우선 (프록시가 WebP·PNG로 돌려줘도 이름과 형식이 일치)
    const extByType={'image/jpeg':'jpg','image/png':'png','image/webp':'webp','image/gif':'gif'}[blob.type];
    const ext=extByType||url.split('?')[0].split('.').pop().toLowerCase().replace(/[^a-z]/g,'')||'jpg';
    const validExt=['jpg','jpeg','png','webp','gif'].includes(ext)?ext:'jpg';
    const fname='cover_url.'+validExt;
    const file=new File([blob],fname,{type:blob.type||'image/jpeg'});

    if(mode==='convert'){
      S.coverFile=file;
      const nameEl=nameId?document.getElementById(nameId):null;
      if(nameEl) nameEl.textContent='✅ URL 표지 적용';
      document.getElementById('coverDz')?.classList.add('ok');
      const thumbEl=thumbId?document.getElementById(thumbId):null;
      if(thumbEl){
        const dataUrl=await blobToDataUrl(blob);
        const img=document.createElement('img');
        img.src=dataUrl;
        thumbEl.replaceChildren(img);
      }
      const inpEl=document.getElementById(inpId); if(inpEl) inpEl.value='';
    } else {
      // 일괄변환: 공통 표지 File 저장
      B.urlCoverFile=file;
      const drop=document.getElementById('batchCoverDrop');
      drop?.classList.add('ok');
      const label=drop?.querySelector('div'); if(label) label.textContent='✅ URL 표지 적용';
      const inpEl=document.getElementById(inpId); if(inpEl) inpEl.value='';
    }
    if(btn){
      btn.textContent='✅ 적용됨';
      setTimeout(()=>{btn.textContent=origText;btn.disabled=false;},1500);
    }
  }catch(e){
    if(btn){btn.textContent=origText;btn.disabled=false;}
    // CORS 차단 안내
    showCorsHelp(inpId, url, thumbId, nameId, mode);
  }
}

function showCorsHelp(inpId, url, thumbId, nameId, mode){
  // CORS 차단 시 대안 안내 모달
  // ★ Phase 12: URL을 inline onclick 문자열에 이어붙이지 않음 — 따옴표가 든 URL로 스크립트가 주입되던 문제
  //   버튼은 정적 마크업 + addEventListener, 이미지 페이지 열기는 http(s) 검증 후 noopener로만 연다
  const safeUrl=_parseHttpUrl(url)?.href||'';
  const overlay=document.createElement('div');
  overlay.style.cssText='position:fixed;inset:0;background:var(--overlay-strong);z-index:600;display:flex;align-items:center;justify-content:center';
  overlay.innerHTML=`
    <div style="background:var(--panel);border-radius:var(--radius-sm);padding:24px;max-width:440px;width:90vw;box-shadow:var(--shadow-xl)">
      <h3 style="font-size:var(--fs-base);font-weight:700;margin-bottom:10px">⚠️ 이미지를 직접 가져올 수 없어요</h3>
      <p style="font-size:var(--fs-sm);color:var(--text2);margin-bottom:14px;line-height:1.7">
        이 이미지는 외부 사이트 보안(CORS) 정책으로 직접 가져올 수 없어요.<br>
        아래 방법 중 하나를 사용해주세요.
      </p>
      <div style="display:flex;flex-direction:column;gap:8px;margin-bottom:16px">
        <div style="background:var(--bg2);border-radius:var(--radius-sm);padding:10px;font-size:var(--fs-sm)">
          <b>방법 1 (권장)</b> — 구글 이미지에서 이미지를 <b>다운로드</b>한 뒤<br>
          드래그앤드롭으로 표지에 넣기
        </div>
        <div style="background:var(--bg2);border-radius:var(--radius-sm);padding:10px;font-size:var(--fs-sm)">
          <b>방법 2</b> — 이미지 페이지를 열어서<br>
          이미지를 <b>다른 이름으로 저장</b> 후 드래그앤드롭
        </div>
        <div style="background:var(--bg2);border-radius:var(--radius-sm);padding:10px;font-size:var(--fs-sm)">
          <b>방법 3</b> — 아래 버튼으로 이미지 페이지 열기 →<br>
          이미지 우클릭 → 다른 이름으로 저장
        </div>
      </div>
      <div style="display:flex;gap:8px;justify-content:flex-end">
        <button type="button" class="btn btn-ghost btn-sm" data-cors-close>닫기</button>
        <button type="button" class="btn btn-blue btn-sm" data-cors-open>🔗 이미지 페이지 열기</button>
      </div>
    </div>`;
  document.body.appendChild(overlay);
  overlay.onclick=e=>{if(e.target===overlay)overlay.remove();};
  overlay.querySelector('[data-cors-close]')?.addEventListener('click',()=>overlay.remove());
  const openBtn=overlay.querySelector('[data-cors-open]');
  if(openBtn){
    if(!safeUrl) openBtn.style.display='none';
    openBtn.addEventListener('click',()=>{
      if(safeUrl) window.open(safeUrl,'_blank','noopener,noreferrer');
      overlay.remove();
    });
  }
}

// ★ Phase 12: 캐시 우회 쿼리 — 기존 쿼리스트링이 있으면 '&'로 연결
//   (이전: url+'?'+Date.now() → '?type=w500?1730…'처럼 기존 쿼리 값이 깨져 썸네일 CDN 이미지가 404)
function _withCacheBust(url){
  try{
    const u=new URL(url);
    u.searchParams.set('_nvt', String(Date.now()));
    return u.href;
  }catch(e){
    return url+(url.includes('?')?'&':'?')+'_nvt='+Date.now();
  }
}

// canvas crossOrigin 방식 — 투명 영역은 흰색으로 채운 뒤 JPEG 인코딩
function _imgUrlToCanvasBlob(src){
  return new Promise((resolve,reject)=>{
    const img=new Image();
    img.crossOrigin='anonymous';
    img.onload=()=>{
      try{
        const canvas=document.createElement('canvas');
        canvas.width=img.naturalWidth||img.width;
        canvas.height=img.naturalHeight||img.height;
        const ctx=canvas.getContext('2d');
        // ★ Phase 12: 투명 PNG가 JPEG로 바뀌며 배경이 검게 되던 문제 — resizeCoverIfNeeded와 동일하게 흰 배경
        ctx.fillStyle='#ffffff';
        ctx.fillRect(0,0,canvas.width,canvas.height);
        ctx.drawImage(img,0,0);
        canvas.toBlob(b=>{
          if(b) resolve(b);
          else reject(new Error('canvas toBlob 실패'));
        },'image/jpeg',0.92);
      }catch(err){ reject(err); }   // tainted canvas(SecurityError)
    };
    img.onerror=()=>reject(new Error('CORS 차단'));
    img.src=src;
  });
}

async function urlToBlob(url){
  // ① 원본 URL 그대로 → ② 캐시 우회 쿼리 (이전에 비-CORS로 캐시된 응답 회피)
  //   서명된 URL(쿼리 변경 시 403)을 위해 원본을 먼저 시도
  try{ return await _imgUrlToCanvasBlob(url); }catch(e){}
  try{ return await _imgUrlToCanvasBlob(_withCacheBust(url)); }catch(e){}
  // ③ ★ Phase 12: 이미지 프록시 체인 (cover-search.js — weserv → Workers → 직접)
  //   이전: canvas가 막히면 프록시를 거치지 않고 바로 CORS 안내창을 띄움
  if(typeof _fetchImgBlob==='function'){
    const blob=await _fetchImgBlob(url);
    if(blob&&/^image\//.test(blob.type||'')) return blob;
  }
  throw new Error('CORS 차단');
}

function blobToDataUrl(blob){
  return new Promise(res=>{
    const r=new FileReader();
    r.onload=e=>res(e.target.result);
    r.readAsDataURL(blob);
  });
}

// 표지 미지정 상태 썸네일 (index.html #coverThumb 초기 마크업과 동일)
const COVER_THUMB_EMPTY_HTML='<span class="cover-thumb-empty"><svg viewBox="0 0 24 24" width="26" height="26" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8.5" cy="8.5" r="1.5"/><polyline points="21 15 16 10 5 21"/></svg><span>표지</span></span>';

function handleCover(files){
  const f=files?.[0];if(!f)return;
  // ★ 수동 지정 표지 — 이후 TXT+이미지 자동 매칭이 덮어쓰지 않도록 플래그 해제
  // (autoMatchCoverImage는 이 함수 호출 직후 _coverAuto=true로 재설정)
  S._coverAuto=false;
  // ★ BUG-3 수정: coverThumb의 이전 blob URL 해제 (메모리 누수 방지)
  const thumb=document.getElementById('coverThumb');
  if(thumb){
    const prevImg=thumb.querySelector('img[data-blob-url]');
    if(prevImg) URL.revokeObjectURL(prevImg.dataset.blobUrl);
  }
  S.coverFile=f;
  scheduleSessionSave();   // ★ Phase 16
  document.getElementById('coverName').textContent='✅ '+f.name;
  document.getElementById('coverDz')?.classList.add('ok');
  const objUrl=URL.createObjectURL(f);
  if(thumb){ thumb.innerHTML=''; const img=document.createElement('img'); img.src=objUrl; img.dataset.blobUrl=objUrl; thumb.appendChild(img); }
}

// ══════════════════════════════════════════
// 🖼 Module: CoverAutoMatch (TXT ↔ 이미지 파일명 유사도 매칭)
// ══════════════════════════════════════════
// 동작 원리:
//   1. 파일명 stem 정규화 (normStem + 'cover/표지' 꼬리표 제거)
//   2. 유사도 = max(문자 바이그램 Dice 계수, 포함 관계 점수)
//      - 포함 관계: 짧은 쪽이 긴 쪽에 통째로 들어있으면 0.75~1.0
//   3. TXT 파일명 전체 / [작가] 제목 · 제목@작가 에서 추출한 제목 둘 다 비교해 최고점 사용
//   4. 임계값(0.5) 이상 최고점 이미지를 표지로 지정 — 이미지가 1개뿐이면 임계값 미달이어도 사용
const _IMG_EXT_RX=/\.(jpg|jpeg|png|webp|bmp|tiff|tif|avif)$/i;
const COVER_MATCH_MIN=0.5;

function _fileStem(name){ return String(name||'').replace(/\.[^.]+$/,''); }

// 파일명 stem에서 제목만 추출 ([작가] 제목 / 제목 @ 작가 규칙 — handleTxt 메타 자동 채우기와 동일)
function _titleFromStem(stem){
  const s=String(stem||'');
  let m=s.match(/^\[(.+?)\]\s*(.+)$/);
  if(m) return m[2].trim();
  m=s.match(/^(.+?)\s*@\s*(.+)$/);
  if(m) return m[1].trim();
  return s;
}

// 매칭 전용 키: 표지 꼬리표 제거 후 normStem 정규화
function _coverMatchKey(stem){
  const cleaned=String(stem||'').replace(/(?:cover|front|thumbnail|thumb|표지|커버)/gi,'');
  return normStem(cleaned);
}

// 두 파일명의 유사도 (0.0 ~ 1.0)
function nameSimilarity(a, b){
  const x=_coverMatchKey(a), y=_coverMatchKey(b);
  if(!x||!y) return 0;
  if(x===y) return 1;
  const shortK=x.length<=y.length?x:y;
  const longK =x.length<=y.length?y:x;
  let contain=0;
  if(shortK.length>=2&&longK.includes(shortK)) contain=0.75+0.25*(shortK.length/longK.length);
  if(x.length<2||y.length<2) return contain;
  // 문자 바이그램 Dice 계수 — O(n) Map 카운팅
  const bigrams=t=>{
    const m=new Map();
    for(let i=0;i<t.length-1;i++){ const k=t.slice(i,i+2); m.set(k,(m.get(k)||0)+1); }
    return m;
  };
  const A=bigrams(x), Bm=bigrams(y);
  let inter=0;
  A.forEach((c,k)=>{ inter+=Math.min(c, Bm.get(k)||0); });
  const dice=(2*inter)/((x.length-1)+(y.length-1));
  return Math.max(dice, contain);
}

// TXT 목록과 이미지 목록 중 가장 이름이 비슷한 이미지 1개 반환 → {file, score, txtName} | null
function findSimilarImage(txtFiles, imgs, minScore=COVER_MATCH_MIN){
  let best=null;
  (imgs||[]).forEach(img=>{
    if(!img?.name) return;
    const iStem=_fileStem(img.name);
    (txtFiles||[]).forEach(t=>{
      if(!t?.name) return;
      const tStem=_fileStem(t.name);
      [tStem, _titleFromStem(tStem)].forEach(k=>{
        const sc=nameSimilarity(k, iStem);
        if(!best||sc>best.score) best={file:img, score:sc, txtName:t.name};
      });
    });
  });
  return best&&best.score>=minScore?best:null;
}

// 표지 자동 매칭 실행 — 성공 시 true
function autoMatchCoverImage(imgs, txtFiles){
  const list=Array.from(imgs||[]).filter(f=>_IMG_EXT_RX.test(f?.name||''));
  if(!list.length) return false;
  // ★ 사용자가 직접 지정한 표지(수동·검색·URL)는 보호 — 자동 매칭 표지만 교체 허용
  if(S.coverFile&&!S._coverAuto){
    Toast.info('🖼 이미 지정한 표지가 있어서 이미지 자동 매칭을 건너뛰었어요.');
    return false;
  }
  let hit=findSimilarImage(txtFiles, list);
  let fallback=false;
  if(!hit&&list.length===1){
    // 이미지가 하나뿐이면 이름이 달라도 표지로 사용 (함께 선택한 의도 존중)
    hit={file:list[0], score:findSimilarImage(txtFiles, list, 0)?.score||0, txtName:''};
    fallback=true;
  }
  if(!hit){
    Toast.info(`🖼 TXT와 이름이 비슷한 이미지를 찾지 못했어요 (${list.length}개 검사)`);
    return false;
  }
  handleCover([hit.file]);
  S._coverAuto=true;
  const pct=Math.round(hit.score*100);
  const nameEl=document.getElementById('coverName');
  if(nameEl) nameEl.textContent=fallback
    ? '✅ '+hit.file.name+' · 함께 선택한 이미지'
    : '✅ '+hit.file.name+' · 이름 유사도 '+pct+'%';
  if(fallback) Toast.info(`🖼 이름 유사도는 낮지만(${pct}%) 함께 선택한 이미지라 표지로 지정했어요.`);
  else Toast.success(`🖼 표지 자동 매칭: ${hit.file.name} (유사도 ${pct}%)`);
  return true;
}

// ── 공통 삽화 파일 처리 함수 ──
// fileArr: 대상 파일 배열, dzId: 드롭존 ID, renderFn: 태그 렌더 함수
function handleIllFiles(files, fileArr, dzId, renderFn){
  const imgs=Array.from(files).filter(f=>/\.(jpg|jpeg|png|gif|webp|bmp|tiff|tif|avif)$/i.test(f.name));
  if(!imgs.length)return;
  fileArr.push(...imgs);
  renderFn();
  const dz=document.getElementById(dzId);
  if(dz){dz.className=(dz.className.includes('epub-drop')?'epub-drop ok':'dz ok');}
}
function handleIll(files){ handleIllFiles(files,S.illFiles,'illDz',renderIllTags); }

function renderIllTags(){
  const c=document.getElementById('illTags');
  // ★ L-19 FIX: 재렌더 전 기존 ObjectURL 모두 해제 → 메모리 누수 방지
  c.querySelectorAll('img[data-obj-url]').forEach(img=>{
    URL.revokeObjectURL(img.dataset.objUrl);
  });
  c.innerHTML='';
  const willConvert=document.getElementById('optImgConvert')?.checked!==false;
  S.illFiles.forEach((f,i)=>{
    const ext=f.name.split('.').pop().toLowerCase();
    const isJpg=['jpg','jpeg'].includes(ext);
    const needsConvert=!isJpg&&willConvert;
    const fmtBadge=isJpg
      ? `<span style="font-size:var(--fs-xs);background:var(--green-bg);color:var(--green);border-radius:var(--radius-xs);padding:1px 4px;font-weight:700">JPG</span>`
      : needsConvert
        ? `<span style="font-size:var(--fs-xs);background:var(--yellow-bg);color:var(--yellow);border-radius:var(--radius-xs);padding:1px 4px;font-weight:700">${escHtml(ext.toUpperCase())}→JPG</span>`
        : `<span style="font-size:var(--fs-xs);background:var(--blue-bg);color:var(--blue);border-radius:var(--radius-xs);padding:1px 4px;font-weight:700">${escHtml(ext.toUpperCase())}</span>`;

    const t=document.createElement('div');
    t.className='tag';
    t.style.cssText='display:flex;align-items:center;gap:5px;padding:4px 8px';
    t.title=f.name+(needsConvert?' (변환 예정)':'');
    t.dataset.idx=i; // ★ 인덱스 명시 저장

    // 썸네일
    const thumb=document.createElement('img');
    thumb.style.cssText='width:22px;height:22px;object-fit:cover;border-radius:var(--radius-xs);flex-shrink:0;border:1px solid var(--border)';
    thumb.alt=f.name;
    const url=URL.createObjectURL(f);
    thumb.src=url;
    thumb.dataset.objUrl=url;
    thumb.onerror=()=>{thumb.style.display='none';};

    const label=document.createElement('span');
    label.style.cssText='max-width:120px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:var(--fs-xs)';
    label.textContent=f.name;

    // 챕터 인덱스 배지 — 파일명에서 파싱해서 어느 챕터에 삽입될지 표시
    const stem=f.name.replace(/\.[^.]+$/,'');
    const mi=stem.match(/^(\d+)(?:_(\d+))?/);
    const chIdxBadge=mi ? (()=>{
      const chIdx=parseInt(mi[1]);      // 1-based 표시용
      const sub=mi[2]?('-'+parseInt(mi[2])):'';
      const b=document.createElement('span');
      b.style.cssText='font-size:var(--fs-xs);background:var(--accent-bg);color:var(--accent);border-radius:var(--radius-xs);padding:1px 5px;font-weight:700;flex-shrink:0;white-space:nowrap';
      b.textContent=chIdx+'번째'+sub;
      b.title=chIdx+'번째 챕터 앞에 삽입 (파일명 기준 인덱스)';
      return b;
    })() : null;

    const badge=document.createElement('span');
    badge.innerHTML=fmtBadge;  // safe-html: fmtBadge는 고정 마크업 + escHtml(확장자)

    const x=document.createElement('span');
    x.className='x';
    x.textContent='✕';
    x.onclick=()=>removeIll(i);

    t.appendChild(thumb);
    t.appendChild(label);
    if(chIdxBadge) t.appendChild(chIdxBadge);
    t.appendChild(badge);
    t.appendChild(x);
    c.appendChild(t);
  });
}

function removeIll(i){
  // data-idx로 정확한 썸네일 찾아서 URL 해제
  const tag=document.getElementById('illTags').querySelector(`[data-idx="${i}"]`);
  const thumb=tag?.querySelector('img[data-obj-url]');
  if(thumb) URL.revokeObjectURL(thumb.dataset.objUrl);
  S.illFiles.splice(i,1);
  renderIllTags();
  if(!S.illFiles.length)document.getElementById('illDz').className='dz';
}

// ── 수동 삽화 행 공통 생성 함수 ──
// containerId: 삽입할 컨테이너 ID (manualIlls / insManualIlls)
function addManualIllRow(containerId){
  const id=S.manualCnt++;
  const c=document.getElementById(containerId);
  if(!c) return;
  const r=document.createElement('div');
  r.className='mill-row';r.id='mr'+id;
  r.innerHTML=
    '<div class="mill-row-top">'+
      '<input placeholder="파일명 (예: 16.jpg)" id="mp'+id+'" style="flex:2;min-width:100px" data-input-action="manualIllName" data-id="'+id+'">'+
      '<button class="btn btn-ghost btn-sm" data-action="browseManual" data-id="'+id+'">찾기</button>'+
      '<input type="number" placeholder="중심 화 번호" id="mc'+id+'" style="width:90px" min="1" data-input-action="loadIllRange" data-id="'+id+'">'+
      '<select id="mpos'+id+'"><option value="before">챕터 앞</option><option value="after">챕터 뒤</option></select>'+
      '<button class="btn btn-sm" style="background:var(--accent-bg);color:var(--accent)" data-action="removeManualIllRow" data-row-id="mr'+id+'">✕</button>'+
    '</div>'+
    '<div class="mill-preview" id="mpv'+id+'">'+
      '<div style="font-size:var(--fs-xs);color:var(--text2);padding:4px 2px">화 번호를 입력하면 해당 화 ±1화 범위를 보여줘요.</div>'+
    '</div>';
  c.appendChild(r);
}
function addManualIll(){ addManualIllRow('manualIlls'); }

// 파일명 → 화 번호 자동 추출 + 범위 로드
function onManualIllName(id){
  const stem=document.getElementById('mp'+id).value.trim().replace(/\.[^.]+$/,'');
  const m=stem.match(/^(\d+)/);
  if(m){
    document.getElementById('mc'+id).value=m[1];
    loadIllRange(id);
  }
}

function browseManual(id){
  const inp=document.createElement('input');inp.type='file';inp.accept='.jpg,.jpeg,.png,.gif,.webp,.bmp,.tiff,.tif,.avif';
  inp.onchange=()=>{
    if(!inp.files[0]) return;
    S.illFiles.push(inp.files[0]);
    renderIllTags();
    document.getElementById('mp'+id).value=inp.files[0].name;
    onManualIllName(id);
  };
  inp.click();
}

// 화 번호 기준 ±1화 범위 로드 + 미리보기 렌더
const _illRangeCache={};  // id → {chNum, chapters:[{ci,heading,body}]}

async function loadIllRange(id){
  const chNum=parseInt(document.getElementById('mc'+id).value);
  const pv=document.getElementById('mpv'+id);
  if(!chNum||!S.txtFiles.length){
    pv.innerHTML='<div style="font-size:var(--fs-xs);color:var(--text2);padding:4px 2px">화 번호를 입력하면 해당 화 ±1화 범위를 보여줘요.</div>';
    pv.classList.remove('show');
    return;
  }

  const chapters=await getCachedChapters();
  if(!chapters.length){pv.classList.remove('show');return;}

  // 중심 챕터 인덱스 — ★ Phase 10: 감지 단계 화 번호(meta.num) 우선, 없으면 제목에서 추출 (EPUB 삽입 기준과 동일)
  const centerCi=chapters.findIndex(c=>((c[2]&&c[2].num!=null)?c[2].num:extractChNum(c[0]))===chNum);

  if(centerCi<0){
    pv.innerHTML='<div class="mill-ch-match"><div class="mill-ch-title" style="color:var(--accent)">⚠️ '+chNum+'화를 찾지 못했어요</div>'+  // safe-html: chNum은 parseInt 결과
      '<div class="mill-ch-body">화 번호를 확인하거나 목차 확인을 먼저 실행해주세요.</div></div>';
    pv.classList.add('show');
    return;
  }

  // ±1화 범위 구성
  const range=[];
  if(centerCi>0)                   range.push({ci:centerCi-1, role:'prev'});
                                    range.push({ci:centerCi,   role:'center'});
  if(centerCi<chapters.length-1)   range.push({ci:centerCi+1, role:'next'});

  // 범위 캐시 저장 (키워드 검색에 사용)
  _illRangeCache[id]={chNum, range:range.map(({ci,role})=>({ci,role,heading:chapters[ci][0],body:chapters[ci][1]||'',
    num:(chapters[ci][2]&&chapters[ci][2].num!=null)?chapters[ci][2].num:null}))};

  renderIllRangePanel(id, '', null);
}

// 3화 범위 패널 렌더 (kw: 현재 키워드, selectedCi: 선택된 챕터 인덱스)
function renderIllRangePanel(id, kw, selectedCi){
  const pv=document.getElementById('mpv'+id);
  const cache=_illRangeCache[id];
  if(!cache){pv.classList.remove('show');return;}

  const kwEsc=kw?kw.replace(/[.*+?^${}()|[\]\\]/g,'\\$&'):'';

  // 3화 카드
  let cardsHtml='<div class="mill-range">';
  cache.range.forEach(({ci,role,heading,body})=>{
    const isSel=ci===selectedCi;
    const isCenter=role==='center';
    const roleLabel=role==='prev'?'⬆ 이전화':role==='next'?'⬇ 다음화':'🎯 '+extractChNum(heading)+'화';
    const cardClass='mill-range-card'+(isCenter?' center':'')+(isSel?' selected':'');

    // 본문 앞부분 (키워드 있으면 하이라이트)
    let bodyPreview=(body||'').split('\n').filter(l=>l.trim()).slice(0,3).join(' ');
    if(bodyPreview.length>60) bodyPreview=bodyPreview.slice(0,60)+'…';
    let titleHtml=escHtml(heading);
    let bodyHtml=escHtml(bodyPreview);

    if(kw&&kwEsc){
      const rx=new RegExp(kwEsc,'g');
      titleHtml=titleHtml.replace(rx,'<span class="rc-kw-hit">'+escHtml(kw)+'</span>');
      // 본문에 키워드 있으면 주변 컨텍스트로 교체
      if(body.includes(kw)){
        const idx=body.indexOf(kw);
        const s=Math.max(0,idx-25);
        const e=Math.min(body.length,idx+kw.length+35);
        bodyHtml='···'+escHtml(body.slice(s,e)).replace(rx,'<span class="rc-kw-hit">'+escHtml(kw)+'</span>')+'···';
      }
    }

    cardsHtml+=
      '<div class="'+cardClass+'" data-action="selectIllRangeCard" data-id="'+id+'" data-ci="'+ci+'" title="클릭해서 이 화로 삽입 위치 설정">'+
        '<div class="rc-role">'+roleLabel+(isSel?' ✓':'')+'</div>'+
        '<div class="rc-title">'+titleHtml+'</div>'+
        '<div class="rc-body">'+bodyHtml+'</div>'+
      '</div>';
  });
  cardsHtml+='</div>';

  // 키워드 검색바
  const kwBar=
    '<div class="mill-kw-bar">'+
      '<span style="font-size:var(--fs-xs);color:var(--text2);white-space:nowrap">🔍 범위 내 검색:</span>'+
      '<input id="mkw'+id+'" placeholder="키워드로 정확한 위치 찾기" value="'+escHtml(kw)+'" '+
             'data-input-action="illKwSearch" data-id="'+id+'">'+
    '</div>'+
    '<div class="mill-kw-status" id="mks'+id+'">'+
      (kw
        ? (cache.range.some(({body,heading})=>(body||heading).includes(kw))
            ? '✅ 범위 내 발견 — 해당 화를 클릭해서 선택하세요'
            : '⚠️ 이 범위(±1화)에 키워드가 없어요. 화 번호를 확인해주세요.')
        : '키워드를 입력하면 3화 범위 안에서만 검색해요')+
    '</div>';

  pv.innerHTML=cardsHtml+kwBar;
  pv.classList.add('show');
}

// 카드 클릭 → 삽입 위치 설정
function selectIllRangeCard(id, ci){
  const cache=_illRangeCache[id];
  if(!cache) return;
  const ch=cache.range.find(r=>r.ci===ci);
  if(!ch) return;

  // 화 번호 입력란에 선택된 화 번호 반영
  const chNum=ch.num!=null?ch.num:extractChNum(ch.heading);
  const mcEl=document.getElementById('mc'+id);
  if(chNum&&mcEl) mcEl.value=chNum;

  // 미리보기 재렌더 (선택 표시)
  const kw=document.getElementById('mkw'+id)?.value||'';
  renderIllRangePanel(id, kw, ci);
}

// 키워드 검색 (디바운스 · 범위 내에서만)
let _kwTimer={};
function debounceIllKwSearch(id){ clearTimeout(_kwTimer['r'+id]); _kwTimer['r'+id]=setTimeout(()=>illKwSearch(id),250); }

function illKwSearch(id){
  const kw=document.getElementById('mkw'+id)?.value.trim()||'';
  const cache=_illRangeCache[id];
  if(!cache) return;

  // 키워드 히트가 있는 카드를 자동 선택
  let autoSel=null;
  if(kw){
    const hit=cache.range.find(({body,heading})=>(body||'').includes(kw)||heading.includes(kw));
    if(hit) autoSel=hit.ci;
  }
  renderIllRangePanel(id, kw, autoSel);
}


// ════════════════════════════════════════════════════════
// ★ 간격 분할 전역 상태 — window 단일 소유권
// parser.js / convert.js 양쪽에서 동일한 객체를 참조
// ════════════════════════════════════════════════════════
// ★ Phase 10: window._autoSplitActive 정의는 parser.js 한 곳 (값은 StateManager 'convert' 스토어 보관)
//   (이전: parser.js 접근자·convert.js·main.js 세 곳에 서로 다른 저장소로 중복 정의)


// tocItems(간격분할 결과)를 [heading, body] 쌍으로 조립
// ══════════════════════════════════════════
// 📊 Module: Progress (진행률 바 UI)
// ══════════════════════════════════════════

// ★ U-01: 진행 타임라인 — 스파크라인용 단계별 소요시간 기록
const _progressTimeline = [];

// 전역 setProgress 함수 — startConvert / splitChaptersAsync / getParserWorker 공통 사용
// ════════════════════════════════════════════════════════
// ★ PERF-01: 진행률 관련 DOM 엘리먼트 모듈 스코프 캐싱
// setProgress()가 변환 중 수백 회 호출되므로 매 호출마다
// document.getElementById를 반복하지 않도록 1회 캐싱
// DOMContentLoaded 이후 initUiState()에서 _initProgEls()로 초기화
// ════════════════════════════════════════════════════════
let _progBarEl   = null;
let _progMsgEl   = null;
let _progWrapEl  = null;
let _progResultEl = null;
let _progErrEl   = null;

function _initProgEls(){
  _progBarEl    = document.getElementById('progBar');
  _progMsgEl    = document.getElementById('progMsg');
  _progWrapEl   = document.getElementById('progWrap');
  _progResultEl = document.getElementById('resultBox');
  _progErrEl    = document.getElementById('errBox');
}

// ── 스텝 인디케이터 pct 경계 상수 ──
const _PROG_STEPS = [15, 30, 45, 92];

function setProgress(pct, msg){
  // ★ PERF-01: 캐싱된 엘리먼트 사용 (getElementById 반복 제거)
  // 캐시가 아직 없으면 fallback으로 즉시 쿼리 (DOMContentLoaded 이전 안전망)
  const bar = _progBarEl || document.getElementById('progBar');
  const txt = _progMsgEl || document.getElementById('progMsg');
  if(bar){
    bar.style.width = pct + '%';
    // ★ U-15 FIX: aria-progressbar 속성 실시간 갱신 — 스크린리더 접근성
    bar.setAttribute('aria-valuemin', '0');
    bar.setAttribute('aria-valuemax', '100');
    bar.setAttribute('aria-valuenow', String(pct));
    bar.setAttribute('aria-valuetext', msg ? `${pct}%, ${msg}` : `${pct}%`);
    // ★ 진행 중 striped 애니메이션, 완료 시 정지
    if(pct > 0 && pct < 100){
      bar.classList.add('animating');
    } else {
      bar.classList.remove('animating', 'compressing');
    }
    // ★ UX-ANIM: 92% 이상 = JSZip 압축 구간 → compressing pulse 추가
    // 이 구간에서 메인 스레드가 블로킹되어 바가 멈춰 보이는 문제 완화
    if(pct >= 92 && pct < 100){
      bar.classList.add('compressing');
    } else {
      bar.classList.remove('compressing');
    }
  }
  if(txt) txt.textContent = msg || '';
  // ★ U-01: 타임라인에 기록 (스파크라인 렌더링용)
  _progressTimeline.push({ pct, msg, t: Date.now() });
  // ★ 스텝 인디케이터 갱신 (epub-gen.js의 updateProgStep 호출)
  if(typeof updateProgStep === 'function'){
    let step = 0;
    for(let i = 0; i < _PROG_STEPS.length; i++){
      if(pct > _PROG_STEPS[i]) step = i + 1;
    }
    updateProgStep(step);
  }
}

// ✨ Module: Convert (변환 실행 플로우)
// ══════════════════════════════════════════
// ★ Phase 9: 변환 재진입 방지 — 버튼 연타·단축키 반복으로 변환이 동시에 2개 이상 돌던 문제
let _convertRunning=false;
let _batchRunning=false;

// ★ Phase 15: 스트리밍 저장 — 변환 시작 시 저장 위치를 먼저 고르면 EPUB을 메모리에 모으지 않고 파일로 바로 기록
//   (Chromium 계열 File System Access API · 사용자 클릭 직후에만 대화상자 허용 → 첫 await 전에 호출)
function _streamSaveAvailable(){ return typeof window.showSaveFilePicker==='function'; }
async function _pickStreamTarget(title){
  if(document.getElementById('optStreamSave')?.checked!==true||!_streamSaveAvailable()) return null;
  try{
    const handle=await window.showSaveFilePicker({
      suggestedName:String(title||'제목 없음').replace(/[\\/:*?"<>|]/g,'_')+'.epub',
      types:[{description:'EPUB 전자책', accept:{'application/epub+zip':['.epub']}}],
    });
    return {name:handle.name, writable:await handle.createWritable()};
  }catch(e){
    if(e?.name==='AbortError') return 'cancel';
    Toast.warn('저장 위치를 열 수 없어 일반 방식으로 변환해요.');
    return null;
  }
}

async function startConvert(){
  if(!S.txtFiles.length){Toast.warn('TXT 파일을 선택해주세요.');return;}
  if(_convertRunning){Toast.info('변환이 이미 진행 중이에요.');return;}
  // ★ Phase 15: 스트리밍 저장 위치 선택 (취소하면 변환하지 않음)
  _convertRunning=true;
  const streamTarget=await _pickStreamTarget(document.getElementById('title')?.value.trim());
  _convertRunning=false;
  if(streamTarget==='cancel'){ Toast.info('저장 위치 선택을 취소했어요.',2000); return; }
  let streamDone=false;
  const convertStart=Date.now();
  // ★ U-01: 타임라인 초기화
  _progressTimeline.length = 0;
  const sparkEl = document.getElementById('progressSparkline');
  if(sparkEl){ sparkEl.innerHTML=''; sparkEl.style.display='none'; }
  // ★ PERF-01: 캐싱 변수 우선 사용 (없으면 직접 쿼리 fallback)
  const _progWrap   = _progWrapEl   || document.getElementById('progWrap');
  const _resultBox  = _progResultEl || document.getElementById('resultBox');
  const _errBox     = _progErrEl    || document.getElementById('errBox');
  _progWrap?.classList.add('show');
  _resultBox?.classList.remove('show');
  _errBox?.classList.remove('show');

  // ── 단계별 진행 표시 ──
  setProgress(0,'① 파일 읽는 중...');

  // ★ Phase 10: 중단은 AbortController 하나로 — 파일 읽기·파싱·EPUB 빌드(Worker) 어느 단계에서든 즉시 멈춤
  //   (이전: 파싱 Worker만 종료 → 그 밖의 단계에서 누르면 변환이 끝까지 진행되고 결과까지 표시됨)
  const ac=new AbortController();
  const checkAbort=()=>{ if(ac.signal.aborted){ const err=new Error('사용자 중단'); err.name='AbortError'; throw err; } };
  const progWrapEl=document.getElementById('progWrap');
  let abortBtn=document.getElementById('convertAbortBtn');
  if(!abortBtn){
    abortBtn=document.createElement('button');
    abortBtn.id='convertAbortBtn';
    abortBtn.className='btn';
    abortBtn.style.cssText='font-size:var(--fs-xs);padding:4px 12px;background:var(--accent-bg);color:var(--accent);border:1.5px solid var(--accent);border-radius:var(--radius-xs);margin-top:6px;display:block';
    abortBtn.textContent='⛔ 변환 중단';
    progWrapEl?.appendChild(abortBtn);
  }
  abortBtn.style.display='block';
  abortBtn.onclick=()=>{
    ac.abort();
    // ★ 파싱 Worker 즉시 종료 (동기 루프 중이라 메시지로는 중단 불가) — EPUB Worker는 signal로 종료
    terminateParserWorker('사용자 중단');
    abortBtn.style.display='none';
    setProgress(0,'⛔ 중단됨');
    document.getElementById('progWrap')?.classList.remove('show');
  };

  _convertRunning=true;
  const _convertBtnEl=document.getElementById('convertBtn');
  _convertBtnEl?.setAttribute('aria-busy','true');
  if(_convertBtnEl) _convertBtnEl.disabled=true;
  try{
    const sorted=[...S.txtFiles];
    const customPat=document.getElementById('pattern')?.value.trim();
    // ★ Phase 13: 설정 탭 '본문 정리' 옵션 (잡음 줄·줄바꿈 병합·문단 정합·기호 정리)
    const cleanOpts=getTextCleanupOpts();
    const tocMode=S.tocItems.length>0;
    // ★ Phase 10: 목차가 이미 있고 원문 줄이 메모리에 있으면 파일을 다시 읽지 않음
    //   (이전: 목차 기반 조립에서도 모든 파일을 매번 다시 읽고 디코딩)
    let srcLines=tocMode?_tocSourceLines():null;
    let raw=null, fileBreaks=[];
    if(!srcLines){
      const raws=[];
      for(let fi=0;fi<sorted.length;fi++){
        setProgress(Math.round(fi/sorted.length*12)+1,
          `① 파일 읽는 중... (${fi+1}/${sorted.length}) ${sorted[fi].name}`);
        await yieldToMain();
        checkAbort();
        raws.push(await fileToText(sorted[fi]));
      }
      // ★ 파일 경계(여러 TXT)·파일명 화수 범위를 목차 감지에 전달
      ({text:raw, fileBreaks}=joinTextsWithBreaks(raws, sorted.map(f=>f.name)));
    }
    setProgress(14,'① 파일 읽기 완료');
    await yieldToMain();
    checkAbort();

    setProgress(15,'② 챕터 패턴 분석 중...');
    await yieldToMain();

    let chapters;
    if(tocMode){
      // ★ tocItems가 있으면 항상 tocItems 기반 조립 (간격 분할 결과 포함 — 원문은 _tocSourceLines 단일 기준)
      // ★ L-16 FIX: 원문 줄이 해제된 경우(대용량 변환 후) 같은 결합 규칙으로 다시 만든 줄 배열 사용
      if(!srcLines){
        srcLines=raw.split('\n');
        if(window._autoSplitActive) window._autoSplitLines=srcLines.length<=200000?srcLines:null;
        window._fullRawLines=srcLines;
      }
      setProgress(20, window._autoSplitActive?'② 간격 분할 모드 — 목차 기반 챕터 조립 중...':'② 목차 기반 챕터 조립 중...');
      await yieldToMain();
      chapters=buildChaptersFromTocItems(srcLines, S.tocItems);
      setProgress(28,`② 챕터 조립 완료 (활성 ${S.tocItems.filter(t=>t.enabled).length}개 → ${chapters.length}개)`);
    } else {
      // tocItems 없음 → 원본 텍스트 직접 파싱
      const detectOpts={
        fileBreaks,
        range:rangeForFiles(sorted.map(f=>f.name)),
        mergeParts:document.getElementById('optMergeParts')?.checked===true,
      };
      setProgress(18,'② 목차 패턴 감지 중...');
      await yieldToMain();
      chapters=_countLines(raw)>=100000
        ? await splitChaptersAsync(raw,customPat,(pct,msg)=>setProgress(pct,msg),detectOpts)
        : splitChapters(raw,customPat,detectOpts);
      setProgress(24,`② 챕터 분리 완료 (${chapters.length}개)`);
    }
    raw=null;
    checkAbort();
    // ★ Phase 10: '문단 정합' 옵션 — 조립된 본문에 적용 (이전: 실제 변환에는 전달되지 않아 무시됨)
    // ★ Phase 13: 문단 정합을 포함한 본문 정리 파이프라인으로 통합 (일괄 변환·미리보기와 같은 함수)
    let cleanStats=null;
    {
      setProgress(28,'② 본문 정리 중...');
      await yieldToMain();
      const res=applyTextCleanup(chapters, cleanOpts);
      chapters=res.chapters; cleanStats=res.stats;
    }
    await yieldToMain();
    setProgress(30,'③ 삽화 파싱 중...');
    await yieldToMain();
    checkAbort();
    // 삽화 파싱 — 파일명 숫자 = 챕터 순번(1-based, '서문' 제외 — Worker에서 매핑)
    // 01.jpg → 첫 번째 챕터 / 100.jpg → 100번째 챕터
    // 01_01.jpg → 첫 번째 챕터의 첫 번째 삽화 / 01_02.jpg → 두 번째 삽화
    const autoIlls=[];
    for(const f of S.illFiles){
      const stem=f.name.replace(/\.[^.]+$/,'');
      const m=stem.match(/^(\d+)(?:_(\d+))?/);
      if(m){
        const chIdx=parseInt(m[1],10)-1;   // 1-based → 0-based 순번
        const order=parseInt(m[2]||'1',10); // 서브넘버 (01_01 → 1, 01_02 → 2)
        autoIlls.push({file:f, idx:chIdx, order, pos:'before'});
      }
    }
    autoIlls.sort((a,b)=>a.idx-b.idx||a.order-b.order);
    const manualIlls=[];
    document.querySelectorAll('[id^="mr"]').forEach(row=>{
      const id=row.id.replace('mr','');
      const name=document.getElementById('mp'+id)?.value.trim();if(!name)return;
      const file=S.illFiles.find(f=>f.name===name);if(!file)return;
      const pos=document.getElementById('mpos'+id)?.value||'before';
      // 새 UI: 화 번호 기준 (키워드는 범위 내 검색용, 최종 삽입은 화 번호 기준)
      const ch=parseInt(document.getElementById('mc'+id)?.value,10);
      if(ch) manualIlls.push({file,ch,order:999,pos});
      // 키워드도 병행 저장 (buildEpub에서 kw 매칭도 지원)
      const kw=document.getElementById('mkw'+id)?.value.trim();
      if(!ch&&kw) manualIlls.push({file,kw,pos});
    });
    const illMap=[...autoIlls,...manualIlls];
    const title=document.getElementById('title')?.value.trim()||'제목 없음';
    const author=document.getElementById('author')?.value.trim()||'작자 미상';
    const useItalic=document.getElementById('optItalic')?.checked;

    // ★ 표지 폴백: 표지 이미지 없을 때 Canvas로 텍스트 커버 자동 생성
    let effectiveCover=S.coverFile;
    if(!effectiveCover){
      setProgress(35,'③ 텍스트 표지 생성 중...');
      await yieldToMain();
      effectiveCover=await generateTextCover(title, author);
    }
    checkAbort();

    setProgress(40,'④ EPUB 빌드 중...');
    await yieldToMain();
    // ★ U-17: warnings 배열 수집 — buildEpub이 {blob, warnings} 형태로 반환 시 처리
    let epubWarnings = [];
    const epubResult = await buildEpub(
      {
        title,author,chapters,coverFile:effectiveCover,illMap,useItalic,
        // ★ 시리즈 메타 (EPUB3 belongs-to-collection + calibre:series)
        series:(document.getElementById('series')?.value||'').trim(),
        seriesIndex:parseInt(document.getElementById('seriesIdx')?.value||'0',10)||0,
      },
      (pct,msg)=>setProgress(40+Math.round(pct*0.52), msg),
      {signal:ac.signal, writable:streamTarget?.writable||null}
    );
    checkAbort();
    // ★ Phase 15: 스트리밍 저장이면 Blob 없이 파일 크기만 돌아옴
    const streamed=!!(epubResult&&epubResult.streamed);
    if(streamed) streamDone=true;
    const sizeBytes=streamed?(epubResult.size||0):null;
    let blob;
    if(streamed){
      blob=null;
    } else if(epubResult && epubResult.blob){
      blob = epubResult.blob;
      epubWarnings = epubResult.warnings || [];
    } else {
      blob = epubResult; // 기존 Blob 직접 반환 방식 하위 호환
    }
    // ★ 변환 리포트: 챕터 구성에서 확인 가능한 경고 수집 (화수 도약·짧은 챕터·패턴 미감지·삽화 매핑 실패)
    epubWarnings = epubWarnings.concat(_collectConvertWarnings(chapters, illMap));
    // ★ Phase 13: 본문 정리 결과 요약 (사용자가 켠 옵션이 실제로 무엇을 바꿨는지)
    epubWarnings = epubWarnings.concat(_describeCleanStats(cleanStats, cleanOpts));
    S.epubBlob=blob;
    S.epubName=streamed?(streamTarget.name||title.replace(/[\\/:*?"<>|]/g,'_')+'.epub'):title.replace(/[\\/:*?"<>|]/g,'_')+'.epub';
    const outBytes=streamed?sizeBytes:blob.size;
    const elapsed=((Date.now()-convertStart)/1000).toFixed(1);
    setProgress(100,'✅ 변환 완료! ('+elapsed+'초)');
    const _abDone=document.getElementById('convertAbortBtn'); if(_abDone) _abDone.style.display='none';

    // ★ 메모리 정리: 200,000줄 이하는 유지 (대용량 장편에서 간격 분할 재접근 가능하도록)
    // window 프로퍼티를 통해 parser.js의 실제 변수를 갱신 (원문 문자열은 텍스트 캐시에 남아 재조립 시 디코딩 없이 복원)
    if(window._fullRawLines&&window._fullRawLines.length>200000){
      window._fullRawLines=null;
    }
    if(window._autoSplitLines&&window._autoSplitLines.length>200000){
      window._autoSplitLines=null;
    }
    const realChapters=chapters.filter(c=>!(c[2]&&c[2].pre)&&c[0]!=='서문');
    document.getElementById('resultMsg').textContent=streamed?('💾 '+S.epubName+' — 고른 위치에 저장했어요'):S.epubName;
    showResultStats('resultStats',[
      {
        label: /^\(\d+\/\d+\)$/.test(realChapters[0]?.[0]||'') ? '페이지' : '챕터',
        value: realChapters.length+'개'
      },
      {label:'파일 크기',value:(outBytes/1024/1024).toFixed(1)+'MB'},
      {label:'소요 시간',value:elapsed+'초'},
    ]);
    // 미리보기/분리용 챕터 저장
    _previewChapters=chapters;
    // ── 히스토리 저장 (IndexedDB 비동기) ──
    // ★ Phase 10: 기록 저장은 변환 결과 표시를 막지 않음 (이전: await — 저장 공간 부족 시 변환 실패로 표시되거나
    //   트랜잭션 abort 미처리로 Promise가 끝나지 않아 변환 버튼이 계속 비활성 상태로 남음)
    saveHistory({
      title,author,
      chapterCount:realChapters.length,
      sizeMB:(outBytes/1024/1024).toFixed(1),
      elapsed,
      date:new Date().toLocaleString('ko-KR',{month:'short',day:'numeric',hour:'2-digit',minute:'2-digit'}),
      name:S.epubName,
      blob   // ★ Phase 15: 스트리밍 저장이면 null — 기록만 남고 파일은 사용자가 고른 위치에 있음
    }).catch(err=>console.warn('[history] 저장 실패:', err));
    const _splitSec=document.getElementById('splitSec'); if(_splitSec) _splitSec.style.display='block';
    const _resBox = _progResultEl || document.getElementById('resultBox');
    if(_resBox){
      _resBox.classList.add('show');
      // ★ UX-ANIM: 결과박스 완료 시 부드러운 스크롤 이동
      _resBox.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }
    if(!streamed){
      _showShareBtnIfSupported(); // ★ C-04: 공유 버튼 조건부 표시
      // ★ EPUB 다운로드 완료 플로팅 바 활성화
      _showEpubDownloadBar(S.epubName);
    } else {
      Toast.success('💾 '+S.epubName+' 파일로 저장했어요');
    }
    // ★ 07: 결과 카드 count-up 애니메이션
    _animateResultStats();
    // ★ U-01: 진행 스파크라인 렌더링
    _renderProgressSparkline();
    // ★ U-17: 변환 경고 리포트 렌더링
    _renderConvertReport(epubWarnings);
    // ★ ADD-10: 변환 완료 브라우저 알림 (탭 백그라운드 시)
    _sendConvertNotif(title || S.epubName, realChapters.length);
  }catch(e){
    // ★ Phase 10: 사용자 중단은 오류로 표시하지 않음
    if(ac.signal.aborted||e?.name==='AbortError'){
      Toast.info('변환을 중단했어요.',2000);
      return;
    }
    // ★ U-20: 복구 가능 오류와 치명적 오류 분류 — EPUB 생성 실패는 치명적 오류(오류 박스)로 표시
    //   (이전: buildEpub이 모든 오류를 RecoverableError로 감싸 '계속 진행합니다' 경고만 뜨고 결과도 오류 안내도 없었음)
    if(e instanceof RecoverableError){
      Toast.warn('⚠ ' + e.message + (e.context ? ` (${e.context})` : ''));
    } else {
      // ★ UX-ANIM: 에러 박스 scrollIntoView + err-shake 애니메이션 트리거
      const errEl = _progErrEl || document.getElementById('errBox');
      if(errEl){
        errEl.textContent = '❌ ' + friendlyError(e);
        errEl.classList.remove('show', 'err-shake');
        void errEl.offsetWidth; // reflow 강제 → 애니메이션 재시작
        errEl.classList.add('show', 'err-shake');
        errEl.scrollIntoView({ behavior: 'smooth', block: 'center' });
      }
      console.error('[startConvert]', e);
    }
  }finally{
    // ★ Phase 15: 스트리밍 저장 도중 실패·중단 → 쓰다 만 파일 폐기 (EPUB 빌드 전 단계에서 끝난 경우 포함)
    if(streamTarget&&streamTarget!=='cancel'&&!streamDone) streamTarget.writable?.abort?.().catch?.(()=>{});
    // ★ Side-Effect 가드: 예외·정상 종료 모두 UI 스피너·중단 버튼 반드시 해제
    // ★ PERF-01: 캐싱 변수 우선 사용
    (_progWrapEl || document.getElementById('progWrap'))?.classList.remove('show');
    const _ab = document.getElementById('convertAbortBtn');
    if(_ab) _ab.style.display = 'none';
    _convertRunning=false;
    _convertBtnEl?.removeAttribute('aria-busy');
    if(_convertBtnEl) _convertBtnEl.disabled=false;
  }
}

// ★ U-17: 변환 경고 수집 — 결과 카드의 #convertReport에 표시
function _collectConvertWarnings(chapters, illMap){
  const out=[];
  const list=Array.isArray(chapters)?chapters:[];
  const real=list.filter(c=>!(c[2]&&c[2].pre)&&c[0]!=='서문');
  if(!real.length) return out;
  // 패턴 미감지 → 페이지/본문 단위 분할
  if(real.every(([h])=>h==='본문'||/^\(\d+\/\d+\)$/.test(h))){
    out.push('챕터 패턴을 찾지 못해 '+(real.length>1?real.length+'개 페이지로 나눠':'본문 하나로')+' 저장했어요. 목차가 필요하면 패턴을 직접 입력하거나 간격 분할을 사용하세요.');
  }
  // 화수 도약 (누락 의심)
  if(typeof _checkIndexJump==='function'&&real.length>2){
    const {jumps}=_checkIndexJump(real);
    jumps.slice(0,5).forEach(j=>out.push(`화수 도약 ${j.from}화 → ${j.to}화 (+${j.gap}) — 중간 화가 빠졌을 수 있어요.`));
    if(jumps.length>5) out.push(`화수 도약 외 ${jumps.length-5}건`);
  }
  // 본문이 매우 짧은 챕터 (마지막 챕터 제외)
  const th=typeof getSuspThreshold==='function'?getSuspThreshold():50;
  const short=real.slice(0,-1).filter(([,b])=>String(b||'').replace(/\s/g,'').length<th);
  if(short.length) out.push(`본문이 ${th}자 미만인 챕터 ${short.length}개: ${short.slice(0,3).map(([h])=>h).join(', ')}${short.length>3?' …':''}`);
  // 삽화 매핑 실패 (해당 화가 없음) — 순번은 '서문' 제외 기준 (EPUB Worker 매핑과 동일)
  const nums=new Set(list.map(c=>(c[2]&&c[2].num!=null)?c[2].num:extractChNum(String(c[0]||''))).filter(n=>n!=null));
  (illMap||[]).forEach(il=>{
    if(typeof il.idx==='number'&&(il.idx<0||il.idx>=real.length)) out.push(`삽화 ${il.file?.name||''}: ${il.idx+1}번째 챕터가 없어 삽입되지 않았어요.`);
    else if(typeof il.ch==='number'&&!nums.has(il.ch)) out.push(`삽화 ${il.file?.name||''}: ${il.ch}화를 찾지 못해 삽입되지 않았어요.`);
  });
  return out;
}

// ★ Phase 13: 본문 정리 통계 → 리포트 문구 (변경이 없으면 빈 배열)
function _describeCleanStats(st, opts){
  const out=[];
  if(!st||!opts) return out;
  if(opts.noise&&st.noise) out.push(`본문 정리: 잡음 줄 ${st.noise}줄을 제외했어요 (작가의 말·공지·URL 등).`);
  if(opts.hardWrap){
    if(st.wrapInfo&&st.wrap) out.push(`본문 정리: ${st.wrapInfo.width}자 고정 줄바꿈을 감지해 ${st.wrap}줄을 문단으로 이었어요.`);
    else if(!st.wrapInfo) out.push('본문 정리: 고정 폭 줄바꿈이 감지되지 않아 줄바꿈 병합은 적용하지 않았어요.');
  }
  if(opts.symbols&&st.symbols) out.push(`본문 정리: 기호를 정리한 줄 ${st.symbols}줄.`);
  return out;
}

// ★ U-17: 변환 오류 리포트 — 챕터별 경고 항목 요약 렌더링
function _renderConvertReport(warnings){
  const el = document.getElementById('convertReport');
  if(!el) return;
  if(!warnings || !warnings.length){ el.style.display='none'; return; }
  // ★ style.css의 #convertReport{display:none} 기본값 때문에 ''가 아닌 'block'으로 명시
  el.style.display = 'block';
  // ★ Phase 13: '본문 정리:' 항목은 경고가 아니라 정보 — 건수·아이콘·색을 분리
  const isInfo=w=>/^본문 정리:/.test(String(w));
  const warnCount=warnings.filter(w=>!isInfo(w)).length;
  const head=warnCount?`⚠ 변환 경고 ${warnCount}건`:'ℹ 변환 정보';
  el.innerHTML =  // safe-html: head는 고정 문구+건수, 항목은 escHtml
    `<div style="font-size:var(--fs-xs);font-weight:700;color:${warnCount?'var(--accent)':'var(--blue)'};margin-bottom:6px">${head}</div>` +
    `<div style="display:flex;flex-direction:column;gap:4px;max-height:120px;overflow-y:auto">` +
    warnings.map(w=>isInfo(w)
      ? `<div style="font-size:var(--fs-xs);color:var(--text2);padding:3px 6px;background:var(--blue-bg);border-radius:var(--radius-xs);border-left:2px solid var(--blue)">ℹ ${escHtml(String(w))}</div>`
      : `<div style="font-size:var(--fs-xs);color:var(--text2);padding:3px 6px;background:var(--accent-bg);border-radius:var(--radius-xs);border-left:2px solid var(--accent)">⚠ ${escHtml(String(w))}</div>`).join('') +
    `</div>`;
}

// ★ U-01: 변환 진행 스파크라인 — 단계별 소요시간 시각화
function _renderProgressSparkline(){
  const container = document.getElementById('progressSparkline');
  if(!container || _progressTimeline.length < 2) return;
  const steps = _progressTimeline.filter((s,i,a)=> i===0 || s.pct !== a[i-1].pct);
  const totalMs = steps[steps.length-1].t - steps[0].t;
  if(totalMs <= 0) return;

  const W=260, H=36, PAD=2;
  const barW = Math.max(2, Math.floor((W - PAD*(steps.length-1)) / steps.length));
  let svgBars='';
  for(let i=1; i<steps.length; i++){
    const dur = steps[i].t - steps[i-1].t;
    const ratio = dur / totalMs;
    const bh = Math.max(2, Math.round(ratio * (H-4)));
    const x = (i-1) * (barW + PAD);
    const pct = steps[i].pct;
    const col = pct >= 90 ? 'var(--green)' : pct >= 50 ? 'var(--accent)' : 'var(--blue)';
    const label = steps[i].msg ? steps[i].msg.replace(/[①②③④⑤]/,'').trim().slice(0,12) : '';
    svgBars += `<rect x="${x}" y="${H-bh}" width="${barW}" height="${bh}" fill="${col}" rx="1" opacity="0.85"><title>${label} (${(dur/1000).toFixed(1)}s)</title></rect>`;
  }
  container.innerHTML =  // safe-html: 막대 SVG는 숫자 좌표로만 생성
    `<svg width="${W}" height="${H}" style="display:block;margin:6px auto 0" aria-label="단계별 소요시간 스파크라인">
      <title>변환 단계별 소요시간</title>${svgBars}
    </svg>
    <div style="font-size:var(--fs-xs);color:var(--text2);margin-top:2px">단계별 소요시간 (총 ${(totalMs/1000).toFixed(1)}초)</div>`;
  container.style.display = 'block'; // ★ #progressSparkline{display:none} 기본값 대응
}

// ★ 07: 결과 카드 count-up + shimmer 애니메이션
function _animateResultStats(){
  const resultBox = document.getElementById('resultBox');
  if(!resultBox) return;

  // shimmer 효과 (0.6초)
  resultBox.classList.add('result-shimmer');
  setTimeout(()=>resultBox.classList.remove('result-shimmer'), 700);

  // count-up: result-stat-val 요소들의 숫자를 0에서 올라가게
  resultBox.querySelectorAll('.result-stat-val').forEach(el=>{
    const raw = el.textContent.trim();
    // 숫자 추출 (1,110화 → 1110, 4.2MB → 4.2)
    const numMatch = raw.replace(/,/g,'').match(/[\d.]+/);
    if(!numMatch) return;
    const target = parseFloat(numMatch[0]);
    const suffix = raw.replace(numMatch[0],'').replace(/,/g,'');
    const isFloat = raw.includes('.');
    const dur = 600;
    const start = performance.now();
    const tick = (now)=>{
      const t = Math.min((now-start)/dur, 1);
      // ease-out cubic
      const ease = 1 - Math.pow(1-t, 3);
      const cur = target * ease;
      const disp = isFloat ? cur.toFixed(1) : Math.round(cur).toLocaleString();
      el.textContent = disp + suffix;
      if(t < 1) requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  });

  // ★ UX-ANIM: 다운로드 버튼 dl-pop 스케일 팝업 애니메이션
  // 기존 pulse-once 대신 눈에 띄는 scale pop으로 교체하여 주목도 강화
  const dlBtn = resultBox.querySelector('[data-action="downloadEpub"]');
  if(dlBtn){
    dlBtn.classList.remove('dl-pop', 'pulse-once');
    void dlBtn.offsetWidth; // reflow 강제 → 애니메이션 재시작 보장
    dlBtn.classList.add('dl-pop');
    dlBtn.addEventListener('animationend', ()=>dlBtn.classList.remove('dl-pop'), { once: true });
  }
}

function friendlyError(e){
  const msg=(e.message||String(e)).toLowerCase();
  // ① 인코딩 오류
  if(msg.includes('encoding')||msg.includes('codec')||msg.includes('utf')||msg.includes('decode'))
    return '⚠️ 인코딩 오류: 파일이 UTF-8이 아닐 수 있어요. EUC-KR 등 다른 인코딩 파일은 먼저 UTF-8로 변환해주세요.';
  // ② 메모리 초과
  if(msg.includes('memory')||msg.includes('quota')||msg.includes('arraybuffer')||msg.includes('maximum'))
    return '⚠️ 메모리 부족: 파일이 너무 커요. 파일을 500화 단위로 분할하거나 불필요한 탭을 닫고 다시 시도해주세요.';
  // ③ JSZip 압축 오류
  if(msg.includes('jszip')||msg.includes('zip')||msg.includes('deflate')||msg.includes('compress'))
    return '⚠️ 압축 오류: EPUB 파일 생성 중 오류가 발생했어요. 파일 크기를 줄이거나 설정에서 압축 레벨을 낮춰보세요.';
  // ④ 용량 한도 초과 (localStorage/IndexedDB)
  if(msg.includes('quotaexceeded')||msg.includes('storage'))
    return '⚠️ 저장 공간 부족: 브라우저 저장 공간이 가득 찼어요. 히스토리를 삭제하거나 캐시를 초기화해주세요.';
  // ⑤ EPUB 구조 오류
  if(msg.includes('container')||msg.includes('opf')||msg.includes('epub'))
    return '⚠️ EPUB 구조 오류: 유효하지 않은 EPUB 파일이에요. 다른 EPUB 파일로 시도해주세요.';
  // ⑥ 챕터 없음
  if(msg.includes('챕터가 없')||msg.includes('chapter'))
    return '⚠️ 챕터 없음: 삽입할 챕터가 선택되지 않았어요. 목차에서 하나 이상 선택해주세요.';
  // ⑦ 파일 읽기 오류
  if(msg.includes('filereader')||msg.includes('cannot read')||msg.includes('file'))
    return '⚠️ 파일 오류: 파일을 읽을 수 없어요. 파일이 열려있거나 손상된 파일이 아닌지 확인해주세요.';
  // ⑧ Worker 오류
  if(msg.includes('worker'))
    return '⚠️ Worker 오류: 백그라운드 처리 중 오류가 발생했어요. 페이지를 새로고침 후 다시 시도해주세요.';
  // ⑨ 네트워크 오류 (폰트/이미지 로드)
  if(msg.includes('network')||msg.includes('fetch')||msg.includes('cors'))
    return '⚠️ 네트워크 오류: 이미지나 폰트를 불러올 수 없어요. 인터넷 연결을 확인해주세요.';
  return '❌ 오류: '+(e.message||String(e));
}

// ══════════════════════════════════════════
// 👁  Module: Preview (변환 결과 미리보기 모달)
// ══════════════════════════════════════════
let _previewChapters=[], _previewIdx=0, _previewFont='', _previewLine='';

function showPreview(){
  if(!_previewChapters.length&&!S.epubBlob){
    Toast.info('변환 후 사용할 수 있어요.');return;
  }
  _previewIdx=0;
  _previewFont=document.getElementById('cssFont')?.value||'"Noto Serif KR",serif';
  _previewLine=document.getElementById('cssLine')?.value||'1.9';

  // ★ EPUB Blob이 있으면 JSZip으로 파싱해 실제 본문 렌더링
  if(S.epubBlob){
    _renderEpubPreview(S.epubBlob);
  } else {
    renderPreview();
  }
  document.getElementById('previewModal')?.classList.add('show');
  document.body.style.overflow='hidden';
  document.body.style.touchAction='none';
}

// ★ EPUB Blob → JSZip 파싱 → 첫 챕터 HTML 렌더링
async function _renderEpubPreview(blob){
  const body=document.getElementById('previewBody');
  body.innerHTML='<div style="text-align:center;padding:30px;color:var(--text2)">⏳ EPUB 파싱 중...</div>';
  try{
    const zip=await JSZip.loadAsync(blob);
    // OPF 찾기
    const container=await zip.file('META-INF/container.xml').async('text');
    const opfPath=container.match(/full-path="([^"]+)"/)?.[1];
    if(!opfPath){renderPreview();return;}
    const opfBase=opfPath.replace(/[^/]+$/,'');
    const opfText=await zip.file(opfPath).async('text');
    // spine 순서 파싱
    const idrefs=[...opfText.matchAll(/<itemref[^>]+idref="([^"]+)"/g)].map(m=>m[1]);
    const manifest={};
    for(const m of opfText.matchAll(/<item[^>]+id="([^"]+)"[^>]+href="([^"]+)"/g)){
      manifest[m[1]]=m[2];
    }
    // 첫 3개 spine 항목 렌더링
    const previewItems=idrefs.filter(id=>manifest[id]&&!manifest[id].includes('cover')).slice(0,3);
    let html='';
    for(const id of previewItems){
      const href=opfBase+manifest[id];
      const xhtml=await zip.file(href)?.async('text')||'';
      // body 추출
      const bodyMatch=xhtml.match(/<body[^>]*>([\s\S]*?)<\/body>/i);
      if(bodyMatch){
        // 이미지 src를 blob URL로 변환
        let content=bodyMatch[1]
          .replace(/<img[^>]+>/gi,'') // 이미지 제거 (미리보기에서 불필요)
          .replace(/class="[^"]*"/g,'') // 클래스 제거
          .replace(/<(\/?)h[1-6]/gi,'<$1h3'); // 헤딩 통일
        html+=`<div class="preview-ch">${content}</div>`;
      }
    }
    body.innerHTML=html||'<div style="padding:20px;color:var(--text2)">미리보기 내용을 불러올 수 없어요.</div>';
    body.style.fontFamily=_previewFont;
    body.style.lineHeight=_previewLine;
    document.getElementById('previewPageInfo').textContent=
      `EPUB 직접 렌더링 · 앞 ${previewItems.length}챕터`;
  }catch(e){
    // 파싱 실패 시 기존 텍스트 미리보기로 폴백
    renderPreview();
  }
}

function renderPreview(){
  const body=document.getElementById('previewBody');
  // 모바일에서 내부 스크롤이 페이지 스크롤과 충돌하지 않도록
  body.style.overscrollBehavior='contain';
  body.style.webkitOverflowScrolling='touch';
  const total=Math.min(_previewChapters.length,_previewIdx+3);
  const start=_previewIdx;
  let html='';
  for(let i=start;i<total;i++){
    const[h,b]=_previewChapters[i];
    if(h==='서문') continue;
    html+='<div class="preview-ch">';
    html+='<h2>'+escHtml(h)+'</h2>';
    const lines=b.split('\n').slice(0,30);
    for(const line of lines){
      const t=line.trim();
      if(!t) continue;
      if(/^[-\u2014]/.test(t)) html+='<p><em>'+escHtml(t)+'</em></p>';
      else html+='<p>'+escHtml(t)+'</p>';
    }
    if(b.split('\n').length>30) html+='<p style="color:var(--text2);font-size:var(--fs-xs);margin-top:8px">... (이하 생략)</p>';
    html+='</div>';
  }
  body.innerHTML=html;  // safe-html: html은 escHtml로 이스케이프한 문단 조각
  body.style.fontFamily=_previewFont;
  body.style.lineHeight=_previewLine;
  document.getElementById('previewPageInfo').textContent=
    (start+1)+'~'+Math.min(total,_previewChapters.length)+' / '+_previewChapters.filter(([h])=>h!=='서문').length+'화';
}

function previewNav(dir){
  _previewIdx=Math.max(0,Math.min(_previewChapters.length-3,_previewIdx+(dir*3)));
  renderPreview();
}

function closePreview(){
  document.getElementById('previewModal')?.classList.remove('show');
  document.body.style.overflow=''; // 스크롤 복원
  document.body.style.touchAction='';
}

// ══════════════════════════════════════════
// ✂️  Module: Split (EPUB N화씩 분리)
// ══════════════════════════════════════════
async function startSplit(){
  if(!S.epubBlob||!_previewChapters.length){Toast.warn('먼저 EPUB을 변환해주세요.');return;}
  const n=parseInt(document.getElementById('splitN')?.value)||100;
  const title=document.getElementById('title')?.value.trim()||'제목 없음';
  const author=document.getElementById('author')?.value.trim()||'작자 미상';
  const useItalic=document.getElementById('optItalic')?.checked!==false;
  const coverFile=S.coverFile;
  const listEl=document.getElementById('splitList');
  listEl.innerHTML='<div style="font-size:var(--fs-sm);color:var(--text2);grid-column:1/-1">분리 중...</div>';
  document.getElementById('splitSec').style.display='block';

  // N화 단위 분리 — '서문'은 화수에 세지 않되 첫 파트 앞에 붙여 보존 (★ 이전: 서문 내용이 분리본에서 사라짐)
  const preface=_previewChapters.filter(([h])=>h==='서문');
  const chapters=_previewChapters.filter(([h])=>h!=='서문');
  const parts=[];
  for(let i=0;i<chapters.length;i+=n){
    parts.push(chapters.slice(i,i+n));
  }
  if(parts.length&&preface.length) parts[0]=[...preface,...parts[0]];

  listEl.innerHTML='';
  const blobs=[];
  for(let pi=0;pi<parts.length;pi++){
    const part=parts[pi];
    const partTitle=title+' '+(pi+1)+'권';
    const firstCh=part[0]?.[0]||'';
    const lastCh=part[part.length-1]?.[0]||'';
    const div=document.createElement('div');
    div.className='split-item';
    div.id='spi_'+pi;
    div.innerHTML='<div style="font-weight:600;margin-bottom:4px">'+escHtml(partTitle)+'</div>'+  // safe-html: pi는 인덱스(숫자)
      '<div style="font-size:var(--fs-xs);color:var(--text2)">'+escHtml(firstCh)+' ~ '+escHtml(lastCh)+'</div>'+
      '<div id="sps_'+pi+'" style="font-size:var(--fs-xs);color:var(--text2);margin-top:4px">생성 중...</div>';
    listEl.appendChild(div);

    try{
      // ★ 분할 EPUB은 원제목을 시리즈로, 파트 순번을 권 번호로 기록 → 리더기 서재에서 묶여 보임
      const blob=await buildEpub({title:partTitle,author,chapters:part,coverFile:pi===0?coverFile:null,illMap:[],useItalic,
        series:title,seriesIndex:pi+1},null);
      blobs.push({name:partTitle+'.epub',blob});
      div.className='split-item done';
      document.getElementById('sps_'+pi).textContent='✅ '+(blob.size/1024/1024).toFixed(1)+'MB';
    }catch(e){
      document.getElementById('sps_'+pi).textContent='❌ 오류';
    }
  }

  // 전체 ZIP 다운로드 버튼 추가
  if(blobs.length>1){
    const btn=document.createElement('div');
    btn.style.gridColumn='1/-1';btn.style.marginTop='8px';
    btn.innerHTML='<button class="btn btn-green" data-action="downloadSplitZip">⬇ 전체 ZIP 다운로드</button>';
    listEl.appendChild(btn);
    window._splitBlobs=blobs;
  }else if(blobs.length===1){
    const url=URL.createObjectURL(blobs[0].blob);
    const a=document.createElement('a');a.href=url;a.download=blobs[0].name;a.click();
    setTimeout(()=>URL.revokeObjectURL(url),1000);
  }
}

async function downloadSplitZip(){
  if(!window._splitBlobs) return;
  const zip=new JSZip();
  window._splitBlobs.forEach(r=>zip.file(r.name,r.blob));
  const blob=await zip.generateAsync({type:'blob',compression:'STORE'});   // ★ Phase 10: EPUB 재압축 생략
  const url=URL.createObjectURL(blob);
  const a=document.createElement('a');a.href=url;a.download='epub_분리.zip';a.click();
  setTimeout(()=>URL.revokeObjectURL(url),1000);
}

function downloadEpub(){
  if(!S.epubBlob){
    Toast.warn('먼저 ✨ EPUB 만들기 버튼을 눌러 변환을 실행해주세요.');
    return;
  }
  const a=document.createElement('a');
  a.href=URL.createObjectURL(S.epubBlob);
  a.download=S.epubName||'output.epub';
  a.click();
  setTimeout(()=>URL.revokeObjectURL(a.href),1000);
}

// ★ EPUB 다운로드 완료 플로팅 바 — 변환 완료 시 하단에 상시 표시
// ★ Phase 10: 변환 결과 상태 해제 + 하단 바를 '변환' 상태로 복귀 (새 파일 로드·초기화 공용)
function _resetConvertResultUi(){
  S.epubBlob=null; S.epubName='';
  _previewChapters=[];
  const dl=document.getElementById('btmDownload'); if(dl) dl.style.display='none';
  const cv=document.getElementById('btmConvert'); if(cv&&document.getElementById('page-convert')?.offsetParent!==null) cv.style.display='flex';
  document.getElementById('resultBox')?.classList.remove('show');
  const sp=document.getElementById('splitSec'); if(sp) sp.style.display='none';
}

function _showEpubDownloadBar(epubName){
  const bar=document.getElementById('btmDownload');
  const nameEl=document.getElementById('btmDlName');
  const convertBar=document.getElementById('btmConvert');
  if(!bar) return;

  // 파일명 표시
  if(nameEl) nameEl.textContent=epubName||'output.epub';

  // 변환 바를 숨기고 다운로드 바 표시
  if(convertBar) convertBar.style.display='none';
  bar.style.display='flex';

  // pulse 애니메이션 1회
  bar.classList.remove('pulse');
  requestAnimationFrame(()=>requestAnimationFrame(()=>bar.classList.add('pulse')));

  // 닫기 버튼 — 닫으면 기존 변환 바로 복귀
  const closeBtn=document.getElementById('btmDlClose');
  if(closeBtn){
    // 이벤트 중복 방지: 기존 리스너 제거 후 재등록
    const newClose=closeBtn.cloneNode(true);
    closeBtn.parentNode.replaceChild(newClose, closeBtn);
    newClose.addEventListener('click',()=>{
      bar.style.display='none';
      if(convertBar) convertBar.style.display='flex';
    });
  }
}

// ★ I7: 챕터별 글자수 분포 미니 SVG 차트
// ★ Phase 9:
//   · 화수가 막대 수용량(폭/2)보다 많으면 연속 화를 구간으로 묶어 그림
//     (이전: 막대 폭 1px+간격 1px 고정 → 300px에 868화면 앞 ~150화만 보이고 나머지 잘림)
//   · 툴팁은 textContent로 채움 (이전: data-title을 innerHTML로 넣어 '<img onerror>' 제목이 실행됨)
//   · 툴팁 요소는 전역 1개를 재사용하고, 다시 그릴 때 숨김 (이전: 렌더마다 body에 새 div 누적)
//   · 막대 색은 CSS 변수 (이전: #e8764a / #4472a8 하드코딩)
let _tocChartTipEl=null;
function _getTocChartTip(){
  if(!_tocChartTipEl||!_tocChartTipEl.isConnected){
    _tocChartTipEl=document.createElement('div');
    _tocChartTipEl.className='toc-chart-tooltip';
    _tocChartTipEl.style.display='none';
    const strong=document.createElement('strong');
    const sub=document.createElement('div');
    _tocChartTipEl.append(strong,sub);
    document.body.appendChild(_tocChartTipEl);
  }
  return _tocChartTipEl;
}
function _fmtChars(n){
  return n>=10000?(n/10000).toFixed(1)+'만자':n>=1000?(n/1000).toFixed(1)+'k':n+'자';
}
function renderTocMiniChart(){
  const el=document.getElementById('tocMiniChart');
  if(_tocChartTipEl) _tocChartTipEl.style.display='none';
  if(!el||!S.tocItems.length) return;
  const items=S.tocItems.filter(t=>t.enabled&&(t.bodyLen||0)>0);
  if(!items.length){el.innerHTML='';return;}
  // ★ FIX-07 연동: getSuspThreshold 사용
  const _suspThr = typeof getSuspThreshold==='function' ? getSuspThreshold() : 50;
  const W=el.clientWidth||300, H=36;
  // 막대 하나 최소 2px(폭 1 + 간격 1) — 넘치면 연속 화를 구간으로 묶음
  const slots=Math.max(1,Math.floor((W-4)/2));
  const per=Math.ceil(items.length/slots);
  const groups=[];
  for(let g=0;g<items.length;g+=per) groups.push(items.slice(g,g+per));
  // 막대 간격을 소수로 계산해 폭 전체를 채움 (정수 내림 시 오른쪽이 비는 문제 방지)
  const step=(W-4)/groups.length, bw=Math.max(1,step-1);
  // ★ Phase 10: 수만 항목 spread(Math.max(...arr))는 인자 수 한도(RangeError) 위험 → reduce
  const maxLen=items.reduce((m,t)=>Math.max(m,t.bodyLen||0),1);

  const bars=groups.map((grp,i)=>{
    const lens=grp.map(t=>t.bodyLen||0);
    const top=Math.max(...lens);
    const h=Math.max(2,Math.floor(top/maxLen*(H-4)));
    const x=(2+i*step).toFixed(2);
    // ★ ADD-03: 짧은 챕터(경고), 긴 챕터(파랑), 정상(accent) — 구간에 짧은 화가 하나라도 있으면 경고색
    const col = Math.min(...lens) < _suspThr ? 'var(--yellow)' : top > 50000 ? 'var(--blue)' : 'var(--accent)';
    // ★ BUG-FIX: data-real-idx에 실제 S.tocItems 인덱스 저장 (enabled 필터 인덱스 ≠ 실제 인덱스)
    const realIdx = S.tocItems.indexOf(grp[0]);
    return `<rect x="${x}" y="${H-h}" width="${bw.toFixed(2)}" height="${h}" rx="1" data-idx="${i}" data-real-idx="${realIdx}"
      style="fill:${col};cursor:pointer;opacity:.75;transition:opacity .1s"/>`;
  }).join('');

  // viewBox + preserveAspectRatio=none: 실제 표시 폭(width:100%)에 막대 전체를 맞춤
  el.innerHTML=`<svg width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" style="display:block;width:100%">${bars}</svg>`;  // safe-html: 막대 SVG는 숫자 좌표로만 생성

  // ★ ADD-03: SVG hover 툴팁
  const svg = el.querySelector('svg');
  if(!svg) return;
  svg.addEventListener('mousemove', e=>{
    const rect_svg = e.target;
    if(rect_svg?.tagName !== 'rect') return;
    const grp = groups[parseInt(rect_svg.dataset.idx)];
    if(!grp) return;
    const tip=_getTocChartTip();
    const first=grp[0], last=grp[grp.length-1];
    const total=grp.reduce((a,t)=>a+(t.bodyLen||0),0);
    if(tip.firstChild) tip.firstChild.textContent = grp.length>1
      ? `${first.title||''} ~ ${last.title||''}`.slice(0,60)
      : (first.title||'챕터 '+(S.tocItems.indexOf(first)+1)).slice(0,40);
    if(tip.lastChild) tip.lastChild.textContent = grp.length>1
      ? `${grp.length}개 · 평균 ${_fmtChars(Math.round(total/grp.length))}`
      : _fmtChars(total);
    tip.style.left = Math.min(e.clientX+12, window.innerWidth-220)+'px';
    tip.style.top  = (e.clientY-38)+'px';
    tip.style.display='';
    // 해당 rect hover 강조
    svg.querySelectorAll('rect').forEach(r=>r.style.opacity='.45');
    rect_svg.style.opacity='1';
  });
  svg.addEventListener('mouseleave', ()=>{
    if(_tocChartTipEl) _tocChartTipEl.style.display='none';
    svg.querySelectorAll('rect').forEach(r=>r.style.opacity='.75');
  });
  // 클릭: 해당 챕터(구간의 첫 화)로 스크롤 (★ BUG-FIX: data-real-idx로 실제 tocItems 인덱스 사용)
  svg.addEventListener('click', e=>{
    const rect_svg = e.target;
    if(rect_svg?.tagName !== 'rect') return;
    const realIdx = parseInt(rect_svg.dataset.realIdx ?? rect_svg.dataset.idx, 10);
    // ★ Phase 10: 가상 스크롤 목록 — 화면 밖 행도 tocScrollToIndex로 이동 + 강조
    if(typeof tocTab==='function') tocTab(0);
    if(typeof tocScrollToIndex==='function') tocScrollToIndex(realIdx);
  });
}

// ★ I10: 목차 내보내기 (글자수 포함)
function exportTocWithStats(){
  if(!S.tocItems.length){Toast.warn('목차가 없어요. 먼저 목차 확인을 실행해주세요.');return;}
  const lines=S.tocItems
    .filter(t=>t.enabled)
    .map((t,i)=>{
      const bl=t.bodyLen||0;
      const blStr=bl>=10000?(bl/10000).toFixed(1)+'만자':bl>=1000?(bl/1000).toFixed(1)+'k자':bl+'자';
      return String(i+1).padStart(3,'0')+'. '+t.title+' ('+blStr+')';
    }).join('\n');
  const blob=new Blob([lines],{type:'text/plain;charset=utf-8'});
  const a=document.createElement('a');
  a.href=URL.createObjectURL(blob);
  a.download=(document.getElementById('title')?.value||'목차')+'_목차.txt';
  a.click();
  setTimeout(()=>URL.revokeObjectURL(a.href),1000);
  Toast.success('목차를 내보냈어요 ('+S.tocItems.filter(t=>t.enabled).length+'개 챕터)');
}

// ★ C-04: Web Share API — 모바일(iOS Safari, Android Chrome) EPUB 직접 공유
async function shareEpub(){
  if(!S.epubBlob){ Toast.warn('변환 후 사용할 수 있어요.'); return; }
  if(!navigator.share){ Toast.info('이 브라우저는 공유 기능을 지원하지 않아요.'); return; }
  try{
    const file=new File([S.epubBlob], S.epubName||'output.epub', {type:'application/epub+zip'});
    await navigator.share({ files:[file], title: S.epubName||'EPUB', text:'NovelEPUB으로 변환된 파일입니다.' });
  }catch(e){
    if(e.name!=='AbortError') Toast.error('공유 실패: '+e.message);
  }
}

// ★ C-04: 결과 카드에 공유 버튼 조건부 표시 (navigator.share 지원 환경만)
function _showShareBtnIfSupported(){
  if(!navigator.share&&!navigator.canShare) return;
  const btnRow=document.querySelector('#resultBox .flex-row');
  if(!btnRow||document.getElementById('shareEpubBtn')) return;
  const btn=document.createElement('button');
  btn.id='shareEpubBtn';
  btn.className='btn btn-blue';
  btn.setAttribute('data-action','shareEpub');
  btn.textContent='📤 공유';
  btnRow.appendChild(btn);
}

// ════ 결과 stat 카드 렌더링 (최적화 5) ════
function showResultStats(containerId, stats){
  const el=document.getElementById(containerId);
  if(!el) return;
  el.innerHTML=stats.map(s=>
    `<div class="result-stat-card">
       <div class="result-stat-val">${escHtml(String(s.value))}</div>
       <div class="result-stat-lbl">${escHtml(String(s.label))}</div>
     </div>`
  ).join('');
}

// ════ 목차 편집 상태 배너 (추천 3) ════
function updateTocEditBanner(){
  const banner=document.getElementById('tocEditBanner');
  const textEl=document.getElementById('tocEditBannerText');
  if(!banner) return;
  if(!S.tocItems||!S.tocItems.length){
    banner.classList.remove('show');
    return;
  }
  const total=S.tocItems.length;
  const active=S.tocItems.filter(t=>t.enabled).length;
  const edited=S.tocItems.some(t=>t.originalTitle&&t.title!==t.originalTitle);
  const hasDisabled=active<total;
  if(hasDisabled||edited){
    if(textEl) textEl.textContent=`✏️ 목차 편집됨 — 활성 ${active} / 전체 ${total}개`+(edited?' · 제목 수정 있음':'');
    banner.classList.add('show');
  } else {
    banner.classList.remove('show');
  }
}

// ════ 히스토리 필터/검색 (추천 7) ════
function filterHistory(){
  const q=(document.getElementById('histSearchInp')?.value||'').toLowerCase().trim();
  const onlyHasFile=document.getElementById('histFilterHasFile')?.classList.contains('on');
  document.querySelectorAll('#histList .hist-item').forEach(el=>{
    const title=(el.querySelector('.hist-title')?.textContent||'').toLowerCase();
    const matchQ=!q||title.includes(q);
    const matchFile=!onlyHasFile||el.querySelector('[data-action="histDownload"]');
    el.style.display=(matchQ&&matchFile)?'':'none';
  });
}
function toggleHistFilter(btn){
  btn.classList.toggle('on');
  filterHistory();
}

// ══════════════════════════════════════════
// 📦 Module: Batch (일괄 변환 플로우)
// ══════════════════════════════════════════
// 일괄 변환 패턴 프리셋 — [표시명, 정규식, 설명] (프리셋 패널·100% 일치 탐색 공용)
// ★ v3 이식: '[ 파일명.txt ]' 정규식이 '^\\.'(점)으로 시작해 한 줄도 맞지 않던 문제 수정 → '^\\['
const _BATCH_PRESETS = [
  ['[ 파일명.txt ] 형식','^\\[\\s*.+\\.txt\\s*\\]\\s*$',            '[ 0001_제목.txt ] 분리 파일 합본 형식'],
  ['화 번호',        '^#?(?:제\\s*)?\\d+\\s*화(?:\\s*.+)?$',       '숫자+화 형식 (#N화, 제N화, N화 제목)'],
  ['숫자만',         '^\\d+$',                                      '줄에 숫자만 단독으로 있는 경우'],
  ['소설(숫자)',     '^.{1,60}\\s*\\(\\d+\\)\\s*$',                 '제목 끝에 (N) 형식'],
  ['소설명+N화',    '^.{2,15}\\s+\\d+화$',                          '소설 제목+N화 형식 (이고깽 이후 천 년 1화 등)'],
  ['#N. 제목',      '^#\\d+\\.\\s+.{1,60}$',                       '#숫자+점 형식 (#1. 시작)'],
  ['N. 제목',       '^\\d+\\.\\s+.{1,60}$',                        '숫자+점 형식 (1. 프롤로그)'],
  ['장 번호',       '^(?:제\\s*\\d+\\s*장|第\\s*\\d+\\s*章)',        '제N장 형식 (주만 변연물어 등)'],
  ['N부 M화',       '^[1-9]부\\s+(?:\\d+화|프롤로그)',              'N부 M화 복합 형식'],
  ['=== [제N화] ===','^={2,}\\s*\\[제\\s*\\d+\\s*화\\]',           '이중등호+대괄호 형식'],
  ['Chapter N',     '^(?:chapter|part|ch)\\s*\\d+',                '영어 Chapter/Part 형식'],
  ['프롤로그/외전',  '^(?:프롤로그|에필로그|외전|후일담)',           '외전·에필로그 등 특수 챕터'],
  ['# 제목',        '^#{1,3}\\s*.+$',                               '마크다운 헤딩 형식'],
];

// ════════════════════════════════════════════════════════
// ⚡ 일괄 변환 간격 분할 (N화) — 상태: _bStore  (v3 이식 · 엔진: parser.js computeIntervalSplit)
//   B.batchSplit = { enabled:boolean, template:string }   ← 전역 토글 (모든 파일)
//   B.splitModes = { [idx]: {mode:'interval', total:N} | {mode:'pattern'} }  ← 파일별 우선
// 우선순위: 파일별 interval > 파일별 pattern(전역 해제) > 전역 토글 > 패턴 감지
// ════════════════════════════════════════════════════════
function _resolveBatchSplit(i){
  const g=B.batchSplit||{};
  const tpl=String(g.template||'').trim()||'{N}화';
  const m=(B.splitModes||{})[i];
  if(m&&m.mode==='interval') return {total:m.total||0, template:tpl, source:'file'};
  if(m&&m.mode==='pattern') return null;
  if(g.enabled) return {total:0, template:tpl, source:'global'};
  return null;
}

// 파일명 화수와 정확히 같은 수를 내는 프리셋 (자동 감지가 오차 5%를 넘을 때의 보정 — v3 '100% 일치')
//   개수 기준은 실제 변환과 같은 detectToc(사용자 패턴 모드)의 본편 화수
function _findExactPreset(lines, totalCh){
  if(!totalCh||totalCh<=0||!Array.isArray(lines)) return null;
  for(const [label,val] of _BATCH_PRESETS){
    try{
      // 빠른 거르기: 단순 매칭 줄 수가 화수보다 적으면 detectToc(전체 줄 분석)까지 갈 필요 없음
      const rx=new RegExp(val,'i');
      let raw=0;
      for(const l of lines){ const t=String(l||'').trim(); if(t&&t.length<=150&&rx.test(t)) raw++; }
      if(raw<totalCh) continue;
      const det=detectToc(lines,{customPat:val});
      if(det?.stats?.mode==='custom'&&det.stats.main===totalCh) return {label, val};
    }catch(e){}
  }
  return null;
}

// 전역 간격 분할 토글 + 제목 형식 입력 — batchPattern 행 아래에 1회 삽입 (index.html 무변경)
function _ensureBatchSplitControls(){
  if(document.getElementById('batchSplitRow')){ _syncBatchSplitControls(); return; }
  const anchor=document.getElementById('batchPattern')?.closest('.row');
  if(!anchor?.parentNode) return;

  const row=document.createElement('div');
  row.className='toggle-row';
  row.id='batchSplitRow';
  const info=document.createElement('div');
  const lbl=document.createElement('label');
  lbl.htmlFor='batchIntervalMode';
  lbl.textContent='간격 분할 일괄 적용 (N화)';
  const sm=document.createElement('small');
  sm.textContent='패턴 대신 화수만큼 균등하게 나눠요 · 화수는 파일명 → 감지된 목차 → 자동 추정 순 · 제목 줄이 있으면 그 줄에서 분할';
  info.append(lbl, sm);
  const sw=document.createElement('label');
  sw.className='sw';
  sw.innerHTML='<input type="checkbox" id="batchIntervalMode"><span class="sw-slider" aria-hidden="true"></span>';
  row.append(info, sw);

  const tplRow=document.createElement('div');
  tplRow.className='row';
  tplRow.id='batchSplitTplRow';
  tplRow.style.padding='3px 0';
  const tl=document.createElement('label');
  tl.className='lbl'; tl.htmlFor='batchIntervalTpl'; tl.style.width='80px'; tl.textContent='제목 형식';
  const ti=document.createElement('input');
  ti.className='inp'; ti.id='batchIntervalTpl'; ti.placeholder='{N}화  ({N}=화 번호)';
  tplRow.append(tl, ti);

  anchor.insertAdjacentElement('afterend', row);
  row.insertAdjacentElement('afterend', tplRow);

  row.querySelector('#batchIntervalMode')?.addEventListener('change',e=>{
    const g={...(B.batchSplit||{})};
    g.enabled=!!e.target?.checked;
    _bStore.set({batchSplit:g});
    _syncBatchSplitControls();
    (B.txtFiles||[]).forEach((_,i)=>_syncBatchModeBadge(i));
    if(g.enabled) Toast.info('모든 파일을 간격 분할(N화)로 변환해요. 파일별 설정이 있으면 그 값이 우선이에요.',3500);
  });
  ti.addEventListener('input',e=>{
    const g={...(B.batchSplit||{})};
    g.template=e.target?.value||'';
    _bStore.set({batchSplit:g});
  });
  _syncBatchSplitControls();
}

function _syncBatchSplitControls(){
  const g=B.batchSplit||{};
  const chk=document.getElementById('batchIntervalMode');
  if(chk) chk.checked=!!g.enabled;
  const tplInp=document.getElementById('batchIntervalTpl');
  if(tplInp&&document.activeElement!==tplInp) tplInp.value=g.template||'{N}화';
  const tplRow=document.getElementById('batchSplitTplRow');
  const anyFile=Object.values(B.splitModes||{}).some(m=>m&&m.mode==='interval');
  if(tplRow) tplRow.style.display=(g.enabled||anyFile)?'':'none';
}

// 배치 목록 항목의 모드 배지 + 파일별 패널의 '패턴 모드로' 버튼 표시 동기화
function _syncBatchModeBadge(i){
  const badge=document.getElementById('bmode_'+i);
  const split=_resolveBatchSplit(i);
  if(badge){
    badge.textContent=split?(split.source==='file'?'간격 '+split.total+'화':'간격 분할(자동)'):'';
    badge.style.display=split?'':'none';
  }
  const clearBtn=document.getElementById('bint_clear_'+i);
  if(clearBtn) clearBtn.style.display=split?'':'none';
  _syncBatchSplitControls();
}

// 파일별 간격 분할 적용
function applyBatchInterval(idx){
  const inp=document.getElementById('bint_total_'+idx);
  const n=Number(String(inp?.value||'').trim());
  if(!Number.isInteger(n)||n<1||n>9999){Toast.warn('1~9999 사이의 정수를 입력해주세요.');return;}
  const modes={...(B.splitModes||{})};
  modes[idx]={mode:'interval', total:n};
  _bStore.set({splitModes:modes});
  _renderBatchIntervalPreview(idx);
  _syncBatchModeBadge(idx);
  Toast.success(`${n}화 간격 분할을 적용했어요.`,2500);
}

// 파일별 간격 분할 해제 → 패턴 모드 (전역 토글이 켜져 있으면 이 파일만 패턴 모드로 고정)
function clearBatchInterval(idx){
  const modes={...(B.splitModes||{})};
  if((B.batchSplit||{}).enabled) modes[idx]={mode:'pattern'};
  else delete modes[idx];
  _bStore.set({splitModes:modes});
  const pv=document.getElementById('bint_preview_'+idx);
  if(pv) pv.textContent='패턴 감지 모드로 변환해요.';
  _syncBatchModeBadge(idx);
  Toast.info('패턴 감지 모드로 되돌렸어요.',2000);
}

// 파일별 간격 분할 미리보기 (목차 확인으로 원문이 로드된 경우 — 실제 변환과 같은 엔진·같은 조립기)
function _renderBatchIntervalPreview(idx){
  const pv=document.getElementById('bint_preview_'+idx);
  if(!pv) return;
  const split=_resolveBatchSplit(idx);
  if(!split){ pv.textContent='패턴 감지 모드로 변환해요.'; return; }
  const text=B.sampleTexts?.[idx];
  if(!text||typeof computeIntervalSplit!=='function'){
    pv.textContent='간격 분할 '+(split.total?split.total+'화':'(자동 화수)')+' — 변환할 때 적용돼요.';
    return;
  }
  try{
    const lines=text.split('\n');
    const total=split.total>0?split.total
      :(B.totalChs?.[idx]||estimateIntervalTotal(lines, B.txtFiles?.[idx]?.name||''));
    const items=computeIntervalSplit(lines, total, {titleMode:'number', titleTemplate:split.template});
    _recalcTocStats(items, lines);
    const q=_calcSplitQuality(items);
    const avg=q.avgLen>=10000?(q.avgLen/10000).toFixed(1)+'만자':q.avgLen.toLocaleString()+'자';
    pv.replaceChildren();
    const head=document.createElement('div');
    head.style.marginBottom='3px';
    head.textContent=items.length+'화 · 균등도 '+q.score+'% · 평균 '+avg+'/화';
    const box=document.createElement('div');
    box.style.cssText='display:flex;flex-direction:column;gap:1px;padding:4px 6px;background:var(--bg2);border-radius:var(--radius-xs);border:1px solid var(--border)';
    const sample=items.length<=5?items:[...items.slice(0,3),...items.slice(-2)];
    sample.forEach(t=>{
      const first=(lines.slice(t.line-1, t.line+5).find(l=>String(l).trim())||'').trim();
      const r=document.createElement('div');
      r.style.cssText='display:flex;gap:6px;align-items:baseline;min-width:0';
      const b=document.createElement('b');
      b.style.cssText='color:var(--blue);flex-shrink:0';
      b.textContent=t.title;
      const sp=document.createElement('span');
      sp.style.cssText='overflow:hidden;text-overflow:ellipsis;white-space:nowrap;min-width:0';
      sp.textContent='← '+first.slice(0,40);
      r.append(b, sp);
      box.appendChild(r);
    });
    pv.append(head, box);
  }catch(e){
    pv.textContent='미리보기 생성 실패: '+(e?.message||e);
  }
}

function handleBatchTxt(files){
  const _all=Array.from(files||[]);
  const txts=_all.filter(f=>/\.txt$/i.test(f?.name||''));
  // ★ TXT 드롭존에 이미지가 섞여 오면 표지 맵으로 전달 (파일명 유사도 자동 매핑)
  const imgs=_all.filter(f=>_IMG_EXT_RX.test(f?.name||''));
  if(!txts.length){
    if(imgs.length) handleBatchCover(imgs);
    return;
  }
  B.txtFiles=txts.sort((a,b)=>sortKey(a.name)<sortKey(b.name)?-1:1);
  B.patterns={};
  B.sampleTexts={};
  B.totalChs={};
  B.splitModes={};   // ★ v3: 파일별 간격 분할 설정은 파일 인덱스 기준이므로 새 목록에서 폐기
  const dz=document.getElementById('batchTxtDrop');
  dz.classList.add('ok');
  dz.querySelector('.dz-text').textContent='✅ '+txts.length+'개 파일 선택됨';
  document.getElementById('batchResetBar').style.display='flex';
  renderBatchList();
  const _listSec=document.getElementById('batchListSec');
  if(_listSec) _listSec.style.display='block';
  if(imgs.length) handleBatchCover(imgs);
}

function handleBatchCover(files){
  const imgs=Array.from(files).filter(f=>/\.(jpg|jpeg|png|webp|bmp|tiff|tif|avif)$/i.test(f.name));
  imgs.forEach(f=>{const stem=f.name.replace(/\.[^.]+$/,'');B.coverMap[stem]=f;});
  document.getElementById('batchCoverDrop')?.classList.add('ok');
  document.getElementById('batchCoverDrop').querySelector('div').textContent='✅ '+imgs.length+'개 표지 등록';
  renderBatchList();
}

// 표지 퍼지 매핑: 공백·특수문자 제거 후 문자만 비교하는 방식으로 강화
function normStem(s){
  // 공백, 언더스코어, 하이픈, 괄호류, 권/부/화 숫자 suffix 제거 후 소문자
  return s.replace(/[\s_\-\.\[\]\(\)\{\}「」『』【】《》〈〉·~!?！？,，。\.]+/g,'').toLowerCase();
}
function findFuzzyCover(txtStem){
  const keys=Object.keys(B.coverMap);
  if(!keys.length) return null;
  const normTxt=normStem(txtStem);

  // 0순위: 완전 일치 (정규화 후)
  const exact=keys.find(k=>normStem(k)===normTxt);
  if(exact) return B.coverMap[exact];

  // 1순위: 정규화된 커버 stem이 정규화된 txt stem의 앞부분과 일치 (접두어, 최소 4자)
  const prefix=keys.find(k=>{const nk=normStem(k);return nk.length>=4&&normTxt.startsWith(nk);});
  if(prefix) return B.coverMap[prefix];

  // 2순위: 정규화된 커버 stem이 정규화된 txt stem에 포함 (최소 4자)
  const included=keys.find(k=>{const nk=normStem(k);return nk.length>=4&&normTxt.includes(nk);});
  if(included) return B.coverMap[included];

  // 3순위: 토큰 교집합 — 양쪽을 한글 단어로 분리해 공통 토큰이 2개 이상이면 매칭
  const txtTokens=new Set(txtStem.replace(/[0-9\s_\-\.]+/g,' ').trim().split(/\s+/).filter(t=>t.length>=2));
  const best=keys.reduce((acc,k)=>{
    const kTokens=k.replace(/[0-9\s_\-\.]+/g,' ').trim().split(/\s+/).filter(t=>t.length>=2);
    const common=kTokens.filter(t=>txtTokens.has(t)).length;
    return common>acc.score?{k,score:common}:acc;
  },{k:null,score:1}); // 최소 2개 이상 (score>1)
  if(best.k) return B.coverMap[best.k];

  // 4순위: 바이그램 유사도 — 오타·띄어쓰기·부제 차이 흡수 (nameSimilarity ≥ 0.6)
  let simBest=null;
  keys.forEach(k=>{
    const sc=Math.max(nameSimilarity(txtStem,k), nameSimilarity(_titleFromStem(txtStem),k));
    if(sc>=0.6&&(!simBest||sc>simBest.score)) simBest={k,score:sc};
  });
  if(simBest) return B.coverMap[simBest.k];

  return null;
}

function renderBatchList(){
  const c=document.getElementById('batchList');
  if(!c) return;
  c.replaceChildren();
  _ensureBatchSplitControls();   // ★ v3: 전역 간격 분할 토글 (1회 삽입)
  B.txtFiles.forEach((f,i)=>{
    const stem=f.name.replace(/\.txt$/i,'');
    let title=stem,author='';
    let m=stem.match(/^\[(.+?)\]\s*(.+)$/);
    if(m){author=m[1].trim();title=m[2].trim();}
    else{m=stem.match(/^(.+?)\s*@\s*(.+)$/);if(m){title=m[1].trim();author=m[2].trim();}}
    const cover=B.coverMap[stem]||findFuzzyCover(stem)||B.urlCoverFile||null;
    const d=document.createElement('div');d.className='batch-item';d.id='bi_'+i;
    const thumbHtml=cover
      ?'<div class="batch-thumb" data-action="batchPickCover" data-idx="'+i+'" title="클릭해서 변경"><img id="bthumb_'+i+'" src=""></div>'
      :'<div class="batch-thumb" data-action="batchPickCover" data-idx="'+i+'" title="표지 지정">+</div>';
    d.innerHTML='<div class="batch-header">'+thumbHtml+  // safe-html: thumbHtml은 고정 마크업(+숫자 id)
      '<div style="flex:1;min-width:0"><div class="batch-title">'+escHtml(title)+'</div>'+
      '<div style="display:flex;align-items:center;gap:6px;flex-wrap:wrap"><div class="batch-status" id="bst_'+i+'">'+(author?'✒️ '+escHtml(author):'')+'</div>'+
      '<span id="bmode_'+i+'" style="display:none;font-size:var(--fs-xs);padding:1px 7px;border-radius:var(--radius-sm);white-space:nowrap;background:var(--blue-bg);color:var(--blue);border:1px solid var(--blue)"></span>'+
      '<button class="batch-toc-btn" data-action="showBatchToc" data-idx="'+i+'" title="목차 미리보기">📋 목차 확인</button></div>'+
      '</div></div>'+
      '<div class="batch-toc-panel" id="btp_'+i+'"></div>'+
      '<div class="batch-prog"><div class="batch-prog-bar" id="bpb_'+i+'" style="width:0"></div></div>';
    c.appendChild(d);
    if(cover){const r=new FileReader();r.onload=e=>{const img=document.getElementById('bthumb_'+i);if(img)img.src=e.target.result;};r.readAsDataURL(cover);}
    _syncBatchModeBadge(i);
  });
}

async function showBatchToc(idx, btn){
  const panel=document.getElementById('btp_'+idx);
  if(panel.classList.contains('show')){
    panel.classList.remove('show');
    btn.textContent='📋 목차 확인';
    return;
  }

  btn.textContent='⏳ 분석 중...';btn.disabled=true;
  try{
    const file=B.txtFiles[idx];
    // 전체 파일 텍스트 로드 (정확한 목차 감지)
    let text;
    try{ text=await fileToText(file); }
    catch(e){ text=await sampleLines(file); }
    const allLines=text.split('\n');

    // 파일명에서 총 화수 추출 (80% 기준)
    const totalCh=parseChapterRange(file.name)?.total||0;   // 파일명 화수 ('1-201 완결' → 201, '0-853' → 854)

    // sampleText와 totalCh 캐시 저장
    B.sampleTexts[idx]=text;
    B.totalChs[idx]=totalCh;
    // 파일별 개별 패턴 우선, 없으면 공통 패턴
    const pat=(B.patterns[idx]||document.getElementById('batchPattern')?.value||'').trim();
    // ★ Phase 8: 실제 일괄 변환(splitChapters)과 같은 detectToc 사용 — 확인 패널 = 변환 결과
    //   이전: bestPat 단일 패턴 + 자동 감지 정규식을 파일별 '지정 패턴'으로 저장 → 변환 때 새 엔진을 우회
    const mergeParts=document.getElementById('optMergeParts')?.checked===true;
    let det=detectToc(allLines,{customPat:pat, range:parseChapterRange(file.name), mergeParts});
    // ★ v3 이식: 자동 감지가 파일명 화수와 5% 넘게 어긋나면 화수가 정확히 같은 프리셋을 찾아 이 파일 패턴으로 채택
    //   (이 패턴은 B.patterns에 저장 → 실제 변환도 같은 결과)
    let exactPreset=null;
    if(!pat&&totalCh>0&&Math.abs(det.stats.main-totalCh)/totalCh>0.05){
      exactPreset=_findExactPreset(allLines, totalCh);
      if(exactPreset){
        B.patterns[idx]=exactPreset.val;
        det=detectToc(allLines,{customPat:exactPreset.val, range:parseChapterRange(file.name), mergeParts});
      }
    }
    const exactMatch=totalCh>0&&det.stats.main===totalCh;
    const chapters=det.items.map(it=>({line:it.line,title:it.title}));
    const detectedName=exactPreset?exactPreset.label:det.name;
    const mainCnt=det.stats.main;
    const detectedPct=totalCh>0?mainCnt/totalCh*100:100;

    // 파일명 화수와 5% 이내면 성공 (화수 정보가 없으면 3개 이상 감지로 판단)
    const isGood=chapters.length>=3&&(totalCh===0||Math.abs(mainCnt-totalCh)/totalCh<=0.05);

    panel.innerHTML='';
    const HEAD=5, TAIL=5;

    if(!isGood){
      // 실패: 패턴 패널 표시 + 현황
      let failMsg='';
      if(chapters.length<3) failMsg='챕터를 감지하지 못했어요.';
      else failMsg=`본편 ${mainCnt}화 감지 (파일명 ${totalCh}화 기준 ${detectedPct.toFixed(1)}% — 오차 5% 초과)`;

      panel.innerHTML=
        '<div style="font-size:var(--fs-xs);color:var(--accent);padding:4px;margin-bottom:6px">'+
          '⚠️ '+escHtml(failMsg)+' 아래에서 패턴을 선택하거나 간격 분할(N화)을 적용해주세요.'+
        '</div>'+
        buildPatPresetPanel(idx,text,totalCh);
    } else {
      // 성공: 챕터 목록 + 패턴 변경 버튼
      const pctStr=totalCh>0?` · 본편 ${mainCnt}/${totalCh}화 (${(detectedPct-100>=0?'+':'')+(detectedPct-100).toFixed(1)}%)`:'';
      const info=document.createElement('div');
      info.style.cssText='font-size:var(--fs-xs);color:var(--text2);margin-bottom:6px;display:flex;justify-content:space-between;align-items:center';
      const exactBadge=exactMatch
        ?' <span style="font-size:var(--fs-xs);padding:0 6px;border-radius:var(--radius-sm);background:var(--green-bg);color:var(--green);border:1px solid var(--green)">파일명 화수 100% 일치</span>'
        :'';
      info.innerHTML=  // safe-html: pctStr·exactBadge는 숫자·고정 마크업, 패턴 이름은 escHtml
        `<span>총 <b style="color:var(--accent)">${chapters.length}</b>개 챕터${pctStr}${detectedName?' · '+escHtml(detectedName):''}${exactBadge}</span>`+
        '<button class="btn btn-ghost btn-sm" style="font-size:var(--fs-xs)" data-action="toggleBatchPreset" data-idx="'+idx+'">✏️ 패턴 변경 · 간격 분할</button>';
      panel.appendChild(info);
      if(exactPreset) Toast.success(`'${exactPreset.label}' 패턴이 파일명 화수(${totalCh}화)와 정확히 일치해 이 파일에 적용했어요.`,3500);

      const presetDiv=document.createElement('div');
      presetDiv.id='bpreset_'+idx;
      presetDiv.style.display=_resolveBatchSplit(idx)?'block':'none';   // 간격 분할 중이면 설정을 펼쳐 둠
      presetDiv.innerHTML=buildPatPresetPanel(idx,text,totalCh);
      panel.appendChild(presetDiv);

      const list=document.createElement('div');
      list.className='batch-toc-list';
      const show=chapters.length<=HEAD+TAIL
        ? chapters
        : [...chapters.slice(0,HEAD), null, ...chapters.slice(-TAIL)];
      show.forEach(ch=>{
        const row=document.createElement('div');
        if(!ch){
          row.style.cssText='text-align:center;color:var(--text3);font-size:var(--fs-xs);padding:3px 0';
          row.textContent='··· '+(chapters.length-HEAD-TAIL)+'개 더 ···';
        } else {
          row.className='batch-toc-row';
          row.innerHTML='<span class="batch-toc-num">'+ch.line+'줄</span><span class="batch-toc-title">'+escHtml(ch.title)+'</span>';  // safe-html: ch.line은 줄 번호(숫자), 제목은 escHtml
        }
        list.appendChild(row);
      });
      panel.appendChild(list);
    }
    panel.classList.add('show');
    btn.textContent='📋 목차 닫기';
    _renderBatchIntervalPreview(idx);   // ★ v3: 원문이 로드됐으니 간격 분할 미리보기 갱신
  }catch(e){
    panel.innerHTML='<div style="font-size:var(--fs-xs);color:var(--accent)">오류: '+escHtml(e?.message||String(e))+'</div>';
    panel.classList.add('show');
    btn.textContent='📋 목차 확인';
  }
  btn.disabled=false;
}

function toggleBatchPreset(idx){
  const d=document.getElementById('bpreset_'+idx);
  if(!d) return;
  const isHidden = d.style.display==='none';
  if(isHidden){
    // 열 때 항상 최신 개수로 재렌더
    d.innerHTML=buildPatPresetPanel(idx, B.sampleTexts[idx]||'', B.totalChs[idx]||0);
    d.style.display='block';
  } else {
    d.style.display='none';
  }
}

function buildPatPresetPanel(idx, sampleText, totalCh){
  const curPat = B.patterns[idx] || '';
  const lines = sampleText ? sampleText.split('\n') : [];
  const tc = totalCh || 0;

  // 각 패턴별 매칭 개수 계산
  function countPat(val){
    try{
      const rx=new RegExp(val,'i');
      const cnt=lines.filter(l=>l.trim()&&rx.test(l.trim())).length;
      return cnt;
    }catch(e){return 0;}
  }

  const PRESETS = _BATCH_PRESETS;

  // 현재 패턴에서 체크 상태 계산
  const checkedVals = new Set();
  if(curPat){
    const orMatch = curPat.match(/^\^\(\?:(.+)\)$/);
    if(orMatch){
      const parts = orMatch[1].split('|');
      PRESETS.forEach(([,val])=>{
        const stripped = val.replace(/^\^/,'').replace(/\$$/,'');
        if(parts.some(p=>p===stripped)) checkedVals.add(val);
      });
    } else {
      PRESETS.forEach(([,val])=>{ if(val===curPat) checkedVals.add(val); });
    }
  }

  let html =
    '<div style="margin-top:6px;padding:8px;background:var(--bg);border-radius:var(--radius-sm);border:1px solid var(--border)">' +
    '<div style="font-size:var(--fs-sm);font-weight:700;color:var(--text);margin-bottom:8px">📐 챕터 패턴 선택</div>' +
    '<div style="display:flex;gap:6px;margin-bottom:8px;flex-wrap:wrap">' +
      '<button class="btn btn-ghost btn-sm" style="font-size:var(--fs-xs)" data-action="batchPresetCheckAll" data-idx="'+idx+'" data-val="true">전체 선택</button>' +
      '<button class="btn btn-ghost btn-sm" style="font-size:var(--fs-xs)" data-action="batchPresetCheckAll" data-idx="'+idx+'" data-val="false">전체 해제</button>' +
      '<button class="btn btn-ghost btn-sm" style="font-size:var(--fs-xs)" data-action="batchPresetAuto" data-idx="'+idx+'">🔍 자동 감지</button>' +
    '</div>' +
    '<div id="bpck_list_'+idx+'" style="display:flex;flex-direction:column;gap:4px">';

  PRESETS.forEach(([label, val, desc])=>{
    const checked = checkedVals.has(val) ? 'checked' : '';
    const cnt = countPat(val);
    const pct = tc>0 ? (cnt/tc*100).toFixed(0) : null;
    const isExact = tc>0&&cnt===tc;   // ★ v3: 파일명 화수와 정확히 같은 개수
    const pctStr = pct!==null ? ` (${cnt}개 / ${pct}%${isExact?' · 100% 일치':parseFloat(pct)>=80?' ⭐':''})` : (cnt>0?` (${cnt}개)`:'');
    const goodBg = pct!==null&&parseFloat(pct)>=80 ? 'background:var(--green-bg);border-color:var(--green)' : '';

    html +=
      `<label style="display:flex;align-items:flex-start;gap:8px;padding:5px 6px;border-radius:var(--radius-xs);cursor:pointer;border:1px solid var(--border);background:var(--bg2);${goodBg}">` +
        `<input type="checkbox" class="bpck_${idx}" data-val="${escHtml(val)}" ${checked}` +
               ` data-input-action="applyBatchPreset" data-idx="${idx}" style="margin-top:2px;flex-shrink:0">` +
        '<div style="min-width:0;flex:1">' +
          '<div style="font-size:var(--fs-sm);font-weight:600;display:flex;gap:6px;align-items:center;flex-wrap:wrap">' +
            escHtml(label) +
            `<span style="font-size:var(--fs-xs);color:${parseFloat(pct)>=80?'var(--green)':'var(--accent)'};font-weight:700">${pctStr}</span>` +
            `<span style="font-size:var(--fs-xs);color:var(--text2);font-weight:400">${escHtml(desc)}</span>` +
          '</div>' +
        '</div>' +
      '</label>';
  });

  html +=
    '</div>' +
    '<div style="margin-top:8px;border-top:1px solid var(--border);padding-top:8px">' +
      '<div style="font-size:var(--fs-xs);font-weight:600;color:var(--text2);margin-bottom:4px">직접 입력 (정규식)</div>' +
      '<div style="display:flex;gap:6px">' +
        `<input class="inp" id="bpat_direct_${idx}" placeholder="직접 입력하거나 위에서 선택" ` +
               `value="${escHtml(curPat)}" style="flex:1;font-size:var(--fs-xs)" data-input-action="applyBatchPreset" data-idx="${idx}">` +
        `<button class="btn btn-blue btn-sm" data-action="confirmBatchPreset" data-idx="${idx}">✅ 적용</button>` +
      '</div>' +
      `<div id="bpat_preview_${idx}" style="font-size:var(--fs-xs);color:var(--text2);margin-top:4px">` +
        (curPat?'현재: '+escHtml(curPat):'(자동 감지)') +
      '</div>' +
    '</div>' +
    _batchIntervalSectionHtml(idx, lines, tc) +
    '</div>';
  return html;
}

// ★ v3 이식: 프리셋 패널 하단 '간격 분할 (N화)' 섹션 — 기본 화수: 저장값 → 파일명 → 감지 수 → 빈 줄 군집 → 300줄당 1화
function _batchIntervalSectionHtml(idx, lines, tc){
  const sm=(B.splitModes||{})[idx];
  let est=(sm&&sm.mode==='interval'&&sm.total)||tc||0;
  if(!est) est=lines.length?estimateIntervalTotal(lines, B.txtFiles?.[idx]?.name||''):1;
  est=Math.max(1, Math.min(9999, est||1));
  const active=!!_resolveBatchSplit(idx);
  return '<div style="margin-top:8px;border-top:1px solid var(--border);padding-top:8px">' +
      '<div style="font-size:var(--fs-xs);font-weight:600;color:var(--text2);margin-bottom:4px">간격 분할 (N화)</div>' +
      '<div style="display:flex;gap:6px;align-items:center;flex-wrap:wrap">' +
        `<input class="inp" type="number" min="1" max="9999" id="bint_total_${idx}" value="${est}" aria-label="간격 분할 화수" style="width:90px;font-size:var(--fs-xs)">` +
        '<span style="font-size:var(--fs-xs);color:var(--text2)">화로 균등 분할 (제목 줄이 있으면 그 줄에서 분할)</span>' +
        `<button class="btn btn-blue btn-sm" data-action="applyBatchInterval" data-idx="${idx}">간격 분할 적용</button>` +
        `<button class="btn btn-ghost btn-sm" id="bint_clear_${idx}" data-action="clearBatchInterval" data-idx="${idx}" style="display:${active?'':'none'}">↩ 패턴 모드로</button>` +
      '</div>' +
      `<div id="bint_preview_${idx}" style="font-size:var(--fs-xs);color:var(--text2);margin-top:4px">` +
        (active?'간격 분할 적용됨':'패턴 감지 모드로 변환해요.') +
      '</div>' +
    '</div>';
}

function batchPresetCheckAll(idx, checked){
  document.querySelectorAll('.bpck_'+idx).forEach(cb=>cb.checked=checked);
  applyBatchPreset(idx);
}

async function batchPresetAuto(idx){
  const file = B.txtFiles[idx];
  if(!file) return;
  delete B.patterns[idx];
  delete B.sampleTexts[idx];
  const btn = document.querySelector('#bi_'+idx+' .batch-toc-btn');
  const panel = document.getElementById('btp_'+idx);
  panel.classList.remove('show');
  if(btn){
    btn.textContent='📋 목차 확인';
    await showBatchToc(idx, btn);
  }
}

function applyBatchPreset(idx){
  // 직접 입력 필드 — 사용자가 명시적으로 입력한 경우만 우선
  const directEl=document.getElementById('bpat_direct_'+idx);
  const direct=directEl?.value.trim();
  const checks=[...document.querySelectorAll('.bpck_'+idx+':checked')].map(c=>c.dataset.val);

  let combined='';
  if(direct&&!checks.length){
    // 직접 입력만 있는 경우
    combined=direct;
  } else if(checks.length===1&&!direct){
    combined=checks[0];
  } else if(checks.length>1&&!direct){
    // 체크박스 여러 개 → OR 결합
    const parts=checks.map(v=>v.replace(/^\^/,'').replace(/\$$/,'').replace(/^\(\?:/,'').replace(/\)$/,''));
    combined='^(?:'+parts.join('|')+')$';
  } else if(direct&&checks.length){
    // 직접 입력 + 체크박스 모두 있으면 직접 입력 우선
    combined=direct;
  }

  // 직접 입력 필드 동기화 (체크박스로만 선택 시)
  if(!direct&&combined&&directEl) directEl.value=combined;

  // 패턴 저장
  if(combined) B.patterns[idx]=combined;
  else delete B.patterns[idx];

  const prev=document.getElementById('bpat_preview_'+idx);
  if(prev) prev.textContent=combined?'현재: '+combined:'(자동 감지)';

  // 총 챕터 수 실시간 업데이트
  if(combined&&B.sampleTexts[idx]){
    try{
      const rx=new RegExp(combined,'i');
      const lines=B.sampleTexts[idx].split('\n');
      const cnt=lines.filter(l=>l.trim()&&rx.test(l.trim())).length;
      const totalCh=B.totalChs[idx]||0;
      const pct=totalCh>0?(cnt/totalCh*100).toFixed(0)+'%':null;
      const infoEl=document.querySelector('#btp_'+idx+' b[style*="accent"]');
      if(infoEl){
        infoEl.textContent=cnt;
        const pctSpan=infoEl.nextSibling;
        if(pctSpan&&pct) pctSpan.textContent=' ('+pct+(parseFloat(pct)>=80?' ⭐':'')+')';
      }
    }catch(e){}
  }
}

async function confirmBatchPreset(idx){
  const directEl=document.getElementById('bpat_direct_'+idx);
  const direct=directEl?.value.trim();
  const checks=[...document.querySelectorAll('.bpck_'+idx+':checked')].map(c=>c.dataset.val);

  let pat=direct;
  if(!pat&&checks.length===1) pat=checks[0];
  else if(!pat&&checks.length>1){
    const parts=checks.map(v=>v.replace(/^\^/,'').replace(/\$$/,'').replace(/^\(\?:/,'').replace(/\)$/,''));
    pat='^(?:'+parts.join('|')+')$';
  }
  if(!pat) pat=B.patterns[idx];
  if(!pat){Toast.warn('패턴을 선택하거나 직접 입력해주세요.');return;}

  B.patterns[idx]=pat;
  // ★ v3: 패턴을 명시적으로 확정하면 이 파일의 간격 분할은 해제 (전역 토글이 켜져 있으면 이 파일만 패턴 모드로 고정)
  const modes={...(B.splitModes||{})};
  if(modes[idx]?.mode==='interval'||(B.batchSplit||{}).enabled){
    if((B.batchSplit||{}).enabled) modes[idx]={mode:'pattern'};
    else delete modes[idx];
    _bStore.set({splitModes:modes});
  }
  const btn=document.querySelector('#bi_'+idx+' .batch-toc-btn');
  const panel=document.getElementById('btp_'+idx);
  panel?.classList.remove('show');
  if(btn){btn.textContent='📋 목차 확인';await showBatchToc(idx,btn);}
  _syncBatchModeBadge(idx);
}

function batchPickCover(idx){
  const inp=document.createElement('input');inp.type='file';inp.accept='.jpg,.jpeg,.png,.webp';
  inp.onchange=()=>{
    const f=inp.files[0];if(!f)return;
    B.coverMap[B.txtFiles[idx].name.replace(/\.txt$/i,'')]=f;
    const thumb=document.querySelector('#bi_'+idx+' .batch-thumb');
    // ★ Phase 15: 문자열 대신 DOM으로 이미지 생성
    if(thumb){const r=new FileReader();r.onload=e=>{const img=document.createElement('img');img.src=e.target.result;img.style.cssText='width:100%;height:100%;object-fit:cover';thumb.replaceChildren(img);};r.readAsDataURL(f);}
  };inp.click();
}

async function startBatch(){
  if(!B.txtFiles.length){Toast.warn('TXT 파일을 선택해주세요.');return;}
  if(_batchRunning){Toast.info('일괄 변환이 이미 진행 중이에요.');return;}
  _batchRunning=true;
  B.results=[];
  const _batchStartTime = Date.now();
  document.getElementById('batchProgWrap')?.classList.add('show');
  document.getElementById('batchResultBox')?.classList.remove('show');
  const total=B.txtFiles.length;
  const globalPat=document.getElementById('batchPattern')?.value.trim();
  const useItalicBatch=document.getElementById('batchItalic')?.checked;

  try{
    for(let i=0;i<total;i++){
      const f=B.txtFiles[i];
      const stem=f.name.replace(/\.txt$/i,'');
      let title=stem,author='';
      let m=stem.match(/^\[(.+?)\]\s*(.+)$/);
      if(m){author=m[1].trim();title=m[2].trim();}
      else{m=stem.match(/^(.+?)\s*@\s*(.+)$/);if(m){title=m[1].trim();author=m[2].trim();}}
      const cover=B.coverMap[stem]||findFuzzyCover(stem)||B.urlCoverFile||null;
      const item=document.getElementById('bi_'+i);
      if(item)item.className='batch-item running';
      document.getElementById('bst_'+i).textContent='변환 중...';
      document.getElementById('batchProgMsg').textContent='('+(i+1)+'/'+total+') '+title+' 변환 중...';
      document.getElementById('batchProgBar').style.width=Math.floor(i/total*100)+'%';
      try{
        await new Promise(r=>setTimeout(r,0));
        const raw=await fileToText(f);
        let chapters;
        // ★ v3 이식: 간격 분할(N화) 분기 — 파일별 설정 > 전역 토글 (엔진: computeIntervalSplit, 조립: TocModel)
        const split=_resolveBatchSplit(i);
        if(split){
          const lines=raw.replace(/\r\n?/g,'\n').split('\n');
          const n=split.total>0?split.total:(B.totalChs?.[i]||estimateIntervalTotal(lines, f.name));
          const items=computeIntervalSplit(lines, n, {titleMode:'number', titleTemplate:split.template});
          chapters=intervalItemsToChapters(lines, items);
          const stEl=document.getElementById('bst_'+i);
          if(stEl) stEl.textContent='변환 중... (간격 분할 '+chapters.length+'화)';
        } else {
          const pattern=(B.patterns[i]||globalPat);
          // ★ 파일명 화수 범위('1-201 완결')로 목차 감지 보정
          chapters=splitChapters(raw,pattern,{
            range:parseChapterRange(f.name),
            mergeParts:document.getElementById('optMergeParts')?.checked===true,
          });
        }
        // ★ Phase 13: 설정 탭 '본문 정리'를 일괄 변환에도 적용 (이전: 문단 정합 옵션이 일괄 변환에는 전달되지 않음)
        chapters=applyTextCleanup(chapters, getTextCleanupOpts()).chapters;
        // ★ 파일명에서 시리즈명·권 번호 자동 추출 ('작품 3권.txt' → 작품 / 3)
        const sm=parseSeriesFromName(f.name);
        const blob=await buildEpub({title,author,chapters,coverFile:cover,illMap:[],useItalic:useItalicBatch,
          series:sm?.series||'',seriesIndex:sm?.index||0},
          pct=>{document.getElementById('bpb_'+i).style.width=(30+pct*0.7)+'%';});
        B.results.push({name:title+'.epub',blob});
        if(item)item.className='batch-item done';
        const _doneEl=document.getElementById('bst_'+i);
        if(_doneEl) _doneEl.textContent='✅ 완료 · '+chapters.filter(([h])=>h!=='서문').length+'화'+(split?' (간격 분할)':'');
        document.getElementById('bpb_'+i).style.width='100%';
      }catch(e){
        // ★ 개별 파일 오류: 해당 항목만 실패 표시 후 루프 계속 (전체 중단 없음)
        if(item)item.className='batch-item error';
        document.getElementById('bst_'+i).textContent='❌ '+e.message;
      }
    }
    document.getElementById('batchProgBar').style.width='100%';
    document.getElementById('batchProgMsg').textContent='완료! '+B.results.length+'/'+total+'개 성공';
    document.getElementById('batchResultMsg').textContent=B.results.length+'개 epub 생성 완료';
    document.getElementById('batchResultBox')?.classList.add('show');
    const batchElapsed=((Date.now()-_batchStartTime)/1000).toFixed(1);
    const totalMB=B.results.reduce((s,r)=>s+(r.blob?.size||0),0)/1024/1024;
    Toast.success(`✅ 일괄변환 완료 — ${B.results.length}/${total}개 성공 · ${totalMB.toFixed(1)}MB · ${batchElapsed}초`, 6000);
  }finally{
    // ★ Side-Effect 가드: 예기치 않은 예외에도 반드시 batchProgWrap 해제
    // (outer catch 없이 finally만으로 무한 스피너 방지)
    document.getElementById('batchProgWrap')?.classList.remove('show');
    _batchRunning=false;
  }
}

async function downloadBatchZip(){
  if(!B.results.length)return;
  // ★ Phase 10: 단일 파일 다운로드도 Object URL 해제 (이전: 누수)
  if(B.results.length===1){const a=document.createElement('a');a.href=URL.createObjectURL(B.results[0].blob);a.download=B.results[0].name;a.click();setTimeout(()=>URL.revokeObjectURL(a.href),1000);return;}
  const zip=new JSZip();
  B.results.forEach(r=>zip.file(r.name,r.blob));
  // ★ Phase 10: EPUB은 이미 ZIP 압축 파일 → STORE (DEFLATE 재압축은 CPU만 쓰고 크기는 거의 그대로)
  const blob=await zip.generateAsync({type:'blob',compression:'STORE'});
  const a=document.createElement('a');a.href=URL.createObjectURL(blob);a.download='epub_일괄변환.zip';a.click();
  setTimeout(()=>URL.revokeObjectURL(a.href),1000);
}

// ════════════════════════════════════════════════
// ⚡ Module: ParserWorker — 대용량(10만 줄+) 파싱 전용 Blob Worker
// ★ Worker 소스는 parser.js buildParserWorkerSource()가 생성 (패턴·파싱 로직 단일 소유)
//   → 이전의 인라인 복사본(PATS·bestPat·splitChaptersWorkerDetailed) 제거
// ★ new Blob([코드]) → URL.createObjectURL → new Worker(url) → 즉시 revoke
// ════════════════════════════════════════════════
let _parserWorker=null;               // 지연 생성되는 파싱 Worker 인스턴스
const _workerCallbacks=new Map();     // 요청 id → {resolve, reject}
let _workerIdCounter=0;               // 요청 id 시퀀스

function createParserWorker(){
  const blob=new Blob([buildParserWorkerSource()],{type:'application/javascript'});
  const url=URL.createObjectURL(blob);
  try{
    return new Worker(url);
  }finally{
    URL.revokeObjectURL(url);
  }
}


function getParserWorker(){
  if(!_parserWorker){
    _parserWorker=createParserWorker();
    _parserWorker.onmessage=function(e){
      const{type,id,result,error,pct,msg}=e.data;
      if(type==='PROGRESS'){
        setProgress(pct,msg);
        return;
      }
      const cb=_workerCallbacks.get(id);
      if(!cb) return;
      _workerCallbacks.delete(id); // ★ B-FIX-03: 응답 즉시 Map에서 제거 → 콜백 재사용 방지
      if(type==='DONE') cb.resolve(result);
      else cb.reject(new Error(error||'Worker 오류'));
    };
    _parserWorker.onerror=function(e){
      // ★ B-FIX-03: onerror 시 모든 대기 콜백 reject 후 Map 초기화
      for(const[,cb]of _workerCallbacks){
        cb.reject(new Error('Worker 오류: '+(e.message||'unknown')));
      }
      _workerCallbacks.clear();
      _parserWorker=null; // 재생성 허용
    };
  }
  return _parserWorker;
}

// ★ 파싱 Worker 강제 종료 — splitChapters는 동기 루프라 메시지(ABORT)로는 멈출 수 없으므로 terminate
//   대기 중인 요청은 모두 reject (startConvert는 _convertAborted 플래그로 조용히 종료)
function terminateParserWorker(reason){
  if(_parserWorker){
    _parserWorker.terminate();
    _parserWorker=null;
  }
  for(const[,cb]of _workerCallbacks){
    cb.reject(new Error(reason||'파싱 중단'));
  }
  _workerCallbacks.clear();
}

/**
 * Worker 기반 splitChapters (비동기)
 * 10만 줄 이상 파일에서 메인 스레드 블로킹 없음
 */
async function splitChaptersAsync(raw, customPat, onProgress, opts={}){
  const lineCount=_countLines(raw);

  if(lineCount<100000){
    // 소형 파일: 동기 처리 (Worker 오버헤드 없음)
    return splitChapters(raw, customPat, opts);
  }

  onProgress&&onProgress(8,'② 대용량 파일 — Worker 파싱 시작...');

  return new Promise((resolve,reject)=>{
    const id=++_workerIdCounter;
    _workerCallbacks.set(id,{resolve,reject});

    // ★ 타임아웃: Worker가 응답 없이 채널이 닫히는 경우 방지 (2분)
    const timer=setTimeout(()=>{
      if(_workerCallbacks.has(id)){
        _workerCallbacks.delete(id);
        // ★ Phase 10: 응답 없는 Worker는 종료한 뒤 동기 폴백 (이전: Worker가 계속 CPU를 쓰는 채로 메인 스레드도 파싱)
        //   terminateParserWorker는 남은 콜백을 모두 reject — 이 요청은 위에서 이미 제거됨
        terminateParserWorker('파싱 타임아웃');
        try{resolve(splitChapters(raw,customPat,opts));}
        catch(e){reject(new Error('파싱 타임아웃: '+e.message));}
      }
    }, 120000);

    try{
      const worker=getParserWorker();
      // ★ 원본 콜백을 타이머 정리 포함 버전으로 래핑
      const orig=_workerCallbacks.get(id);
      _workerCallbacks.set(id,{
        // ★ Worker 안에는 Toast가 없으므로 화수 도약 경고는 결과 수신 후 메인 스레드에서 표시
        resolve:(r)=>{ clearTimeout(timer); _warnIndexJump(r); orig.resolve(r); },
        reject: (e)=>{ clearTimeout(timer); orig.reject(e); }
      });
      worker.postMessage({type:'SPLIT',payload:{raw,customPat,opts},id});
    }catch(e){
      clearTimeout(timer);
      _workerCallbacks.delete(id);
      // Worker 실패 시 동기 폴백
      try{resolve(splitChapters(raw,customPat,opts));}catch(e2){reject(e2);}
    }
  });
}

/**
 * ★ Phase 10: 미리보기용 목차 감지 — 10만 줄 이상은 파싱 Worker에서 (메인 스레드 멈춤 방지)
 * @returns {Promise<object|null>} detectToc 결과 · 사용자 중단 시 null
 */
async function detectTocAsync(lines, text, opts={}){
  if(!Array.isArray(lines)||lines.length<100000||typeof Worker==='undefined') return detectToc(lines, opts);
  return new Promise(resolve=>{
    const id=++_workerIdCounter;
    const fallback=()=>{ try{ resolve(detectToc(lines, opts)); }catch(e){ resolve(null); } };
    const timer=setTimeout(()=>{
      if(_workerCallbacks.has(id)){ _workerCallbacks.delete(id); terminateParserWorker('감지 타임아웃'); fallback(); }
    },120000);
    _workerCallbacks.set(id,{
      resolve:r=>{ clearTimeout(timer); resolve(r); },
      // 사용자 중단(변환 중단 버튼)은 조용히 종료, 그 밖의 Worker 오류는 메인 스레드로 다시 감지
      reject:e=>{ clearTimeout(timer); if(/중단/.test(String(e?.message||''))) resolve(null); else fallback(); },
    });
    try{
      getParserWorker().postMessage({type:'DETECT', payload:{raw:text, opts}, id});
    }catch(e){
      clearTimeout(timer); _workerCallbacks.delete(id); fallback();
    }
  });
}

// ── DOMContentLoaded에 폰트 패널 초기화 추가 ──
async function resetAll(){
  if(!await Toast.confirm('모든 설정을 초기화할까요?')) return;
  _sStore.set({txtFiles:[],coverFile:null,illFiles:[],tocItems:[],epubBlob:null,epubName:'',manualCnt:0,_coverAuto:false});
  _chaptersCache=null;_chaptersCacheKey='';
  clearTextCache();   // ★ Phase 10
  document.getElementById('txtDz').className='dz';
  document.getElementById('illDz').className='dz';
  document.getElementById('coverDz')?.classList.remove('ok'); // className 덮어쓰기 금지 — dz-compact 유지
  const _ct=document.getElementById('coverThumb'); if(_ct) _ct.innerHTML=COVER_THUMB_EMPTY_HTML;
  document.getElementById('coverName').textContent='';
  document.getElementById('txtInfo').style.display='none';
  document.getElementById('illTags').innerHTML='';
  document.getElementById('manualIlls').innerHTML='';
  ['title','author','series','seriesIdx','pattern'].forEach(id=>{ const el=document.getElementById(id); if(el) el.value=''; });
  ['tocPanel','progWrap','resultBox','errBox'].forEach(id=>document.getElementById(id)?.classList.remove('show'));
}

// ★ 탭별 렌더링 지연 플래그 (최초 1회만 렌더링)
function resetBatchTxt(){
  _bStore.set({txtFiles:[],patterns:{},sampleTexts:{},totalChs:{},splitModes:{}});
  const dz=document.getElementById('batchTxtDrop');
  dz.className='dz';dz.querySelector('.dz-text').textContent='TXT 파일 여러 개 드래그하거나 클릭';
  document.getElementById('batchList').innerHTML='';
  document.getElementById('batchListSec').style.display='none';
  if(!Object.keys(B.coverMap).length&&!B.urlCoverFile) document.getElementById('batchResetBar').style.display='none';
}
function resetBatchCover(){
  _bStore.set({coverMap:{},urlCoverFile:null});
  const dz=document.getElementById('batchCoverDrop');
  dz.className='dz';dz.querySelector('div').textContent='표지 이미지들 한꺼번에 드래그';
  document.getElementById('batchCoverUrlInp').value='';
  renderBatchList();
}
async function resetBatchAll(){
  if(!await Toast.confirm('일괄 변환 탭의 모든 파일을 초기화할까요?')) return;
  resetBatchTxt();resetBatchCover();
  _bStore.set({batchSplit:{enabled:false,template:'{N}화'}});   // ★ v3: 전역 간격 분할 토글도 해제
  _syncBatchSplitControls();
  document.getElementById('batchResetBar').style.display='none';
  ['batchProgWrap','batchResultBox','batchErrBox'].forEach(id=>{
    const el=document.getElementById(id);if(el)el.classList.remove('show');
  });
}

// ── EPUB 편집 탭 초기화 ──
function resetEditEpub(){
  _eStore.set({epubFile:null,epubZip:null,chapters:[],spineOrder:[],selectedChIdx:null,insTxtFiles:[],insTxtChapters:[],resultBlob:null,resultName:''});
  _eiStore.set({files:[],manualRows:0});
  document.getElementById('epubDrop').className='epub-drop';
  document.getElementById('epubInfo').style.display='none';
  document.getElementById('epubInfo').textContent='';
  const eb=document.getElementById('extractImgBar');if(eb)eb.style.display='none';
  const ep=document.getElementById('extractImgProgress');if(ep)ep.style.display='none';
  ['editSec','insertSec','editIllSec','insTocSec','insIllSec'].forEach(id=>{const el=document.getElementById(id);if(el)el.style.display='none';});
  document.getElementById('editResetBar').style.display='none';
  renderEditIllTags();
  typeof resetDirectEditToc==='function'&&resetDirectEditToc();
}
async function resetEditAll(){
  if(!await Toast.confirm('EPUB 편집 탭을 전부 초기화할까요?')) return;
  resetEditEpub();
}

// ════ 결과 stat 카드 렌더링 (최적화 5) ════
// ════════════════════════════════════════════════════════════
// ★ Phase 16: 작업 복원 — 변환 탭의 TXT 파일·목차 편집·메타데이터·표지를 IndexedDB(SettingsDB)에 자동 저장
//   새로고침·탭 닫힘 후 다시 열면 '이전 작업을 이어서 할까요?' 확인 → 파일을 다시 넣고 편집한 목차까지 복원
//   File 객체는 IndexedDB에 그대로 저장 가능(구조화 복제). 합계 300MB 초과·저장 실패는 조용히 건너뜀
// ════════════════════════════════════════════════════════════
const _SESSION_KEY='session_v1';
const _SESSION_MAX_BYTES=300*1024*1024;
let _sessionTimer=null, _sessionRestoring=false, _sessionTocEdited=false;

function scheduleSessionSave(opts={}){
  if(opts.tocEdited) _sessionTocEdited=true;
  if(_sessionRestoring||typeof SettingsDB==='undefined') return;
  clearTimeout(_sessionTimer);
  _sessionTimer=setTimeout(_saveSessionNow, 800);
}

async function _saveSessionNow(){
  try{
    if(!S.txtFiles.length){ await SettingsDB.remove(_SESSION_KEY); return; }
    const total=S.txtFiles.reduce((s,f)=>s+(f.size||0),0)+(S.coverFile?.size||0);
    if(total>_SESSION_MAX_BYTES) return;
    const val=id=>document.getElementById(id)?.value||'';
    await SettingsDB.set(_SESSION_KEY, {
      v:1, savedAt:Date.now(),
      files:[...S.txtFiles],
      tocItems:_sessionTocEdited?JSON.parse(JSON.stringify(S.tocItems||[])):null,
      meta:{title:val('title'), author:val('author'), series:val('series'), seriesIdx:val('seriesIdx'), pattern:val('pattern')},
      cover:(S.coverFile instanceof Blob)?S.coverFile:null,
    });
  }catch(e){ console.warn('[session] 저장 실패:', e?.name||e); }
}

function _timeAgo(ts){
  const m=Math.round((Date.now()-ts)/60000);
  if(m<1) return '방금';
  if(m<60) return m+'분 전';
  const h=Math.round(m/60);
  return h<24?h+'시간 전':Math.round(h/24)+'일 전';
}

// 앱 시작 시 1회 — 파일이 이미 있거나(.txt로 실행) 저장된 작업이 없으면 아무것도 하지 않음
async function offerSessionRestore(){
  if(typeof SettingsDB==='undefined') return;
  let ses=null;
  try{ ses=await SettingsDB.get(_SESSION_KEY); }catch(e){ return; }
  if(!ses||!Array.isArray(ses.files)||!ses.files.length) return;
  if(window.__launchedWithFiles||S.txtFiles.length) return;
  const desc=ses.files.length+'개 파일'+(ses.tocItems?.length?' · 목차 편집 포함':'')+' · '+_timeAgo(ses.savedAt||Date.now());
  const ok=await Toast.confirm('이전 작업을 이어서 할까요? ('+desc+')');
  if(!ok){ SettingsDB.remove(_SESSION_KEY).catch(()=>{}); return; }
  await restoreSession(ses);
}

async function restoreSession(ses){
  _sessionRestoring=true;
  try{
    typeof switchPage==='function'&&switchPage('convert');
    handleTxt(ses.files, false);
    if(ses.cover instanceof Blob){
      const cf=ses.cover instanceof File?ses.cover:new File([ses.cover],'cover.jpg',{type:ses.cover.type||'image/jpeg'});
      handleCover([cf]);
    }
    // 자동 목차 감지(previewToc)가 끝날 때까지 기다린 뒤 편집한 목차·메타 덮어쓰기
    const t0=Date.now();
    while(!S.tocItems.length&&Date.now()-t0<15000) await new Promise(r=>setTimeout(r,150));
    if(Array.isArray(ses.tocItems)&&ses.tocItems.length){
      S.tocItems=ses.tocItems;
      _sessionTocEdited=true;
      typeof _tocTouch==='function'&&_tocTouch();
      typeof renderTocItems==='function'&&renderTocItems();
      typeof updateTocStat==='function'&&updateTocStat();
      typeof updateTocEditBanner==='function'&&updateTocEditBanner();
    }
    const m=ses.meta||{};
    ['title','author','series','seriesIdx','pattern'].forEach(id=>{
      const el=document.getElementById(id);
      if(el&&typeof m[id]==='string'&&m[id]) el.value=m[id];
    });
    Toast.success('이전 작업을 복원했어요.');
  }catch(e){
    console.warn('[session] 복원 실패:', e);
    Toast.warn('이전 작업을 복원하지 못했어요.');
  }finally{
    _sessionRestoring=false;
    scheduleSessionSave();
  }
}

// 메타데이터 입력도 자동 저장 대상
function setupSessionAutosave(){
  ['title','author','series','seriesIdx','pattern'].forEach(id=>{
    document.getElementById(id)?.addEventListener('input', ()=>scheduleSessionSave());
  });
  setTimeout(()=>{ offerSessionRestore(); }, 700);   // launchQueue(.txt로 실행)가 먼저 처리되도록 잠시 뒤
}

function resetConvertTxt(){
  // ★ Phase 16: 저장된 작업도 함께 삭제
  _sessionTocEdited=false; clearTimeout(_sessionTimer);
  if(typeof SettingsDB!=='undefined') SettingsDB.remove(_SESSION_KEY).catch(()=>{});
  // ★ 목차·감지 상태도 함께 초기화 (이전: tocItems가 남아 자동 미리보기 OFF일 때 새 파일을 이전 목차로 자름)
  S.txtFiles=[];S._rawTextFull=[];S.tocItems=[];_tocDropLines=[];_chaptersCache=null;_chaptersCacheKey='';
  // ★ Phase 10: 목차 편집 UI 상태·디코딩 캐시·이전 변환 결과도 함께 정리
  _tocSelectedIdxs.clear(); _tocPendingTitleIdx=null; _tocFilterQ=''; _tocUndoStack.length=0;
  clearTextCache();
  _resetConvertResultUi();
  // ★ window 단일 소유권: 전역 분할 상태 완전 초기화
  window._autoSplitActive=false;
  window._autoSplitLines=null;
  window._fullRawLines=[];
  // DOM 잔재 정리
  document.getElementById('hybrid-suggest-btn')?.remove();
  document.getElementById('title-template-bar')?.remove();
  // ★ splitBtn 원상 복구 — _syncSplitBtn(parser.js)으로 단일 관리 (항상 정의돼 있어 폴백 분기 제거)
  _syncSplitBtn('reset');
  document.getElementById('txtDz').className='dz';
  // ★ UX-PD: 파일 리셋 → 목차 확인·간격 분할 버튼 비활성 표시 (.is-idle)
  document.getElementById('patSection')?.classList.add('is-idle');
  document.getElementById('txtInfo').style.display='none';
  const fl=document.getElementById('txtFileList'); if(fl){ fl.style.display='none'; fl.hidden=true; }
  const sl=document.getElementById('txtSortList'); if(sl) sl.innerHTML='';
  document.getElementById('tocPanel')?.classList.remove('show');
  ['title','author','series','seriesIdx','pattern'].forEach(id=>{const el=document.getElementById(id);if(el)el.value='';});
  document.getElementById('convertResetBar').style.display='none';
  const regexFeed=document.getElementById('regexFeed');if(regexFeed)regexFeed.style.display='none';
  // ★ Phase 16: 하단 바는 S.txtFiles=[] 구독 알림으로 갱신
}
function resetConvertCover(){
  S.coverFile=null;
  S._coverAuto=false;
  document.getElementById('coverDz')?.classList.remove('ok'); // className 덮어쓰기 금지 — dz-compact 유지
  const t=document.getElementById('coverThumb');
  if(t)t.innerHTML=COVER_THUMB_EMPTY_HTML;
  document.getElementById('coverName').textContent='';
  const inp=document.getElementById('coverUrlInp');if(inp)inp.value='';
}
async function resetConvertAll(){
  if(!await Toast.confirm('변환 탭의 모든 파일과 설정을 초기화할까요?')) return;
  resetConvertTxt();resetConvertCover();

  // ★ B-FIX-05: 대용량 상태 명시적 해제 → GC 수거 유도
  if(_sStore.get().tocItems && _sStore.get().tocItems.length > 0){
    _sStore.get().tocItems.length = 0;
  }
  _sStore.set({illFiles:[],tocItems:[],epubBlob:null,manualCnt:0});

  // ★ B-FIX-01: 초기화 시 _encCache도 정리 (+ Phase 10 디코딩 캐시)
  _encCache.clear();
  clearTextCache();

  // ★ PERF-GC: illTags 내 Blob URL 전체 해제 후 replaceChildren() — innerHTML 대비 GC 친화적
  const illTagsEl = document.getElementById('illTags');
  if(illTagsEl){
    illTagsEl.querySelectorAll('img[data-obj-url]').forEach(img => URL.revokeObjectURL(img.dataset.objUrl));
    illTagsEl.replaceChildren(); // innerHTML = '' 대신 — DOM 자식 분리 + 이벤트 핸들러 자동 GC
  }
  // manualIlls도 동일하게 처리
  const manualEl = document.getElementById('manualIlls');
  if(manualEl) manualEl.replaceChildren();

  document.getElementById('illDz').className='dz';
  ['progWrap','resultBox','errBox','splitSec'].forEach(id=>{
    const el=document.getElementById(id);
    if(el){el.classList.remove('show');if(id==='splitSec')el.style.display='none';}
  });
}
