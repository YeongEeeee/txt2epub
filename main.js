// ════════════════════════════════════════════════
// main.js — 흐름 제어 & 이벤트 바인딩
// NovelEPUB | TXT → EPUB3
//
// 의존성: parser.js, epub-gen.js, JSZip (CDN)
// 역할:
//   - Toast / EventBus / StateManager (아키텍처 레이어)
//   - 상태 관리 (S, B, E, EI)
//   - 이벤트 바인딩 및 UI 핸들러
//   - 변환/일괄/편집 플로우 제어
//   - localStorage 설정 저장/복원
// ════════════════════════════════════════════════

'use strict';
// ══════════════════════════════════════════════════════════
// ██████╗ ██████╗ ██████╗ ██████╗
// ██╔══██╗██╔══██╗██╔══██╗██╔══██╗
// ██████╔╝██████╔╝██████╔╝██████╔╝  아키텍처 레이어
// ██╔═══╝ ██╔══██╗██╔══╝  ██╔══██╗
// ██║     ██║  ██║███████╗██████╔╝
// ╚═╝     ╚═╝  ╚═╝╚══════╝╚═════╝
// ──────────────────────────────────────────────────────────
//  Layer 0 │ Toast UI     — alert/confirm/prompt 대체
//  Layer 1 │ EventBus     — 탭 간 메시지 버스
//  Layer 2 │ StateManager — 탭별 독립 상태 컨테이너
//  Layer 3 │ EventDelegate — data-action 이벤트 위임
// ══════════════════════════════════════════════════════════

// ─────────────────────────────────────────
// Layer 0 · Toast UI
// alert()  → Toast.info / Toast.error / Toast.success
// confirm() → Toast.confirm(msg)  returns Promise<bool>
// prompt()  → Toast.prompt(msg, placeholder) returns Promise<string|null>
// ─────────────────────────────────────────
const Toast = (() => {
  let _container = null;

  function _ensureContainer() {
    if (_container) return;
    _container = document.createElement('div');
    _container.id = 'toast-container';
    _container.style.cssText =
      'position:fixed;top:16px;right:16px;z-index:9999;display:flex;' +
      'flex-direction:column;gap:8px;pointer-events:none;max-width:340px';
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
    const el = document.createElement('div');
    el.style.cssText =
      `background:${colors[type]};border:1.5px solid ${borders[type]};` +
      'border-radius:10px;padding:10px 14px;font-size:12px;font-family:inherit;' +
      'color:var(--text);box-shadow:0 4px 18px rgba(0,0,0,.15);' +
      'pointer-events:auto;display:flex;align-items:flex-start;gap:8px;' +
      'animation:toastIn .22s ease;max-width:340px;line-height:1.5';
    el.innerHTML =
      `<span style="flex-shrink:0;font-size:14px">${icons[type]}</span>` +
      `<span style="flex:1">${msg}</span>` +
      `<button style="background:none;border:none;cursor:pointer;color:var(--text2);` +
      `font-size:14px;padding:0;line-height:1;margin-left:4px;flex-shrink:0" ` +
      `onclick="this.closest('div').remove()">✕</button>`;
    _container.appendChild(el);
    if (duration > 0) setTimeout(() => el.remove(), duration);
    return el;
  }

  function info(msg)    { _show(msg, 'info'); }
  function success(msg) { _show(msg, 'success'); }
  function error(msg)   { _show(msg, 'error', 5000); }
  function warn(msg)    { _show(msg, 'warn'); }

  function confirm(msg) {
    return new Promise(resolve => {
      _ensureContainer();
      const overlay = document.createElement('div');
      overlay.style.cssText =
        'position:fixed;inset:0;background:rgba(0,0,0,.45);z-index:9998;' +
        'display:flex;align-items:center;justify-content:center';
      overlay.innerHTML =
        `<div style="background:var(--panel);border-radius:14px;padding:24px 28px;` +
        `max-width:360px;width:90vw;box-shadow:0 8px 40px rgba(0,0,0,.25);` +
        `font-family:inherit;border:1.5px solid var(--border)">` +
        `<p style="font-size:13px;line-height:1.7;color:var(--text);margin-bottom:18px">` +
        `${msg}</p>` +
        `<div style="display:flex;gap:8px;justify-content:flex-end">` +
        `<button id="_tc_cancel" class="btn btn-ghost" style="font-size:12px;padding:7px 16px">취소</button>` +
        `<button id="_tc_ok"     class="btn btn-accent" style="font-size:12px;padding:7px 18px;border-radius:8px">확인</button>` +
        `</div></div>`;
      document.body.appendChild(overlay);
      overlay.querySelector('#_tc_ok').onclick     = () => { overlay.remove(); resolve(true); };
      overlay.querySelector('#_tc_cancel').onclick  = () => { overlay.remove(); resolve(false); };
      overlay.onclick = e => { if(e.target===overlay){overlay.remove();resolve(false);} };
    });
  }

  function prompt(msg, placeholder = '', defaultVal = '') {
    return new Promise(resolve => {
      _ensureContainer();
      const overlay = document.createElement('div');
      overlay.style.cssText =
        'position:fixed;inset:0;background:rgba(0,0,0,.45);z-index:9998;' +
        'display:flex;align-items:center;justify-content:center';
      overlay.innerHTML =
        `<div style="background:var(--panel);border-radius:14px;padding:24px 28px;` +
        `max-width:380px;width:90vw;box-shadow:0 8px 40px rgba(0,0,0,.25);` +
        `font-family:inherit;border:1.5px solid var(--border)">` +
        `<p style="font-size:13px;line-height:1.7;color:var(--text);margin-bottom:12px">` +
        `${msg}</p>` +
        `<input id="_tp_inp" class="inp" style="width:100%;margin-bottom:16px" ` +
        `placeholder="${placeholder}" value="${defaultVal}">` +
        `<div style="display:flex;gap:8px;justify-content:flex-end">` +
        `<button id="_tp_cancel" class="btn btn-ghost" style="font-size:12px;padding:7px 16px">취소</button>` +
        `<button id="_tp_ok"     class="btn btn-accent" style="font-size:12px;padding:7px 18px;border-radius:8px">확인</button>` +
        `</div></div>`;
      document.body.appendChild(overlay);
      const inp = overlay.querySelector('#_tp_inp');
      inp.focus();
      inp.addEventListener('keydown', e => {
        if (e.key === 'Enter') { overlay.remove(); resolve(inp.value); }
        if (e.key === 'Escape'){ overlay.remove(); resolve(null); }
      });
      overlay.querySelector('#_tp_ok').onclick    = () => { overlay.remove(); resolve(inp.value); };
      overlay.querySelector('#_tp_cancel').onclick = () => { overlay.remove(); resolve(null); };
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
    (_listeners[event] || []).forEach(fn => { try { fn(data); } catch(e) { console.error(e); } });
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
    // _state는 객체 직접 참조 — push/splice 등 배열 변형 메서드 정상 동작
    const _state = { ...initialState };
    // 배열 값은 초기화 시 원본 참조 유지
    Object.keys(initialState).forEach(k => {
      if (Array.isArray(initialState[k])) _state[k] = [...initialState[k]];
    });
    const _subscribers = [];

    // ref(): 내부 state 직접 참조 반환 (배열 변형용)
    function ref() { return _state; }

    // get(): 안전한 shallow copy 반환 (읽기 전용용)
    function get() { return _state; }  // 직접 참조 반환으로 변경

    function set(patch) {
      const prev = { ..._state };
      Object.assign(_state, patch);
      _subscribers.forEach(fn => { try { fn(_state, prev); } catch(e){} });
      EventBus.emit(`state:${name}:change`, { state: _state, prev });
    }

    function reset() {
      // 배열 초기화 시 기존 참조 유지하며 비움
      Object.keys(initialState).forEach(k => {
        if (Array.isArray(initialState[k])) {
          _state[k].length = 0;  // 참조 유지하며 배열 비움
          _state[k].push(...initialState[k]);
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

// ─────────────────────────────────────────
// Layer 3 · EventDelegate
// data-action 기반 이벤트 위임
// inline onclick="" 완전 대체
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

// ─────────────────────────────────────────
// Toast CSS 주입 (한 번만)
// ─────────────────────────────────────────
(function injectToastCSS() {
  const style = document.createElement('style');
  style.textContent = `
    @keyframes toastIn {
      from { opacity:0; transform:translateX(20px); }
      to   { opacity:1; transform:none; }
    }
    #toast-container > div:hover { filter: brightness(.96); }
  `;
  document.head.appendChild(style);
})();

// ══════════════════════════════════════════
// 📦 Module: State  (StateManager 기반 탭별 독립 상태)
// ══════════════════════════════════════════
const PAT_PRESETS = [
  {label:'[ 파일명.txt ] 형식', val:'^\\[\\s*.+\\.txt\\s*\\]\\s*$'},
  {label:'[EP.N] 형식',        val:'^\\[(?:EP|Ep|ep)\\.\\d+\\](?:\\s*.+)?$'},
  {label:'[Prologue] 형식',    val:'^\\[(?:Prologue|Epilogue|Side|Extra|프롤로그|에필로그|외전)(?:\\s*.+)?\\](?:\\s*.+)?$'},
  {label:'NNN  제목 형식',     val:'^\\d{3,6}\\s{2,}.+$'},
  {label:'〈N화〉 꺽쇠',          val:'^[〈<]\\s*(\\d+)\\s*화\\s*[〉>](?:\\s*(.*))?$'},
  {label:'줄 시작 통합 ★',     val:'^(?:\\s?〈\\s?\\d+화\\s?〉|EP\\.\\d+|(?=\\d+화)\\d+화|\\d+).*'},
  {label:'화 번호 (#N화 포함)', val:'^#?(?:제\\s*)?\\d+\\s*화(?:\\s*.+)?$'},
  {label:'소설(숫자)',          val:'^.{1,60}\\s*\\(\\d+\\)\\s*$'},
  {label:'숫자만',              val:'^\\d+$'},
  {label:'Chapter N',          val:'^(?:chapter|part|ch)\\s*\\d+(?:\\s*.+)?$'},
  {label:'EP/Ch/Scene N',      val:'^(?:EP|제|Chapter|Ch|디|Scene|Prologue)\\.?\\s*\\d+'},
  {label:'N. 제목',            val:'^\\d{1,3}\\.\\s*.+$'},
  {label:'N권',                val:'^\\d+권(?:\\s*.+)?$'},
  {label:'제목+구분선',         val:'^.+[=\\-]{3,}$'},
  {label:'# 제목',             val:'^#{1,3}\\s*.+$'},
  {label:'【제목】',            val:'^【.+】.*$'},
  {label:'=== [제N화] ===',    val:'^={2,}\\s*\\[제\\s*\\d+\\s*화\\]\\s*={0,}$'},
  {label:'N부 M화',            val:'^[1-9]부\\s+(?:\\d+화|프롤로그)(?:\\s*.+)?$'},
  {label:'#N. 제목',           val:'^#\\d+\\.\\s+.{1,60}$'},
  {label:'소설명+N화',          val:'^.{2,15}\\s+\\d+화$'},
];

// ── StateManager 기반 탭별 독립 상태 ──
// S: 변환탭, B: 일괄탭, E: 편집탭, EI: 편집삽화
// 기존 코드와 완전 호환 — 동일한 S.xxx 접근 방식 유지
// StateManager.create()는 상태 격리 + 변경 감지를 보장함

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
// S.xxx 읽기/쓰기가 StateManager를 통해 동작함
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

let customFontFile=null, customFontName='', customFontFace='';
// B, E, EI 별칭 — Object.assign 호환을 위한 헬퍼
// (reset 함수들이 Object.assign(S, {...}) 사용 → Proxy에서 직접 동작)

// ══════════════════════════════════════════
// 🚀 Module: Init   (DOMContentLoaded 진입점)
// ══════════════════════════════════════════
// ── scheduler.yield() 폴리필 ──
// Chrome 115+: scheduler.yield() 네이티브 지원
// 구형 브라우저: setTimeout(0) 폴백 → 메인 스레드에 제어권 반납
const yieldToMain = (typeof scheduler !== 'undefined' && scheduler.yield)
  ? () => scheduler.yield()
  : () => new Promise(r => setTimeout(r, 0));

window.addEventListener('DOMContentLoaded', ()=>{
  loadCssSettings();
  loadExtraSettings();
  loadApiSettings();
  buildPatHelpers();
  setupDragDrop();
  setupEventListeners();
  setupEventDelegate();   // ← data-action 이벤트 위임 활성화
  updateSettingsSummary();
  // 슬라이더 초기값 select 기준으로 동기화
  const lineVal=document.getElementById('cssLine')?.value||'1.9';
  syncSelect('cssLine','cssLineSlider','cssLineVal',lineVal);
  const sizeVal=document.getElementById('cssFontSize')?.value||'1em';
  syncSelect('cssFontSize','cssFontSizeSlider','cssFontSizeVal',sizeVal);
});

// 패턴 헬퍼 선택 상태 (helperId → Set of vals)
const _chipSelected={patHelper:new Set(), insPatHelper:new Set(), eTocPatHelper:new Set()};

function buildPatHelpers(){
  ['patHelper','insPatHelper','eTocPatHelper'].forEach(id=>{
    const c=document.getElementById(id); if(!c) return;
    const targetInput=id==='patHelper'?'pattern':'insPattern';
    c.innerHTML=''; // 매번 재빌드 가능하도록 초기화

    // ── 안내 텍스트 ──
    const hint=document.createElement('span');
    hint.style.cssText='font-size:11px;color:var(--text2);align-self:center;margin-right:2px';
    hint.textContent='빠른 선택:';
    c.appendChild(hint);

    // ── 현재 감지됨 칩 (patHelper 전용) ──
    if(id==='patHelper'){
      const detectedChip=document.createElement('span');
      detectedChip.className='pat-chip detected';
      detectedChip.id='chip_detected';
      const hasDet=S._detectedPat&&S._detectedName;
      detectedChip.textContent=hasDet?'✅ 감지됨: '+S._detectedName:'⬜ 감지 없음';
      detectedChip.style.cssText=hasDet?'':'opacity:.4;cursor:default';
      detectedChip.title=hasDet?'현재 자동 감지된 패턴을 선택에 추가':'아직 목차 확인을 실행하지 않았어요';
      if(hasDet){
        detectedChip.onclick=()=>{
          const src=S._detectedPat.source;
          const sel=_chipSelected[id];
          if(sel.has(src)){
            sel.delete(src);
            detectedChip.classList.remove('active');
          } else {
            sel.add(src);
            detectedChip.classList.add('active');
          }
          const combined=buildCombinedPat(sel);
          document.getElementById(targetInput).value=combined;
          previewToc();
        };
      }
      c.appendChild(detectedChip);
    }

    // ── 프리셋 칩들 ──
    PAT_PRESETS.forEach(p=>{
      const chip=document.createElement('span');
      chip.className='pat-chip';
      chip.textContent=p.label;
      chip.dataset.val=p.val;
      // 현재 감지된 패턴과 일치하면 미리 하이라이트
      if(id==='patHelper'&&S._detectedPat){
        try{
          const detSrc=S._detectedPat.source;
          const pRx=new RegExp(p.val.replace(/^\^/,'').replace(/\$$/,''));
          // source에 이 프리셋 패턴의 핵심 부분이 포함되면 하이라이트
          if(detSrc.includes(p.val.replace(/^\^/,'').replace(/\$$/,'').replace(/\(\?:/g,'').replace(/\)/g,'').split('|')[0].slice(0,8))){
            chip.style.borderStyle='dashed';
            chip.title='현재 감지된 패턴에 포함됨';
          }
        }catch(e){}
      }
      chip.onclick=()=>{
        const sel=_chipSelected[id];
        if(sel.has(p.val)){
          sel.delete(p.val);
          chip.classList.remove('active');
        } else {
          sel.add(p.val);
          chip.classList.add('active');
        }
        const combined=buildCombinedPat(sel);
        document.getElementById(targetInput).value=combined;
        if(id==='patHelper'){
          // 적용 버튼 바 표시/갱신
          const applyBar=document.getElementById('patApplyBar');
          const applyInfo=document.getElementById('patApplyInfo');
          if(applyBar){
            applyBar.style.display=sel.size?'flex':'none';
            if(applyInfo) applyInfo.textContent=sel.size?sel.size+'개 패턴 선택됨':'';
          }
        } else {
          reloadInsToc();
        }
      };
      c.appendChild(chip);
    });

    // ── 초기화 버튼 ──
    const clr=document.createElement('span');
    clr.className='pat-chip';
    clr.textContent='✕ 초기화';
    clr.style.opacity='.6';
    clr.onclick=()=>{
      _chipSelected[id].clear();
      c.querySelectorAll('.pat-chip.active').forEach(el=>el.classList.remove('active'));
      document.getElementById(targetInput).value='';
      if(id==='patHelper'){
        const applyBar=document.getElementById('patApplyBar');
        if(applyBar) applyBar.style.display='none';
        previewToc();
      } else reloadInsToc();
    };
    c.appendChild(clr);
  });
}

// previewToc 완료 후 감지됨 칩 업데이트
function refreshDetectedChip(){
  const chip=document.getElementById('chip_detected');
  if(!chip) return;
  const hasDet=S._detectedPat&&S._detectedName;
  chip.textContent=hasDet?'✅ 감지됨: '+S._detectedName:'⬜ 감지 없음';
  chip.style.opacity=hasDet?'1':'0.4';
  chip.style.cursor=hasDet?'pointer':'default';
  chip.title=hasDet?'현재 자동 감지된 패턴을 선택에 추가':'아직 목차 확인을 실행하지 않았어요';
  // onclick 재연결
  if(hasDet){
    const src=S._detectedPat.source;
    const sel=_chipSelected['patHelper'];
    // 이미 선택됐으면 active 유지
    if(sel.has(src)) chip.classList.add('active');
    else chip.classList.remove('active');
    chip.onclick=()=>{
      if(sel.has(src)){
        sel.delete(src);
        chip.classList.remove('active');
      } else {
        sel.add(src);
        chip.classList.add('active');
      }
      const combined=buildCombinedPat(sel);
      document.getElementById('pattern').value=combined;
      previewToc();
    };
  } else {
    chip.onclick=null;
  }
}

function buildCombinedPat(selSet){
  if(selSet.size===0) return '';
  if(selSet.size===1) return [...selSet][0];
  // ★ 각 패턴의 $ 앵커를 보존하면서 결합
  // 기존 방식의 버그: $ 를 제거하면 '숫자만(^\d+$)'이 '123 뒤에텍스트'도 매칭
  const parts=[...selSet].map(p=>{
    const hasEnd=p.endsWith('$')&&!p.endsWith('\\$');
    // ^ 제거 (맨 앞에만 있는 ^)
    let core=p.startsWith('^')?p.slice(1):p;
    // 끝 $ 제거 (후에 재부착)
    if(hasEnd) core=core.slice(0,-1);
    // 바깥 (?:...) 그룹 한 겹 제거 (중첩 방지)
    if(core.startsWith('(?:')&&core.endsWith(')')){
      // 매칭되는 괄호인지 확인
      let depth=0,isOuter=false;
      for(let i=0;i<core.length;i++){
        if(core[i]==='('&&core[i-1]!=='\\') depth++;
        else if(core[i]===')'&&core[i-1]!=='\\') depth--;
        if(depth===0&&i===core.length-1){isOuter=true;break;}
      }
      if(isOuter) core=core.slice(3,-1);
    }
    return '(?:'+core+(hasEnd?'$':'')+')';
  });
  return '^(?:'+parts.join('|')+')';
}

function clearChipSelection(helperId){
  // 직접 타이핑 시 칩 선택 상태만 초기화 (입력값은 유지)
  _chipSelected[helperId]?.clear();
  const c=document.getElementById(helperId);
  if(c) c.querySelectorAll('.pat-chip.active').forEach(el=>el.classList.remove('active'));
}

function setupEventListeners(){
  // file input onchange (드래그존 onclick과 같은 핸들러 연결)
  document.getElementById('txtIn').onchange        =e=>{
    // 이미 파일이 있으면 append 모드 (파일 추가 버튼 클릭 시)
    const append=S.txtFiles.length>0;
    handleTxt(e.target.files,append);
    e.target.value=''; // 같은 파일 재선택 허용
  };
  document.getElementById('illIn').onchange        =e=>handleIll(e.target.files);
  document.getElementById('coverIn').onchange      =e=>handleCover(e.target.files);
  document.getElementById('epubIn').onchange       =e=>loadEpub(e.target.files[0]);
  document.getElementById('insTxtIn').onchange     =e=>handleInsTxt(e.target.files);
  document.getElementById('insIllIn').onchange     =e=>handleInsIll(e.target.files);
  document.getElementById('editIllIn').onchange    =e=>handleEditIll(e.target.files);
  document.getElementById('batchTxtIn').onchange   =e=>handleBatchTxt(e.target.files);
  document.getElementById('batchCoverIn').onchange =e=>handleBatchCover(e.target.files);
  document.getElementById('fontIn').onchange       =e=>handleCustomFont(e.target.files);
  document.getElementById('cssImportIn').onchange  =e=>handleCssImportEpub(e.target.files);
  // 표지 썸네일 클릭 (드래그존이 아닌 별도 버튼)
  document.getElementById('coverThumb').onclick=()=>document.getElementById('coverIn').click();
  // editIllMode 라디오
  document.querySelectorAll('input[name="editIllMode"]').forEach(r=>r.addEventListener('change',e=>{
    document.getElementById('editIllManual').style.display=e.target.value==='manual'?'block':'none';
  }));
  // 삽입 위치 라디오
  document.querySelectorAll('input[name="insPos"]').forEach(r=>r.addEventListener('change',()=>{
    if(E.selectedChIdx!==null)selectCh(E.selectedChIdx);
  }));
}

// ── data-input-action 인풋 이벤트 위임 핸들러 ──
// HTML oninput="" 제거 후 addEventListener 방식으로 통합
(function setupInputDelegate(){
  const _inputHandlers = {
    previewCoverUrlConvert: (el) => previewCoverUrl('coverUrlInp','coverThumb','coverName','convert'),
    previewCoverUrlBatch:   (el) => previewCoverUrl('batchCoverUrlInp',null,null,'batch'),
    clearChipPatHelper:     ()   => clearChipSelection('patHelper'),
    clearChipInsHelper:     ()   => clearChipSelection('insPatHelper'),
    smartPatConvert:        ()   => smartPatConvert(),
    eSmartPatConvert:   () => eSmartPatConvert(),
    clearEtocChip:      () => clearChipSelection('eTocPatHelper'),
    saveCssSettings:        ()   => saveCssSettings(),
    saveExtraSettings:      ()   => saveExtraSettings(),
    saveApiSettings:        ()   => saveApiSettings(),
    syncImgQuality:         (el) => {
      const val = document.getElementById('optImgQualityVal');
      if(val) val.textContent = el.value + '%';
      saveExtraSettings();
    },
    saveExtraSettingsRenderIll: () => { saveExtraSettings(); renderIllTags(); },
    updateCssSave:              () => { updateCssPreview(); saveCssSettings(); },
    saveOptLang:   () => saveExtraSettings(),
    syncCssLine:   (el) => { syncSelect('cssLine','cssLineSlider','cssLineVal',el.value); updateCssPreview(); saveCssSettings(); },
    syncCssFontSize:   (el) => { syncSelect('cssFontSize','cssFontSizeSlider','cssFontSizeVal',el.value); updateCssPreview(); saveCssSettings(); },
    syncCssLineSlider:    (el) => { syncSlider('cssLine','cssLineSlider','cssLineVal',el.value); updateCssPreview(); saveCssSettings(); },
    syncCssFontSizeSlider:(el) => { syncSlider('cssFontSize','cssFontSizeSlider','cssFontSizeVal',el.value+'em'); updateCssPreview(); saveCssSettings(); },
    syncIndent:           (el) => syncIndent(el.value),
    // ★ 4방향 여백 슬라이더 ↔ 숫자 input 양방향 동기화
    syncPadTop:    (el) => { const n=document.getElementById('cssPadTop');    if(n)n.value=el.value; saveCssSettings(); saveUserPrefs(); },
    syncPadBottom: (el) => { const n=document.getElementById('cssPadBottom'); if(n)n.value=el.value; saveCssSettings(); saveUserPrefs(); },
    syncPadLeft:   (el) => { const n=document.getElementById('cssPadLeft');   if(n)n.value=el.value; saveCssSettings(); saveUserPrefs(); },
    syncPadRight:  (el) => { const n=document.getElementById('cssPadRight');  if(n)n.value=el.value; saveCssSettings(); saveUserPrefs(); },
  };
  document.addEventListener('input', e => {
    let t = e.target;
    while (t && t !== document.body) {
      const action = t.dataset?.inputAction;
      if (action && _inputHandlers[action]) {
        _inputHandlers[action](t, e);
        return;
      }
      t = t.parentElement;
    }
  });
  // onchange도 동일 패턴으로 위임
  document.addEventListener('change', e => {
    let t = e.target;
    while (t && t !== document.body) {
      const action = t.dataset?.inputAction;
      if (action && _inputHandlers[action]) {
        _inputHandlers[action](t, e);
        return;
      }
      t = t.parentElement;
    }
  });
})();


// ══════════════════════════════════════════
// EventDelegate 액션 등록
// data-action="xxx" 버튼 클릭 → 해당 함수 호출
// HTML의 onclick="" 완전 대체
// ══════════════════════════════════════════
function setupEventDelegate(){
  EventDelegate.registerAll({
    // ── 헤더 ──
    toggleTheme:      () => toggleTheme(),
    resetAll:         () => resetAll(),

    // ── 탭 전환 ──
    switchPage:       (el) => switchPage(el.dataset.page),

    // ── 변환 탭 ──
    resetConvertTxt:  () => resetConvertTxt(),
    sortTxtAuto:      () => { S.txtFiles=smartSortFiles(S.txtFiles); _chaptersCache=null; renderTxtFileList(); Toast.success('스마트 정렬 완료!'); },
    sortTxtAlpha:     () => { S.txtFiles=[...S.txtFiles].sort((a,b)=>sortKey(a.name)<sortKey(b.name)?-1:1); _chaptersCache=null; renderTxtFileList(); },
    addMoreTxt:       () => document.getElementById('txtIn').click(),
    resetConvertCover:() => resetConvertCover(),
    resetConvertAll:  () => resetConvertAll(),
    previewToc:       () => previewToc(),
    autoSplitByInterval: () => autoSplitByInterval(),
    applySmartPat:    () => applySmartPat(),
    applySelectedChips:  () => applySelectedChips(),
    applyPat:         () => applyPat(),
    tocTab:           (el) => tocTab(parseInt(el.dataset.idx)),
    addManualIll:     () => addManualIll(),
    showPreview:      () => showPreview(),
    downloadEpub:     () => downloadEpub(),
    startConvert:     () => startConvert(),
    startSplit:       () => startSplit(),

    // ── 일괄 변환 탭 ──
    resetBatchTxt:    () => resetBatchTxt(),
    resetBatchCover:  () => resetBatchCover(),
    resetBatchAll:    () => resetBatchAll(),
    startBatch:       () => startBatch(),
    downloadBatchZip: () => downloadBatchZip(),

    // ── EPUB 편집 탭 ──
    resetEditEpub:    () => resetEditEpub(),
    resetEditAll:     () => resetEditAll(),
    extractEpubImages:() => extractEpubImages(),
    reloadInsToc:     () => reloadInsToc(),
    addInsManualIll:  () => addInsManualIll(),
    addEditIllRow:    () => addEditIllRow(),
    downloadEditEpub: () => downloadEditEpub(),
    startEditEpub:    () => startEditEpub(),
    applyInsTocRange: (el) => applyInsTocRange(el.dataset.range),
    toggleAllInsToc:  (el) => toggleAllInsToc(el.dataset.val === 'true'),
    insIllMode:       (el) => {
      document.getElementById('editIllManual').style.display =
        el.value === 'manual' ? 'block' : 'none';
    },

    // ── 히스토리 탭 ──
    clearAllHistory:  () => clearAllHistory(),

    // ── 설정 탭 ──
    resetAllSettings: () => resetAllSettings(),
    resetColors:      () => resetColors(),
    applyCssImport:   () => applyCssImport(),
    clearCssImport:   () => clearCssImport(),

    // ── 표지 검색 ──
    openCoverModal:   (el) => openCoverModal(el.dataset.mode),
    closeCoverModal:  () => closeCoverModal(),
    runCoverSearch:   () => runCoverSearch(),
    applyCoverUrl:    (el) => applyCoverUrl(
      el.dataset.inp,
      el.dataset.thumb || null,
      el.dataset.name  || null,
      el.dataset.mode
    ),

    // ── 미리보기 모달 ──
    showPreview:   () => showPreview(),
    closePreview:  () => closePreview(),
    previewNav:    (el) => previewNav(parseInt(el.dataset.dir)),

    // ── 히스토리 (동적 생성 버튼) ──
    histDownload:  (el) => histDownload(el.dataset.key, el.dataset.name),
    deleteHistory: (el) => deleteHistory(el.dataset.key),

    // ── TOC 동적 버튼 ──
    toggleAllToc:  (el) => toggleAllToc(el.dataset.val === 'true'),
    removeDirectIllRow: (el) => {
      const row = document.getElementById(el.dataset.rowId);
      if(row) row.remove();
    },
    removeAllSuspicious: () => {
      // suspicious 각 항목의 다음 항목(오감지)을 뒤에서부터 제거
      const indices=[];
      S.tocItems.forEach((t,i)=>{ if(t.suspicious && i+1<S.tocItems.length) indices.push(i+1); });
      const toRemove=[...new Set(indices)].sort((a,b)=>b-a);
      toRemove.forEach(i=>S.tocItems.splice(i,1));
      renderTocItems();
      updateTocStat();
      document.getElementById('susp-toast')?.remove();
      if(toRemove.length>0) Toast.success('오감지 챕터 '+toRemove.length+'개를 목차에서 제거했어요.');
    },

    // ── 분리 ZIP 다운로드 ──
    downloadSplitZip: () => downloadSplitZip(),

    // ── 수동 삽화 행 삭제 (동적 생성 버튼) ──
    removeManualIllRow: (el) => {
      const row = document.getElementById(el.dataset.rowId);
      if (row) row.remove();
    },
    removeEditIllRow: (el) => {
      const row = document.getElementById(el.dataset.rowId);
      if (row) row.remove();
    },

    // ── EPUB 직접 편집 탭 ──
    switchEditTab:          (el) => switchEditTab(el.dataset.tab),
    eTocTab:                (el) => eTocTab(parseInt(el.dataset.idx)),
    eToggleAllToc:          (el) => eToggleAllToc(el.dataset.val==='true'),
    previewEpubToc:         ()   => previewEpubToc(),
    applyESmartPat:         ()   => applyESmartPat(),
    applyETocSelectedChips: ()   => applyETocSelectedChips(),
    applyEPat:              ()   => applyEPat(),
    directEditTocCheckAll:  (el) => directEditTocCheckAll(el.dataset.val==='true'),
    directEditTocMoveUp:    ()   => directEditTocMoveUp(),
    directEditTocMoveDown:  ()   => directEditTocMoveDown(),
    addDirectEditIllRow:    ()   => addDirectEditIllRow(),
    directEditCssPreset:    (el) => directEditCssPreset(el.dataset.preset),
    clearDirectEditCss:     ()   => { const el=document.getElementById('directEditCssInput'); if(el) el.value=''; },
    applyDirectEdit:        ()   => applyDirectEdit(),
    downloadDirectEditEpub: ()   => downloadDirectEditEpub(),
  });

  // EventDelegate 전역 클릭 위임 시작
  EventDelegate.init();

  // ── 모달 오버레이 클릭 닫기 (data-action-overlay) ──
  document.addEventListener('click', e => {
    const overlay = e.target.closest('[data-action-overlay]');
    if (overlay && e.target === overlay) {
      const fn = overlay.dataset.actionOverlay;
      if (fn === 'closePreview')    closePreview();
      if (fn === 'closeCoverModal') closeCoverModal();
    }
  });

  // ── EventBus 구독: 탭 전환 알림 ──
  EventBus.on('page:changed', ({name}) => {
    if (name === 'history') renderHistory();
  });

  // ── StateManager 구독: 탭별 UI 자동 갱신 예시 ──
  _sStore.subscribe((state) => {
    // 변환탭 상태 변경 시 리셋바 표시 여부 자동 갱신
    const bar = document.getElementById('convertResetBar');
    if (bar) bar.style.display = (state.txtFiles.length || state.coverFile) ? 'flex' : 'none';
  });
}


function setupDragDrop(){
  // (dragzone ID, drop handler, file input ID)
  setupDz('txtDz',         handleTxt,                   'txtIn');
  setupDz('coverDz',       handleCover,                 'coverIn');
  setupDz('illDz',         handleIll,                   'illIn');
  setupDz('epubDrop',      files=>loadEpub(files[0]),   'epubIn');
  setupDz('insTxtDrop',    handleInsTxt,                'insTxtIn');
  setupDz('insIllDrop',    handleInsIll,                'insIllIn');
  setupDz('editIllDrop',   handleEditIll,               'editIllIn');
  setupDz('batchTxtDrop',  handleBatchTxt,              'batchTxtIn');
  setupDz('batchCoverDrop',handleBatchCover,            'batchCoverIn');
  setupDz('fontDrop',      handleCustomFont,            'fontIn');
  setupDz('cssImportDrop', handleCssImportEpub,         'cssImportIn');
}

function setupDz(id,fn,inputId){
  const el=document.getElementById(id);
  if(!el) return;
  el.addEventListener('dragover',e=>{e.preventDefault();el.classList.add('over');});
  el.addEventListener('dragleave',()=>el.classList.remove('over'));
  el.addEventListener('drop',e=>{e.preventDefault();el.classList.remove('over');fn(e.dataTransfer.files);});
  if(inputId) el.onclick=()=>{const inp=document.getElementById(inputId);if(inp)inp.click();};
}

// ══════════════════════════════════════════
// 🎨 Module: Theme  (다크/라이트 테마 전환)
// ══════════════════════════════════════════
function toggleTheme(){
  const d=document.documentElement,dark=d.getAttribute('data-theme')==='dark';
  d.setAttribute('data-theme',dark?'light':'dark');
  document.getElementById('themeBtn').textContent=dark?'🌙':'☀️';
}

async function resetAll(){
  if(!await Toast.confirm('모든 설정을 초기화할까요?')) return;
  _sStore.set({txtFiles:[],coverFile:null,illFiles:[],tocItems:[],epubBlob:null,epubName:'',manualCnt:0});
  _chaptersCache=null;_chaptersCacheKey='';
  document.getElementById('txtDz').className='dz';
  document.getElementById('illDz').className='dz';
  document.getElementById('coverDz').className='dz';
  document.getElementById('coverThumb').innerHTML='표지';
  document.getElementById('coverName').textContent='';
  document.getElementById('txtInfo').style.display='none';
  document.getElementById('illTags').innerHTML='';
  document.getElementById('manualIlls').innerHTML='';
  ['title','author','pattern'].forEach(id=>document.getElementById(id).value='');
  ['tocPanel','progWrap','resultBox','errBox'].forEach(id=>document.getElementById(id).classList.remove('show'));
}

function switchPage(name){
  const pages=['convert','batch','edit','history','settings'];
  document.querySelectorAll('.page-tab').forEach((t,i)=>t.classList.toggle('on',pages[i]===name));
  pages.forEach(p=>{document.getElementById('page-'+p).classList.toggle('on',p===name);});
  EventBus.emit('page:changed', {name}); // 탭 전환 이벤트 발행
  document.getElementById('btmConvert').style.display=name==='convert'?'flex':'none';
  document.getElementById('btmBatch').style.display=name==='batch'?'flex':'none';
  document.getElementById('btmEdit').style.display=name==='edit'?'flex':'none';
  if(name==='convert'||name==='batch') updateSettingsSummary();
  if(name==='history') renderHistory();
}

function updateSettingsSummary(){
  const font=document.getElementById('cssFont');
  const fontName=font&&font.options&&font.options[font.selectedIndex]?font.options[font.selectedIndex].text.split(' ')[0]:'Noto Serif KR';
  const line=document.getElementById('cssLine')?.value||'1.9';
  const size=document.getElementById('cssFontSize')?.value||'1em';
  const italic=document.getElementById('optItalic')?.checked?'이탤릭 ON':'이탤릭 OFF';
  const indent=document.getElementById('optIndent')?.checked?'들여쓰기 ON':'들여쓰기 OFF';
  const imgConv=document.getElementById('optImgConvert')?.checked!==false?'삽화 JPG변환 ON':'삽화 JPG변환 OFF';
  const summary='현재 설정: '+fontName+' · 줄간격 '+line+' · 크기 '+size+' · '+italic+' · '+indent+' · '+imgConv;
  const el=document.getElementById('settingsSummary');
  if(el) el.textContent=summary;
  const el2=document.getElementById('batchSettingSummary');
  if(el2) el2.textContent=summary;
}

// ══════════════════════════════════════════
// 🔍 Module: Encoding (EUC-KR/UTF-8 자동 감지)
// ══════════════════════════════════════════
// 마지막 감지된 인코딩 저장
const _encCache=new Map();

async function detectEncoding(file){
  const ab=await fileToAB(file);
  // 샘플 크기 64KB (8KB → 64KB: 경계 잘림 문제 해소)
  const bytes=new Uint8Array(ab.slice(0,65536));

  // BOM 체크
  if(bytes[0]===0xEF&&bytes[1]===0xBB&&bytes[2]===0xBF) return 'utf-8';
  if(bytes[0]===0xFF&&bytes[1]===0xFE) return 'utf-16le';
  if(bytes[0]===0xFE&&bytes[1]===0xFF) return 'utf-16be';

  // UTF-8 유효성 검사 (오류율 기반)
  let utf8Errors=0, totalMultibyte=0;
  let i=0;
  // 마지막 3바이트는 잘림 방지를 위해 제외
  const limit=bytes.length-3;
  while(i<limit){
    const b=bytes[i];
    if(b<0x80){i++;continue;}
    if(b>=0xC2&&b<=0xDF){
      if((bytes[i+1]&0xC0)===0x80){totalMultibyte++;i+=2;continue;}
    } else if(b>=0xE0&&b<=0xEF){
      if((bytes[i+1]&0xC0)===0x80&&(bytes[i+2]&0xC0)===0x80){totalMultibyte++;i+=3;continue;}
    } else if(b>=0xF0&&b<=0xF4){
      if(i+3<limit&&(bytes[i+1]&0xC0)===0x80&&(bytes[i+2]&0xC0)===0x80&&(bytes[i+3]&0xC0)===0x80){totalMultibyte++;i+=4;continue;}
    }
    utf8Errors++;i++;
  }

  // 오류율 0.1% 미만 → UTF-8 확정
  // (경계 잘림 등 극소수 오류는 무시)
  const errorRate=utf8Errors/Math.max(totalMultibyte,1);
  if(errorRate<0.001) return 'utf-8';

  // EUC-KR / CP949 판정:
  // TextDecoder로 직접 디코딩 후 U+FFFD(깨진 문자) 수 비교
  const utf8Text=new TextDecoder('utf-8',{fatal:false}).decode(bytes);
  const eucText=new TextDecoder('euc-kr',{fatal:false}).decode(bytes);
  const utf8Bad=(utf8Text.match(/\ufffd/g)||[]).length;
  const eucBad=(eucText.match(/\ufffd/g)||[]).length;

  // UTF-8 깨짐이 0이면 UTF-8 확정 (파일 자체가 올바른 UTF-8)
  if(utf8Bad===0) return 'utf-8';
  return utf8Bad<=eucBad ? 'utf-8' : 'euc-kr';
}

async function fileToText(file){
  const enc=await detectEncoding(file);
  _encCache.set(file,enc);

  // TextDecoder 직접 사용 — 대용량 파일(20MB+)에서 더 안정적
  // FileReader.readAsText()는 브라우저 내부 구현에 따라 청크 경계에서 손실 가능
  return new Promise((res,rej)=>{
    const r=new FileReader();
    r.onload=e=>{
      try{
        const ab=e.target.result;
        // TextDecoder로 직접 디코딩 (fatal:false → 잘못된 바이트는 U+FFFD 대체)
        const decoder=new TextDecoder(enc,{fatal:false});
        const text=decoder.decode(new Uint8Array(ab));
        // U+FFFD(대체문자) 포함 여부 경고 — EUC-KR 오판 감지
        const badCount=(text.match(/\ufffd/g)||[]).length;
        if(badCount>10&&enc==='utf-8'){
          // UTF-8 판정인데 깨진 문자가 많으면 EUC-KR로 재시도
          const r2=new FileReader();
          r2.onload=e2=>{
            const ab2=e2.target.result;
            const text2=new TextDecoder('euc-kr',{fatal:false}).decode(new Uint8Array(ab2));
            const bad2=(text2.match(/\ufffd/g)||[]).length;
            res(bad2<badCount?text2:text);
          };
          r2.onerror=()=>res(text);
          r2.readAsArrayBuffer(file);
        }else{
          res(text);
        }
      }catch(err){
        // fallback: readAsText
        const fr=new FileReader();
        fr.onload=ev=>res(ev.target.result);
        fr.onerror=rej;
        fr.readAsText(file,enc);
      }
    };
    r.onerror=rej;
    r.readAsArrayBuffer(file);
  });
}

// 파일을 스트리밍 방식으로 부분 읽기 (대용량 파일 UI 블로킹 방지)
// UTF-8 경계 안전 슬라이스 읽기
// 고정 바이트 오프셋 슬라이스 시 멀티바이트 문자(한글 3바이트)가 잘릴 수 있음
// → ArrayBuffer로 읽어서 경계 바이트를 직접 보정 후 TextDecoder 사용
async function readFileSlice(file, start, end){
  // 앞 경계 보정: start가 멀티바이트 중간이면 다음 유효 바이트로 이동
  const MARGIN=4; // UTF-8 최대 4바이트
  const safeStart=Math.max(0, start-MARGIN);
  const safeEnd=Math.min(file.size, end+MARGIN);

  return new Promise((res,rej)=>{
    const slice=file.slice(safeStart, safeEnd);
    const r=new FileReader();
    r.onload=e=>{
      const bytes=new Uint8Array(e.target.result);
      // 앞 경계: start-safeStart 오프셋부터 첫 유효 UTF-8 시작 바이트 찾기
      let s=start-safeStart;
      while(s<bytes.length&&s<MARGIN&&(bytes[s]&0xC0)===0x80) s++;
      // 뒤 경계: end-safeStart 오프셋 이후 멀티바이트 완성 보장
      let e2=end-safeStart;
      while(e2<bytes.length&&(bytes[e2]&0xC0)===0x80) e2++;
      try{
        const text=new TextDecoder('utf-8',{fatal:false}).decode(bytes.subarray(s,e2));
        res(text);
      }catch(err){
        // fallback: FileReader readAsText
        const fr=new FileReader();
        fr.onload=ev=>res(ev.target.result);
        fr.onerror=()=>res('');
        fr.readAsText(new Blob([bytes.subarray(s,e2)]),'utf-8');
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
  const chunks=[];
  chunks.push(await readFileSlice(file, 0, CHUNK));
  chunks.push(await readFileSlice(file, Math.floor(size*0.25), Math.floor(size*0.25)+CHUNK));
  chunks.push(await readFileSlice(file, Math.floor(size*0.5),  Math.floor(size*0.5)+CHUNK));
  chunks.push(await readFileSlice(file, Math.floor(size*0.75), Math.floor(size*0.75)+CHUNK));
  chunks.push(await readFileSlice(file, Math.max(0,size-CHUNK), size));

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
  const ext=file.name.split('.').pop().toLowerCase();
  const supportedAsIs=['jpg','jpeg'];
  const convertable=['png','gif','webp','bmp','tiff','tif','avif','heic','heif'];

  if(supportedAsIs.includes(ext)) return {blob:file, ext:'jpg', mt:'image/jpeg'};

  const shouldConvert=forCover || document.getElementById('optImgConvert')?.checked!==false;

  if(shouldConvert && convertable.includes(ext)){
    const quality=(parseInt(document.getElementById('optImgQuality')?.value||'92'))/100;
    try{
      const blob=await imgToJpgBlob(file, quality);
      return {blob, ext:'jpg', mt:'image/jpeg'};
    }catch(e){
      console.warn('JPG 변환 실패, 원본 사용:', file.name, e);
    }
  }

  const mimeMap={
    'png':'image/png','gif':'image/gif','webp':'image/webp',
    'bmp':'image/bmp','tiff':'image/tiff','tif':'image/tiff',
    'avif':'image/avif','svg':'image/svg+xml',
  };
  const mt=mimeMap[ext]||'image/jpeg';
  return {blob:file, ext, mt};
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
        // PNG 투명 배경 → 흰색
        ctx.fillStyle='#ffffff';
        ctx.fillRect(0,0,c.width,c.height);
        ctx.drawImage(img,0,0);
        c.toBlob(b=>{
          URL.revokeObjectURL(url);
          if(b) res(b);
          else rej(new Error('toBlob 실패'));
        },'image/jpeg',quality);
      }catch(e){URL.revokeObjectURL(url);rej(e);}
    };
    img.onerror=(e)=>{URL.revokeObjectURL(url);rej(new Error('이미지 로드 실패: '+file.name));};
    img.src=url;
  });
}

// 🎨 Module: CssSettings (스타일 설정 관리)
// ══════════════════════════════════════════
function saveCssSettings(){
  try{
    const indentSlider=document.getElementById('cssIndentSlider');
    localStorage.setItem('epub_css',JSON.stringify({
      font:document.getElementById('cssFont')?.value,
      line:document.getElementById('cssLine')?.value,
      size:document.getElementById('cssFontSize')?.value,
      margin:document.getElementById('cssMargin')?.value,
      textColor:document.getElementById('cssTextColor')?.value||'',
      bgColor:document.getElementById('cssBgColor')?.value||'',
      align:document.querySelector('input[name="cssAlign"]:checked')?.value||'justify',
      titleStyle:document.querySelector('input[name="cssTitleStyle"]:checked')?.value||'center',
      indentEm:indentSlider?parseFloat(indentSlider.value):1.0,
      extra:document.getElementById('cssExtra')?.value||'',
    }));
  }catch(e){}
}

function saveExtraSettings(){
  try{
    localStorage.setItem('epub_extra',JSON.stringify({
      emptyLine:document.getElementById('optEmptyLine')?.checked,
      chTitle:document.getElementById('optChTitle')?.checked,
      darkCover:document.getElementById('optDarkCover')?.checked,
      autoPreview:document.getElementById('optAutoPreview')?.checked,
      showLineNum:document.getElementById('optShowLineNum')?.checked,
      defaultPat:document.getElementById('optDefaultPat')?.value||'',
      lang:document.getElementById('optLang')?.value||'ko',
      publisher:document.getElementById('optPublisher')?.value||'',
      compression:document.getElementById('optCompression')?.value||'6',
      italic:document.getElementById('optItalic')?.checked,
      indent:document.getElementById('optIndent')?.checked,
      imgConvert:document.getElementById('optImgConvert')?.checked,
      imgQuality:document.getElementById('optImgQuality')?.value||'92',
    }));
  }catch(e){}
}

function loadExtraSettings(){
  try{
    const s=JSON.parse(localStorage.getItem('epub_extra')||'{}');
    if(s.emptyLine!=null) document.getElementById('optEmptyLine').checked=s.emptyLine;
    if(s.chTitle!=null) document.getElementById('optChTitle').checked=s.chTitle;
    if(s.darkCover!=null) document.getElementById('optDarkCover').checked=s.darkCover;
    if(s.autoPreview!=null) document.getElementById('optAutoPreview').checked=s.autoPreview;
    if(s.showLineNum!=null) document.getElementById('optShowLineNum').checked=s.showLineNum;
    if(s.italic!=null) document.getElementById('optItalic').checked=s.italic;
    if(s.indent!=null) document.getElementById('optIndent').checked=s.indent;
    if(s.imgConvert!=null&&document.getElementById('optImgConvert')) document.getElementById('optImgConvert').checked=s.imgConvert;
    if(s.imgQuality&&document.getElementById('optImgQuality')){
      document.getElementById('optImgQuality').value=s.imgQuality;
      const vl=document.getElementById('optImgQualityVal');
      if(vl) vl.textContent=s.imgQuality+'%';
    }
    if(s.defaultPat) document.getElementById('optDefaultPat').value=s.defaultPat;
    if(s.lang) document.getElementById('optLang').value=s.lang;
    if(s.publisher) document.getElementById('optPublisher').value=s.publisher;
    if(s.compression) document.getElementById('optCompression').value=s.compression;
    if(s.defaultPat) document.getElementById('pattern').value=s.defaultPat;
  }catch(e){}
}

async function resetAllSettings(){
  if(!await Toast.confirm('모든 설정을 초기화할까요?')) return;
  localStorage.removeItem('epub_css');
  localStorage.removeItem('epub_extra');
  location.reload();
}

// ── 변환 탭 초기화 ──
function resetConvertTxt(){
  S.txtFiles=[];S._rawTextFull=[];_chaptersCache=null;_chaptersCacheKey='';
  _autoSplitActive=false;_autoSplitLines=null;
  document.getElementById('txtDz').className='dz';
  document.getElementById('txtInfo').style.display='none';
  const fl=document.getElementById('txtFileList'); if(fl) fl.style.display='none';
  const sl=document.getElementById('txtSortList'); if(sl) sl.innerHTML='';
  document.getElementById('tocPanel').classList.remove('show');
  ['title','author','pattern'].forEach(id=>{const el=document.getElementById(id);if(el)el.value='';});
  document.getElementById('convertResetBar').style.display='none';
}
function resetConvertCover(){
  S.coverFile=null;
  document.getElementById('coverDz').className='dz';
  const t=document.getElementById('coverThumb');
  if(t)t.innerHTML='<span style="display:flex;flex-direction:column;align-items:center;gap:4px"><span style="font-size:22px">🖼</span><span>표지</span></span>';
  document.getElementById('coverName').textContent='';
  const inp=document.getElementById('coverUrlInp');if(inp)inp.value='';
}
async function resetConvertAll(){
  if(!await Toast.confirm('변환 탭의 모든 파일과 설정을 초기화할까요?')) return;
  resetConvertTxt();resetConvertCover();
  _sStore.set({illFiles:[],tocItems:[],epubBlob:null,manualCnt:0});
  document.getElementById('illDz').className='dz';
  document.getElementById('illTags').innerHTML='';
  document.getElementById('manualIlls').innerHTML='';
  ['progWrap','resultBox','errBox','splitSec'].forEach(id=>{
    const el=document.getElementById(id);
    if(el){el.classList.remove('show');if(id==='splitSec')el.style.display='none';}
  });
}

// ── 일괄 변환 탭 초기화 ──
function resetBatchTxt(){
  _bStore.set({txtFiles:[],patterns:{},sampleTexts:{},totalChs:{}});
  const dz=document.getElementById('batchTxtDrop');
  dz.className='dz';dz.querySelector('.dz-text').textContent='TXT 파일 여러 개 드래그하거나 클릭';
  document.getElementById('batchList').innerHTML='';
  document.getElementById('batchListSec').style.display='none';
  if(!Object.keys(B.coverMap).length&&!B.urlCoverFile) document.getElementById('batchResetBar').style.display='none';
}
function resetBatchCover(){
  _bStore.set({coverMap:{},urlCoverFile:null});
  const dz=document.getElementById('batchCoverDrop');
  dz.className='dz';dz.querySelector('div').textContent='🖼 표지 이미지들 한꺼번에 드래그';
  document.getElementById('batchCoverUrlInp').value='';
  renderBatchList();
}
async function resetBatchAll(){
  if(!await Toast.confirm('일괄 변환 탭의 모든 파일을 초기화할까요?')) return;
  resetBatchTxt();resetBatchCover();
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
}
async function resetEditAll(){
  if(!await Toast.confirm('EPUB 편집 탭을 전부 초기화할까요?')) return;
  resetEditEpub();
}

// ── EPUB CSS 임포트 ──
const _cssImportSelected=new Set();
async function handleCssImportEpub(files){
  const file=files[0];if(!file||!file.name.endsWith('.epub'))return;
  const info=document.getElementById('cssImportInfo');
  info.textContent='분석 중...';
  try{
    const ab=await fileToAB(file);
    const zip=await JSZip.loadAsync(ab);
    let allCss='';
    for(const name of Object.keys(zip.files)){
      if(name.endsWith('.css')) allCss+=await zip.files[name].async('text')+'\n';
    }
    // 유용한 클래스 추출 (색상, 배경, 특수 폰트)
    const KNOWN=[
      {cls:'.txt2',     label:'파란 본문',    desc:'color:#2457BD — 강조 대화'},
      {cls:'.flashback',label:'회상체',        desc:'gray+italic — 회상 장면'},
      {cls:'.box7',     label:'녹색 박스',     desc:'연두 배경 테두리 박스'},
      {cls:'.box9',     label:'핑크 박스',     desc:'분홍 배경 테두리 박스'},
      {cls:'.box3',     label:'파란 박스',     desc:'파란 배경 테두리 박스'},
      {cls:'.box_message',label:'편지 박스',   desc:'ridge 테두리 메시지 박스'},
      {cls:'.sms_msg_me',label:'SMS 내 말',    desc:'파란 말풍선'},
      {cls:'.sms_msg_you',label:'SMS 상대',    desc:'회색 말풍선'},
      {cls:'.news',     label:'신문 박스',     desc:'double 테두리 뉴스 스타일'},
      {cls:'.txtink',   label:'잉크 폰트',     desc:'InkLipquid — 손글씨'},
      {cls:'.txthand',  label:'손글씨',        desc:'UhBeeSeulvely'},
      {cls:'.txtrd',    label:'리디바탕',       desc:'RIDIBatang 폰트'},
      {cls:'.txtsns',   label:'SNS 문자',      desc:'작은 글씨 SNS 메시지'},
      {cls:'.gojo1',    label:'제목형 텍스트', desc:'진한 소형 제목 스타일'},
      {cls:'.gojo2',    label:'하늘색 강조',   desc:'민트 배경 강조 박스'},
      {cls:'.red',      label:'빨간 강조',     desc:'color:#C30000 bold'},
      {cls:'.blue',     label:'파란 강조',     desc:'color:#000CC0 bold'},
    ];
    const found=KNOWN.filter(({cls})=>{
      const src=cls.replace('.','\\.');
      return new RegExp(src+'\\s*\\{').test(allCss);
    });

    // 파일에서 직접 추출 (알 수 없는 클래스)
    const extracted=[];
    for(const m of allCss.matchAll(/(\.[a-zA-Z][a-zA-Z0-9_-]*)\s*\{([^}]+)\}/g)){
      const cls=m[1],body=m[2];
      if(found.some(f=>f.cls===cls)) continue;
      const hasBg=/background-color\s*:\s*#[0-9a-fA-F]{3,6}/.test(body);
      const hasColor=/(?:^|[^-])color\s*:\s*#[0-9a-fA-F]{3,6}/.test(body);
      const hasBorder=/border\s*:/.test(body);
      const hasSpecialFont=/font-family\s*:/.test(body);
      if((hasBg||hasColor||hasBorder||hasSpecialFont)&&body.length>20){
        const bg=body.match(/background-color\s*:\s*(#[0-9a-fA-F]{3,8})/)?.[1]||'';
        const col=body.match(/(?:^|;)\s*color\s*:\s*(#[0-9a-fA-F]{3,8})/)?.[1]||'';
        extracted.push({cls,label:cls,desc:(bg?'bg:'+bg+' ':'')+(col?'color:'+col+' ':'')+body.slice(0,40).replace(/\s+/g,' ')+'…',bg,col,raw:body.trim()});
      }
    }

    const all=[...found.map(f=>{
      const bg=allCss.match(new RegExp(f.cls.replace('.','\\.')+'\\s*\\{([^}]+)\\}'))?.[1]||'';
      const bgCol=bg.match(/background-color\s*:\s*(#[0-9a-fA-F]{3,8})/)?.[1]||'';
      const col=bg.match(/(?:^|;)\s*color\s*:\s*(#[0-9a-fA-F]{3,8})/)?.[1]||'';
      return {...f,bg:bgCol,col,raw:bg.trim()};
    }),...extracted.slice(0,20)];

    _cssImportSelected.clear();
    const grid=document.getElementById('cssImportClasses');
    grid.style.display='grid';
    grid.innerHTML='';
    all.forEach(item=>{
      const card=document.createElement('div');
      card.className='css-cls-card';
      const swatch=document.createElement('div');
      swatch.className='css-cls-swatch';
      if(item.bg) swatch.style.background=item.bg;
      else if(item.col) swatch.style.background=item.col+'22';
      else swatch.style.background='var(--border)';
      card.innerHTML=`<div class="css-cls-name">${escHtml(item.label)}</div><div class="css-cls-desc">${escHtml(item.desc.slice(0,50))}</div>`;
      card.insertBefore(swatch,card.firstChild);
      card.onclick=()=>{
        card.classList.toggle('sel');
        if(card.classList.contains('sel')) _cssImportSelected.add(item);
        else _cssImportSelected.delete(item);
        document.getElementById('cssImportApplyBar').style.display=_cssImportSelected.size?'block':'none';
      };
      grid.appendChild(card);
    });
    document.getElementById('cssImportInfo').textContent=`✅ ${all.length}개 클래스 발견 — 추가할 클래스를 선택하세요`;
    if(!all.length) document.getElementById('cssImportInfo').textContent='⚠️ 유용한 CSS 클래스를 찾지 못했어요';
  }catch(e){
    info.textContent='❌ 오류: '+e.message;
  }
}

function applyCssImport(){
  if(!_cssImportSelected.size)return;
  const count=_cssImportSelected.size;
  const extraEl=document.getElementById('cssExtra');
  const existing=extraEl?.value||'';
  const newCss=Array.from(_cssImportSelected)
    .map(item=>`/* ${item.label} */\n${item.cls}{${item.raw}}`)
    .join('\n');
  if(extraEl) extraEl.value=(existing?existing+'\n\n':'')+newCss;
  _cssImportSelected.clear();
  document.querySelectorAll('.css-cls-card.sel').forEach(c=>c.classList.remove('sel'));
  document.getElementById('cssImportApplyBar').style.display='none';
  saveCssSettings();
  Toast.success(`✅ ${count}개 클래스가 "추가 CSS" 영역에 추가됐어요.`);
}
function clearCssImport(){
  _cssImportSelected.clear();
  document.getElementById('cssImportClasses').style.display='none';
  document.getElementById('cssImportClasses').innerHTML='';
  document.getElementById('cssImportApplyBar').style.display='none';
  document.getElementById('cssImportInfo').textContent='';
  document.getElementById('cssImportDrop').className='dz';
}

function loadCssSettings(){
  try{
    const saved=JSON.parse(localStorage.getItem('epub_css')||'{}');
    if(saved.font){const sel=document.getElementById('cssFont');if(sel)[...sel.options].forEach(o=>{if(o.value===saved.font)o.selected=true;});}
    if(saved.line){
      const sl=document.getElementById('cssLineSlider'),vl=document.getElementById('cssLineVal'),sel=document.getElementById('cssLine');
      if(sl)sl.value=parseFloat(saved.line);
      if(vl)vl.textContent=parseFloat(saved.line).toFixed(1);
      if(sel)[...sel.options].forEach(o=>{if(o.value===saved.line)o.selected=true;});
    }
    if(saved.size){
      const numVal=parseFloat(saved.size);
      const sl=document.getElementById('cssFontSizeSlider'),vl=document.getElementById('cssFontSizeVal'),sel=document.getElementById('cssFontSize');
      if(sl)sl.value=numVal;
      if(vl)vl.textContent=numVal.toFixed(2).replace(/\.?0+$/,'')+'em';
      if(sel)[...sel.options].forEach(o=>{if(o.value===saved.size)o.selected=true;});
    }
    if(saved.margin){const sel=document.getElementById('cssMargin');if(sel)[...sel.options].forEach(o=>{if(o.value===saved.margin)o.selected=true;});}
    if(saved.textColor&&document.getElementById('cssTextColor'))document.getElementById('cssTextColor').value=saved.textColor;
    if(saved.bgColor&&document.getElementById('cssBgColor'))document.getElementById('cssBgColor').value=saved.bgColor;
    if(saved.align){const r=document.querySelector('input[name="cssAlign"][value="'+saved.align+'"]');if(r)r.checked=true;}
    if(saved.titleStyle){const r=document.querySelector('input[name="cssTitleStyle"][value="'+saved.titleStyle+'"]');if(r)r.checked=true;}
    if(saved.indentEm!=null){
      const sl=document.getElementById('cssIndentSlider'),vl=document.getElementById('cssIndentVal');
      if(sl)sl.value=saved.indentEm;
      if(vl)vl.textContent=parseFloat(saved.indentEm).toFixed(1)+'em';
    }
    if(saved.extra&&document.getElementById('cssExtra'))document.getElementById('cssExtra').value=saved.extra;
    updateCssPreview();
  }catch(e){}
}

// 슬라이더 ↔ select 동기화 헬퍼
function syncSlider(selectId,sliderId,valId,val){
  const numVal=parseFloat(val);
  const sel=document.getElementById(selectId);
  const vl=document.getElementById(valId);
  if(vl)vl.textContent=selectId==='cssFontSize'?numVal.toFixed(2).replace(/\.?0+$/,'')+'em':numVal.toFixed(1);
  if(sel){let best=null,bd=Infinity;[...sel.options].forEach(o=>{const d=Math.abs(parseFloat(o.value)-numVal);if(d<bd){bd=d;best=o;}});if(best)best.selected=true;}
}
function syncSelect(selectId,sliderId,valId,val){
  const numVal=parseFloat(val);
  const sl=document.getElementById(sliderId),vl=document.getElementById(valId);
  if(sl)sl.value=numVal;
  if(vl)vl.textContent=selectId==='cssFontSize'?numVal.toFixed(2).replace(/\.?0+$/,'')+'em':numVal.toFixed(1);
}
function syncIndent(val){
  const vl=document.getElementById('cssIndentVal');
  if(vl)vl.textContent=parseFloat(val).toFixed(1)+'em';
  saveCssSettings();updateCssPreview();
}
function resetColors(){
  const tc=document.getElementById('cssTextColor'),bc=document.getElementById('cssBgColor');
  if(tc)tc.value='#2d1f14';if(bc)bc.value='#fdf6ee';
  updateCssPreview();saveCssSettings();
}

function updateCssPreview(){
  const p=document.getElementById('cssPreview');if(!p)return;
  const font=document.getElementById('cssFont')?.value||'"Noto Serif KR",serif';
  const line=document.getElementById('cssLine')?.value||'1.9';
  const size=document.getElementById('cssFontSize')?.value||'1em';
  const margin=document.getElementById('cssMargin')?.value||'1.5em 1.8em';
  const textColor=document.getElementById('cssTextColor')?.value||'';
  const bgColor=document.getElementById('cssBgColor')?.value||'';
  const align=document.querySelector('input[name="cssAlign"]:checked')?.value||'justify';
  const titleStyle=document.querySelector('input[name="cssTitleStyle"]:checked')?.value||'center';
  p.style.cssText=`font-family:${font};line-height:${line};font-size:${size};padding:${margin};${textColor?'color:'+textColor+';':''}${bgColor?'background:'+bgColor+';':''}text-align:${align};border-radius:8px`;
  const te=document.getElementById('cssPreviewTitle');
  if(te){
    te.style.textAlign=titleStyle==='left'?'left':'center';
    te.style.borderBottom=titleStyle==='underline'?'2px solid currentColor':'none';
    te.style.paddingBottom=titleStyle==='underline'?'6px':'0';
    te.style.border=titleStyle==='box'?'1.5px solid currentColor':'none';
    te.style.padding=titleStyle==='box'?'4px 14px':'0';
    te.style.borderRadius=titleStyle==='box'?'5px':'0';
    te.style.display='block';
  }
}

// 📂 Module: FileHandlers (드롭·파일 입력 처리)
// ══════════════════════════════════════════
function handleTxt(files, append=false){
  const txts=Array.from(files).filter(f=>f.name.endsWith('.txt'));
  if(!txts.length)return;

  // append 모드: 기존 파일에 추가 (중복 제거)
  if(append&&S.txtFiles.length){
    const existing=new Set(S.txtFiles.map(f=>f.name));
    const newFiles=txts.filter(f=>!existing.has(f.name));
    if(!newFiles.length){Toast.warn('이미 추가된 파일이에요.');return;}
    S.txtFiles=[...S.txtFiles,...newFiles];
  }else{
    S.txtFiles=smartSortFiles(txts); // 스마트 정렬 적용
  }

  document.getElementById('txtDz').className='dz ok';
  document.getElementById('convertResetBar').style.display='flex';
  _chaptersCache=null; // 캐시 무효화

  renderTxtFileList();

  // 자동 미리보기
  if(document.getElementById('optAutoPreview')?.checked) setTimeout(()=>previewToc(),300);

  // 메타데이터 자동 채우기 (첫 파일 기준)
  const stem=S.txtFiles[0].name.replace(/\.txt$/i,'');
  let title=stem,author='';
  let m=stem.match(/^\[(.+?)\]\s*(.+)$/);
  if(m){author=m[1].trim();title=m[2].trim();}
  else{m=stem.match(/^(.+?)\s*@\s*(.+)$/);if(m){title=m[1].trim();author=m[2].trim();}}
  if(!document.getElementById('title').value) document.getElementById('title').value=title;
  if(!document.getElementById('author').value) document.getElementById('author').value=author;
}

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
      'border-radius:6px;background:var(--accent-bg);box-shadow:0 4px 16px rgba(0,0,0,.2)';
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
      const moved=S.txtFiles.splice(st.fromIdx,1)[0];
      S.txtFiles.splice(toIdx,0,moved);
      _chaptersCache=null;
      renderTxtFileList();
    }

    _touchDragState=null;
  });
}

function renderTxtFileList(){
  const files=S.txtFiles;
  const listEl=document.getElementById('txtSortList');
  const countEl=document.getElementById('txtFileCount');
  const infoEl=document.getElementById('txtInfo');
  const listWrap=document.getElementById('txtFileList');
  if(!listEl) return;

  // 기존 info 영역 간단 요약
  infoEl.style.display='block';
  infoEl.textContent='✅ '+files.length+'개 파일 선택됨';
  listWrap.style.display='block';
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

    // 인코딩 비동기 감지
    detectEncoding(f).then(enc=>{
      const encBadge=document.createElement('span');
      encBadge.className='txt-file-enc';
      encBadge.textContent=enc.toUpperCase().replace('-','');
      const rmBtn=row.querySelector('.txt-file-rm');
      if(rmBtn) row.insertBefore(encBadge,rmBtn);
    });

    // ✕ 클릭으로 개별 파일 제거
    row.querySelector('.txt-file-rm').onclick=e=>{
      e.stopPropagation();
      const idx=parseInt(e.target.dataset.idx);
      S.txtFiles.splice(idx,1);
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
      const moved=S.txtFiles.splice(fromIdx,1)[0];
      S.txtFiles.splice(toIdx,0,moved);
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

// 구글 이미지 검색창 열기 (제목 자동 완성)
// URL 입력 시 실시간 미리보기
function previewCoverUrl(inpId, thumbId, nameId, mode){
  const url=document.getElementById(inpId)?.value.trim();
  if(!url||!url.startsWith('http')) return;
  if(thumbId){
    const thumb=document.getElementById(thumbId);
    const img=new Image();
    img.crossOrigin='anonymous';
    img.onload=()=>{
      thumb.innerHTML='<img src="'+url+'" style="opacity:.6">';
    };
    img.onerror=()=>{}; // CORS 차단 시 조용히 실패
    img.src=url;
  }
}

// URL 적용 — canvas로 blob 변환 (CORS 통과 시) 또는 직접 fetch
async function applyCoverUrl(inpId, thumbId, nameId, mode){
  const url=document.getElementById(inpId)?.value.trim();
  if(!url){Toast.warn('이미지 URL을 입력해주세요.');return;}
  if(!url.startsWith('http')){Toast.warn('http:// 또는 https:// 로 시작하는 URL을 입력해주세요.');return;}

  const btn=event.target;
  const origText=btn.textContent;
  btn.textContent='로딩 중...';btn.disabled=true;

  try{
    // 방법 1: canvas crossOrigin으로 blob 변환
    const blob=await urlToBlob(url);
    const ext=url.split('?')[0].split('.').pop().toLowerCase().replace(/[^a-z]/g,'') || 'jpg';
    const validExt=['jpg','jpeg','png','webp','gif'].includes(ext)?ext:'jpg';
    const fname='cover_url.'+validExt;
    const file=new File([blob],fname,{type:blob.type||'image/jpeg'});

    if(mode==='convert'){
      S.coverFile=file;
      if(nameId) document.getElementById(nameId).textContent='✅ URL 표지 적용';
      document.getElementById('coverDz').classList.add('ok');
      if(thumbId){
        const dataUrl=await blobToDataUrl(blob);
        document.getElementById(thumbId).innerHTML='<img src="'+dataUrl+'">';
      }
      document.getElementById(inpId).value='';
    } else {
      // 일괄변환: 공통 표지 File 저장
      B.urlCoverFile=file;
      document.getElementById('batchCoverDrop').classList.add('ok');
      document.getElementById('batchCoverDrop').querySelector('div').textContent='✅ URL 표지 적용';
      document.getElementById(inpId).value='';
    }
    btn.textContent='✅ 적용됨';
    setTimeout(()=>{btn.textContent=origText;btn.disabled=false;},1500);
  }catch(e){
    btn.textContent=origText;btn.disabled=false;
    // CORS 차단 안내
    showCorsHelp(inpId, url, thumbId, nameId, mode);
  }
}

function showCorsHelp(inpId, url, thumbId, nameId, mode){
  // CORS 차단 시 대안 안내 모달
  const overlay=document.createElement('div');
  overlay.style.cssText='position:fixed;inset:0;background:rgba(0,0,0,.6);z-index:600;display:flex;align-items:center;justify-content:center';
  overlay.innerHTML=`
    <div style="background:var(--panel);border-radius:12px;padding:24px;max-width:440px;width:90vw;box-shadow:0 8px 40px rgba(0,0,0,.3)">
      <h3 style="font-size:14px;font-weight:700;margin-bottom:10px">⚠️ 이미지를 직접 가져올 수 없어요</h3>
      <p style="font-size:12px;color:var(--text2);margin-bottom:14px;line-height:1.7">
        이 이미지는 외부 사이트 보안(CORS) 정책으로 직접 가져올 수 없어요.<br>
        아래 방법 중 하나를 사용해주세요.
      </p>
      <div style="display:flex;flex-direction:column;gap:8px;margin-bottom:16px">
        <div style="background:var(--bg2);border-radius:8px;padding:10px;font-size:12px">
          <b>방법 1 (권장)</b> — 구글 이미지에서 이미지를 <b>다운로드</b>한 뒤<br>
          드래그앤드롭으로 표지에 넣기
        </div>
        <div style="background:var(--bg2);border-radius:8px;padding:10px;font-size:12px">
          <b>방법 2</b> — 이미지 페이지를 열어서<br>
          이미지를 <b>다른 이름으로 저장</b> 후 드래그앤드롭
        </div>
        <div style="background:var(--bg2);border-radius:8px;padding:10px;font-size:12px">
          <b>방법 3</b> — 아래 버튼으로 이미지 페이지 열기 →<br>
          이미지 우클릭 → 다른 이름으로 저장
        </div>
      </div>
      <div style="display:flex;gap:8px;justify-content:flex-end">
        <button class="btn btn-ghost btn-sm" onclick="this.closest('div[style*=fixed]').remove()">닫기</button>
        <button class="btn btn-blue btn-sm" onclick="window.open('${url}','_blank');this.closest('div[style*=fixed]').remove()">🔗 이미지 페이지 열기</button>
      </div>
    </div>`;
  document.body.appendChild(overlay);
  overlay.onclick=e=>{if(e.target===overlay)overlay.remove();};
}

async function urlToBlob(url){
  // canvas crossOrigin 방식
  return new Promise((resolve,reject)=>{
    const img=new Image();
    img.crossOrigin='anonymous';
    img.onload=()=>{
      const canvas=document.createElement('canvas');
      canvas.width=img.naturalWidth||img.width;
      canvas.height=img.naturalHeight||img.height;
      canvas.getContext('2d').drawImage(img,0,0);
      canvas.toBlob(b=>{
        if(b) resolve(b);
        else reject(new Error('canvas toBlob 실패'));
      },'image/jpeg',0.92);
    };
    img.onerror=()=>reject(new Error('CORS 차단'));
    img.src=url+'?'+(Date.now()); // 캐시 우회 시도
  });
}

function blobToDataUrl(blob){
  return new Promise(res=>{
    const r=new FileReader();
    r.onload=e=>res(e.target.result);
    r.readAsDataURL(blob);
  });
}

function handleCover(files){
  const f=files[0];if(!f)return;
  S.coverFile=f;
  document.getElementById('coverName').textContent='✅ '+f.name;
  document.getElementById('coverDz').classList.add('ok');
  const r=new FileReader();
  r.onload=e=>document.getElementById('coverThumb').innerHTML='<img src="'+e.target.result+'">';
  r.readAsDataURL(f);
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
  const c=document.getElementById('illTags');c.innerHTML='';
  const willConvert=document.getElementById('optImgConvert')?.checked!==false;
  S.illFiles.forEach((f,i)=>{
    const ext=f.name.split('.').pop().toLowerCase();
    const isJpg=['jpg','jpeg'].includes(ext);
    const needsConvert=!isJpg&&willConvert;
    const fmtBadge=isJpg
      ? `<span style="font-size:9px;background:var(--green-bg);color:var(--green);border-radius:3px;padding:1px 4px;font-weight:700">JPG</span>`
      : needsConvert
        ? `<span style="font-size:9px;background:var(--yellow-bg);color:var(--yellow);border-radius:3px;padding:1px 4px;font-weight:700">${ext.toUpperCase()}→JPG</span>`
        : `<span style="font-size:9px;background:var(--blue-bg);color:var(--blue);border-radius:3px;padding:1px 4px;font-weight:700">${ext.toUpperCase()}</span>`;

    const t=document.createElement('div');
    t.className='tag';
    t.style.cssText='display:flex;align-items:center;gap:5px;padding:4px 8px';
    t.title=f.name+(needsConvert?' (변환 예정)':'');
    t.dataset.idx=i; // ★ 인덱스 명시 저장

    // 썸네일
    const thumb=document.createElement('img');
    thumb.style.cssText='width:22px;height:22px;object-fit:cover;border-radius:3px;flex-shrink:0;border:1px solid var(--border)';
    thumb.alt=f.name;
    const url=URL.createObjectURL(f);
    thumb.src=url;
    thumb.dataset.objUrl=url;
    thumb.onerror=()=>{thumb.style.display='none';};

    const label=document.createElement('span');
    label.style.cssText='max-width:120px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:11px';
    label.textContent=f.name;

    // 챕터 인덱스 배지 — 파일명에서 파싱해서 어느 챕터에 삽입될지 표시
    const stem=f.name.replace(/\.[^.]+$/,'');
    const mi=stem.match(/^(\d+)(?:_(\d+))?/);
    const chIdxBadge=mi ? (()=>{
      const chIdx=parseInt(mi[1]);      // 1-based 표시용
      const sub=mi[2]?('-'+parseInt(mi[2])):'';
      const b=document.createElement('span');
      b.style.cssText='font-size:9px;background:var(--accent-bg);color:var(--accent);border-radius:3px;padding:1px 5px;font-weight:700;flex-shrink:0;white-space:nowrap';
      b.textContent=chIdx+'번째'+sub;
      b.title=chIdx+'번째 챕터 앞에 삽입 (파일명 기준 인덱스)';
      return b;
    })() : null;

    const badge=document.createElement('span');
    badge.innerHTML=fmtBadge;

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
      '<input placeholder="파일명 (예: 16.jpg)" id="mp'+id+'" style="flex:2;min-width:100px" oninput="onManualIllName('+id+')">'+
      '<button class="btn btn-ghost btn-sm" onclick="browseManual('+id+')">찾기</button>'+
      '<input type="number" placeholder="중심 화 번호" id="mc'+id+'" style="width:90px" min="1" oninput="loadIllRange('+id+')">'+
      '<select id="mpos'+id+'"><option value="before">챕터 앞</option><option value="after">챕터 뒤</option></select>'+
      '<button class="btn btn-sm" style="background:var(--accent-bg);color:var(--accent)" data-action="removeManualIllRow" data-row-id="mr'+id+'">✕</button>'+
    '</div>'+
    '<div class="mill-preview" id="mpv'+id+'">'+
      '<div style="font-size:11px;color:var(--text2);padding:4px 2px">화 번호를 입력하면 해당 화 ±1화 범위를 보여줘요.</div>'+
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
    pv.innerHTML='<div style="font-size:11px;color:var(--text2);padding:4px 2px">화 번호를 입력하면 해당 화 ±1화 범위를 보여줘요.</div>';
    pv.classList.remove('show');
    return;
  }

  const chapters=await getCachedChapters();
  if(!chapters.length){pv.classList.remove('show');return;}

  // extractChNum으로 중심 챕터 인덱스 찾기
  const centerCi=chapters.findIndex(([h])=>extractChNum(h)===chNum);

  if(centerCi<0){
    pv.innerHTML='<div class="mill-ch-match"><div class="mill-ch-title" style="color:var(--accent)">⚠️ '+chNum+'화를 찾지 못했어요</div>'+
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
  _illRangeCache[id]={chNum, range:range.map(({ci,role})=>({ci,role,...{heading:chapters[ci][0],body:chapters[ci][1]||''}}))} ;

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
      '<div class="'+cardClass+'" onclick="selectIllRangeCard('+id+','+ci+')" title="클릭해서 이 화로 삽입 위치 설정">'+
        '<div class="rc-role">'+roleLabel+(isSel?' ✓':'')+'</div>'+
        '<div class="rc-title">'+titleHtml+'</div>'+
        '<div class="rc-body">'+bodyHtml+'</div>'+
      '</div>';
  });
  cardsHtml+='</div>';

  // 키워드 검색바
  const kwBar=
    '<div class="mill-kw-bar">'+
      '<span style="font-size:11px;color:var(--text2);white-space:nowrap">🔍 범위 내 검색:</span>'+
      '<input id="mkw'+id+'" placeholder="키워드로 정확한 위치 찾기" value="'+escHtml(kw)+'" '+
             'oninput="debounceIllKwSearch('+id+')">'+
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
  const chNum=extractChNum(ch.heading);
  if(chNum) document.getElementById('mc'+id).value=chNum;

  // 미리보기 재렌더 (선택 표시)
  const kw=document.getElementById('mkw'+id)?.value||'';
  renderIllRangePanel(id, kw, ci);
}

// 키워드 검색 (디바운스 · 범위 내에서만)
let _kwTimer={};
function debounceKwSearch(id){ clearTimeout(_kwTimer[id]); _kwTimer[id]=setTimeout(()=>kwSearch(id),350); }
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

// startConvert에서 수동삽화 읽는 로직도 수정 필요 — _illRangeCache에서 선택된 ci 기반으로
function getManualIllTarget(id){
  // 현재 선택된 카드의 챕터 인덱스 반환 (선택 안된 경우 중심 화 번호 사용)
  const chNum=parseInt(document.getElementById('mc'+id)?.value);
  return {ch:chNum||null, pos:document.getElementById('mpos'+id)?.value||'before'};
}


async function kwSearch(id){
  const kw=document.getElementById('mk'+id)?.value.trim();
  const pv=document.getElementById('mpv'+id);
  if(!kw||kw.length<1){pv.classList.remove('show');return;}

  const chapters=await getCachedChapters();
  if(!chapters.length){pv.classList.remove('show');return;}

  const kwEsc=kw.replace(/[.*+?^${}()|[\]\\]/g,'\\$&');
  const kwRx=new RegExp(kwEsc,'g');

  // 1단계: 키워드가 있는 챕터 인덱스 전체 탐색 (제목 + 본문 전체)
  let centerIdx=-1;
  let totalMatches=0;
  for(let ci=0;ci<chapters.length;ci++){
    const [heading,body]=chapters[ci];
    if(heading.includes(kw)||(body||'').includes(kw)){
      if(centerIdx<0) centerIdx=ci; // 첫 번째 발견 챕터
      totalMatches++;
    }
  }

  if(centerIdx<0){
    pv.innerHTML=
      '<div class="mill-ch-match">'+
        '<div class="mill-ch-title" style="color:var(--text2)">검색 결과 없음</div>'+
        '<div class="mill-ch-body">&#39;'+escHtml(kw)+'&#39; 를 포함한 챕터가 없어요.<br>'+
        '<span style="font-size:10px">다른 키워드를 시도하거나 화 번호 모드를 사용해보세요.</span></div>'+
      '</div>';
    pv.classList.add('show');
    return;
  }

  // 2단계: 발견 챕터 ±1화 (총 최대 3화) 표시
  const range=[];
  if(centerIdx>0)                    range.push({ci:centerIdx-1, role:'prev'});
                                     range.push({ci:centerIdx,   role:'match'});
  if(centerIdx<chapters.length-1)    range.push({ci:centerIdx+1, role:'next'});

  const moreCount=totalMatches-1;

  let html=
    '<div class="mill-ch-match">'+
      '<div class="mill-ch-title" style="display:flex;justify-content:space-between;align-items:center">'+
        '<span>🔍 <b>'+escHtml(kw)+'</b> 발견 · 전후 3화</span>'+
        (moreCount>0?'<span style="font-size:10px;color:var(--text2)">외 '+moreCount+'곳 더</span>':'')+
      '</div>'+
      '<div class="mill-kw-list">';

  range.forEach(({ci,role})=>{
    const [heading,body]=chapters[ci];
    const isMatch=role==='match';

    // 키워드 주변 컨텍스트: 발견 화는 본문에서 키워드 앞뒤 40자, 나머지는 본문 첫 줄
    let snippet='';
    if(isMatch){
      const fullText=heading+' '+(body||'');
      const idx=fullText.indexOf(kw);
      if(idx>=0){
        const s=Math.max(0,idx-30);
        const e=Math.min(fullText.length,idx+kw.length+40);
        snippet=fullText.slice(s,e).replace(/\n/g,' ');
      }
    } else {
      snippet=(body||'').split('\n').filter(l=>l.trim())[0]||'';
    }

    // 키워드 하이라이트 (발견 화만)
    const hiSnippet=isMatch
      ? snippet.replace(new RegExp(kwEsc,'g'),'<span class="mill-kw-highlight">'+escHtml(kw)+'</span>')
      : escHtml(snippet);
    const hiTitle=isMatch
      ? escHtml(heading).replace(new RegExp(kwEsc,'g'),'<span class="mill-kw-highlight">'+escHtml(kw)+'</span>')
      : escHtml(heading);

    const roleIcon  = role==='prev'?'⬆':'next'===role?'⬇':'🎯';
    const roleLabel = role==='prev'?'이전화':role==='next'?'다음화':'발견';
    const rowStyle  = isMatch
      ? 'border:1.5px solid var(--accent);background:var(--accent-bg);border-radius:6px;'
      : '';

    html+=
      '<div class="mill-kw-item" id="mkwi_'+id+'_'+ci+'" style="'+rowStyle+'" '+
           'onclick="selectKwResult('+id+',\''+escAttr(heading)+'\','+ci+')">'+
        '<div style="display:flex;flex-direction:column;min-width:34px;align-items:center;gap:1px">'+
          '<span style="font-size:12px">'+roleIcon+'</span>'+
          '<span style="font-size:9px;color:var(--text2)">'+roleLabel+'</span>'+
        '</div>'+
        '<div style="flex:1;min-width:0">'+
          '<div style="font-weight:'+(isMatch?'700':'500')+';font-size:11px">'+hiTitle+'</div>'+
          '<div style="color:var(--text2);font-size:10px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">&#183;&#183;&#183;'+hiSnippet+'&#183;&#183;&#183;</div>'+
        '</div>'+
      '</div>';
  });

  html+='</div></div>';
  pv.innerHTML=html;
  pv.classList.add('show');
}

function selectKwResult(id, heading, ci){
  // 선택 표시 갱신
  document.querySelectorAll('[id^="mkwi_'+id+'_"]').forEach(el=>el.classList.remove('selected'));
  event.currentTarget.classList.add('selected');
  // ★ 실제 화 번호 인풋에 반영 (ci = 챕터 인덱스)
  const mcEl=document.getElementById('mc'+id);
  if(mcEl&&ci!=null){
    // 챕터 인덱스 → 서문 제외 실제 순번 계산
    mcEl.value=ci+1;
    // _illRangeCache 갱신을 위해 loadIllRange 재호출
    loadIllRange(id);
  }
}

let _autoSplitActive=false; // 간격 분할 모드 활성 플래그

// 파일명에서 총 화수 추출 (예: "소설_1-277" → 277, "소설_1234화" → 1234)
function extractTotalFromFilename(filename){
  const stem=filename.replace(/\.[^.]+$/,'');
  // "N-M" 형태: 마지막 숫자 M이 총 화수
  let m=stem.match(/-(\d+)[^\d]*(?:완|完|edit|_|$)/i);
  if(m) return parseInt(m[1]);
  m=stem.match(/[_-](\d+)[_-]\d+/);
  if(m) return null; // 범위 불명확
  m=stem.match(/(\d{2,4})화/);
  if(m) return parseInt(m[1]);
  m=stem.match(/[_-](\d{2,4})[^\d]*$/);
  if(m) return parseInt(m[1]);
  return null;
}

// tocItems(간격분할 결과)를 [heading, body] 쌍으로 조립
// ══════════════════════════════════════════
// 📊 Module: Progress (진행률 바 UI)
// ══════════════════════════════════════════
// ✨ Module: Convert (변환 실행 플로우)
// ══════════════════════════════════════════
async function startConvert(){
  if(!S.txtFiles.length){Toast.warn('TXT 파일을 선택해주세요.');return;}
  const convertStart=Date.now();
  document.getElementById('progWrap').classList.add('show');
  document.getElementById('resultBox').classList.remove('show');
  document.getElementById('errBox').classList.remove('show');

  // ── 단계별 진행 표시 ──
  setProgress(0,'① 파일 읽는 중...');

  // ★ 파싱 중단 버튼 표시
  let _convertAborted=false;
  const progWrapEl=document.getElementById('progWrap');
  let abortBtn=document.getElementById('convertAbortBtn');
  if(!abortBtn){
    abortBtn=document.createElement('button');
    abortBtn.id='convertAbortBtn';
    abortBtn.className='btn';
    abortBtn.style.cssText='font-size:11px;padding:4px 12px;background:var(--accent-bg);color:var(--accent);border:1.5px solid var(--accent);border-radius:6px;margin-top:6px;display:block';
    abortBtn.textContent='⛔ 변환 중단';
    progWrapEl?.appendChild(abortBtn);
  }
  abortBtn.style.display='block';
  abortBtn.onclick=()=>{
    _convertAborted=true;
    // Worker에도 Abort 신호
    if(_parserWorker) _parserWorker.postMessage({type:'ABORT',id:-1});
    abortBtn.style.display='none';
    setProgress(0,'⛔ 중단됨');
    document.getElementById('progWrap').classList.remove('show');
  };

  try{
    const sorted=[...S.txtFiles];
    const totalFiles=sorted.length;
    // 파일별 진행률 표시
    const raws=[];
    for(let fi=0;fi<totalFiles;fi++){
      setProgress(Math.round(fi/totalFiles*12)+1,
        `① 파일 읽는 중... (${fi+1}/${totalFiles}) ${sorted[fi].name}`);
      await yieldToMain();
      raws.push(await fileToText(sorted[fi]));
    }
    const raw=raws.join('\n\n');
    setProgress(14,'① 파일 읽기 완료');
    await yieldToMain();

    setProgress(15,'② 챕터 패턴 분석 중...');
    await yieldToMain();
    const customPat=document.getElementById('pattern').value.trim();
    const disabledTitles=new Set(S.tocItems.filter(t=>!t.enabled).map(t=>t.title));

    let chapters;
    if(_autoSplitActive&&_autoSplitLines&&S.tocItems.length>0){
      setProgress(20,'② 간격 분할 적용 중...');
      await yieldToMain();
      // 간격 분할 모드: tocItems 기반 챕터 조립 (enabled + 편집된 제목 반영)
      chapters=buildChaptersFromTocItems(_autoSplitLines, S.tocItems);
    } else {
      setProgress(18,'② 목차 패턴 감지 중...');
      await yieldToMain();
      // ★ 대용량(10만 줄 이상)은 비동기 파서, 소형은 동기 처리
      const lineCount=(raw.match(/\n/g)||[]).length;
      if(lineCount>=100000){
        chapters=await splitChaptersAsync(raw,customPat,(pct,msg)=>setProgress(pct,msg));
      } else {
        chapters=splitChapters(raw,customPat);
      }
      setProgress(24,`② 챕터 분리 완료 (${chapters.length}개)`);
      await yieldToMain();
      // ★ 인라인 편집된 tocItems 제목 반영 (originalTitle → 편집된 title)
      if(S.tocItems.length>0){
        const editedMap=new Map();
        S.tocItems.forEach(t=>{
          if(t.originalTitle&&t.title!==t.originalTitle) editedMap.set(t.originalTitle,t.title);
        });
        if(editedMap.size>0){
          chapters=chapters.map(([h,b])=>[editedMap.has(h)?editedMap.get(h):h, b]);
        }
      }
      // disabled 챕터는 인접 챕터 본문에 병합
      if(disabledTitles.size>0){
        setProgress(28,'② 비활성 챕터 병합 중...');
        await yieldToMain();
        const merged=[];let pb='';
        for(const[h,b]of chapters){
          if(disabledTitles.has(h)){
            pb+=(pb?'\n\n':'')+h+'\n'+b;
          } else {
            if(pb&&merged.length>0){
              merged[merged.length-1][1]+='\n\n'+pb;
              pb='';
            } else if(pb){
              // 아직 merged 없음 → 이 챕터 본문 앞에 붙임
              merged.push([h, pb+'\n\n'+b]);
              pb='';
              continue;
            }
            merged.push([h,b]);
          }
        }
        if(pb&&merged.length>0) merged[merged.length-1][1]+='\n\n'+pb;
        chapters=merged;
      }
    }
    setProgress(30,'③ 삽화 파싱 중...');
    await yieldToMain();
    // 삽화 파싱 — 파일명 숫자 = 챕터 인덱스(1-based)
    // 01.jpg → chapters[0] (첫 번째 챕터)
    // 100.jpg → chapters[99] (100번째 챕터)
    // 01_01.jpg → chapters[0]의 첫 번째 삽화
    // 01_02.jpg → chapters[0]의 두 번째 삽화
    const autoIlls=[];
    for(const f of S.illFiles){
      const stem=f.name.replace(/\.[^.]+$/,'');
      const m=stem.match(/^(\d+)(?:_(\d+))?/);
      if(m){
        const chIdx=parseInt(m[1])-1;   // 1-based → 0-based 인덱스
        const order=parseInt(m[2]||'1'); // 서브넘버 (01_01 → 1, 01_02 → 2)
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
      const ch=parseInt(document.getElementById('mc'+id)?.value);
      if(ch) manualIlls.push({file,ch,order:999,pos});
      // 키워드도 병행 저장 (buildEpub에서 kw 매칭도 지원)
      const kw=document.getElementById('mkw'+id)?.value.trim();
      if(!ch&&kw) manualIlls.push({file,kw,pos});
    });
    const illMap=[...autoIlls,...manualIlls];
    const title=document.getElementById('title').value.trim()||'제목 없음';
    const author=document.getElementById('author').value.trim()||'작자 미상';
    const useItalic=document.getElementById('optItalic').checked;

    // ★ 표지 폴백: 표지 이미지 없을 때 Canvas로 텍스트 커버 자동 생성
    let effectiveCover=S.coverFile;
    if(!effectiveCover){
      setProgress(35,'③ 텍스트 표지 생성 중...');
      await yieldToMain();
      effectiveCover=await generateTextCover(title, author);
    }

    setProgress(40,'④ EPUB 빌드 중...');
    await yieldToMain();
    const blob=await buildEpub({title,author,chapters,coverFile:effectiveCover,illMap,useItalic},
      (pct,msg)=>setProgress(40+Math.round(pct*0.52), msg));
    S.epubBlob=blob;
    S.epubName=title.replace(/[\\/:*?"<>|]/g,'_')+'.epub';
    const elapsed=((Date.now()-convertStart)/1000).toFixed(1);
    setProgress(100,'✅ 변환 완료! ('+elapsed+'초)');
    document.getElementById('convertAbortBtn')?.style&&(document.getElementById('convertAbortBtn').style.display='none');

    // ★ 메모리 정리: 대용량 원문 데이터 해제
    // _fullRawLines는 목차 미리보기에서 사용 후 더 이상 불필요
    if(_fullRawLines&&_fullRawLines.length>50000){
      _fullRawLines=null;
    }
    // autoSplitLines도 변환 완료 후 해제
    if(_autoSplitLines&&_autoSplitLines.length>50000){
      _autoSplitLines=null;
    }
    // 챕터 캐시는 미리보기/분리에서 필요하므로 유지 (단, 대용량은 제한)
    document.getElementById('resultMsg').textContent=S.epubName;
    showResultStats('resultStats',[
      {
        label: /^\(\d+\/\d+\)$/.test(chapters.filter(([h])=>h!=='서문')[0]?.[0]||'') ? '페이지' : '챕터',
        value: chapters.filter(([h])=>h!=='서문').length+'개'
      },
      {label:'파일 크기',value:(blob.size/1024/1024).toFixed(1)+'MB'},
      {label:'소요 시간',value:elapsed+'초'},
    ]);
    // 미리보기/분리용 챕터 저장
    _previewChapters=chapters;
    // ── 히스토리 저장 (IndexedDB 비동기) ──
    await saveHistory({
      title,author,
      chapterCount:chapters.filter(([h])=>h!=='서문').length,
      sizeMB:(blob.size/1024/1024).toFixed(1),
      elapsed,
      date:new Date().toLocaleString('ko-KR',{month:'short',day:'numeric',hour:'2-digit',minute:'2-digit'}),
      name:S.epubName,
      blob
    });
    document.getElementById('splitSec').style.display='block';
    document.getElementById('resultBox').classList.add('show');
  }catch(e){
    console.error(e);
    document.getElementById('progWrap').classList.remove('show');
    document.getElementById('errBox').textContent='❌ '+friendlyError(e);
    document.getElementById('errBox').classList.add('show');
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
  if(!S.epubBlob){return;}
  // 변환된 챕터 데이터로 미리보기 (최근 변환 기억)
  if(!_previewChapters.length){Toast.info('변환 후 사용할 수 있어요.');return;}
  _previewIdx=0;
  _previewFont=document.getElementById('cssFont')?.value||'"Noto Serif KR",serif';
  _previewLine=document.getElementById('cssLine')?.value||'1.9';
  renderPreview();
  document.getElementById('previewModal').classList.add('show');
  document.body.style.overflow='hidden'; // 모달 열리면 배경 스크롤 차단
  document.body.style.touchAction='none';
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
    if(b.split('\n').length>30) html+='<p style="color:var(--text2);font-size:11px;margin-top:8px">... (이하 생략)</p>';
    html+='</div>';
  }
  body.innerHTML=html;
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
  document.getElementById('previewModal').classList.remove('show');
  document.body.style.overflow=''; // 스크롤 복원
  document.body.style.touchAction='';
}

// ══════════════════════════════════════════
// ✂️  Module: Split (EPUB N화씩 분리)
// ══════════════════════════════════════════
async function startSplit(){
  if(!S.epubBlob||!_previewChapters.length){Toast.warn('먼저 EPUB을 변환해주세요.');return;}
  const n=parseInt(document.getElementById('splitN').value)||100;
  const title=document.getElementById('title').value.trim()||'제목 없음';
  const author=document.getElementById('author').value.trim()||'작자 미상';
  const useItalic=document.getElementById('optItalic')?.checked!==false;
  const coverFile=S.coverFile;
  const listEl=document.getElementById('splitList');
  listEl.innerHTML='<div style="font-size:12px;color:var(--text2);grid-column:1/-1">분리 중...</div>';
  document.getElementById('splitSec').style.display='block';

  const chapters=_previewChapters.filter(([h])=>h!=='서문');
  const parts=[];
  for(let i=0;i<chapters.length;i+=n){
    parts.push(chapters.slice(i,i+n));
  }

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
    div.innerHTML='<div style="font-weight:600;margin-bottom:4px">'+escHtml(partTitle)+'</div>'+
      '<div style="font-size:11px;color:var(--text2)">'+escHtml(firstCh)+' ~ '+escHtml(lastCh)+'</div>'+
      '<div id="sps_'+pi+'" style="font-size:11px;color:var(--text2);margin-top:4px">생성 중...</div>';
    listEl.appendChild(div);

    try{
      const blob=await buildEpub({title:partTitle,author,chapters:part,coverFile:pi===0?coverFile:null,illMap:[],useItalic},null);
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
  const blob=await zip.generateAsync({type:'blob',compression:'DEFLATE'});
  const url=URL.createObjectURL(blob);
  const a=document.createElement('a');a.href=url;a.download='epub_분리.zip';a.click();
  setTimeout(()=>URL.revokeObjectURL(url),1000);
}

function downloadEpub(){
  if(!S.epubBlob)return;
  const a=document.createElement('a');a.href=URL.createObjectURL(S.epubBlob);a.download=S.epubName;a.click();
  setTimeout(()=>URL.revokeObjectURL(a.href),1000);
}

// ══════════════════════════════════════════
// 📦 Module: Batch (일괄 변환 플로우)
// ══════════════════════════════════════════
function handleBatchTxt(files){
  const txts=Array.from(files).filter(f=>f.name.endsWith('.txt'));
  if(!txts.length)return;
  B.txtFiles=txts.sort((a,b)=>sortKey(a.name)<sortKey(b.name)?-1:1);
  B.patterns={};
  B.sampleTexts={};
  B.totalChs={};
  const dz=document.getElementById('batchTxtDrop');
  dz.classList.add('ok');
  dz.querySelector('.dz-text').textContent='✅ '+txts.length+'개 파일 선택됨';
  document.getElementById('batchResetBar').style.display='flex';
  renderBatchList();
  document.getElementById('batchListSec').style.display='block';
}

function handleBatchCover(files){
  const imgs=Array.from(files).filter(f=>/\.(jpg|jpeg|png|webp|bmp|tiff|tif|avif)$/i.test(f.name));
  imgs.forEach(f=>{const stem=f.name.replace(/\.[^.]+$/,'');B.coverMap[stem]=f;});
  document.getElementById('batchCoverDrop').classList.add('ok');
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

  return null;
}

function renderBatchList(){
  const c=document.getElementById('batchList');c.innerHTML='';
  B.txtFiles.forEach((f,i)=>{
    const stem=f.name.replace(/\.txt$/i,'');
    let title=stem,author='';
    let m=stem.match(/^\[(.+?)\]\s*(.+)$/);
    if(m){author=m[1].trim();title=m[2].trim();}
    else{m=stem.match(/^(.+?)\s*@\s*(.+)$/);if(m){title=m[1].trim();author=m[2].trim();}}
    const cover=B.coverMap[stem]||findFuzzyCover(stem)||B.urlCoverFile||null;
    const d=document.createElement('div');d.className='batch-item';d.id='bi_'+i;
    const thumbHtml=cover
      ?'<div class="batch-thumb" onclick="batchPickCover('+i+')" title="클릭해서 변경"><img id="bthumb_'+i+'" src=""></div>'
      :'<div class="batch-thumb" onclick="batchPickCover('+i+')" title="표지 지정">+</div>';
    d.innerHTML='<div class="batch-header">'+thumbHtml+
      '<div style="flex:1;min-width:0"><div class="batch-title">'+escHtml(title)+'</div>'+
      '<div style="display:flex;align-items:center;gap:6px"><div class="batch-status" id="bst_'+i+'">'+(author?'✒️ '+escHtml(author):'')+'</div>'+
      '<button class="batch-toc-btn" onclick="showBatchToc('+i+',this)" title="목차 미리보기">📋 목차 확인</button></div>'+
      '</div></div>'+
      '<div class="batch-toc-panel" id="btp_'+i+'"></div>'+
      '<div class="batch-prog"><div class="batch-prog-bar" id="bpb_'+i+'" style="width:0"></div></div>';
    c.appendChild(d);
    if(cover){const r=new FileReader();r.onload=e=>{const img=document.getElementById('bthumb_'+i);if(img)img.src=e.target.result;};r.readAsDataURL(cover);}
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
    const totalCh=extractTotalFromFilename(file.name)||0;

    // sampleText와 totalCh 캐시 저장
    B.sampleTexts[idx]=text;
    B.totalChs[idx]=totalCh;
    // 파일별 개별 패턴 우선, 없으면 공통 패턴
    const pat=(B.patterns[idx]||document.getElementById('batchPattern')?.value||'').trim();
    let chapters=[], detectedName='', detectedPct=0;
    if(pat){
      try{
        const rx=new RegExp(pat,'i');
        allLines.forEach((l,i)=>{if(l.trim()&&rx.test(l.trim()))chapters.push({line:i+1,title:l.trim()});});
        detectedName='지정 패턴';
        detectedPct=totalCh>0?chapters.length/totalCh*100:100;
      }catch(e){}
    }
    if(!chapters.length){
      const {rx,name,cnt}=bestPat(text);
      detectedName=name||'';
      if(rx){
        allLines.forEach((l,i)=>{if(l.trim()&&rx.test(l.trim()))chapters.push({line:i+1,title:l.trim()});});
        detectedPct=totalCh>0?chapters.length/totalCh*100:100;
        // 80% 이상이면 패턴 저장
        if(detectedPct>=80||totalCh===0) B.patterns[idx]=rx.source;
      }
    }

    // 중복 제거
    const seen=new Set();
    chapters=chapters.filter(c=>{if(seen.has(c.title))return false;seen.add(c.title);return true;});

    // 80% 미만이면 실패 처리
    const isGood=(detectedPct>=80||totalCh===0)&&chapters.length>=3;

    panel.innerHTML='';
    const HEAD=5, TAIL=5;

    if(!isGood){
      // 실패: 패턴 패널 표시 + 현황
      let failMsg='';
      if(chapters.length<3) failMsg='챕터를 감지하지 못했어요.';
      else failMsg=`${chapters.length}개 감지 (파일 ${totalCh}화 기준 ${detectedPct.toFixed(0)}% - 80% 미달)`;

      panel.innerHTML=
        '<div style="font-size:11px;color:var(--accent);padding:4px;margin-bottom:6px">'+
          '⚠️ '+failMsg+' 아래에서 패턴을 선택해주세요.'+
        '</div>'+
        buildPatPresetPanel(idx,text,totalCh);
    } else {
      // 성공: 챕터 목록 + 패턴 변경 버튼
      const pctStr=totalCh>0?` · ${detectedPct.toFixed(0)}% (${totalCh}화 기준)`:'';
      const info=document.createElement('div');
      info.style.cssText='font-size:11px;color:var(--text2);margin-bottom:6px;display:flex;justify-content:space-between;align-items:center';
      info.innerHTML=
        `<span>총 <b style="color:var(--accent)">${chapters.length}</b>개 챕터${pctStr}${detectedName?' · '+detectedName:''}</span>`+
        '<button class="btn btn-ghost btn-sm" style="font-size:10px" onclick="toggleBatchPreset('+idx+')">✏️ 패턴 변경</button>';
      panel.appendChild(info);

      const presetDiv=document.createElement('div');
      presetDiv.id='bpreset_'+idx;
      presetDiv.style.display='none';
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
          row.style.cssText='text-align:center;color:var(--text3);font-size:10px;padding:3px 0';
          row.textContent='··· '+(chapters.length-HEAD-TAIL)+'개 더 ···';
        } else {
          row.className='batch-toc-row';
          row.innerHTML='<span class="batch-toc-num">'+ch.line+'줄</span><span class="batch-toc-title">'+escHtml(ch.title)+'</span>';
        }
        list.appendChild(row);
      });
      panel.appendChild(list);
    }
    panel.classList.add('show');
    btn.textContent='📋 목차 닫기';
  }catch(e){
    panel.innerHTML='<div style="font-size:11px;color:var(--accent)">오류: '+e.message+'</div>';
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

  const PRESETS = [
    ['[ 파일명.txt ] 형식','^\\.\\s*.+\\.txt\\s*\\]\\s*$',            '[ 0001_제목.txt ] 분리 파일 합본 형식'],
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
    '<div style="margin-top:6px;padding:8px;background:var(--bg);border-radius:8px;border:1px solid var(--border)">' +
    '<div style="font-size:12px;font-weight:700;color:var(--text);margin-bottom:8px">📐 챕터 패턴 선택</div>' +
    '<div style="display:flex;gap:6px;margin-bottom:8px;flex-wrap:wrap">' +
      '<button class="btn btn-ghost btn-sm" style="font-size:10px" onclick="batchPresetCheckAll('+idx+',true)">전체 선택</button>' +
      '<button class="btn btn-ghost btn-sm" style="font-size:10px" onclick="batchPresetCheckAll('+idx+',false)">전체 해제</button>' +
      '<button class="btn btn-ghost btn-sm" style="font-size:10px" onclick="batchPresetAuto('+idx+')">🔍 자동 감지</button>' +
    '</div>' +
    '<div id="bpck_list_'+idx+'" style="display:flex;flex-direction:column;gap:4px">';

  PRESETS.forEach(([label, val, desc])=>{
    const checked = checkedVals.has(val) ? 'checked' : '';
    const cnt = countPat(val);
    const pct = tc>0 ? (cnt/tc*100).toFixed(0) : null;
    const pctStr = pct!==null ? ` (${cnt}개 / ${pct}%${parseFloat(pct)>=80?' ⭐':''})` : (cnt>0?` (${cnt}개)`:'');
    const goodBg = pct!==null&&parseFloat(pct)>=80 ? 'background:var(--green-bg);border-color:var(--green)' : '';

    html +=
      `<label style="display:flex;align-items:flex-start;gap:8px;padding:5px 6px;border-radius:5px;cursor:pointer;border:1px solid var(--border);background:var(--bg2);${goodBg}">` +
        `<input type="checkbox" class="bpck_${idx}" data-val="${escHtml(val)}" ${checked}` +
               ` onchange="applyBatchPreset(${idx})" style="margin-top:2px;flex-shrink:0">` +
        '<div style="min-width:0;flex:1">' +
          '<div style="font-size:12px;font-weight:600;display:flex;gap:6px;align-items:center;flex-wrap:wrap">' +
            escHtml(label) +
            `<span style="font-size:11px;color:${parseFloat(pct)>=80?'var(--green)':'var(--accent)'};font-weight:700">${pctStr}</span>` +
            `<span style="font-size:10px;color:var(--text2);font-weight:400">${escHtml(desc)}</span>` +
          '</div>' +
        '</div>' +
      '</label>';
  });

  html +=
    '</div>' +
    '<div style="margin-top:8px;border-top:1px solid var(--border);padding-top:8px">' +
      '<div style="font-size:11px;font-weight:600;color:var(--text2);margin-bottom:4px">직접 입력 (정규식)</div>' +
      '<div style="display:flex;gap:6px">' +
        `<input class="inp" id="bpat_direct_${idx}" placeholder="직접 입력하거나 위에서 선택" ` +
               `value="${escHtml(curPat)}" style="flex:1;font-size:11px" oninput="applyBatchPreset(${idx})">` +
        `<button class="btn btn-blue btn-sm" onclick="confirmBatchPreset(${idx})">✅ 적용</button>` +
      '</div>' +
      `<div id="bpat_preview_${idx}" style="font-size:10px;color:var(--text2);margin-top:4px">` +
        (curPat?'현재: '+escHtml(curPat):'(자동 감지)') +
      '</div>' +
    '</div>' +
    '</div>';
  return html;
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
  const btn=document.querySelector('#bi_'+idx+' .batch-toc-btn');
  const panel=document.getElementById('btp_'+idx);
  panel.classList.remove('show');
  if(btn){btn.textContent='📋 목차 확인';await showBatchToc(idx,btn);}
}

function batchPickCover(idx){
  const inp=document.createElement('input');inp.type='file';inp.accept='.jpg,.jpeg,.png,.webp';
  inp.onchange=()=>{
    const f=inp.files[0];if(!f)return;
    B.coverMap[B.txtFiles[idx].name.replace(/\.txt$/i,'')]=f;
    const thumb=document.querySelector('#bi_'+idx+' .batch-thumb');
    if(thumb){const r=new FileReader();r.onload=e=>{thumb.innerHTML='<img src="'+e.target.result+'" style="width:100%;height:100%;object-fit:cover">';};r.readAsDataURL(f);}
  };inp.click();
}

async function startBatch(){
  if(!B.txtFiles.length){Toast.warn('TXT 파일을 선택해주세요.');return;}
  B.results=[];
  document.getElementById('batchProgWrap').classList.add('show');
  document.getElementById('batchResultBox').classList.remove('show');
  const total=B.txtFiles.length;
  const globalPat=document.getElementById('batchPattern').value.trim();
  const useItalicBatch=document.getElementById('batchItalic').checked;

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
      // 이벤트 루프 양보 — UI 갱신 보장 (파일 간 블로킹 방지)
      await new Promise(r=>setTimeout(r,0));
      const raw=await fileToText(f);
      const pattern=(B.patterns[i]||globalPat);
      const chapters=splitChapters(raw,pattern);
      const blob=await buildEpub({title,author,chapters,coverFile:cover,illMap:[],useItalic:useItalicBatch},
        pct=>{document.getElementById('bpb_'+i).style.width=(30+pct*0.7)+'%';});
      B.results.push({name:title+'.epub',blob});
      if(item)item.className='batch-item done';
      document.getElementById('bst_'+i).textContent='✅ 완료';
      document.getElementById('bpb_'+i).style.width='100%';
    }catch(e){
      if(item)item.className='batch-item error';
      document.getElementById('bst_'+i).textContent='❌ '+e.message;
    }
  }
  document.getElementById('batchProgBar').style.width='100%';
  document.getElementById('batchProgMsg').textContent='완료! '+B.results.length+'/'+total+'개 성공';
  document.getElementById('batchResultMsg').textContent=B.results.length+'개 epub 생성 완료';
  document.getElementById('batchResultBox').classList.add('show');
}

async function downloadBatchZip(){
  if(!B.results.length)return;
  if(B.results.length===1){const a=document.createElement('a');a.href=URL.createObjectURL(B.results[0].blob);a.download=B.results[0].name;a.click();return;}
  const zip=new JSZip();
  B.results.forEach(r=>zip.file(r.name,r.blob));
  const blob=await zip.generateAsync({type:'blob',compression:'DEFLATE'});
  const a=document.createElement('a');a.href=URL.createObjectURL(blob);a.download='epub_일괄변환.zip';a.click();
  setTimeout(()=>URL.revokeObjectURL(a.href),1000);
}

// ══════════════════════════════════════════
// ✏️  Module: EditEpub (EPUB 편집 진입)
// ══════════════════════════════════════════
// epubDrop 이벤트는 setupDz에서 처리

// ══════════════════════════════════════════
// 🔧 Module: EpubStructure (OPF·NCX 파싱)
// ══════════════════════════════════════════

// OPF spine toc 속성 → manifest → href 순서로 메인 NCX를 정확히 찾음
// bookN_toc.ncx 같은 챕터별 NCX를 잘못 잡는 버그 방지
function findMainNcx(zipFiles, opfText, opfBase){
  const keys=Object.keys(zipFiles);
  // 1순위: spine toc="id" → manifest에서 해당 id의 href
  const tocIdM=opfText.match(/<spine[^>]+toc="([^"]+)"/);
  if(tocIdM){
    const esc=tocIdM[1].replace(/[.*+?^${}()|[\]\\]/g,'\\$&');
    const tocHrefM=opfText.match(new RegExp('<item[^>]+id="'+esc+'"[^>]+href="([^"]+)"'));
    if(tocHrefM){
      const full=(opfBase+tocHrefM[1]).replace(/\/\//g,'/');
      if(keys.find(f=>f===full)) return full;
    }
  }
  // 2순위: 파일명이 정확히 'toc.ncx'
  const exact=keys.find(f=>f.endsWith('/toc.ncx')||f==='toc.ncx');
  if(exact) return exact;
  // 3순위: 단 하나의 .ncx만 있으면 그게 메인
  const allNcx=keys.filter(f=>f.endsWith('.ncx'));
  if(allNcx.length===1) return allNcx[0];
  // 4순위: 경로 가장 짧은 .ncx (루트에 가까운 것)
  if(allNcx.length>1) return allNcx.sort((a,b)=>a.length-b.length||a.localeCompare(b))[0];
  return null;
}

// OPF manifest에서 nav.xhtml을 정확히 찾음
function findNavXhtml(zipFiles, opfText, opfBase){
  const keys=Object.keys(zipFiles);
  // 1순위: manifest에서 properties="nav" 항목
  const m1=opfText.match(/<item[^>]+properties="[^"]*\bnav\b[^"]*"[^>]+href="([^"]+)"/);
  const m2=opfText.match(/<item[^>]+href="([^"]+)"[^>]+properties="[^"]*\bnav\b[^"]*"/);
  const navHref=(m1||m2||[])[1];
  if(navHref){
    const full=(opfBase+navHref).replace(/\/\//g,'/');
    if(keys.find(f=>f===full)) return full;
  }
  // 2순위: 파일명이 정확히 'nav.xhtml'
  return keys.find(f=>f.endsWith('/nav.xhtml')||f==='nav.xhtml')||null;
}

// 챕터별 NCX 구조 감지 (bookN_toc.ncx 패턴)
function detectPerChapterNcx(zipFiles, opfText, opfBase){
  const keys=Object.keys(zipFiles);
  const perNcx=keys.filter(f=>/book\d+_toc\.ncx/.test(f));
  if(perNcx.length<2) return null;
  const rel=perNcx[0].replace(opfBase,'');
  if(!opfText.includes(`href="${rel}"`)) return null;
  return {type:'per-chapter', opfBase};
}

async function loadEpub(file){
  if(!file||!file.name.endsWith('.epub'))return;
  E.epubFile=file;
  document.getElementById('epubDrop')?.classList.add('ok');
  document.getElementById('epubInfo').style.display='block';
  document.getElementById('epubInfo').textContent='로딩 중...';
  document.getElementById('editResetBar').style.display='flex';
  const ab=await fileToAB(file);
  E.epubZip=await JSZip.loadAsync(ab);
  const container=await E.epubZip.file('META-INF/container.xml').async('text');
  const opfPath=container.match(/full-path="([^"]+)"/)[1];
  const opfBase=opfPath.replace(/[^/]+$/,'');
  const opfText=await E.epubZip.file(opfPath).async('text');
  const manifestMap={};
  for(const m of opfText.matchAll(/<item[^>]+id="([^"]+)"[^>]+href="([^"]+)"/g)) manifestMap[m[1]]=m[2];
  const spineIds=[...opfText.matchAll(/<itemref[^>]+idref="([^"]+)"/g)].map(m=>m[1]);
  E.spineOrder=spineIds.map(id=>opfBase+manifestMap[id]).filter(Boolean);
  const titleMap={};
  const ncxFile=findMainNcx(E.epubZip.files,opfText,opfBase);
  E.perChapterNcx=detectPerChapterNcx(E.epubZip.files,opfText,opfBase);
  if(ncxFile){
    const ncxText=await E.epubZip.file(ncxFile).async('text');
    for(const m of ncxText.matchAll(/<navPoint[^>]*>[\s\S]*?<text>([^<]+)<\/text>[\s\S]*?<content src="([^"#]+)/g)){
      const href=(opfBase+m[2]).replace(/\/\//g,'/');
      titleMap[href]=m[1].trim();
    }
  }
  // titleMap의 제목이 'Chapter N' 형식이면 실제 xhtml <h1>에서 재취득
  const chapterNTitle=/^Chapter\s+\d+$/i;
  E.chapters=await Promise.all(
    E.spineOrder
      .filter(href=>!href.includes('cover')&&!href.includes('nav'))
      .map(async(href,idx)=>{
        let title=titleMap[href]||'';
        if(!title||chapterNTitle.test(title)){
          try{
            const raw=await E.epubZip.file(href).async('text');
            const h1=raw.match(/<h[12][^>]*>([^<]+)<\/h[12]>/);
            if(h1) title=h1[1].trim();
          }catch(e){}
        }
        if(!title) title=href.split('/').pop().replace('.xhtml','');
        return {idx,href,title};
      })
  );
  document.getElementById('epubInfo').textContent='✅ '+file.name+' ('+E.chapters.length+'개 챕터)';
  // 이미지 추출 버튼 표시
  const extractBar=document.getElementById('extractImgBar');
  if(extractBar) extractBar.style.display='block';
  document.getElementById('extractImgInfo').textContent=
    `EPUB 내 이미지를 챕터명으로 추출해요 (${E.chapters.length}개 챕터 로드됨)`;
  // 기본값: 마지막 챕터 뒤
  E.selectedChIdx=E.chapters.length-1;
  document.querySelector('input[name="insPos"][value="after"]').checked=true;
  renderChList();
  document.getElementById('editSec').style.display='block';
  document.getElementById('insertSec').style.display='block';
  // 직접 편집 섹션 표시 + 목차 초기화
  document.getElementById('epubDirectEditSec').style.display='block';
  renderDirectEditToc();
  // EPUB 전체 텍스트 추출 (목차 재생성용)
  extractEpubRawText();
  // 메타데이터 초기화 (기존 값 가져오기)
  try{
    const opfXml=await E.epubZip.file(
      Object.keys(E.epubZip.files).find(f=>f.endsWith('.opf'))
    ).async('text');
    const doc=new DOMParser().parseFromString(opfXml,'text/xml');
    const existTitle=doc.querySelector('title,dc\\:title')?.textContent||'';
    const existAuthor=doc.querySelector('creator,dc\\:creator')?.textContent||'';
    document.getElementById('directEditTitle').placeholder=existTitle||'변경할 제목 (비워두면 유지)';
    document.getElementById('directEditAuthor').placeholder=existAuthor||'변경할 작가명 (비워두면 유지)';
  }catch(e){}
  // 삽입 위치 표시 업데이트
  if(E.chapters.length>0){
    const lastCh=E.chapters[E.chapters.length-1];
    document.getElementById('insertPos').innerHTML=
      '📍 <b>'+escHtml(lastCh.title)+'</b> <span style="color:var(--accent)">뒤</span>에 삽입 <span style="font-size:10px;color:var(--text2)">(기본값 - 클릭해서 변경)</span>';
  }
}

// ══════════════════════════════════════════
// 🖼  Module: ImageExtract (EPUB 이미지 추출)
// ══════════════════════════════════════════
async function extractEpubImages(){
  if(!E.epubZip||!E.chapters.length){
    Toast.warn('EPUB 파일을 먼저 불러주세요.');return;
  }

  const btn=document.getElementById('extractImgBtn');
  const progress=document.getElementById('extractImgProgress');
  const progBar=document.getElementById('extractProgBar');
  const progMsg=document.getElementById('extractProgMsg');
  const infoEl=document.getElementById('extractImgInfo');

  btn.disabled=true;
  btn.textContent='추출 중...';
  progress.style.display='block';
  progBar.style.width='0%';

  try{
    // ── 1. OPF에서 이미지 파일 목록 수집 ──
    const container=await E.epubZip.file('META-INF/container.xml').async('text');
    const opfPath=container.match(/full-path="([^"]+)"/)[1];
    const opfBase=opfPath.replace(/[^/]+$/,'');
    const opfText=await E.epubZip.file(opfPath).async('text');

    // manifest에서 이미지 항목만 추출
    const imgManifest={}; // id → href
    for(const m of opfText.matchAll(/<item[^>]+id="([^"]+)"[^>]+href="([^"]+)"[^>]+media-type="(image\/[^"]+)"/g)){
      imgManifest[m[1]]={href:opfBase+m[2], mt:m[3]};
    }
    // href를 절대경로 키로 역매핑
    const imgByHref={};
    for(const[id,info] of Object.entries(imgManifest)){
      imgByHref[info.href.replace(/\/\//g,'/')]={id,mt:info.mt};
    }

    // ── 2. 각 챕터 xhtml에서 img src 추출 → 챕터 매핑 ──
    // chapterImages: [{chTitle, imgHref}]
    const chapterImages=[]; // {chTitle, imgHref, ext}

    progMsg.textContent='챕터 분석 중...';
    for(let ci=0;ci<E.chapters.length;ci++){
      progBar.style.width=Math.round(ci/E.chapters.length*50)+'%';
      const ch=E.chapters[ci];
      let xhtml='';
      try{ xhtml=await E.epubZip.file(ch.href).async('text'); }catch(e){ continue; }

      // img src 추출 (src="..." or src='...')
      const imgRefs=[...xhtml.matchAll(/(?:src|xlink:href)=["']([^"']+\.(jpe?g|png|gif|webp|svg|avif))["']/gi)];
      for(const m of imgRefs){
        // 상대경로 → 절대경로
        const srcRel=m[1];
        let absHref;
        if(srcRel.startsWith('http')){
          absHref=srcRel;
        } else {
          const chDir=ch.href.replace(/[^/]+$/,'');
          absHref=(chDir+srcRel).replace(/[^/]+\/\.\.\//g,'').replace(/\/\//g,'/');
        }
        // 이 href가 실제 EPUB 내부 이미지인지 확인
        if(E.epubZip.file(absHref)||imgByHref[absHref]){
          const ext=srcRel.split('.').pop().toLowerCase();
          chapterImages.push({chTitle:ch.title, imgHref:absHref, ext});
        }
      }
    }

    if(!chapterImages.length){
      infoEl.textContent='⚠️ 이미지를 찾지 못했어요 (표지·내부 삽화 없음)';
      progress.style.display='none';
      btn.disabled=false;
      btn.textContent='📦 이미지 추출';
      return;
    }

    progMsg.textContent=`${chapterImages.length}개 이미지 압축 중...`;
    progBar.style.width='55%';

    // ── 3. 챕터별 이미지 번호 카운터 ──
    const chCounter={};
    const fileEntries=[]; // {filename, href}

    for(const{chTitle, imgHref, ext} of chapterImages){
      // 파일명에 사용할 수 없는 문자 제거
      const safeTitle=chTitle
        .replace(/[\\/:*?"<>|]/g,'_')
        .replace(/\s+/g,' ')
        .trim()
        .slice(0,60); // 최대 60자

      if(!(safeTitle in chCounter)) chCounter[safeTitle]=0;
      chCounter[safeTitle]++;

      // 첫 번째 이미지는 그냥 제목, 2번째부터 _N 붙임
      const cnt=chCounter[safeTitle];
      const filename=cnt===1
        ? `${safeTitle}.${ext}`
        : `${safeTitle}_${cnt}.${ext}`;

      fileEntries.push({filename, href:imgHref});
    }

    // ── 4. 중복 파일명 처리 ──
    // (같은 제목의 챕터가 여러 개면 번호 카운터가 이미 처리함)
    // 단, 아예 동일한 imgHref가 중복 등록된 경우 제거
    const seenHrefs=new Set();
    const uniqueEntries=fileEntries.filter(e=>{
      if(seenHrefs.has(e.href)) return false;
      seenHrefs.add(e.href);
      return true;
    });

    // ── 5. JSZip으로 압축 ──
    const outZip=new JSZip();
    let done=0;
    for(const{filename, href} of uniqueEntries){
      progBar.style.width=(55+Math.round(done/uniqueEntries.length*40))+'%';
      progMsg.textContent=`이미지 추출 중 (${done+1}/${uniqueEntries.length}): ${filename}`;
      try{
        const blob=await E.epubZip.file(href).async('arraybuffer');
        outZip.file(filename, blob);
      }catch(e){
        console.warn('이미지 추출 실패:', href, e);
      }
      done++;
    }

    progBar.style.width='97%';
    progMsg.textContent='ZIP 생성 중...';

    const zipBlob=await outZip.generateAsync({
      type:'blob',
      compression:'STORE' // 이미지는 이미 압축됨
    });

    progBar.style.width='100%';

    // ── 6. 다운로드 ──
    const epubName=(E.epubFile?.name||'epub').replace(/\.epub$/i,'');
    const a=document.createElement('a');
    a.href=URL.createObjectURL(zipBlob);
    a.download=epubName+'_images.zip';
    a.click();
    setTimeout(()=>URL.revokeObjectURL(a.href),3000);

    const totalImgs=uniqueEntries.length;
    infoEl.textContent=`✅ ${totalImgs}개 이미지 추출 완료 (${(zipBlob.size/1024).toFixed(0)}KB)`;
    progMsg.textContent=`완료! ${totalImgs}개 이미지가 ZIP으로 다운로드됩니다.`;

  }catch(e){
    console.error('이미지 추출 실패:', e);
    progMsg.textContent='❌ 오류: '+e.message;
    infoEl.textContent='⚠️ 이미지 추출 중 오류 발생';
  }finally{
    btn.disabled=false;
    btn.textContent='📦 이미지 추출';
    progBar.style.width='100%';
  }
}

function renderChList(){
  const c=document.getElementById('chList');c.innerHTML='';
  E.chapters.forEach((ch,i)=>{
    const d=document.createElement('div');
    const isSel=E.selectedChIdx===i;
    const isLast=i===E.chapters.length-1;
    d.className='ch-item'+(isSel?' sel':'');
    d.innerHTML='<span class="ch-idx">'+(i+1)+'</span>'+
      '<span class="ch-title">'+escHtml(ch.title)+'</span>'+
      (isLast?'<span class="ch-badge" style="background:var(--green-bg);color:var(--green)">마지막</span>':
               '<span class="ch-badge badge-existing">기존</span>');
    d.onclick=()=>selectCh(i);
    c.appendChild(d);
  });
  // 선택된 항목으로 스크롤
  if(E.selectedChIdx!==null){
    const sel=c.children[E.selectedChIdx];
    if(sel) setTimeout(()=>sel.scrollIntoView({block:'nearest'}),50);
  }
}

function selectCh(i){
  E.selectedChIdx=i;
  renderChList();
  const pos=document.querySelector('input[name="insPos"]:checked').value;
  const ch=E.chapters[i];
  document.getElementById('insertPos').innerHTML=
    '📍 <b>'+escHtml(ch.title)+'</b> '+
    (pos==='before'?'<span style="color:var(--accent)">앞</span>에':'<span style="color:var(--accent)">뒤</span>에')+' 삽입';
}

async function handleInsTxt(files){
  const txts=Array.from(files).filter(f=>f.name.endsWith('.txt'));
  if(!txts.length)return;
  E.insTxtFiles=txts;
  const info=document.getElementById('insTxtInfo');
  info.style.display='block';info.textContent='📖 분석 중...';
  document.getElementById('insTxtDrop').classList.add('ok');
  const pat=document.getElementById('insPattern').value.trim();
  const sorted=[...txts].sort((a,b)=>sortKey(a.name)<sortKey(b.name)?-1:1);
  const raws=await Promise.all(sorted.map(fileToText));
  const raw=raws.join('\n\n');
  const chapters=splitChapters(raw,pat);
  // 텍스트 파일에서 뽑아온 순서(splitChapters 인덱스)를 정렬 기준으로 사용
  // 번호 기반 재정렬 제거: "1화"와 "외전 1화"가 동일 chNum=1로 충돌하는 문제 해결
  const mapped=chapters.map((ch,i)=>({
    idx:i,
    title:ch[0],
    body:ch[1],
    enabled:true,
    chNum:_extractTocNum(ch[0])  // 중복 감지·연결점 표시용으로만 유지
  }));
  E.insTxtChapters=mapped;
  info.textContent='✅ '+txts.length+'개 파일 · '+chapters.length+'개 챕터 감지';
  renderInsTocList();
  document.getElementById('insTocSec').style.display='block';
  document.getElementById('editIllSec').style.display='block';
}

async function reloadInsToc(){
  if(!E.insTxtFiles.length){Toast.warn('TXT 파일을 먼저 선택해주세요.');return;}
  await handleInsTxt(E.insTxtFiles);
}

function renderInsTocList(){
  const c=document.getElementById('insTocList');c.innerHTML='';
  const items=E.insTxtChapters||[];
  if(!items.length){
    c.innerHTML='<div class="toc-empty">TXT 파일을 로드해주세요.</div>';
    updateInsTocCount();
    return;
  }

  const epubLastNum=_getEpubLastChNum();
  // ① EPUB에 이미 있는 챕터 키 집합 (ns:num 복합키 — 본편/외전 구분)
  const epubKeys=new Set((E.chapters||[]).map(ch=>_tocKey(ch.title)));

  let dupCount=0;
  items.forEach((ch,i)=>{
    const d=document.createElement('div');
    d.className='ch-item'+(ch.enabled?'':' off');
    d.style.transition='opacity .15s';

    const chk=document.createElement('input');
    chk.type='checkbox'; chk.className='toc-chk'; chk.checked=ch.enabled;
    chk.addEventListener('change',e=>{
      e.stopPropagation();
      toggleInsTocItem(i,chk.checked);
      d.classList.toggle('off',!chk.checked);
    });

    const num=document.createElement('span');
    num.className='ch-idx'; num.textContent=(i+1);

    const title=document.createElement('span');
    title.className='ch-title'; title.textContent=ch.title;

    // ns:num 복합키로 중복 감지 — "1화"(main:1)와 "외전 1화"(extra:1)는 다른 키
    const parsed=_parseTocTitle(ch.title);
    const chKey=_tocKey(ch.title);
    const chNum=parsed.num;
    const isDup=chNum>0&&epubKeys.has(chKey);
    // 연결점: 본편(main) 기준으로만 판정
    const isNext=parsed.ns==='main'&&epubLastNum>0&&chNum===epubLastNum+1;

    if(isDup){ dupCount++; }

    if(isDup){
      const dupBadge=document.createElement('span');
      dupBadge.style.cssText='font-size:9px;background:var(--yellow-bg);color:var(--yellow);border:1px solid var(--accent2);border-radius:3px;padding:1px 5px;flex-shrink:0';
      dupBadge.textContent='중복';
      dupBadge.title='EPUB에 이미 있는 챕터예요 ('+chKey+')';
      d.appendChild(chk); d.appendChild(num); d.appendChild(title); d.appendChild(dupBadge);
    } else if(isNext){
      const marker=document.createElement('span');
      marker.style.cssText='font-size:9px;background:var(--blue);color:#fff;border-radius:3px;padding:1px 5px;flex-shrink:0';
      marker.textContent='← 연결점';
      marker.title='EPUB 마지막('+epubLastNum+'화) 바로 다음 챕터';
      const newBadge=document.createElement('span');
      newBadge.className='ch-badge badge-new'; newBadge.textContent='신규';
      d.appendChild(chk); d.appendChild(num); d.appendChild(title);
      d.appendChild(marker); d.appendChild(newBadge);
    } else {
      const newBadge=document.createElement('span');
      newBadge.className='ch-badge badge-new'; newBadge.textContent='신규';
      d.appendChild(chk); d.appendChild(num); d.appendChild(title); d.appendChild(newBadge);
    }
    c.appendChild(d);
  });

  // 중복 카운트 표시
  const dupCountEl=document.getElementById('insTocDupCount');
  if(dupCountEl){
    if(dupCount>0){
      dupCountEl.textContent='⚠ 중복 '+dupCount+'개';
      dupCountEl.style.display='';
    }else{
      dupCountEl.style.display='none';
    }
  }

  updateInsTocCount();
  syncInsTocRefSelect();
  _showEpubConnectInfo();
  // ② 연속성 검증
  _checkTocContinuity();
}

// ② 연속성 검증 — 누락 화수 감지
function _checkTocContinuity(){
  const warnEl=document.getElementById('insTocGapWarn');
  if(!warnEl) return;
  const epubLastNum=_getEpubLastChNum();
  const items=E.insTxtChapters||[];
  if(epubLastNum<=0||!items.length){ warnEl.style.display='none'; return; }

  // 활성화된 TXT 챕터 중 본편(main)만 추출 — 외전/번외는 연속성 계산 제외
  const enabledNums=items
    .filter(ch=>ch.enabled)
    .filter(ch=>_parseTocTitle(ch.title).ns==='main') // 본편만
    .map(ch=>_extractTocNum(ch.title))
    .filter(n=>n>0);
  if(!enabledNums.length){ warnEl.style.display='none'; return; }

  const minTxtNum=Math.min(...enabledNums);
  const gaps=[];

  // EPUB 마지막과 TXT 최솟값 사이 공백
  if(minTxtNum>epubLastNum+1){
    for(let n=epubLastNum+1;n<minTxtNum;n++) gaps.push(n);
  }

  if(gaps.length>0){
    const gapStr=gaps.length<=5?gaps.join(', ')+'화':gaps[0]+'화~'+gaps[gaps.length-1]+'화 ('+gaps.length+'개)';
    warnEl.innerHTML='⚠️ <b>연속성 경고</b>: EPUB 마지막('+epubLastNum+'화)과 TXT 시작('+minTxtNum+'화) 사이 <b>'+gapStr+'</b>가 누락되어 있어요.';
    warnEl.style.display='block';
  }else{
    warnEl.style.display='none';
  }
}

// EPUB 마지막 챕터 번호 추출
function _getEpubLastChNum(){
  if(!E.chapters||!E.chapters.length) return -1;
  const last=E.chapters[E.chapters.length-1];
  return _extractTocNum(last.title);
}
// 챕터 제목에서 번호 추출 (중복 감지·연결점 표시용)
// 외전/번외/프롤로그는 본편과 충돌하지 않도록 별도 네임스페이스 부여
// 반환 형식: {num, ns}
//   num: 정수 번호 (없으면 -1)
//   ns:  'main'(본편) | 'extra'(외전/번외) | 'special'(프롤로그/에필로그 등)
function _parseTocTitle(t){
  const s=(t||'').trim();
  // 외전/번외/사이드/특별편 키워드 — 본편과 별도 ns
  if(/(?:^|\s)(?:외전|번외|사이드|side|특별편|bonus|extra)/i.test(s)){
    const m=s.match(/(\d+)/);
    return {num: m?parseInt(m[1]):-1, ns:'extra'};
  }
  // 후일담/에필로그/종장
  if(/(?:^|\s)(?:후일담|에필로그|epilogue|종장)/i.test(s)){
    const m=s.match(/(\d+)/);
    return {num: m?parseInt(m[1]):-1, ns:'special'};
  }
  // 프롤로그/서장 — 본편 앞
  if(/^(?:프롤로그|서장|prologue)/i.test(s))
    return {num:0, ns:'special'};
  // 일반 본편
  const m=s.match(/(\d+)/);
  return {num: m?parseInt(m[1]):-1, ns:'main'};
}

// 하위 호환용 — 번호만 반환
function _extractTocNum(t){
  return _parseTocTitle(t).num;
}

// 중복 감지에 사용: ns + num 복합 키 반환
function _tocKey(t){
  const {num,ns}=_parseTocTitle(t);
  return ns+':'+num;
}

// EPUB 연결 정보 표시
function _showEpubConnectInfo(){
  const infoEl=document.getElementById('insTocEpubInfo');
  const textEl=document.getElementById('insTocEpubInfoText');
  if(!infoEl||!textEl) return;
  if(!E.chapters||!E.chapters.length){infoEl.style.display='none';return;}
  const lastCh=E.chapters[E.chapters.length-1];
  const lastNum=_getEpubLastChNum();
  const numText=lastNum>0?` (${lastNum}화)`:'';
  textEl.innerHTML=
    `현재 EPUB 마지막 챕터: <b>${escHtml(lastCh.title)}</b>${numText} — `+
    `<b>${E.chapters.length}번째</b> 위치<br>`+
    `<span style="color:var(--accent);font-size:10px">➡ 아래에서 이 이후 챕터들을 선택해 삽입하세요</span>`;
  infoEl.style.display='block';
}

// TXT 챕터 목록을 기준 챕터 select에 동기화 (TXT 기준으로 변경)
function syncInsTocRefSelect(){
  const sel=document.getElementById('insTocRefChapter');
  if(!sel) return;
  const items=E.insTxtChapters||[];
  if(!items.length){ sel.innerHTML='<option value="">— TXT 기준 챕터 선택 —</option>'; return; }

  const prev=sel.value;
  sel.innerHTML='<option value="">— TXT 기준 챕터 선택 —</option>';

  // EPUB 마지막 챕터 번호를 기준으로 기본 선택값 계산
  const epubLastNum=_getEpubLastChNum();
  let defaultIdx=-1;

  items.forEach((ch,i)=>{
    const opt=document.createElement('option');
    opt.value=i;
    const chNum=_extractTocNum(ch.title);
    // EPUB 마지막 화 다음 챕터를 기본값으로
    if(epubLastNum>0&&chNum===epubLastNum+1&&defaultIdx<0) defaultIdx=i;
    opt.textContent=(i+1)+'. '+ch.title;
    sel.appendChild(opt);
  });

  // 기본값: EPUB 이후 첫 챕터, 없으면 맨 처음
  if(prev!==''){ sel.value=prev; }
  else if(defaultIdx>=0){ sel.value=defaultIdx; }
  else if(items.length){ sel.value=0; }
}

// TXT 챕터 기준 이전/이후 + 빠른 선택
function applyInsTocRange(mode){
  const sel=document.getElementById('insTocRefChapter');
  const items=E.insTxtChapters||[];
  if(!items.length) return;

  const infoEl=document.getElementById('insTocRangeInfo');
  const epubLastNum=_getEpubLastChNum();
  // 챕터 키 집합 (ns:num 복합키 — 본편/외전 구분)
  const epubKeys=new Set((E.chapters||[]).map(ch=>_tocKey(ch.title)));

  if(mode==='reset'){
    items.forEach(ch=>ch.enabled=true);
    infoEl.textContent=''; renderInsTocList(); return;
  }

  // EPUB 이후만: 본편 기준 (외전은 번호 무관하게 항상 포함)
  if(mode==='epubAfter'){
    if(epubLastNum<=0){ Toast.warn('EPUB 파일을 먼저 불러와주세요.'); return; }
    let cnt=0;
    items.forEach(ch=>{
      const {num,ns}=_parseTocTitle(ch.title);
      // 본편은 epubLastNum 초과만, 외전/특별편은 무조건 포함, 번호 없으면 포함
      ch.enabled=(ns!=='main'||num>epubLastNum||num<=0);
      if(ch.enabled) cnt++;
    });
    infoEl.textContent='EPUB 이후('+epubLastNum+'화 초과) '+cnt+'개 선택';
    renderInsTocList(); return;
  }

  // EPUB 이전만: 본편 기준
  if(mode==='epubBefore'){
    if(epubLastNum<=0){ Toast.warn('EPUB 파일을 먼저 불러와주세요.'); return; }
    let cnt=0;
    items.forEach(ch=>{
      const {num,ns}=_parseTocTitle(ch.title);
      ch.enabled=(ns==='main'&&num>0&&num<=epubLastNum);
      if(ch.enabled) cnt++;
    });
    infoEl.textContent='EPUB 이전('+epubLastNum+'화 이하) '+cnt+'개 선택';
    renderInsTocList(); return;
  }

  // 중복 제외: ns:num 복합키 기준 — "1화"와 "외전 1화"를 별개로 판정
  if(mode==='dedupe'){
    let deduped=0;
    items.forEach(ch=>{
      const key=_tocKey(ch.title);
      const {num}=_parseTocTitle(ch.title);
      if(num>0&&epubKeys.has(key)){ ch.enabled=false; deduped++; }
    });
    infoEl.textContent=deduped>0?'중복 '+deduped+'개 해제됨':'중복 챕터 없음';
    renderInsTocList(); return;
  }

  // 기준 챕터 선택 필요
  const refIdx=sel&&sel.value!==''?parseInt(sel.value):-1;
  if(refIdx<0){ Toast.warn('기준 챕터를 먼저 선택해주세요.'); return; }

  const refTitle=items[refIdx]?.title||'';
  let enabledCount=0;

  if(mode==='before'){
    items.forEach((ch,i)=>{ ch.enabled=(i<=refIdx); if(ch.enabled) enabledCount++; });
    infoEl.textContent='"'+refTitle+'" 포함 이전 '+enabledCount+'개 선택 (1~'+(refIdx+1)+'번째)';
  } else if(mode==='after'){
    items.forEach((ch,i)=>{ ch.enabled=(i>=refIdx); if(ch.enabled) enabledCount++; });
    infoEl.textContent='"'+refTitle+'" 포함 이후 '+enabledCount+'개 선택 ('+(refIdx+1)+'~'+items.length+'번째)';
  }

  renderInsTocList();
}

function toggleInsTocItem(i,v){if(E.insTxtChapters)E.insTxtChapters[i].enabled=v;updateInsTocCount();}
function toggleAllInsToc(v){if(E.insTxtChapters)E.insTxtChapters.forEach(ch=>ch.enabled=v);renderInsTocList();}
function updateInsTocCount(){
  const items=E.insTxtChapters||[];
  const on=items.filter(ch=>ch.enabled).length;
  document.getElementById('insTocCount').textContent=on+'/'+items.length+'개 선택됨';
}

async function startEditEpub(){
  if(!E.epubZip){Toast.warn('EPUB 파일을 먼저 불러와주세요.');return;}
  if(!E.insTxtFiles.length){Toast.warn('삽입할 TXT 파일을 선택해주세요.');return;}
  // selectedChIdx는 epub 로드 시 마지막 챕터로 기본 설정됨
  document.getElementById('editProgWrap').classList.add('show');
  document.getElementById('editResultBox').classList.remove('show');
  document.getElementById('editErrBox').classList.remove('show');
  function ep(pct,msg){document.getElementById('editProgBar').style.width=pct+'%';document.getElementById('editProgMsg').textContent=msg;}
  try{
    ep(5,'TXT 읽는 중...');
    let newChapters;
    if(E.insTxtChapters&&E.insTxtChapters.length>0){
      newChapters=E.insTxtChapters.filter(ch=>ch.enabled).map(ch=>[ch.title,ch.body]);
    }else{
      const sorted=[...E.insTxtFiles].sort((a,b)=>sortKey(a.name)<sortKey(b.name)?-1:1);
      const raws=await Promise.all(sorted.map(fileToText));
      newChapters=splitChapters(raws.join('\n\n'),document.getElementById('insPattern').value.trim());
    }
    newChapters=newChapters.filter(([h])=>h!=='서문'||newChapters.length===1);
    if(!newChapters.length)throw new Error('삽입할 챕터가 없습니다.');
    ep(15,'EPUB 복제 중...');
    const newZip=new JSZip();
    for(const[name,f]of Object.entries(E.epubZip.files)){
      if(f.dir)continue;
      newZip.file(name,await f.async('arraybuffer'));
    }
    const containerXml=await E.epubZip.file('META-INF/container.xml').async('text');
    const opfPath=containerXml.match(/full-path="([^"]+)"/)[1];
    const opfBase=opfPath.replace(/[^/]+$/,'');
    let opfText=await E.epubZip.file(opfPath).async('text');
    const keepCss=document.getElementById('keepOrigCss')?.checked!==false;
    const cssMatch=opfText.match(/href="([^"]*style[^"]*\.css)"/i);
    const cssHref=cssMatch?cssMatch[1]:'style.css';
    // 원본 CSS 유지 OFF시 새 스타일 주입
    if(!keepCss&&cssMatch){
      const origCssPath=opfBase+cssHref;
      if(newZip.file(origCssPath)) newZip.file(origCssPath,buildCss());
    }
    ep(25,'챕터 파일 생성 중...');
    const existingNums=Object.keys(E.epubZip.files).filter(f=>f.includes('chapter_'))
      .map(f=>{const m=f.match(/chapter_(\d+)/);return m?parseInt(m[1]):-1;});
    let nextNum=(existingNums.length?Math.max(...existingNums):0)+1;
    const newManifestItems=[],newSpineIds=[],newNcxItems=[];
    const useItalic=true;
    // 챕터별 NCX 구조 감지 (bookN_toc.ncx 패턴)
    const perChNcx=E.perChapterNcx;
    // 공통 renderBodyHtml 사용 (시스템창 처리·빈줄 제한 포함)
    function bToHtml(body){ return renderBodyHtml(body,{useItalic,maxBlank:2}); }
    function makeChNcx(id,title,contentSrc){
      return '<?xml version="1.0" encoding="UTF-8"?>\n'+
        '<ncx xmlns="http://www.daisy.org/z3986/2005/ncx/" version="2005-1">\n'+
        '  <head><meta name="dtb:uid" content="urn:uuid:'+id+'"/><meta name="dtb:depth" content="1"/>'+
        '<meta name="dtb:totalPageCount" content="0"/><meta name="dtb:maxPageNumber" content="0"/></head>\n'+
        '  <docTitle><text>'+escHtml(title)+'</text></docTitle>\n'+
        '  <navMap>\n    <navPoint id="navPoint-1" playOrder="1">\n'+
        '      <navLabel><text>'+escHtml(title)+'</text></navLabel>\n'+
        '      <content src="'+contentSrc+'"/>\n    </navPoint>\n  </navMap>\n</ncx>';
    }
    for(let i=0;i<newChapters.length;i++){
      if(i%20===0) ep(25+Math.floor(i/newChapters.length*40),'챕터 생성 중 ('+i+'/'+newChapters.length+')...');
      const[heading,body]=newChapters[i];
      const fname='chapter_'+String(nextNum).padStart(4,'0')+'.xhtml';
      const fullPath=opfBase+'Text/'+fname;
      const chid='ins_ch_'+String(nextNum).padStart(4,'0');
      // keepOrigCss=true이면 원본 CSS의 커스텀 폰트가 적용됨
// 커스텀 폰트(NF_Library 등)가 !important로 지정된 경우 새 챕터 한글이 깨짐
// → 새 챕터 body에 시스템 폰트를 !important 인라인으로 강제 지정
const inlineFont=keepCss
  ? ' style="font-family: \'Noto Serif KR\',\'Malgun Gothic\',\'Apple SD Gothic Neo\',\'나눔고딕\',sans-serif !important"'
  : '';
newZip.file(fullPath,'<?xml version="1.0" encoding="utf-8"?><!DOCTYPE html>\n<html xmlns="http://www.w3.org/1999/xhtml"><head>\n<title>'+escHtml(heading)+'</title>\n<link rel="stylesheet" type="text/css" href="../'+cssHref+'"/>\n'+
  '<style>/* 커스텀 폰트 폰트 오버라이드 */\np,h1,h2,h3,h4,h5,span,a{font-family:\'Noto Serif KR\',\'Malgun Gothic\',\'Apple SD Gothic Neo\',sans-serif!important}</style>\n'+
  '</head><body>\n<h1>'+escHtml(heading)+'</h1>\n'+bToHtml(body)+'</body></html>');
      newManifestItems.push({id:chid,href:'Text/'+fname,mt:'application/xhtml+xml'});
      // 챕터별 NCX 구조이면 개별 ncx 파일도 생성
      if(perChNcx){
        const ncxFname='chapter_'+String(nextNum).padStart(4,'0')+'_toc.ncx';
        const ncxPath=opfBase+'Text/'+ncxFname;
        newZip.file(ncxPath, makeChNcx(chid, heading, fname));
        newManifestItems.push({id:chid+'_ncx',href:'Text/'+ncxFname,mt:'application/x-dtbncx+xml'});
      }
      newSpineIds.push(chid);
      newNcxItems.push({id:chid,title:heading,src:'Text/'+fname});
      nextNum++;
    }
    ep(70,'OPF 업데이트 중...');
    const manifestInsert=newManifestItems.map(it=>'<item id="'+it.id+'" href="'+it.href+'" media-type="'+it.mt+'"/>').join('\n');
    opfText=opfText.replace('</manifest>',manifestInsert+'\n</manifest>');
    const selHref=E.chapters[E.selectedChIdx].href;
    const selHrefRel=selHref.replace(opfBase,'');
    const insPos=document.querySelector('input[name="insPos"]:checked').value;
    // manifest에서 선택 챕터의 id 찾기
    const manifestIdMatch=opfText.match(new RegExp('<item[^>]+id="([^"]+)"[^>]+href="'+selHrefRel.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')+'"'));
    const selId=manifestIdMatch?manifestIdMatch[1]:'';
    const newSpineRefs=newSpineIds.map(id=>'<itemref idref="'+id+'"/>').join('\n');
    if(selId&&insPos==='before'){
      opfText=opfText.replace('<itemref idref="'+selId+'"/>',newSpineRefs+'\n<itemref idref="'+selId+'"/>');
    }else if(selId&&insPos==='after'){
      opfText=opfText.replace('<itemref idref="'+selId+'"/>','<itemref idref="'+selId+'"/>\n'+newSpineRefs);
    }else{
      opfText=opfText.replace('</spine>',newSpineRefs+'\n</spine>');
    }
    newZip.file(opfPath,opfText);
    // NCX + nav.xhtml 목차 업데이트
    ep(82,'목차 업데이트 중...');
    const selFilename=selHrefRel.split('/').pop();
    const escSelFn=selFilename.replace(/[.*+?^${}()|[\]\\]/g,'\\$&');

    // NCX 업데이트
    const ncxFile=findMainNcx(E.epubZip.files,opfText,opfBase);
    if(ncxFile){
      let ncxText=await E.epubZip.file(ncxFile).async('text');
      const maxOrder=Math.max(...[...ncxText.matchAll(/playOrder="(\d+)"/g)].map(m=>parseInt(m[1])),0);
      const newNavPoints=newNcxItems.map((it,i)=>
        '<navPoint id="'+it.id+'" playOrder="'+(maxOrder+i+1)+'">'+
        '<navLabel><text>'+escHtml(it.title)+'</text></navLabel>'+
        '<content src="'+it.src+'"/></navPoint>'
      ).join('\n');
      // ✅ 핵심 수정: (?:(?!</navPoint>)[\s\S])*? 로 navPoint 경계를 절대 넘지 않음
      const ncxSafeRx=new RegExp(
        '<navPoint[^>]*>(?:(?!</navPoint>)[\\s\\S])*?<content src="[^"]*'
        +escSelFn+'[^"]*"/>(?:(?!</navPoint>)[\\s\\S])*?</navPoint>'
      );
      const ncxM=ncxText.match(ncxSafeRx);
      if(ncxM){
        if(insPos==='before') ncxText=ncxText.replace(ncxM[0],newNavPoints+'\n'+ncxM[0]);
        else ncxText=ncxText.replace(ncxM[0],ncxM[0]+'\n'+newNavPoints);
      }else{
        ncxText=ncxText.replace('</navMap>',newNavPoints+'\n</navMap>');
      }
      newZip.file(ncxFile,ncxText);
    }

    // nav.xhtml 업데이트 (EPUB3 리더 우선 사용)
    const navFile=findNavXhtml(E.epubZip.files,opfText,opfBase);
    if(navFile){
      let navText=await E.epubZip.file(navFile).async('text');
      const newNavLis=newNcxItems.map(it=>'<li><a href="'+it.src+'">'+escHtml(it.title)+'</a></li>').join('\n');
      const navM=navText.match(new RegExp('<li><a href="[^"]*'+escSelFn+'[^"]*">[^<]*</a></li>'));
      if(navM){
        if(insPos==='before') navText=navText.replace(navM[0],newNavLis+'\n'+navM[0]);
        else navText=navText.replace(navM[0],navM[0]+'\n'+newNavLis);
      }else{
        navText=navText.replace('</ol>',newNavLis+'\n</ol>');
      }
      newZip.file(navFile,navText);
    }
    // 삽화 삽입
    if(EI.files.length>0){
      ep(88,'삽화 삽입 중...');
      const illEntries=buildIllEntries(E.chapters,opfBase);
      if(illEntries.length>0) await insertIllsToEpub(newZip,opfPath,opfBase,illEntries);
    }
    ep(92,'압축 중...');
    const blob=await newZip.generateAsync({type:'blob',mimeType:'application/epub+zip',compression:'DEFLATE',compressionOptions:{level:parseInt(document.getElementById('optCompression')?.value||'6')}},
      meta=>ep(92+Math.floor(meta.percent*0.07),'압축 중 '+Math.floor(meta.percent)+'%...'));
    E.resultBlob=blob;
    E.resultName=E.epubFile.name.replace('.epub','')+'_편집.epub';
    ep(100,'완료!');
    document.getElementById('editResultMsg').textContent=E.resultName+' ('+(blob.size/1024/1024).toFixed(1)+'MB)';
    document.getElementById('editResultBox').classList.add('show');
  }catch(e){
    console.error(e);
    document.getElementById('editProgWrap').classList.remove('show');
    document.getElementById('editErrBox').textContent='❌ '+friendlyError(e);
    document.getElementById('editErrBox').classList.add('show');
  }
}

// ══════════════════════════════════════════
// 🖼  Module: IllustInsert (삽화 삽입·매핑)
// ══════════════════════════════════════════

// editIllDrop / insIllDrop 이벤트는 setupEventListeners에서 처리

// handleEditIll / handleInsIll → 공통 handleIllFiles 사용
function handleEditIll(files){ handleIllFiles(files,EI.files,'editIllDrop',renderEditIllTags); }
function handleInsIll(files){
  handleIllFiles(files,EI.files,'insIllDrop',renderEditIllTags);
}

// EPUB 편집 탭 삽화 태그 렌더링 (editIllTags + insIllTags 동시 갱신)
function renderEditIllTags(){
  ['editIllTags','insIllTags'].forEach(cid=>{
    const c=document.getElementById(cid);if(!c)return;
    c.innerHTML='';
    EI.files.forEach((f,i)=>{
      const t=document.createElement('div');t.className='tag';
      t.innerHTML=escHtml(f.name)+' <span class="x" onclick="removeEditIll('+i+')">✕</span>';
      c.appendChild(t);
    });
  });
}
function removeEditIll(i){EI.files.splice(i,1);renderEditIllTags();}

function addInsManualIll(){ addManualIllRow('insManualIlls'); }

function addEditIllRow(){
  const id=EI.manualRows++;
  const c=document.getElementById('editIllManualList');
  const r=document.createElement('div');r.className='mill-row';r.id='eir_'+id;
  r.innerHTML=
    '<input placeholder="파일명 (예: 16.jpg)" id="eif_'+id+'" style="flex:2;min-width:100px">'+
    '<button class="btn btn-ghost btn-sm" onclick="browseEditIll('+id+')">찾기</button>'+
    '<select id="eim_'+id+'" onchange="toggleEIM('+id+')"><option value="chapter">화 번호</option><option value="keyword">키워드</option><option value="title">챕터 제목 포함</option></select>'+
    '<input type="number" placeholder="화 번호" id="eic_'+id+'" style="width:78px" min="1">'+
    '<input placeholder="키워드/제목" id="eik_'+id+'" style="flex:1;min-width:80px;display:none">'+
    '<select id="eip_'+id+'"><option value="before">챕터 앞</option><option value="after">챕터 뒤</option></select>'+
    '<button class="btn btn-sm" style="background:var(--accent-bg);color:var(--accent)" data-action="removeEditIllRow" data-row-id="eir_'+id+'">✕</button>';
  c.appendChild(r);
}
function toggleEIM(id){
  const m=document.getElementById('eim_'+id).value;
  document.getElementById('eic_'+id).style.display=m==='chapter'?'':'none';
  document.getElementById('eik_'+id).style.display=(m==='keyword'||m==='title')?'':'none';
}
function browseEditIll(id){
  const inp=document.createElement('input');inp.type='file';inp.accept='.jpg,.jpeg,.png,.gif,.webp,.bmp,.tiff,.tif,.avif';
  inp.onchange=()=>{if(inp.files[0]){EI.files.push(inp.files[0]);renderEditIllTags();document.getElementById('eif_'+id).value=inp.files[0].name;}};
  inp.click();
}

// 삽화를 epub zip에 추가하고 OPF/NCX/nav 업데이트
async function insertIllsToEpub(newZip, opfPath, opfBase, illEntries){
  if(!illEntries.length) return;

  let opfText=await newZip.file(opfPath).async('text');
  const ncxFile=findMainNcx(newZip.files,opfText,opfBase);
  const navFile=findNavXhtml(newZip.files,opfText,opfBase);
  let ncxText=ncxFile?await newZip.file(ncxFile).async('text'):'';
  let navText=navFile?await newZip.file(navFile).async('text'):'';

  // 기존 manifest에서 최대 이미지 인덱스 파악
  const existImgNums=Object.keys(newZip.files).filter(f=>/img_\d+/.test(f))
    .map(f=>{const m=f.match(/img_(\d+)/);return m?parseInt(m[1]):-1;});
  let imgIdx=(existImgNums.length?Math.max(...existImgNums):0)+1;

  // 기존 ill 페이지 인덱스
  const existIllNums=Object.keys(newZip.files).filter(f=>/ill_\d+\.xhtml/.test(f))
    .map(f=>{const m=f.match(/ill_(\d+)/);return m?parseInt(m[1]):-1;});
  let illIdx=(existIllNums.length?Math.max(...existIllNums):0)+1;

  // 기존 CSS href
  const cssMatch=opfText.match(/href="([^"]*style[^"]*\.css)"/i);
  const cssHref=cssMatch?cssMatch[1]:'style.css';

  const maxNcxOrder=ncxText?Math.max(...[...ncxText.matchAll(/playOrder="(\d+)"/g)].map(m=>parseInt(m[1])),0):0;
  let ncxOrderOffset=0;

  for(const entry of illEntries){
    const{file, targetHref, pos}=entry;
    if(!file||!targetHref) continue;

    // 이미지 저장 (convertImageFile로 통일 — 설정에 따라 JPG 변환 or 원본 유지)
    const {blob:imgBlob, ext:dext, mt}=await convertImageFile(file);
    const imgDest=opfBase+'Images/ill_img_'+String(imgIdx).padStart(4,'0')+'.'+dext;
    const imgRelHref='Images/ill_img_'+String(imgIdx).padStart(4,'0')+'.'+dext;
    newZip.file(imgDest,await fileToAB(imgBlob));
    const imgId='edit_img_'+String(imgIdx).padStart(4,'0');
    opfText=opfText.replace('</manifest>','<item id="'+imgId+'" href="'+imgRelHref+'" media-type="'+mt+'"/>\n</manifest>');
    imgIdx++;

    // ill xhtml 페이지 생성
    const illFname='ill_edit_'+String(illIdx).padStart(4,'0')+'.xhtml';
    const illFullPath=opfBase+'Text/'+illFname;
    const illRelHref='Text/'+illFname;
    const illId='ill_edit_'+String(illIdx).padStart(4,'0');
    const illTitle='삽화';
    newZip.file(illFullPath,'<?xml version="1.0" encoding="utf-8"?><!DOCTYPE html>\n'+
      '<html xmlns="http://www.w3.org/1999/xhtml"><head><title>'+illTitle+'</title>\n'+
      '<link rel="stylesheet" type="text/css" href="../'+cssHref+'"/></head>\n'+
      '<body><div class="illust-page"><img src="../'+imgRelHref+'" alt="삽화"/></div></body></html>');

    // manifest에 ill xhtml 추가
    opfText=opfText.replace('</manifest>','<item id="'+illId+'" href="'+illRelHref+'" media-type="application/xhtml+xml"/>\n</manifest>');

    // spine에 삽입 (targetHref 기준)
    const targetRel=targetHref.replace(opfBase,'');
    const manifestMatch=opfText.match(new RegExp('<item[^>]+id="([^"]+)"[^>]+href="'+targetRel.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')+'"'));
    const targetId=manifestMatch?manifestMatch[1]:'';
    const newItemRef='<itemref idref="'+illId+'"/>';
    if(targetId){
      if(pos==='before') opfText=opfText.replace('<itemref idref="'+targetId+'"/>',newItemRef+'\n<itemref idref="'+targetId+'"/>');
      else opfText=opfText.replace('<itemref idref="'+targetId+'"/>','<itemref idref="'+targetId+'"/>\n'+newItemRef);
    }else{
      opfText=opfText.replace('</spine>',newItemRef+'\n</spine>');
    }

    // NCX 업데이트
    if(ncxFile&&ncxText){
      const selFn=targetRel.split('/').pop();
      const escFn=selFn.replace(/[.*+?^${}()|[\]\\]/g,'\\$&');
      const newNavPt='<navPoint id="'+illId+'" playOrder="'+(maxNcxOrder+ncxOrderOffset+1)+'">'+
        '<navLabel><text>'+illTitle+'</text></navLabel>'+
        '<content src="'+illRelHref+'"/></navPoint>';
      ncxOrderOffset++;
      const ncxSafeRx=new RegExp('<navPoint[^>]*>(?:(?!</navPoint>)[\\s\\S])*?<content src="[^"]*'+escFn+'[^"]*"/>(?:(?!</navPoint>)[\\s\\S])*?</navPoint>');
      const ncxM=ncxText.match(ncxSafeRx);
      if(ncxM){
        if(pos==='before') ncxText=ncxText.replace(ncxM[0],newNavPt+'\n'+ncxM[0]);
        else ncxText=ncxText.replace(ncxM[0],ncxM[0]+'\n'+newNavPt);
      }else{
        ncxText=ncxText.replace('</navMap>',newNavPt+'\n</navMap>');
      }
    }

    // nav.xhtml 업데이트
    if(navFile&&navText){
      const selFn=targetRel.split('/').pop();
      const escFn=selFn.replace(/[.*+?^${}()|[\]\\]/g,'\\$&');
      const newLi='<li><a href="'+illRelHref+'">'+illTitle+'</a></li>';
      const navM=navText.match(new RegExp('<li><a href="[^"]*'+escFn+'[^"]*">[^<]*</a></li>'));
      if(navM){
        if(pos==='before') navText=navText.replace(navM[0],newLi+'\n'+navM[0]);
        else navText=navText.replace(navM[0],navM[0]+'\n'+newLi);
      }else{
        navText=navText.replace('</ol>',newLi+'\n</ol>');
      }
    }
    illIdx++;
  }

  // 업데이트된 파일들 저장
  newZip.file(opfPath,opfText);
  if(ncxFile&&ncxText) newZip.file(ncxFile,ncxText);
  if(navFile&&navText) newZip.file(navFile,navText);
}



function downloadEditEpub(){
  if(!E.resultBlob)return;
  const a=document.createElement('a');a.href=URL.createObjectURL(E.resultBlob);a.download=E.resultName;a.click();
  setTimeout(()=>URL.revokeObjectURL(a.href),1000);
}

// ══════════════════════════════════════════
// ✏️ Module: DirectEditEpub (EPUB 직접 편집)
// ══════════════════════════════════════════
let _directEditResult=null; // {blob, name}
let _directEditIllFiles=[];  // 삽화 파일 목록
let _directEditTocItems=[];  // 목차 편집 상태

// ── EPUB 텍스트 추출 (목차 재생성용) ──
let _epubRawText='';     // 전체 텍스트 (줄 배열 아님)
let _epubRawLines=[];    // 줄 배열
let _eTocItems=[];       // 감지된 목차 아이템
let _eSmartPatTimer=null;

async function extractEpubRawText(){
  if(!E.epubZip||!E.chapters.length){ _epubRawText=''; _epubRawLines=[]; return; }
  // EPUB 각 챕터 xhtml → 텍스트 추출 후 합치기
  const parts=[];
  for(const ch of E.chapters){
    try{
      const xhtml=await E.epubZip.file(ch.href)?.async('text')||'';
      const doc=new DOMParser().parseFromString(xhtml,'text/html');
      // body 텍스트만 추출 (태그 제거)
      const body=doc.body?.innerText||doc.body?.textContent||'';
      parts.push(body.trim());
    }catch(e){}
  }
  _epubRawText=parts.join('\n\n');
  _epubRawLines=_epubRawText.split('\n');
  // 원본 텍스트 탭 갱신
  const tb1=document.getElementById('eTb1');
  if(tb1&&tb1.style.display!=='none'){
    tb1.innerHTML='<pre class="toc-raw">'+
      _epubRawLines.map((l,i)=>String(i+1).padStart(4,' ')+' | '+escHtml(l)).join('\n')+'</pre>';
  }
}

// ── 목차 확인 (EPUB 버전) ──
async function previewEpubToc(){
  if(!_epubRawText){ Toast.warn('EPUB 파일을 먼저 불러와주세요.'); return; }
  const pat=document.getElementById('eTocPattern').value.trim();
  const tb0=document.getElementById('eTb0');
  const tb1=document.getElementById('eTb1');
  tb0.innerHTML='<div style="font-size:12px;color:var(--text2);padding:8px">🔍 감지 중...</div>';

  // 원본 텍스트 탭 내용 채우기
  tb1.innerHTML='<pre class="toc-raw">'+
    _epubRawLines.map((l,i)=>String(i+1).padStart(4,' ')+' | '+escHtml(l)).join('\n')+'</pre>';

  // 패턴 또는 자동 감지
  let found=[];
  if(pat){
    try{
      const rx=new RegExp(pat,'i');
      _epubRawLines.forEach((l,i)=>{
        if(l.trim()&&rx.test(l.trim())) found.push({line:i+1,title:l.trim(),enabled:true});
      });
    }catch(e){
      tb0.innerHTML='<div style="color:var(--accent);padding:8px;font-size:12px">⚠️ 정규식 오류: '+escHtml(e.message)+'</div>';
      return;
    }
  }else{
    // 자동 감지 — 기존 bestPat 활용
    const {rx}=bestPat(_epubRawText);
    if(rx){
      _epubRawLines.forEach((l,i)=>{
        if(l.trim()&&rx.test(l.trim())) found.push({line:i+1,title:l.trim(),enabled:true});
      });
      document.getElementById('eTocPattern').value=rx.source;
    }
  }

  _eTocItems=found;
  renderETocItems();

  // 칩 감지 결과 갱신
  refreshEDetectedChip();
}

function renderETocItems(){
  const tb0=document.getElementById('eTb0');
  if(!_eTocItems.length){
    tb0.innerHTML='<div class="toc-empty">⚠️ 챕터가 감지되지 않았어요. 정규식을 수정해보세요.</div>';
    return;
  }
  tb0.innerHTML='';
  const stat=document.createElement('div');
  stat.style.cssText='margin-bottom:6px;display:flex;gap:6px;align-items:center;flex-wrap:wrap';
  stat.innerHTML='<span style="font-size:11px;color:var(--text2)">총 <b>'+_eTocItems.length+'</b>개 감지</span>'+
    '<button class="btn btn-ghost btn-sm" data-action="eToggleAllToc" data-val="true">전체 선택</button>'+
    '<button class="btn btn-ghost btn-sm" data-action="eToggleAllToc" data-val="false">전체 해제</button>';
  tb0.appendChild(stat);

  _eTocItems.forEach((item,i)=>{
    const d=document.createElement('div');
    d.className='toc-item'+(item.enabled?'':' off');

    const chk=document.createElement('input');
    chk.type='checkbox'; chk.className='toc-chk'; chk.checked=item.enabled;
    chk.onchange=e=>{ _eTocItems[i].enabled=chk.checked; d.classList.toggle('off',!chk.checked); };

    const num=document.createElement('span');
    num.className='toc-num'; num.textContent=item.line+'줄';

    const title=document.createElement('input');
    title.className='toc-title-edit'; title.value=item.title;
    title.onchange=()=>{ _eTocItems[i].title=title.value.trim()||item.title; };

    d.appendChild(chk); d.appendChild(num); d.appendChild(title);
    tb0.appendChild(d);
  });
}

function eToggleAllToc(v){ _eTocItems.forEach(t=>t.enabled=v); renderETocItems(); }

// ── 정규식 탭 ──
function eTocTab(n){
  const panel=document.getElementById('eTocPanel');
  if(panel) panel.querySelectorAll('.ttab').forEach((t,i)=>t.classList.toggle('on',i===n));
  [0,1,2].forEach(i=>{
    const el=document.getElementById('eTb'+i);
    if(el) el.style.display=i===n?'':'none';
  });
  if(n===1&&_epubRawLines.length){
    document.getElementById('eTb1').innerHTML='<pre class="toc-raw">'+
      _epubRawLines.map((l,i)=>String(i+1).padStart(4,' ')+' | '+escHtml(l)).join('\n')+'</pre>';
  }
}
function applyEPat(){
  const v=document.getElementById('eTocPatEdit').value.trim();
  if(v){ document.getElementById('eTocPattern').value=v; previewEpubToc(); }
}

// ── 빠른 선택 칩 ──
function refreshEDetectedChip(){
  const pat=document.getElementById('eTocPattern').value.trim();
  if(!pat) return;
  const allChips=document.querySelectorAll('#eTocPatHelper .pat-chip');
  allChips.forEach(chip=>{
    chip.classList.remove('detected','active');
    try{
      const rx=new RegExp(chip.dataset.pat,'i');
      if(rx.source===new RegExp(pat,'i').source){ chip.classList.add('detected','active'); }
    }catch(e){}
  });
}
function applyETocSelectedChips(){
  const sel=_chipSelected['eTocPatHelper'];
  if(!sel||!sel.size){ Toast.warn('패턴을 먼저 선택해주세요.'); return; }
  const combined=buildCombinedPat(sel);
  document.getElementById('eTocPattern').value=combined;
  clearChipSelection('eTocPatHelper');
  document.getElementById('eTocPatApplyBar').style.display='none';
  previewEpubToc();
}

// ── AI 스마트 패턴 (EPUB 버전) ──
function eSmartPatConvert(){
  clearTimeout(_eSmartPatTimer);
  const include=document.getElementById('eSmartPatInput')?.value.trim()||'';
  const exclude=document.getElementById('eSmartPatExclude')?.value.trim()||'';
  if(!include){ document.getElementById('eSmartPatResultBox').style.display='none'; return; }
  _eSmartPatTimer=setTimeout(()=>_eRunSmartPat(include, exclude), 600);
}
async function _eRunSmartPat(include, exclude){
  const resultBox=document.getElementById('eSmartPatResultBox');
  const resultEl=document.getElementById('eSmartPatResult');
  const aiLabel=document.getElementById('eSmartPatAiLabel');
  const applyBtn=resultBox.querySelector('button');
  const apiKey=(document.getElementById('geminiApiKey')?.value||'').trim();
  resultBox.style.display='flex'; resultBox.style.borderColor='var(--border)';
  resultEl.textContent='⏳ 변환 중...'; applyBtn.style.display='none';
  if(aiLabel) aiLabel.style.display='none';
  try{
    let rx=null;
    if(apiKey){
      rx=await _askGeminiForPattern(apiKey, include, exclude);
    }
    if(!rx) rx=guessPatternFromExample(include);
    if(rx){
      resultEl.textContent=rx;
      resultBox.style.borderColor='var(--accent)';
      applyBtn.style.display='';
      if(apiKey&&aiLabel) aiLabel.style.display='';
    }else{
      resultEl.textContent='(인식 불가 — 정규식 수정 탭에서 직접 입력)';
      resultBox.style.borderColor='var(--border)';
    }
  }catch(e){
    const msg=e.message||'';
    if(msg==='quota_exceeded'){
      Toast.warn(
        'Gemini API 할당량 초과 — 내장 변환 로직을 사용해요.<br>'+
        '<small style="opacity:.8">💡 오류에 <b>limit: 0</b>이 있으면 Google AI Studio 키인지 확인해주세요.<br>'+
        'https://aistudio.google.com/app/apikey</small>'
      );
    } else if(msg.includes('API 키가 올바르지 않아요')){
      resultEl.textContent='⚠ '+msg;
      resultBox.style.borderColor='var(--accent)';
      resultBox.style.display='flex';
      applyBtn.style.display='none';
      return;
    } else {
      console.warn('[Gemini] _eRunSmartPat 오류:', e);
    }
    const rx2=guessPatternFromExample(include);
    if(rx2){ resultEl.textContent=rx2; resultBox.style.borderColor='var(--accent)'; applyBtn.style.display=''; }
    else{ resultEl.textContent='(변환 실패 — 정규식 수정 탭에서 직접 입력)'; resultBox.style.borderColor='var(--border)'; }
  }
}
function applyESmartPat(){
  const rx=document.getElementById('eSmartPatResult')?.textContent;
  if(!rx||rx.startsWith('(')) return;
  document.getElementById('eTocPattern').value=rx;
  document.getElementById('eSmartPatInput').value='';
  document.getElementById('eSmartPatExclude').value='';
  document.getElementById('eSmartPatResultBox').style.display='none';
  previewEpubToc();
}

// ── 탭 전환 ──
function switchEditTab(name){
  ['toc','ill','css'].forEach(t=>{
    const btn=document.getElementById('editTab_'+t);
    const panel=document.getElementById('editPanel_'+t);
    const active=t===name;
    btn.style.color=active?'var(--accent)':'var(--text2)';
    btn.style.borderBottom=active?'2px solid var(--accent)':'2px solid transparent';
    btn.style.background=active?'var(--accent-bg)':'none';
    panel.style.display=active?'block':'none';
  });
  // 삽화 탭 열 때 드롭존 이벤트 초기화
  if(name==='ill') setupDirectEditIllDrop();
}

// ── 목차 렌더 ──
function renderDirectEditToc(){
  if(!E.chapters.length) return;
  // 초기화: chapters 기반으로 tocItems 생성
  if(!_directEditTocItems.length||_directEditTocItems.length!==E.chapters.length){
    _directEditTocItems=E.chapters.map(ch=>({
      href:ch.href, title:ch.title, enabled:true
    }));
  }
  const list=document.getElementById('directEditTocList');
  if(!list) return;
  list.innerHTML='';
  _directEditTocItems.forEach((item,i)=>{
    const d=document.createElement('div');
    d.className='ch-item';
    d.draggable=true;
    d.style.cssText='display:flex;align-items:center;gap:8px;cursor:default;'+(item.enabled?'':'opacity:.4');
    d.dataset.idx=i;

    const chk=document.createElement('input');
    chk.type='checkbox'; chk.className='toc-chk'; chk.checked=item.enabled;
    chk.onchange=()=>{ _directEditTocItems[i].enabled=chk.checked; d.style.opacity=chk.checked?'1':'0.4'; };

    const num=document.createElement('span');
    num.className='ch-idx'; num.textContent=(i+1);

    const title=document.createElement('input');
    title.className='toc-title-edit'; title.value=item.title;
    title.onchange=()=>{ _directEditTocItems[i].title=title.value.trim()||item.title; };

    // 드래그
    d.addEventListener('dragstart',()=>{ d.style.opacity='0.35'; d._dragIdx=i; });
    d.addEventListener('dragend',()=>{ d.style.opacity=item.enabled?'1':'0.4'; });
    d.addEventListener('dragover',e=>{ e.preventDefault(); d.classList.add('drag-over'); });
    d.addEventListener('dragleave',()=>{ d.classList.remove('drag-over'); });
    d.addEventListener('drop',e=>{
      e.preventDefault(); d.classList.remove('drag-over');
      const src=parseInt(list.querySelector('[style*="0.35"]')?.dataset.idx??'-1');
      if(src<0||src===i) return;
      const moved=_directEditTocItems.splice(src,1)[0];
      _directEditTocItems.splice(i,0,moved);
      renderDirectEditToc();
    });

    d.appendChild(chk); d.appendChild(num); d.appendChild(title);
    list.appendChild(d);
  });
}

function directEditTocCheckAll(v){
  _directEditTocItems.forEach(it=>it.enabled=v);
  renderDirectEditToc();
}
function directEditTocMoveUp(){
  // 선택된 체크된 항목 중 첫 번째를 한 칸 위로
  const focused=document.querySelector('#directEditTocList input[type="checkbox"]:checked');
  if(!focused) return;
  const idx=parseInt(focused.closest('[data-idx]')?.dataset.idx??'-1');
  if(idx<=0) return;
  [_directEditTocItems[idx-1],_directEditTocItems[idx]]=[_directEditTocItems[idx],_directEditTocItems[idx-1]];
  renderDirectEditToc();
}
function directEditTocMoveDown(){
  const focused=document.querySelector('#directEditTocList input[type="checkbox"]:checked');
  if(!focused) return;
  const idx=parseInt(focused.closest('[data-idx]')?.dataset.idx??'-1');
  if(idx<0||idx>=_directEditTocItems.length-1) return;
  [_directEditTocItems[idx],_directEditTocItems[idx+1]]=[_directEditTocItems[idx+1],_directEditTocItems[idx]];
  renderDirectEditToc();
}

// ── 삽화 드롭존 ──
function setupDirectEditIllDrop(){
  const dz=document.getElementById('directEditIllDrop');
  const inp=document.getElementById('directEditIllIn');
  if(!dz||dz._ready) return;
  dz._ready=true;
  dz.onclick=()=>inp.click();
  dz.ondragover=e=>{e.preventDefault();dz.classList.add('over');};
  dz.ondragleave=()=>dz.classList.remove('over');
  dz.ondrop=e=>{e.preventDefault();dz.classList.remove('over');handleDirectEditIll(e.dataTransfer.files);};
  inp.onchange=e=>handleDirectEditIll(e.target.files);
  // 수동 매핑 라디오
  document.querySelectorAll('input[name="directEditIllMode"]').forEach(r=>{
    r.onchange=()=>{
      document.getElementById('directEditIllManual').style.display=r.value==='manual'?'block':'none';
    };
  });
}
function handleDirectEditIll(files){
  [...files].forEach(f=>{
    if(!_directEditIllFiles.find(x=>x.name===f.name)) _directEditIllFiles.push(f);
  });
  renderDirectEditIllTags();
}
function renderDirectEditIllTags(){
  const c=document.getElementById('directEditIllTags'); c.innerHTML='';
  _directEditIllFiles.forEach((f,i)=>{
    const stem=f.name.replace(/\.[^.]+$/,'');
    const mi=stem.match(/^(\d+)(?:_(\d+))?/);
    const badge=mi?`<span style="font-size:9px;background:var(--accent-bg);color:var(--accent);border-radius:3px;padding:1px 5px;font-weight:700">${parseInt(mi[1])}번째${mi[2]?'-'+parseInt(mi[2]):''}</span>`:'';
    const t=document.createElement('div');
    t.className='tag';
    t.innerHTML=`<span style="font-size:11px;max-width:120px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${escHtml(f.name)}</span>${badge}<span class="x" onclick="removeDirectEditIll(${i})">✕</span>`;
    c.appendChild(t);
  });
}
function removeDirectEditIll(i){ _directEditIllFiles.splice(i,1); renderDirectEditIllTags(); }
function addDirectEditIllRow(){
  const list=document.getElementById('directEditIllManualList');
  const id=Date.now();
  const div=document.createElement('div');
  div.className='mill-row'; div.id='deir_'+id;
  div.style.marginBottom='8px';
  div.innerHTML=
    '<div style="display:flex;gap:6px;align-items:center;flex-wrap:wrap">'+
    '<select id="deif_'+id+'" style="flex:2;min-width:100px;font-size:12px;padding:5px 8px;border:1.5px solid var(--border);border-radius:6px;background:var(--bg);color:var(--text);font-family:inherit">'+
    '<option value="">파일 선택</option>'+
    _directEditIllFiles.map(f=>`<option value="${escHtml(f.name)}">${escHtml(f.name)}</option>`).join('')+
    '</select>'+
    '<input type="number" id="deich_'+id+'" placeholder="챕터 번호(1-based)" min="1" style="width:130px;font-size:12px;padding:5px 8px;border:1.5px solid var(--border);border-radius:6px;background:var(--bg);color:var(--text)">'+
    '<select id="deip_'+id+'" style="font-size:12px;padding:5px 8px;border:1.5px solid var(--border);border-radius:6px;background:var(--bg);color:var(--text);font-family:inherit"><option value="before">챕터 앞</option><option value="after">챕터 뒤</option></select>'+
    '<button class="btn btn-sm" style="background:var(--accent-bg);color:var(--accent)" data-action="removeDirectIllRow" data-row-id="deir_'+id+'">✕</button>'+
    '</div>';
  list.appendChild(div);
}

// ── CSS 프리셋 ──
function directEditCssPreset(type){
  const ta=document.getElementById('directEditCssInput');
  const presets={
    indent:'p { text-indent: 1em; margin: 0; }\nbody { padding: 1em 1.5em; }',
    line:'body { line-height: 1.9; }\np { margin-bottom: 0.4em; }',
    font:"body { font-size: 1.05em; font-family: 'Noto Serif KR', serif; }",
    reset:'* { margin: 0; padding: 0; box-sizing: border-box; }\nbody { font-size: 1em; line-height: 1.8; padding: 1em; }'
  };
  ta.value=(ta.value?ta.value+'\n\n':'')+presets[type];
}

// ── 적용 ──
async function applyDirectEdit(){
  if(!E.epubZip){ Toast.warn('EPUB 파일을 먼저 불러와주세요.'); return; }

  const activeTab=['toc','ill','css'].find(t=>document.getElementById('editPanel_'+t).style.display!=='none')||'toc';
  const progWrap=document.getElementById('directEditProgWrap');
  const progBar=document.getElementById('directEditProgBar');
  const progMsg=document.getElementById('directEditProgMsg');
  const errBox=document.getElementById('directEditErrBox');
  const resultBox=document.getElementById('directEditResultBox');

  progWrap.classList.add('show'); errBox.classList.remove('show'); resultBox.style.display='none';
  function ep(pct,msg){ progBar.style.width=pct+'%'; progMsg.textContent=msg; }

  try{
    ep(5,'EPUB 복제 중...');
    const newZip=new JSZip();
    for(const[name,f] of Object.entries(E.epubZip.files)){
      if(f.dir) continue;
      newZip.file(name, await f.async('arraybuffer'));
    }

    const containerXml=await E.epubZip.file('META-INF/container.xml').async('text');
    const opfPath=containerXml.match(/full-path="([^"]+)"/)[1];
    const opfBase=opfPath.replace(/[^/]+$/,'');

    // ── 목차 재생성 ──
    if(activeTab==='toc'){
      ep(20,'목차 재생성 중...');
      // 감지된 새 목차 사용 (_eTocItems), 없으면 기존 목차 편집 결과 사용
      let enabledItems;
      if(_eTocItems.length>0){
        // 패턴 감지로 새로 생성된 목차 → href를 텍스트 내 줄 번호로 가장 가까운 챕터에 매핑
        enabledItems=_eTocItems.filter(it=>it.enabled).map(item=>{
          // _epubRawLines에서 item.line 기준으로 어느 챕터 xhtml에 해당하는지 계산
          // 챕터 전체 텍스트 합산 줄 수 기반으로 해당 챕터 href 찾기
          let accLines=0;
          let targetHref=E.chapters[0]?.href||'';
          for(const ch of E.chapters){
            const chLines=_epubRawLines.filter((_,i)=>i>=accLines&&i<accLines+9999).length;
            // 챕터당 평균 줄수로 어느 챕터인지 근사
            const chLineCount=Math.ceil(_epubRawLines.length/E.chapters.length);
            const chIdx=Math.min(Math.floor((item.line-1)/Math.max(1,chLineCount)), E.chapters.length-1);
            targetHref=E.chapters[chIdx]?.href||E.chapters[0]?.href;
            break;
          }
          return {href:targetHref, title:item.title, enabled:true};
        });
        // href 중복 제거 (같은 챕터에 여러 제목이 매핑되면 첫 번째만)
        const seen=new Set();
        enabledItems=enabledItems.filter(it=>{ if(seen.has(it.href))return false; seen.add(it.href); return true; });
      }else{
        enabledItems=_directEditTocItems.filter(it=>it.enabled);
      }
      if(!enabledItems.length) throw new Error('활성화된 챕터가 없어요. 먼저 목차 확인을 눌러주세요.');

      // OPF 읽기
      let opfXml=await E.epubZip.file(opfPath).async('text');

      // 메타데이터 수정
      const newTitle=document.getElementById('directEditTitle').value.trim();
      const newAuthor=document.getElementById('directEditAuthor').value.trim();
      if(newTitle) opfXml=opfXml.replace(/<dc:title>[^<]*<\/dc:title>/,`<dc:title>${escHtml(newTitle)}</dc:title>`);
      if(newAuthor) opfXml=opfXml.replace(/<dc:creator[^>]*>[^<]*<\/dc:creator>/,`<dc:creator>${escHtml(newAuthor)}</dc:creator>`);

      // Spine 재생성 (활성화된 챕터 순서로)
      // 새 목차(_eTocItems)일 경우: 기존 모든 챕터 순서 유지 + 제목만 갱신
      const spineItems=(_eTocItems.length>0
        ? E.chapters.map(ch=>ch.href)   // 원본 순서 유지
        : enabledItems.map(it=>it.href) // 편집 순서 적용
      ).map(href=>{
        const relHref=href.replace(opfBase,'');
        const id=relHref.replace(/[^a-zA-Z0-9_-]/g,'_').replace(/^_+/,'ch_');
        return `<itemref idref="${id}"/>`;
      }).join('\n    ');
      opfXml=opfXml.replace(/<spine[^>]*>[\s\S]*?<\/spine>/,
        `<spine toc="ncx">\n    ${spineItems}\n  </spine>`);
      newZip.file(opfPath, opfXml);

      // NCX 재생성
      ep(50,'NCX 목차 재생성 중...');
      const ncxPath=opfBase+(opfXml.match(/href="([^"]*\.ncx)"/)?.[1]||'toc.ncx');
      const navPoints=enabledItems.map((it,idx)=>`
    <navPoint id="np${idx+1}" playOrder="${idx+1}">
      <navLabel><text>${escHtml(it.title)}</text></navLabel>
      <content src="${it.href.replace(opfBase,'')}"/>
    </navPoint>`).join('');
      const ncxXml=`<?xml version="1.0" encoding="UTF-8"?>
<ncx xmlns="http://www.daisy.org/z3986/2005/ncx/" version="2005-1">
  <head><meta name="dtb:depth" content="1"/></head>
  <docTitle><text>${escHtml(newTitle||E.chapters[0]?.title||'')}</text></docTitle>
  <navMap>${navPoints}
  </navMap>
</ncx>`;
      newZip.file(ncxPath, ncxXml);

      // Nav HTML 재생성 (EPUB3)
      const navPath=Object.keys(E.epubZip.files).find(f=>f.includes('nav') && f.endsWith('.xhtml'));
      if(navPath){
        const navItems=enabledItems.map(it=>
          `<li><a href="${it.href.replace(opfBase,'')}">${escHtml(it.title)}</a></li>`
        ).join('\n      ');
        const navHtml=`<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE html>
<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops">
<head><meta charset="UTF-8"/><title>목차</title></head>
<body><nav epub:type="toc"><ol>
      ${navItems}
</ol></nav></body></html>`;
        newZip.file(navPath, navHtml);
      }
      ep(80,'완료 중...');
    }

    // ── 삽화 추가 ──
    else if(activeTab==='ill'){
      ep(20,'삽화 매핑 중...');
      if(!_directEditIllFiles.length) throw new Error('삽화 파일을 먼저 추가해주세요.');

      const mode=document.querySelector('input[name="directEditIllMode"]:checked').value;
      // buildIllEntries와 동일한 인덱스 매핑 로직 사용
      const illEntries=buildIllEntries(E.chapters, opfBase, _directEditIllFiles, mode);
      if(!illEntries.length) throw new Error('삽입할 삽화를 매핑하지 못했어요. 파일명을 확인해주세요.');

      ep(40,'삽화 삽입 중...');
      await insertIllsToEpub(newZip, opfPath, opfBase, illEntries);
      ep(80,'완료 중...');
    }

    // ── CSS 추가 ──
    else if(activeTab==='css'){
      ep(20,'CSS 파일 찾는 중...');
      const userCss=document.getElementById('directEditCssInput').value.trim();
      if(!userCss) throw new Error('추가할 CSS를 입력해주세요.');
      const append=document.getElementById('directEditCssAppend').checked;

      // EPUB 내 CSS 파일 찾기
      const cssFiles=Object.keys(E.epubZip.files).filter(f=>f.endsWith('.css'));
      if(!cssFiles.length) throw new Error('EPUB 내 CSS 파일을 찾지 못했어요.');

      ep(40,'CSS 수정 중...');
      for(const cssFile of cssFiles){
        const orig=append ? (await E.epubZip.file(cssFile).async('text'))+'\n\n/* === 추가된 CSS === */\n'+userCss : userCss;
        newZip.file(cssFile, orig);
      }
      ep(80,'완료 중...');
    }

    ep(90,'EPUB 생성 중...');
    const blob=await newZip.generateAsync({type:'blob',compression:'DEFLATE',compressionOptions:{level:6}});
    const origName=(E.epubFile?.name||'edited').replace(/\.epub$/i,'');
    const suffix=activeTab==='toc'?'_목차수정':activeTab==='ill'?'_삽화추가':'_CSS추가';
    _directEditResult={blob, name:origName+suffix+'.epub'};
    ep(100,'완료!');
    document.getElementById('directEditResultMsg').textContent=_directEditResult.name;
    resultBox.style.display='block';
    Toast.success('EPUB 편집이 완료됐어요.');
  }catch(e){
    errBox.textContent='❌ '+e.message; errBox.classList.add('show');
    progWrap.classList.remove('show');
    console.error(e);
  }
}

function downloadDirectEditEpub(){
  if(!_directEditResult) return;
  const a=document.createElement('a');
  a.href=URL.createObjectURL(_directEditResult.blob);
  a.download=_directEditResult.name; a.click();
  setTimeout(()=>URL.revokeObjectURL(a.href),1000);
}

// buildIllEntries 오버로드: directEdit용 파일 목록 지원
function buildIllEntries(epubChapters, opfBase, illFilesOverride, modeOverride){
  const files=illFilesOverride||EI.files;
  const mode=modeOverride||(document.querySelector('input[name="editIllMode"]:checked')?.value||'auto');
  const entries=[];
  const overflowWarnings=[];

  if(mode==='auto'){
    const autoEntries=[];
    for(const f of files){
      const stem=f.name.replace(/\.[^.]+$/,'');
      const m=stem.match(/^(\d+)(?:_(\d+))?/);
      if(!m) continue;
      const chIdx=parseInt(m[1])-1;
      const order=parseInt(m[2]||'1');
      let ch=null;
      if(chIdx>=0&&chIdx<epubChapters.length){
        ch=epubChapters[chIdx];
      }else if(epubChapters.length>0){
        ch=epubChapters[epubChapters.length-1];
        overflowWarnings.push(f.name);
      }
      if(ch) autoEntries.push({file:f, targetHref:ch.href, pos:'before', order});
    }
    autoEntries.sort((a,b)=>a.order-b.order);
    entries.push(...autoEntries);
  }else{
    // 수동: 기존 eir_ 또는 deir_ 행 파싱
    const prefix=illFilesOverride?'deir_':'eir_';
    document.querySelectorAll('[id^="'+prefix+'"]').forEach(row=>{
      const id=row.id.replace(prefix,'');
      const fname=document.getElementById((illFilesOverride?'deif_':'eif_')+id)?.value.trim();
      if(!fname) return;
      const file=files.find(f=>f.name===fname);
      if(!file) return;
      const chNum=parseInt(document.getElementById((illFilesOverride?'deich_':'eic_')+id)?.value||'0');
      const pos=document.getElementById((illFilesOverride?'deip_':'eip_')+id)?.value||'before';
      const chIdx=chNum-1;
      const ch=chIdx>=0&&chIdx<epubChapters.length?epubChapters[chIdx]:null;
      if(ch) entries.push({file,targetHref:ch.href,pos});
    });
  }

  // 기존 editIll 경로에서만 overflow 경고 표시
  if(!illFilesOverride){
    const warnEl=document.getElementById('editIllOverflowWarn');
    if(warnEl){
      if(overflowWarnings.length>0){
        warnEl.textContent='⚠️ 목차 수('+epubChapters.length+'화)를 초과하는 삽화 '+overflowWarnings.length+'개가 마지막 챕터에 배치되었습니다: '+overflowWarnings.join(', ');
        warnEl.style.display='block';
      }else{ warnEl.style.display='none'; }
    }
  }
  return entries;
}


// ══════════════════════════════════════════
// 🔍 Module: CoverSearch (표지 검색 모달)
// ══════════════════════════════════════════
let _coverModalMode='convert';
let _searchAbortCtrl=null; // ★ 검색 Abort 컨트롤러

function saveApiSettings(){
  try{
    // geminiApiKey → sessionStorage (탭 닫으면 자동 삭제)
    const gemKey=document.getElementById('geminiApiKey')?.value||'';
    if(gemKey) sessionStorage.setItem('epub_gemini_key', gemKey);
    else sessionStorage.removeItem('epub_gemini_key');
    _updateGeminiKeyBadge();
    localStorage.setItem('epub_api',JSON.stringify({
      geminiApiKey:'', // localStorage에는 더 이상 저장 안 함
      naverClientId:document.getElementById('naverClientId')?.value||'',
      naverClientSecret:document.getElementById('naverClientSecret')?.value||'',
    }));
  }catch(e){}
}
// ── Gemini API Key 상태 배지 ──
function _updateGeminiKeyBadge(){
  const input=document.getElementById('geminiApiKey');
  const badge=document.getElementById('geminiKeyStatus');
  if(!input||!badge) return;
  const hasKey=input.value.trim().length>0;
  badge.style.display=hasKey?'':'none';
  badge.textContent=hasKey?'✅ 등록됨':'';
  badge.style.background=hasKey?'var(--green-bg)':'';
  badge.style.color=hasKey?'var(--green)':'';
}

function loadApiSettings(){
  try{
    // geminiApiKey: sessionStorage (탭 닫으면 삭제 — XSS 위험 감소)
    // naverClient*: localStorage (편의상 유지)
    const gemKey=sessionStorage.getItem('epub_gemini_key')||'';
    if(gemKey&&document.getElementById('geminiApiKey')) document.getElementById('geminiApiKey').value=gemKey;
    const s=JSON.parse(localStorage.getItem('epub_api')||'{}');
    if(s.geminiApiKey&&!gemKey&&document.getElementById('geminiApiKey'))
      document.getElementById('geminiApiKey').value=s.geminiApiKey; // 기존 localStorage 마이그레이션
    // 키 상태 배지 갱신
    _updateGeminiKeyBadge();
    if(s.naverClientId&&document.getElementById('naverClientId')) document.getElementById('naverClientId').value=s.naverClientId;
    if(s.naverClientSecret&&document.getElementById('naverClientSecret')) document.getElementById('naverClientSecret').value=s.naverClientSecret;
  }catch(e){}
}

// ── 검색용 순수 제목 추출 ──
// "작품명 1-489 본편, 후일담, 번외편 완" → "작품명"
// "작품명 2권" / "작품명_완결" / "[작가명] 작품명" → "작품명"
function extractSearchTitle(raw) {
  let t = raw
    .replace(/\.txt$/i, '')
    // ★ [연재], (완결), {개정판} 등 메타 태그 제거
    .replace(/[\[\(\{][^\]\)\}]{0,20}[\]\)\}]/g, '')
    // 작가명@ 또는 @작가명 제거
    .replace(/^.+?@\s*/, '')
    .replace(/@.+$/, '')
    // 언더스코어/하이픈 구분자로 연결된 접두사 제거: "작가명_제목" → "제목"
    .replace(/^[^가-힣a-zA-Z\d]*[a-zA-Z\d가-힣]{1,10}[_\-]\s*/, '')
    .replace(/\s+/g, ' ')
    .trim();

  // 숫자 범위 제거: "1-489화", "1~300"
  t = t.replace(/\s+\d+[-~]\d+[화편]?.*$/, '');
  // 권/부 앞까지만
  t = t.replace(/\s+\d+[권부].*$/, '');
  // 완결·번외·후일담·외전 이후 제거
  t = t.replace(/\s*(?:완결?|완전판|전권|전편|번외|후일담|외전|특별판|최종화|연재중|연재|단행본|개정판|리마스터|무삭제|성인판).*$/i, '');
  // 쉼표 뒤 제거
  t = t.replace(/,.*$/, '');
  // 남은 괄호 제거
  t = t.replace(/\s*[\(\[\{].+$/, '');
  // 숫자만 남으면 원본 복원
  if(/^\d+$/.test(t.trim())) t=raw.replace(/\.txt$/i,'').trim();

  return t.trim() || raw.replace(/\.txt$/i,'').trim();
}

function openCoverModal(mode){
  _coverModalMode=mode;
  let q='';
  if(mode==='convert'){
    // 입력된 제목 우선, 없으면 파일명에서 추출
    const titleInput=document.getElementById('title')?.value.trim()||'';
    if(titleInput){
      q=extractSearchTitle(titleInput);
    } else if(S.txtFiles.length){
      q=extractSearchTitle(S.txtFiles[0].name);
    }
  } else {
    const f=B.txtFiles[0];
    q=f ? extractSearchTitle(f.name) : '';
  }
  document.getElementById('coverSearchQ').value=q;
  document.getElementById('coverModal').classList.add('show');
  if(q) setTimeout(()=>runCoverSearch(),100);
  else document.getElementById('coverModalBody').innerHTML=
    '<div style="text-align:center;padding:40px 0;color:var(--text2);font-size:13px">소설 제목을 입력하고 검색하면<br>네이버·리디·카카오페이지·노벨피아·구글에서 동시 검색해요</div>';
}
function closeCoverModal(){
  document.getElementById('coverModal').classList.remove('show');
  document.body.style.overflow='';
  document.body.style.touchAction='';
  // ★ Abort 진행 중인 검색 취소
  if(_searchAbortCtrl){_searchAbortCtrl.abort();_searchAbortCtrl=null;}
}

// ★ Center Crop + Resize: EPUB 표준 비율(2:3)로 중앙 크롭
// maxH = 1200px, targetRatio = 2/3 (width/height)
async function centerCropToBlob(src, targetW=800, targetH=1200, quality=0.92){
  return new Promise(resolve=>{
    const img=new Image();
    img.crossOrigin='anonymous';
    img.onload=()=>{
      const canvas=document.createElement('canvas');
      canvas.width=targetW; canvas.height=targetH;
      const ctx=canvas.getContext('2d');
      ctx.fillStyle='#ffffff';
      ctx.fillRect(0,0,targetW,targetH);

      // 소스 비율 계산
      const srcRatio=img.naturalWidth/img.naturalHeight;
      const tgtRatio=targetW/targetH;
      let sx,sy,sw,sh;
      if(srcRatio>tgtRatio){
        // 소스가 더 넓음 → 좌우 크롭
        sh=img.naturalHeight; sw=sh*tgtRatio;
        sx=(img.naturalWidth-sw)/2; sy=0;
      } else {
        // 소스가 더 좁음 → 상하 크롭
        sw=img.naturalWidth; sh=sw/tgtRatio;
        sx=0; sy=(img.naturalHeight-sh)/2;
      }
      ctx.drawImage(img,sx,sy,sw,sh,0,0,targetW,targetH);
      canvas.toBlob(blob=>{
        if(blob) resolve(blob);
        else resolve(null);
      },'image/jpeg',quality);
    };
    img.onerror=()=>resolve(null);
    img.src=typeof src==='string'?src:URL.createObjectURL(src);
  });
}

// 이미지 클릭 → Center Crop → 표지 적용 + 모달 닫기
async function applyCoverCard(url, title){
  const inpId=_coverModalMode==='convert'?'coverUrlInp':'batchCoverUrlInp';
  const thumbId=_coverModalMode==='convert'?'coverThumb':null;
  const nameId=_coverModalMode==='convert'?'coverName':null;

  // ★ 외부 URL 이미지 → Center Crop → Blob URL로 변환
  try{
    const croppedBlob=await centerCropToBlob(url,800,1200,0.92);
    if(croppedBlob){
      const croppedUrl=URL.createObjectURL(croppedBlob);
      const inp=document.getElementById(inpId);
      if(inp) inp.value=croppedUrl;
      closeCoverModal();
      await applyCoverUrl(inpId,thumbId,nameId,_coverModalMode);
      return;
    }
  }catch(e){/* 실패 시 원본 URL 사용 */}

  // 폴백: 원본 URL 그대로
  const inp=document.getElementById(inpId);
  if(inp) inp.value=url;
  closeCoverModal();
  await applyCoverUrl(inpId,thumbId,nameId,_coverModalMode);
}

// ── 메인 검색: 4개 플랫폼 병렬 실행 ──
async function runCoverSearch(){
  const q=document.getElementById('coverSearchQ').value.trim();
  if(!q) return;

  // ★ 이전 검색 Abort
  if(_searchAbortCtrl){_searchAbortCtrl.abort();}
  _searchAbortCtrl=new AbortController();
  const signal=_searchAbortCtrl.signal;

  const PLATFORMS=Object.entries(CoverSearchAdapters).map(([id,a])=>({id,label:a.label,badge:a.badge,fn:a.fetch}));

  const body=document.getElementById('coverModalBody');
  body.innerHTML=PLATFORMS.map(p=>
    `<div class="cover-platform-sec" id="sec_${p.id}">
      <div class="cover-platform-hdr">
        <span class="cover-platform-label">${p.label}</span>
        <span class="cover-platform-spinner" id="spin_${p.id}"></span>
        <span class="cover-platform-status" id="stat_${p.id}">검색 중...</span>
      </div>
      <div class="cover-strip" id="strip_${p.id}">
        ${[0,1,2,3,4].map(()=>'<div style="width:90px;height:158px;background:var(--border);border-radius:8px;flex-shrink:0;animation:fadeUp .6s ease infinite alternate"></div>').join('')}
      </div>
    </div>`
  ).join('')+
  // ★ URL 직접 입력 + 파일 드래그 영역
  `<div id="cover-manual-area" style="margin-top:12px;border-top:1px solid var(--border);padding-top:10px">
    <div style="font-size:11px;font-weight:600;color:var(--text);margin-bottom:6px">🖼 직접 등록</div>
    <div style="display:flex;gap:6px;margin-bottom:8px">
      <input id="coverDirectUrl" class="inp" placeholder="이미지 URL 붙여넣기 (https://...)" style="font-size:11px;flex:1">
      <button class="btn btn-blue btn-sm" onclick="applyDirectCoverUrl()" style="font-size:11px;white-space:nowrap">✅ 적용</button>
    </div>
    <div id="coverFileDrop"
         style="border:2px dashed var(--border);border-radius:8px;padding:14px;text-align:center;font-size:11px;color:var(--text2);cursor:pointer;transition:border-color .2s"
         ondragover="event.preventDefault();this.style.borderColor='var(--accent)'"
         ondragleave="this.style.borderColor='var(--border)'"
         ondrop="handleCoverFileDrop(event)"
         onclick="document.getElementById('coverFileInput').click()">
      파일을 여기에 드래그하거나 클릭해서 선택
      <input type="file" id="coverFileInput" accept=".jpg,.jpeg,.png,.webp,.bmp" hidden
             onchange="handleCoverFileSelect(this.files)">
    </div>
  </div>`+
  `<div class="platform-link-row">
    <span style="font-size:10px;color:var(--text2);align-self:center">직접 열기:</span>
    ${[
      ['네이버 시리즈','https://series.naver.com/search/search.series?query='+encodeURIComponent(q)+'&categoryTypeCode=novel'],
      ['리디북스','https://ridibooks.com/search?q='+encodeURIComponent(q)],
      ['카카오페이지','https://page.kakao.com/search/result?keyword='+encodeURIComponent(q)],
      ['노벨피아','https://novelpia.com/search/novel?search_string='+encodeURIComponent(q)],
      ['구글 이미지','https://www.google.com/search?tbm=isch&q='+encodeURIComponent(q+' 소설 표지')],
    ].map(([l,u])=>`<button class="platform-link" onclick="window.open('${u}','_blank')">${escHtml(l)} ↗</button>`).join('')}
    <button class="platform-link" id="searchAbortBtn" style="margin-left:auto;color:var(--accent);border-color:var(--accent)" onclick="abortCoverSearch()">⛔ 중단</button>
  </div>`;

  // 병렬 실행 — Abort 신호 전달
  PLATFORMS.forEach(p=>{
    if(signal.aborted) return;
    const fetchFn=p.fn;
    // signal을 지원하는 어댑터는 두 번째 인자로 전달, 아닌 경우 graceful 처리
    Promise.resolve().then(()=>fetchFn(q,signal)).then(items=>{
      if(signal.aborted) return;
      renderPlatformStrip(p.id,p.label,p.badge,q,items);
    }).catch(e=>{
      if(e?.name==='AbortError'||signal.aborted) return;
      renderPlatformFallback(p.id,p.label,q);
    });
  });
}

// ★ 검색 Abort
function abortCoverSearch(){
  if(_searchAbortCtrl){_searchAbortCtrl.abort();_searchAbortCtrl=null;}
  document.getElementById('searchAbortBtn')?.remove();
  document.querySelectorAll('.cover-platform-spinner').forEach(el=>el.style.display='none');
  document.querySelectorAll('.cover-platform-status').forEach(el=>{if(el.textContent==='검색 중...')el.textContent='중단됨';});
}

// ★ URL 직접 적용
async function applyDirectCoverUrl(){
  const url=document.getElementById('coverDirectUrl')?.value.trim();
  if(!url) return;
  await applyCoverCard(url,'직접 입력');
}

// ★ 파일 드롭 핸들러
async function handleCoverFileDrop(e){
  e.preventDefault();
  document.getElementById('coverFileDrop').style.borderColor='var(--border)';
  const file=e.dataTransfer?.files[0];
  if(file&&file.type.startsWith('image/')) await applyCoverFile(file);
}
async function handleCoverFileSelect(files){
  const file=files?.[0];
  if(file) await applyCoverFile(file);
}
async function applyCoverFile(file){
  const blob=await centerCropToBlob(file,800,1200,0.92);
  const objectUrl=URL.createObjectURL(blob||file);
  const inpId=_coverModalMode==='convert'?'coverUrlInp':'batchCoverUrlInp';
  const inp=document.getElementById(inpId);
  if(inp) inp.value=objectUrl;
  closeCoverModal();
  await applyCoverUrl(inpId,_coverModalMode==='convert'?'coverThumb':null,_coverModalMode==='convert'?'coverName':null,_coverModalMode);
}

// ── 각 섹션 렌더 ──
// ── 이미지 CORS 프록시 헬퍼 ──
// Workers 경유로 이미지 로드 → CORS 헤더 자동 추가
// crossorigin 속성 없이 로드하면 canvas 오염 없이 표시만 가능
function proxyImgUrl(originalUrl){
  if(!originalUrl) return '';
  const worker=PROXIES.find(p=>p.url.includes('workers.dev'));
  if(worker) return worker.url+encodeURIComponent(originalUrl);
  return originalUrl; // Workers 없으면 직접 시도
}

// img onerror: Workers 경유 실패 시 직접 URL → 그래도 실패 시 placeholder
function imgError(el, originalUrl){
  if(el.dataset.retried==='1'){
    // 최종 실패 → 회색 placeholder
    el.style.display='none';
    const ph=document.createElement('div');
    ph.style.cssText='width:90px;height:128px;background:var(--border);border-radius:4px;display:flex;align-items:center;justify-content:center;font-size:10px;color:var(--text2);text-align:center;padding:4px';
    ph.textContent='이미지\n없음';
    el.parentElement?.insertBefore(ph, el);
    return;
  }
  el.dataset.retried='1';
  el.src=originalUrl; // 직접 URL로 재시도
}

function renderPlatformStrip(id, label, badgeClass, q, items){
  const strip=document.getElementById('strip_'+id);
  const stat=document.getElementById('stat_'+id);
  const spin=document.getElementById('spin_'+id);
  if(!strip) return;
  if(spin) spin.style.display='none';

  if(!items||!items.length){
    if(stat) stat.textContent='결과 없음';
    strip.innerHTML=`<div class="cover-fallback">
      <span>직접 검색 →</span>
      <button onclick="window.open(getPlatformUrl('${id}','${escHtml(q)}'),'_blank')">🌐 ${escHtml(label)} 열기</button>
    </div>`;
    return;
  }
  if(stat) stat.textContent=items.length+'개';
  strip.innerHTML=items.map((item,i)=>{
    const rawUrl=item.image||'';
    const proxiedUrl=escHtml(proxyImgUrl(rawUrl));  // Workers 경유 URL
    const directUrl=escHtml(rawUrl);                 // 직접 URL (fallback)
    const title=(item.title||'').replace(/'/g,"\\'").replace(/"/g,'&quot;');
    const titleHtml=escHtml(item.title||'');
    return `<div class="cover-result-card" onclick="applyCoverCard('${directUrl}','${title}')" title="${titleHtml}">
      <span class="cover-result-badge ${badgeClass}">${id==='naver'?'N':id==='ridi'?'R':id==='kakao'?'K':id==='novelpia'?'NP':'G'}</span>
      <div class="apply-overlay">클릭해서 적용</div>
      <img class="cover-result-img" src="${proxiedUrl}" alt="${titleHtml}" loading="lazy"
           referrerpolicy="no-referrer"
           data-original="${directUrl}"
           onerror="imgError(this,'${directUrl}')">
      <div class="cover-result-title">${titleHtml}</div>
    </div>`;
  }).join('');
}

function renderPlatformFallback(id, label, q){
  const strip=document.getElementById('strip_'+id);
  const stat=document.getElementById('stat_'+id);
  const spin=document.getElementById('spin_'+id);
  if(spin) spin.style.display='none';
  if(stat) stat.textContent='크롤링 실패';
  if(strip) strip.innerHTML=`<div class="cover-fallback">
    <span>사이트에서 직접 검색 후 이미지 URL 복사</span>
    <button onclick="window.open(getPlatformUrl('${id}','${escHtml(q)}'),'_blank')">🌐 ${escHtml(label)} 열기</button>
  </div>`;
}

function getPlatformUrl(id,q){
  const urls={
    naver:'https://series.naver.com/search/search.series?query='+encodeURIComponent(q)+'&categoryTypeCode=novel',
    ridi:'https://ridibooks.com/search?q='+encodeURIComponent(q),
    kakao:'https://page.kakao.com/search/result?keyword='+encodeURIComponent(q),
    novelpia:'https://novelpia.com/search/novel?search_string='+encodeURIComponent(q),
    google:'https://www.google.com/search?tbm=isch&q='+encodeURIComponent(q+' 소설 표지'),
  };
  return urls[id]||'#';
}

// ══════════════════════════════════════════
// 🌐 Module: Crawlers (네이버·리디·노벨피아·구글)
// ══════════════════════════════════════════
// ── CoverSearchAdapters: 플랫폼별 어댑터 패턴 ──
// 새 플랫폼 추가 = 이 객체에 항목 1개만 추가하면 됨
const CoverSearchAdapters = {
  naver:    { label:'📗 네이버 시리즈',  badge:'badge-naver',    fetch: q=>fetchNaver(q) },
  ridi:     { label:'📘 리디북스',        badge:'badge-ridi',     fetch: q=>fetchRidi(q)  },
  kakao:    { label:'🟡 카카오페이지',    badge:'badge-kakao',    fetch: q=>fetchKakao(q) },
  novelpia: { label:'📙 노벨피아',         badge:'badge-novelpia', fetch: q=>fetchNovelpia(q) },
  google:   { label:'🌐 구글 이미지',     badge:'badge-google',   fetch: q=>fetchGoogle(q) },
};

// 다중 프록시 설정
// type: 'json' → {contents:...} 응답, 'direct' → HTML 직접 응답
const PROXIES=[
  {url:'https://icy-frog-a6c0.tlsxo213.workers.dev/?url=', type:'direct'}, // 자체 CF Workers (1순위)
  {url:'https://api.allorigins.win/get?url=',               type:'json'},   // 범용 (2순위)
  {url:'https://corsproxy.io/?url=',                        type:'direct'}, // (3순위)
  {url:'https://api.codetabs.com/v1/proxy?quest=',          type:'direct'}, // (4순위)
  // thingproxy.freeboard.io 제거 — DNS 불능 확인됨
];

// 프록시 1개 시도 — 성공 여부와 HTML 반환
async function _tryProxy(proxy, url, timeout){
  const res=await fetch(proxy.url+encodeURIComponent(url),{signal:AbortSignal.timeout(timeout)});
  if(!res.ok) return null;
  const text=await res.text();
  if(!text||text.length<30) return null;
  if(proxy.type==='json'){
    try{
      const json=JSON.parse(text);
      if(json.contents!=null) return json.contents;
      return null;
    }catch(e){ return null; }
  }
  return text;
}

// 모든 프록시를 순서대로 시도 (GET)
async function proxyFetch(url, timeout=9000){
  let lastErr;
  for(const proxy of PROXIES){
    try{
      const html=await _tryProxy(proxy, url, timeout);
      if(html) return html;
    }catch(e){ lastErr=e; }
  }
  throw lastErr||new Error('모든 프록시 실패');
}

// Workers 경유 POST 요청 (노벨피아 등 POST API용)
// Workers가 ?url=...&_method=POST&_body=... 형태를 처리
async function proxyPost(url, body, timeout=9000){
  // 1순위: 자체 Workers (POST 지원)
  const worker = PROXIES.find(p=>p.url.includes('workers.dev'));
  if(worker){
    try{
      const res=await fetch(worker.url+encodeURIComponent(url)+'&_method=POST&_body='+encodeURIComponent(body),
        {signal:AbortSignal.timeout(timeout)});
      if(res.ok){
        const text=await res.text();
        if(text&&text.length>10) return text;
      }
    }catch(e){}
  }
  // fallback: 직접 시도 (실패할 수 있음)
  try{
    const res=await fetch(url,{
      method:'POST',
      headers:{'Content-Type':'application/x-www-form-urlencoded'},
      body,
      signal:AbortSignal.timeout(timeout)
    });
    if(res.ok) return await res.text();
  }catch(e){}
  throw new Error('POST 프록시 실패');
}

// 여러 프록시를 병렬로 시도 — 가장 빠른 성공 결과 반환
async function proxyFetchRace(url, timeout=9000){
  const promises=PROXIES.map(proxy=>
    _tryProxy(proxy, url, timeout).catch(()=>null)
  );
  // 첫 번째 non-null 결과 반환
  return new Promise((resolve,reject)=>{
    let done=false, pending=promises.length;
    promises.forEach(p=>p.then(html=>{
      if(!done&&html){ done=true; resolve(html); }
      if(--pending===0&&!done) reject(new Error('모든 프록시 실패'));
    }).catch(()=>{ if(--pending===0&&!done) reject(new Error('모든 프록시 실패')); }));
  });
}

// ── 카카오페이지 ──
async function fetchKakao(q){
  // 카카오CDN 이미지 유효성 검사
  function isKakaoImg(src){
    if(!src||src.length<40) return false;
    const s=src.toLowerCase();
    if(s.includes('icon')||s.includes('logo')||s.includes('badge')||s.includes('profile')||s.includes('default')) return false;
    return s.includes('kakaocdn')||s.includes('dn-img-page.kakao')||
           s.includes('t1.kakaocdn')||s.includes('k.kakaocdn');
  }

  const worker=PROXIES.find(p=>p.url.includes('workers.dev'));

  // ── 1순위: 카카오페이지 GraphQL API ──
  // 실제 카카오페이지 앱이 사용하는 공식 GraphQL 엔드포인트
  if(worker){
    try{
      // 카카오페이지 실제 GraphQL 쿼리 (네트워크 탭 확인)
      const body=JSON.stringify({
        operationName:'SearchContentByKeyword',
        query:`query SearchContentByKeyword($keyword:String!,$page:Int,$size:Int){
          searchByKeyword(keyword:$keyword,page:$page,size:$size,contentsType:NOVEL){
            count
            list{
              id title
              thumbnail
              singleThumbnailImage{url}
              horizontalThumbnail{url}
            }
          }
        }`,
        variables:{keyword:q, page:0, size:12}
      });

      const workerUrl=worker.url
        +encodeURIComponent('https://page.kakao.com/graphql')
        +'&_method=POST'
        +'&_body='+encodeURIComponent(body)
        +'&_h_Content-Type='+encodeURIComponent('application/json')
        +'&_h_Accept='+encodeURIComponent('application/json');

      const res=await fetch(workerUrl,{signal:AbortSignal.timeout(9000)});
      if(res.ok){
        const json=await res.json();
        // 다양한 응답 구조 시도
        const list=json?.data?.searchByKeyword?.list
          ||json?.data?.searchContentByKeyword?.edges?.map(e=>e.node)
          ||[];
        const items=list.map(n=>({
          title:n.title||q,
          image:n.thumbnail||(typeof n.thumbnail==='string'?n.thumbnail:'')||
                n.singleThumbnailImage?.url||n.horizontalThumbnail?.url||''
        })).filter(i=>i.image&&i.image.startsWith('http'));
        if(items.length) return items.slice(0,12);
      }
    }catch(e){}
  }

  // ── 2순위: Daum 책 검색 JSON API (Workers 경유) ──
  // search.daum.net은 서버사이드 렌더링 → 이미지 파싱 가능
  try{
    // Daum 책 검색 — 결과에 카카오페이지 표지 포함
    const html=await proxyFetch(
      'https://search.daum.net/search?w=book&q='+encodeURIComponent(q)+'&DA=LB2'
    );
    const doc=new DOMParser().parseFromString(html,'text/html');
    const items=[];

    // Daum 책 검색 결과 구조
    doc.querySelectorAll('a[href*="page.kakao"] img, a[href*="kakao"] img, .wrap_thmbnail img, .thumb_img img').forEach(img=>{
      const src=img.getAttribute('src')||img.getAttribute('data-original-src')||'';
      if(src&&src.startsWith('http')&&src.length>40&&!src.includes('icon')){
        const titleEl=img.closest('li,article,.item_book')?.querySelector('.tit_subject,.tit_item,strong,a[class*="tit"]');
        items.push({title:titleEl?.textContent?.trim()||img.alt||q, image:src});
      }
    });

    // img 전체 fallback — kakaocdn 이미지만
    if(!items.length){
      doc.querySelectorAll('img').forEach(img=>{
        const src=img.getAttribute('src')||img.getAttribute('data-original-src')||'';
        if(isKakaoImg(src)) items.push({title:img.alt||q, image:src});
      });
    }
    if(items.length) return items.slice(0,12);
  }catch(e){}

  // ── 3순위: Daum 통합검색 HTML (소설 카테고리) ──
  try{
    const html=await proxyFetch(
      'https://search.daum.net/search?q='+encodeURIComponent(q+' 카카오페이지 소설')+'&DA=LB2'
    );
    const doc=new DOMParser().parseFromString(html,'text/html');
    const items=[];
    doc.querySelectorAll('img').forEach(img=>{
      const src=img.getAttribute('src')||img.getAttribute('data-original-src')||'';
      if(isKakaoImg(src)) items.push({title:img.alt||q, image:src});
    });
    return items.slice(0,12);
  }catch(e){ return []; }
}

// ── 네이버 시리즈 ──
async function fetchNaver(q){
  const clientId=document.getElementById('naverClientId')?.value.trim();
  const clientSecret=document.getElementById('naverClientSecret')?.value.trim();

  // 1) 네이버 오픈API — Workers에 헤더 파라미터로 전달 (_h_ prefix)
  if(clientId&&clientSecret){
    try{
      const worker=PROXIES.find(p=>p.url.includes('workers.dev'));
      if(worker){
        const apiUrl='https://openapi.naver.com/v1/search/book.json?query='+encodeURIComponent(q)+'&display=12&sort=sim';
        const workerUrl=worker.url+encodeURIComponent(apiUrl)
          +'&_h_X-Naver-Client-Id='+encodeURIComponent(clientId)
          +'&_h_X-Naver-Client-Secret='+encodeURIComponent(clientSecret);
        const res=await fetch(workerUrl,{signal:AbortSignal.timeout(8000)});
        if(res.ok){
          const json=await res.json();
          const items=(json.items||[]).map(it=>({
            title:it.title.replace(/<[^>]+>/g,''),
            image:it.image
          })).filter(it=>it.image);
          if(items.length) return items.slice(0,12);
        }
      }
    }catch(e){}
  }

  // 2) 네이버 시리즈 검색 HTML 파싱
  try{
    const html=await proxyFetch(
      'https://series.naver.com/search/search.series?query='+encodeURIComponent(q)+'&categoryTypeCode=novel'
    );
    const doc=new DOMParser().parseFromString(html,'text/html');
    const items=[];
    doc.querySelectorAll('.lst_list li, .search_lst li, [class*="list"] li').forEach(li=>{
      const img=li.querySelector('img');
      const titleEl=li.querySelector('[class*="title"],[class*="subj"],strong,a');
      const src=img?.getAttribute('src')||img?.getAttribute('data-src')||'';
      if(src&&src.startsWith('http')&&(src.includes('thumb')||src.includes('cover')||src.includes('book'))&&!src.includes('icon')){
        items.push({title:titleEl?.textContent?.trim()||q, image:src});
      }
    });
    if(items.length) return items.slice(0,12);

    // img 전체 fallback
    doc.querySelectorAll('img').forEach(img=>{
      const src=img.getAttribute('src')||img.getAttribute('data-src')||'';
      if(src&&src.startsWith('http')&&(src.includes('thumb')||src.includes('cover'))&&!src.includes('static')&&!src.includes('icon')){
        items.push({title:img.alt||q, image:src});
      }
    });
    return items.slice(0,12);
  }catch(e){ return []; }
}

// ── 리디북스 ──
async function fetchRidi(q){
  // 리디 이미지 URL 유효성 검사 — 배지·아이콘 제거
  function isValidRidiImg(src){
    if(!src||!src.startsWith('http')) return false;
    if(src.includes('badge')||src.includes('icon')||src.includes('logo')) return false;
    if(src.includes('active.ridibooks.com')) return false;  // 배지 CDN 차단
    if(src.includes('static')||src.includes('pixel.')) return false;
    return src.includes('cdn.ridi')||src.includes('thumb')||src.includes('cover')||src.includes('book');
  }

  try{
    const html=await proxyFetch(
      'https://ridibooks.com/search?q='+encodeURIComponent(q)+'&adult_exclude=n'
    );
    const doc=new DOMParser().parseFromString(html,'text/html');
    const items=[];
    // 검색 결과 카드 셀렉터 (여러 패턴 시도)
    doc.querySelectorAll('[class*="book_item"],[class*="BookItem"],[class*="SearchBook"],[class*="book_list"] li').forEach(el=>{
      const img=el.querySelector('img');
      const titleEl=el.querySelector('[class*="title"],[class*="Title"],h3,h4,strong,a');
      const src=img?.getAttribute('src')||img?.getAttribute('data-src')||img?.getAttribute('data-original')||'';
      if(isValidRidiImg(src)){
        items.push({title:titleEl?.textContent?.trim()||q, image:src});
      }
    });
    if(!items.length){
      doc.querySelectorAll('img').forEach(img=>{
        const src=img.getAttribute('src')||img.getAttribute('data-src')||'';
        if(isValidRidiImg(src)) items.push({title:img.alt||q, image:src});
      });
    }
    return items.slice(0,12);
  }catch(e){ return []; }
}

// ── 노벨피아 ──
async function fetchNovelpia(q){
  function fixNovelpiaImg(src){
    if(!src) return '';
    if(src.startsWith('//')) return 'https:'+src;
    if(src.startsWith('/')) return 'https://novelpia.com'+src;
    return src;
  }

  // 노벨피아: Workers 경유 POST API 시도 → 검색 페이지 파싱 fallback
  // 1) Workers 경유 POST API
  try{
    const postBody='search_type=all&search_string='+encodeURIComponent(q)+'&page=1&page_limit=12';
    const resp=await proxyPost('https://novelpia.com/proc/novel_list', postBody);
    const json=JSON.parse(resp);
    const list=json.list||json.data||[];
    const items=list.slice(0,12).map(n=>({
      title:n.novel_name||n.title||q,
      image:fixNovelpiaImg(n.cover_img||n.cover||n.img||n.thumbnail||'')
    })).filter(i=>i.image);
    if(items.length) return items;
  }catch(e){}

  // 2) Workers 경유 검색 페이지 파싱
  try{
    const html=await proxyFetch('https://novelpia.com/search/novel?search_string='+encodeURIComponent(q));
    const doc=new DOMParser().parseFromString(html,'text/html');
    const items=[];
    // 다양한 셀렉터 시도
    doc.querySelectorAll('[class*="novel"],[class*="book"],[class*="item"]').forEach(el=>{
      const img=el.querySelector('img');
      const src=img?.getAttribute('src')||img?.getAttribute('data-src')||'';
      const fixed=fixNovelpiaImg(src);
      if(fixed&&fixed.startsWith('http')&&!fixed.includes('icon')&&!fixed.includes('logo')){
        items.push({title:img?.alt||el.querySelector('h3,h4,strong,a')?.textContent?.trim()||q, image:fixed});
      }
    });
    if(items.length) return items.slice(0,12);

    // img 전체 fallback
    doc.querySelectorAll('img').forEach(img=>{
      const src=fixNovelpiaImg(img.getAttribute('src')||img.getAttribute('data-src')||'');
      if(src&&src.startsWith('http')&&(src.includes('cover')||src.includes('novel')||src.includes('thumb'))&&!src.includes('icon')){
        items.push({title:img.alt||q, image:src});
      }
    });
    return items.slice(0,12);
  }catch(e){ return []; }
}

// ── 구글 이미지 커스텀 검색 (공개 크롤링) ──
async function fetchGoogle(q){
  // 구글 이미지 직접 크롤링 불가 (모든 프록시 429/403 차단)
  // 대안: Bing 이미지 → DuckDuckGo → 네이버 이미지 순으로 시도

  function isValidImg(src){
    if(!src||!src.startsWith('http')||src.length<40) return false;
    const s=src.toLowerCase();
    return !s.includes('icon')&&!s.includes('logo')&&!s.includes('pixel')&&
           !s.includes('blank')&&!s.includes('spacer')&&
           (s.includes('.jpg')||s.includes('.jpeg')||s.includes('.png')||
            s.includes('.webp')||s.includes('image')||s.includes('thumb')||
            s.includes('cover')||s.includes('photo'));
  }

  // ── 1순위: Bing 이미지 검색 (SSR HTML — Workers 경유) ──
  try{
    const html=await proxyFetch(
      'https://www.bing.com/images/search?q='+encodeURIComponent(q+' 소설 표지')+'&form=HDRSC2&first=1'
    );
    const doc=new DOMParser().parseFromString(html,'text/html');
    const items=[];
    const seen=new Set();

    // Bing 이미지 결과 — data-src 또는 murl 속성에 원본 URL
    doc.querySelectorAll('.iusc,[class*="imgpt"],[class*="img_cont"]').forEach(el=>{
      // Bing은 data-m JSON에 murl(원본 URL) 포함
      const m=el.getAttribute('m')||el.getAttribute('data-m')||'';
      if(m){
        try{
          const obj=JSON.parse(m);
          const url=obj.murl||obj.imgurl||'';
          if(url&&!seen.has(url)&&isValidImg(url)){
            seen.add(url);
            items.push({title:obj.t||q, image:url});
          }
        }catch(e){}
      }
      // img 태그 직접 확인
      const img=el.querySelector('img');
      const src=img?.getAttribute('src')||img?.getAttribute('data-src')||'';
      if(src&&!seen.has(src)&&isValidImg(src)){
        seen.add(src);
        items.push({title:img?.alt||q, image:src});
      }
    });

    // Bing img 태그 전체 fallback
    if(!items.length){
      doc.querySelectorAll('img[src]').forEach(img=>{
        const src=img.getAttribute('src')||'';
        if(!seen.has(src)&&isValidImg(src)&&!src.includes('bing.com/th')){
          seen.add(src); items.push({title:img.alt||q, image:src});
        }
      });
    }
    if(items.length) return items.slice(0,12);
  }catch(e){}

  // ── 2순위: DuckDuckGo 이미지 API (공개 JSON — Workers 경유) ──
  try{
    const html=await proxyFetch(
      'https://duckduckgo.com/?q='+encodeURIComponent(q+' 소설 표지')+'&iax=images&ia=images'
    );
    // DuckDuckGo vqd 토큰 추출
    const vqd=(html.match(/vqd=['"]([^'"]+)['"]/)||[])[1];
    if(vqd){
      const jsonHtml=await proxyFetch(
        'https://duckduckgo.com/i.js?q='+encodeURIComponent(q+' 소설 표지')+'&vqd='+encodeURIComponent(vqd)+'&p=1'
      );
      const json=JSON.parse(jsonHtml);
      const items=(json.results||[]).slice(0,12).map(r=>({
        title:r.title||q,
        image:r.image||r.thumbnail||''
      })).filter(i=>i.image&&isValidImg(i.image));
      if(items.length) return items;
    }
  }catch(e){}

  // ── 3순위: 네이버 이미지 검색 HTML (Workers 경유) ──
  try{
    const html=await proxyFetch(
      'https://search.naver.com/search.naver?where=image&query='+encodeURIComponent(q+' 소설 표지')+'&sm=tab_srt&sort=0'
    );
    const doc=new DOMParser().parseFromString(html,'text/html');
    const items=[];
    const seen=new Set();
    doc.querySelectorAll('img[data-lazy-src],img[data-original],img[src]').forEach(img=>{
      const src=img.getAttribute('data-lazy-src')||img.getAttribute('data-original')||img.getAttribute('src')||'';
      if(!seen.has(src)&&isValidImg(src)&&!src.includes('naver.com/static')){
        seen.add(src);
        items.push({title:img.alt||q, image:src});
      }
    });
    return items.slice(0,12);
  }catch(e){ return []; }
}

// ══════════════════════════════════════════
// 🔍 Module: CoverSearchModal (표지 검색 모달 스크립트)
// ══════════════════════════════════════════
// ══════════════════════════════════════════
// 표지 검색 모달 (전 플랫폼 동시 검색)

// ════════════════════════════════════════════════
// 📐 Module: FontPanel — 5종 웹폰트 설정 컨트롤
// ════════════════════════════════════════════════
const SUPPORTED_FONTS=[
  {name:'Noto Sans KR',   label:'본고딕 (Noto Sans KR)',   family:"'Noto Sans KR',sans-serif",     cls:'noto-sans-kr'},
  {name:'Noto Serif KR',  label:'본명조 (Noto Serif KR)',   family:"'Noto Serif KR',serif",          cls:'noto-serif-kr'},
  {name:'Nanum Gothic',   label:'나눔고딕',                  family:"'Nanum Gothic',sans-serif",      cls:'nanum-gothic'},
  {name:'Nanum Myeongjo', label:'나눔명조',                  family:"'Nanum Myeongjo',serif",         cls:'nanum-myeongjo'},
  {name:'Gowun Batang',   label:'고운바탕',                  family:"'Gowun Batang',serif",           cls:'gowun-batang'},
];

// 폰트 드롭다운 빌드 (설정탭 폰트 select에 5종만 표시)
function buildFontDropdown(){
  const selects=document.querySelectorAll('.font-select-epub, #cssFont');
  selects.forEach(sel=>{
    sel.innerHTML=SUPPORTED_FONTS.map(f=>
      `<option value="${f.family}">${f.label}</option>`
    ).join('');
  });
}

// 폰트 미리보기 업데이트
function updateFontPreview(){
  const sel=document.getElementById('cssFont');
  if(!sel) return;
  const found=SUPPORTED_FONTS.find(f=>f.family===sel.value);
  const preview=document.querySelector('.font-preview');
  if(preview&&found){
    preview.style.fontFamily=found.family;
    preview.textContent='가나다라마바사아자차카타파하 AaBbCc 1234567890 가나다라마바사아자차카타파하';
  }
}

// 사용자 설정 localStorage 저장 (폰트/글자크기/줄간격/여백)
function saveUserPrefs(){
  try{
    const prefs={
      font:        document.getElementById('cssFont')?.value||'',
      size:        document.getElementById('cssFontSize')?.value||'1em',
      line:        document.getElementById('cssLine')?.value||'1.9',
      // ★ 4방향 여백 개별 저장 (cssPadH/V는 폴백용으로 유지)
      padTop:      document.getElementById('cssPadTop')?.value||'1.5',
      padBottom:   document.getElementById('cssPadBottom')?.value||'1.5',
      padLeft:     document.getElementById('cssPadLeft')?.value||'1.8',
      padRight:    document.getElementById('cssPadRight')?.value||'1.8',
      // 기존 호환 폴백
      padH:        document.getElementById('cssPadH')?.value||'1.8em',
      padV:        document.getElementById('cssPadV')?.value||'1.5em',
      dark:        document.documentElement.dataset.theme==='dark',
      italic:      document.getElementById('optItalic')?.checked??true,
      indent:      document.getElementById('optIndent')?.checked??true,
      mergePara:   document.getElementById('optMergeShortLines')?.checked??false,
      // 슬라이더 값도 함께 저장
      indentEm:    document.getElementById('cssIndentSlider')?.value||'1.0',
      textColor:   document.getElementById('cssTextColor')?.value||'',
      bgColor:     document.getElementById('cssBgColor')?.value||'',
    };
    localStorage.setItem('novelepub_prefs', JSON.stringify(prefs));
  }catch(e){}
}

// 저장된 설정 복원
function loadUserPrefs(){
  try{
    const raw=localStorage.getItem('novelepub_prefs');
    if(!raw) return;
    const p=JSON.parse(raw);

    // 폰트
    if(p.font){ const el=document.getElementById('cssFont'); if(el) el.value=p.font; }
    // 글자 크기
    if(p.size){ const el=document.getElementById('cssFontSize'); if(el) el.value=p.size; }
    // 줄간격
    if(p.line){ const el=document.getElementById('cssLine'); if(el) el.value=p.line; }

    // ★ 4방향 여백 복원 + 슬라이더 동기화
    const padMap=[
      ['cssPadTop',    'cssPadTopSlider',    p.padTop,    '1.5'],
      ['cssPadBottom', 'cssPadBottomSlider', p.padBottom, '1.5'],
      ['cssPadLeft',   'cssPadLeftSlider',   p.padLeft,   '1.8'],
      ['cssPadRight',  'cssPadRightSlider',  p.padRight,  '1.8'],
    ];
    for(const [numId, sliderId, val, def] of padMap){
      const v=val||def;
      const numEl =document.getElementById(numId);
      const slideEl=document.getElementById(sliderId);
      if(numEl)   numEl.value=v;
      if(slideEl) slideEl.value=v;
    }

    // 기존 호환 폴백 (cssPadH/V가 남아있는 경우)
    if(p.padH){ const el=document.getElementById('cssPadH'); if(el) el.value=p.padH; }
    if(p.padV){ const el=document.getElementById('cssPadV'); if(el) el.value=p.padV; }

    // 다크모드
    if(p.dark===true) document.documentElement.dataset.theme='dark';

    // 토글 옵션
    if(p.italic!=null){  const el=document.getElementById('optItalic');          if(el) el.checked=p.italic; }
    if(p.indent!=null){  const el=document.getElementById('optIndent');          if(el) el.checked=p.indent; }
    if(p.mergePara!=null){ const el=document.getElementById('optMergeShortLines'); if(el) el.checked=p.mergePara; }

    // 들여쓰기 슬라이더
    if(p.indentEm!=null){ const el=document.getElementById('cssIndentSlider'); if(el) el.value=p.indentEm; }

    // 텍스트/배경 색상
    if(p.textColor){ const el=document.getElementById('cssTextColor'); if(el) el.value=p.textColor; }
    if(p.bgColor){   const el=document.getElementById('cssBgColor');   if(el) el.value=p.bgColor; }

    updateFontPreview();
  }catch(e){}
}

// ════════════════════════════════════════════════
// ⚡ Module: Worker — Blob 기반 인라인 Web Worker
// ★ 외부 파일(parser.js) 의존성 없음
// ★ 로컬 파일 실행, 하위 경로, CORS 환경 모두 안전
// ★ new Blob([코드]) → URL.createObjectURL → new Worker(url)
// ★ Worker 생성 직후 URL.revokeObjectURL로 메모리 해제
// ════════════════════════════════════════════════

/**
 * createParserWorker — Blob URL 인라인 Worker 생성
 *
 * 경로 독립적: file://, http://, https:// 어디서든 동작
 * Worker 내부에 KEYWORD_PATS, bestPat, splitChaptersWorker 완전 인라인
 */
function createParserWorker(){
  // ★ PATS, bestPat, splitChapters, KEYWORD_PATS를 Worker 코드로 직렬화
  // Worker는 독립 스코프이므로 필요한 함수를 모두 인라인
  const workerSrc=`
'use strict';
// ── Worker 내부 유틸 ──
function escHtml(s){return s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');}

${KEYWORD_PATS.toString().includes('KEYWORD_PATS') ? '' : ''}
// KEYWORD_PATS 인라인
const KEYWORD_PATS=[
  /^(?:프롤로그|프롤)(?:\\s*.+)?$/i,
  /^(?:에필로그|에필)(?:\\s*.+)?$/i,
  /^외전(?:\\s*.+)?$/,
  /^번외(?:\\s*.+)?$/,
  /^후기(?:\\s*.+)?$/,
  /^작가\\s*후기(?:\\s*.+)?$/,
  /^작가의\\s*말(?:\\s*.+)?$/,
  /^작가\\s*노트(?:\\s*.+)?$/,
  /^(?:side\\s*story|side\\s*episode|special\\s*episode)(?:\\s*.+)?$/i,
  /^(?:prologue|epilogue|afterword|author.?s?\\s*note)(?:\\s*.+)?$/i,
  /^서장(?:\\s*.+)?$/,
  /^종장(?:\\s*.+)?$/,
  /^서문(?:\\s*.+)?$/,
];

// PATS 인라인 (parser.js와 동일)
const PATS=[
  [/^\\[(?:EP|Ep|ep)\\.\\d+\\](?:\\s*.+)?$/,'[EP.N]'],
  [/^\\[(?:Prologue|Epilogue|Side|Extra|프롤로그|에필로그|외전)(?:\\s*.+)?\\](?:\\s*.+)?$/i,'[Prologue]'],
  [/^\\d{3,6}\\s{2,}.+$/,'NNN제목'],
  [/^[〈<]\\s*\\d+\\s*화\\s*[〉>](?:\\s*.+)?$/i,'〈N화〉'],
  [/^제\\s*\\d+\\s*화(?:\\s*.+)?$/,'제N화'],
  [/^제\\s*\\d+\\s*장(?:\\s*.+)?$/,'제N장'],
  [/^\\d+화(?:\\s*.+)?$/,'N화'],
  [/^\\d+화\\.\\s*.+$/,'화.제목'],
  [/^#?(?:제\\s*)?\\d+\\s*화(?:\\s*.+)?$/i,'화번호'],
  [/^\\[\\s*제?\\s*\\d+\\s*화\\s*\\](?:\\s*.+)?$/,'[N화]'],
  [/^(?:chapter|part|ch)\\.?\\s*\\d+(?:\\s*.+)?$/i,'Chapter'],
  [/^(?:EP|Ch|Scene|Act)\\.?\\s*\\d+(?:\\s*.+)?$/i,'EP/Scene'],
  [/^\\d+\\.\\s+.{1,60}$/,'N.제목'],
  [/^.{2,15}\\s+\\d+화$/,'소설명+N화'],
  [/^\\d+$/,'숫자만'],
];

function checkTitleWaPattern(lines,minGap=50){
  const rx=/^.{2,15}\\s+\\d+화$/;
  const pos=[];
  lines.forEach((l,i)=>{if(l.trim()&&rx.test(l.trim()))pos.push(i);});
  if(pos.length<3)return{cnt:0,rx:null};
  const real=pos.filter((p,j)=>Math.min(p-(pos[j-1]??-999),(pos[j+1]??p+999)-p)>=minGap);
  return real.length>=3?{cnt:real.length,rx}:{cnt:0,rx:null};
}
function checkNDotPattern(lines,minGap=50){
  const rx=/^\\d+\\.\\s+.{1,60}$/;
  const pos=[];
  lines.forEach((l,i)=>{if(l.trim()&&rx.test(l.trim()))pos.push(i);});
  if(pos.length<3)return{cnt:0,rx:null};
  const real=pos.filter((p,j)=>Math.min(p-(pos[j-1]??-999),(pos[j+1]??p+999)-p)>=minGap);
  if(real.length<3)return{cnt:0,rx:null};
  const first=parseInt(lines[real[0]].trim().match(/^(\\d+)\\./)[1]);
  return first>5?{cnt:0,rx:null}:{cnt:real.length,rx};
}

function bestPat(raw){
  const lines=raw.split('\\n');
  const totalLines=lines.length;
  const tailStart=Math.floor(totalLines*0.90);
  let best=null,bestScore=0,bestName='';
  const mixed=[];
  const blankWrapped=new Set();
  for(let i=1;i<lines.length-1;i++){
    const p=!lines[i-1].trim(),n=!lines[i+1].trim();
    const p2=i>=2&&!lines[i-2].trim(),n2=i+2<lines.length&&!lines[i+2].trim();
    if(lines[i].trim()&&(p||p2)&&(n||n2))blankWrapped.add(i);
  }
  for(const[rx,name]of PATS){
    const idxs=[];
    for(let i=0;i<lines.length;i++){const t=lines[i].trim();if(t&&rx.test(t))idxs.push(i);}
    if(idxs.length<3)continue;
    const isNum=rx.source==='^\\\\d+$';
    const score=idxs.reduce((a,i)=>{
      if(i>=tailStart&&isNum)return a;
      return a+(blankWrapped.has(i)?3:1);
    },0);
    if(!score)continue;
    mixed.push({rx,name,cnt:idxs.length,score});
    if(score>bestScore){bestScore=score;best=rx;bestName=name;}
  }
  const dynGap=Math.max(30,Math.min(200,Math.floor(totalLines/50)));
  const nDot=checkNDotPattern(lines,dynGap);
  if(nDot.cnt>0&&nDot.cnt*3>bestScore){bestScore=nDot.cnt*3;best=nDot.rx;bestName='N.제목';mixed.push({rx:nDot.rx,name:'N.제목',cnt:nDot.cnt,score:nDot.cnt*3});}
  const tWa=checkTitleWaPattern(lines,dynGap);
  if(tWa.cnt>0&&tWa.cnt*3>bestScore){bestScore=tWa.cnt*3;best=tWa.rx;bestName='소설명+N화';mixed.push({rx:tWa.rx,name:'소설명+N화',cnt:tWa.cnt,score:tWa.cnt*3});}
  if(bestScore<3){const fb=/^\\d+$/;const c=lines.filter((l,i)=>i<tailStart&&l.trim()&&fb.test(l.trim())).length;if(c>=3){bestScore=c;best=fb;bestName='숫자만';}}
  if(mixed.length>1){
    const tot=mixed.reduce((s,m)=>s+m.cnt,0);
    const dom=mixed.find(m=>m.cnt/tot>=0.75);
    if(dom)return{rx:dom.rx,name:dom.name+'[지배]',cnt:dom.cnt};
  }
  const seen=new Set();
  const uniq=mixed.filter(m=>{if(seen.has(m.rx.source))return false;seen.add(m.rx.source);return true;});
  if(uniq.length>1){
    const comb=new RegExp('(?:'+uniq.map(m=>m.rx.source).join('|')+')','i');
    const uc=[...new Set(lines.filter(l=>l.trim()&&comb.test(l.trim())).map(l=>l.trim()))];
    if(uc.length>bestScore)return{rx:comb,name:'혼합[자동]',cnt:uc.length,isMixed:true};
  }
  return{rx:best,name:bestName,cnt:bestScore};
}

function splitChaptersWorker(raw,customPat){
  raw=raw.replace(/\\r\\n/g,'\\n').replace(/\\r/g,'\\n').replace(/\\xad/g,'\\u2014').replace(/[\\x00-\\x08\\x0B\\x0C\\x0E-\\x1F]/g,'').replace(/[\\uFFFE\\uFFFF]/g,'');
  let rx=null;
  if(customPat&&customPat.trim()){try{rx=new RegExp(customPat.trim(),'i');}catch(e){}}
  if(!rx){const r=bestPat(raw);rx=r.rx;}
  if(rx){
    const kw=KEYWORD_PATS.map(k=>k.source).join('|');
    rx=new RegExp('(?:'+rx.source+'|'+kw+')','i');
  }
  if(!rx){
    const lines=raw.split('\\n'),total=lines.length;
    const PL=Math.max(200,Math.min(500,Math.floor(total/20)));
    const chs=[];
    for(let i=0;i<total;i+=PL){
      const s=lines.slice(i,i+PL).join('\\n').trim();if(!s)continue;
      const pg=Math.floor(i/PL)+1,tp=Math.ceil(total/PL);
      chs.push([pg===1&&tp===1?'본문':'('+pg+'/'+tp+')',s]);
    }
    return chs.length?chs:[['본문',raw.trim()]];
  }
  const lines=raw.split('\\n');
  const chs=[],seen=new Map();
  const sep=/^[-=*─━~·.‒—]{3,}\\s*$|^[─━═]{2,}$/;
  let cur=null,body=[];
  for(let li=0;li<lines.length;li++){
    const line=lines[li],t=line.trim();
    if(t&&rx.test(t)){
      const pc=seen.get(t)||0;seen.set(t,pc+1);
      const ut=pc===0?t:t+' ('+(pc+1)+')';
      while(body.length&&(sep.test(body[body.length-1].trim())||!body[body.length-1].trim()))body.pop();
      if(cur===null&&body.length>0)chs.push(['서문',body.join('\\n').trim()]);
      else if(cur!==null)chs.push([cur,body.join('\\n').trim()]);
      cur=ut;body=[];
      let ni=li+1;while(ni<lines.length&&sep.test(lines[ni].trim()))ni++;
      if(ni>li+1)li=ni-1;
    }else{body.push(line);}
  }
  if(cur!==null)chs.push([cur,body.join('\\n').trim()]);
  else if(body.length)chs.push(['본문',body.join('\\n').trim()]);
  raw=null;
  return chs.length?chs:[['본문','']];
}

// ── Worker 메시지 핸들러 ──
self.onmessage=function(e){
  const{type,payload,id}=e.data;
  try{
    if(type==='SPLIT'){
      const{raw,customPat}=payload;
      self.postMessage({type:'PROGRESS',id,pct:5,msg:'② 텍스트 정규화 중...'});

      // ★ 1% 단위 세밀한 진행률 — 파싱 루프 내에서 직접 보고
      const result=splitChaptersWorkerDetailed(raw,customPat,function(pct,msg){
        self.postMessage({type:'PROGRESS',id,pct,msg});
      });
      self.postMessage({type:'DONE',id,result});
    } else if(type==='ABORT'){
      // Abort 요청 수신 — 플래그 설정
      self._aborted=true;
    }
  }catch(err){
    self.postMessage({type:'ERROR',id,error:err.message||String(err)});
  }
};

function splitChaptersWorkerDetailed(raw,customPat,onProgress){
  self._aborted=false;
  raw=raw.replace(/\r\n/g,'\n').replace(/\r/g,'\n')
         .replace(/\xad/g,'\u2014').replace(/[\x00-\x08\x0B\x0C\x0E-\x1F]/g,'')
         .replace(/[\uFFFE\uFFFF]/g,'');

  onProgress(8,'② 패턴 분석 중...');
  let rx=null;
  if(customPat&&customPat.trim()){try{rx=new RegExp(customPat.trim(),'i');}catch(e){}}
  if(!rx){const r=bestPat(raw);rx=r.rx;}
  if(rx){
    const kw=KEYWORD_PATS.map(k=>k.source).join('|');
    rx=new RegExp('(?:'+rx.source+'|'+kw+')','i');
  }

  onProgress(12,'② 챕터 분리 시작...');

  if(!rx){
    const lines=raw.split('\n'),total=lines.length;
    const PL=Math.max(200,Math.min(500,Math.floor(total/20)));
    const chs=[];
    for(let i=0;i<total;i+=PL){
      if(self._aborted) return chs;
      const s=lines.slice(i,i+PL).join('\n').trim();if(!s)continue;
      const pg=Math.floor(i/PL)+1,tp=Math.ceil(total/PL);
      chs.push([pg===1&&tp===1?'본문':'('+pg+'/'+tp+')',s]);
      // ★ 1% 단위 진행률
      onProgress(12+Math.round((i/total)*80),'② 페이지 분할 중... '+pg+'/'+tp);
    }
    return chs.length?chs:[['본문',raw.trim()]];
  }

  const lines=raw.split('\n');
  const total=lines.length;
  const chs=[],seen=new Map();
  const sep=/^[-=*─━~·.‒—]{3,}\s*$|^[─━═]{2,}$/;
  let cur=null,body=[];
  let lastPct=12;

  for(let li=0;li<total;li++){
    if(self._aborted) break;
    const line=lines[li],t=line.trim();
    if(t&&rx.test(t)){
      const pc=seen.get(t)||0;seen.set(t,pc+1);
      const ut=pc===0?t:t+' ('+(pc+1)+')';
      while(body.length&&(sep.test(body[body.length-1].trim())||!body[body.length-1].trim()))body.pop();
      if(cur===null&&body.length>0)chs.push(['서문',body.join('\n').trim()]);
      else if(cur!==null)chs.push([cur,body.join('\n').trim()]);
      cur=ut;body=[];
      let ni=li+1;while(ni<total&&sep.test(lines[ni].trim()))ni++;
      if(ni>li+1)li=ni-1;
    }else{body.push(line);}

    // ★ 1% 단위 진행률 보고 (총 라인의 1%마다)
    const pct=12+Math.round((li/total)*80);
    if(pct>lastPct){
      lastPct=pct;
      onProgress(pct,'② 챕터 파싱 중... '+(chs.length+1)+'화 / '+(li+1).toLocaleString()+'줄');
    }
  }
  if(cur!==null)chs.push([cur,body.join('\n').trim()]);
  else if(body.length)chs.push(['본문',body.join('\n').trim()]);
  raw=null;
  return chs.length?chs:[['본문','']];
}
`;
  const blob=new Blob([workerSrc],{type:'application/javascript'});
  const url=URL.createObjectURL(blob);
  const worker=new Worker(url);
  // URL은 Worker 생성 후 즉시 해제 가능 (Worker는 이미 로드됨)
  URL.revokeObjectURL(url);
  return worker;
}

// Worker 인스턴스 관리 (싱글턴 — 재사용)
let _parserWorker=null;
let _workerCallbacks=new Map(); // id → {resolve, reject}
let _workerIdCounter=0;

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
      _workerCallbacks.delete(id);
      if(type==='DONE') cb.resolve(result);
      else cb.reject(new Error(error||'Worker 오류'));
    };
    _parserWorker.onerror=function(e){
      // 모든 대기 콜백에 에러 전파
      for(const[id,cb]of _workerCallbacks){
        cb.reject(new Error('Worker 오류: '+e.message));
      }
      _workerCallbacks.clear();
      _parserWorker=null; // Worker 재생성 허용
    };
  }
  return _parserWorker;
}

/**
 * Worker 기반 splitChapters (비동기)
 * 10만 줄 이상 파일에서 메인 스레드 블로킹 없음
 */
async function splitChaptersAsync(raw, customPat, onProgress){
  const lineCount=(raw.match(/\n/g)||[]).length;

  if(lineCount<100000){
    // 소형 파일: 동기 처리 (Worker 오버헤드 없음)
    return splitChapters(raw, customPat);
  }

  onProgress&&onProgress(8,'② 대용량 파일 — Worker 파싱 시작...');

  return new Promise((resolve,reject)=>{
    const id=++_workerIdCounter;
    _workerCallbacks.set(id,{resolve,reject});
    try{
      const worker=getParserWorker();
      worker.postMessage({type:'SPLIT',payload:{raw,customPat},id});
    }catch(e){
      _workerCallbacks.delete(id);
      // Worker 실패 시 동기 폴백
      try{resolve(splitChapters(raw,customPat));}catch(e2){reject(e2);}
    }
  });
}

// ── DOMContentLoaded에 폰트 패널 초기화 추가 ──
// 기존 init에 후크
const _origInit=window.addEventListener;
window.addEventListener('DOMContentLoaded', ()=>{
  buildFontDropdown();
  loadUserPrefs();
  updateFontPreview();
  // 폰트/슬라이더 change 이벤트에 saveUserPrefs 연결
  ['cssFont','cssFontSize','cssLine','cssPadH','cssPadV',
   'cssPadTop','cssPadBottom','cssPadLeft','cssPadRight'].forEach(id=>{
    document.getElementById(id)?.addEventListener('change', ()=>{
      updateFontPreview();
      saveUserPrefs();
      saveCssSettings&&saveCssSettings();
    });
    // 숫자 input은 input 이벤트도 처리
    if(id.startsWith('cssPad')&&id!=='cssPadH'&&id!=='cssPadV'){
      document.getElementById(id)?.addEventListener('input', ()=>{
        // 슬라이더 동기화
        const slEl=document.getElementById(id+'Slider');
        const numEl=document.getElementById(id);
        if(slEl&&numEl) slEl.value=numEl.value;
        saveUserPrefs();
        saveCssSettings&&saveCssSettings();
      });
    }
  });

  // 4방향 슬라이더 → 숫자 input 동기화
  ['cssPadTop','cssPadBottom','cssPadLeft','cssPadRight'].forEach(id=>{
    document.getElementById(id+'Slider')?.addEventListener('input', e=>{
      const numEl=document.getElementById(id);
      if(numEl) numEl.value=e.target.value;
      saveUserPrefs();
      saveCssSettings&&saveCssSettings();
    });
  });

  ['optItalic','optIndent','optMergeShortLines'].forEach(id=>{
    document.getElementById(id)?.addEventListener('change', saveUserPrefs);
  });
});
