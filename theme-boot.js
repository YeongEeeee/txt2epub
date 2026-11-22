// ════════════════════════════════════════════════════════
// NovelEPUB — theme-boot.js
// ★ Phase 31: 저장된 테마·스킨을 첫 화면 전에 적용 (<head>에서 동기 실행, 1KB 미만)
//   나머지 스크립트가 defer로 바뀌어 첫 화면이 JS 실행 전에 그려지므로,
//   여기서 먼저 정하지 않으면 '다크'·'인디고/포레스트'를 저장한 사용자에게
//   기본 테마가 잠깐 보였다가 바뀜 (CSP상 인라인 스크립트를 쓸 수 없어 별도 파일)
//   저장값이 없으면 아무것도 하지 않음 → style.css의 prefers-color-scheme 규칙이 그대로 적용
//   이후 ui-state.js initTheme()·settings.js initSkin()이 같은 저장 키로 최종 상태를 다시 맞춤
// ════════════════════════════════════════════════════════
(function(){
  try{
    var d=document.documentElement;
    var theme=localStorage.getItem('novelepub_theme');
    if(theme==='dark'||theme==='light') d.setAttribute('data-theme',theme);
    var skin=localStorage.getItem('novelepub_skin');
    if(skin==='indigo'||skin==='forest') d.setAttribute('data-skin',skin);
  }catch(e){}
})();
