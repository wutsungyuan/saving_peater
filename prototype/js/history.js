// 歷史頁：用量與過去的分析、辨識紀錄。
// 經典腳本（不是 ES module）：和其他 js/*.js 共用全域，由 index.html 依固定順序載入，順序不能換。

// ===== 歷史 =====
const usageCards = document.getElementById('usageCards');
const historyOut = document.getElementById('historyOut');

const timeAgo = ts => {
  const m = Math.floor((Date.now() - ts) / 60000);
  if (m < 1) return '剛剛';
  if (m < 60) return `${m} 分鐘前`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h} 小時前`;
  const d = Math.floor(h / 24);
  return d < 30 ? `${d} 天前` : new Date(ts).toLocaleDateString('zh-TW');
};

async function loadHistory(){
  historyOut.innerHTML = '<p class="msg">載入中…</p>';
  try {
    const d = await fetch('/api/history').then(r => r.json());
    const card = (title, x) => `<div class="ucard"><h4>${title}</h4>
      <div class="big">${money(x.cost_usd)}</div>
      <div class="sub">${x.requests} 次分析　${x.sentences} 句<br>
        新分析 ${x.analyzed} 句／快取 ${x.cached} 句<br>
        輸出 ${nf(x.output_tokens)} tokens</div></div>`;
    usageCards.innerHTML = card('今天', d.usage.today) + card('本月', d.usage.month) + card('全部', d.usage.all)
      + `<div class="ucard"><h4>快取</h4><div class="big">${d.usage.all.cached}</div>
         <div class="sub">句直接命中快取<br>省下重新分析的時間與額度</div></div>`
      ;
    document.getElementById('quotaNote').innerHTML =
      `<b>以上是這個工具自己的用量，不是你的 Claude 訂閱額度。</b>
       真實額度請看 Claude app → Settings → Usage —— 那裡有 5 小時 session 與每週兩種視窗的實際百分比。
       Claude CLI 沒有提供查詢介面，所以無法顯示在這裡。`;

    if (!d.items.length){
      historyOut.innerHTML = '<p class="msg">還沒有分析紀錄。到「分析」貼一段文章就會出現在這裡。</p>';
      return;
    }
    historyOut.innerHTML = d.items.map(it => {
      const gone = !it.preview;
      const KIND = { analyze:['分析句子','句',''], wordset:['建立字表','字','word'],
        ocr:['照片抄單字','字','ocr'], 'ocr-text':['照片抄句子','句','ocr'],
        'paper-gen':['測驗卷出題（模型）','題','paper'], 'paper-grade':['測驗卷 AI 批改','題','paper'], 'exam-ocr':['照片重現考卷','題','paper'] };
      const [kindName, unit, kindCls] = KIND[it.kind] || KIND.analyze;
      const isWord = it.kind === 'wordset';
      const isOcr  = it.kind === 'ocr' || it.kind === 'ocr-text';
      const isPaper = it.kind === 'paper-gen' || it.kind === 'paper-grade' || it.kind === 'exam-ocr';      // 用量紀錄而已，沒有原文可以重新分析
      const dead = isWord && !it.ref_alive;           // 字表已被刪除
      // 字表的原文是「名稱\n單字清單」，拆開顯示才讀得懂
      const lines = (it.preview || '').split('\n');
      const body = gone ? '（原文已超過保留期限，自動清除）'
        : isOcr
          ? `<span class="hwords">${esc(lines.join('、'))}${it.full_len > 300 ? '…' : ''}</span>`
        : isWord
          ? `<span class="hname">${esc(lines[0])}</span>` +
            `<span class="hwords">${esc(lines.slice(1).join('、'))}${it.full_len > 300 ? '…' : ''}</span>`
          : esc(it.preview) + (it.full_len > 300 ? '…' : '');
      return `<button class="hitem${gone ? ' hgone' : ''}${dead ? ' hdead' : ''}" data-id="${it.id}"
        data-kind="${esc(it.kind)}" data-ref="${it.ref_id ?? ''}" ${gone ? 'disabled' : ''}>
        <div class="htext">
          <span class="hkind${kindCls ? ' ' + kindCls : ''}">${kindName}</span>
          ${dead ? '<span class="hkind gone">已刪除</span>' : ''}
          ${body}
          <div class="hmeta">
            <span>${timeAgo(it.created_at)}</span>
            <span><b>${it.sentences}</b> ${unit}</span>
            ${isWord || isOcr || isPaper ? '' : `<span>新分析 <b>${it.analyzed}</b>／快取 <b>${it.cached}</b></span>`}
            <span><b>${(it.ms / 1000).toFixed(1)}s</b></span>
            ${it.cost_usd ? `<span>參考費用 <b>${money(it.cost_usd)}</b></span>` : ''}
          </div>
        </div></button>`;
    }).join('') +
    `<p class="note-retain">原文保留 ${d.retainDays} 天後自動清除，分析快取本身不受影響。</p>`;
  } catch (e){
    historyOut.innerHTML = `<p class="msg">載入失敗：${esc(e.message)}</p>`;
  }
}

historyOut.addEventListener('click', async e => {
  const b = e.target.closest('.hitem'); if (!b || b.disabled) return;
  if (b.dataset.kind === 'paper-gen' || b.dataset.kind === 'paper-grade' || b.dataset.kind === 'exam-ocr') return;      // 出題與批改的用量紀錄：沒有可以重新分析的原文
  if (b.dataset.kind === 'ocr-text'){       // 句子辨識：把抄到的文字帶回分析的輸入框
    const { text } = await fetch(`/api/history?id=${b.dataset.id}`).then(r => r.json());
    jumpTo('sentence', { sub: 'live' });
    if (text){ curKind = null; setInput(text); }
    return;
  }
  if (b.dataset.kind === 'ocr'){            // 單字表辨識：把結果帶回新增字表的表單
    const { text } = await fetch(`/api/history?id=${b.dataset.id}`).then(r => r.json());
    jumpTo('words');
    if (text){
      el('wsForm').hidden = false;
      setFormMode(true);
      el('wsText').value = text;
      el('wsText').dispatchEvent(new Event('input'));
      el('wsHint').textContent = '已帶回上次辨識的結果，核對後可直接建立字表。';
    }
    return;
  }
  if (b.dataset.kind === 'wordset'){        // 字表不是句子，拿去分析沒有意義
    if (b.classList.contains('hdead')){
      b.insertAdjacentHTML('beforeend',
        '<div class="hnote">這份字表已經刪除了，用量紀錄仍然保留。</div>');
      setTimeout(() => b.querySelector('.hnote')?.remove(), 3000);
      return;
    }
    const ref = Number(b.dataset.ref);
    jumpTo('words');
    if (ref) { wsSel = [ref]; wsCurrent = ref; await loadWordsets(); }   // 直接切到那一份
    return;
  }
  const { text } = await fetch(`/api/history?id=${b.dataset.id}`).then(r => r.json());
  if (!text) return;
  jumpTo('sentence', { sub: 'live' });
  setInput(text);
  analyzeLive(text);   // 全部命中快取，會瞬間完成
});
