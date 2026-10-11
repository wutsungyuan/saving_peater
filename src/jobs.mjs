// 申請單（花費關卡）。學生要花額度的操作不直接執行，改開一張申請單；老師核准後才在背景執行。
// 執行靠 internalCall：重送同一個請求給現有的路由（以老師身分），所以結果和老師自己按下去完全一樣。
//   analyze  分析沒快取的句子（可附 saveAs：分析完存成文章）
//   ocr      拍照辨識英文句子（結果是文字，學生再帶回輸入框）
//   wordset  建立單字表
//   ai-grade AI 批改測驗卷的造句與翻譯
// 一次只執行一張（排隊），避免同時燒額度。伺服器重新啟動時，沒做完的會接著做（分析有快取，重做不會重複收費）。

import { randomBytes, createHash } from 'node:crypto';
import { internalCall } from './internal.mjs';
import { saveArticle } from './articles.mjs';

const sha = s => createHash('sha256').update(s).digest('hex').slice(0, 24);
const short = (s, n = 40) => { const t = String(s ?? '').replace(/\s+/g, ' ').trim(); return t.length > n ? t.slice(0, n) + '…' : t; };

/** 開一張申請單。同一件事（同樣內容）已經有進行中的就沿用，不重複開。 */
export function submitJob(cache, { kind, payload, quote = null, summary = '', by, dedupOn }){
  const dedup = `${kind}:${sha(dedupOn ?? JSON.stringify(payload))}`;
  const hit = cache.pendingJobByDedup(dedup);
  if (hit) return { ...hit, reused: true };
  const id = randomBytes(6).toString('hex');
  cache.createJob({ id, kind, dedup, payload, quote, summary, by });
  return { ...cache.getJob(id), reused: false };
}

/** 老師的決定：approve 核准（接著排隊執行）、reject 拒絕（附備註）、retry 重新執行失敗的 */
export function decideJob(cache, id, action, note = ''){
  const job = cache.getJob(id);
  if (!job) return { error: 'not-found', message: '找不到這張申請單。' };
  const now = Date.now();
  if (action === 'approve' || action === 'retry'){
    const ok = action === 'approve' ? job.status === 'pending' : job.status === 'failed';
    if (!ok) return { error: 'bad-state', message: `這張申請單現在是「${job.status}」，不能${action === 'approve' ? '核准' : '重新執行'}。` };
    cache.updateJob(id, { status: 'approved', decidedAt: now, note: null, result: null });
    enqueue(cache, id);
    return { ok: true, job: cache.getJob(id) };
  }
  if (action === 'reject'){
    if (job.status !== 'pending') return { error: 'bad-state', message: `這張申請單現在是「${job.status}」，不能拒絕。` };
    cache.updateJob(id, { status: 'rejected', decidedAt: now, note: String(note || '').slice(0, 200), finishedAt: now });
    clearPayload(cache, job);
    return { ok: true, job: cache.getJob(id) };
  }
  return { error: 'bad-action', message: '不認得這個動作。' };
}

/** 學生撤回自己還沒審的申請 */
export function cancelJob(cache, id, by){
  const job = cache.getJob(id);
  if (!job || job.by !== by) return { error: 'not-found', message: '找不到這張申請單。' };
  if (job.status !== 'pending') return { error: 'bad-state', message: '已經審過了，不能撤回。' };
  cache.updateJob(id, { status: 'cancelled', finishedAt: Date.now() });
  clearPayload(cache, job);
  return { ok: true, job: cache.getJob(id) };
}

// 照片很大，辨識完（或被拒絕、撤回）就不必留著
function clearPayload(cache, job){
  if (job.kind === 'ocr' && job.payload?.image) cache.updateJob(job.id, { payload: { ...job.payload, image: null } });
}

// ---- 排隊執行 ----
const queue = [];
let running = false;
export function enqueue(cache, id){
  if (!queue.includes(id)) queue.push(id);
  pump(cache);
}
async function pump(cache){
  if (running) return;
  running = true;
  try {
    while (queue.length){
      const id = queue.shift();
      const job = cache.getJob(id);
      if (!job || job.status !== 'approved') continue;
      await execute(cache, job).catch(e => finish(cache, job, 'failed', { error: String(e?.message || e).slice(0, 300) }));
    }
  } finally { running = false; }
}
/** 伺服器啟動時：還在跑或已核准沒跑完的接著做 */
export function resumeJobs(cache){
  for (const j of cache.jobs({ statuses: ['running', 'approved'], limit: 200 }).reverse()){
    if (j.status === 'running') cache.updateJob(j.id, { status: 'approved' });
    enqueue(cache, j.id);
  }
}
/** 測試用：等排隊的都跑完 */
export async function idle(){ while (running || queue.length) await new Promise(r => setTimeout(r, 20)); }

function finish(cache, job, status, result, costUsd = 0){
  cache.updateJob(job.id, { status, result, costUsd, finishedAt: Date.now() });
  clearPayload(cache, job);
}

async function execute(cache, job){
  cache.updateJob(job.id, { status: 'running', startedAt: Date.now() });
  const p = job.payload;
  if (job.kind === 'analyze'){
    const r = await internalCall('POST', '/api/analyze', { text: p.text, article: p.article === true });
    if (r.status !== 200 || !r.events) return finish(cache, job, 'failed', { error: r.json?.error || `HTTP ${r.status}` });
    const done = r.events.find(e => e.event === 'done')?.data;
    const halted = r.events.find(e => e.event === 'halted')?.data;
    const summary = { total: done?.total ?? 0, cached: done?.cached ?? 0, analyzed: done?.analyzed ?? 0, failed: done?.failed ?? 0 };
    const cost = done?.usage?.costUsd ?? 0;
    if (halted) return finish(cache, job, 'failed', { ...summary, error: halted.kind === 'rate-limit' ? '額度用盡，稍後再試。' : String(halted.message || '分析中斷'), halted: halted.kind }, cost);
    if (!done || summary.failed) return finish(cache, job, 'failed', { ...summary, error: summary.failed ? `有 ${summary.failed} 句分析失敗，已分析好的都在快取裡，重新執行只會處理失敗的。` : '分析沒有完成' }, cost);
    if (p.saveAs){
      const a = saveArticle(cache, { name: p.saveAs, text: p.text });
      if (a.error) return finish(cache, job, 'failed', { ...summary, error: a.message || a.error }, cost);
      return finish(cache, job, 'done', { ...summary, articleId: a.id, articleName: a.name, added: a.added }, cost);
    }
    return finish(cache, job, 'done', summary, cost);
  }
  if (job.kind === 'ocr'){
    const r = await internalCall('POST', '/api/analyze-ocr', { image: p.image });
    if (r.status !== 200 || !r.json?.text) return finish(cache, job, 'failed', { error: r.json?.message || r.json?.error || `HTTP ${r.status}` });
    return finish(cache, job, 'done', { text: r.json.text, filled: r.json.filled ?? 0 }, r.json.usage?.costUsd ?? 0);
  }
  if (job.kind === 'wordset'){
    const r = await internalCall('POST', '/api/wordsets', p);
    if (r.status !== 200) return finish(cache, job, 'failed', { error: r.json?.message || r.json?.error || `HTTP ${r.status}` });
    return finish(cache, job, 'done', { id: r.json?.id ?? null, name: r.json?.name ?? p.name ?? '', count: r.json?.count ?? null }, r.json?.usage?.costUsd ?? 0);
  }
  if (job.kind === 'ai-grade'){
    const r = await internalCall('POST', '/api/paper-ai-grade', { id: p.id, confirm: true });
    if (r.status !== 200) return finish(cache, job, 'failed', { error: r.json?.message || r.json?.error || `HTTP ${r.status}` });
    return finish(cache, job, 'done', { paperId: p.id, graded: r.json?.graded ?? null }, r.json?.costUsd ?? 0);
  }
  return finish(cache, job, 'failed', { error: `不認得的申請種類：${job.kind}` });
}

export const jobSummary = { short };
