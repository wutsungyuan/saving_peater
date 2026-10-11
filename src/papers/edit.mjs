// 老師編修卷子：草稿階段可以改名、換掉一題、刪掉一題，滿意了再發佈給學生。
// 規則：
//  - 只有草稿（status = 'draft'）能換題與刪題；已發佈的要先「收回」（學生還沒開始作答才能收回）。
//  - 閱讀測驗、克漏字、文意選填的題目跟文章綁在一起，不能單題編修；模型出的延伸題只能刪、不能換（換就要再花額度）。
//  - 刪題後每題分數重新分配，滿分一定維持 100；至少要留 10 題。
//  - 換題從同一個範圍裡抽同題型、沒出現在這份卷子的題，不呼叫模型、不花額度。

import { DIFFICULTY_NAME, rescore, seededRng } from './plan.mjs';
import { buildPool } from './pool.mjs';
import { generateType } from './gen.mjs';
import { paperView } from './paper.mjs';

const MIN_QUESTIONS = 10;
const SWAPPABLE = new Set(['mc', 'reorder', 'fix', 'fill', 'match', 'trans', 'make']);

export const titleOf = p => p.settings.title || `${DIFFICULTY_NAME[p.settings.difficulty] ?? ''}・${p.n} 題`;

/** 老師看的卷子：題目帶答案與解說（學生版會拿掉）。 */
export function paperAdminView(p){
  const v = paperView(p), byId = new Map(p.data.questions.map(q => [q.id, q]));
  return { ...v, title: titleOf(p), editable: p.status === 'draft',
    sections: v.sections.map(s => ({ ...s, questions: s.questions.map(q => ({ ...byId.get(q.id), id: q.id })) })) };
}

/** 依各區塊的題數重新分配分數（總分維持 100）。回傳 false 表示分不出剛好 100 分。 */
function reassign(data){
  const rows = rescore(data.sections.map(s => ({ id: s.id, n: s.questionIds.length })));
  if (!rows) return false;
  const byId = new Map(data.questions.map(q => [q.id, q]));
  data.sections.forEach((s, si) => {
    const row = rows[si];
    s.n = s.questionIds.length; s.pts = row.pts;
    s.questionIds.forEach((id, i) => {
      const adj = row.extra > 0 ? (i < row.extra ? 0.5 : 0) : row.extra < 0 ? (i < -row.extra ? -0.5 : 0) : 0;
      byId.get(id).pts = row.pts + adj;
    });
  });
  if (data.plan) data.plan.total = data.questions.reduce((a, q) => a + q.pts, 0);
  return true;
}

/** action：rename | publish | unpublish | remove | swap。成功回 { ok, paper }，失敗回 { error, message }。 */
export function editPaper(cache, id, { action, title, questionId } = {}, { ttlDays = 30 } = {}){
  const p = cache.getPaper(id);
  if (!p) return { error: 'expired', message: '這份卷子已經過期或不存在。' };
  if (p.settings.kind === 'fix') return { error: 'fix-paper', message: '訂正卷不能編修。' };
  const done = () => ({ ok: true, paper: paperAdminView(cache.getPaper(id)) });

  if (action === 'rename'){
    cache.updatePaper(id, { settings: { ...p.settings, title: String(title ?? '').trim().slice(0, 60) || undefined } });
    return done();
  }
  if (action === 'publish'){
    if (p.status !== 'draft') return { error: 'bad-state', message: '這份卷子已經發佈了。' };
    cache.updatePaper(id, { status: 'open', expiresAt: Date.now() + ttlDays * 86400_000 });
    return done();
  }
  if (action === 'unpublish'){
    if (p.status !== 'open') return { error: 'bad-state', message: p.status === 'submitted' ? '已經交卷的不能收回。' : '這份卷子還是草稿。' };
    if (Object.values(p.data.answers ?? {}).some(v => (Array.isArray(v) ? v : [v]).some(x => String(x ?? '').trim())))
      return { error: 'has-answers', message: '學生已經開始作答了，不能收回。' };
    cache.updatePaper(id, { status: 'draft', expiresAt: Date.now() + ttlDays * 3 * 86400_000 });
    return done();
  }

  if (action !== 'remove' && action !== 'swap') return { error: 'bad-action', message: '不認得這個動作。' };
  if (p.status !== 'draft') return { error: 'not-draft', message: '已發佈的卷子不能改題目。先「收回」變成草稿再改（學生還沒開始作答才能收回）。' };
  const data = p.data, q = data.questions.find(x => x.id === questionId);
  if (!q) return { error: 'no-question', message: '找不到這一題。' };
  if (q.passageId) return { error: 'passage', message: '這題和文章綁在一起（閱讀測驗、克漏字、文意選填），不能單題編修。' };
  const sec = data.sections.find(s => s.id === q.section);

  if (action === 'remove'){
    if (data.questions.length <= MIN_QUESTIONS) return { error: 'too-few', message: `卷子至少要留 ${MIN_QUESTIONS} 題。` };
    const next = structuredClone(data);
    const ns = next.sections.find(s => s.id === q.section);
    ns.questionIds = ns.questionIds.filter(x => x !== questionId);
    if (q.src === 'ext-model' || q.src === 'ext-free') ns.ext = Math.max(0, (ns.ext ?? 0) - 1);
    if (q.src === 'ext-free') ns.extFree = Math.max(0, (ns.extFree ?? 0) - 1);
    next.questions = next.questions.filter(x => x.id !== questionId);
    if (!ns.questionIds.length) next.sections = next.sections.filter(s => s !== ns);
    delete next.answers?.[questionId];
    if (!reassign(next)) return { error: 'cannot-rescore', message: '刪掉這題後，分數分不出剛好 100 分。請換題而不是刪題。' };
    cache.updatePaper(id, { data: next, n: next.questions.length });
    return done();
  }

  // swap
  if (!SWAPPABLE.has(q.section)) return { error: 'not-swappable', message: '這個題型不能單題換。' };
  if (q.src === 'ext-model') return { error: 'model-only', message: '這題是模型出的延伸題，只能刪掉；要換就得再請模型出題（花額度）。' };
  const pool = buildPool(cache, p.settings);
  const used = new Set(data.questions.map(x => x.meta?.key).filter(Boolean));
  const rng = seededRng(Math.floor(Math.random() * 2 ** 31));
  const wantFree = q.src === 'ext-free';
  const out = generateType(q.section, 12, pool, rng, wantFree ? { ext: 12, extFree: 12 } : {});
  let cands = (out.questions ?? []).filter(c => !used.has(c.meta?.key) && c.type === q.type);
  if (wantFree){ const free = cands.filter(c => c.src === 'ext-free'); if (free.length) cands = free; }
  else cands = cands.filter(c => (c.src ?? 'scope') === 'scope');
  if (!cands.length) return { error: 'no-candidate', message: '這個範圍裡沒有別的同類型題目可以換了。' };
  const pick = cands[0];
  const { passageIdx, ...rest } = pick;
  const next = structuredClone(data);
  const i = next.questions.findIndex(x => x.id === questionId);
  next.questions[i] = { ...rest, id: q.id, section: q.section, pts: q.pts };
  const ns = next.sections.find(s => s.id === q.section);
  if (q.src !== pick.src){
    const was = q.src === 'ext-free' ? 1 : 0, now = pick.src === 'ext-free' ? 1 : 0;
    ns.extFree = Math.max(0, (ns.extFree ?? 0) - was + now);
    ns.ext = Math.max(0, (ns.ext ?? 0) - (q.src === 'ext-free' ? 1 : 0) + (pick.src === 'ext-free' ? 1 : 0));
  }
  delete next.answers?.[questionId];
  cache.updatePaper(id, { data: next });
  cache.bumpQuestions([pick.meta?.bankId].filter(Boolean));
  return done();
}
