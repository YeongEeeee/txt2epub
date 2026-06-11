// ════════════════════════════════════════════════
// settings.js — CSS/Extra/사용자 설정, 프리셋, 폰트, 스킨, API, 히스토리, 알림, 텍스트표지
// NovelEPUB | TXT → EPUB3
//
// 의존성: core.js (Toast, SettingsDB, S, EventBus)
// ════════════════════════════════════════════════

/* global Toast, SettingsDB, S, B, EventBus, escHtml, escAttr,
   updateCssPreview, updateMiniReader, updateSettingsSummary, syncSelect,
   fileToAB */

'use strict';

// 🎨 Module: CssSettings (스타일 설정 관리)
// ══════════════════════════════════════════
// ★ S-01: saveCssSettings debounce — 슬라이더 드래그 등 연속 호출 시 300ms 후 1회만 실행
// 이전: 매 input 이벤트마다 JSON.stringify + localStorage.setItem → 메인 스레드 블로킹
let _saveCssTimer = null;
function saveCssSettings(){
  clearTimeout(_saveCssTimer);
  _saveCssTimer = setTimeout(_saveCssSettingsNow, 300);
}
function _saveCssSettingsNow(){
  try{
    // ★ DOM 캐싱: getElementById 반복 호출 최소화
    const _el=id=>document.getElementById(id);
    const indentSlider=_el('cssIndentSlider');
    localStorage.setItem('epub_css',JSON.stringify({
      font:     _el('cssFont')?.value,
      line:     _el('cssLine')?.value,
      size:     _el('cssFontSize')?.value,
      padTop:   _el('cssPadTop')?.value||'1.5',
      padBottom:_el('cssPadBottom')?.value||'1.5',
      padLeft:  _el('cssPadLeft')?.value||'1.8',
      padRight: _el('cssPadRight')?.value||'1.8',
      textColor:_el('cssTextColor')?.value||'',
      bgColor:  _el('cssBgColor')?.value||'',
      align:    document.querySelector('input[name="cssAlign"]:checked')?.value||'justify',
      titleStyle:document.querySelector('input[name="cssTitleStyle"]:checked')?.value||'center',
      indentEm: indentSlider?parseFloat(indentSlider.value):1.0,
      extra:    _el('cssExtra')?.value||'',
    }));
  }catch(e){}
}

function saveExtraSettings(){
  try{
    localStorage.setItem('epub_extra',JSON.stringify({
      emptyLine:document.getElementById('optEmptyLine')?.checked,
      // ★ Part2: 본문 공백 최적화 플래그 (3줄+ 연속 공백 → 최대 1줄 압축)
      removeBlankLines:document.getElementById('optRemoveBlankLines')?.checked ?? false,
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

// ★ API 키 저장/로드 (Gemini, Naver)
function saveApiSettings(){
  try{
    const gemini=(document.getElementById('geminiApiKey')?.value||'').trim();
    const naverId=(document.getElementById('naverClientId')?.value||'').trim();
    const naverSecret=(document.getElementById('naverClientSecret')?.value||'').trim();
    localStorage.setItem('novelepub_api',JSON.stringify({gemini,naverId,naverSecret}));
  }catch(e){}
}
function loadApiSettings(){
  try{
    const s=JSON.parse(localStorage.getItem('novelepub_api')||'{}');
    if(s.gemini){ const el=document.getElementById('geminiApiKey'); if(el) el.value=s.gemini; }
    if(s.naverId){ const el=document.getElementById('naverClientId'); if(el) el.value=s.naverId; }
    if(s.naverSecret){ const el=document.getElementById('naverClientSecret'); if(el) el.value=s.naverSecret; }
  }catch(e){}
}

function loadExtraSettings(){
  try{
    const s=JSON.parse(localStorage.getItem('epub_extra')||'{}');
    if(s.emptyLine!=null){ const _elEL=document.getElementById('optEmptyLine'); if(_elEL) _elEL.checked=s.emptyLine; }
    // ★ Part2: 본문 공백 최적화 플래그 복원
    if(s.removeBlankLines!=null){
      const _elRB=document.getElementById('optRemoveBlankLines');
      if(_elRB) _elRB.checked=s.removeBlankLines;
      // StateManager에 동기화 (S가 정의된 경우)
      if(typeof S!=='undefined' && S && typeof S.settings !== 'undefined'){
        S.settings = S.settings || {};
        S.settings.removeBlankLines = !!s.removeBlankLines;
      }
    }
    if(s.chTitle!=null){ const _elCT=document.getElementById('optChTitle'); if(_elCT) _elCT.checked=s.chTitle; }
    if(s.darkCover!=null){ const _elDC=document.getElementById('optDarkCover'); if(_elDC) _elDC.checked=s.darkCover; }
    if(s.autoPreview!=null){ const _elAP=document.getElementById('optAutoPreview'); if(_elAP) _elAP.checked=s.autoPreview; }
    if(s.showLineNum!=null){ const _elSL=document.getElementById('optShowLineNum'); if(_elSL) _elSL.checked=s.showLineNum; }
    if(s.italic!=null){ const _elIt=document.getElementById('optItalic'); if(_elIt) _elIt.checked=s.italic; }
    if(s.indent!=null){ const _elIn=document.getElementById('optIndent'); if(_elIn) _elIn.checked=s.indent; }
    if(s.imgConvert!=null&&document.getElementById('optImgConvert')) document.getElementById('optImgConvert').checked=s.imgConvert;
    if(s.imgQuality&&document.getElementById('optImgQuality')){
      const _elIQ=document.getElementById('optImgQuality'); if(_elIQ) _elIQ.value=s.imgQuality;
      const vl=document.getElementById('optImgQualityVal');
      if(vl) vl.textContent=s.imgQuality+'%';
    }
    if(s.defaultPat){ const _elDP=document.getElementById('optDefaultPat'); if(_elDP) _elDP.value=s.defaultPat; }
    if(s.lang){ const _elLg=document.getElementById('optLang'); if(_elLg) _elLg.value=s.lang; }
    if(s.publisher){ const _elPb=document.getElementById('optPublisher'); if(_elPb) _elPb.value=s.publisher; }
    if(s.compression){ const _elCp=document.getElementById('optCompression'); if(_elCp) _elCp.value=s.compression; }
    if(s.defaultPat){ const _elPt2=document.getElementById('pattern'); if(_elPt2) _elPt2.value=s.defaultPat; }
  }catch(e){}
}

async function resetAllSettings(){
  if(!await Toast.confirm('모든 설정을 초기화할까요?')) return;
  localStorage.removeItem('epub_css');
  localStorage.removeItem('epub_extra');
  location.reload();
}

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
    // ★ cssMargin → 4방향 여백 복원
    const padMap=[['cssPadTop','cssPadTopSlider',saved.padTop,'1.5'],['cssPadBottom','cssPadBottomSlider',saved.padBottom,'1.5'],['cssPadLeft','cssPadLeftSlider',saved.padLeft,'1.8'],['cssPadRight','cssPadRightSlider',saved.padRight,'1.8']];
    for(const[numId,sliderId,val,def]of padMap){
      const v=val||def;
      const n=document.getElementById(numId),s=document.getElementById(sliderId);
      if(n)n.value=v; if(s)s.value=v;
    }
    if(saved.textColor&&document.getElementById('cssTextColor'))document.getElementById('cssTextColor').value=saved.textColor;
    if(saved.bgColor&&document.getElementById('cssBgColor'))document.getElementById('cssBgColor').value=saved.bgColor;
    if(saved.align){const r=document.querySelector('input[name="cssAlign"][value="'+saved.align+'"]');if(r)r.checked=true;}
    if(saved.titleStyle){const r=document.querySelector('input[name="cssTitleStyle"][value="'+saved.titleStyle+'"]');if(r)r.checked=true;}
    if(saved.indentEm!=null){
      const sl=document.getElementById('cssIndentSlider'),vl=document.getElementById('cssIndentVal');
      if(sl)sl.value=saved.indentEm;
      if(vl)vl.textContent=parseFloat(saved.indentEm).toFixed(1)+'em';
      // ★ BUG-26 수정: syncIndent 명시 호출로 슬라이더 완전 동기화
      typeof syncIndent==='function'&&syncIndent(saved.indentEm);
    }
    if(saved.extra&&document.getElementById('cssExtra'))document.getElementById('cssExtra').value=saved.extra;
    updateCssPreview();
    updateMiniReader&&updateMiniReader();
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
  if(tc)tc.value=getCssVar('--text')||'#2d1f14';if(bc)bc.value=getCssVar('--bg')||'#fdf6ee';
  updateCssPreview();saveCssSettings();
}

// updateCssPreview — ui-state.js에 정의 (중복 방지, settings.js에서 typeof 체크로 호출)
// function updateCssPreview() → ui-state.js:79

const CSS_PRESETS_KEY='novelepub_css_presets';
const CSS_PRESET_DEFAULTS=[
  {name:'웹소설 기본', font:'"Noto Serif KR",serif', line:'1.9', size:'1em', padTop:'1.5', padBottom:'1.5', padLeft:'1.8', padRight:'1.8'},
  {name:'라이트 노벨',  font:'"Noto Sans KR",sans-serif', line:'2.0', size:'0.9em', padTop:'1.2', padBottom:'1.2', padLeft:'1.5', padRight:'1.5'},
  {name:'넓은 여백',    font:'"Gowun Batang",serif', line:'2.2', size:'1em', padTop:'2.5', padBottom:'2.5', padLeft:'2.8', padRight:'2.8'},
  {name:'좁은 여백',    font:'"Nanum Gothic",sans-serif', line:'1.7', size:'0.95em', padTop:'0.8', padBottom:'0.8', padLeft:'1.0', padRight:'1.0'},
];

function loadCssPresets(){
  try{ return JSON.parse(localStorage.getItem(CSS_PRESETS_KEY)||'[]'); }
  catch(e){ return []; }
}
function saveCssPresets(presets){
  try{ localStorage.setItem(CSS_PRESETS_KEY, JSON.stringify(presets)); }
  catch(e){}
}

function saveCurrentAsPreset(){
  const name=prompt('프리셋 이름을 입력하세요:','');
  if(!name||!name.trim()) return;
  const preset={
    name:name.trim(),
    font:  document.getElementById('cssFont')?.value||'"Noto Serif KR",serif',
    line:  document.getElementById('cssLine')?.value||'1.9',
    size:  document.getElementById('cssFontSize')?.value||'1em',
    padTop:   document.getElementById('cssPadTop')?.value||'1.5',
    padBottom:document.getElementById('cssPadBottom')?.value||'1.5',
    padLeft:  document.getElementById('cssPadLeft')?.value||'1.8',
    padRight: document.getElementById('cssPadRight')?.value||'1.8',
    textColor:document.getElementById('cssTextColor')?.value||'',
    bgColor:  document.getElementById('cssBgColor')?.value||'',
    align:    document.querySelector('input[name="cssAlign"]:checked')?.value||'justify',
    titleStyle:document.querySelector('input[name="cssTitleStyle"]:checked')?.value||'center',
  };
  const presets=loadCssPresets();
  // 같은 이름 있으면 덮어쓰기
  const existing=presets.findIndex(p=>p.name===preset.name);
  if(existing>=0) presets[existing]=preset;
  else presets.unshift(preset);
  saveCssPresets(presets);
  renderCssPresetList();
  Toast.success(`프리셋 "${preset.name}" 저장됨`);
}

function applyPreset(preset){
  // 폰트
  const fontSel=document.getElementById('cssFont');
  if(fontSel&&preset.font) fontSel.value=preset.font;
  // 줄간격
  const lineSel=document.getElementById('cssLine');
  if(lineSel&&preset.line){
    lineSel.value=preset.line;
    syncSelect('cssLine','cssLineSlider','cssLineVal',preset.line);
  }
  // 글자크기
  const sizeSel=document.getElementById('cssFontSize');
  if(sizeSel&&preset.size){
    sizeSel.value=preset.size;
    const n=parseFloat(preset.size);
    const sl=document.getElementById('cssFontSizeSlider'),vl=document.getElementById('cssFontSizeVal');
    if(sl)sl.value=n; if(vl)vl.textContent=n.toFixed(2).replace(/\.?0+$/,'')+'em';
  }
  // 4방향 여백
  [['cssPadTop','cssPadTopSlider',preset.padTop],
   ['cssPadBottom','cssPadBottomSlider',preset.padBottom],
   ['cssPadLeft','cssPadLeftSlider',preset.padLeft],
   ['cssPadRight','cssPadRightSlider',preset.padRight]
  ].forEach(([nid,sid,v])=>{
    if(!v) return;
    const n=document.getElementById(nid),s=document.getElementById(sid);
    if(n)n.value=v; if(s)s.value=v;
  });
  // 색상
  if(preset.textColor!==undefined){const el=document.getElementById('cssTextColor');if(el)el.value=preset.textColor;}
  if(preset.bgColor!==undefined){const el=document.getElementById('cssBgColor');if(el)el.value=preset.bgColor;}
  // 정렬
  if(preset.align){const r=document.querySelector('input[name="cssAlign"][value="'+preset.align+'"]');if(r)r.checked=true;}
  if(preset.titleStyle){const r=document.querySelector('input[name="cssTitleStyle"][value="'+preset.titleStyle+'"]');if(r)r.checked=true;}

  updateFontPreview();
  updateCssPreview&&updateCssPreview();
  saveCssSettings();
  Toast.success(`"${preset.name}" 적용됨`);
}

function deletePreset(name){
  const presets=loadCssPresets().filter(p=>p.name!==name);
  saveCssPresets(presets);
  renderCssPresetList();
}

function renderCssPresetList(){
  const container=document.getElementById('cssPresetList');
  if(!container) return;
  const userPresets=loadCssPresets();
  const all=[...CSS_PRESET_DEFAULTS,...userPresets];
  container.innerHTML='';
  if(!all.length){
    container.innerHTML='<span style="font-size:11px;color:var(--text2)">저장된 프리셋 없음</span>';
    return;
  }
  all.forEach((p,idx)=>{
    const isDefault=idx<CSS_PRESET_DEFAULTS.length;
    const chip=document.createElement('div');
    chip.className='preset-chip';
    chip.title=`폰트: ${p.font}\n줄간격: ${p.line}\n여백: ${p.padTop||'1.5'}/${p.padLeft||'1.8'}em`;
    chip.innerHTML=
      `<span>${escHtml(p.name)}</span>`+
      (isDefault?'':'<button class="preset-del" onclick="deletePreset(\''+escAttr(p.name)+'\')" title="삭제">✕</button>');
    chip.querySelector('span').addEventListener('click',()=>applyPreset(p));
    container.appendChild(chip);
  });
}
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
  if(!selects||!selects.length) return; // guard: DOM 없으면 조용히 반환
  selects.forEach(sel=>{
    if(!sel) return;
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
      // 4방향 여백
      padTop:      document.getElementById('cssPadTop')?.value||'1.5',
      padBottom:   document.getElementById('cssPadBottom')?.value||'1.5',
      padLeft:     document.getElementById('cssPadLeft')?.value||'1.8',
      padRight:    document.getElementById('cssPadRight')?.value||'1.8',
      // ★ 텍스트 정렬·챕터 제목 스타일 (라디오 복원용)
      cssAlign:    document.querySelector('input[name="cssAlign"]:checked')?.value||'justify',
      cssTitleStyle: document.querySelector('input[name="cssTitleStyle"]:checked')?.value||'center',
      // 색상
      textColor:   document.getElementById('cssTextColor')?.value||'',
      bgColor:     document.getElementById('cssBgColor')?.value||'',
      // 슬라이더 값
      indentEm:    document.getElementById('cssIndentSlider')?.value||'1.0',
      // 테마/옵션
      dark:        document.documentElement.dataset.theme==='dark',
      italic:      document.getElementById('optItalic')?.checked??true,
      indent:      document.getElementById('optIndent')?.checked??true,
      mergePara:   document.getElementById('optMergeShortLines')?.checked??false,
    };
    localStorage.setItem('novelepub_prefs', JSON.stringify(prefs));
  }catch(e){}
}

// 저장된 설정 복원
function loadUserPrefs(){
  // ★ novelepub_prefs에서 복원 (슬라이더·레이블·라디오 완전 동기화)
  try{
    const raw=localStorage.getItem('novelepub_prefs');
    if(!raw) return;
    const p=JSON.parse(raw);

    // ── 폰트 ──
    if(p.font){
      const el=document.getElementById('cssFont');
      if(el) el.value=p.font;
    }

    // ── 글자 크기 (select + 슬라이더 + 레이블 span 동기화) ──
    if(p.size){
      const numVal=parseFloat(p.size)||1.0;
      const sel=document.getElementById('cssFontSize');
      const sl =document.getElementById('cssFontSizeSlider');
      const vl =document.getElementById('cssFontSizeVal');
      if(sel) sel.value=p.size;
      if(sl)  sl.value=numVal;
      if(vl)  vl.textContent=numVal.toFixed(2).replace(/\.?0+$/,'')+'em';
    }

    // ── 줄간격 (select + 슬라이더 + 레이블 span 동기화) ──
    if(p.line){
      const numVal=parseFloat(p.line)||1.9;
      const sel=document.getElementById('cssLine');
      const sl =document.getElementById('cssLineSlider');
      const vl =document.getElementById('cssLineVal');
      if(sel) sel.value=p.line;
      if(sl)  sl.value=numVal;
      if(vl)  vl.textContent=numVal.toFixed(1);
    }

    // ── 4방향 여백 (숫자 input + 슬라이더 동기화) ──
    const padMap=[
      ['cssPadTop',    'cssPadTopSlider',    p.padTop,    '1.5'],
      ['cssPadBottom', 'cssPadBottomSlider', p.padBottom, '1.5'],
      ['cssPadLeft',   'cssPadLeftSlider',   p.padLeft,   '1.8'],
      ['cssPadRight',  'cssPadRightSlider',  p.padRight,  '1.8'],
    ];
    for(const [numId, sliderId, val, def] of padMap){
      const v=String(val||def);
      const numEl  =document.getElementById(numId);
      const slideEl=document.getElementById(sliderId);
      if(numEl)   numEl.value=v;
      if(slideEl) slideEl.value=parseFloat(v)||parseFloat(def);
    }

    // ── 들여쓰기 슬라이더 + 레이블 ──
    if(p.indentEm!=null){
      const sl=document.getElementById('cssIndentSlider');
      const vl=document.getElementById('cssIndentVal');
      if(sl) sl.value=p.indentEm;
      if(vl) vl.textContent=parseFloat(p.indentEm).toFixed(1)+'em';
    }

    // ── 텍스트 정렬 라디오버튼 복원 ──
    if(p.cssAlign){
      const r=document.querySelector(`input[name="cssAlign"][value="${p.cssAlign}"]`);
      if(r) r.checked=true;
    }

    // ── 챕터 제목 스타일 라디오버튼 복원 ──
    if(p.cssTitleStyle){
      const r=document.querySelector(`input[name="cssTitleStyle"][value="${p.cssTitleStyle}"]`);
      if(r) r.checked=true;
    }

    // ── 텍스트/배경 색상 ──
    if(p.textColor){ const el=document.getElementById('cssTextColor'); if(el) el.value=p.textColor; }
    if(p.bgColor){   const el=document.getElementById('cssBgColor');   if(el) el.value=p.bgColor; }

    // ── 다크모드 ──
    if(p.dark===true){
      document.documentElement.dataset.theme='dark';
      const btn=document.getElementById('themeBtn');
      if(btn) btn.textContent='☀️';
    }

    // ── 토글 옵션 ──
    if(p.italic!=null){   const el=document.getElementById('optItalic');          if(el) el.checked=p.italic; }
    if(p.indent!=null){   const el=document.getElementById('optIndent');          if(el) el.checked=p.indent; }
    if(p.mergePara!=null){ const el=document.getElementById('optMergeShortLines'); if(el) el.checked=p.mergePara; }

    // ── 폰트 프리뷰 + CSS 미리보기 갱신 ──
    updateFontPreview&&updateFontPreview();
    updateCssPreview&&updateCssPreview();
    // ★ BUG-11 수정: loadUserPrefs 후 saveCssSettings 호출하여 설정 동기화
    saveCssSettings&&saveCssSettings();
  }catch(e){}
}

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
          // ★ L-07 FIX: modelId 특수문자 이스케이프 + \s 올바른 정규식 처리
          (()=>{ const safeId=modelId.replace(/[-.*+?^${}()|[\]\\]/g,'\\$&'); return errMsg.match(new RegExp('model:\\s*'+safeId)); })());

      if(isHardLimit){
        // 재시도해도 의미 없음 → 즉시 다음 모델로
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
        return {ok:false,fatal:false,msg:'quota_exceeded',model:modelId};
      }

      const waitMs=Math.min(baseWait, 30000); // 최대 30초 대기
      await new Promise(r=>setTimeout(r,waitMs));
      continue; // 같은 모델 재시도
    }

    // 404: 모델 없음 → 다음 모델
    if(status===404) return {ok:false,fatal:false,msg:'model_not_found'};

    // 500/503: 서버 오류 → 짧게 대기 후 재시도
    if(status>=500&&attempt<maxRetries){
      const waitMs=1000*(attempt+1);
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
      // ★ L-10: 다른 탭에서 버전 업 요청 시 현재 연결 닫기
      db.onversionchange=()=>{ db.close(); _histDB=null; };
    };
    req.onsuccess=e=>{
      _histDB=e.target.result;
      // ★ L-10: 연결 후에도 versionchange 핸들러 등록
      _histDB.onversionchange=()=>{ _histDB.close(); _histDB=null; };
      res(_histDB);
    };
    req.onerror=()=>rej(req.error);
    // ★ L-10 FIX: onblocked 핸들러 추가 — 다른 탭이 DB를 열고 있으면 reject
    req.onblocked=()=>{
      console.warn('NovelEPUB: IDB open blocked by another tab');
      rej(new Error('IDB blocked by another tab'));
    };
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
  }catch(e){return null;}
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
  const key='hist_'+(typeof crypto!=='undefined'&&crypto.randomUUID?crypto.randomUUID():Date.now());
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
  let metas=loadHistMetas();
  if(!metas.length){
    c.innerHTML='<div class="hist-empty">📭 아직 변환 기록이 없어요.<br>TXT→EPUB 탭에서 변환하면 여기에 저장돼요.</div>';
    return;
  }

  // ★ ADD-07: 별표 상태 로드
  let _starred = {};
  try{ _starred = JSON.parse(localStorage.getItem('novelepub_hist_starred')||'{}'); }catch(e){}

  // ★ B-05: 정렬 옵션 적용
  const sortKey = document.getElementById('histSortSel')?.value || 'newest';
  if(sortKey==='oldest')      metas=[...metas].reverse();
  else if(sortKey==='size')   metas=[...metas].sort((a,b)=>parseFloat(b.sizeMB)-parseFloat(a.sizeMB));
  else if(sortKey==='chapters') metas=[...metas].sort((a,b)=>b.chapterCount-a.chapterCount);

  // ★ ADD-07: 별표 항목 상단 고정
  metas = [
    ...metas.filter(m=>_starred[m.key]),
    ...metas.filter(m=>!_starred[m.key]),
  ];

  c.innerHTML='<div style="text-align:center;padding:12px 0;font-size:11px;color:var(--text2)">⏳ 로딩 중...</div>';
  const blobExists=await Promise.all(metas.map(m=>idbGet(m.key).then(b=>!!b).catch(()=>false)));
  c.innerHTML='';

  // ★ 이전 변환 대비 비교 배지 생성
  function _compareBadge(cur, prev){
    if(!prev) return '';
    const parts=[];
    const chDiff=cur.chapterCount-prev.chapterCount;
    if(chDiff!==0){
      const sign=chDiff>0?'+':'';
      const color=chDiff>0?'var(--green)':'var(--accent)';
      parts.push(`<span style="color:${color};font-weight:600">${sign}${chDiff}화</span>`);
    }
    const sizeDiff=(parseFloat(cur.sizeMB)-parseFloat(prev.sizeMB)).toFixed(1);
    if(Math.abs(parseFloat(sizeDiff))>=0.1){
      const sign=parseFloat(sizeDiff)>0?'+':'';
      parts.push(`<span style="color:var(--text2)">${sign}${sizeDiff}MB</span>`);
    }
    if(!parts.length) return '';
    return `<span class="hist-compare-badge" title="이전 변환 대비">${parts.join(' / ')}</span>`;
  }

  // 같은 제목 기준으로 이전 변환 찾기
  metas.forEach((m,idx)=>{
    const row=document.createElement('div');
    const isStarred = !!_starred[m.key];
    row.className='hist-item'+(isStarred?' starred-item':'');
    const hasBlob=blobExists[idx];
    // 같은 제목의 이전 기록 찾기 (현재 항목 제외, 오래된 순 첫 번째)
    const prevSameTitle=metas.slice(idx+1).find(p=>p.title===m.title);
    const compareBadge=_compareBadge(m, prevSameTitle);

    // ★ ADD-07: 별표 버튼
    const starBtn = document.createElement('button');
    starBtn.className = 'hist-star' + (isStarred?' starred':'');
    starBtn.title = isStarred ? '별표 해제' : '별표 (상단 고정)';
    starBtn.textContent = isStarred ? '★' : '☆';
    starBtn.addEventListener('click', e=>{
      e.stopPropagation();
      if(_starred[m.key]) delete _starred[m.key];
      else _starred[m.key] = true;
      try{ localStorage.setItem('novelepub_hist_starred', JSON.stringify(_starred)); }catch(ex){}
      renderHistory();
    });

    // ★ XSS 방지: IndexedDB에서 읽어온 메타 데이터 전체 이스케이프
    // m.title/author는 이미 escHtml, m.date/chapterCount 등 숫자도 방어적 처리
    const safeDate       = escHtml(String(m.date||''));
    const safeChCount    = escHtml(String(m.chapterCount||''));
    const safeSizeMB     = escHtml(String(m.sizeMB||''));
    const safeElapsed    = escHtml(String(m.elapsed||''));
    const safeKey        = escAttr(String(m.key||''));
    const safeName       = escAttr(String(m.name||''));
    // compareBadge는 내부 로직이 생성한 HTML — 이미 escHtml 처리된 상태
    row.innerHTML=
      '<div class="hist-thumb">📚</div>'+
      '<div class="hist-info">'+
        '<div class="hist-title">'+escHtml(m.title)+(m.author?'<span style="font-weight:400;color:var(--text2);font-size:11px"> / '+escHtml(m.author)+'</span>':'')+(compareBadge?' '+compareBadge:'')+'</div>'+
        '<div class="hist-meta">'+safeDate+' · '+safeChCount+'화 · '+safeSizeMB+'MB · '+safeElapsed+'초</div>'+
      '</div>'+
      (hasBlob
        ?'<button class="btn btn-green btn-sm" data-action="histDownload" data-key="'+safeKey+'" data-name="'+safeName+'">⬇ 다운로드</button>'
        :'<span style="font-size:11px;color:var(--text2);white-space:nowrap">파일 없음</span>')+
      '<button class="hist-del" data-action="deleteHistory" data-key="'+safeKey+'" title="기록 삭제">✕</button>';
    row.insertBefore(starBtn, row.firstChild);
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
const SETTINGS_SCHEMA_VERSION = 3;

// ★ U-18: 구버전 설정 JSON 마이그레이션 함수
function _migrateSettings(data){
  const ver = parseInt(data._version) || 1;
  // v1 → v2: 단일 key 구조에서 novelepub_ prefix 키 구조로 전환
  if(ver < 2){
    if(data.cssFont)       { try{ const d=JSON.parse(localStorage.getItem('novelepub_css')||'{}'); d.cssFont=data.cssFont; data.novelepub_css=JSON.stringify(d); }catch(e){} }
    if(data.optItalic!==undefined){ try{ const d=JSON.parse(localStorage.getItem('novelepub_extras')||'{}'); d.optItalic=data.optItalic; data.novelepub_extras=JSON.stringify(d); }catch(e){} }
  }
  // v2 → v3: _exported 필드 추가 (자동 처리됨, 별도 마이그 불필요)
  return data;
}

function exportSettings(){
  // ★ BUG-15 수정: API 키(*_api*) 포함 항목 제외, epub_css/epub_extra 추가
  const EXPORT_KEYS = [
    'novelepub_css','novelepub_extras','novelepub_prefs',
    'novelepub_susp_threshold','novelepub_skin','novelepub_theme',
    'novelepub_css_presets',
    'epub_css','epub_extra',
  ];
  // ★ U-18: 버전 및 내보낸 날짜 포함
  const data = { _version: SETTINGS_SCHEMA_VERSION, _exported: new Date().toISOString() };
  EXPORT_KEYS.forEach(k => {
    // API 키가 포함된 키는 제외
    if(k.includes('_api') || k.includes('api_')) return;
    try{ const v = localStorage.getItem(k); if(v !== null) data[k] = v; }catch(e){}
  });
  const blob = new Blob([JSON.stringify(data, null, 2)], {type:'application/json'});
  const url  = URL.createObjectURL(blob);
  const a    = document.createElement('a');
  a.href = url;
  a.download = 'novelepub-settings-' + new Date().toISOString().slice(0,10) + '.json';
  a.click();
  setTimeout(()=>URL.revokeObjectURL(url), 1000);
  Toast.success('설정을 JSON 파일로 내보냈어요.');
}

function importSettingsBtn(){
  document.getElementById('settingsImportIn')?.click();
}

// settingsImportIn onchange는 DOMContentLoaded 후 연결
document.addEventListener('DOMContentLoaded', ()=>{
  document.getElementById('settingsImportIn')?.addEventListener('change', async e=>{
    const file = e.target.files?.[0];
    if(!file) return;
    try{
      const text = await file.text();
      let data = JSON.parse(text);
      if(!data._version) throw new Error('유효하지 않은 설정 파일이에요.');
      // ★ U-18: 구버전 JSON 마이그레이션
      data = _migrateSettings(data);
      let count = 0;
      Object.keys(data).forEach(k=>{
        if(k.startsWith('_')) return;
        try{ localStorage.setItem(k, data[k]); count++; }catch(ex){}
      });
      e.target.value = '';
      Toast.success(`설정 ${count}개를 불러왔어요. 페이지를 새로고침하면 완전히 적용돼요.`);
      // 즉시 적용 가능한 것만 적용
      loadCssSettings&&loadCssSettings();
      loadExtraSettings&&loadExtraSettings();
      updateSettingsSummary&&updateSettingsSummary();
      updateMiniReader&&updateMiniReader();
    }catch(err){
      Toast.error('설정 파일 가져오기 실패: ' + (err.message||'알 수 없는 오류'));
    }
  });
});

// ══════════════════════════════════════════
// ★ ADD-09: 표지 자동 생성 (Canvas 기반)
// ══════════════════════════════════════════
// generateTextCover는 이미 main.js에 구현되어 있으면 그걸 사용
// 없으면 아래 기본 구현 사용
if(typeof generateTextCover === 'undefined'){
  window.generateTextCover = async function(title, author, preset=0){
    const gradients = [
      ['#2d1f14','#5a3a22'],  // 0: 워밍 브라운
      ['#0a1628','#1a3a5c'],  // 1: 딥 네이비
      ['#1a2810','#3a5a1a'],  // 2: 포레스트 그린
    ];
    const [c1,c2] = gradients[preset % gradients.length];
    const W=300, H=450;
    const canvas = document.createElement('canvas');
    canvas.width=W; canvas.height=H;
    const ctx = canvas.getContext('2d');
    const grad = ctx.createLinearGradient(0,0,W,H);
    grad.addColorStop(0, c1); grad.addColorStop(1, c2);
    ctx.fillStyle = grad;
    ctx.fillRect(0,0,W,H);
    // 장식선
    ctx.strokeStyle = 'rgba(255,255,255,0.15)';
    ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(20,20); ctx.lineTo(W-20,20);
    ctx.lineTo(W-20,H-20); ctx.lineTo(20,H-20); ctx.closePath(); ctx.stroke();
    // 제목
    ctx.fillStyle = '#ffffff';
    ctx.font = `bold ${Math.min(28, Math.floor(W*0.08))}px 'Noto Serif KR', serif`;
    ctx.textAlign = 'center';
    const maxW = W-60;
    // 긴 제목 자동 줄바꿈
    const words = [...title];
    let line='', lines=[], y=H*0.42;
    for(const ch of words){
      const test=line+ch;
      if(ctx.measureText(test).width > maxW && line){
        lines.push(line); line=ch;
      } else { line=test; }
    }
    if(line) lines.push(line);
    const lineH = 38;
    const startY = y - ((lines.length-1)*lineH)/2;
    lines.forEach((l,i)=>ctx.fillText(l, W/2, startY + i*lineH));
    // 작가명
    if(author){
      ctx.font = `${Math.min(18,Math.floor(W*0.056))}px 'Noto Serif KR', serif`;
      ctx.fillStyle = 'rgba(255,255,255,0.75)';
      ctx.fillText(author, W/2, startY + lines.length*lineH + 20);
    }
    return new Promise(res=>canvas.toBlob(b=>res(b), 'image/jpeg', 0.92));
  };
}

// ══════════════════════════════════════════
// ★ ADD-10: 변환 완료 브라우저 알림
// ══════════════════════════════════════════
const _notifKey = 'novelepub_notification';

function _initNotifStatus(){
  const chk   = document.getElementById('optNotification');
  const status= document.getElementById('notifStatus');
  if(!chk||!status) return;
  const perm = typeof Notification !== 'undefined' ? Notification.permission : 'unsupported';
  const saved = localStorage.getItem(_notifKey) === 'true';
  if(perm === 'unsupported'){
    status.textContent = '미지원 브라우저';
    chk.disabled = true; return;
  }
  if(perm === 'granted'){
    status.textContent = '허용됨'; status.className = 'granted';
    chk.checked = saved;
  } else if(perm === 'denied'){
    status.textContent = '차단됨'; status.className = 'denied';
    chk.checked = false; chk.disabled = true;
  } else {
    status.textContent = '미설정';
    chk.checked = false;
  }
}

document.addEventListener('DOMContentLoaded', ()=>{
  _initNotifStatus();
});

function _sendConvertNotif(title, chapterCount){
  try{
    const enabled = localStorage.getItem(_notifKey) === 'true';
    if(!enabled) return;
    if(typeof Notification === 'undefined' || Notification.permission !== 'granted') return;
    // ★ BUG-20 수정: visibilityState + hasFocus() 모두 체크
    if(document.visibilityState === 'visible' && document.hasFocus()) return;
    new Notification('📚 NovelEPUB 변환 완료', {
      body: `"${title}" (${chapterCount}화) EPUB 생성 완료`,
      icon: 'data:image/svg+xml,<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><text y="26" font-size="28">📚</text></svg>',
    });
  }catch(e){}
}

// ══════════════════════════════════════════
// 🔤 Module: CustomFont (커스텀 폰트 로드)
// ══════════════════════════════════════════
let customFontFile=null, customFontName='', customFontFace='';

async function handleCustomFont(files){
  const f=files[0];if(!f)return;
  customFontFile=f;
  const ext=f.name.split('.').pop().toLowerCase();
  const fontName=f.name.replace(/\.[^.]+$/,'');
  customFontName=fontName;
  // ★ BUG-10 수정: 청크 단위 base64 인코딩 (스택오버플로우 방지)
  const ab=await fileToAB(f);
  const bytes=new Uint8Array(ab);
  let b64=''; const CHUNK=8192;
  for(let i=0;i<bytes.length;i+=CHUNK) b64+=btoa(String.fromCharCode(...bytes.subarray(i,i+CHUNK)));
  const mimeMap={'ttf':'font/truetype','otf':'font/opentype','woff':'font/woff','woff2':'font/woff2'};
  const mime=mimeMap[ext]||'font/truetype';
  // ★ S-02: 이전 customFontFace(data-URL)가 있으면 새 값으로 덮어쓰기 전 명시적 초기화
  // data-URL은 ObjectURL이 아니므로 revokeObjectURL 불필요
  // 단, 대형 문자열이 메모리에 중복으로 잠기지 않도록 이전 참조를 null 처리 후 교체
  customFontFace = null;
  // ★ S-03: base64 인코딩 후 Uint8Array/ArrayBuffer 참조 즉시 해제 → GC 수거 유도
  // 커스텀 폰트 파일은 수 MB가 될 수 있음 — b64 변환 후 원본 버퍼 불필요
  bytes.fill(0); // 메모리 내용 초기화 (보안 + GC 힌트)
  customFontFace='@font-face{font-family:"'+fontName+'";src:url("data:'+mime+';base64,'+b64+'") format("'+ext+'");}\n';
  b64 = null; // ★ 이제 b64 문자열도 customFontFace에 이미 포함됨 — 중복 참조 해제
  SettingsDB.set('customFontFace', customFontFace).catch(()=>{});
  SettingsDB.set('customFontName', customFontName).catch(()=>{});
  const opt=document.getElementById('customFontOpt');
  if(opt){opt.textContent='📁 '+fontName;opt.style.display='';opt.value='"'+fontName+'",serif';}
  const cfEl=document.getElementById('cssFont');if(cfEl)cfEl.value='"'+fontName+'",serif';
  const fontInfoEl=document.getElementById('fontInfo');if(fontInfoEl)fontInfoEl.textContent='✅ '+f.name+' ('+(ab.byteLength/1024).toFixed(0)+'KB)';
  const fontDropEl=document.getElementById('fontDrop');if(fontDropEl)fontDropEl.classList.add('ok');
  typeof updateCssPreview==='function'&&updateCssPreview();
  typeof saveCssSettings==='function'&&saveCssSettings();
  typeof updateSettingsSummary==='function'&&updateSettingsSummary();
}
function setSkin(skinName){
  const skins = ['terracotta','indigo','forest'];
  const d = document.documentElement;
  if(skinName==='terracotta') d.removeAttribute('data-skin');
  else d.setAttribute('data-skin', skinName);
  // 스와치 active 상태 갱신
  skins.forEach(s=>{
    const sw = document.getElementById('skin-'+s);
    if(sw) sw.classList.toggle('active', s===skinName);
  });
  // ★ 헤더 그림자는 style.css의 [data-skin] .hdr 규칙이 담당 (하드코딩 제거)
  try{ localStorage.setItem('novelepub_skin', skinName); }catch(e){}
}
function initSkin(){
  try{
    const saved = localStorage.getItem('novelepub_skin')||'terracotta';
    setSkin(saved);
  }catch(e){}
}

// (setupSwipe는 ui-state.js에서 관리)
