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
    // ★ HTML 허용: 내부 로직(I9 delta 배지 등)에서만 HTML 사용
    // 외부 사용자 입력(파일명 등)은 반드시 textContent로 처리할 것
    if (/<[a-z][\s\S]*>/i.test(msg) && typeof msg === 'string') {
      // 내부 생성 HTML만 허용 (외부 입력 경로는 별도 처리)
      msgSpan.innerHTML = msg;
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
      p.textContent = msg; // ★ XSS 방지

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
      _listeners[event].forEach(fn => { try { fn(data); } catch(e) {} });
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
// ══════════════════════════════════════════
const PAT_PRESETS = [
  {label:'[ 파일명.txt ] 형식', val:'^\\[\\s*.+\\.txt\\s*\\]\\s*$'},
  {label:'[EP.N] 형식',        val:'^\\[(?:EP|Ep|ep)\\.\\d+\\](?:\\s*.+)?$'},
  {label:'[Prologue] 형식',    val:'^\\[(?:Prologue|Epilogue|Side|Extra|프롤로그|에필로그|외전)(?:\\s*.+)?\\](?:\\s*.+)?$'},
  {label:'NNN  제목 형식',     val:'^\\d{3,6}\\s{2,}.+$'},
  {label:'〈N화〉 꺽쇠',          val:'^[〈<]\\s*(\\d+)\\s*화\\s*[〉>](?:\\s*([^\\r\\n]*))?$'},
  {label:'줄 시작 통합 ★',     val:'^(?:\\s?〈\\s?\\d+화\\s?〉|EP\\.\\d+|\\d+화|\\d+)[^\\r\\n]*'},
  {label:'화 번호 (#N화 포함)', val:'^#?(?:제\\s*)?\\d+\\s*화(?:\\s*.+)?$'},
  {label:'소설(숫자)',          val:'^.{1,60}\\s*\\(\\d+\\)\\s*$'},
  {label:'숫자만',              val:'^\\d+$'},
  {label:'Chapter N',          val:'^(?:chapter|part|ch)\\s*\\d+(?:\\s*.+)?$'},
  {label:'EP/Ch/Scene N',      val:'^(?:EP|제|Chapter|Ch|디|Scene|Prologue)\\.?\\s*\\d+'},
  {label:'N. 제목',            val:'^\\d{1,3}\\.\\s*.+$'},
  {label:'N권',                val:'^\\d+권(?:\\s*.+)?$'},
  {label:'제목+구분선',         val:'^.+[=\\-]{3,}$'},
  {label:'# 제목',             val:'^#{1,3}\\s*.+$'},
  {label:'【제목】',            val:'^【.+】[^\\r\\n]*$'},
  {label:'=== [제N화] ===',    val:'^={2,}\\s*\\[제\\s*\\d+\\s*화\\]\\s*={0,}$'},
  {label:'N부 M화',            val:'^[1-9]부\\s+(?:\\d+화|프롤로그)(?:\\s*.+)?$'},
  {label:'#N. 제목',           val:'^#\\d+\\.\\s+.{1,60}$'},
  {label:'소설명+N화',          val:'^.{2,15}\\s+\\d+화$'},
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
const yieldToMain = (typeof scheduler !== 'undefined' && scheduler.yield)
  ? () => scheduler.yield()
  : () => new Promise(r => setTimeout(r, 0));

// ★ U-20: 복구 가능 오류 분류
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
