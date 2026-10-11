// 老師後台的句子管理：列出已分析的句子，搜尋、篩選、看完整分析、排除出題、重新分析、刪除。
// 經典腳本（不是 ES module）：和其他 js/*.js 共用全域，由 index.html 依固定順序載入，順序不能換。

const SN_PAGE = 50;
const SN_FILTERS = [['all', '全部'], ['issue', '有問題（無法分析或有錯誤標註）'], ['excluded', '已排除出題'], ['outscope', '超出國中範圍'], ['unused', '沒有被文章用到']];
const TENSE_NAMES = Object.fromEntries([...CORE_TENSES, ...Object.entries(EXTRA_TENSES)]);
let snState = { q: '', filter: 'all', offset: 0, total: 0, items: [] };

el('snFilter').innerHTML = SN_FILTERS.map(([k, zh]) => `<option value="${k}">${esc(zh)}</option>`).join('');

function snRow(s){
  const tags = [
    s.patternId ? PATTERN_NAMES[s.patternId] : null,
    s.tense ? (TENSE_NAMES[s.tense] || s.tense) : null,
    s.inScope === false ? '超出範圍' : null,
    s.issue ? `無法分析（${s.issue}）` : null,
    s.errors ? `${s.errors} 個錯誤標註` : null,
    s.speaker ? `${s.speaker} 說的` : null,
    s.usedInArticles ? `${s.usedInArticles} 篇文章用到` : '沒有被文章用到',
    `命中 ${s.hits} 次`,
    new Date(s.createdAt).toLocaleDateString('zh-TW'),
  ].filter(Boolean);
  return `<article class="srow${s.excluded ? ' ex' : ''}" data-hash="${s.hash}">
    <div class="srow-main"><b class="en">${esc(s.original)}</b>${s.excluded ? '<span class="badge warn">已排除出題</span>' : ''}</div>
    <div class="srow-zh">${esc(s.translation)}</div>
    <div class="srow-tags">${tags.map(esc).join('　·　')}</div>
    <div class="row srow-acts">
      <button type="button" class="linky" data-sn="view">看分析</button>
      <button type="button" class="linky" data-sn="exclude">${s.excluded ? '恢復出題' : '排除出題'}</button>
      <button type="button" class="linky" data-sn="reanalyze">重新分析</button>
      <button type="button" class="linky danger" data-sn="delete"${s.usedInArticles ? ' disabled title="還在文章表裡，要先從文章移除"' : ''}>刪除</button>
      <span class="hint srow-msg"></span>
    </div>
    <div class="srow-detail" hidden></div></article>`;
}

function snPaint(){
  el('snCount').textContent = snState.total ? `共 ${snState.total} 句${snState.items.length < snState.total ? `，顯示 ${snState.items.length} 句` : ''}` : '';
  el('snList').innerHTML = snState.items.length ? snState.items.map(snRow).join('')
    : `<div class="box"><p style="margin:0">${snState.q || snState.filter !== 'all' ? '沒有符合的句子。' : '還沒有分析過的句子。'}</p></div>`;
  el('snMore').hidden = snState.items.length >= snState.total;
}

async function loadSentences(more = false){
  if (API === false){ el('snList').innerHTML = needApi('句子管理'); return; }
  if (!more){ snState = { ...snState, offset: 0, items: [] }; el('snList').innerHTML = '<p class="msg">載入中…</p>'; }
  const qs = `q=${encodeURIComponent(snState.q)}&filter=${snState.filter}&limit=${SN_PAGE}&offset=${snState.offset}`;
  const r = await artApi('/api/admin/sentences?' + qs);
  if (!r.ok){ el('snList').innerHTML = `<p class="msg">${r.status === 403 ? '這個功能只有老師能用。' : '讀不到句子清單。'}</p>`; return; }
  snState.total = r.json.total;
  snState.items = more ? [...snState.items, ...r.json.items] : r.json.items;
  snState.offset = snState.items.length;
  snPaint();
}

let snTimer = null;
el('snQ').addEventListener('input', () => { clearTimeout(snTimer); snTimer = setTimeout(() => { snState.q = el('snQ').value.trim(); loadSentences(); }, 300); });
el('snFilter').addEventListener('change', () => { snState.filter = el('snFilter').value; loadSentences(); });
el('snMore').addEventListener('click', () => loadSentences(true));

el('snList').addEventListener('click', async e => {
  const b = e.target.closest('[data-sn]'); if (!b) return;
  const row = b.closest('.srow'), hash = row.dataset.hash, act = b.dataset.sn;
  const msg = row.querySelector('.srow-msg'), detail = row.querySelector('.srow-detail');
  const item = snState.items.find(x => x.hash === hash);

  if (act === 'view'){
    if (!detail.hidden){ detail.hidden = true; b.textContent = '看分析'; return; }
    msg.textContent = '讀取中…';
    const r = await artApi('/api/admin/sentence?hash=' + hash);
    msg.textContent = '';
    if (!r.ok || !r.json.data){ msg.textContent = '讀不到這一句的分析。'; return; }
    const used = r.json.usedIn.length ? `<p class="hint">用在文章：${r.json.usedIn.map(a => esc(a.name)).join('、')}</p>` : '';
    detail.innerHTML = `<div class="out-inline" data-mode="full" data-pos-mode="content">${renderSentence({ ...r.json.data, index: 0 }, false)}</div>${used}`;
    detail.hidden = false; b.textContent = '收起分析';
    if (typeof layoutPosLabels === 'function') layoutPosLabels();
    return;
  }
  if (act === 'exclude'){
    const flag = !item.excluded;
    const r = await artApi('/api/admin/sentence-exclude', { method: 'POST', body: { hash, excluded: flag } });
    if (!r.ok){ msg.textContent = r.json.message || '操作失敗'; return; }
    item.excluded = flag;
    if (snState.filter === 'excluded' && !flag){ snState.items = snState.items.filter(x => x !== item); snState.total--; }
    return snPaint();
  }
  if (act === 'delete'){
    if (b.dataset.armed !== '1'){ b.dataset.armed = '1'; b.textContent = '再按一次確定刪除'; setTimeout(() => { b.dataset.armed = '0'; b.textContent = '刪除'; }, 4000); return; }
    const r = await artApi('/api/admin/sentence?hash=' + hash, { method: 'DELETE' });
    if (!r.ok){ msg.textContent = r.json.message || '刪除失敗'; return; }
    snState.items = snState.items.filter(x => x !== item); snState.total--;
    return snPaint();
  }
  if (act === 'reanalyze'){
    msg.textContent = '算報價中…';
    const q = await artApi('/api/admin/sentence-reanalyze', { method: 'POST', body: { hash } });
    if (q.status !== 409 || !q.json.quote){ msg.textContent = q.json.message || '無法重新分析'; return; }
    const est = q.json.quote.estimate;
    msg.innerHTML = `重新分析一句，預估 <b>${usd(est.low)}～${usd(est.high)}</b>、約 ${est.seconds} 秒（舊的結果會被取代；失敗會保留舊的）。
      <button type="button" class="primary" data-sn="reanalyze-go">確定</button> <button type="button" class="linky" data-sn="reanalyze-no">取消</button>`;
    return;
  }
  if (act === 'reanalyze-no'){ msg.textContent = ''; return; }
  if (act === 'reanalyze-go'){
    b.disabled = true; msg.textContent = '重新分析中…約十幾秒，請不要離開';
    const r = await artApi('/api/admin/sentence-reanalyze', { method: 'POST', body: { hash, confirm: true } });
    if (!r.ok){ msg.textContent = r.json.message || '重新分析失敗'; return; }
    detail.hidden = true; await loadSentences();
  }
});
// 展開後的分析卡：游標移到單字跳出詞性與成分的便條
el('snList').addEventListener('pointerover', e => { const w = e.target.closest('.w'); w ? showTip(w) : hideTip(); });
el('snList').addEventListener('pointerleave', hideTip);
