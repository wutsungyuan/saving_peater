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
el('snFilter').addEventListener('change', () => { snState.filter = el('snFilter').value; el('snAssign').hidden = snState.filter !== 'unused'; el('snAssignMsg').textContent = ''; loadSentences(); });

// 還沒有範圍的句子：歸進文章表。先預覽會歸到哪幾份、各幾句，按「確定」才真的歸。
async function snAssign(mode){
  const msg = el('snAssignMsg'), name = el('snAssignName').value.trim();
  if (mode === 'name' && !name){ msg.textContent = '請先輸入範圍名稱。'; el('snAssignName').focus(); return; }
  const body = { mode, name, q: snState.q };
  const p = await artApi('/api/admin/sentences-assign', { method: 'POST', body });
  if (!p.ok){ msg.textContent = p.json.message || '無法預覽'; return; }
  if (!p.json.total){ msg.textContent = '沒有可以歸類的句子。'; return; }
  const list = p.json.groups.map(g => `「${esc(g.name)}」${g.count} 句${g.exists ? '（接在既有的後面）' : '（新建）'}`).join('、');
  msg.innerHTML = `共 ${p.json.total} 句，會歸入：${list}。 <button type="button" class="primary" id="snAssignOk">確定歸入</button> <button type="button" class="linky" id="snAssignNo">取消</button>`;
  el('snAssignNo').onclick = () => { msg.textContent = ''; };
  el('snAssignOk').onclick = async () => {
    el('snAssignOk').disabled = true;
    const r = await artApi('/api/admin/sentences-assign', { method: 'POST', body: { ...body, confirm: true } });
    if (!r.ok){ msg.textContent = r.json.message || '歸類失敗'; return; }
    msg.textContent = `已歸入 ${r.json.added} 句。`;
    if (typeof refreshArticleNames === 'function') refreshArticleNames();
    loadSentences();
  };
}
el('snAssignGo').addEventListener('click', () => snAssign('name'));
el('snAssignDate').addEventListener('click', () => snAssign('by-date'));
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

// ===== 整理學生的練習紀錄（後台「學生紀錄」）=====
const REC_KIND = { all: '全部（句子與單字）', practice: '句子練習', quiz: '單字測驗', exam: '測驗卷裡的作答' };
let recSets = [];
let recPreviewKey = null;                     // 預覽時的條件；條件改了，確認鈕就失效，要重新預覽

const recForm = () => ({
  kind: el('recKind').value, from: el('recFrom').value || undefined, to: el('recTo').value || undefined,
  setIds: [...document.querySelectorAll('#recSets [aria-pressed="true"]')].map(b => Number(b.dataset.id)),
  resetProgress: el('recReset').checked,
});
const recDescribe = f => [REC_KIND[f.kind] || f.kind,
  f.from || f.to ? `${f.from || '不限'} ～ ${f.to || '不限'}` : '不限日期',
  f.setIds?.length ? '字表：' + f.setIds.map(id => recSets.find(s => s.id === id)?.name ?? '#' + id).join('、') : null,
  f.resetProgress ? '含熟練度' : null].filter(Boolean).join('・');
const recCounts = c => `句子作答 ${c.attempts} 筆、單字作答 ${c.wordAttempts} 筆${c.progress ? `、單字熟練度 ${c.progress} 個字` : ''}`;

function recAuditPaint(list){
  el('recAudit').innerHTML = list?.length ? `<div class="scroll"><table class="p-table"><thead><tr><th>時間</th><th>條件</th><th>刪掉</th><th>備份</th></tr></thead><tbody>${list.map(a => {
    const d = a.detail || {};
    const f = d.filter ? { kind: d.filter.kind, from: d.filter.from ? new Date(d.filter.from).toLocaleDateString('sv') : '', to: d.filter.to ? new Date(d.filter.to - 86400000).toLocaleDateString('sv') : '', setIds: d.filter.setIds, resetProgress: d.filter.resetProgress } : null;
    return `<tr><td>${esc(new Date(a.at).toLocaleString('zh-TW', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' }))}</td>
      <td>${f ? esc(recDescribe(f)) : ''}</td><td>${d.deleted ? esc(recCounts(d.deleted)) : ''}</td><td><small>${esc(d.backup || '')}</small></td></tr>`;
  }).join('')}</tbody></table></div>` : '<p class="hint">還沒有。</p>';
}

async function loadRecSets(){
  const d = await fetch('/api/wordsets?user=x').then(r => r.ok ? r.json() : null).catch(() => null);
  recSets = d?.sets ?? [];
  el('recSets').innerHTML = recSets.length ? recSets.map(s => `<button type="button" class="tchip" data-id="${s.id}" aria-pressed="false">${esc(s.name)}</button>`).join('') : '<span class="hint">還沒有單字表。</span>';
}
el('recBox').addEventListener('toggle', () => { if (el('recBox').open){ loadRecSets(); recPreviewFetch(true); } });
el('recSets').addEventListener('click', e => { const b = e.target.closest('.tchip'); if (b){ b.setAttribute('aria-pressed', String(b.getAttribute('aria-pressed') !== 'true')); recStale(); } });
for (const id of ['recKind', 'recFrom', 'recTo', 'recReset']) el(id).addEventListener('change', recStale);
function recStale(){ if (recPreviewKey && JSON.stringify(recForm()) !== recPreviewKey){ recPreviewKey = null; el('recResult').innerHTML = ''; el('recMsg').textContent = '條件改了，請重新預覽。'; } }

async function recPreviewFetch(auditOnly = false){
  const f = recForm();
  const r = await artApi('/api/admin/records-preview', { method: 'POST', body: f });
  if (!r.ok){ el('recMsg').textContent = r.json.message || '預覽失敗'; return; }
  recAuditPaint(r.json.audit);
  if (auditOnly) return;
  const c = r.json.counts, total = c.attempts + c.wordAttempts + c.progress;
  recPreviewKey = JSON.stringify(f);
  el('recMsg').textContent = '';
  el('recResult').innerHTML = total
    ? `<div class="rec-warn"><p><b>將刪除：${esc(recCounts(c))}。</b></p><p class="hint">條件：${esc(recDescribe(f))}。刪掉就不能從畫面復原（只能用備份還原）。</p>
        <div class="row"><button type="button" class="danger-btn" id="recGo">確定刪除（先備份）</button></div></div>`
    : '<p class="hint">沒有符合條件的紀錄。</p>';
}
el('recPreview').addEventListener('click', () => recPreviewFetch());
el('recResult').addEventListener('click', async e => {
  const b = e.target.closest('#recGo'); if (!b) return;
  if (b.dataset.armed !== '1'){ b.dataset.armed = '1'; b.textContent = '再按一次，真的刪除'; setTimeout(() => { if (b.isConnected){ b.dataset.armed = '0'; b.textContent = '確定刪除（先備份）'; } }, 5000); return; }
  if (recPreviewKey !== JSON.stringify(recForm())){ el('recMsg').textContent = '條件改了，請重新預覽。'; return; }
  b.disabled = true; el('recMsg').textContent = '備份並刪除中…';
  const r = await artApi('/api/admin/records-delete', { method: 'POST', body: { ...recForm(), confirm: true } });
  if (!r.ok){ b.disabled = false; el('recMsg').textContent = r.json.message || '刪除失敗'; return; }
  recPreviewKey = null;
  el('recMsg').textContent = '';
  el('recResult').innerHTML = `<p class="rec-done">已刪除：${esc(recCounts(r.json.deleted))}。${r.json.backup ? `刪之前的備份：<code>${esc(r.json.backup)}</code>（在資料庫旁的 backups 資料夾）。` : ''}</p>`;
  if (r.json.audit) recAuditPaint(r.json.audit);
  loadStudentRecords();                                    // 上面的統計跟著更新
});
