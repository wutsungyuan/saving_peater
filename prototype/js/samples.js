// 範例句：內建範例，與換成自己分析過的句子。
// 經典腳本（不是 ES module）：和其他 js/*.js 共用全域，由 index.html 依固定順序載入，順序不能換。

// ===== 範例句也可以改用自己分析過的句子 =====
// 內建那 12 句是教學用的標準範例，當入口很好；但真正貼近孩子在讀的，
// 是他自己貼過、分析過的句子。資料庫裡有就讓標籤能換過去。
async function loadSampleCounts(){
  if (API === false) return;
  try { sampleCounts = (await fetch('/api/samples').then(r => r.json())).counts || {}; }
  catch { sampleCounts = {}; }
}


/** 往下換一句。走完自己分析過的那些就回到內建範例，形成一個循環。 */
async function nextSample(){
  const n = sampleCounts[curKind] || 0;
  if (!n) return;                               // 沒有可換的就維持內建範例
  if (curIdx + 1 >= n){ curIdx = -1; return render(curKind); }
  try {
    const d = await fetch(`/api/samples?kind=${encodeURIComponent(curKind)}&n=${curIdx + 1}`)
      .then(r => r.json());
    if (!d.total) return;
    curIdx = d.index;
    out.innerHTML = renderSentence(d.sentence, false);
    setInput(d.original);
    layoutPosLabels();
  } catch { /* 拿不到就維持現狀 */ }
}

// 手機上開頭說明收成兩行，點了才展開。桌機不顯示這個鈕。
(() => {
  const p = el('intro'), b = el('introMore');
  const phone = () => matchMedia('(max-width:560px)').matches;
  const sync = () => {
    b.hidden = !phone();
    if (!phone()) p.classList.remove('open');
  };
  b.addEventListener('click', () => {
    const open = p.classList.toggle('open');
    b.textContent = open ? '收起說明' : '看說明';
  });
  sync();
  matchMedia('(max-width:560px)').addEventListener('change', sync);
})();
