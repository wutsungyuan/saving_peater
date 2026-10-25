// 測驗卷：出卷設定（範圍、題數、難度、題型、即時預覽）、作答（自動存檔、可續做）、交卷結果（錯的在前）、
// 自評、訂正（不影響統計）、歷史（快取，到期自動清除）、列印版面。
// 經典腳本（不是 ES module）：和其他 js/*.js 共用全域，由 index.html 依固定順序載入，順序不能換。

const P = {
  tab: 'setup',                       // setup | run | result | history
  sets: [], articles: [], availability: [], preview: null, previewErr: null,
  cfg: { setIds: [], articleIds: [], n: 40, difficulty: 'easy', mode: 'auto', types: [], saver: false, preferModel: false },
  paper: null, answers: {}, orderIdx: {}, saveTimer: null, previewTimer: null, saveState: '', busy: false,
};
const pBox = () => el('pr-paper');
const P_DIFF = {
  easy: ['簡單', '題目全部來自你選的範圍，不會多花額度。'],
  mid:  ['中等', '約 3 成是延伸題（和範圍有關聯的字與句子）：先用字族、易混淆字這類現成的關聯字，不夠才請模型出。'],
  hard: ['困難', '約 6 成是延伸題（和範圍有關聯的字與句子）：先用現成的關聯字，不夠才請模型出。'],
};
const P_TYPE_TAG = { p: '程式出題', m: '需要模型' };
const fmtPts = n => (Math.round(n * 2) / 2).toString();
const pOpenKey = 'analyzer-paper-open';
const rememberOpen = id => { try { id ? localStorage.setItem(pOpenKey, id) : localStorage.removeItem(pOpenKey); } catch {} };
const rememberedOpen = () => { try { return localStorage.getItem(pOpenKey); } catch { return null; } };

// ---- 導覽列：出卷／歷史 ----
const pNav = () => `<div class="subrow"><div class="subtabs" role="group" aria-label="測驗卷">
  <button data-pt="setup" class="admin-only" aria-pressed="${P.tab === 'setup' || P.tab === 'run' || P.tab === 'result'}">出卷</button>
  <button data-pt="exam" class="admin-only" aria-pressed="${P.tab === 'exam'}">考卷重現</button>
  <button data-pt="history" aria-pressed="${P.tab === 'history'}">歷史</button></div></div>`;

async function loadPaperHome(){
  if (API === false){ pBox().innerHTML = '<p class="msg">測驗卷需要本機後端。</p>'; return; }
  if (P.tab === 'run' && P.paper) return renderRun();
  if (P.tab === 'result' && P.paper) return renderResult();
  if (P.tab === 'history') return loadHistory2();
  if (P.tab === 'exam' && isAdminApp()) return renderExamImport();
  if (!isAdminApp()){ P.tab = 'history'; return loadHistory2(); }      // 前台只看卷子（學生與老師都一樣）；出卷在後台
  P.tab = 'setup';                                   // 走到這裡就是要顯示出卷設定頁（載入完成時若使用者已切去別頁就不重畫，見下面）
  pBox().innerHTML = '<p class="msg">讀取中…</p>';
  const [s, a, ol] = await Promise.all([
    fetch(`/api/wordsets?user=${encodeURIComponent(USER)}`).then(r => r.json()).catch(() => ({ sets: [] })),
    artApi('/api/articles').then(r => r.json?.articles ?? []).catch(() => []),
    artApi('/api/papers').then(r => (r.json?.papers ?? []).filter(p => p.status === 'open' && p.kind !== 'fix').reverse()).catch(() => null),
  ]);
  P.sets = s.sets ?? []; P.articles = a; P.openList = ol;
  if (P.tab !== 'setup') return;               // 載入的空檔裡使用者已經切去別頁（例如歷史），不要把設定頁蓋回去
  // 範圍預設選目前單字頁選的字表（沒有就不預選，讓使用者自己選）
  P.cfg.setIds = P.cfg.setIds.filter(id => P.sets.some(x => x.id === id));
  P.cfg.articleIds = P.cfg.articleIds.filter(id => P.articles.some(x => x.id === id));
  if (!P.cfg.setIds.length && !P.cfg.articleIds.length && typeof wsSel !== 'undefined' && wsSel.length) P.cfg.setIds = wsSel.filter(id => P.sets.some(x => x.id === id));
  renderSetup();
  schedulePreview(0);
}

// ================= 出卷設定 =================
function renderSetup(){
  const c = P.cfg, resume = rememberedOpen(), ol = P.openList;
  const chip = (kind, id, label) => `<button type="button" class="tchip" data-scope="${kind}" data-id="${id}" aria-pressed="${(kind === 'set' ? c.setIds : c.articleIds).includes(id)}">${esc(label)}</button>`;
  pBox().innerHTML = `${pNav()}
  <div class="box p-setup">
    <label>① 範圍（單字表、文章表各自勾選）</label>
    <div class="p-scope"><b>單字表</b><div class="row">${P.sets.length ? P.sets.map(s => chip('set', s.id, `${s.name}（${s.word_count} 字）`)).join('') : '<span class="hint">還沒有單字表，到「單字」建立。</span>'}</div></div>
    <div class="p-scope"><b>文章表</b><div class="row">${P.articles.length ? P.articles.map(a => chip('art', a.id, `${a.name}（${a.sentences} 句）`)).join('') : '<span class="hint">還沒有文章表，到「分析」填文章名稱建立。</span>'}</div></div>

    <label>② 題數：<output id="pNv">${c.n}</output> 題，滿分 100 分</label>
    <div class="row"><input type="range" id="pN" min="25" max="50" step="1" value="${c.n}" aria-label="題數"></div>

    <label>③ 難度（題目有多少比例來自你選的範圍）</label>
    <div class="row"><select id="pDiff" aria-label="難度">${Object.entries(P_DIFF).map(([k, [n]]) =>
      `<option value="${k}"${c.difficulty === k ? ' selected' : ''}>${n}${k === 'easy' ? '（100% 範圍內）' : k === 'mid' ? '（70% 範圍內、30% 延伸）' : '（40% 範圍內、60% 延伸）'}</option>`).join('')}</select>
      <span class="hint" id="pDiffNote">${P_DIFF[c.difficulty][1]}</span></div>

    <label>④ 題型</label>
    <div class="row p-mode"><label class="p-radio"><input type="radio" name="pMode" value="auto"${c.mode === 'auto' ? ' checked' : ''}> 自動配題（核心三塊一定出現，再隨機補）</label>
      <label class="p-radio"><input type="radio" name="pMode" value="custom"${c.mode === 'custom' ? ' checked' : ''}> 自選題型</label></div>
    <div class="row" id="pTypes" ${c.mode === 'custom' ? '' : 'hidden'}></div>

    <label>⑤ 進階</label>
    <div class="row"><label class="p-radio"><input type="checkbox" id="pSaver"${c.saver ? ' checked' : ''}> 省錢模式（不呼叫模型，只用程式出題與題庫現成的題）</label>
      <label class="p-radio"><input type="checkbox" id="pPrefer"${c.preferModel ? ' checked' : ''}> 延伸題偏好模型（內容更多樣，花費較高）</label></div>
  </div>
  <div class="box" id="pPreview"><p class="hint">選好範圍後，這裡會顯示配題與每題分數。</p></div>
  <div class="row"><button class="primary" id="pStart" disabled>開始出卷</button><span class="hint" id="pMsg"></span></div>`;
  renderTypes(); renderPreview();
}

function renderTypes(){
  const box = el('pTypes'); if (!box) return;
  const av = P.availability.length ? P.availability : [];
  box.innerHTML = av.map(a => `<button type="button" class="tchip p-type" data-type="${a.id}" aria-pressed="${P.cfg.types.includes(a.id) && a.ok}" ${a.ok ? '' : 'disabled'}
      title="${esc(a.reason || '')}">${esc(a.name)}${a.ok ? '' : `<small>（${esc(a.reason)}）</small>`}</button>`).join('') || '<span class="hint">先選範圍。</span>';
}

function schedulePreview(ms = 250){
  clearTimeout(P.previewTimer);
  const b = el('pStart'); if (b) b.disabled = true;      // 設定剛改過，報價還沒重算，先不讓按（不然會拿舊報價出卷）
  P.previewTimer = setTimeout(runPreview, ms);
}
async function runPreview(){
  const c = P.cfg;
  if (!c.setIds.length && !c.articleIds.length){ P.preview = null; P.previewErr = null; P.availability = []; renderTypes(); renderPreview(); return; }
  const r = await artApi('/api/paper-preview', { method: 'POST', body: { ...c, mode: c.mode, types: c.types } });
  P.availability = r.json.availability ?? [];
  if (!r.ok){ P.preview = null; P.previewErr = r.json.message || '預覽失敗'; }
  else { P.preview = r.json; P.previewErr = null; }
  // 自選題型：還沒勾過的話，預設勾選目前能出的
  if (c.mode === 'custom' && !c.types.length){
    const ok = P.availability.filter(a => a.ok).map(a => a.id);
    if (ok.length){ c.types = ok; return runPreview(); }            // 預設勾選目前能出的，再預覽一次
  }
  renderTypes(); renderPreview();
}

function renderPreview(){
  const box = el('pPreview'), start = el('pStart'); if (!box) return;
  if (!P.cfg.setIds.length && !P.cfg.articleIds.length){ box.innerHTML = '<p class="hint">請先在上面選一份單字表或文章表。</p>'; start.disabled = true; return; }
  if (P.previewErr){ box.innerHTML = `<p class="msg">${esc(P.previewErr)}</p>`; start.disabled = true; return; }
  const v = P.preview; if (!v){ box.innerHTML = '<p class="hint">計算配題中…</p>'; start.disabled = true; return; }
  const pl = v.plan, ex = pl.ext, sc = v.scope;
  box.innerHTML = `<label>配題與分數預覽</label>
  <div class="scroll"><table class="p-table"><thead><tr><th>題型</th><th>題數</th><th>每題</th><th>小計</th><th>延伸</th></tr></thead><tbody>${pl.rows.map(r => `<tr>
    <td>${esc(r.name)} <span class="tag ${r.model ? 't-model' : 't-prog'}">${r.model ? P_TYPE_TAG.m : P_TYPE_TAG.p}</span></td><td>${r.n}</td>
    <td>${fmtPts(r.pts)} 分${r.extra ? `<small>（${Math.abs(r.extra)} 題${r.extra > 0 ? '+' : '−'}0.5）</small>` : ''}</td><td>${fmtPts(r.sub)}</td>
    <td>${r.ext ? `${r.ext} 題<br><small>免費 ${r.extFree}${r.ext - r.extFree ? `、模型 ${r.ext - r.extFree}` : ''}</small>` : '—'}</td></tr>`).join('')}</tbody>
    <tfoot><tr><td><b>合計</b></td><td><b>${pl.N}</b></td><td></td><td><b>${fmtPts(pl.total)} 分</b></td><td>${ex.actual ? `${ex.actual} 題` : '—'}</td></tr></tfoot></table></div>
  <p class="hint">素材：單字 ${sc.words}、已分析句子 ${sc.sentences}、文章 ${sc.articles}、免費延伸字 ${sc.extWords}。${P.cfg.difficulty === 'easy' ? '難度簡單：全部題目來自你選的範圍，不增加任何模型呼叫。'
    : `目標延伸 ${ex.target} 題，實際 ${ex.actual} 題（其中免費 ${ex.free} 題）。`}</p>
  ${quoteHtml(v.quote)}
  ${pl.skipped?.length ? `<p class="hint">這些題型在這個範圍出不了，已略過：${pl.skipped.map(id => (P.availability.find(a => a.id === id)?.name ?? id)).join('、')}。</p>` : ''}
  ${pl.relax ? '<p class="hint">你選的題型數和題數不太搭，已放寬部分題型的題數範圍。</p>' : ''}`;
  start.disabled = P.busy;
  start.textContent = v.quote.calls ? `請模型出題並開始（約 US$${v.quote.estimate.low.toFixed(2)}–${v.quote.estimate.high.toFixed(2)}）` : '開始出卷';
}

function quoteHtml(q){
  if (!q || !q.calls) return '<p class="hint quote ok">💰 報價：<b>這份卷子不需要呼叫模型</b>（程式出題＋題庫現成的題），不花額度。</p>';
  const e = q.estimate, kind = { read: '閱讀測驗', cloze: '克漏字干擾項', ext: '延伸題' };
  return `<div class="quote"><p>💰 報價：要請模型出題 <b>${q.calls}</b> 次、約 ${q.questions} 題，預估 <b>US$${e.low.toFixed(2)}–${e.high.toFixed(2)}</b>、約 ${e.seconds} 秒（${e.unit === 'history' ? '依你最近的出題紀錄估算' : '還沒有出題紀錄，用預設單價估算'}；上限已含第一次呼叫的暖機成本）。</p>
    <p class="hint">${q.tasks.map(t => kind[t.kind] + (t.kind === 'ext' ? '' : '×1')).join('、')}。出過的題會存進題庫，之後的卷子優先重用，不會再收費。想完全不花額度就勾「省錢模式」。按下面的按鈕就代表同意。</p></div>`;
}

// ---- 設定區的互動 ----
pBox().addEventListener('click', e => {
  const t = e.target;
  const scope = t.closest('[data-scope]');
  if (scope){
    const id = Number(scope.dataset.id), list = scope.dataset.scope === 'set' ? P.cfg.setIds : P.cfg.articleIds;
    const i = list.indexOf(id); i >= 0 ? list.splice(i, 1) : list.push(id);
    scope.setAttribute('aria-pressed', String(i < 0)); P.cfg.types = []; schedulePreview(); return;
  }
  const ty = t.closest('.p-type');
  if (ty && !ty.disabled){
    const id = ty.dataset.type, i = P.cfg.types.indexOf(id); i >= 0 ? P.cfg.types.splice(i, 1) : P.cfg.types.push(id);
    ty.setAttribute('aria-pressed', String(i < 0)); schedulePreview(); return;
  }
  const act = t.closest('[data-act]')?.dataset.act;
  if (act) handlePaperAction(act, t.closest('[data-act]'));
  const nav = t.closest('[data-pt]');
  if (nav) { P.tab = nav.dataset.pt; nav.dataset.pt === 'history' ? loadHistory2() : nav.dataset.pt === 'exam' ? renderExamImport() : (P.paper && P.paper.status === 'open' ? (P.tab = 'run', renderRun()) : (P.tab = 'setup', loadPaperHome())); }
  if (t.id === 'pStart') startPaper();
});
pBox().addEventListener('input', e => {
  if (e.target.id === 'pN'){ P.cfg.n = Number(e.target.value); el('pNv').textContent = P.cfg.n; schedulePreview(); return; }
  onAnswerInput(e);
});
pBox().addEventListener('change', e => {
  const t = e.target;
  if (t.id === 'pDiff'){ P.cfg.difficulty = t.value; el('pDiffNote').textContent = P_DIFF[t.value][1]; schedulePreview(); }
  else if (t.name === 'pMode'){ P.cfg.mode = t.value; P.cfg.types = []; el('pTypes').hidden = t.value !== 'custom'; schedulePreview(0); }
  else if (t.id === 'pSaver'){ P.cfg.saver = t.checked; schedulePreview(); }
  else if (t.id === 'pPrefer'){ P.cfg.preferModel = t.checked; schedulePreview(); }
  else onAnswerInput(e);
});

async function startPaper(){
  if (!P.preview || P.busy) return;
  P.busy = true; el('pStart').disabled = true;
  const q = P.preview.quote, c = P.cfg;
  el('pMsg').textContent = q?.calls ? `請模型出題中…約 ${q.estimate.seconds} 秒，請不要關閉頁面` : '出卷中…';
  const r = await artApi('/api/papers', { method: 'POST', body: { ...c, userToken: USER, seed: P.preview.seed, confirm: Boolean(q?.calls), draft: isAdminApp() } });      // 老師出卷先存成草稿，編修後再發佈
  P.busy = false;
  if (!r.ok){ el('pStart').disabled = false; el('pMsg').textContent = r.json.message || ('出卷失敗：' + (r.json.error || r.status)); return; }
  const m = r.json.model;
  if (m?.error) alert(`模型出題中斷（${m.error.kind === 'rate-limit' ? '額度用盡' : m.error.message}）。卷子已用現有的題目出好，沒有出成功的題型已自動略過。`);
  openPaper(r.json.paper);
}
function openPaper(paper){
  if (!isAdminApp() && paper.status === 'draft') return loadHistory2();                      // 草稿不能在前台作答
  if (isAdminApp() && paper.status !== 'submitted') return loadAdminPaper(paper.id);        // 後台：草稿與已發佈的是編修／預覽，不是作答
  P.paper = paper; P.answers = { ...(paper.answers || {}) }; P.orderIdx = {}; P.saveState = '';
  P.tab = paper.status === 'submitted' ? 'result' : 'run';
  rememberOpen(paper.status === 'open' ? paper.id : null);
  paper.status === 'submitted' ? renderResult() : renderRun();
  window.scrollTo({ top: 0 });
}

function handlePaperAction(act, node){
  if (act === 'resume'){ artApi(`/api/paper?id=${node?.dataset.id || rememberedOpen()}`).then(r => r.ok ? openPaper(r.json) : (rememberOpen(null), loadPaperHome())); }
}

// ================= 作答 =================
const labelOf = (q, v) => (q.choices || []).find(c => String(c.value) === String(v))?.label ?? String(v ?? '');
const flatQs = paper => paper.sections.flatMap(s => s.questions);

function inlinePassage(text){
  return esc(text).replace(/\((\d+)\)/g, '<b class="p-blank">($1)</b>').replace(/\n\n/g, '</p><p>').replace(/\n/g, '<br>');   // 對話：每次發言一行
}

function qBody(q, ans){
  if (q.inputMode === 'choice'){
    if (['cloze', 'wbank', 'match'].includes(q.type))
      return `<select data-q="${q.id}" aria-label="第 ${q.blankNo ?? ''} 題"><option value="">請選擇</option>${q.choices.map(c =>
        `<option value="${esc(c.value)}"${ans?.[0] != null && String(ans[0]) === String(c.value) ? ' selected' : ''}>${esc(c.label)}</option>`).join('')}</select>`;
    return `<div class="q-opts">${q.choices.map(c => `<label class="q-opt"><input type="radio" name="${q.id}" data-q="${q.id}" value="${esc(c.value)}"${ans?.[0] != null && String(ans[0]) === String(c.value) ? ' checked' : ''}> ${esc(c.label)}</label>`).join('')}</div>`;
  }
  if (q.inputMode === 'text')
    return `<div class="q-blanks">${Array.from({ length: q.blanks || 1 }, (_, i) => `<input type="text" data-q="${q.id}" data-i="${i}" autocomplete="off" autocapitalize="off" spellcheck="false"
      value="${esc(ans?.[i] ?? '')}" placeholder="${q.blanks > 1 ? `第 ${i + 1} 格` : '填入答案'}">`).join('')}</div>`;
  if (q.inputMode === 'open')
    return `<textarea data-q="${q.id}" rows="2" autocapitalize="sentences" spellcheck="false" placeholder="${q.type === 'trans' ? '寫出英文句子' : '寫一個完整的句子'}">${esc(ans?.[0] ?? '')}</textarea>`;
  if (q.inputMode === 'order'){
    const used = P.orderIdx[q.id] ?? (P.orderIdx[q.id] = restoreOrder(q, ans));
    return `<div class="p-order" data-order="${q.id}"><div class="p-line" aria-label="你排的順序">${used.length ? used.map(i => `<button type="button" class="p-chunk on" data-take="${i}">${esc(q.chunks[i])}</button>`).join('') : '<span class="hint">點下面的詞組，依序排成句子</span>'}</div>
      <div class="p-bank">${q.chunks.map((c, i) => `<button type="button" class="p-chunk" data-put="${i}" ${used.includes(i) ? 'disabled' : ''}>${esc(c)}</button>`).join('')}</div>
      <button type="button" class="linky" data-reset="${q.id}">重排</button></div>`;
  }
  return '';
}
function restoreOrder(q, ans){
  const idx = [], taken = new Set();
  for (const t of ans ?? []){ const i = q.chunks.findIndex((c, k) => c === t && !taken.has(k)); if (i >= 0){ idx.push(i); taken.add(i); } }
  return idx;
}

function qCard(q, n, ans, { showPts = true } = {}){
  const sample = q.display || q.sentence ? `<div class="q-sent">${qDisplay(q)}</div>`      // 句子練習引擎出的題（會標出要問的字）
    : q.type === 'trans' ? `<div class="q-zh">${esc(q.question ?? '')}</div>`                // 翻譯：中文題幹
    : q.question ? `<div class="q-sent">${esc(q.question)}</div>` : '';
  return `<article class="q p-q" id="pq-${q.id}" data-qcard="${q.id}">
    <div class="q-head"><span class="q-no">${n}</span><span class="q-prompt">${esc(q.prompt ?? '')}</span>${q.src && q.src !== 'scope' ? '<span class="tag t-prog">延伸</span>' : ''}${showPts ? `<span class="p-pts">${fmtPts(q.pts)} 分</span>` : ''}</div>
    ${q.context ? `<div class="q-ctx"><span class="who">${esc(q.context.speaker || '對方')}</span>${esc(q.context.text)}</div>` : ''}
    ${sample}${q.hint ? `<div class="q-hint">（${esc(q.hint)}）</div>` : ''}${qBody(q, ans)}</article>`;
}

/** 克漏字、文意選填：空格很多，每格各占一張卡片太長，改成一張卡片裡的緊湊列表 */
function qRows(s, start){
  return `<article class="q p-q p-cloze">${s.questions.map((q, i) => `<div class="p-brow" id="pq-${q.id}" data-qcard="${q.id}">
    <span class="q-no">${start + i}</span><b class="p-blank">(${q.blankNo})</b>${qBody(q, P.answers[q.id])}<span class="p-pts">${fmtPts(q.pts)} 分</span></div>`).join('')}</article>`;
}
function answeredCount(){ return flatQs(P.paper).filter(q => (P.answers[q.id] || []).some(x => String(x).trim())).length; }
function updateProgress(){ const e = el('pProgress'); if (e) e.textContent = `已作答 ${answeredCount()} / ${P.paper.n}`; const s = el('pSave'); if (s) s.textContent = P.saveState; }

function renderRun(){
  const paper = P.paper, fix = paper.kind === 'fix';
  let n = 0;
  pBox().innerHTML = `${pNav()}
  <div class="box p-head"><div><b>${fix ? '訂正' : `${esc(paper.settings.difficultyName || '')}・${paper.n} 題・滿分 100 分`}</b>
    <span class="hint" id="pProgress"></span><span class="hint" id="pSave"></span></div>
    <div class="row"><button class="linky" type="button" data-act2="print">列印試卷</button></div></div>
  ${fix ? '<p class="hint">訂正不影響統計，也不改變原卷的分數。</p>' : ''}
  ${paper.sections.map((s, si) => `<section class="p-sec"><h3>${fix ? '' : `第 ${['一', '二', '三', '四', '五', '六', '七', '八', '九', '十'][si] ?? si + 1} 部分　`}${esc(s.name)}${s.pts ? `<small>　每題 ${fmtPts(s.pts)} 分</small>` : ''}</h3>
    ${s.passages.filter(p => s.questions.some(q => q.passageId === p.id)).map(p => `<div class="p-passage"><b>${esc(p.title ?? '')}</b><p>${inlinePassage(p.text)}</p>${p.bank ? `<p class="hint">字庫：${p.bank.map(esc).join('、')}</p>` : ''}</div>`).join('')}
    ${['cloze', 'wbank'].includes(s.id) ? (() => { const start = n + 1; n += s.questions.length; return qRows(s, start); })()
      : s.questions.map(q => qCard(q, ++n, P.answers[q.id], { showPts: !fix })).join('')}</section>`).join('')}
  <div class="row"><button class="primary" id="pSubmit">交卷</button><span class="hint" id="pSubMsg"></span></div>`;
  updateProgress();
}

// ---- 作答的輸入、自動存檔 ----
function onAnswerInput(e){
  const t = e.target, qid = t.dataset?.q; if (!qid || !P.paper || P.tab !== 'run') return;
  if (t.type === 'radio' || t.tagName === 'SELECT') P.answers[qid] = t.value === '' ? [] : [t.value];
  else if (t.tagName === 'TEXTAREA') P.answers[qid] = [t.value];
  else if (t.type === 'text'){
    const i = Number(t.dataset.i || 0), a = P.answers[qid] ? [...P.answers[qid]] : [];
    while (a.length < i) a.push('');                                  // 補空字串，不留空洞
    a[i] = t.value; P.answers[qid] = a;
  }
  scheduleSave();
}
function scheduleSave(){
  P.saveState = '儲存中…'; updateProgress();
  clearTimeout(P.saveTimer);
  P.saveTimer = setTimeout(saveNow, 800);
}
async function saveNow(){
  if (!P.paper || P.paper.status !== 'open') return;
  clearTimeout(P.saveTimer);
  const r = await artApi('/api/paper-save', { method: 'POST', body: { id: P.paper.id, answers: P.answers } });
  P.saveState = r.ok ? '已自動儲存' : '儲存失敗，請確認連線'; updateProgress();
}
window.addEventListener('pagehide', () => { if (P.paper?.status === 'open' && P.saveTimer) navigator.sendBeacon?.(`/api/paper-save${TOKEN ? '?token=' + encodeURIComponent(TOKEN) : ''}`, new Blob([JSON.stringify({ id: P.paper.id, answers: P.answers })], { type: 'application/json' })); });

// 排序題：點詞組放進答案、點答案裡的詞組拿回來
pBox().addEventListener('click', e => {
  const put = e.target.closest('[data-put]'), take = e.target.closest('[data-take]'), reset = e.target.closest('[data-reset]');
  const host = e.target.closest('[data-order]'); if (!host || !P.paper) return;
  const qid = host.dataset.order, q = flatQs(P.paper).find(x => x.id === qid), used = P.orderIdx[qid] ?? (P.orderIdx[qid] = []);
  if (put) used.push(Number(put.dataset.put));
  else if (take){ const i = used.indexOf(Number(take.dataset.take)); if (i >= 0) used.splice(i, 1); }
  else if (reset) used.length = 0;
  else return;
  P.answers[qid] = used.map(i => q.chunks[i]);
  host.outerHTML = qBody(q, P.answers[qid]);
  scheduleSave();
});

// ================= 交卷與結果 =================
pBox().addEventListener('click', async e => {
  if (e.target.id === 'pSubmit'){
    const left = P.paper.n - answeredCount(), b = e.target;
    if (left > 0 && b.dataset.armed !== '1'){ b.dataset.armed = '1'; b.textContent = `還有 ${left} 題沒作答，再按一次確定交卷`; setTimeout(() => { b.dataset.armed = '0'; b.textContent = '交卷'; }, 5000); return; }
    b.disabled = true; el('pSubMsg').textContent = '批改中…';
    clearTimeout(P.saveTimer);
    const r = await artApi('/api/paper-submit', { method: 'POST', body: { id: P.paper.id, answers: P.answers, userToken: USER } });
    if (!r.ok){ b.disabled = false; el('pSubMsg').textContent = r.json.message || '交卷失敗'; return; }
    rememberOpen(null); P.paper = r.json.paper; P.tab = 'result'; renderResult(); window.scrollTo({ top: 0 });
  }
  if (e.target.id === 'pAi'){
    e.target.disabled = true; el('pAiMsg').textContent = '算報價中…';
    const q = await artApi('/api/paper-ai-grade', { method: 'POST', body: { id: P.paper.id } });
    if (q.status === 202){ el('pAiMsg').textContent = '已送出申請，老師核准後會批改，結果在「我的申請」。'; return; }
    if (q.status !== 409){ e.target.disabled = false; el('pAiMsg').textContent = q.json.message || '無法批改'; return; }
    const est = q.json.quote.estimate;
    el('pAiBox').insertAdjacentHTML('beforeend', `<div class="quote" id="pAiQuote"><p>💰 報價：一次呼叫批改 <b>${q.json.quote.count}</b> 題，預估 <b>US$${est.low.toFixed(2)}–${est.high.toFixed(2)}</b>、約 ${est.seconds} 秒（${est.unit === 'history' ? '依你最近的批改紀錄估算' : '還沒有批改紀錄，用預設單價估算'}；上限已含第一次呼叫的暖機成本）。</p>
      <div class="row"><button class="primary" type="button" id="pAiGo">確定，請 AI 批改</button><button class="linky" type="button" id="pAiNo">取消</button></div></div>`);
    el('pAiMsg').textContent = '';
    el('pAiNo').onclick = () => { el('pAiQuote').remove(); el('pAi').disabled = false; };
    el('pAiGo').onclick = async () => {
      el('pAiGo').disabled = true; el('pAiNo').disabled = true; el('pAiMsg').textContent = `批改中…約 ${est.seconds} 秒，請不要離開`;
      const r = await artApi('/api/paper-ai-grade', { method: 'POST', body: { id: P.paper.id, confirm: true } });
      if (!r.ok){ el('pAiQuote')?.remove(); el('pAi').disabled = false; el('pAiMsg').textContent = r.json.message || '批改失敗'; return; }
      P.paper = r.json.paper; renderResult();
      el('pFixMsg').textContent = `AI 批改完成：${r.json.graded} 題${r.json.missing?.length ? `（${r.json.missing.length} 題沒批改到，請自評）` : ''}，花費約 US$${(r.json.costUsd || 0).toFixed(3)}。`;
    };
    return;
  }
  const mk = e.target.closest('[data-mark]');
  if (mk){
    const r = await artApi('/api/paper-self', { method: 'POST', body: { id: P.paper.id, marks: { [mk.dataset.qid]: mk.dataset.mark === '1' } } });
    if (r.ok){ P.paper = r.json.paper; renderResult(); document.getElementById('res-' + mk.dataset.qid)?.scrollIntoView({ block: 'center' }); }
  }
  const act2 = e.target.closest('[data-act2]')?.dataset.act2;
  if (act2 === 'print') printPaper(false);
  if (act2 === 'print-ans') printPaper(true);
  if (act2 === 'newpaper') { saveNow().finally(() => { P.tab = 'setup'; P.paper = null; loadPaperHome(); }); }
  if (act2 === 'fix') startFix();
  if (act2 === 'again') { P.tab = 'setup'; P.paper = null; loadPaperHome(); }
  if (act2 === 'to-setup') { P.tab = 'setup'; loadPaperHome(); }
});

function fmtGiven(q, g){
  if (!g?.length || g.every(x => !String(x).trim())) return '（沒作答）';
  return q.inputMode === 'choice' ? labelOf(q, g[0]) : q.inputMode === 'order' ? g.join(' ') : g.join(' / ');
}
function fmtExpected(q, it){
  if (q.inputMode === 'choice') return labelOf(q, it.expected?.[0]);
  if (q.type === 'make') return it.reference ? `（自由發揮）參考：${it.reference}` : '（自由發揮）';
  return (it.expected ?? []).join(' / ');
}

/** 請 AI 批改造句與翻譯：選用。先報價、你確認才呼叫（一次呼叫批改全部）。 */
function aiCount(r){ return r.items.filter(it => (it.type === 'make' || it.type === 'trans') && !it.ai && (it.given || []).some(x => String(x).trim())).length; }
function aiBox(r){
  if (P.paper.kind === 'fix') return '';
  const n = aiCount(r), done = r.items.filter(it => it.ai).length;
  if (!n) return done ? `<p class="hint">造句與翻譯已由 AI 批改（${done} 題）。你仍然可以在每題改自評。</p>` : '';
  if (isStudentRole()) return `<div class="box" id="pAiBox"><p style="margin:0">造句和翻譯有 <b>${n}</b> 題，程式只能做基本檢查。想要更準確的批改，可以請老師核准後由 AI 批改。</p>
    <div class="row"><button type="button" id="pAi">申請 AI 批改（${n} 題）</button><span class="hint" id="pAiMsg">不申請就維持自評。</span></div></div>`;
  return `<div class="box" id="pAiBox"><p style="margin:0">造句和翻譯有 <b>${n}</b> 題，程式只能做基本檢查。想要更準確的批改，可以請 AI 看一次（選用）。</p>
    <div class="row"><button type="button" id="pAi">請 AI 批改（${n} 題）</button><span class="hint" id="pAiMsg">先顯示報價，你確認才會呼叫模型；不按就維持自評，不花額度。</span></div></div>`;
}

function renderResult(){
  const paper = P.paper, r = paper.result, fix = paper.kind === 'fix';
  const qs = Object.fromEntries(flatQs(paper).map((q, i) => [q.id, { ...q, no: i + 1 }]));
  const okOf = it => it.correct === true || it.marked === true;
  const wrong = r.order.filter(id => { const it = r.items.find(x => x.id === id); return !okOf(it) && !it.pending; });
  const pending = r.order.filter(id => r.items.find(x => x.id === id).pending);
  const right = r.order.filter(id => okOf(r.items.find(x => x.id === id)));
  const card = id => {
    const it = r.items.find(x => x.id === id), q = qs[id], good = okOf(it);
    return `<article class="p-res ${good ? 'good' : it.pending ? 'pend' : 'bad'}" id="res-${id}">
      <div class="q-head"><span class="q-no">${q.no}</span><span class="badge ${good ? '' : 'warn'}">${good ? '答對' : it.pending ? '待自評' : '答錯'}</span>
        <span class="q-prompt">${esc(q.prompt ?? '')}</span><span class="p-pts">${fmtPts(it.earned)} / ${fmtPts(it.pts)} 分</span></div>
      ${q.question != null || q.display || q.sentence ? `<div class="${q.type === 'trans' ? 'q-zh' : 'q-sent'}">${q.display || q.sentence ? qDisplay(q) : esc(q.question)}</div>` : ''}
      <p class="p-line2"><b>你的答案</b>　${esc(fmtGiven(q, it.given))}</p>
      ${good && !it.pending ? '' : `<p class="p-line2"><b>參考答案</b>　${esc(fmtExpected(q, it))}</p>`}
      ${it.ai ? `<p class="p-ai"><span class="tag t-model">AI 批改</span>　${esc(it.ai.comment || '')}${it.ai.fix ? `<br><b>建議寫法</b>　${esc(it.ai.fix)}` : ''}</p>` : ''}
      ${it.checks ? `<p class="hint">${it.checks.map(c => `${c.ok ? '✓' : '✗'} ${esc(c.label)}`).join('　')}${it.suggest === 'likely' ? '　（看起來不錯，仍請自己確認）' : ''}</p>` : ''}
      ${it.explain && !good ? `<p class="p-expl">${esc(it.explain)}</p>` : ''}
      ${q.inputMode === 'open' ? `<div class="row"><span class="hint">自評：</span><button type="button" class="${it.marked === true ? 'primary' : ''}" data-mark="1" data-qid="${id}">我答對了</button>
        <button type="button" class="${it.marked === false ? 'primary' : ''}" data-mark="0" data-qid="${id}">沒答對</button></div>` : ''}</article>`;
  };
  pBox().innerHTML = `${pNav()}
  <div class="box p-score"><div class="p-big">${fix ? `${r.right} / ${r.items.length}` : `${fmtPts(r.score)}<small> / ${fmtPts(r.total)}</small>`}</div>
    <div>${fix ? '<b>訂正結果</b>　改對的題數。訂正不影響統計，也不改變原卷分數。' : `<b>${esc(paper.settings.difficultyName || '')}・${paper.n} 題</b>　答對 ${r.right}　答錯 ${r.wrong}${r.pending ? `　待自評 ${r.pending}` : ''}`}</div></div>
  ${fix ? '' : `<div class="scroll"><table class="p-table"><thead><tr><th>題型</th><th>得分</th><th>答對</th><th>答錯</th></tr></thead><tbody>${r.bySection.map(s => `<tr><td>${esc(s.name)}</td><td>${fmtPts(s.score)} / ${fmtPts(s.total)}</td><td>${s.right}</td><td>${s.wrong}${s.pending ? `（待自評 ${s.pending}）` : ''}</td></tr>`).join('')}</tbody></table></div>`}
  ${pending.length ? `<div class="box p-note">有 ${pending.length} 題（造句、翻譯）要由你自評：看過參考答案後，標「我答對了」或「沒答對」，分數會更新。自評不計入弱點統計。</div>` : ''}
  ${aiBox(r)}
  <div class="row"><button class="primary" data-act2="fix" ${wrong.length + pending.filter(id => r.items.find(x => x.id === id).marked === false).length || wrong.length ? '' : 'disabled'}>訂正錯題</button>
    <button data-act2="print-ans">列印答案卷</button><button data-act2="again" class="admin-only">再出一份</button><button data-act2="to-setup" class="admin-only">回到出卷</button></div>
  <p class="hint" id="pFixMsg"></p>
  ${wrong.length ? `<h3 class="p-h">答錯的題（${wrong.length}）</h3>${wrong.map(card).join('')}` : ''}
  ${pending.length ? `<h3 class="p-h">待自評（${pending.length}）</h3>${pending.map(card).join('')}` : ''}
  ${right.length ? `<details class="p-right"><summary>答對的題（${right.length}）</summary>${right.map(card).join('')}</details>` : ''}`;
}

async function startFix(){
  const r = await artApi('/api/paper-redo', { method: 'POST', body: { id: P.paper.id } });
  if (!r.ok){ el('pFixMsg').textContent = r.json.message || '無法訂正'; return; }
  openPaper(r.json.paper);
}

// ================= 歷史 =================
async function loadHistory2(){
  P.tab = 'history';
  pBox().innerHTML = `${pNav()}<p class="msg">讀取中…</p>`;
  const r = await artApi('/api/papers');
  if (!r.ok){ pBox().innerHTML = `${pNav()}<p class="msg">讀不到歷史。</p>`; return; }
  const names = ids => ids?.length ? ids.map(id => P.sets.find(s => s.id === id)?.name ?? P.articles.find(a => a.id === id)?.name ?? `#${id}`).join('、') : '';
  const list = isAdminApp() ? r.json.papers : r.json.papers.filter(p => p.status !== 'draft');       // 草稿還沒發佈，前台（連老師登入也一樣）不列、不能作答；要到後台編修、發佈
  // 訂正卷歸在原卷底下：主列表只列主測驗，點「訂正紀錄」才展開；原卷已不在列表裡的訂正卷（過期、被刪）才單獨列出
  // 訂正卷還可以再訂正（from 指向上一份訂正卷），所以一路往上追到列表裡最上層的那份，整串都歸在它底下（由舊到新）
  const byId = new Map(list.map(p => [p.id, p]));
  const rootOf = p => { let c = p, hops = 0; while (c.kind === 'fix' && c.from && byId.has(c.from) && hops++ < 50) c = byId.get(c.from); return c; };
  const fixesOf = new Map();
  for (const p of [...list].reverse()) { const r = rootOf(p); if (r !== p) fixesOf.set(r.id, [...(fixesOf.get(r.id) ?? []), p]); }
  const mains = list.filter(p => rootOf(p) === p);
  P.openFix ??= new Set();
  const row = (p, root = null) => {
    const fx = fixesOf.get(p.id) ?? [], open = P.openFix.has(p.id);
    return `<tr${root ? ` class="p-child" data-fixof="${root.id}"${P.openFix.has(root.id) ? '' : ' hidden'}` : ''}>
    <td>${new Date(p.createdAt).toLocaleString('zh-TW', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' })}</td>
    <td>${p.kind === 'fix' ? '<span class="tag t-model">訂正</span> ' : ''}${p.pinned ? '<span class="tag t-prog" title="不會過期">📌 釘選</span> ' : ''}${p.title ? `<b>${esc(p.title)}</b> <small>（${p.n} 題・${esc(p.difficultyName || '')}）</small>` : `${p.n} 題${p.kind === 'fix' ? '' : `・${esc(p.difficultyName || '')}`}`}<br><small>${esc(names([...(p.setIds || []), ...(p.articleIds || [])]))}</small>${fx.length ? `<br><button class="linky" data-fixtoggle="${p.id}" data-n="${fx.length}" aria-expanded="${open}">${open ? '▾' : '▸'} 訂正紀錄（${fx.length}）</button>` : ''}</td>
    <td>${p.status === 'draft' ? '<span class="tag t-prog">草稿</span>' : p.status === 'submitted' ? (p.kind === 'fix' ? '已完成' : `<b>${fmtPts(p.score)}</b> 分`) : (isAdminApp() ? '已發佈・作答中' : '作答中')}</td>
    <td><button class="linky" data-open="${p.id}">${p.status === 'draft' ? '編輯' : p.status === 'submitted' ? (isAdminApp() ? '看作答' : '看結果') : isAdminApp() ? '預覽' : '繼續'}</button>${p.status === 'draft' ? ` <button class="linky admin-only" data-pub="${p.id}">發佈</button>` : ''} <button class="linky danger admin-only" data-del="${p.id}">刪除</button>${isAdminApp() && p.kind !== 'fix' ? `<br>${p.status === 'submitted' ? `<button class="linky" data-retake="${p.id}">再考一次</button> ` : ''}<button class="linky" data-pin="${p.id}" data-on="${p.pinned ? 1 : 0}">${p.pinned ? '取消釘選' : '釘選'}</button>` : ''}</td></tr>`;
  };
  pBox().innerHTML = `${pNav()}${mains.length ? `<div class="scroll"><table class="p-table"><thead><tr><th>時間</th><th>內容</th><th>狀態</th><th></th></tr></thead><tbody>${mains.map(p => row(p) + (fixesOf.get(p.id) ?? []).map(c => row(c, p)).join('')).join('')}</tbody></table></div>`
    : '<div class="box"><p style="margin:0">還沒有出過卷子。</p></div>'}
  <p class="hint" id="pHistMsg"></p>
  <p class="hint">歷史只用快取存放：保留 ${r.json.keepDays} 天、最近 20 份，到期自動清除（釘選的不會）。答題統計（弱點）另外保存，不會跟著清除。</p>`;
}
pBox().addEventListener('click', async e => {
  const pub = e.target.closest('[data-pub]');
  if (pub){ const r = await artApi('/api/paper-edit', { method: 'POST', body: { id: pub.dataset.pub, action: 'publish' } }); if (!r.ok) alert(r.json.message || '發佈失敗'); return loadHistory2(); }
  const tg = e.target.closest('[data-fixtoggle]');
  if (tg){                                                                                  // 展開／收合這份卷子的訂正紀錄
    const id = tg.dataset.fixtoggle, on = !P.openFix?.has(id);
    (P.openFix ??= new Set())[on ? 'add' : 'delete'](id);
    pBox().querySelectorAll(`[data-fixof="${id}"]`).forEach(r => { r.hidden = !on; });
    tg.setAttribute('aria-expanded', String(on)); tg.textContent = `${on ? '▾' : '▸'} 訂正紀錄（${tg.dataset.n}）`;
    return;
  }
  const pn = e.target.closest('[data-pin]');
  if (pn){                                                                                  // 釘選／取消釘選：釘選的不會過期
    pn.disabled = true;
    const r = await artApi('/api/paper-pin', { method: 'POST', body: { id: pn.dataset.pin, pinned: pn.dataset.on !== '1' } });
    if (!r.ok){ pn.disabled = false; const m = el('pHistMsg'); if (m) m.textContent = r.json.message || '釘選失敗'; return; }
    return loadHistory2();
  }
  const rt = e.target.closest('[data-retake]');
  if (rt){                                                                                  // 整份重考：沿用題目、重新打亂選項，直接發佈給學生
    if (rt.dataset.armed !== '1'){ rt.dataset.armed = '1'; rt.textContent = '再按一次：發佈給學生'; setTimeout(() => { rt.dataset.armed = '0'; rt.textContent = '再考一次'; }, 5000); return; }
    rt.disabled = true; rt.textContent = '發佈中…';
    const r = await artApi('/api/paper-retake', { method: 'POST', body: { id: rt.dataset.retake } });
    if (!r.ok){ rt.disabled = false; rt.textContent = '再考一次'; const m = el('pHistMsg'); if (m) m.textContent = r.json.message || '重考失敗'; return; }
    await loadHistory2();
    const m = el('pHistMsg'); if (m) m.textContent = `已發佈「${r.json.title}」，學生那邊的測驗卷就看得到了（選項順序已重新打亂）。`;
    return;
  }
  const o = e.target.closest('[data-open]'), d = e.target.closest('[data-del]');
  if (o){ const r = await artApi(`/api/paper?id=${o.dataset.open}`); if (r.ok) openPaper(r.json); else loadHistory2(); }
  if (d){
    if (d.dataset.armed !== '1'){ d.dataset.armed = '1'; d.textContent = '再按一次確定'; setTimeout(() => { d.dataset.armed = '0'; d.textContent = '刪除'; }, 4000); return; }
    await artApi(`/api/papers?id=${d.dataset.del}`, { method: 'DELETE' });
    if (rememberedOpen() === d.dataset.del) rememberOpen(null);
    loadHistory2();
  }
});

// ================= 列印（試卷與答案卷）=================
function printPaper(withAnswers){
  const paper = P.paper; if (!paper) return;
  const r = paper.result; let n = 0;
  const html = `<div id="p-print"><h2>英文測驗卷${withAnswers ? '（答案卷）' : ''}</h2>
    <p>姓名：__________　　日期：__________　　${withAnswers && r ? `得分：${fmtPts(r.score)} / ${fmtPts(r.total)}` : `滿分 100 分，共 ${paper.n} 題`}</p>
    ${paper.sections.map((s, si) => `<section><h3>${['一', '二', '三', '四', '五', '六', '七', '八', '九', '十'][si] ?? si + 1}、${esc(s.name)}（每題 ${fmtPts(s.pts)} 分）</h3>
      ${s.passages.filter(p => s.questions.some(q => q.passageId === p.id)).map(p => `<div class="pp-passage"><b>${esc(p.title ?? '')}</b><p>${inlinePassage(p.text)}</p>${p.bank ? `<p>字庫：${p.bank.map(esc).join('、')}</p>` : ''}</div>`).join('')}
      ${s.questions.map(q => { n++; const it = r?.items.find(x => x.id === q.id);
        return `<div class="pp-q">${q.context ? `<p class="pp-ctx"><i>${esc(q.context.speaker || '對方')}：${esc(q.context.text)}</i></p>` : ''}<p><b>${n}.</b> ${esc(q.prompt ?? '')}${q.display || q.sentence ? qDisplay(q) : esc(q.question ?? '')}${q.hint ? `（${esc(q.hint)}）` : ''}</p>
        ${q.inputMode === 'choice' ? (['cloze', 'wbank', 'match'].includes(q.type) ? '<p>答：______</p>' : `<p class="pp-opts">${q.choices.map((c, i) => `(${'ABCD'[i]}) ${esc(c.label)}`).join('　')}</p>`)
          : q.inputMode === 'order' ? `<p>${q.chunks.map(esc).join(' ／ ')}</p><p>答：________________________________</p>`
          : '<p>答：________________________________</p>'}
        ${withAnswers && it ? `<p class="pp-ans">答案：${esc(q.inputMode === 'choice' ? labelOf(q, it.expected?.[0]) : fmtExpected(q, it))}　（你的答案：${esc(fmtGiven(q, it.given))}）</p>` : ''}</div>`; }).join('')}</section>`).join('')}</div>`;
  document.body.insertAdjacentHTML('beforeend', html);
  document.body.classList.add('p-printing');
  const done = () => { document.getElementById('p-print')?.remove(); document.body.classList.remove('p-printing'); window.removeEventListener('afterprint', done); };
  window.addEventListener('afterprint', done);
  setTimeout(() => { try { window.print(); } catch { done(); } if (!window.matchMedia?.('print').matches) setTimeout(done, 1500); }, 50);
}
