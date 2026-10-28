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
  } else if (act === 'cancel'){
    extra.hidden = true; extra.innerHTML = '';
  }
}
for (const k of Object.values(CT_KINDS))
  el(k.box).addEventListener('click', e => { const b = e.target.closest('[data-ct]'); if (b) ctAct(b); });
