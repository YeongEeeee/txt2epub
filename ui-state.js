// ════════════════════════════════════════════════
// ui-state.js — UI 상태 관리, 이벤트 바인딩, 공통 렌더링
// NovelEPUB | TXT → EPUB3
//
// 의존성: core.js, settings.js, parser.js (일부 함수)
// ════════════════════════════════════════════════

/* global Toast, EventBus, EventDelegate, StateManager,
   S, B, E, EI, _sStore, _bStore, _eStore, _eiStore,
   yieldToMain, RecoverableError, genUID, PAT_PRESETS,
   saveCssSettings, saveExtraSettings, loadCssSettings, loadExtraSettings,
   loadApiSettings, saveApiSettings, buildFontDropdown, loadUserPrefs,
   saveUserPrefs, updateFontPreview, renderCssPresetList, initSkin,
   handleCustomFont, _initNotifStatus, _notifKey, _updateGeminiKeyBadge,
   escHtml, previewToc, splitChapters, bestPat,
   fileToText, sampleLines */

'use strict';

// ── CSS 변수 읽기 헬퍼
// getCssVar — epub-gen.js에 정의 (먼저 로드되는 파일에 canonical 버전 유지)
// function getCssVar(name) → epub-gen.js:31

// ══════════════════════════════════════════
// 🌙 Module: Theme (다크모드)
// ══════════════════════════════════════════
function toggleTheme(){
  const d=document.documentElement;
  const isDark=d.getAttribute('data-theme')==='dark';
  const next=isDark?'light':'dark';
  d.setAttribute('data-theme',next);
  const _tb=document.getElementById('themeBtn');
  if(_tb){
    const iconSpan=_tb.querySelector('.ibtn-icon');
    if(iconSpan){
      _tb.classList.add('theme-anim');
      setTimeout(()=>{ iconSpan.textContent=isDark?'🌙':'☀️'; _tb.classList.remove('theme-anim'); },250);
    } else {
      _tb.textContent=isDark?'🌙':'☀️';
    }
  }
  try{ localStorage.setItem('novelepub_theme',next); }catch(e){}
}

function initTheme(){
  let theme=null;
  try{ theme=localStorage.getItem('novelepub_theme'); }catch(e){}
  if(!theme){
    theme=window.matchMedia('(prefers-color-scheme:dark)').matches?'dark':'light';
  }
  document.documentElement.setAttribute('data-theme',theme);
  const btn=document.getElementById('themeBtn');
  if(btn){
    const icon=btn.querySelector('.ibtn-icon');
    const emoji=theme==='dark'?'☀️':'🌙';
    if(icon) icon.textContent=emoji; else btn.textContent=emoji;
  }
  window.matchMedia('(prefers-color-scheme:dark)').addEventListener('change',e=>{
    try{
      const saved=localStorage.getItem('novelepub_theme');
      if(!saved){
        const t=e.matches?'dark':'light';
        document.documentElement.setAttribute('data-theme',t);
        const b=document.getElementById('themeBtn');
        if(b){
          const ic=b.querySelector('.ibtn-icon');
          const em=t==='dark'?'☀️':'🌙';
          if(ic) ic.textContent=em; else b.textContent=em;
        }
      }
    }catch(ex){}
  });
}

// ══════════════════════════════════════════
// 🎨 Module: CssPreview (미리보기 업데이트)
// ══════════════════════════════════════════
function updateCssPreview(){
  const _el=id=>document.getElementById(id);
  const p=_el('cssPreview'); if(!p) return;
  const font=_el('cssFont')?.value||'"Noto Serif KR",serif';
  const line=_el('cssLine')?.value||'1.9';
  const size=_el('cssFontSize')?.value||'1em';
  const padTop   =_el('cssPadTop')?.value   ||'1.5';
  const padBottom=_el('cssPadBottom')?.value||'1.5';
  const padLeft  =_el('cssPadLeft')?.value  ||'1.8';
  const padRight =_el('cssPadRight')?.value ||'1.8';
  const paddingVal=`${padTop}em ${padRight}em ${padBottom}em ${padLeft}em`;
  const textColor=_el('cssTextColor')?.value||'';
  const bgColor  =_el('cssBgColor')?.value  ||'';
  const align=document.querySelector('input[name="cssAlign"]:checked')?.value||'justify';
  const titleStyle=document.querySelector('input[name="cssTitleStyle"]:checked')?.value||'center';
  p.style.cssText=`font-family:${font};line-height:${line};font-size:${size};padding:${paddingVal};${textColor?'color:'+textColor+';':''}${bgColor?'background:'+bgColor+';':''}text-align:${align};border-radius:8px`;
  const te=_el('cssPreviewTitle');
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

// ── 미니 리더 실시간 반영 ──
function updateMiniReader(){
  const preview=document.getElementById('miniReaderPreview');
  const title=document.getElementById('miniReaderTitle');
  const body=document.getElementById('miniReaderBody');
  const meta=document.getElementById('miniReaderMeta');
  if(!preview) return;
  const font=document.getElementById('cssFont')?.value||'"Noto Serif KR",serif';
  const lineH=document.getElementById('cssLine')?.value||'1.9';
  const fontSize=document.getElementById('cssFontSize')?.value||'1em';
  const bgColor=document.getElementById('cssBgColor')?.value||'#fdf8f3';
  const txColor=document.getElementById('cssTextColor')?.value||'#2d1f14';
  preview.style.fontFamily=font;
  preview.style.lineHeight=lineH;
  preview.style.fontSize=fontSize;
  preview.style.background=bgColor;
  preview.style.color=txColor;
  const toc=typeof S!=='undefined'&&S.tocItems?S.tocItems.filter(t=>t.enabled):[];
  if(toc.length>0&&title&&body){
    title.textContent=toc[0].title||'1화';
    const previewText=(toc[0].body||'').slice(0,200).replace(/\n{2,}/g,'\n').trim();
    if(previewText){
      const _esc=s=>s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
      body.innerHTML=_esc(previewText)
        .replace(/^—\s/gm,'<em>— ').replace(/\n/g,'<br>')
        +(previewText.includes('—')?'</em>':'');
    }
  }
  if(meta){
    const fontName=font.split(',')[0].replace(/['"]/g,'').trim()||'Noto Serif KR';
    meta.innerHTML=
      `<span class="mini-reader-stat">폰트 <strong>${fontName}</strong></span>`+
      `<span class="mini-reader-stat">줄간격 <strong>${lineH}</strong></span>`+
      `<span class="mini-reader-stat">크기 <strong>${fontSize}</strong></span>`;
  }
  preview.classList.add('updating');
  setTimeout(()=>preview.classList.remove('updating'),500);
}

// ── 설정 요약 ──
function updateSettingsSummary(){
  const font=document.getElementById('cssFont');
  const fontName=font&&font.options&&font.options[font.selectedIndex]?font.options[font.selectedIndex].text.split(' ')[0]:'Noto Serif';
  const line=document.getElementById('cssLine')?.value||'1.9';
  const size=document.getElementById('cssFontSize')?.value||'1em';
  const italic=document.getElementById('optItalic')?.checked;
  const indent=document.getElementById('optIndent')?.checked;
  const merge=document.getElementById('optMergeShortLines')?.checked;
  const imgConv=document.getElementById('optImgConvert')?.checked!==false;

  function badge(icon, label, val, on){
    const cls='opt-badge'+(on?' on':' off');
    return `<span class="${cls}"><span class="opt-badge-icon">${icon}</span> ${label} <span class="opt-badge-val">${val}</span></span>`;
  }
  const chipHtml=
    badge('🔤','폰트',fontName,true)+
    badge('↕','줄간격',line,true)+
    badge('📐','크기',size,true)+
    badge('👻','이탤릭',italic?'ON':'OFF',italic)+
    badge('⬛','들여쓰기',indent?'ON':'OFF',indent)+
    badge('📏','문단정합',merge?'ON':'OFF',merge)+
    badge('🖼','JPG변환',imgConv?'ON':'OFF',imgConv);

  [document.getElementById('settingsSummary'), document.getElementById('batchSettingSummary')].forEach(el=>{
    if(el) el.innerHTML=chipHtml;
  });
  updateMiniReader&&updateMiniReader();
}

// ── 하단 바 파일 상태 업데이트 ──
function updateBtmBar(files){
  const bar=document.getElementById('btmConvert');
  const btn=document.getElementById('convertBtn');
  const stat=document.getElementById('btmFileStatus');
  if(!bar||!btn) return;
  const hasFile=files&&files.length>0;
  bar.classList.toggle('ready',hasFile);
  btn.setAttribute('data-ready',hasFile?'true':'false');
  btn.setAttribute('aria-disabled', hasFile ? 'false' : 'true');
  if(stat){
    if(!hasFile){
      stat.className='btm-status-val none';
      stat.textContent='선택 안 됨';
    }else if(files.length===1){
      // ★ BUG-24 수정: 파일 크기 표시 단위 보정 (1KB 미만은 B 단위)
      const bytes=files[0].size;
      const sizeStr=bytes<1024?bytes+'B':bytes<1048576?(bytes/1024).toFixed(0)+'KB':(bytes/1048576).toFixed(1)+'MB';
      const name=files[0].name;
      stat.className='btm-status-val ok';
      stat.textContent=`${name.length>18?name.slice(0,18)+'…':name} (${sizeStr})`;
    }else{
      stat.className='btm-status-val ok';
      stat.textContent=`${files.length}개 파일 선택됨`;
    }
  }
}

// ── 탭 전환 ──
const _tabRendered = {};
let _lastPageIndex = 0;

function switchPage(name){
  const pages=['convert','batch','edit','history','settings'];
  const nextIdx = pages.indexOf(name);
  const dir = nextIdx > _lastPageIndex ? 'slide-from-right' : 'slide-from-left';
  _lastPageIndex = nextIdx;

  document.querySelectorAll('.page-tab').forEach((t,i)=>{
    const isActive = pages[i]===name;
    t.classList.toggle('on', isActive);
    t.setAttribute('aria-selected', isActive ? 'true' : 'false');
  });

  pages.forEach(p=>{
    const el=document.getElementById('page-'+p);
    if(!el) return;
    const isActive = p===name;
    el.classList.toggle('on', isActive);
    if(isActive){
      el.classList.remove('slide-from-left','slide-from-right');
      void el.offsetWidth;
      el.classList.add(dir);
      el.removeAttribute('aria-hidden');
      el.style.contentVisibility='';
    } else {
      el.setAttribute('aria-hidden', 'true');
      if(p==='history'||p==='edit'){
        el.style.contentVisibility='hidden';
      }
    }
  });

  EventBus.emit('page:changed', {name});
  // ★ 변환/다운로드/일괄/편집 바 탭별 표시 제어
  const dlBar=document.getElementById('btmDownload');
  const cvBar=document.getElementById('btmConvert');
  if(name==='convert'){
    // 변환 탭: EPUB 있으면 다운로드 바, 없으면 변환 바
    const hasEpub=typeof S!=='undefined'&&S.epubBlob;
    if(dlBar) dlBar.style.display=hasEpub?'flex':'none';
    if(cvBar) cvBar.style.display=hasEpub?'none':'flex';
  } else {
    // 다른 탭: 두 바 모두 숨김
    if(dlBar) dlBar.style.display='none';
    if(cvBar) cvBar.style.display='none';
  }
  document.getElementById('btmBatch')?.style   && (document.getElementById('btmBatch').style.display=name==='batch'?'flex':'none');
  document.getElementById('btmEdit')?.style    && (document.getElementById('btmEdit').style.display=name==='edit'?'flex':'none');

  if(name==='convert'||name==='batch') updateSettingsSummary();

  if(name==='history' && !_tabRendered.history){
    _tabRendered.history = true;
    typeof renderHistory==='function'&&renderHistory();
  } else if(name==='history'){
    typeof renderHistory==='function'&&renderHistory();
  }
}

// ── 패딩 아코디언 ──
function togglePadAccordion(){
  const btn=document.getElementById('padAccordionToggle');
  const body=document.getElementById('padAccordionBody');
  if(!btn||!body) return;
  const open=body.classList.toggle('open');
  btn.classList.toggle('open', open);
}

// ── 가상 스크롤 ──
function createVirtualScroll(container, lines, lineHeight=18, visibleBuffer=60){
  if(!lines||!lines.length) return {destroy:()=>{}};
  const ITEM_H = lineHeight;
  let totalH   = lines.length * ITEM_H;
  container.style.cssText = 'position:relative;overflow-y:auto;height:320px';
  const spacer = document.createElement('div');
  spacer.style.cssText = 'position:absolute;top:0;left:0;width:1px;height:'+totalH+'px;pointer-events:none';
  container.appendChild(spacer);
  const content = document.createElement('pre');
  content.className = 'toc-raw';
  content.style.cssText = 'position:absolute;top:0;left:0;right:0;margin:0;white-space:pre;font-size:11px;line-height:'+ITEM_H+'px;font-family:monospace';
  container.appendChild(content);
  let lastStart = -1, lastEnd = -1, rafId = null;

  function getViewH(){ return container.clientHeight || 320; }
  function render(){
    rafId = null;
    const scrollTop = container.scrollTop;
    const viewH     = getViewH();
    const start = Math.max(0, Math.floor(scrollTop / ITEM_H) - visibleBuffer);
    const end   = Math.min(lines.length, Math.ceil((scrollTop + viewH) / ITEM_H) + visibleBuffer);
    if(start === lastStart && end === lastEnd) return;
    lastStart = start; lastEnd = end;
    content.style.top = (start * ITEM_H) + 'px';
    content.textContent = lines.slice(start, end).map((l, i) => String(start + i + 1).padStart(5, ' ') + ' │ ' + l).join('\n');
  }
  function onScroll(){ if(rafId) return; rafId = requestAnimationFrame(render); }
  let resizeObs = null;
  if(typeof ResizeObserver !== 'undefined'){
    resizeObs = new ResizeObserver(() => { lastStart = -1; lastEnd = -1; onScroll(); });
    resizeObs.observe(container);
  }
  container.addEventListener('scroll', onScroll, {passive:true});
  render();
  return {
    update(newLines){ lines=newLines; totalH=newLines.length*ITEM_H; spacer.style.height=totalH+'px'; lastStart=-1; lastEnd=-1; render(); },
    destroy(){ container.removeEventListener('scroll', onScroll); if(rafId) cancelAnimationFrame(rafId); resizeObs?.disconnect(); }
  };
}

// ══════════════════════════════════════════
// 🎛 Module: EventListeners + Init
// ══════════════════════════════════════════

// 패턴 칩 선택 상태
const _chipSelected={patHelper:new Set(), insPatHelper:new Set(), eTocPatHelper:new Set()};

function toggleChipGroup(){
  const wrap=document.getElementById('chipGroupWrap');
  const btn=document.getElementById('chipGroupToggle');
  if(!wrap||!btn) return;
  const expanded=wrap.classList.toggle('expanded');
  btn.setAttribute('aria-expanded', expanded ? 'true' : 'false');
  btn.innerHTML=expanded
    ? '<span class="chip-group-toggle-icon" aria-hidden="true">▼</span> 접기'
    : '<span class="chip-group-toggle-icon" aria-hidden="true">▼</span> 더 보기';
}

function buildPatHelpers(){
  // ══════════════════════════════════════
  // ★ 정규식 빠른 선택 — 카테고리 탭 방식 (patHelper 전용)
  // insPatHelper / eTocPatHelper는 기존 방식 유지
  // ══════════════════════════════════════
  _buildMainPatHelper();
  ['insPatHelper','eTocPatHelper'].forEach(id=>_buildLegacyChips(id));
}

// ── 메인 패턴 헬퍼 (카테고리 탭) ──
function _buildMainPatHelper(){
  const c=document.getElementById('patHelper');
  if(!c) return;
  c.innerHTML='';
  c.style.cssText='margin-top:4px';

  // 최근 사용 패턴 (localStorage)
  let _recentPats=[];
  try{ _recentPats=JSON.parse(localStorage.getItem('novelepub_recent_pats')||'[]'); }catch(e){}

  // 현재 활성 카테고리
  let _activeCat='popular';

  function renderChips(cat){
    _activeCat=cat;
    c.innerHTML='';

    // ── 감지된 패턴 칩 (모든 탭 공통 최상단) ──
    if(S._detectedPat&&S._detectedName){
      const detChip=document.createElement('span');
      detChip.className='pat-chip detected';
      detChip.id='chip_detected';
      const src=S._detectedPat.source;
      const isSel=_chipSelected['patHelper'].has(src);
      detChip.textContent=(isSel?'✅ ':'🔍 ')+'자동감지: '+S._detectedName;
      detChip.title='목차 확인에서 자동 감지된 패턴 — 클릭해서 선택/해제';
      if(isSel) detChip.classList.add('active');
      detChip.onclick=()=>{
        const sel=_chipSelected['patHelper'];
        if(sel.has(src)){sel.delete(src);detChip.classList.remove('active');detChip.textContent='🔍 자동감지: '+S._detectedName;}
        else{sel.add(src);detChip.classList.add('active');detChip.textContent='✅ 자동감지: '+S._detectedName;}
        _syncPatInput(); typeof previewToc==='function'&&previewToc();
      };
      c.appendChild(detChip);
    }

    // ── 카테고리별 칩 ──
    const presets = cat==='recent'
      ? _recentPats.map(v=>PAT_PRESETS.find(p=>p.val===v)).filter(Boolean)
      : PAT_PRESETS.filter(p=>p.cat===cat);

    presets.forEach(p=>{
      const chip=document.createElement('span');
      chip.className='pat-chip';
      const isSel=_chipSelected['patHelper'].has(p.val);
      if(isSel) chip.classList.add('active');
      chip.textContent=p.label;
      chip.title=(p.desc||p.label)+(isSel?' — 선택됨 (클릭해서 해제)':' — 클릭해서 선택');
      chip.dataset.val=p.val;
      // 현재 감지 패턴과 매칭되면 점선 테두리
      if(S._detectedPat){
        try{
          const detSrc=S._detectedPat.source;
          const core=p.val.replace(/^\^/,'').replace(/\$$/,'').split('|')[0].slice(0,8);
          if(core&&detSrc.includes(core)){chip.style.borderStyle='dashed';chip.title+=' (감지 패턴에 포함됨)';}
        }catch(e){}
      }
      chip.onclick=()=>{
        const sel=_chipSelected['patHelper'];
        if(sel.has(p.val)){sel.delete(p.val);chip.classList.remove('active');}
        else{sel.add(p.val);chip.classList.add('active');_addRecentPat(p.val);}
        _syncPatInput();
        const applyBar=document.getElementById('patApplyBar');
        const applyInfo=document.getElementById('patApplyInfo');
        if(applyBar){applyBar.style.display=sel.size?'flex':'none';if(applyInfo)applyInfo.textContent=sel.size?sel.size+'개 패턴 선택됨':'';}
      };
      c.appendChild(chip);
    });

    if(presets.length===0){
      const empty=document.createElement('span');
      empty.style.cssText='font-size:11px;color:var(--text3);padding:4px 0';
      empty.textContent=cat==='recent'?'아직 사용한 패턴이 없어요':'패턴 없음';
      c.appendChild(empty);
    }

    // ── 초기화 칩 ──
    const clr=document.createElement('span');
    clr.className='pat-chip';
    clr.textContent='✕ 초기화';
    clr.style.cssText='opacity:.55;margin-left:4px';
    clr.title='선택 해제 및 입력 초기화';
    clr.onclick=()=>{
      _chipSelected['patHelper'].clear();
      c.querySelectorAll('.pat-chip.active').forEach(el=>el.classList.remove('active'));
      const inp=document.getElementById('pattern');if(inp)inp.value='';
      const applyBar=document.getElementById('patApplyBar');if(applyBar)applyBar.style.display='none';
      typeof previewToc==='function'&&previewToc();
    };
    c.appendChild(clr);
  }

  function _syncPatInput(){
    const combined=buildCombinedPat(_chipSelected['patHelper']);
    const inp=document.getElementById('pattern');
    if(inp) inp.value=combined;
  }

  function _addRecentPat(val){
    _recentPats=_recentPats.filter(v=>v!==val);
    _recentPats.unshift(val);
    if(_recentPats.length>6) _recentPats=_recentPats.slice(0,6);
    try{localStorage.setItem('novelepub_recent_pats',JSON.stringify(_recentPats));}catch(e){}
    // 최근 탭 버튼 표시
    const recentTab=document.getElementById('patCatRecent');
    if(recentTab) recentTab.style.display='';
  }

  // ── 카테고리 탭 이벤트 ──
  const tabBar=document.getElementById('patCatTabs');
  if(tabBar){
    // 최근 사용이 있으면 탭 표시
    if(_recentPats.length>0){
      const rt=document.getElementById('patCatRecent');
      if(rt) rt.style.display='';
    }
    tabBar.querySelectorAll('.pat-cat-tab').forEach(btn=>{
      btn.addEventListener('click',()=>{
        tabBar.querySelectorAll('.pat-cat-tab').forEach(b=>b.classList.remove('on'));
        btn.classList.add('on');
        renderChips(btn.dataset.cat);
      });
    });
  }

  // 초기 렌더
  renderChips('popular');
  // chip_detected 갱신을 위한 refreshDetectedChip 호환
  window._renderMainPatChips=()=>renderChips(_activeCat);
}

// ── 레거시 헬퍼 (insPatHelper / eTocPatHelper — 기존 방식 유지) ──
function _buildLegacyChips(id){
  const c=document.getElementById(id); if(!c) return;
  const targetInput=id==='insPatHelper'?'insPattern':'eTocPatEdit';
  c.innerHTML='';
  const hint=document.createElement('span');
  hint.style.cssText='font-size:11px;color:var(--text2);align-self:center;margin-right:2px';
  hint.textContent='빠른 선택:';
  c.appendChild(hint);

  PAT_PRESETS.forEach(p=>{
    const chip=document.createElement('span');
    chip.className='pat-chip';
    chip.textContent=p.label;
    chip.dataset.val=p.val;
    chip.title=p.desc||p.label;
    chip.onclick=()=>{
      const sel=_chipSelected[id];
      if(sel.has(p.val)){sel.delete(p.val);chip.classList.remove('active');}
      else{sel.add(p.val);chip.classList.add('active');}
      const combined=buildCombinedPat(sel);
      const inp=document.getElementById(targetInput);
      if(inp) inp.value=combined;
      typeof reloadInsToc==='function'&&reloadInsToc();
    };
    c.appendChild(chip);
  });

  const clr=document.createElement('span');
  clr.className='pat-chip';
  clr.textContent='✕ 초기화';
  clr.style.opacity='.6';
  clr.onclick=()=>{
    _chipSelected[id].clear();
    c.querySelectorAll('.pat-chip.active').forEach(el=>el.classList.remove('active'));
    const inp=document.getElementById(targetInput);if(inp)inp.value='';
    typeof reloadInsToc==='function'&&reloadInsToc();
  };
  c.appendChild(clr);
}

function refreshDetectedChip(){
  // ★ 카테고리 탭 방식: 전체 재렌더로 갱신
  if(typeof window._renderMainPatChips==='function'){
    window._renderMainPatChips();
    return;
  }
  const chip=document.getElementById('chip_detected');
  if(!chip) return;
  const hasDet=S._detectedPat&&S._detectedName;
  chip.textContent=hasDet?'✅ 감지됨: '+S._detectedName:'⬜ 감지 없음';
  chip.style.opacity=hasDet?'1':'0.4';
  chip.style.cursor=hasDet?'pointer':'default';
  chip.title=hasDet?'현재 자동 감지된 패턴을 선택에 추가':'아직 목차 확인을 실행하지 않았어요';
  if(hasDet){
    const src=S._detectedPat.source;
    const sel=_chipSelected['patHelper'];
    if(sel.has(src)) chip.classList.add('active');
    else chip.classList.remove('active');
    chip.onclick=()=>{
      if(sel.has(src)){ sel.delete(src); chip.classList.remove('active'); }
      else { sel.add(src); chip.classList.add('active'); }
      const combined=buildCombinedPat(sel);
      const inp=document.getElementById('pattern');
      if(inp) inp.value=combined;
      typeof previewToc==='function'&&previewToc();
    };
  } else { chip.onclick=null; }
}

function buildCombinedPat(selSet){
  if(selSet.size===0) return '';
  if(selSet.size===1) return [...selSet][0];
  const parts=[...selSet].map(p=>{
    const hasStart = p.startsWith('^');
    let core = hasStart ? p.slice(1) : p;
    // ★ L-04 FIX: endsWith 단순화
    const hasEnd = core.endsWith('$') && !core.endsWith('\\$');
    if(hasEnd) core = core.slice(0, -1);
    if(core.startsWith('(?:') && core.endsWith(')')){
      let d=0, isOuter=true;
      for(let i=0;i<core.length;i++){
        if(core[i]==='('&&core[i-1]!=='\\') d++;
        else if(core[i]===')'&&core[i-1]!=='\\') d--;
        if(d===0 && i<core.length-1){isOuter=false;break;}
      }
      if(isOuter) core=core.slice(3,-1);
    }
    return '(?:'+core+(hasEnd?'$':'')+')';
  });
  const hasSomeStart=[...selSet].some(p=>p.startsWith('^'));
  return (hasSomeStart?'^':'')+'(?:'+parts.join('|')+')';
}

function clearChipSelection(helperId){
  _chipSelected[helperId]?.clear();
  const c=document.getElementById(helperId);
  if(c) c.querySelectorAll('.pat-chip.active').forEach(el=>el.classList.remove('active'));
}

// ── 단축키 도움말 ──
function showShortcutHelp(){
  const existing=document.getElementById('shortcutHelp');
  if(existing){existing.remove();return;}
  const kbdStyle='background:var(--bg2);border:1px solid var(--border);border-radius:4px;padding:2px 6px';
  const el=document.createElement('div');
  el.id='shortcutHelp';
  el.style.cssText='position:fixed;top:50%;left:50%;transform:translate(-50%,-50%);background:var(--panel);border:2px solid var(--border);border-radius:14px;padding:20px 24px;z-index:9999;box-shadow:0 8px 32px rgba(0,0,0,.3);font-size:12px;min-width:280px';
  el.innerHTML='<div style="font-size:14px;font-weight:700;margin-bottom:12px;color:var(--text)">⌨️ 단축키</div>'+
    '<table style="border-collapse:collapse;width:100%;line-height:2"><tbody>'+
    '<tr><td style="color:var(--text2);padding-right:16px"><kbd style="'+kbdStyle+'">Ctrl+Space</kbd></td><td>✨ 변환 시작</td></tr>'+
    '<tr><td><kbd style="'+kbdStyle+'">Ctrl+S</kbd></td><td>⬇ EPUB 다운로드</td></tr>'+
    '<tr><td><kbd style="'+kbdStyle+'">Ctrl+클릭</kbd></td><td>목차 다중 선택 (병합용)</td></tr>'+
    '<tr><td><kbd style="'+kbdStyle+'">Shift+클릭</kbd></td><td>목차 범위 선택</td></tr>'+
    '<tr><td><kbd style="'+kbdStyle+'">드래그 중앙</kbd></td><td>두 챕터 드래그 병합</td></tr>'+
    '<tr><td><kbd style="'+kbdStyle+'">Ctrl+?</kbd></td><td>이 도움말 열기/닫기</td></tr>'+
    '<tr><td><kbd style="'+kbdStyle+'">Esc</kbd></td><td>모달 닫기</td></tr>'+
    '</tbody></table>'+
    '<div style="text-align:right;margin-top:12px"><button class="btn btn-ghost btn-sm" id="shortcutHelpClose">닫기</button></div>';
  document.body.appendChild(el);
  document.getElementById('shortcutHelpClose')?.addEventListener('click',()=>el.remove());
}

// ── 드래그드롭 셋업 ──
function setupDragDrop(){
  setupDz('txtDz',         (f)=>handleTxt(f),                 'txtIn');
  setupDz('coverDz',       (f)=>handleCover(f),               'coverIn');
  setupDz('illDz',         (f)=>handleIll(f),                 'illIn');
  setupDz('epubDrop',      files=>loadEpub(files[0]),         'epubIn');
  setupDz('insTxtDrop',    (f)=>handleInsTxt(f),              'insTxtIn');
  setupDz('insIllDrop',    (f)=>handleInsIll(f),              'insIllIn');
  setupDz('editIllDrop',   (f)=>handleEditIll(f),             'editIllIn');
  setupDz('batchTxtDrop',  (f)=>handleBatchTxt(f),            'batchTxtIn');
  setupDz('batchCoverDrop',(f)=>handleBatchCover(f),          'batchCoverIn');
  setupDz('fontDrop',      (f)=>handleCustomFont(f),          'fontIn');
  setupDz('cssImportDrop', (f)=>handleCssImportEpub(f),       'cssImportIn');
}

function setupDz(id,fn,inputId){
  const el=document.getElementById(id);
  if(!el) return;
  el.addEventListener('dragover',e=>{e.preventDefault();el.classList.add('over');});
  el.addEventListener('dragleave',()=>el.classList.remove('over'));
  el.addEventListener('drop',e=>{
    e.preventDefault();el.classList.remove('over');
    fn(e.dataTransfer.files);
    _spawnDropConfetti(el);
  });
  if(inputId){
    el.onclick=()=>{const inp=document.getElementById(inputId);if(inp)inp.click();};
    el.addEventListener('keydown',e=>{
      if(e.key==='Enter'||e.key===' '){
        e.preventDefault();
        const inp=document.getElementById(inputId);
        if(inp) inp.click();
      }
    });
  }
}

function _spawnDropConfetti(container){
  if(!container) return;
  const colors = ['var(--accent)','var(--blue)','var(--green)','var(--accent2)','var(--yellow)','#9b59b6'];
  for(let i=0; i<6; i++){
    const c = document.createElement('span');
    c.className = 'dz-confetti';
    const left = 20 + Math.random() * 60;
    const delay = Math.random() * 0.3;
    c.style.cssText =
      `left:${left}%;top:30%;background:${colors[i % colors.length]};` +
      `animation-delay:${delay}s;border-radius:${Math.random()>0.5?'50%':'2px'}`;
    container.appendChild(c);
    setTimeout(()=>c.remove(), 900);
  }
}

// ── data-input-action 인풋 이벤트 위임 ──
(function setupInputDelegate(){
  const _inputHandlers = {
    previewCoverUrlConvert: () => typeof previewCoverUrl==='function'&&previewCoverUrl('coverUrlInp','coverThumb','coverName','convert'),
    previewCoverUrlBatch:   () => typeof previewCoverUrl==='function'&&previewCoverUrl('batchCoverUrlInp',null,null,'batch'),
    patternValidate: (el) => {
      const val = el.value.trim();
      const patEl = document.getElementById('pattern');
      if(!patEl) return;
      if(!val){ patEl.style.borderColor=''; patEl.title=''; return; }
      try{
        const rx = new RegExp(val,'i');
        const lines = typeof _fullRawLines!=='undefined'&&_fullRawLines ? _fullRawLines : [];
        const cnt = lines.filter(l=>l.trim()&&rx.test(l.trim())).length;
        if(cnt===0){ patEl.style.borderColor='var(--accent2)'; patEl.title='유효한 정규식이지만 현재 파일에서 매칭 0건'; }
        else { patEl.style.borderColor='var(--green)'; patEl.title=`매칭 ${cnt.toLocaleString()}건 발견`; }
      }catch(e){ patEl.style.borderColor='var(--accent)'; patEl.title='정규식 오류: '+e.message; }
      clearChipSelection&&clearChipSelection('patHelper');
      const clearBtn = document.getElementById('patternClearBtn');
      if(clearBtn) clearBtn.style.display = val ? '' : 'none';
    },
    clearChipInsHelper:     ()   => clearChipSelection('insPatHelper'),
    smartPatConvert:        ()   => typeof smartPatConvert==='function'&&smartPatConvert(),
    eSmartPatConvert:       ()   => typeof eSmartPatConvert==='function'&&eSmartPatConvert(),
    clearEtocChip:          ()   => clearChipSelection('eTocPatHelper'),
    saveCssSettings:        ()   => typeof saveCssSettings==='function'&&saveCssSettings(),
    liveUpdateCover: (el) => {
      if(S.coverFile) return;
      const title  = document.getElementById('title')?.value||'';
      const author = document.getElementById('author')?.value||'';
      if(!title) return;
      typeof generateTextCover==='function'&&generateTextCover(title, author).then(blob=>{
        if(!blob) return;
        const url = URL.createObjectURL(blob);
        const thumb = document.getElementById('coverThumb');
        if(!thumb) return;
        let img = thumb.querySelector('img');
        if(!img){ img=document.createElement('img'); thumb.innerHTML=''; thumb.appendChild(img); }
        const old = img.src;
        img.src = url;
        img.onload = ()=>{ if(old&&old.startsWith('blob:')) URL.revokeObjectURL(old); };
      }).catch(()=>{});
    },
    saveExtraSettings:      ()   => typeof saveExtraSettings==='function'&&saveExtraSettings(),
    saveApiSettings:        ()   => typeof saveApiSettings==='function'&&saveApiSettings(),
    syncImgQuality:         (el) => {
      const val = document.getElementById('optImgQualityVal');
      if(val) val.textContent = el.value + '%';
      typeof saveExtraSettings==='function'&&saveExtraSettings();
    },
    saveExtraSettingsRenderIll: () => { typeof saveExtraSettings==='function'&&saveExtraSettings(); typeof renderIllTags==='function'&&renderIllTags(); },
    updateCssSave: () => { updateCssPreview(); typeof saveCssSettings==='function'&&saveCssSettings(); updateMiniReader&&updateMiniReader(); updateSettingsSummary&&updateSettingsSummary(); },
    cssExtraAutoResize: (el) => {
      el.style.height = 'auto';
      el.style.height = Math.min(el.scrollHeight, 300) + 'px';
      updateCssPreview();
      typeof saveCssSettings==='function'&&saveCssSettings();
    },
    saveOptLang:   () => typeof saveExtraSettings==='function'&&saveExtraSettings(),
    toggleNotification: (el) => {
      if(!el.checked){ localStorage.removeItem(_notifKey); _initNotifStatus&&_initNotifStatus(); return; }
      if(typeof Notification === 'undefined'){ el.checked=false; return; }
      if(Notification.permission === 'granted'){
        localStorage.setItem(_notifKey,'true'); _initNotifStatus&&_initNotifStatus();
      } else if(Notification.permission !== 'denied'){
        Notification.requestPermission().then(perm=>{
          if(perm==='granted'){ localStorage.setItem(_notifKey,'true'); }
          else { el.checked=false; }
          _initNotifStatus&&_initNotifStatus();
        });
      } else {
        el.checked=false; Toast.warn('브라우저 알림이 차단되어 있어요. 브라우저 주소창 자물쇠 아이콘에서 허용해주세요.');
      }
    },
    updateSuspThreshold: (() => {
      let _debTimer = null;
      return (el) => {
        const val = parseInt(el.value) || 50;
        const display = document.getElementById('suspThresholdVal');
        if(display) display.textContent = val + '자';
        try{ localStorage.setItem('novelepub_susp_threshold', String(val)); }catch(e){}
        clearTimeout(_debTimer);
        _debTimer = setTimeout(() => {
          if(!S?.tocItems?.length) return;
          S.tocItems.forEach((t, fi) => {
            const bl = typeof t.bodyLen === 'number' ? t.bodyLen : (t.body||'').replace(/\s/g,'').length;
            t.suspicious = bl < val && fi < S.tocItems.length - 1;
          });
          typeof updateTocStat === 'function' && updateTocStat();
          typeof renderTocItems === 'function' && renderTocItems();
        }, 80);
      };
    })(),
    // ── CSS 슬라이더 ↔ 셀렉트 동기화 ──
    syncCssLine:          (el) => { typeof syncSelect==='function'&&syncSelect('cssLine','cssLineSlider','cssLineVal',el.value); updateCssPreview(); typeof saveCssSettings==='function'&&saveCssSettings(); updateMiniReader&&updateMiniReader(); },
    syncCssLineSlider:    (el) => { typeof syncSlider==='function'&&syncSlider('cssLine','cssLineSlider','cssLineVal',el.value); updateCssPreview(); typeof saveCssSettings==='function'&&saveCssSettings(); updateMiniReader&&updateMiniReader(); },
    syncCssFontSize:      (el) => { typeof syncSelect==='function'&&syncSelect('cssFontSize','cssFontSizeSlider','cssFontSizeVal',el.value); updateCssPreview(); typeof saveCssSettings==='function'&&saveCssSettings(); updateMiniReader&&updateMiniReader(); },
    syncCssFontSizeSlider:(el) => { typeof syncSlider==='function'&&syncSlider('cssFontSize','cssFontSizeSlider','cssFontSizeVal',el.value); updateCssPreview(); typeof saveCssSettings==='function'&&saveCssSettings(); updateMiniReader&&updateMiniReader(); },
    syncIndent:           (el) => { typeof syncIndent==='function'&&syncIndent(parseFloat(el.value)||1.0); updateCssPreview(); typeof saveCssSettings==='function'&&saveCssSettings(); updateMiniReader&&updateMiniReader(); },
    syncPadTop:           (el) => { const v=document.getElementById('cssPadTop');if(v)v.value=el.value; const d=document.getElementById('cssPadTopVal');if(d)d.textContent=el.value+'em'; updateCssPreview(); typeof saveCssSettings==='function'&&saveCssSettings(); },
    syncPadBottom:        (el) => { const v=document.getElementById('cssPadBottom');if(v)v.value=el.value; const d=document.getElementById('cssPadBottomVal');if(d)d.textContent=el.value+'em'; updateCssPreview(); typeof saveCssSettings==='function'&&saveCssSettings(); },
    syncPadLeft:          (el) => { const v=document.getElementById('cssPadLeft');if(v)v.value=el.value; const d=document.getElementById('cssPadLeftVal');if(d)d.textContent=el.value+'em'; updateCssPreview(); typeof saveCssSettings==='function'&&saveCssSettings(); },
    syncPadRight:         (el) => { const v=document.getElementById('cssPadRight');if(v)v.value=el.value; const d=document.getElementById('cssPadRightVal');if(d)d.textContent=el.value+'em'; updateCssPreview(); typeof saveCssSettings==='function'&&saveCssSettings(); },
  };

  document.addEventListener('input', e=>{
    const action = e.target?.dataset?.inputAction;
    if(action && _inputHandlers[action]) {
      _inputHandlers[action](e.target, e);
    }
  }, false);
  document.addEventListener('change', e=>{
    const action = e.target?.dataset?.inputAction;
    if(action && _inputHandlers[action]) {
      _inputHandlers[action](e.target, e);
    }
  }, false);
})();

function setupEventListeners(){
  document.getElementById('txtIn').onchange        =e=>{ const append=S.txtFiles.length>0; typeof handleTxt==='function'&&handleTxt(e.target.files,append); e.target.value=''; };
  document.getElementById('illIn').onchange        =e=>typeof handleIll==='function'&&handleIll(e.target.files);
  document.getElementById('coverIn').onchange      =e=>typeof handleCover==='function'&&handleCover(e.target.files);
  document.getElementById('epubIn').onchange       =e=>typeof loadEpub==='function'&&loadEpub(e.target.files[0]);
  document.getElementById('insTxtIn').onchange     =e=>typeof handleInsTxt==='function'&&handleInsTxt(e.target.files);
  document.getElementById('insIllIn').onchange     =e=>typeof handleInsIll==='function'&&handleInsIll(e.target.files);
  document.getElementById('editIllIn').onchange    =e=>typeof handleEditIll==='function'&&handleEditIll(e.target.files);
  document.getElementById('batchTxtIn').onchange   =e=>typeof handleBatchTxt==='function'&&handleBatchTxt(e.target.files);
  document.getElementById('batchCoverIn').onchange =e=>typeof handleBatchCover==='function'&&handleBatchCover(e.target.files);
  document.getElementById('fontIn').onchange       =e=>handleCustomFont(e.target.files);
  document.getElementById('cssImportIn').onchange  =e=>typeof handleCssImportEpub==='function'&&handleCssImportEpub(e.target.files);
  document.getElementById('coverThumb').onclick    =()=>document.getElementById('coverIn')?.click();

  // ★ U-03: 클립보드 붙여넣기(Ctrl+V) 파일 지원
  document.addEventListener('paste', e=>{
    const tag=(e.target?.tagName||'').toUpperCase();
    if(tag==='INPUT'||tag==='TEXTAREA') return;
    const files=e.clipboardData?.files;
    if(!files||!files.length) return;
    const txtFiles=[...files].filter(f=>f.name.toLowerCase().endsWith('.txt')||f.type==='text/plain');
    const imgFiles=[...files].filter(f=>/\.(jpg|jpeg|png|gif|webp|bmp|tiff|tif|avif)$/i.test(f.name)||f.type.startsWith('image/'));
    if(txtFiles.length){ e.preventDefault(); typeof handleTxt==='function'&&handleTxt(txtFiles, S.txtFiles.length>0); Toast.info(`📋 TXT ${txtFiles.length}개 파일 붙여넣기됨`); }
    else if(imgFiles.length){ e.preventDefault(); typeof handleIll==='function'&&handleIll(imgFiles); Toast.info(`📋 이미지 ${imgFiles.length}개 파일 붙여넣기됨`); }
  });

  // ★ UI-07: 표지 썸네일 3D 틸트 효과
  (()=>{
    const thumb = document.getElementById('coverThumb');
    if(!thumb) return;
    thumb.addEventListener('mousemove', e=>{
      const r = thumb.getBoundingClientRect();
      const cx = r.left + r.width/2, cy = r.top + r.height/2;
      const dx = (e.clientX - cx) / (r.width/2);
      const dy = (e.clientY - cy) / (r.height/2);
      thumb.classList.add('tilting');
      thumb.style.transform = `perspective(500px) rotateY(${dx*8}deg) rotateX(${-dy*8}deg) scale(1.03)`;
    });
    thumb.addEventListener('mouseleave', ()=>{ thumb.classList.remove('tilting'); thumb.style.transform = ''; });
  })();

  document.querySelectorAll('input[name="editIllMode"]').forEach(r=>r.addEventListener('change',e=>{
    document.getElementById('editIllManual').style.display=e.target.value==='manual'?'block':'none';
  }));
  document.querySelectorAll('input[name="insPos"]').forEach(r=>r.addEventListener('change',()=>{
    if(E.selectedChIdx!==null) typeof selectCh==='function'&&selectCh(E.selectedChIdx);
  }));

  // ★ 단축키 — Ctrl+Space: 변환 시작 / Ctrl+S: 다운로드 / Ctrl+?: 도움말
  document.addEventListener('keydown',e=>{
    const tag=(e.target.tagName||'').toUpperCase();
    if(tag==='INPUT'||tag==='TEXTAREA'||tag==='SELECT') return;
    if(e.ctrlKey||e.metaKey){
      if(e.key===' '){e.preventDefault(); typeof startConvert==='function'&&startConvert();}
      else if(e.key==='s'||e.key==='S'){e.preventDefault(); typeof downloadEpub==='function'&&downloadEpub();}
      else if(e.key==='/'||e.key==='?'){e.preventDefault();showShortcutHelp();}
    }
    if(e.key==='Escape'){
      document.querySelector('.modal-overlay.show')&&document.querySelector('.modal-overlay.show')
        .querySelectorAll('[data-action]')
        .forEach(el=>{ if(el.dataset.action?.includes('close'))el.click(); });
    }
  });
}

function setupEventDelegate(){
  EventDelegate.registerAll({
    toggleTheme:   () => toggleTheme(),
    switchPage:    (el) => switchPage(el.dataset.page),
    // ── TXT 파일 목록 버튼 ──
    addMoreTxt:    () => document.getElementById('txtIn')?.click(),
    sortTxtAuto:   () => {
      if(!S?.txtFiles?.length) return;
      S.txtFiles = typeof smartSortFiles==='function' ? smartSortFiles(S.txtFiles) : [...S.txtFiles].sort((a,b)=>{
        const n=(s)=>s.replace(/(\d+)/g,m=>m.padStart(10,'0'));
        return n(a.name)<n(b.name)?-1:1;
      });
      typeof renderTxtFileList==='function'&&renderTxtFileList();
      Toast.success('숫자 기준 자동 정렬 완료');
    },
    sortTxtAlpha:  () => {
      if(!S?.txtFiles?.length) return;
      S.txtFiles = [...S.txtFiles].sort((a,b)=>a.name.localeCompare(b.name,'ko'));
      typeof renderTxtFileList==='function'&&renderTxtFileList();
      Toast.success('사전순 정렬 완료');
    },
    resetAll:      () => typeof resetAll==='function'&&resetAll(),
    resetConvertAll: () => typeof resetConvertAll==='function'&&resetConvertAll(),
    resetConvertTxt: () => typeof resetConvertTxt==='function'&&resetConvertTxt(),
    resetConvertCover: () => typeof resetConvertCover==='function'&&resetConvertCover(),
    resetBatchAll: () => typeof resetBatchAll==='function'&&resetBatchAll(),
    resetBatchTxt: () => typeof resetBatchTxt==='function'&&resetBatchTxt(),
    resetBatchCover: () => typeof resetBatchCover==='function'&&resetBatchCover(),
    resetEditAll:  () => typeof resetEditAll==='function'&&resetEditAll(),
    resetEditEpub: () => typeof resetEditEpub==='function'&&resetEditEpub(),
    resetAllSettings: () => typeof resetAllSettings==='function'&&resetAllSettings(),
    startConvert:  () => typeof startConvert==='function'&&startConvert(),
    startBatch:    () => typeof startBatch==='function'&&startBatch(),
    downloadBatchZip: () => typeof downloadBatchZip==='function'&&downloadBatchZip(),
    startEditEpub: () => typeof startEditEpub==='function'&&startEditEpub(),
    downloadEditEpub: () => typeof downloadEditEpub==='function'&&downloadEditEpub(),
    downloadEpub:  () => typeof downloadEpub==='function'&&downloadEpub(),
    shareEpub:     () => typeof shareEpub==='function'&&shareEpub(),
    startSplit:    (el) => typeof startSplit==='function'&&startSplit(parseInt(el.dataset.n||'5')),
    exportTocWithStats: () => typeof exportTocWithStats==='function'&&exportTocWithStats(),
    openCoverModal: (el) => typeof openCoverModal==='function'&&openCoverModal(el.dataset.mode||'convert'),
    closeCoverModal: () => typeof closeCoverModal==='function'&&closeCoverModal(),
    runCoverSearch: () => typeof runCoverSearch==='function'&&runCoverSearch(),
    abortCoverSearch: () => typeof abortCoverSearch==='function'&&abortCoverSearch(),
    applyCoverUrl: (el) => typeof applyCoverUrl==='function'&&applyCoverUrl(el.dataset.inp,el.dataset.thumb,el.dataset.name,el.dataset.mode),
    clearCssImport: () => typeof clearCssImport==='function'&&clearCssImport(),
    applyCssImport: () => typeof applyCssImport==='function'&&applyCssImport(),
    addManualIll:  () => typeof addManualIll==='function'&&addManualIll(),
    addInsManualIll: () => typeof addInsManualIll==='function'&&addInsManualIll(),
    addEditIllRow: () => typeof addEditIllRow==='function'&&addEditIllRow(),
    addDirectEditIllRow: () => typeof addDirectEditIllRow==='function'&&addDirectEditIllRow(),
    applyInsTocRange: (el) => typeof applyInsTocRange==='function'&&applyInsTocRange(el.dataset.mode),
    syncInsTocRefSelect: () => typeof syncInsTocRefSelect==='function'&&syncInsTocRefSelect(),
    toggleAllInsToc: (el) => typeof toggleAllInsToc==='function'&&toggleAllInsToc(el.dataset.val==='true'),
    selectCh:      (el) => typeof selectCh==='function'&&selectCh(parseInt(el.dataset.idx)),
    extractEpubImages: () => typeof extractEpubImages==='function'&&extractEpubImages(),
    previewToc:    () => typeof previewToc==='function'&&previewToc(),
    autoSplitByInterval: () => typeof autoSplitByInterval==='function'&&autoSplitByInterval(),
    applyPat:      () => typeof applyPat==='function'&&applyPat(),
    tocTab:        (el) => typeof tocTab==='function'&&tocTab(parseInt(el.dataset.idx)),
    undoToc:       () => typeof undoToc==='function'&&undoToc(),
    applyPatFromBar: () => { const v=document.getElementById('pattern')?.value; if(v) typeof previewToc==='function'&&previewToc(); },
    saveCurrentAsPreset: () => saveCurrentAsPreset(),
    exportSettings: () => exportSettings(),
    importSettingsBtn: () => importSettingsBtn(),
    setSkin:       (el) => typeof setSkin==='function'&&setSkin(el.dataset.skin),
    togglePadAccordion: () => togglePadAccordion(),
    showPreview:   () => typeof showPreview==='function'&&showPreview(),
    closePreview:  () => typeof closePreview==='function'&&closePreview(),
    previewNav:    (el) => typeof previewNav==='function'&&previewNav(parseInt(el.dataset.dir)),
    histDownload:  (el) => histDownload(el.dataset.key, el.dataset.name),
    deleteHistory: (el) => deleteHistory(el.dataset.key),
    clearAllHistory: () => clearAllHistory(),
    toggleAllToc:  (el) => typeof toggleAllToc==='function'&&toggleAllToc(el.dataset.val === 'true'),
    removeDirectIllRow: (el) => { const row = document.getElementById(el.dataset.rowId); if(row) row.remove(); },
    removeAllSuspicious: () => {
      const indices=[];
      S.tocItems.forEach((t,i)=>{ if(t.suspicious && i+1<S.tocItems.length) indices.push(i+1); });
      const toRemove=[...new Set(indices)].sort((a,b)=>b-a);
      if(toRemove.length>0) typeof _saveTocSnapshot==='function'&&_saveTocSnapshot();
      toRemove.forEach(i=>S.tocItems.splice(i,1));
      typeof _chaptersCache!=='undefined'&&(_chaptersCache=null);
      typeof _chaptersCacheKey!=='undefined'&&(_chaptersCacheKey='');
      typeof renderTocItems==='function'&&renderTocItems();
      typeof updateTocStat==='function'&&updateTocStat();
      typeof updateTocEditBanner==='function'&&updateTocEditBanner();
      document.getElementById('susp-toast')?.remove();
      if(toRemove.length>0) Toast.success('오감지 챕터 '+toRemove.length+'개를 목차에서 제거했어요.');
    },
    downloadSplitZip: () => typeof downloadSplitZip==='function'&&downloadSplitZip(),
    removeManualIllRow: (el) => { const row = document.getElementById(el.dataset.rowId); if (row) row.remove(); },
    removeEditIllRow: (el) => { const row = document.getElementById(el.dataset.rowId); if (row) row.remove(); },
    toggleChipGroup:         ()   => toggleChipGroup(),
    switchEditTab:          (el) => typeof switchEditTab==='function'&&switchEditTab(el.dataset.tab),
    eTocTab:                (el) => typeof eTocTab==='function'&&eTocTab(parseInt(el.dataset.idx)),
    eToggleAllToc:          (el) => typeof eToggleAllToc==='function'&&eToggleAllToc(el.dataset.val==='true'),
    previewEpubToc:         ()   => typeof previewEpubToc==='function'&&previewEpubToc(),
    applyESmartPat:         ()   => typeof applyESmartPat==='function'&&applyESmartPat(),
    applyETocSelectedChips: ()   => typeof applyETocSelectedChips==='function'&&applyETocSelectedChips(),
    applyEPat:              ()   => typeof applyEPat==='function'&&applyEPat(),
    directEditTocCheckAll:  (el) => typeof directEditTocCheckAll==='function'&&directEditTocCheckAll(el.dataset.val==='true'),
    directEditTocMoveUp:    ()   => typeof directEditTocMoveUp==='function'&&directEditTocMoveUp(),
    directEditTocMoveDown:  ()   => typeof directEditTocMoveDown==='function'&&directEditTocMoveDown(),
    directEditCssPreset:    (el) => typeof directEditCssPreset==='function'&&directEditCssPreset(el.dataset.preset),
    clearDirectEditCss:     ()   => { const el=document.getElementById('directEditCssInput'); if(el) el.value=''; },
    applyDirectEdit:        ()   => typeof applyDirectEdit==='function'&&applyDirectEdit(),
    downloadDirectEditEpub: ()   => typeof downloadDirectEditEpub==='function'&&downloadDirectEditEpub(),
    showShortcutHelp:       ()   => showShortcutHelp(),
  });

  EventDelegate.init();

  // ── 모달 오버레이 클릭 닫기 ──
  document.addEventListener('click', e => {
    const overlay = e.target.closest('[data-action-overlay]');
    if (overlay && e.target === overlay) {
      const fn = overlay.dataset.actionOverlay;
      if (fn === 'closePreview')    typeof closePreview==='function'&&closePreview();
      if (fn === 'closeCoverModal') typeof closeCoverModal==='function'&&closeCoverModal();
    }
  });

  // ── 복사 버튼 툴팁 ──
  document.addEventListener('click', e=>{
    const copyBtn=e.target.closest('[data-copy]');
    if(!copyBtn) return;
    const text=copyBtn.getAttribute('data-copy-text')||copyBtn.textContent;
    navigator.clipboard?.writeText(text).then(()=>{
      copyBtn.querySelector('.copy-tooltip')?.remove();
      const tip=document.createElement('span');
      tip.className='copy-tooltip';
      tip.textContent='복사됨!';
      copyBtn.appendChild(tip);
      setTimeout(()=>tip.remove(), 1050);
    }).catch(()=>{});
  });

  // ── EventBus 구독 ──
  EventBus.on('page:changed', ({name}) => {
    if (name === 'history') typeof renderHistory==='function'&&renderHistory();
  });

  // ── StateManager 구독 ──
  _sStore.subscribe((state) => {
    const bar = document.getElementById('convertResetBar');
    if (bar) bar.style.display = (state.txtFiles.length || state.coverFile) ? 'flex' : 'none';
    if(state.tocItems) {
      typeof updateFeedFromToc==='function'&&updateFeedFromToc(state.tocItems);
      updateMiniReader&&updateMiniReader();
    }
  });
}

// ══════════════════════════════════════════
// 🚀 DOMContentLoaded 진입점
// ══════════════════════════════════════════

// ★ BUG-30 수정: DOMContentLoaded 리스너를 단일 블록으로 통합
window.addEventListener('DOMContentLoaded', ()=>{
  initTheme();
  loadCssSettings();
  loadExtraSettings();
  loadApiSettings();
  buildFontDropdown&&buildFontDropdown();
  loadUserPrefs();
  buildPatHelpers();
  setupDragDrop();
  setupEventListeners();
  setupEventDelegate();
  updateSettingsSummary();
  renderCssPresetList&&renderCssPresetList();
  typeof renderHistory==='function'&&renderHistory();
  initSkin&&initSkin();
  buildFontDropdown&&buildFontDropdown();
  updateFontPreview&&updateFontPreview();

  // 폰트/슬라이더 change 이벤트
  ['cssFont','cssFontSize','cssLine',
   'cssPadTop','cssPadBottom','cssPadLeft','cssPadRight'].forEach(id=>{
    document.getElementById(id)?.addEventListener('change', ()=>{
      updateFontPreview&&updateFontPreview();
      saveUserPrefs&&saveUserPrefs();
      saveCssSettings&&saveCssSettings();
    });
    if(id.startsWith('cssPad')){
      document.getElementById(id)?.addEventListener('input', ()=>{
        const slEl=document.getElementById(id+'Slider');
        const numEl=document.getElementById(id);
        if(slEl&&numEl) slEl.value=numEl.value;
        saveUserPrefs&&saveUserPrefs();
        saveCssSettings&&saveCssSettings();
      });
    }
  });
  // cssPadXxxSlider의 input 이벤트는 data-input-action="syncPadXxx" 핸들러가 처리 (중복 제거)
  ['optItalic','optIndent','optMergeShortLines'].forEach(id=>{
    document.getElementById(id)?.addEventListener('change', saveUserPrefs);
  });

  document.getElementById('histSearchInp')?.addEventListener('input', ()=>filterHistory&&filterHistory());
  document.getElementById('histFilterHasFile')?.addEventListener('click', function(){ toggleHistFilter&&toggleHistFilter(this); });
  document.getElementById('coverSearchQ')?.addEventListener('keydown', e=>{ if(e.key==='Enter') typeof runCoverSearch==='function'&&runCoverSearch(); });
  document.getElementById('padAccordionToggle')?.addEventListener('click', ()=>togglePadAccordion&&togglePadAccordion());

  const lineVal=document.getElementById('cssLine')?.value||'1.9';
  syncSelect('cssLine','cssLineSlider','cssLineVal',lineVal);
  const sizeVal=document.getElementById('cssFontSize')?.value||'1em';
  syncSelect('cssFontSize','cssFontSizeSlider','cssFontSizeVal',sizeVal);

  // suspThresholdSlider 초기값 복원
  (()=>{
    let savedThr = 50;
    try{ savedThr = parseInt(localStorage.getItem('novelepub_susp_threshold')||'50')||50; }catch(e){}
    const slider = document.getElementById('suspThresholdSlider');
    const display = document.getElementById('suspThresholdVal');
    if(slider){ slider.value = String(savedThr); }
    if(display){ display.textContent = savedThr + '자'; }
  })();

  // 커스텀 폰트 복원
  SettingsDB.get('customFontFace').then(face=>{
    if(face){
      SettingsDB.get('customFontName').then(name=>{
        customFontFace = face;
        customFontName = name||'커스텀폰트';
        const opt=document.getElementById('customFontOpt');
        if(opt){opt.textContent='📁 '+customFontName;opt.style.display='';opt.value='"'+customFontName+'",serif';}
      });
    }
  }).catch(()=>{});
});

// ★ 모바일 스와이프 탭 전환
(function setupSwipe(){
  const pages = ['convert','batch','edit','history','settings'];
  let _swX = null, _swY = null, _swActive = false;
  document.addEventListener('touchstart', e=>{
    if(e.target.closest('.txt-file-row,.toc-drag-handle,.toc-item,.ch-list,.toc-body,.modal-overlay')) return;
    if(e.touches.length !== 1) return;
    _swX = e.touches[0].clientX; _swY = e.touches[0].clientY; _swActive = true;
  }, {passive:true});
  document.addEventListener('touchmove', e=>{
    if(!_swActive || _swX===null || _swY===null) return;
    const dx = e.touches[0].clientX - _swX;
    const dy = e.touches[0].clientY - _swY;
    if(Math.abs(dy) > Math.abs(dx)) _swActive = false;
  }, {passive:true});
  document.addEventListener('touchend', e=>{
    if(!_swActive || _swX===null) return;
    const dx = e.changedTouches[0].clientX - _swX;
    _swX = null; _swY = null; _swActive = false;
    if(Math.abs(dx) < 52) return;
    const curTab = document.querySelector('.page-tab.on');
    if(!curTab) return;
    const curPage = curTab.dataset.page;
    const curIdx = pages.indexOf(curPage);
    if(curIdx < 0) return;
    const nextIdx = dx < 0 ? Math.min(curIdx + 1, pages.length - 1) : Math.max(curIdx - 1, 0);
    if(nextIdx !== curIdx) switchPage(pages[nextIdx]);
  }, {passive:true});
})();

// ── 실시간 피드백 피드 갱신 ──
function updateFeedFromToc(tocArray){
  const feed=document.getElementById('regexFeed');
  const list=document.getElementById('regexFeedList');
  const badge=document.getElementById('detectBadge');
  const stat=document.getElementById('regexFeedStat');
  if(!feed) return;
  // ★ L-13 FIX: tocArray null/undefined 방어 — 피드 DOM 잔류 방지
  if(!tocArray || !Array.isArray(tocArray)){
    feed.style.display='none';
    return;
  }
  feed.style.display='';
  const total=tocArray?tocArray.length:0;
  // ★ FIX-07: getSuspThreshold() 사용 (DOM 슬라이더 실시간 반영)
  const suspThreshold = typeof getSuspThreshold==='function' ? getSuspThreshold() : 50;
  // ★ 글자수 집계 (bodyLen 기반)
  let totalChars = 0;
  if(total > 0){
    tocArray.forEach(c=>{
      const bl = typeof c.bodyLen === 'number' ? c.bodyLen : (c.body||'').replace(/\s/g,'').length;
      totalChars += bl;
    });
  }
  const avgChars = total > 0 ? Math.round(totalChars / total) : 0;
  const totalCharsStr = totalChars >= 10000
    ? (totalChars/10000).toFixed(1)+'만자'
    : totalChars.toLocaleString()+'자';
  const shortCount=total?tocArray.filter(c=>{
    const bl = typeof c.bodyLen === 'number' ? c.bodyLen : (c.body||'').replace(/\s/g,'').length;
    return bl > 0 && bl < suspThreshold;
  }).length:0;
  if(badge){
    badge.className='detect-badge'+(total===0?' zero':shortCount>0?' warn':'');
    badge.innerHTML=total>0
      ?`<span class="detect-badge-num">${total}</span>개 장 감지됨`
      :'감지된 챕터 없음';
  }
  if(list&&total>0){
    const preview=(tocArray||[]).slice(0,8);
    list.innerHTML=preview.map((ch,i)=>{
      const chars = typeof ch.bodyLen === 'number' ? ch.bodyLen : (ch.body||'').replace(/\s/g,'').length;
      const isShort=chars>0&&chars<suspThreshold;
      const badgeCls='feed-item-badge'+(isShort?' short':chars>0?' ok':'');
      const badgeTxt=chars>0?(isShort?`⚠ ${chars}자`:`${chars.toLocaleString()}자`):'';
      const prev=(ch.body||'').replace(/\n/g,' ').slice(0,60);
      const titleSafe=(ch.title||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
      const prevSafe=prev.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
      return `<div class="feed-item"><span class="feed-item-num">${i+1}</span><div class="feed-item-body"><div class="feed-item-title">${titleSafe}</div>${prevSafe?`<div class="feed-item-preview">${prevSafe}…</div>`:''}</div>${badgeTxt?`<span class="${badgeCls}">${badgeTxt}</span>`:''}</div>`;
    }).join('');
  }else if(list){
    list.innerHTML='<div class="regex-feed-empty"><div class="regex-feed-empty-icon">📄</div>패턴을 입력하거나 목차 확인을 눌러주세요</div>';
  }
  if(stat){
    // ★ 총글자수 · 평균 글자수 표시
    const charInfo = total > 0 ? `${totalCharsStr} · 평균 ${avgChars.toLocaleString()}자` : '';
    const shortInfo = shortCount > 0 ? ` · ⚠ 짧은챕터 ${shortCount}개(기준:${suspThreshold}자)` : '';
    if(total>8){
      stat.textContent = `1–8 / ${total}개 · ${charInfo}${shortInfo}`;
    } else if(total>0){
      stat.textContent = `총 ${total}개 · ${charInfo}${shortInfo}`;
    } else {
      stat.textContent = ' ';
    }
  }
}

// ══════════════════════════════════════════
// 🔍 Module: Encoding (EUC-KR/UTF-8 자동 감지)
// ══════════════════════════════════════════
// 마지막 감지된 인코딩 저장
