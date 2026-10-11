// 分析頁的拍照辨識（可一次多張）。
// 經典腳本（不是 ES module）：和其他 js/*.js 共用全域，由 index.html 依固定順序載入，順序不能換。

// ===== 分析分頁的拍照辨識 =====
// 辨識只負責把照片變成文字填進輸入框，之後完全走原本的流程
// （斷句 → 逐句分析 → 快取），和自己貼上一整段沒有任何差別。
async function handleAnalyzeImage(files){
  const list = [].concat(files || []).filter(Boolean);
  if (!list.length) return;
  const btn = el('anPhoto'), hint = el('inp-hint');
  btn.disabled = true; goBtn.disabled = true;
  let ok = 0, lines = 0, filled = 0, cost = 0, queued = 0; const failed = [];
  try {
    for (let i = 0; i < list.length; i++){
      const tag = list.length > 1 ? `第 ${i + 1}／${list.length} 張：` : '';
      anBusy(true, tag + '讀取照片', '縮圖中');
      hint.textContent = tag + '讀取照片…';
      try {
        const image = await shrinkImage(list[i]);
        if (!image){ failed.push(`第 ${i + 1} 張讀不到`); continue; }
        anBusy(true, tag + '辨識中', '把課本上的英文句子抄下來，大約十幾秒');
        hint.textContent = tag + '辨識中…';
        const d = await fetch('/api/analyze-ocr', {
          method:'POST', headers:{ 'content-type':'application/json', ...(TOKEN?{'x-auth-token':TOKEN}:{}) },
          body: JSON.stringify({ image, mode: typeof anMode !== 'undefined' ? anMode : 'sentence' }),
        }).then(r => r.json());
        if (d.pending){ queued++; continue; }                      // 學生：辨識要老師核准，已開申請單
        if (d.error === 'unauthorized') showTokenBanner('存取碼不對或還沒輸入，所以照片沒辦法辨識。請輸入存取碼。');
        if (d.error){ failed.push(`第 ${i + 1} 張：${d.message || d.error}`); continue; }
        if (!d.text){ failed.push(`第 ${i + 1} 張沒抄到完整的英文句子（單字表請改用「單字」分頁的拍照）`); continue; }
        // 輸入框裡如果是範例句（curKind 不為 null），那不是使用者打的內容，直接覆蓋。
        // 真的是自己貼的才接在後面 —— 拍兩頁、或一次選兩張都靠這個。
        const own = curKind === null ? inp.value.trim() : '';
        const seen = new Set(own.split('\n').map(l => l.trim().toLowerCase()).filter(Boolean));
        const fresh = d.text.split('\n').filter(l => l.trim() && !seen.has(l.trim().toLowerCase())).join('\n');
        setInput(own ? [own, fresh].filter(Boolean).join('\n') : d.text);
        curKind = null;
        ok++; lines += d.text.split('\n').filter(Boolean).length; filled += d.filled || 0; cost += d.usage.costUsd || 0;
      } catch (err){
        failed.push(`第 ${i + 1} 張辨識失敗：${err.message}`);
      }
    }
    if (ok) inp.focus();
    const total = inp.value.split('\n').filter(l => l.trim()).length;
    const parts = [];
    if (ok) parts.push(`辨識了 ${ok} 張，抄到 ${lines} 行，輸入框目前共 ${total} 行（參考費用 ${money(cost)}）。` +
      (filled ? `考卷的 ${filled} 個空格已依選項填上答案 —— 那是分析出來的，不是解答本，請自己核對。`
              : '請核對上面的內容，刪掉不需要的部分再按分析。'));
    if (queued) parts.push(`已送出 ${queued} 張照片的辨識申請。老師核准後，辨識結果會出現在「我的申請」，到時可以一鍵帶回輸入框。`);
    if (failed.length) parts.push('失敗：' + failed.join('；') + '。');
    hint.textContent = parts.join(' ');
  } finally { anBusy(false); btn.disabled = false; goBtn.disabled = false; }
}

el('anPhoto').addEventListener('click', () => el('anFile').click());
el('anFile').addEventListener('change', e => {
  const fs = [...(e.target.files || [])];
  e.target.value = '';
  handleAnalyzeImage(fs);
});

// 拖曳與貼上：和單字分頁同一套來源判斷
// 句子頁與文章頁都有輸入區（同一塊 #an-live 搬來搬去）；輸入區看得到才處理拖進來的圖片
const liveOn = () => el('an-live').offsetParent !== null;
for (const view of [el('view-sentence'), el('view-article')]) {
  let depth = 0;
  view.addEventListener('dragenter', e => {
    if (!liveOn()) return;
    if (![...(e.dataTransfer?.types || [])].includes('Files')) return;
    e.preventDefault();
    if (depth++ === 0) view.classList.add('dropping');
  });
  view.addEventListener('dragover', e => {
    if (!liveOn()) return;
    if ([...(e.dataTransfer?.types || [])].includes('Files')){
      e.preventDefault(); e.dataTransfer.dropEffect = 'copy';
    }
  });
  view.addEventListener('dragleave', () => { if (--depth <= 0){ depth = 0; view.classList.remove('dropping'); } });
  view.addEventListener('drop', e => {
    if (!liveOn()) return;
    const f = imagesFromTransfer(e.dataTransfer);
    if (!f.length && !(e.dataTransfer?.files?.length)) return;
    e.preventDefault();
    depth = 0; view.classList.remove('dropping');
    if (!f.length){ el('inp-hint').textContent = '拖進來的不是圖片。請拖 JPG 或 PNG 的課本照片。'; return; }
    handleAnalyzeImage(f);
  });
  view.addEventListener('paste', e => {
    if (!liveOn()) return;
    const f = imageFromTransfer(e.clipboardData);
    if (!f) return;               // 貼文字就照常貼進輸入框
    e.preventDefault();
    handleAnalyzeImage(f);
  });
}
