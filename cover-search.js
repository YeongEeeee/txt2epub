// ════════════════════════════════════════════════
// cover-search.js — 표지 검색 모달, 플랫폼 어댑터, 프록시
// NovelEPUB | TXT → EPUB3
//
// 의존성: core.js (Toast, S, B)
// ════════════════════════════════════════════════

/* global Toast, S, B, escHtml, getCssVar */

'use strict';

// ══════════════════════════════════════════
// 🌐 Module: CoverSearch (표지 검색 모달)
// ══════════════════════════════════════════
let _coverModalMode='convert';
let _searchAbortCtrl=null;

// ── 검색용 순수 제목 추출 ──
function extractSearchTitle(raw) {
  let t = raw
    .replace(/\.txt$/i, '')
    .replace(/[\[\(\{][^\]\)\}]{0,20}[\]\)\}]/g, '')
    .replace(/^.+?@\s*/, '')
    .replace(/@.+$/, '')
    .replace(/^[^가-힣a-zA-Z\d]*[a-zA-Z\d가-힣]{1,10}[_\-]\s*/, '')
    .replace(/\s+/g, ' ')
    .trim();
  t = t.replace(/\s+\d+[-~]\d+[화편]?.*$/, '');
  t = t.replace(/\s+\d+[권부].*$/, '');
  t = t.replace(/\s*(?:완결?|완전판|전권|전편|번외|후일담|외전|특별판|최종화|연재중|연재|단행본|개정판|리마스터|무삭제|성인판).*$/i, '');
  t = t.replace(/,.*$/, '');
  t = t.replace(/\s*[\(\[\{].+$/, '');
  if(/^\d+$/.test(t.trim())) t=raw.replace(/\.txt$/i,'').trim();
  return t.trim() || raw.replace(/\.txt$/i,'').trim();
}

function openCoverModal(mode){
  _coverModalMode=mode;
  let q='';
  if(mode==='convert'){
    const titleInput=document.getElementById('title')?.value.trim()||'';
    if(titleInput){ q=extractSearchTitle(titleInput); }
    else if(S.txtFiles.length){ q=extractSearchTitle(S.txtFiles[0].name); }
  } else {
    const f=B.txtFiles[0];
    q=f ? extractSearchTitle(f.name) : '';
  }
  document.getElementById('coverSearchQ').value=q;
  document.getElementById('coverModal')?.classList.add('show');
  if(q) setTimeout(()=>runCoverSearch(),100);
  else document.getElementById('coverModalBody').innerHTML=
    '<div style="text-align:center;padding:40px 0;color:var(--text2);font-size:13px">소설 제목을 입력하고 검색하면<br>네이버·리디·카카오페이지·노벨피아·구글에서 동시 검색해요</div>';
}

function closeCoverModal(){
  document.getElementById('coverModal')?.classList.remove('show');
  document.body.style.overflow='';
  document.body.style.touchAction='';
  if(_searchAbortCtrl){_searchAbortCtrl.abort();_searchAbortCtrl=null;}
}

async function centerCropToBlob(src, targetW=800, targetH=1200, quality=0.92){
  return new Promise(resolve=>{
    const img=new Image();
    img.crossOrigin='anonymous';
    img.onload=()=>{
      const canvas=document.createElement('canvas');
      canvas.width=targetW; canvas.height=targetH;
      const ctx=canvas.getContext('2d');
      ctx.fillStyle=typeof getCssVar==='function'?getCssVar('--bg')||'#ffffff':'#ffffff';
      ctx.fillRect(0,0,targetW,targetH);
      const srcRatio=img.naturalWidth/img.naturalHeight;
      const tgtRatio=targetW/targetH;
      let sx,sy,sw,sh;
      if(srcRatio>tgtRatio){ sh=img.naturalHeight; sw=sh*tgtRatio; sx=(img.naturalWidth-sw)/2; sy=0; }
      else { sw=img.naturalWidth; sh=sw/tgtRatio; sx=0; sy=(img.naturalHeight-sh)/2; }
      ctx.drawImage(img,sx,sy,sw,sh,0,0,targetW,targetH);
      canvas.toBlob(blob=>{
        // ★ BUG-16 수정: null 체크
        resolve(blob||null);
      },'image/jpeg',quality);
    };
    img.onerror=()=>resolve(null);
    img.src=typeof src==='string'?src:URL.createObjectURL(src);
  });
}

async function applyCoverCard(url, title){
  const inpId=_coverModalMode==='convert'?'coverUrlInp':'batchCoverUrlInp';
  const thumbId=_coverModalMode==='convert'?'coverThumb':null;
  const nameId=_coverModalMode==='convert'?'coverName':null;
  try{
    const croppedBlob=await centerCropToBlob(url,800,1200,0.92);
    if(croppedBlob){
      const croppedUrl=URL.createObjectURL(croppedBlob);
      const inp=document.getElementById(inpId);
      if(inp) inp.value=croppedUrl;
      closeCoverModal();
      typeof applyCoverUrl==='function'&&await applyCoverUrl(inpId,thumbId,nameId,_coverModalMode);
      return;
    }
  }catch(e){}
  const inp=document.getElementById(inpId);
  if(inp) inp.value=url;
  closeCoverModal();
  typeof applyCoverUrl==='function'&&await applyCoverUrl(inpId,thumbId,nameId,_coverModalMode);
}

async function runCoverSearch(){
  const q=document.getElementById('coverSearchQ')?.value.trim();
  if(!q) return;
  if(_searchAbortCtrl){_searchAbortCtrl.abort();}
  _searchAbortCtrl=new AbortController();
  const signal=_searchAbortCtrl.signal;
  const PLATFORMS=Object.entries(CoverSearchAdapters).map(([id,a])=>({id,label:a.label,badge:a.badge,fn:a.fetch}));
  const body=document.getElementById('coverModalBody');
  const _esc=s=>(typeof escHtml==='function'?escHtml(String(s||'')):String(s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;'));
  body.innerHTML=PLATFORMS.map(p=>
    `<div class="cover-platform-sec" id="sec_${p.id}">
      <div class="cover-platform-hdr">
        <span class="cover-platform-label">${_esc(p.label)}</span>
        <span class="cover-platform-status" id="stat_${p.id}">검색 중...</span>
        <span class="cover-platform-spinner" id="spin_${p.id}">⏳</span>
      </div>
      <div class="cover-strip" id="strip_${p.id}">
        ${[0,1,2,3,4].map(()=>'<div style="width:90px;height:158px;background:var(--border);border-radius:8px;flex-shrink:0;animation:fadeUp .6s ease infinite alternate"></div>').join('')}
      </div>
    </div>`
  ).join('')+
  `<div id="cover-manual-area" style="margin-top:12px;border-top:1px solid var(--border);padding-top:10px">
    <div style="font-size:11px;font-weight:600;color:var(--text);margin-bottom:6px">🖼 직접 등록</div>
    <div style="display:flex;gap:6px;margin-bottom:8px">
      <input id="coverDirectUrl" class="inp" placeholder="이미지 URL 붙여넣기 (https://...)" style="font-size:11px;flex:1">
      <button class="btn btn-blue btn-sm" onclick="(async()=>{const u=document.getElementById('coverDirectUrl')?.value.trim();if(u)await applyCoverCard(u,'직접입력');})()" style="font-size:11px;white-space:nowrap">✅ 적용</button>
    </div>
    <div id="coverFileDrop"
         style="border:2px dashed var(--border);border-radius:8px;padding:14px;text-align:center;font-size:11px;color:var(--text2);cursor:pointer;transition:border-color .2s"
         ondragover="event.preventDefault();this.style.borderColor='var(--accent)'"
         ondragleave="this.style.borderColor='var(--border)'"
         ondrop="handleCoverFileDrop(event)"
         onclick="document.getElementById('coverFileInput')?.click()">
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
    ].map(([l,u])=>`<button class="platform-link" onclick="window.open('${u}','_blank')">${_esc(l)} ↗</button>`).join('')}
    <button class="platform-link" id="searchAbortBtn" style="margin-left:auto;color:var(--accent);border-color:var(--accent)" onclick="abortCoverSearch()">⛔ 중단</button>
  </div>`;

  // ★ BUG-10 수정: Promise.allSettled 방식으로 각 플랫폼 독립 처리
  PLATFORMS.forEach(p=>{
    if(signal.aborted) return;
    const fetchFn=p.fn;
    Promise.resolve().then(()=>fetchFn(q,signal)).then(items=>{
      if(signal.aborted) return;
      renderPlatformStrip(p.id,p.label,p.badge,q,items);
    }).catch(e=>{
      if(e?.name==='AbortError'||signal.aborted) return;
      renderPlatformFallback(p.id,p.label,q);
    });
  });
}

function abortCoverSearch(){
  if(_searchAbortCtrl){_searchAbortCtrl.abort();_searchAbortCtrl=null;}
  document.getElementById('searchAbortBtn')?.remove();
  document.querySelectorAll('.cover-platform-spinner').forEach(el=>el.style.display='none');
  document.querySelectorAll('.cover-platform-status').forEach(el=>{if(el.textContent==='검색 중...')el.textContent='중단됨';});
}

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
  typeof applyCoverUrl==='function'&&await applyCoverUrl(inpId,_coverModalMode==='convert'?'coverThumb':null,_coverModalMode==='convert'?'coverName':null,_coverModalMode);
}

function proxyImgUrl(originalUrl){
  if(!originalUrl) return '';
  const worker=PROXIES.find(p=>p.url.includes('workers.dev'));
  if(worker) return worker.url+encodeURIComponent(originalUrl);
  return originalUrl;
}

function imgError(el, originalUrl){
  if(el.dataset.retried==='1'){
    el.style.display='none';
    const ph=document.createElement('div');
    ph.style.cssText='width:90px;height:128px;background:var(--border);border-radius:4px;display:flex;align-items:center;justify-content:center;font-size:10px;color:var(--text2);text-align:center;padding:4px';
    ph.textContent='이미지\n없음';
    el.parentElement?.insertBefore(ph, el);
    return;
  }
  el.dataset.retried='1';
  el.src=originalUrl;
}

function renderPlatformStrip(id, label, badgeClass, q, items){
  const strip=document.getElementById('strip_'+id);
  const stat=document.getElementById('stat_'+id);
  const spin=document.getElementById('spin_'+id);
  if(!strip) return;
  if(spin) spin.style.display='none';
  const _esc=s=>(typeof escHtml==='function'?escHtml(String(s||'')):String(s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;'));
  if(!items||!items.length){
    if(stat) stat.textContent='결과 없음';
    strip.innerHTML=`<div class="cover-fallback">
      <span>직접 검색 →</span>
      <button onclick="window.open(getPlatformUrl('${id}','${_esc(q)}'),'_blank')">🌐 ${_esc(label)} 열기</button>
    </div>`;
    return;
  }
  if(stat) stat.textContent=items.length+'개';
  strip.innerHTML=items.map((item)=>{
    const rawUrl=item.image||'';
    const proxiedUrl=_esc(proxyImgUrl(rawUrl));
    const directUrl=_esc(rawUrl);
    const title=(item.title||'').replace(/'/g,"\\'").replace(/"/g,'&quot;');
    const titleHtml=_esc(item.title||'');
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
  const _esc=s=>(typeof escHtml==='function'?escHtml(String(s||'')):String(s||''));
  if(spin) spin.style.display='none';
  if(stat) stat.textContent='크롤링 실패';
  if(strip) strip.innerHTML=`<div class="cover-fallback">
    <span>사이트에서 직접 검색 후 이미지 URL 복사</span>
    <button onclick="window.open(getPlatformUrl('${id}','${_esc(q)}'),'_blank')">🌐 ${_esc(label)} 열기</button>
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
// 🌐 Module: CoverSearchAdapters + Proxies
// ══════════════════════════════════════════
const CoverSearchAdapters = {
  naver:    { label:'📗 네이버 시리즈',  badge:'badge-naver',    fetch: q=>fetchNaver(q) },
  ridi:     { label:'📘 리디북스',        badge:'badge-ridi',     fetch: q=>fetchRidi(q)  },
  kakao:    { label:'🟡 카카오페이지',    badge:'badge-kakao',    fetch: q=>fetchKakao(q) },
  novelpia: { label:'📙 노벨피아',         badge:'badge-novelpia', fetch: q=>fetchNovelpia(q) },
  google:   { label:'🌐 구글 이미지',     badge:'badge-google',   fetch: q=>fetchGoogle(q) },
};

const PROXIES=[
  {url:'https://icy-frog-a6c0.tlsxo213.workers.dev/?url=', type:'direct'},
  {url:'https://api.allorigins.win/get?url=',               type:'json'},
  {url:'https://corsproxy.io/?url=',                        type:'direct'},
  {url:'https://api.codetabs.com/v1/proxy?quest=',          type:'direct'},
];

async function _tryProxy(proxy, url, timeout){
  const res=await fetch(proxy.url+encodeURIComponent(url),{signal:AbortSignal.timeout(timeout)});
  if(!res.ok) return null;
  const text=await res.text();
  if(!text||text.length<30) return null;
  if(proxy.type==='json'){
    try{ const json=JSON.parse(text); if(json.contents!=null) return json.contents; return null; }
    catch(e){ return null; }
  }
  return text;
}

async function proxyFetch(url, timeout=9000){
  let lastErr;
  for(const proxy of PROXIES){
    try{ const html=await _tryProxy(proxy, url, timeout); if(html) return html; }
    catch(e){ lastErr=e; }
  }
  throw lastErr||new Error('모든 프록시 실패');
}

async function proxyPost(url, body, timeout=9000){
  const worker = PROXIES.find(p=>p.url.includes('workers.dev'));
  if(worker){
    try{
      const res=await fetch(worker.url+encodeURIComponent(url)+'&_method=POST&_body='+encodeURIComponent(body),{signal:AbortSignal.timeout(timeout)});
      if(res.ok){ const text=await res.text(); if(text&&text.length>10) return text; }
    }catch(e){}
  }
  try{
    const res=await fetch(url,{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded'},body,signal:AbortSignal.timeout(timeout)});
    if(res.ok) return await res.text();
  }catch(e){}
  throw new Error('POST 프록시 실패');
}

async function proxyFetchRace(url, timeout=9000){
  const promises=PROXIES.map(proxy=>_tryProxy(proxy, url, timeout).catch(()=>null));
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
  function isKakaoImg(src){
    if(!src||src.length<40) return false;
    const s=src.toLowerCase();
    if(s.includes('icon')||s.includes('logo')||s.includes('badge')||s.includes('profile')||s.includes('default')) return false;
    return s.includes('kakaocdn')||s.includes('dn-img-page.kakao')||s.includes('t1.kakaocdn')||s.includes('k.kakaocdn');
  }
  const worker=PROXIES.find(p=>p.url.includes('workers.dev'));
  if(worker){
    try{
      const body=JSON.stringify({
        operationName:'SearchContentByKeyword',
        query:`query SearchContentByKeyword($keyword:String!,$page:Int,$size:Int){searchByKeyword(keyword:$keyword,page:$page,size:$size,contentsType:NOVEL){count list{id title thumbnail singleThumbnailImage{url} horizontalThumbnail{url}}}}`,
        variables:{keyword:q, page:0, size:12}
      });
      const workerUrl=worker.url+encodeURIComponent('https://page.kakao.com/graphql')+'&_method=POST'+'&_body='+encodeURIComponent(body)+'&_h_Content-Type='+encodeURIComponent('application/json')+'&_h_Accept='+encodeURIComponent('application/json');
      const res=await fetch(workerUrl,{signal:AbortSignal.timeout(9000)});
      if(res.ok){
        const json=await res.json();
        const list=json?.data?.searchByKeyword?.list||json?.data?.searchContentByKeyword?.edges?.map(e=>e.node)||[];
        const items=list.map(n=>({title:n.title||q,image:n.thumbnail||(typeof n.thumbnail==='string'?n.thumbnail:'')||n.singleThumbnailImage?.url||n.horizontalThumbnail?.url||''})).filter(i=>i.image&&i.image.startsWith('http'));
        if(items.length) return items.slice(0,12);
      }
    }catch(e){}
  }
  try{
    const html=await proxyFetch('https://search.daum.net/search?w=book&q='+encodeURIComponent(q)+'&DA=LB2');
    const doc=new DOMParser().parseFromString(html,'text/html');
    const items=[];
    doc.querySelectorAll('a[href*="page.kakao"] img, a[href*="kakao"] img, .wrap_thmbnail img, .thumb_img img').forEach(img=>{
      const src=img.getAttribute('src')||img.getAttribute('data-original-src')||'';
      if(src&&src.startsWith('http')&&src.length>40&&!src.includes('icon')){
        const titleEl=img.closest('li,article,.item_book')?.querySelector('.tit_subject,.tit_item,strong,a[class*="tit"]');
        items.push({title:titleEl?.textContent?.trim()||img.alt||q, image:src});
      }
    });
    if(!items.length){ doc.querySelectorAll('img').forEach(img=>{ const src=img.getAttribute('src')||img.getAttribute('data-original-src')||''; if(isKakaoImg(src)) items.push({title:img.alt||q, image:src}); }); }
    if(items.length) return items.slice(0,12);
  }catch(e){}
  try{
    const html=await proxyFetch('https://search.daum.net/search?q='+encodeURIComponent(q+' 카카오페이지 소설')+'&DA=LB2');
    const doc=new DOMParser().parseFromString(html,'text/html');
    const items=[];
    doc.querySelectorAll('img').forEach(img=>{ const src=img.getAttribute('src')||img.getAttribute('data-original-src')||''; if(isKakaoImg(src)) items.push({title:img.alt||q, image:src}); });
    return items.slice(0,12);
  }catch(e){ return []; }
}

// ── 네이버 시리즈 ──
async function fetchNaver(q){
  const clientId=document.getElementById('naverClientId')?.value.trim();
  const clientSecret=document.getElementById('naverClientSecret')?.value.trim();
  if(clientId&&clientSecret){
    try{
      const worker=PROXIES.find(p=>p.url.includes('workers.dev'));
      if(worker){
        const apiUrl='https://openapi.naver.com/v1/search/book.json?query='+encodeURIComponent(q)+'&display=12&sort=sim';
        const workerUrl=worker.url+encodeURIComponent(apiUrl)+'&_h_X-Naver-Client-Id='+encodeURIComponent(clientId)+'&_h_X-Naver-Client-Secret='+encodeURIComponent(clientSecret);
        const res=await fetch(workerUrl,{signal:AbortSignal.timeout(8000)});
        if(res.ok){ const json=await res.json(); const items=(json.items||[]).map(it=>({title:it.title.replace(/<[^>]+>/g,''),image:it.image})).filter(it=>it.image); if(items.length) return items.slice(0,12); }
      }
    }catch(e){}
  }
  try{
    const html=await proxyFetch('https://series.naver.com/search/search.series?query='+encodeURIComponent(q)+'&categoryTypeCode=novel');
    const doc=new DOMParser().parseFromString(html,'text/html');
    const items=[];
    doc.querySelectorAll('.lst_list li, .search_lst li, [class*="list"] li').forEach(li=>{
      const img=li.querySelector('img');
      const titleEl=li.querySelector('[class*="title"],[class*="subj"],strong,a');
      const src=img?.getAttribute('src')||img?.getAttribute('data-src')||'';
      if(src&&src.startsWith('http')&&(src.includes('thumb')||src.includes('cover')||src.includes('book'))&&!src.includes('icon')) items.push({title:titleEl?.textContent?.trim()||q, image:src});
    });
    if(items.length) return items.slice(0,12);
    doc.querySelectorAll('img').forEach(img=>{ const src=img.getAttribute('src')||img.getAttribute('data-src')||''; if(src&&src.startsWith('http')&&(src.includes('thumb')||src.includes('cover'))&&!src.includes('static')&&!src.includes('icon')) items.push({title:img.alt||q, image:src}); });
    return items.slice(0,12);
  }catch(e){ return []; }
}

// ── 리디북스 ──
async function fetchRidi(q){
  function isValidRidiImg(src){
    if(!src||!src.startsWith('http')) return false;
    if(src.includes('badge')||src.includes('icon')||src.includes('logo')) return false;
    if(src.includes('active.ridibooks.com')) return false;
    if(src.includes('static')||src.includes('pixel.')) return false;
    return src.includes('cdn.ridi')||src.includes('thumb')||src.includes('cover')||src.includes('book');
  }
  try{
    const html=await proxyFetch('https://ridibooks.com/search?q='+encodeURIComponent(q)+'&adult_exclude=n');
    const doc=new DOMParser().parseFromString(html,'text/html');
    const items=[];
    doc.querySelectorAll('[class*="book_item"],[class*="BookItem"],[class*="SearchBook"],[class*="book_list"] li').forEach(el=>{
      const img=el.querySelector('img');
      const titleEl=el.querySelector('[class*="title"],[class*="Title"],h3,h4,strong,a');
      const src=img?.getAttribute('src')||img?.getAttribute('data-src')||img?.getAttribute('data-original')||'';
      if(isValidRidiImg(src)) items.push({title:titleEl?.textContent?.trim()||q, image:src});
    });
    if(!items.length){ doc.querySelectorAll('img').forEach(img=>{ const src=img.getAttribute('src')||img.getAttribute('data-src')||''; if(isValidRidiImg(src)) items.push({title:img.alt||q, image:src}); }); }
    return items.slice(0,12);
  }catch(e){ return []; }
}

// ── 노벨피아 ──
async function fetchNovelpia(q){
  function fixNovelpiaImg(src){ if(!src) return ''; if(src.startsWith('//')) return 'https:'+src; if(src.startsWith('/')) return 'https://novelpia.com'+src; return src; }
  try{
    const postBody='search_type=all&search_string='+encodeURIComponent(q)+'&page=1&page_limit=12';
    const resp=await proxyPost('https://novelpia.com/proc/novel_list', postBody);
    const json=JSON.parse(resp);
    const list=json.list||json.data||[];
    const items=list.slice(0,12).map(n=>({title:n.novel_name||n.title||q,image:fixNovelpiaImg(n.cover_img||n.cover||n.img||n.thumbnail||'')})).filter(i=>i.image);
    if(items.length) return items;
  }catch(e){}
  try{
    const html=await proxyFetch('https://novelpia.com/search/novel?search_string='+encodeURIComponent(q));
    const doc=new DOMParser().parseFromString(html,'text/html');
    const items=[];
    doc.querySelectorAll('[class*="novel"],[class*="book"],[class*="item"]').forEach(el=>{ const img=el.querySelector('img'); const src=img?.getAttribute('src')||img?.getAttribute('data-src')||''; const fixed=fixNovelpiaImg(src); if(fixed&&fixed.startsWith('http')&&!fixed.includes('icon')&&!fixed.includes('logo')) items.push({title:img?.alt||el.querySelector('h3,h4,strong,a')?.textContent?.trim()||q, image:fixed}); });
    if(items.length) return items.slice(0,12);
    doc.querySelectorAll('img').forEach(img=>{ const src=fixNovelpiaImg(img.getAttribute('src')||img.getAttribute('data-src')||''); if(src&&src.startsWith('http')&&(src.includes('cover')||src.includes('novel')||src.includes('thumb'))&&!src.includes('icon')) items.push({title:img.alt||q, image:src}); });
    return items.slice(0,12);
  }catch(e){ return []; }
}

// ── 구글 이미지 (Bing/DDG/네이버 대체) ──
async function fetchGoogle(q){
  function isValidImg(src){ if(!src||!src.startsWith('http')||src.length<40) return false; const s=src.toLowerCase(); return !s.includes('icon')&&!s.includes('logo')&&!s.includes('pixel')&&!s.includes('blank')&&!s.includes('spacer')&&(s.includes('.jpg')||s.includes('.jpeg')||s.includes('.png')||s.includes('.webp')||s.includes('image')||s.includes('thumb')||s.includes('cover')||s.includes('photo')); }
  try{
    const html=await proxyFetch('https://www.bing.com/images/search?q='+encodeURIComponent(q+' 소설 표지')+'&form=HDRSC2&first=1');
    const doc=new DOMParser().parseFromString(html,'text/html');
    const items=[]; const seen=new Set();
    doc.querySelectorAll('.iusc,[class*="imgpt"],[class*="img_cont"]').forEach(el=>{
      const m=el.getAttribute('m')||el.getAttribute('data-m')||'';
      if(m){ try{ const obj=JSON.parse(m); const url=obj.murl||obj.imgurl||''; if(url&&!seen.has(url)&&isValidImg(url)){ seen.add(url); items.push({title:obj.t||q, image:url}); } }catch(e){} }
      const img=el.querySelector('img'); const src=img?.getAttribute('src')||img?.getAttribute('data-src')||'';
      if(src&&!seen.has(src)&&isValidImg(src)){ seen.add(src); items.push({title:img?.alt||q, image:src}); }
    });
    if(!items.length){ doc.querySelectorAll('img[src]').forEach(img=>{ const src=img.getAttribute('src')||''; if(!seen.has(src)&&isValidImg(src)&&!src.includes('bing.com/th')){ seen.add(src); items.push({title:img.alt||q, image:src}); } }); }
    if(items.length) return items.slice(0,12);
  }catch(e){}
  try{
    const html=await proxyFetch('https://duckduckgo.com/?q='+encodeURIComponent(q+' 소설 표지')+'&iax=images&ia=images');
    const vqd=(html.match(/vqd=['"]([^'"]+)['"]/)||[])[1];
    if(vqd){ const jsonHtml=await proxyFetch('https://duckduckgo.com/i.js?q='+encodeURIComponent(q+' 소설 표지')+'&vqd='+encodeURIComponent(vqd)+'&p=1'); const json=JSON.parse(jsonHtml); const items=(json.results||[]).slice(0,12).map(r=>({title:r.title||q,image:r.image||r.thumbnail||''})).filter(i=>i.image&&isValidImg(i.image)); if(items.length) return items; }
  }catch(e){}
  try{
    const html=await proxyFetch('https://search.naver.com/search.naver?where=image&query='+encodeURIComponent(q+' 소설 표지')+'&sm=tab_srt&sort=0');
    const doc=new DOMParser().parseFromString(html,'text/html');
    const items=[]; const seen=new Set();
    doc.querySelectorAll('img[data-lazy-src],img[data-original],img[src]').forEach(img=>{ const src=img.getAttribute('data-lazy-src')||img.getAttribute('data-original')||img.getAttribute('src')||''; if(!seen.has(src)&&isValidImg(src)&&!src.includes('naver.com/static')){ seen.add(src); items.push({title:img.alt||q, image:src}); } });
    return items.slice(0,12);
  }catch(e){ return []; }
}
