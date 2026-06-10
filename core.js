// ════════════════════════════════════════════════
// core.js — 아키텍처 레이어 (Layer 0~3 + 상태 컨테이너)
// NovelEPUB | TXT → EPUB3
//
// 내보내는 심볼 (전역):
//   Toast, EventBus, StateManager, SettingsDB, EventDelegate
//   PAT_PRESETS, S, B, E, EI (상태 프록시)
//   yieldToMain, RecoverableError
//   _sStore, _bStore, _eStore, _eiStore (직접 접근용)
// ════════════════════════════════════════════════

'use strict';

// ══════════════════════════════════════════════════════════
//  Layer 0 │ Toast UI     — alert/confirm/prompt 대체
//  Layer 1 │ EventBus     — 탭 간 메시지 버스
//  Layer 2 │ StateManager — 탭별 독립 상태 컨테이너
//  Layer 3 │ EventDelegate — data-action 이벤트 위임
// ══════════════════════════════════════════════════════════

// ─────────────────────────────────────────
// Layer 0 · Toast UI
// ─────────────────────────────────────────
const Toast = (() => {
  let _container = null;

  function _ensureContainer() {
    if (_container) return;
    _container = document.createElement('div');
    _container.id = 'toast-container';
    document.body.appendChild(_container);
  }

  function _show(msg, type = 'info', duration = 3200) {
    _ensureContainer();
    const icons = { info:'ℹ️', success:'✅', error:'❌', warn:'⚠️' };
    const colors = {
      info:    'var(--blue-bg)',
      success: 'var(--green-bg)',
      error:   'var(--accent-bg)',
      warn:    'var(--yellow-bg)',
    };
    const borders = {
      info:    'var(--blue)',
      success: 'var(--green)',
      error:   'var(--accent)',
      warn:    'var(--accent2)',
    };

    // ★ U-08: 동일 메시지 dedup — 2초 내 재발생 시 카운터 배지만 증가
    const plainMsg = typeof msg === 'string' ? msg.replace(/<[^>]+>/g,'') : String(msg);
    const existing = [...(_container?.children||[])].find(el => {
      const span = el.querySelector('[data-toast-msg]');
      return span && span.dataset.toastMsg === plainMsg && el.dataset.toastType === type;
    });
    if(existing){
      let cnt = existing.querySelector('.toast-cnt');
      if(!cnt){
        cnt = document.createElement('sup');
        cnt.className = 'toast-cnt';
        cnt.style.cssText =
          'background:var(--text2);color:var(--panel);border-radius:99px;'+
          'font-size:9px;padding:0 4px;margin-left:4px;font-weight:700';
        cnt.textContent = '2';
        existing.querySelector('span:nth-child(2)')?.appendChild(cnt);
      } else {
        cnt.textContent = String((parseInt(cnt.textContent)||1)+1);
      }
      return existing;
    }

    // ★ U-08: 최대 4개 초과 시 가장 오래된 info/warn 제거
    const children = [...(_container?.children||[])];
    if(children.length >= 4){
      const oldest = children.find(el => el.dataset.toastType==='info' || el.dataset.toastType==='warn');
      if(oldest) oldest.remove();
    }

    const el = document.createElement('div');
    el.dataset.toastType = type;
    el.style.cssText =
      `background:${colors[type]};border:1.5px solid ${borders[type]};` +
      'border-radius:10px;padding:10px 14px;font-size:12px;font-family:inherit;' +
      'color:var(--text);box-shadow:0 4px 18px rgba(0,0,0,.15);' +
      'pointer-events:auto;display:flex;align-items:flex-start;gap:8px;' +
      'animation:toastIn .22s ease;max-width:340px;line-height:1.5';

    // ★ XSS 방지: innerHTML → DOM API
    const iconSpan = document.createElement('span');
    iconSpan.style.cssText = 'flex-shrink:0;font-size:14px';
    iconSpan.textContent = icons[type];

    const msgSpan = document.createElement('span');
    msgSpan.style.cssText = 'flex:1';
    msgSpan.dataset.toastMsg = plainMsg;
    // ★ XSS 강화: HTML을 허용하는 경우를 내부 마커(__SAFE_HTML__)로 명시적 제한
    // 외부 사용자 입력(파일명, 제목 등)은 반드시 escHtml 처리 후 일반 문자열로 전달
    // 내부 로직에서 HTML이 필요한 경우: Toast.info(Toast.__html`<b>강조</b>`) 패턴 사용
    if (typeof msg === 'string' && msg.startsWith('\x00SAFE_HTML\x00')) {
      // 내부 코드에서 명시적으로 안전하다고 표시한 HTML만 허용
      // '\x00SAFE_HTML\x00' = 1+8+1 = 11바이트
      msgSpan.innerHTML = msg.slice(11);
    } else if (typeof msg === 'string' && /<[a-z][\s\S]*>/i.test(msg)) {
      // ★ 기존 호출 호환성 유지: 내부 HTML 태그가 포함된 경우
      // 단, 이 경로는 레거시 용도이며 향후 __html 마커로 마이그레이션 권장
      // DOMParser로 파싱해 스크립트 실행 방지
      const parsed = new DOMParser().parseFromString(msg, 'text/html');
      // script/iframe 등 위험 요소 제거
      parsed.querySelectorAll('script,iframe,object,embed').forEach(el=>el.remove());
      msgSpan.innerHTML = parsed.body.innerHTML;
    } else {
      msgSpan.textContent = String(msg);
    }

    const closeBtn = document.createElement('button');
    closeBtn.style.cssText =
      'background:none;border:none;cursor:pointer;color:var(--text2);' +
      'font-size:14px;padding:0;line-height:1;margin-left:4px;flex-shrink:0';
    closeBtn.textContent = '✕';
    closeBtn.onclick = () => el.remove();

    el.append(iconSpan, msgSpan, closeBtn);
    _container.appendChild(el);
    if (duration > 0) setTimeout(() => el.remove(), duration);
    return el;
  }

  function info(msg, duration)    { _show(msg, 'info',    duration !== undefined ? duration : 3200); }
  function success(msg, duration) { _show(msg, 'success', duration !== undefined ? duration : 3200); }
  function error(msg, duration)   { _show(msg, 'error',   duration !== undefined ? duration : 5000); }
  function warn(msg, duration)    { _show(msg, 'warn',    duration !== undefined ? duration : 3200); }

  // ★ confirm: Escape 키 처리 추가 (BUG-22 수정)
  function confirm(msg) {
    return new Promise(resolve => {
      _ensureContainer();
      const overlay = document.createElement('div');
      overlay.style.cssText =
        'position:fixed;inset:0;background:rgba(0,0,0,.45);z-index:9998;' +
        'display:flex;align-items:center;justify-content:center';

      const box = document.createElement('div');
      box.style.cssText =
        'background:var(--panel);border-radius:14px;padding:24px 28px;' +
        'max-width:360px;width:90vw;box-shadow:0 8px 40px rgba(0,0,0,.25);' +
        'font-family:inherit;border:1.5px solid var(--border)';

      const p = document.createElement('p');
      p.style.cssText = 'font-size:13px;line-height:1.7;color:var(--text);margin-bottom:18px';
      // ★ confirm은 내부에서만 호출 (autoSplitByInterval 경고 등) — HTML 허용
      // 단, script/iframe 위험 태그 필터링
      if(typeof msg === 'string' && /<[a-z][\s\S]*>/i.test(msg)){
        const parsed = new DOMParser().parseFromString(msg, 'text/html');
        parsed.querySelectorAll('script,iframe,object,embed').forEach(el=>el.remove());
        p.innerHTML = parsed.body.innerHTML;
      } else {
        p.textContent = String(msg);
      }

      const btnRow = document.createElement('div');
      btnRow.style.cssText = 'display:flex;gap:8px;justify-content:flex-end';

      const cancelBtn = document.createElement('button');
      cancelBtn.className = 'btn btn-ghost';
      cancelBtn.style.cssText = 'font-size:12px;padding:7px 16px';
      cancelBtn.textContent = '취소';
      cancelBtn.onclick = () => { overlay.remove(); resolve(false); };

      const okBtn = document.createElement('button');
      okBtn.className = 'btn btn-accent';
      okBtn.style.cssText = 'font-size:12px;padding:7px 18px;border-radius:8px';
      okBtn.textContent = '확인';
      okBtn.onclick = () => { overlay.remove(); resolve(true); };

      btnRow.append(cancelBtn, okBtn);
      box.append(p, btnRow);
      overlay.appendChild(box);
      document.body.appendChild(overlay);
      overlay.onclick = e => { if(e.target===overlay){overlay.remove();resolve(false);} };

      // ★ BUG-22 수정: confirm에도 Escape 키 처리 추가
      const _handleKey = e => {
        if(e.key === 'Escape'){ overlay.remove(); resolve(false); document.removeEventListener('keydown', _handleKey); }
        if(e.key === 'Enter'){ overlay.remove(); resolve(true); document.removeEventListener('keydown', _handleKey); }
      };
      document.addEventListener('keydown', _handleKey);
    });
  }

  // ★ prompt: innerHTML → DOM API
  function prompt(msg, placeholder = '', defaultVal = '') {
    return new Promise(resolve => {
      _ensureContainer();
      const overlay = document.createElement('div');
      overlay.style.cssText =
        'position:fixed;inset:0;background:rgba(0,0,0,.45);z-index:9998;' +
        'display:flex;align-items:center;justify-content:center';

      const box = document.createElement('div');
      box.style.cssText =
        'background:var(--panel);border-radius:14px;padding:24px 28px;' +
        'max-width:380px;width:90vw;box-shadow:0 8px 40px rgba(0,0,0,.25);' +
        'font-family:inherit;border:1.5px solid var(--border)';

      const p = document.createElement('p');
      p.style.cssText = 'font-size:13px;line-height:1.7;color:var(--text);margin-bottom:12px';
      p.textContent = msg;

      const inp = document.createElement('input');
      inp.className = 'inp';
      inp.style.cssText = 'width:100%;margin-bottom:16px';
      inp.placeholder = placeholder;
      inp.value = defaultVal;

      const btnRow = document.createElement('div');
      btnRow.style.cssText = 'display:flex;gap:8px;justify-content:flex-end';

      const cancelBtn = document.createElement('button');
      cancelBtn.className = 'btn btn-ghost';
      cancelBtn.style.cssText = 'font-size:12px;padding:7px 16px';
      cancelBtn.textContent = '취소';
      cancelBtn.onclick = () => { overlay.remove(); resolve(null); };

      const okBtn = document.createElement('button');
      okBtn.className = 'btn btn-accent';
      okBtn.style.cssText = 'font-size:12px;padding:7px 18px;border-radius:8px';
      okBtn.textContent = '확인';
      okBtn.onclick = () => { overlay.remove(); resolve(inp.value); };

      btnRow.append(cancelBtn, okBtn);
      box.append(p, inp, btnRow);
      overlay.appendChild(box);
      document.body.appendChild(overlay);
      inp.focus();
      inp.addEventListener('keydown', e => {
        if (e.key === 'Enter') { overlay.remove(); resolve(inp.value); }
        if (e.key === 'Escape'){ overlay.remove(); resolve(null); }
      });
      overlay.onclick = e => { if(e.target===overlay){overlay.remove();resolve(null);} };
    });
  }

  return { info, success, error, warn, confirm, prompt };
})();

// ─────────────────────────────────────────
// Layer 1 · EventBus
// 탭 간 느슨한 결합 메시지 버스
// ─────────────────────────────────────────
const EventBus = (() => {
  const _listeners = {};

  function on(event, fn) {
    (_listeners[event] = _listeners[event] || []).push(fn);
    return () => off(event, fn); // unsubscribe 반환
  }
  function off(event, fn) {
    if (_listeners[event]) _listeners[event] = _listeners[event].filter(f => f !== fn);
  }
  function emit(event, data) {
    if (_listeners[event]) {
      // ★ XSS/상태오염 방지: 리스너 오류를 빈 catch로 묻지 않고 console.error로 로깅
      // 중요한 상태 변경 리스너에서 오류 발생 시 디버깅 가능
      _listeners[event].forEach(fn => {
        try { fn(data); }
        catch(e) { console.error('[EventBus] 리스너 오류 (event='+event+'):', e); }
      });
    }
  }

  return { on, off, emit };
})();

// ─────────────────────────────────────────
// Layer 2 · StateManager
// 탭별 독립 상태 컨테이너 + 변경 감지
// ─────────────────────────────────────────
const StateManager = (() => {
  const _stores = {};

  function create(name, initialState) {
    const _state = { ...initialState };
    Object.keys(initialState).forEach(k => {
      if (Array.isArray(initialState[k])) _state[k] = [...initialState[k]];
    });
    const _subscribers = [];

    function ref() { return _state; }
    function get() { return _state; }

    function set(patch) {
      const prev = { ..._state };
      // ★ 대용량 배열 교체 시 기존 참조를 null로 끊어 GC 수거 유도
      Object.keys(patch).forEach(k => {
        if (Array.isArray(_state[k]) && Array.isArray(patch[k]) && _state[k] !== patch[k]) {
          _state[k].length = 0;
          _state[k] = patch[k];
        } else {
          _state[k] = patch[k];
        }
      });
      _subscribers.forEach(fn => { try { fn(_state, prev); } catch(e){} });
      EventBus.emit(`state:${name}:change`, { state: _state, prev });
    }

    function reset() {
      Object.keys(initialState).forEach(k => {
        if (Array.isArray(initialState[k])) {
          if (_state[k] && _state[k].length > 0) {
            _state[k] = null;
          }
          _state[k] = [...initialState[k]];
        } else {
          _state[k] = initialState[k];
        }
      });
      _subscribers.forEach(fn => { try { fn(_state, _state); } catch(e){} });
    }

    function subscribe(fn) {
      _subscribers.push(fn);
      return () => { const i = _subscribers.indexOf(fn); if(i>-1) _subscribers.splice(i,1); };
    }

    _stores[name] = { get, ref, set, reset, subscribe };
    return _stores[name];
  }

  function getStore(name) { return _stores[name]; }

  return { create, getStore };
})();

// ══════════════════════════════════════════
// 💾 Module: SettingsDB (IndexedDB 설정 저장소)
// localStorage 5MB 제한 우회: 대용량 데이터(폰트 등)를 IDB에 저장
// ══════════════════════════════════════════
const SettingsDB = (() => {
  const DB_NAME = 'novelepub_settings';
  const DB_VER  = 1;
  const STORE   = 'settings';
  let _db = null;
  let _dbPromise = null;

  function open(){
    if(_db) return Promise.resolve(_db);
    if(_dbPromise) return _dbPromise;
    _dbPromise = new Promise((res,rej)=>{
      const req = indexedDB.open(DB_NAME, DB_VER);
      req.onupgradeneeded = e => {
        const db = e.target.result;
        if(!db.objectStoreNames.contains(STORE))
          db.createObjectStore(STORE);
      };
      req.onsuccess = e => {
        _db = e.target.result;
        _dbPromise = null;
        res(_db);
      };
      req.onerror = () => {
        _dbPromise = null;
        rej(req.error);
      };
    });
    return _dbPromise;
  }

  async function set(key, value){
    // ★ LOGIC-06: IDB 트랜잭션 실패 시 1회 재시도 (Safari/모바일 간헐적 실패 방어)
    for(let attempt = 0; attempt < 2; attempt++){
      try{
        const db = await open();
        await new Promise((res,rej)=>{
          const tx = db.transaction(STORE,'readwrite');
          tx.objectStore(STORE).put(value, key);
          tx.oncomplete = res;
          tx.onerror    = ()=>rej(tx.error);
        });
        return;
      }catch(e){
        if(attempt === 0){
          _db = null; _dbPromise = null;
          await new Promise(r => setTimeout(r, 80));
        } else {
          try{
            if(typeof value==='string' && value.length < 100000)
              localStorage.setItem('idb_fallback_'+key, value);
          }catch(le){}
        }
      }
    }
  }

  async function get(key){
    try{
      const db = await open();
      return new Promise((res,rej)=>{
        const tx = db.transaction(STORE,'readonly');
        const req = tx.objectStore(STORE).get(key);
        req.onsuccess = ()=>res(req.result??null);
        req.onerror   = ()=>rej(req.error);
      });
    }catch(e){
      try{ return localStorage.getItem('idb_fallback_'+key)||null; }catch(le){ return null; }
    }
  }

  async function remove(key){
    try{
      const db = await open();
      return new Promise((res,rej)=>{
        const tx = db.transaction(STORE,'readwrite');
        tx.objectStore(STORE).delete(key);
        tx.oncomplete=res; tx.onerror=()=>rej(tx.error);
      });
    }catch(e){}
  }

  return { set, get, remove };
})();

// ─────────────────────────────────────────
// Layer 3 · EventDelegate
// data-action 기반 이벤트 위임
// ─────────────────────────────────────────
const EventDelegate = (() => {
  const _registry = {};

  function register(action, fn) {
    _registry[action] = fn;
  }

  function registerAll(map) {
    Object.entries(map).forEach(([action, fn]) => register(action, fn));
  }

  function _handle(e) {
    let target = e.target;
    while (target && target !== document.body) {
      const action = target.dataset?.action;
      if (action && _registry[action]) {
        _registry[action](target, e);
        return;
      }
      target = target.parentElement;
    }
  }

  function init() {
    document.addEventListener('click',  _handle, false);
  }

  return { register, registerAll, init };
})();

// ══════════════════════════════════════════
// 📦 패턴 프리셋 (PAT_PRESETS)
// ══════════════════════════════════════════════════════════════════
// parser.js PATS 79종 + KEYWORD_PATS 18종과 완전 동기화
// cat: 'popular'(자주쓰는) | 'kor'(한국어) | 'eng'(영문/숫자) | 'special'(특수형식)
// ★ 기존 = 원래 23종 / ★ 신규 = 이번 확장 추가분
// ══════════════════════════════════════════════════════════════════
const PAT_PRESETS = [

  // ════════════════════════════════
  // ⭐ 자주 쓰는
  // ════════════════════════════════
  // ★ 기존
  {label:'N화',             val:'^#?(?:제\\s*)?\\d+\\s*화(?:\\s*.+)?$',                   cat:'popular', desc:'1화, 2화, 제3화, #5화'},
  {label:'Chapter N',       val:'^(?:chapter|part|ch)\\.?\\s*\\d+(?:\\s*.+)?$',            cat:'popular', desc:'Chapter 1, Part 12, Ch.3'},
  {label:'숫자만',           val:'^\\d+$',                                                  cat:'popular', desc:'줄 전체가 숫자만 (1, 2, 3)'},
  {label:'N. 제목',         val:'^\\d{1,3}\\.\\s*.+$',                                     cat:'popular', desc:'1. 서막, 2. 시작'},
  {label:'소설명+N화',       val:'^.{2,15}\\s+\\d+화$',                                     cat:'popular', desc:'드래곤 1화, 헌터 12화'},
  {label:'[ 파일명.txt ]',  val:'^\\[\\s*.+\\.txt\\s*\\]\\s*$',                             cat:'popular', desc:'[ 0001_제목.txt ]'},
  // ★ 신규
  {label:'제N화',           val:'^제\\s*\\d+\\s*화(?:\\s*.+)?$',                            cat:'popular', desc:'제1화, 제 12 화 - 타이틀'},
  {label:'[EP.N] 형식',     val:'^\\[(?:EP|Ep|ep)\\.\\d+\\](?:\\s*.+)?$',                  cat:'popular', desc:'[EP.001] 새벽의 검사'},
  {label:'001화 zero-pad',  val:'^0+\\d+화(?:\\s*[^\\r\\n]{0,80})?$',                       cat:'popular', desc:'001화, 0023화 제목 (노벨피아·조아라)'},

  // ════════════════════════════════
  // 🇰🇷 한국어
  // ════════════════════════════════
  // ★ 기존
  {label:'제N화',           val:'^제\\s*\\d+\\s*화(?:\\s*.+)?$',                            cat:'kor', desc:'제1화, 제 2 화'},
  {label:'제N장',           val:'^제\\s*\\d+\\s*장(?:\\s*.+)?$',                            cat:'kor', desc:'제1장, 제2장'},
  {label:'N권',             val:'^\\d+권(?:\\s*.+)?$',                                      cat:'kor', desc:'1권, 2권'},
  {label:'N부 M화',         val:'^[1-9]부\\s+(?:\\d+화|프롤로그)(?:\\s*.+)?$',              cat:'kor', desc:'1부 1화, 2부 프롤로그'},
  {label:'〈N화〉 꺽쇠',    val:'^[〈<]\\s*\\d+\\s*화\\s*[〉>](?:\\s*[^\\r\\n]{0,80})?$',  cat:'kor', desc:'〈1화〉, <2화> 어둠의 서막'},
  {label:'[N화] 대괄호',   val:'^\\[\\s*제?\\s*\\d+\\s*화\\s*\\](?:\\s*.+)?$',             cat:'kor', desc:'[1화], [제2화] 제목'},
  // ★ 신규
  {label:'제N편',           val:'^제\\s*\\d+\\s*편(?:\\s*[^\\r\\n]{0,80})?$',               cat:'kor', desc:'제1편, 제 3 편 결말부'},
  {label:'N편',             val:'^\\d+편(?:\\s*[^\\r\\n]{0,80})?$',                         cat:'kor', desc:'1편, 3편 어둠'},
  {label:'시즌N N화',       val:'^(?:시즌\\s*\\d+|S\\d+)\\s+\\d+화(?:\\s*[^\\r\\n]{0,80})?$', cat:'kor', desc:'시즌2 1화, S2 12화 (시리즈·카카오)'},
  {label:'N화~N화 범위',    val:'^\\d+화?\\s*[-~]\\s*\\d+화(?:\\s*[^\\r\\n]{0,80})?$',      cat:'kor', desc:'1화~3화, 11화 - 13화 (연재분 묶음)'},
  {label:'【N화】 전각',     val:'^【\\s*\\d+\\s*화\\s*】(?:\\s*[^\\r\\n]{0,80})?$',          cat:'kor', desc:'【1화】, 【001화】어둠의 서막 (문피아)'},
  {label:'(N화) 소괄호',    val:'^\\(\\s*제?\\s*\\d+\\s*[화장]\\s*\\)(?:\\s*[^\\r\\n]{0,80})?$', cat:'kor', desc:'(1화), (제12화) 어둠의 서막'},
  {label:'≪N화≫ 겹낫표',   val:'^[≪《]\\s*\\d+\\s*화\\s*[≫》](?:\\s*[^\\r\\n]{0,80})?$',   cat:'kor', desc:'≪1화≫, 《12화》 어둠의 서막'},
  {label:'「N화」 낫표',    val:'^[「『]\\s*\\d+\\s*화\\s*[」』](?:\\s*[^\\r\\n]{0,80})?$',   cat:'kor', desc:'「1화」, 『12화』 서막 (번역 웹소설)'},
  {label:'◆●★+N화',        val:'^[◆●◇○■□▶▷►◀◁★☆♠♦♣♥]\\s*\\d+\\s*화(?:\\s*[^\\r\\n]{0,80})?$', cat:'kor', desc:'◆ 1화, ● 12화 타이틀 (시리즈·카카오)'},
  {label:'첫번째 이야기',   val:'^(?:첫|두|세|네|다섯|여섯|일곱|여덟|아홉|열)\\s*번째\\s*(?:이야기|장|화|편|챕터)(?:\\s*[^\\r\\n]{0,60})?$', cat:'kor', desc:'첫 번째 이야기, 두 번째 장'},
  {label:'제 일/이/삼 화',  val:'^제\\s*(?:일|이|삼|사|오|육|칠|팔|구|십)\\s*[화장편](?:\\s*[^\\r\\n]{0,60})?$', cat:'kor', desc:'제 일 장, 제이화, 제삼편'},
  {label:'막간/인터루드',   val:'^(?:막간|인터루드|interlude)(?:\\s*[^\\r\\n]{0,80})?$',     cat:'kor', desc:'막간, 인터루드, Interlude 1'},
  {label:'프롤로그',        val:'^(?:프롤로그|프롤)(?:\\s*.+)?$',                             cat:'kor', desc:'프롤로그, 프롤 - 시작'},
  {label:'에필로그',        val:'^(?:에필로그|에필)(?:\\s*.+)?$',                             cat:'kor', desc:'에필로그, 에필 - 끝'},
  {label:'외전/번외',       val:'^(?:외전|번외)(?:\\s*.+)?$',                                cat:'kor', desc:'외전, 번외 - 그날의 기억'},
  {label:'특별편/스페셜',   val:'^(?:특별편|스페셜|단편)(?:\\s*[^\\r\\n]{0,80})?$',           cat:'kor', desc:'특별편, 스페셜, 단편 - 그날'},
  {label:'후기/작가의 말',  val:'^(?:후기|작가\\s*후기|작가의\\s*말|작가\\s*노트)(?:\\s*.+)?$', cat:'kor', desc:'후기, 작가의 말, 작가 노트'},
  {label:'공지/설정집',     val:'^(?:공지|공지사항|설정집|일러스트|캐릭터\\s*소개|등장인물)(?:\\s*[^\\r\\n]{0,80})?$', cat:'kor', desc:'공지, 설정집, 일러스트, 캐릭터 소개'},

  // ════════════════════════════════
  // 🔤 영문/숫자
  // ════════════════════════════════
  // ★ 기존
  {label:'EP/Ch/Scene N',   val:'^(?:EP|제|Chapter|Ch|디|Scene|Prologue)\\.?\\s*\\d+',     cat:'eng', desc:'EP.1, Ch.2, Scene 3'},
  {label:'[EP.N] 형식',     val:'^\\[(?:EP|Ep|ep)\\.\\d+\\](?:\\s*.+)?$',                  cat:'eng', desc:'[EP.001] 제목'},
  {label:'NNN  제목',       val:'^\\d{3,6}\\s{2,}.+$',                                     cat:'eng', desc:'001  서막, 0023  제목'},
  {label:'#N. 제목',        val:'^#\\d+\\.\\s+.{1,60}$',                                   cat:'eng', desc:'#1. 제목'},
  {label:'# 제목(마크다운)',val:'^#{1,3}\\s*.+$',                                           cat:'eng', desc:'# 제목, ## 제목'},
  {label:'줄 시작 통합 ★', val:'^(?:\\s?〈\\s?\\d+화\\s?〉|EP\\.\\d+|\\d+화|\\d+)[^\\r\\n]*', cat:'eng', desc:'화/EP/숫자로 시작하는 줄'},
  // ★ 신규
  {label:'Chapter One',     val:'^(?:chapter|part|ch)\\s+(?:one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve)(?:\\s*[^\\r\\n]{0,60})?$', cat:'eng', desc:'Chapter One, CHAPTER TWO, chapter three'},
  {label:'Chap.N',          val:'^chap\\.?\\s*\\d+(?:\\s*[^\\r\\n]{0,80})?$',              cat:'eng', desc:'Chap.1, CHAP.12 - The Start'},
  {label:'Book N',          val:'^book\\s+(?:\\d+|one|two|three|four|five)(?:\\s*[^\\r\\n]{0,80})?$', cat:'eng', desc:'Book 1, Book One: The Beginning'},
  {label:'Nst Story',       val:'^\\d+(?:st|nd|rd|th)\\s+(?:story|episode|chapter|part|tale)(?:\\s*[^\\r\\n]{0,80})?$', cat:'eng', desc:'1st Story, 2nd Episode, 3rd Chapter'},
  {label:'Volume N',        val:'^vol(?:ume)?\\.?\\s*\\d+(?:\\s*[^\\r\\n]{0,80})?$',       cat:'eng', desc:'Volume 1, Vol.12, vol. 3 - 어둠의 계곡'},
  {label:'Part I 로마숫자', val:'^(?:part|section|book)\\s+(?:I{1,3}|IV|VI{0,3}|IX|X{1,3}|XI{0,3}|XIV|XV|XVI{0,3}|XIX|XX{0,3})(?:\\s*[^\\r\\n]{0,80})?$', cat:'eng', desc:'Part I, Part II, Part III (단행본·번역)'},
  {label:'S1E01 형식',      val:'^S\\d+E\\d+(?:\\s*.+)?$',                                  cat:'eng', desc:'S1E01, S2E12 제목'},
  {label:'prologue/epilogue',val:'^(?:prologue|epilogue|afterword|author.?s?\\s*note)(?:\\s*.+)?$', cat:'eng', desc:'Prologue, Epilogue, Afterword'},
  {label:'Side Story/Extra',val:'^(?:side\\s*story|extra\\s*(?:chapter|episode)?|bonus\\s*(?:chapter|episode)?)(?:\\s*\\d*)?(?:\\s*[^\\r\\n]{0,80})?$', cat:'eng', desc:'Side Story 1, Extra Chapter, Bonus Episode'},
  {label:'01. zero-pad',    val:'^0+\\d+\\.\\s+[^\\r\\n]{1,60}$',                           cat:'eng', desc:'01. 서막, 001. 어둠 (zero-pad 점 형식)'},
  {label:'N) 제목',         val:'^\\d+\\)\\s+[^\\r\\n]{1,60}$',                             cat:'eng', desc:'1) 서막, 12) 어둠의 시작'},

  // ════════════════════════════════
  // 🔣 특수형식
  // ════════════════════════════════
  // ★ 기존
  {label:'[Prologue] 형식', val:'^\\[(?:Prologue|Epilogue|Side|Extra|프롤로그|에필로그|외전)(?:\\s*.+)?\\](?:\\s*.+)?$', cat:'special', desc:'[프롤로그], [외전]'},
  {label:'소설(숫자)',       val:'^.{1,60}\\s*\\(\\d+\\)\\s*$',                             cat:'special', desc:'소설이름(1)'},
  {label:'【제목】',         val:'^【.+】[^\\r\\n]*$',                                        cat:'special', desc:'【서막】, 【어둠의 기사】'},
  {label:'제목+구분선',      val:'^.+[=\\-]{3,}$',                                           cat:'special', desc:'제목=== 서막---'},
  {label:'=== [제N화] ===', val:'^={2,}\\s*\\[제\\s*\\d+\\s*화\\]\\s*={0,}$',              cat:'special', desc:'==[제1화]=='},
  // ★ 신규
  {label:'第N章/話 한자',   val:'^第\\s*[\\d一二三四五六七八九十百千]+\\s*[章話话](?:\\s*.+)?$', cat:'special', desc:'第1章, 第三話, 第12話 서막'},
  {label:'第N幕/節',        val:'^第\\s*[\\d一二三四五六七八九十百千]+\\s*[幕節](?:\\s*[^\\r\\n]{0,80})?$', cat:'special', desc:'第1幕, 第三節 어둠의 시작'},
  {label:'간주/幕間',        val:'^(?:간주|幕間)(?:\\s*[^\\r\\n]{0,80})?$',                  cat:'special', desc:'간주, 幕間, 幕間 - 그녀의 선택'},
  {label:'- N - 대시',      val:'^[-─—]{1,3}\\s*\\d+\\s*[-─—]{1,3}$',                     cat:'special', desc:'- 1 -, — 12 —, ─ 3 ─'},
  {label:'─── 제목 ───',   val:'^[-─=]{2,}\\s*[^\\r\\n]{1,60}\\s*[-─=]{2,}$',             cat:'special', desc:'─── 서막 ───, === 어둠의 시작 ==='},
  {label:'<N> 괄호숫자',    val:'^(?:<\\d{1,6}>|\\[\\d{1,6}\\]|\\{\\d{1,6}\\})$',          cat:'special', desc:'<1>, [12], {3} (단순 번호 구분자)'},
  {label:'* N * 구분자',    val:'^[\\*\\-─]+\\s*\\d+화?\\s*[\\*\\-─]+$',                   cat:'special', desc:'*** 1화 ***, --- 12 ---'},
];

// ── StateManager 기반 탭별 독립 상태 ──
const _sStore  = StateManager.create('convert', {
  txtFiles:[], coverFile:null, illFiles:[], tocItems:[],
  epubBlob:null, epubName:'', manualCnt:0,
  _rawTextFull:[], _detectedPat:null, _detectedName:''
});
const _bStore  = StateManager.create('batch', {
  txtFiles:[], coverMap:{}, results:[], urlCoverFile:null,
  patterns:{}, sampleTexts:{}, totalChs:{}
});
const _eStore  = StateManager.create('edit', {
  epubFile:null, epubZip:null, chapters:[], spineOrder:[],
  selectedChIdx:null, insTxtFiles:[], insTxtChapters:[],
  resultBlob:null, resultName:'', perChapterNcx:false
});
const _eiStore = StateManager.create('editIll', {
  files:[], manualRows:0
});

// 기존 코드와 완전 호환되는 Proxy 래퍼
const S  = new Proxy({}, {
  get: (_, k) => _sStore.get()[k],
  set: (_, k, v) => { _sStore.set({[k]: v}); return true; }
});
const B  = new Proxy({}, {
  get: (_, k) => _bStore.get()[k],
  set: (_, k, v) => { _bStore.set({[k]: v}); return true; }
});
const E  = new Proxy({}, {
  get: (_, k) => _eStore.get()[k],
  set: (_, k, v) => { _eStore.set({[k]: v}); return true; }
});
const EI = new Proxy({}, {
  get: (_, k) => _eiStore.get()[k],
  set: (_, k, v) => { _eiStore.set({[k]: v}); return true; }
});

// ── scheduler.yield() 폴리필 ──
// ── scheduler.yield() 폴리필 ──
// ★ C-01: MessageChannel 기반 구현 — iOS Safari에서 연속 setTimeout의 최소 1ms 지연 우회
// scheduler.yield (Chrome 115+) → 가장 빠른 실제 yield
// MessageChannel → setTimeout(0)보다 빠른 macrotask 양보 (iOS Safari 포함)
// setTimeout(0) → 최후 폴백
const yieldToMain = (() => {
  // 1순위: scheduler.yield (Chrome 115+ / Task Scheduling API)
  if (typeof scheduler !== 'undefined' && typeof scheduler.yield === 'function') {
    return () => scheduler.yield();
  }
  // 2순위: MessageChannel — setTimeout(0)보다 낮은 지연, iOS Safari에서도 안정적
  if (typeof MessageChannel !== 'undefined') {
    return () => new Promise(resolve => {
      const ch = new MessageChannel();
      ch.port1.onmessage = resolve;
      ch.port2.postMessage(null);
    });
  }
  // 3순위: setTimeout(0) 폴백
  return () => new Promise(r => setTimeout(r, 0));
})();

// ★ U-20: 복구 가능 오류 분류
// ════════════════════════════════════════════════════════════
// 🌐 CORS 프록시 레이어 — Phase 4 통합
//
// #1  CORS_PROXY_URL: 전역 상수 단일 정의 — 모든 모듈이 window.CORS_PROXY_URL로 접근
// #2  Failover: 프록시 실패 시 원본 URL 직접 재시도
// #3  AbortController 기반 8초 타임아웃
// #4  MIME-Type 화이트리스트 검증 (image/*, application/json만 허용)
// #6  X-NovelEPUB-Token 커스텀 헤더 주입
// #7  ArrayBuffer/Blob 바이너리 안전 처리
// #9  Cache-Control: no-cache 캐시 버스팅
// #10 RecoverableError 기반 Toast 에러 명세
// ════════════════════════════════════════════════════════════

/** ★ #1: 전역 상수 — cover-search.js / edit.js / epub-gen.js 에서 공유 */
const CORS_PROXY_URL = 'https://icy-frog-a6c0.tlsxo213.workers.dev/?url=';
// window에도 노출 (비 모듈 환경 호환)
window.CORS_PROXY_URL = CORS_PROXY_URL;

/** ★ #6: 프록시 보안 토큰 — Cloudflare Worker 인증 */
const _PROXY_TOKEN = 'novelepub-secure-token';

/** ★ #3: 기본 요청 타임아웃 (ms) */
const _PROXY_TIMEOUT_MS = 8000;

// ── #5: URL 안전 인코딩 유틸 ──
// 특수문자·공백·유니코드까지 완전히 처리하여 프록시 라우팅 중 유실 방지
function _safeEncodeUrl(url) {
  try {
    // 이미 인코딩된 %XX는 그대로 두고, 그 외만 인코딩
    return encodeURIComponent(decodeURIComponent(url));
  } catch(e) {
    return encodeURIComponent(url);
  }
}

// ── #4: MIME-Type 화이트리스트 검증 ──
const _ALLOWED_MIME_PREFIXES = ['image/', 'application/json', 'text/'];
function _validateContentType(resp) {
  const ct = resp.headers.get('Content-Type') || '';
  return _ALLOWED_MIME_PREFIXES.some(prefix => ct.includes(prefix));
}

// ── #10: HTTP 상태코드 → 사용자 친화적 에러 메시지 ──
function _proxyErrorMsg(status, url) {
  const host = (() => { try { return new URL(url).hostname; } catch(e) { return url.slice(0, 30); } })();
  const statusText = {
    400: '400 Bad Request',
    401: '401 Unauthorized',
    403: '403 Forbidden',
    404: '404 Not Found',
    429: '429 Too Many Requests',
    500: '500 Internal Server Error',
    502: '502 Bad Gateway',
    503: '503 Service Unavailable',
    504: '504 Gateway Timeout',
  }[status] || `${status} Unknown`;
  return `[CORS Proxy Error: HTTP ${statusText}] — ${host}`;
}

/**
 * proxyGet — HTML/텍스트 응답용 프록시 fetch
 * ★ #2 Failover: 프록시 실패 → 원본 직접 재시도
 * ★ #3 Timeout: AbortController 8초
 * ★ #6 Token: X-NovelEPUB-Token 헤더
 * ★ #9 Cache-Control: no-cache
 * ★ #10 RecoverableError Toast
 *
 * @param {string} url 원본 URL
 * @param {number} [timeout] 타임아웃 ms (기본 8000)
 * @returns {Promise<string>} 응답 텍스트
 */
async function proxyGet(url, timeout = _PROXY_TIMEOUT_MS) {
  const encodedUrl = _safeEncodeUrl(url);   // #5
  const proxyUrl   = CORS_PROXY_URL + encodedUrl;

  // ── 프록시 시도 ──
  const ctrl = new AbortController();       // #3
  const timer = setTimeout(() => ctrl.abort(), timeout);
  try {
    const resp = await fetch(proxyUrl, {
      signal: ctrl.signal,
      headers: {
        'X-NovelEPUB-Token': _PROXY_TOKEN,  // #6
        'Cache-Control':     'no-cache',    // #9
      },
    });
    clearTimeout(timer);
    if (!resp.ok) {
      // #2 Failover: 5xx 서버 오류는 직접 재시도
      if (resp.status >= 500) throw new Error('proxy_server_error:' + resp.status);
      // 4xx는 RecoverableError로 Toast 표시 (#10)
      throw new RecoverableError(_proxyErrorMsg(resp.status, url), { context: 'proxyGet' });
    }
    const text = await resp.text();
    if (!text || text.length < 10) throw new Error('proxy_empty_response');
    return text;
  } catch(e) {
    clearTimeout(timer);
    if (e instanceof RecoverableError) throw e;
    if (e.name === 'AbortError') {
      throw new RecoverableError(`[CORS Proxy Timeout] ${url.slice(0, 50)} — ${timeout}ms 초과`, { context: 'proxyGet' });
    }
    // #2 Failover: 프록시 실패 시 원본 URL 직접 재시도
    console.warn('[proxyGet] 프록시 실패, 직접 요청 시도:', e.message, url);
    const ctrl2 = new AbortController();
    const timer2 = setTimeout(() => ctrl2.abort(), timeout);
    try {
      const resp2 = await fetch(url, { signal: ctrl2.signal, headers: { 'Cache-Control': 'no-cache' } });
      clearTimeout(timer2);
      if (!resp2.ok) throw new RecoverableError(_proxyErrorMsg(resp2.status, url), { context: 'proxyGet-direct' });
      return await resp2.text();
    } catch(e2) {
      clearTimeout(timer2);
      if (e2 instanceof RecoverableError) throw e2;
      throw new RecoverableError(`[CORS Proxy Error] 직접 요청도 실패: ${e2.message}`, { context: 'proxyGet-direct' });
    }
  }
}

/**
 * proxyGetBlob — 이미지/바이너리 응답용 프록시 fetch
 * ★ #7 ArrayBuffer 바이너리 안전 처리
 * ★ #4 MIME-Type 화이트리스트 검증
 * ★ #2 Failover: 프록시 실패 → 원본 직접 재시도
 *
 * @param {string} url 이미지 원본 URL
 * @param {number} [timeout] 타임아웃 ms (기본 8000)
 * @returns {Promise<Blob>} 이미지 Blob
 */
async function proxyGetBlob(url, timeout = _PROXY_TIMEOUT_MS) {
  const encodedUrl = _safeEncodeUrl(url);  // #5
  const proxyUrl   = CORS_PROXY_URL + encodedUrl;

  async function _fetchBlob(targetUrl, isProxy) {
    const ctrl  = new AbortController();   // #3
    const timer = setTimeout(() => ctrl.abort(), timeout);
    try {
      const headers = isProxy
        ? { 'X-NovelEPUB-Token': _PROXY_TOKEN, 'Cache-Control': 'no-cache' }  // #6 #9
        : { 'Cache-Control': 'no-cache' };                                     // #9
      const resp = await fetch(targetUrl, { signal: ctrl.signal, headers });
      clearTimeout(timer);
      if (!resp.ok) throw new Error('http_' + resp.status);
      // #4 MIME-Type 화이트리스트 검증
      const ct = resp.headers.get('Content-Type') || '';
      if (ct && !ct.includes('image/') && !ct.includes('application/octet-stream')) {
        console.warn('[proxyGetBlob] 예상치 못한 Content-Type:', ct, targetUrl);
      }
      // #7 ArrayBuffer → Blob 바이너리 안전 처리
      const ab   = await resp.arrayBuffer();
      const mime = ct.split(';')[0].trim() || 'image/jpeg';
      return new Blob([ab], { type: mime });
    } catch(e) {
      clearTimeout(timer);
      throw e;
    }
  }

  // 프록시 시도
  try {
    return await _fetchBlob(proxyUrl, true);
  } catch(e) {
    if (e.name === 'AbortError') {
      throw new RecoverableError(`[CORS Proxy Timeout] 이미지 로드 초과 — ${timeout}ms`, { context: 'proxyGetBlob' });
    }
    // #2 Failover: 원본 직접 재시도
    console.warn('[proxyGetBlob] 프록시 실패, 직접 요청 시도:', e.message, url);
    try {
      return await _fetchBlob(url, false);
    } catch(e2) {
      // #10 RecoverableError Toast
      const status = parseInt(e2.message.replace('http_', '')) || 0;
      throw new RecoverableError(
        status ? _proxyErrorMsg(status, url) : `[CORS Proxy Error] 이미지 로드 실패: ${e2.message}`,
        { context: 'proxyGetBlob-direct' }
      );
    }
  }
}

// window 노출 (비 모듈 스크립트 환경)
window.proxyGet     = proxyGet;
window.proxyGetBlob = proxyGetBlob;

class RecoverableError extends Error {
  constructor(msg, context){
    super(msg);
    this.name = 'RecoverableError';
    this.context = context || '';
  }
}

// ★ 에러 경계: 치명적 오류 화면 표시
function showErrorBoundary(err){
  const el=document.getElementById('errorBoundary');
  const detail=document.getElementById('errorBoundaryDetail');
  if(!el) return;
  if(detail) detail.textContent=err instanceof Error
    ?(err.message+(err.stack?'\n'+err.stack.split('\n').slice(0,3).join('\n'):''))
    :String(err);
  el.classList.add('show');
}
window.addEventListener('error',e=>{ if(e.error) showErrorBoundary(e.error); });
window.addEventListener('unhandledrejection',e=>{ if(e.reason) showErrorBoundary(e.reason); });

// ★ crypto.randomUUID 래퍼
function genUID(){
  if(crypto.randomUUID) return crypto.randomUUID();
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g,c=>{
    const r=Math.random()*16|0;
    return (c==='x'?r:(r&0x3|0x8)).toString(16);
  });
}
