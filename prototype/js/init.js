// 初始化：依後端狀態決定畫面。
// 經典腳本（不是 ES module）：和其他 js/*.js 共用全域，由 index.html 依固定順序載入，順序不能換。

// ===== 初始化 =====
// 放在最後 —— 這裡會用到散落各處的 USER、wsSel 等變數，
// 擺在前面會踩到 TDZ，而且在 async 函式裡失敗還會被無聲吞掉。
// 首頁預設停在「單字」，所以啟動時就要把字表載進來。
document.body.dataset.view = 'words';   // 預設分頁，CSS 靠這個決定要不要顯示邊緣把手
if (isAdminApp()) showView('jobs');     // 後台一進來先看待審
if (API !== false) loadWordsets();

// 手機上「顯示／詞性／朗讀」預設收起 —— 那三列會把句子卡推到很下面，
// 可是真正常調的只有少數人。桌機寬度夠，維持展開並隱藏這顆鈕。
(function(){
  const bar = el('optBar'), box = el('toolbar');
  const narrow = matchMedia('(max-width:560px)');
  const apply = () => {
    bar.hidden = !narrow.matches;
    if (!narrow.matches){ box.hidden = false; return; }
    box.hidden = bar.getAttribute('aria-expanded') !== 'true';
  };
  bar.addEventListener('click', () => {
    bar.setAttribute('aria-expanded', bar.getAttribute('aria-expanded') === 'true' ? 'false' : 'true');
    apply();
  });
  narrow.addEventListener('change', apply);
  apply();
})();
