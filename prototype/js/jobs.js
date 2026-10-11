// 申請單：學生看自己的申請（「我的申請」），老師審核（「待審」）。同一個畫面，依角色顯示不同內容。
// 經典腳本（不是 ES module）：和其他 js/*.js 共用全域，由 index.html 依固定順序載入，順序不能換。

const JOB_KIND = { analyze: '分析句子', ocr: '辨識照片', wordset: '單字表', 'ai-grade': 'AI 批改' };
const JOB_STATUS = { pending: '等待核准', approved: '已核准，排隊中', running: '執行中', done: '完成', failed: '失敗', rejected: '被拒絕', cancelled: '已撤回' };
const isStudentRole = () => document.body.dataset.role === 'student';
const usd = n => 'US$' + Number(n || 0).toFixed(2);
const when = t => t ? new Date(t).toLocaleString('zh-TW', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : '';

/** 老師看的報價一行 */
function jobQuoteLine(j){
  const q = j.quote; if (!q) return '';
  if (j.kind === 'analyze'){
    const e = q.estimate;
    return `${q.toAnalyze} 句要請模型分析（共 ${q.total} 句${q.cached ? `、已快取 ${q.cached} 句` : ''}）${e ? `・預估 ${usd(e.low)}～${usd(e.high)}、約 ${Math.max(1, Math.round(e.seconds / 60))} 分鐘` : ''}`;
  }
  if (j.kind === 'ai-grade' && q.estimate) return `造句與翻譯 ${q.count} 題・預估 ${usd(q.estimate.low)}～${usd(q.estimate.high)}、約 ${q.estimate.seconds} 秒`;
  if (j.kind === 'wordset') return `${q.words} 個字，每 15 個字呼叫一次模型`;
  return '';
}

/** 結果摘要（兩邊都看得到，不含費用） */
function jobResultLine(j){
  const r = j.result; if (!r) return '';
  if (j.status === 'failed') return r.error || '失敗';
  if (j.kind === 'analyze') return r.articleName ? `已存成文章「${r.articleName}」（${r.analyzed} 句新分析）` : `${r.analyzed} 句已分析好，之後再按分析就是瞬間出結果`;
  if (j.kind === 'ocr') return `辨識出 ${String(r.text || '').split('\n').filter(Boolean).length} 行`;
  if (j.kind === 'wordset') return `「${r.name}」：${r.count ?? ''} 個字`;
  if (j.kind === 'ai-grade') return `已批改${r.graded != null ? ` ${r.graded} 題` : ''}`;
  return '';
}

function jobCard(j, teacher){
  const st = JOB_STATUS[j.status] || j.status;
  const cls = j.status === 'done' ? 'good' : j.status === 'failed' || j.status === 'rejected' ? 'bad' : j.status === 'pending' ? 'mid' : '';
  const quote = teacher ? jobQuoteLine(j) : '';
  const res = jobResultLine(j);
  const cost = teacher && j.costUsd ? `　實際花費 ${usd(j.costUsd)}` : '';
  let acts = '';
  if (teacher){
    if (j.status === 'pending') acts = `<button class="primary" type="button" data-job="approve" data-id="${j.id}">核准</button>
      <input type="text" class="jnote" placeholder="拒絕的理由（選填）" maxlength="100" data-note="${j.id}">
      <button type="button" data-job="reject" data-id="${j.id}">拒絕</button>`;
    else if (j.status === 'failed') acts = `<button type="button" data-job="retry" data-id="${j.id}">重新執行</button>`;
  } else {
    if (j.status === 'pending') acts = `<button class="linky" type="button" data-job="cancel" data-id="${j.id}">撤回</button>`;
    if (j.status === 'done'){
      if (j.kind === 'analyze' && j.result?.articleId) acts = `<button type="button" data-job="open-article" data-id="${j.id}">看文章</button>`;
      else if (j.kind === 'analyze') acts = `<button type="button" data-job="open-sentences" data-id="${j.id}">看分析結果</button>`;
      else if (j.kind === 'ocr') acts = `<button type="button" data-job="use-ocr" data-id="${j.id}">帶回輸入框</button>`;
      else if (j.kind === 'wordset') acts = `<button type="button" data-job="open-words" data-id="${j.id}">看單字表</button>`;
      else if (j.kind === 'ai-grade') acts = `<button type="button" data-job="open-exam" data-id="${j.id}">看成績</button>`;
    }
  }
  return `<article class="job ${cls}" data-id="${j.id}">
    <div class="job-head"><span class="tag">${esc(JOB_KIND[j.kind] || j.kind)}</span><b>${esc(j.summary || '')}</b>
      <span class="job-st">${esc(st)}</span></div>
    <div class="job-meta">${esc(when(j.createdAt))}${j.finishedAt ? `　→ ${esc(when(j.finishedAt))}` : ''}${esc(cost)}</div>
    ${quote ? `<p class="job-quote">💰 ${esc(quote)}</p>` : ''}
    ${j.kind === 'analyze' && teacher && j.status === 'pending' && j.payload?.text ? `<details class="job-text"><summary>看原文</summary><pre>${esc(j.payload.text)}</pre></details>` : ''}
    ${res ? `<p class="job-res ${j.status === 'failed' ? 'bad' : ''}">${esc(res)}</p>` : ''}
    ${j.note ? `<p class="job-res bad">老師的說明：${esc(j.note)}</p>` : ''}
    ${acts ? `<div class="row job-acts">${acts}</div>` : ''}</article>`;
}

let jobsCache = [];
async function loadJobs(){
  const head = el('jobsHead'), list = el('jobsList');
  if (API === false){ head.innerHTML = ''; list.innerHTML = needApi(isStudentRole() ? '我的申請' : '待審'); return; }
  list.innerHTML = '<p class="msg">載入中…</p>';
  const r = await fetch('/api/jobs').then(x => x.ok ? x.json() : null).catch(() => null);
  if (!r){ list.innerHTML = '<p class="msg">讀不到申請單。</p>'; return; }
  jobsCache = r.jobs;
  setJobsBadge(r.pending, r.jobs);
  if (isStudentRole()){
    head.innerHTML = `<p class="hint">要請模型分析的內容（新的句子、照片、單字表、AI 批改）會先送給老師，核准後才會執行。已經分析過的句子不用申請，馬上就能看。</p>`;
    list.innerHTML = r.jobs.length ? r.jobs.map(j => jobCard(j, false)).join('') : '<div class="box"><p style="margin:0">還沒有申請。</p></div>';
    return;
  }
  const pend = r.jobs.filter(j => j.status === 'pending'), rest = r.jobs.filter(j => j.status !== 'pending');
  head.innerHTML = `<div class="subrow"><h3 class="sec" style="margin:0">待審（${pend.length}）</h3>
    ${pend.length > 1 ? '<button type="button" class="linky" id="jobsApproveAll">全部核准</button>' : ''}</div>`;
  list.innerHTML = (pend.length ? pend.map(j => jobCard(j, true)).join('') : '<div class="box"><p style="margin:0">沒有待審的申請。</p></div>')
    + (rest.length ? `<h3 class="sec">處理過的</h3>${rest.map(j => jobCard(j, true)).join('')}` : '');
}

function setJobsBadge(pending, jobs){
  const n = isStudentRole() ? (jobs || []).filter(j => ['pending', 'approved', 'running'].includes(j.status)).length : pending;
  for (const id of ['jobsBadgeT', 'jobsBadgeS']){ const b = el(id); if (b){ b.textContent = n ? String(n) : ''; b.hidden = !n; } }
}

async function jobAct(act, id, extra = {}){
  if (act === 'cancel') return artApi('/api/job-cancel', { method: 'POST', body: { id } });
  return artApi('/api/job-decide', { method: 'POST', body: { id, action: act, ...extra } });
}

el('view-jobs').addEventListener('click', async e => {
  const all = e.target.closest('#jobsApproveAll');
  if (all){
    if (all.dataset.armed !== '1'){ all.dataset.armed = '1'; all.textContent = '再按一次確定全部核准'; setTimeout(() => { all.dataset.armed = '0'; all.textContent = '全部核准'; }, 4000); return; }
    for (const j of jobsCache.filter(x => x.status === 'pending')) await jobAct('approve', j.id);
    return loadJobs();
  }
  const b = e.target.closest('[data-job]'); if (!b) return;
  const id = b.dataset.id, act = b.dataset.job, j = jobsCache.find(x => x.id === id);
  if (['approve', 'reject', 'retry', 'cancel'].includes(act)){
    b.disabled = true;
    const note = act === 'reject' ? (document.querySelector(`[data-note="${id}"]`)?.value || '') : '';
    const r = await jobAct(act, id, act === 'reject' ? { note } : {});
    el('jobsMsg').textContent = r.ok ? '' : (r.json.message || '操作失敗');
    return loadJobs();
  }
  if (!j) return;
  if (act === 'open-article'){ jumpTo('article', { sub: 'articles' }); setTimeout(() => openArticle(j.result.articleId), 300); }
  else if (act === 'open-sentences'){ jumpTo('sentence', { sub: 'live' }); setInput(j.payload.text); analyzeLive(j.payload.text); }
  else if (act === 'use-ocr'){
    const toArticle = j.payload?.mode === 'article';
    jumpTo(toArticle ? 'article' : 'sentence', { sub: toArticle ? 'new' : 'live' });
    setTimeout(() => { setInput(j.result.text); curKind = null; }, 200);
  }
  else if (act === 'open-words'){ wsSel = [j.result.id]; wsCurrent = j.result.id; jumpTo('words'); }
  else if (act === 'open-exam'){ jumpTo('exam'); }
});

// ---- 徽章：每 30 秒問一次有幾張（老師：待審；學生：進行中）。畫面開著「申請」頁就順便重畫。----
let lastActive = null;
async function pollJobs(){
  if (API === false || !API || document.hidden || !['teacher', 'student'].includes(document.body.dataset.role)) return;
  const c = await fetch('/api/jobs-count').then(r => r.ok ? r.json() : null).catch(() => null);
  if (!c) return;
  const n = isStudentRole() ? c.active : c.pending;
  for (const id of ['jobsBadgeT', 'jobsBadgeS']){ const b = el(id); if (b){ b.textContent = n ? String(n) : ''; b.hidden = !n; } }
  if (lastActive !== null && lastActive !== n && !el('view-jobs').hidden) loadJobs();
  lastActive = n;
}
setInterval(pollJobs, 30000);
setTimeout(pollJobs, 2500);
document.addEventListener('visibilitychange', () => { if (!document.hidden) pollJobs(); });
