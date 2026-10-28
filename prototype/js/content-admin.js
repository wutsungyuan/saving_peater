// 老師後台的內容管理：字表與文章表的清單，改名、對學生隱藏、刪除（先預覽、先備份）。
// 經典腳本（不是 ES module）：和其他 js/*.js 共用全域，由 index.html 依固定順序載入，順序不能換。

const CT_KINDS = { wordset: { box: 'ctWordsets', unit: '字', empty: '還沒有字表。' }, article: { box: 'ctArticles', unit: '句', empty: '還沒有文章表。' } };
let ctData = { wordsets: [], articles: [] };

function ctRow(kind, x){
  const when = new Date(x.createdAt), d = `${when.getMonth() + 1}/${when.getDate()}`;
  return `<div class="srow${x.hidden ? ' ex' : ''}" data-kind="${kind}" data-id="${x.id}">
    <div class="srow-main"><b>${esc(x.name)}</b>${x.hidden ? '<span class="badge warn">對學生隱藏</span>' : ''}</div>
    <div class="srow-tags">${x.count} ${CT_KINDS[kind].unit}　·　建立 ${d}${x.note ? `　·　${esc(x.note)}` : ''}</div>
    <div class="row srow-acts">
      <button type="button" class="linky" data-ct="rename">改名</button>
      <button type="button" class="linky" data-ct="${kind === 'wordset' ? 'words' : 'sents'}">${kind === 'wordset' ? '單字' : '句子'}</button><button type="button" class="linky" data-ct="merge">併入…</button>
      <button type="button" class="linky" data-ct="hide">${x.hidden ? '對學生顯示' : '對學生隱藏'}</button>
      <button type="button" class="linky danger" data-ct="delete">刪除</button>
      <span class="hint srow-msg"></span>
    </div>
    <div class="ct-extra" hidden></div></div>`;
}

function ctPaint(){
  for (const [kind, k] of Object.entries(CT_KINDS)){
    const list = ctData[kind === 'wordset' ? 'wordsets' : 'articles'];
    el(k.box).innerHTML = list.length ? list.map(x => ctRow(kind, x)).join('') : `<p class="hint" style="margin:0">${k.empty}</p>`;
  }
}

async function loadContent(){
  const r = await artApi('/api/admin/content');
  if (!r.ok){ el('ctWordsets').innerHTML = `<p class="hint">載入失敗：${esc(r.json?.message || r.status)}</p>`; return; }
  ctData = r.json;
  ctPaint();
}

/** 改了字表／文章表之後，其他頁的清單也要跟著更新 */
function ctRefreshOthers(){
  if (typeof loadWordsets === 'function') loadWordsets();
  if (typeof refreshArticleNames === 'function') refreshArticleNames();
}

/** 文章表的句子清單：勾選、上下移、移動到新／既有文章表、拿掉 */
async function ctSentPanel(id, extra, msg){
  const r = await artApi(`/api/admin/article-sentences?id=${id}`);
  if (!r.ok){ msg.textContent = r.json.message || '載入失敗'; return; }
  const others = ctData.articles.filter(y => y.id !== id);
  extra.hidden = false;
  extra.innerHTML = `<div class="ct-words">${r.json.sentences.map(w => `<div class="ct-sent" data-hash="${esc(w.hash)}"><label><input type="checkbox" value="${esc(w.hash)}"> ${esc(w.original) || '（找不到句子）'}</label>
      <button type="button" class="linky" data-ct="up" aria-label="上移">↑</button><button type="button" class="linky" data-ct="down" aria-label="下移">↓</button></div>`).join('') || '<p class="hint">這份沒有句子。</p>'}</div>
    <div class="row" style="margin-top:6px"><select class="ct-to" aria-label="移到哪一份"><option value="new">移到新文章表…</option>${others.map(y => `<option value="${y.id}">移到「${esc(y.name)}」</option>`).join('')}</select>
      <input type="text" class="ct-newname" maxlength="60" placeholder="新文章表名稱" aria-label="新文章表名稱">
      <button type="button" class="primary" data-ct="smove-ok">移動所選</button>
      <button type="button" class="linky danger" data-ct="sremove">拿掉所選</button>
      <button type="button" class="linky" data-ct="cancel">關閉</button></div>
    <p class="hint" style="margin:6px 0 0">改動後，這份文章表的閱讀測驗與回應題庫會作廢、之後重出（已出的卷子不受影響）。</p>
    <div class="ct-confirm"></div>`;
  const sel = extra.querySelector('.ct-to'), nn = extra.querySelector('.ct-newname');
  sel.addEventListener('change', () => { nn.hidden = sel.value !== 'new'; });
}

async function ctAct(btn){
  const row = btn.closest('.srow'); if (!row) return;
  const kind = row.dataset.kind, id = Number(row.dataset.id);
  const x = ctData[kind === 'wordset' ? 'wordsets' : 'articles'].find(y => y.id === id);
  const msg = row.querySelector('.srow-msg'), extra = row.querySelector('.ct-extra');
  const act = btn.dataset.ct;
  if (act === 'hide'){
    const r = await artApi('/api/admin/content-update', { method: 'POST', body: { kind, id, hidden: !x.hidden } });
    if (!r.ok){ msg.textContent = r.json.message || '失敗'; return; }
    await loadContent(); ctRefreshOthers();
  } else if (act === 'rename'){
    extra.hidden = false;
    extra.innerHTML = `<div class="row"><input type="text" class="grow" maxlength="60" value="${esc(x.name)}" aria-label="新名稱">
      <button type="button" class="primary" data-ct="rename-ok">儲存</button> <button type="button" class="linky" data-ct="cancel">取消</button></div>`;
    extra.querySelector('input').focus();
  } else if (act === 'rename-ok'){
    const name = extra.querySelector('input').value.trim();
    const r = await artApi('/api/admin/content-update', { method: 'POST', body: { kind, id, name } });
    if (!r.ok){ msg.textContent = r.json.message || '改名失敗'; return; }
    await loadContent(); ctRefreshOthers();
  } else if (act === 'delete'){
    const p = await artApi('/api/admin/content-delete-preview', { method: 'POST', body: { kind, ids: [id] } });
    if (!p.ok){ msg.textContent = p.json.message || '無法預覽'; return; }
    const it = p.json.items[0];
    const what = kind === 'wordset'
      ? `會刪掉 ${it.words} 個單字、${it.attempts} 筆作答、${it.progress} 筆熟練度。`
      : `會刪掉這份的 ${it.sentences} 句順序${it.orphaned ? `，其中 ${it.orphaned} 句沒有別的文章表在用，會變成「沒有範圍」` : ''}（句子分析留著）。`;
    extra.hidden = false;
    extra.innerHTML = `<p class="hint" style="margin:6px 0">刪除「${esc(x.name)}」？${what}刪之前會先備份。</p>
      <div class="row"><button type="button" class="primary danger" data-ct="delete-ok">確認刪除</button> <button type="button" class="linky" data-ct="cancel">取消</button></div>`;
  } else if (act === 'delete-ok'){
    btn.disabled = true;
    const r = await artApi('/api/admin/content-delete', { method: 'POST', body: { kind, ids: [id], confirm: true } });
    if (!r.ok){ msg.textContent = r.json.message || '刪除失敗'; btn.disabled = false; return; }
    await loadContent(); ctRefreshOthers();
  } else if (act === 'words'){
    const r = await artApi(`/api/admin/wordset-words?id=${id}`);
    if (!r.ok){ msg.textContent = r.json.message || '載入失敗'; return; }
    const others = ctData.wordsets.filter(y => y.id !== id);
    extra.hidden = false;
    extra.innerHTML = `<div class="ct-words">${r.json.words.map(w => `<label class="ct-word"><input type="checkbox" value="${w.id}"> <b>${esc(w.term)}</b> <span class="hint">${esc(w.zh)}${w.attempts ? `　·　作答 ${w.attempts} 次` : ''}</span></label>`).join('') || '<p class="hint">這份沒有單字。</p>'}</div>
      <div class="row" style="margin-top:6px"><select class="ct-to" aria-label="移到哪一份"><option value="new">移到新字表…</option>${others.map(y => `<option value="${y.id}">移到「${esc(y.name)}」</option>`).join('')}</select>
        <input type="text" class="ct-newname" maxlength="60" placeholder="新字表名稱" aria-label="新字表名稱">
        <button type="button" class="primary" data-ct="move-ok">移動所選</button>
        <button type="button" class="linky danger" data-ct="remove">移除所選</button>
        <button type="button" class="linky" data-ct="cancel">關閉</button></div>
      <div class="ct-confirm"></div>`;
    const sel = extra.querySelector('.ct-to'), nn = extra.querySelector('.ct-newname');
    sel.addEventListener('change', () => { nn.hidden = sel.value !== 'new'; });
  } else if (act === 'move-ok'){
    const ids = [...extra.querySelectorAll('.ct-words input:checked')].map(i => Number(i.value));
    const to = extra.querySelector('.ct-to').value;
    const body = { from: id, wordIds: ids, ...(to === 'new' ? { newName: extra.querySelector('.ct-newname').value } : { to: Number(to) }) };
    const r = await artApi('/api/admin/wordset-move', { method: 'POST', body });
    if (!r.ok){ msg.textContent = r.json.message || '移動失敗'; return; }
    await loadContent(); ctRefreshOthers();
    const row2 = document.querySelector(`#ctWordsets .srow[data-id="${id}"] .srow-msg`);
    if (row2) row2.textContent = `已移動 ${r.json.moved} 個${r.json.skipped.length ? `；目標已有：${r.json.skipped.join('、')}（留在原處）` : ''}`;
  } else if (act === 'remove'){
    const ids = [...extra.querySelectorAll('.ct-words input:checked')].map(i => Number(i.value));
    const p = await artApi('/api/admin/wordset-remove', { method: 'POST', body: { from: id, wordIds: ids } });
    const box = extra.querySelector('.ct-confirm');
    if (p.status !== 409){ msg.textContent = p.json.message || '無法預覽'; return; }
    box.innerHTML = `<p class="hint" style="margin:6px 0">移除 ${p.json.words} 個單字？會一併刪掉 ${p.json.attempts} 筆作答、${p.json.progress} 筆熟練度，刪之前先備份。</p>
      <button type="button" class="primary danger" data-ct="remove-ok">確認移除</button>`;
  } else if (act === 'remove-ok'){
    const ids = [...extra.querySelectorAll('.ct-words input:checked')].map(i => Number(i.value));
    btn.disabled = true;
    const r = await artApi('/api/admin/wordset-remove', { method: 'POST', body: { from: id, wordIds: ids, confirm: true } });
    if (!r.ok){ msg.textContent = r.json.message || '移除失敗'; btn.disabled = false; return; }
    await loadContent(); ctRefreshOthers();
  } else if (act === 'merge'){
    const others = ctData[kind === 'wordset' ? 'wordsets' : 'articles'].filter(y => y.id !== id);
    extra.hidden = false;
    extra.innerHTML = others.length ? `<div class="row"><select class="ct-into" aria-label="併入哪一份">${others.map(y => `<option value="${y.id}">${esc(y.name)}</option>`).join('')}</select>
      <button type="button" class="primary" data-ct="merge-ok">把「${esc(x.name)}」併進去</button> <button type="button" class="linky" data-ct="cancel">取消</button></div>
      <p class="hint" style="margin:6px 0 0">${kind === 'wordset' ? '單字連同作答與熟練度一起搬過去；搬完這一份就刪掉。目標已有同字的會留在這份。' : '句子接在目標後面，這一份搬完就刪掉（目標已有的句子略過）。'}</p>` : '<p class="hint">沒有別的字表可以併入。</p>';
  } else if (act === 'merge-ok'){
    const into = Number(extra.querySelector('.ct-into').value);
    const r = await artApi(`/api/admin/${kind}-merge`, { method: 'POST', body: { from: [id], into } });
    if (!r.ok){ msg.textContent = r.json.message || '合併失敗'; return; }
    await loadContent(); ctRefreshOthers();
  } else if (act === 'sents'){
    await ctSentPanel(id, extra, msg);
  } else if (act === 'up' || act === 'down'){
    const lab = btn.closest('.ct-sent'), sib = act === 'up' ? lab.previousElementSibling : lab.nextElementSibling;
    if (!sib) return;
    act === 'up' ? sib.before(lab) : sib.after(lab);
    // 換位置後，把整個順序存起來
    const hashes = [...extra.querySelectorAll('.ct-sent')].map(l => l.dataset.hash);
    const r = await artApi('/api/admin/article-reorder', { method: 'POST', body: { id, hashes } });
    if (!r.ok){ msg.textContent = r.json.message || '調整失敗'; await ctSentPanel(id, extra, msg); return; }
    msg.textContent = '已存順序';
  } else if (act === 'smove-ok'){
    const hashes = [...extra.querySelectorAll('.ct-sent input:checked')].map(i => i.value);
    const to = extra.querySelector('.ct-to').value;
    const body = { from: id, hashes, ...(to === 'new' ? { newName: extra.querySelector('.ct-newname').value } : { to: Number(to) }) };
    const r = await artApi('/api/admin/article-move', { method: 'POST', body });
    if (!r.ok){ msg.textContent = r.json.message || '移動失敗'; return; }
    await loadContent(); ctRefreshOthers();
    const m2 = document.querySelector(`#ctArticles .srow[data-id="${id}"] .srow-msg`);
    if (m2) m2.textContent = `已移動 ${r.json.moved} 句${r.json.skipped ? `；${r.json.skipped} 句目標已有（留在原處）` : ''}`;
  } else if (act === 'sremove'){
    const hashes = [...extra.querySelectorAll('.ct-sent input:checked')].map(i => i.value);
    const p = await artApi('/api/admin/article-remove', { method: 'POST', body: { from: id, hashes } });
    if (p.status !== 409){ msg.textContent = p.json.message || '無法預覽'; return; }
    extra.querySelector('.ct-confirm').innerHTML = `<p class="hint" style="margin:6px 0">從這份拿掉 ${p.json.sentences} 句？${p.json.orphaned ? `其中 ${p.json.orphaned} 句沒有別的文章表在用，會變成「沒有範圍」。` : ''}句子分析留著。</p>
      <button type="button" class="primary danger" data-ct="sremove-ok">確認拿掉</button>`;
  } else if (act === 'sremove-ok'){
    const hashes = [...extra.querySelectorAll('.ct-sent input:checked')].map(i => i.value);
    btn.disabled = true;
    const r = await artApi('/api/admin/article-remove', { method: 'POST', body: { from: id, hashes, confirm: true } });
    if (!r.ok){ msg.textContent = r.json.message || '移除失敗'; btn.disabled = false; return; }
    await loadContent(); ctRefreshOthers();
  } else if (act === 'cancel'){
    extra.hidden = true; extra.innerHTML = '';
  }
}
for (const k of Object.values(CT_KINDS))
  el(k.box).addEventListener('click', e => { const b = e.target.closest('[data-ct]'); if (b) ctAct(b); });
