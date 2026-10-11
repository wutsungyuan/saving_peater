// 後台的卷子編修：出好的卷子先是「草稿」，老師可以改名、換掉一題、刪掉一題，滿意了再發佈給學生。
// 已發佈的卷子在這裡是預覽（要改題目先「收回」成草稿，學生還沒開始作答才能收回）。
// 經典腳本（不是 ES module）：和其他 js/*.js 共用全域，由 index.html 依固定順序載入，順序不能換。

const PA = { paper: null, armed: null };          // 目前在編修的卷子（含答案的版本）

async function loadAdminPaper(id){
  pBox().innerHTML = `${pNav()}<p class="msg">讀取中…</p>`;
  const r = await artApi(`/api/paper?id=${id}&admin=1`);
  if (!r.ok){ loadHistory2(); return; }
  PA.paper = r.json; P.tab = 'run'; P.paper = null;
  renderAdminPaper();
  window.scrollTo({ top: 0 });
}

/** 一題的答案（老師看的） */
function adminAnswer(q){
  const label = v => (q.choices || []).find(c => String(c.value) === String(v))?.label ?? String(v);
  if (q.inputMode === 'choice') return (q.answer || []).map(label).join('、');
  if (q.inputMode === 'order') return (q.orders?.[0] ?? q.answer ?? []).join(' ');
  if (q.inputMode === 'open') return q.sample || (q.answer || []).join(' / ') || '（開放題，沒有固定答案）';
  return (q.answer || []).join(' / ');
}

function adminQCard(q, n, editable){
  const stem = q.display || q.sentence ? qDisplay(q) : esc(q.question ?? '');
  const choices = q.inputMode === 'choice' && q.choices && !['cloze', 'wbank', 'match'].includes(q.type)
    ? `<ol class="pa-choices" type="A">${q.choices.map(c => `<li class="${(q.answer || []).map(String).includes(String(c.value)) ? 'ok' : ''}">${esc(c.label)}</li>`).join('')}</ol>` : '';
  const chunks = q.inputMode === 'order' ? `<p class="hint">詞組：${(q.chunks || []).map(esc).join(' ／ ')}</p>` : '';
  const bound = Boolean(q.passageId);
  const canSwap = editable && !bound && ['mc', 'reorder', 'fix', 'fill', 'match', 'trans', 'make'].includes(q.section) && q.src !== 'ext-model';
  const acts = editable ? `<div class="row pa-acts">
      <button type="button" class="linky" data-ped="swap" data-qid="${q.id}" ${canSwap ? '' : `disabled title="${bound ? '和文章綁在一起，不能單題編修' : '模型出的延伸題只能刪掉'}"`}>換一題</button>
      <button type="button" class="linky danger" data-ped="remove" data-qid="${q.id}" ${bound ? 'disabled title="和文章綁在一起，不能單題編修"' : ''}>刪除</button></div>` : '';
  return `<article class="q p-q pa-q" id="pq-${q.id}">
    <div class="q-head"><span class="q-no">${n}</span><span class="q-prompt">${esc(q.prompt ?? '')}</span>${q.src && q.src !== 'scope' ? '<span class="tag t-prog">延伸</span>' : ''}<span class="p-pts">${fmtPts(q.pts)} 分</span></div>
    ${q.context ? `<div class="q-ctx"><span class="who">${esc(q.context.speaker || '對方')}</span>${esc(q.context.text)}</div>` : ''}
    ${q.type === 'trans' ? `<div class="q-zh">${esc(q.question ?? '')}</div>` : stem ? `<div class="q-sent">${stem}</div>` : ''}
    ${q.hint ? `<div class="q-hint">（${esc(q.hint)}）</div>` : ''}${choices}${chunks}
    <p class="pa-ans"><b>答案</b>　${esc(adminAnswer(q))}</p>
    ${q.explain ? `<details class="pa-exp"><summary>解說</summary><pre>${esc(q.explain)}</pre></details>` : ''}${acts}</article>`;
}

function renderAdminPaper(){
  const p = PA.paper, draft = p.status === 'draft', submitted = p.status === 'submitted';
  const total = p.sections.flatMap(s => s.questions).reduce((a, q) => a + q.pts, 0);
  let n = 0;
  const stateTag = draft ? '<span class="tag t-prog">草稿</span> 學生還看不到' : '<span class="tag t-model">已發佈</span> 學生可以作答；要改題目先收回';
  pBox().innerHTML = `${pNav()}
  <div class="box p-head pa-head">
    <div class="row"><label for="paTitle" class="hint">卷子名稱</label>
      <input type="text" id="paTitle" maxlength="60" value="${esc(p.title || '')}" placeholder="例如：第一單元複習">
      <button type="button" data-ped="rename">儲存名稱</button></div>
    <div class="row"><span class="hint">${stateTag}　${p.n} 題・${total === 100 ? '滿分 100 分' : `合計 ${fmtPts(total)} 分`}・${esc(p.settings.difficultyName || '')}</span></div>
    <div class="row">
      ${draft ? '<button type="button" class="primary" data-ped="publish">發佈給學生</button>' : submitted ? '' : '<button type="button" data-ped="unpublish">收回成草稿</button>'}
      <button type="button" class="linky" data-ped="print">列印試卷</button>
      <button type="button" class="linky" data-ped="back">← 回到列表</button>
      <span class="hint" id="paMsg"></span></div></div>
  ${p.sections.map((s, si) => `<section class="p-sec"><h3>第 ${['一', '二', '三', '四', '五', '六', '七', '八', '九', '十'][si] ?? si + 1} 部分　${esc(s.name)}<small>　每題 ${fmtPts(s.pts)} 分</small></h3>
    ${s.passages.filter(ps => s.questions.some(q => q.passageId === ps.id)).map(ps => `<div class="p-passage"><b>${esc(ps.title ?? '')}</b><p>${inlinePassage(ps.text)}</p>${ps.bank ? `<p class="hint">字庫：${ps.bank.map(esc).join('、')}</p>` : ''}</div>`).join('')}
    ${s.questions.map(q => adminQCard(q, ++n, draft)).join('')}</section>`).join('')}`;
}

pBox().addEventListener('click', async e => {
  const b = e.target.closest('[data-ped]'); if (!b || !PA.paper) return;
  const act = b.dataset.ped, msg = el('paMsg'), id = PA.paper.id;
  if (act === 'back'){ P.tab = 'history'; return loadHistory2(); }
  if (act === 'print'){ P.paper = PA.paper; printPaper(false); return; }
  if (act === 'remove' && PA.armed !== b.dataset.qid){      // 刪題要按兩次，第一次只是確認
    PA.armed = b.dataset.qid; b.textContent = '再按一次確定刪除';
    setTimeout(() => { if (PA.armed === b.dataset.qid){ PA.armed = null; b.textContent = '刪除'; } }, 4000);
    return;
  }
  PA.armed = null;
  b.disabled = true;
  const body = { id, action: act, questionId: b.dataset.qid, title: act === 'rename' ? el('paTitle').value : undefined };
  const r = await artApi('/api/paper-edit', { method: 'POST', body });
  if (!r.ok){ b.disabled = false; if (el('paMsg')) el('paMsg').textContent = r.json.message || '操作失敗'; return; }
  PA.paper = r.json.paper;
  const note = { rename: '已儲存名稱。', publish: '已發佈，學生現在可以作答。', unpublish: '已收回成草稿。', remove: '已刪除，分數重新分配為滿分 100。', swap: '已換成別的題。' }[act];
  renderAdminPaper();
  if (el('paMsg')) el('paMsg').textContent = note || '';
  if (act === 'swap') document.getElementById('pq-' + b.dataset.qid)?.scrollIntoView({ block: 'nearest' });
});
