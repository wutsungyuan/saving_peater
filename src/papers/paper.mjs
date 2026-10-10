// 測驗卷的生命週期：預覽 → 出卷 → 作答（可存檔續做）→ 交卷批改 → 自評 → 訂正。
// 卷子存在 papers 表（快取性質，到期自動清除）。統計只認第一次作答；訂正不計入統計，原卷分數不變。
// 模型出題（閱讀測驗、克漏字干擾項、延伸題）在 model.mjs：先報價、你確認才呼叫、通過檢查才入庫。

import { randomBytes } from 'node:crypto';
import { composePaper, seededRng, TYPES, TYPE_BY_ID, DIFFICULTY, DIFFICULTY_NAME } from './plan.mjs';
import { buildPool, haveOf } from './pool.mjs';
import { supplyOf, generateType, publicQuestion } from './gen.mjs';
import { gradeQuestion, earned } from './grade.mjs';
import { gradeQuote, runAiGrade, applyGrades } from './aigrade.mjs';
import { planModelWork, runModelWork, readSupply, extBankCaps, extQuestions, readSection, clozeSemantic } from './model.mjs';

const newId = () => 'p' + randomBytes(5).toString('hex');

/** 整理前端送來的出卷設定 */
export function normalizeSettings(b = {}){
  const ids = v => [...new Set((Array.isArray(v) ? v : []).map(Number).filter(n => Number.isFinite(n) && n > 0))].slice(0, 20);
  return {
    setIds: ids(b.setIds), articleIds: ids(b.articleIds),
    n: Math.round(Number(b.n) || 50),
    mode: b.mode === 'custom' ? 'custom' : 'auto',
    types: (Array.isArray(b.types) ? b.types : []).filter(id => TYPE_BY_ID[id]),
    difficulty: DIFFICULTY[b.difficulty] != null ? b.difficulty : 'easy',
    allowOpen: b.allowOpen !== false,
    saver: b.saver === true,                    // 省錢模式：不呼叫模型，只用程式出題與題庫現成的題
    preferModel: b.preferModel === true,        // 延伸題偏好模型
    userToken: String(b.userToken || 'anon').slice(0, 64),
    seed: Number.isFinite(Number(b.seed)) ? Number(b.seed) : undefined,
    confirm: b.confirm === true,                // 使用者看過報價、同意花額度
  };
}

const NEED_TEXT = { ws: '需要單字表或已分析的句子', words: '需要單字表', sent: '需要已分析的句子（單字例句或文章）', art: '需要文章表' };

/** 每個題型在這個範圍能不能出、為什麼不能（給畫面勾選用） */
export function availabilityOf(have, supply, { saver = false } = {}){
  return TYPES.map(t => {
    const need = t.need === 'ws' ? (have.words || have.sent) : have[t.need];
    const sup = supply?.[t.id];
    const ok = need && (sup == null || sup >= t.floor);
    return { id: t.id, name: t.name, ok: Boolean(ok), supply: sup ?? null, model: Boolean(t.model), open: Boolean(t.open), ext: Boolean(t.ext),
      reason: ok ? null : !need ? NEED_TEXT[t.need]
        : t.id === 'read' && saver ? '省錢模式不呼叫模型，題庫裡還沒有這個範圍的閱讀題。關掉省錢模式就能請模型出'
        : `素材不夠：這個範圍只出得了 ${sup} 題，至少要 ${t.floor} 題` };
  });
}

function scopeInfo(cache, settings){
  const pool = buildPool(cache, settings);
  const have = haveOf(pool);
  const rng = seededRng((settings.seed ?? 1) + 7);
  const sem = clozeSemantic(cache, pool);
  const supply = supplyOf(pool, rng, { clozeSemantic: sem });
  supply.read = pool.articles.length ? readSupply(cache, pool, { modelOk: !settings.saver }) : 0;   // 閱讀測驗：能請模型出就算每篇文章 6 題，不能就只算題庫現成的
  const modelCap = settings.saver ? extBankCaps(cache, pool) : null;                                // 省錢模式：延伸題的模型部分只能用題庫現成的
  return { pool, have, supply, modelCap };
}

const composeFor = (settings, info, seed) => composePaper({ have: info.have, supply: info.supply, N: settings.n, mode: settings.mode, types: settings.types,
  allowOpen: settings.allowOpen, difficulty: settings.difficulty, freeSupply: info.pool.extWords.length, preferModel: settings.preferModel,
  modelCap: info.modelCap, seed });

/** 預覽：不出題、不呼叫模型。回傳可出的題型、配題結果與每題分數、延伸題分配、報價。 */
export function previewPaper(cache, rawSettings){
  const settings = normalizeSettings(rawSettings);
  if (!settings.setIds.length && !settings.articleIds.length) return { error: 'no-scope', message: '請至少選一份單字表或文章表。' };
  const info = scopeInfo(cache, settings);
  const availability = availabilityOf(info.have, info.supply, { saver: settings.saver });
  const plan = composeFor(settings, info, settings.seed);
  if (plan.error) return { error: plan.error, message: plan.message, availability };
  const { quote } = planModelWork(cache, info.pool, plan, { saver: settings.saver, seed: plan.seed });
  return { ok: true, seed: plan.seed, settings: { ...settings, seed: plan.seed }, availability, plan, quote,
    scope: { words: info.pool.words.length, sentences: info.pool.records.length, articles: info.pool.articles.length, extWords: info.pool.extWords.length } };
}

/** 依配題結果，把每個題型的題目備好。模型題從題庫取（這之前 runModelWork 已經把缺的補進題庫）。 */
function buildSections(cache, pool, plan, rng){
  const built = []; let short = null;
  for (const row of plan.rows){
    let out;
    if (row.id === 'read') out = readSection(cache, pool, row.n, row.ext, rng);
    else if (['mc', 'reorder', 'fix', 'trans'].includes(row.id))
      out = generateType(row.id, row.n, pool, rng, { ext: row.ext, extFree: row.extFree, modelItems: extQuestions(cache, pool, row.id, row.ext - row.extFree, rng) });
    else out = generateType(row.id, row.n, pool, rng, { ext: row.ext, extFree: row.extFree, clozeSemantic: clozeSemantic(cache, pool) });
    built.push({ row, ...out });
    if (out.questions.length < row.n){ short = { id: row.id, got: out.questions.length }; break; }
  }
  return { built, short };
}

/** 出卷。需要請模型出題而沒有確認時，回 { error:'confirm-required', quote }。回傳 { id, paper, total, model? } 或 { error }。 */
export async function createPaper(cache, rawSettings, { ttlDays = 30 } = {}){
  const settings = normalizeSettings(rawSettings);
  if (!settings.setIds.length && !settings.articleIds.length) return { error: 'no-scope', message: '請至少選一份單字表或文章表。' };
  const info = scopeInfo(cache, settings);
  let seed = settings.seed ?? Math.floor(Math.random() * 2 ** 31);

  // 1) 配題與報價；要呼叫模型就要使用者先確認
  let plan = composeFor(settings, info, seed);
  if (plan.error) return { error: plan.error, message: plan.message };
  const { tasks, quote } = planModelWork(cache, info.pool, plan, { saver: settings.saver, seed });
  let model = null;
  if (tasks.length){
    if (!settings.confirm) return { error: 'confirm-required', message: '這份卷子需要請模型出題，要先確認。', quote };
    model = await runModelWork(cache, info.pool, tasks, { capUsd: Math.max(0.3, Math.round(quote.estimate.high * 150) / 100) });
  }

  // 2) 實際出題可能比預估少（模型題被擋掉、額度用盡、克漏字挖不出那麼多空格）：不夠就把供給量改成實際的，重新配題，最多 5 次
  const supply = { ...info.supply }; let built = null;
  for (let attempt = 0; attempt < 5; attempt++){
    plan = composePaper({ have: info.have, supply, N: settings.n, mode: settings.mode, types: settings.types, allowOpen: settings.allowOpen,
      difficulty: settings.difficulty, freeSupply: info.pool.extWords.length, preferModel: settings.preferModel, modelCap: info.modelCap, seed });
    if (plan.error) return { error: plan.error, message: plan.message, model };
    const r = buildSections(cache, info.pool, plan, seededRng(seed + 1000 + attempt));
    if (!r.short){ built = r.built; break; }
    supply[r.short.id] = r.short.got; seed += 1;
  }
  if (!built) return { error: 'not-enough', message: '這個範圍的素材湊不到這麼多題，請多選一些單字表或文章表，或減少題數。', model };

  // 3) 組卷：題目編號、分區、每題分數（尾差由前面幾題各加減 0.5 分）
  const sections = []; const questions = []; let pSeq = 0;
  for (const { row, questions: qs, passages, ext, extFree } of built){
    const pids = (passages ?? []).map(p => ({ ...p, id: `p${++pSeq}` }));
    const ids = [];
    qs.forEach((q, i) => {
      const id = `q${questions.length + 1}`;
      const adj = row.extra > 0 ? (i < row.extra ? 0.5 : 0) : row.extra < 0 ? (i < -row.extra ? -0.5 : 0) : 0;
      const { passageIdx, ...rest } = q;
      const passageId = passageIdx != null ? pids[passageIdx]?.id : (pids[0] && (q.type === 'cloze' || q.type === 'wbank') ? pids[0].id : undefined);
      questions.push({ ...rest, id, section: row.id, pts: row.pts + adj, ...(passageId ? { passageId } : {}) });
      ids.push(id);
    });
    sections.push({ id: row.id, name: row.name, n: qs.length, pts: row.pts, passages: pids, questionIds: ids, ext, extFree });
  }
  const total = questions.reduce((s, q) => s + q.pts, 0);
  const id = newId();
  const data = { sections, questions, answers: {}, self: {}, plan: { seed, total, rows: plan.rows.map(r => [r.id, r.n, r.ext]), ext: { target: plan.ext.target, actual: built.reduce((a, b) => a + b.ext, 0), free: built.reduce((a, b) => a + b.extFree, 0) }, relax: plan.relax } };
  cache.putPaper({ id, n: questions.length, settings: { ...settings, confirm: undefined, seed }, data, ttlDays });
  cache.bumpQuestions(questions.map(q => q.meta?.bankId).filter(Boolean));          // 用過次數：下一份卷子優先用沒用過的題
  return { id, paper: paperView(cache.getPaper(id)), total, model, quote: tasks.length ? quote : null };
}

/** 給前端看的卷子：題目拿掉答案。交卷後附上批改結果。 */
export function paperView(p){
  if (!p) return null;
  const d = p.data, byId = new Map(d.questions.map(q => [q.id, q]));
  return {
    id: p.id, status: p.status, createdAt: p.createdAt, expiresAt: p.expiresAt, n: p.n, score: p.score, submittedAt: p.submittedAt,
    kind: p.settings.kind ?? 'normal', from: p.settings.from ?? null,
    settings: { n: p.settings.n, difficulty: p.settings.difficulty, difficultyName: DIFFICULTY_NAME[p.settings.difficulty], mode: p.settings.mode,
      setIds: p.settings.setIds, articleIds: p.settings.articleIds },
    sections: d.sections.map(s => ({ id: s.id, name: s.name, n: s.n, pts: s.pts, ext: s.ext, extFree: s.extFree,
      passages: s.passages, questions: s.questionIds.map(id => ({ ...publicQuestion(byId.get(id)), id, pts: byId.get(id).pts, section: s.id, src: byId.get(id).src })) })),
    answers: d.answers, self: d.self, result: d.result ?? null,
  };
}

export function saveAnswers(cache, id, answers){
  const p = cache.getPaper(id);
  if (!p) return { error: 'expired', message: '這份卷子已經過期或不存在。' };
  if (p.status === 'submitted') return { error: 'submitted', message: '這份卷子已經交卷了。' };
  p.data.answers = { ...p.data.answers, ...(answers && typeof answers === 'object' ? answers : {}) };
  cache.savePaperData(id, p.data);
  return { ok: true };
}

/** 把批改結果算成分數、各區塊得分、依「錯的在前」排好順序 */
function summarize(data, grades){
  const items = data.questions.map(q => {
    const g = grades.get(q.id);
    const e = earned(q, g, data.self);
    return { id: q.id, section: q.section, type: q.type, correct: g.correct, pending: g.pending && data.self[q.id] == null, marked: g.pending ? (data.self[q.id] ?? null) : null,
      given: g.given, expected: g.expected, ai: data.ai?.[q.id] ?? null, explain: q.explain, reference: q.sample ?? q.answer?.[0] ?? null, suggest: g.suggest, checks: g.checks, pts: q.pts, earned: e, src: q.src };
  });
  const ok = it => it.correct === true || it.marked === true;
  const bySection = data.sections.map(s => {
    const its = items.filter(i => i.section === s.id);
    return { id: s.id, name: s.name, total: its.reduce((a, i) => a + i.pts, 0), score: its.reduce((a, i) => a + i.earned, 0),
      right: its.filter(ok).length, wrong: its.filter(i => !ok(i) && !i.pending).length, pending: its.filter(i => i.pending).length };
  });
  const rank = it => ok(it) ? 2 : it.pending ? 1 : 0;                      // 錯的在前，其次是還沒自評的，答對的最後
  const order = [...items].sort((a, b) => rank(a) - rank(b) || data.questions.findIndex(q => q.id === a.id) - data.questions.findIndex(q => q.id === b.id)).map(i => i.id);
  return { score: items.reduce((a, i) => a + i.earned, 0), total: items.reduce((a, i) => a + i.pts, 0),
    right: items.filter(ok).length, wrong: items.filter(i => !ok(i) && !i.pending).length, pending: items.filter(i => i.pending).length,
    bySection, items, order };
}

function recordStats(cache, p, grades, userToken){
  for (const q of p.data.questions){
    const g = grades.get(q.id), st = q.meta?.stat;
    if (!st || g.correct == null) continue;                                    // 沒有統計對象、或要自評的題不計入
    const answer = g.given.join(' | '), expected = (g.expected ?? []).join(' | ');
    if (st.kind === 'word') cache.recordWordAttempt({ userToken, wordId: st.wordId, wordIds: st.wordIds, senseIdx: st.senseIdx, mode: st.mode, correct: g.correct, isFix: false, answer, expected });
    else if (st.kind === 'sentence') cache.recordAttempt({ userToken, qtype: st.qtype, sentenceHash: st.hash ?? null, patternId: st.patternId, tenseTime: st.tenseTime,
      tenseAspect: st.tenseAspect, pos: st.pos, pronCase: st.pronCase, correct: g.correct, isFix: false, answer, expected });
    else if (st.kind === 'paper') cache.recordAttempt({ userToken, qtype: st.qtype, sentenceHash: st.hash ?? null, correct: g.correct, isFix: false, answer, expected });
  }
}

/** 交卷。第一次交卷才記統計；訂正卷（settings.kind==='fix'）不記。再交一次就回傳已有的結果。 */
export function submitPaper(cache, id, { answers, userToken = 'anon' } = {}){
  const p = cache.getPaper(id);
  if (!p) return { error: 'expired', message: '這份卷子已經過期或不存在。' };
  if (p.status === 'submitted') return { ok: true, already: true, paper: paperView(p) };
  p.data.answers = { ...p.data.answers, ...(answers && typeof answers === 'object' ? answers : {}) };
  const grades = new Map(p.data.questions.map(q => [q.id, gradeQuestion(q, p.data.answers[q.id])]));
  if (p.settings.kind !== 'fix') recordStats(cache, p, grades, userToken);
  p.data.result = summarize(p.data, grades);
  cache.submitPaper(id, p.data, p.data.result.score);
  if (p.settings.kind !== 'fix') cache.bumpQuestions(p.data.questions.filter(q => q.meta?.bankId && grades.get(q.id).correct === false).map(q => q.meta.bankId), { wrong: true });
  return { ok: true, paper: paperView(cache.getPaper(id)) };
}

/** 自評：開放題（造句、翻譯）由學生或家長標對錯，之後分數重算。不計入統計。 */
export function markSelf(cache, id, marks){
  const p = cache.getPaper(id);
  if (!p) return { error: 'expired', message: '這份卷子已經過期或不存在。' };
  if (p.status !== 'submitted') return { error: 'not-submitted', message: '要先交卷才能自評。' };
  const open = new Set(p.data.questions.filter(q => q.inputMode === 'open').map(q => q.id));
  for (const [qid, v] of Object.entries(marks ?? {})) if (open.has(qid) && typeof v === 'boolean') p.data.self[qid] = v;
  const grades = new Map(p.data.questions.map(q => [q.id, gradeQuestion(q, p.data.answers[q.id])]));
  p.data.result = summarize(p.data, grades);
  cache.submitPaper(id, p.data, p.data.result.score);
  return { ok: true, paper: paperView(cache.getPaper(id)) };
}

/**
 * 請 AI 批改造句與翻譯（選用）。沒確認時回 409 + 報價；確認後一次呼叫批改全部，結果寫進自評。
 * 回傳 { ok, paper, graded, missing, costUsd } 或 { error }。
 */
export async function aiGradePaper(cache, id, { confirm = false } = {}){
  const p = cache.getPaper(id);
  if (!p) return { error: 'expired', message: '這份卷子已經過期或不存在。' };
  if (p.status !== 'submitted') return { error: 'not-submitted', message: '要先交卷才能請 AI 批改。' };
  if (p.settings.kind === 'fix') return { error: 'fix-paper', message: '訂正卷不需要批改。' };
  const quote = gradeQuote(cache, p.data);
  if (!quote.count) return { error: 'nothing-to-grade', message: '沒有需要批改的造句或翻譯題（沒作答的題不會批改）。', quote };
  if (!confirm) return { error: 'confirm-required', message: '要先確認費用才會呼叫模型。', quote };
  const run = await runAiGrade(cache, p.data, { capUsd: Math.max(0.3, Math.round(quote.estimate.high * 150) / 100) });
  if (run.error) return { error: run.error, message: run.message, kind: run.kind, quote };
  applyGrades(p.data, run.results);
  const grades = new Map(p.data.questions.map(q => [q.id, gradeQuestion(q, p.data.answers[q.id])]));
  p.data.result = summarize(p.data, grades);
  cache.submitPaper(id, p.data, p.data.result.score);
  return { ok: true, paper: paperView(cache.getPaper(id)), graded: run.graded, missing: run.missing, costUsd: run.costUsd, partialError: run.error };
}

/** 訂正：把答錯的題重出（題型不換、選項順序重排），錯的排前面。不計入統計，原卷分數不變。 */
export function createFixPaper(cache, id, { ids, ttlDays = 30 } = {}){
  const p = cache.getPaper(id);
  if (!p) return { error: 'expired', message: '這份卷子已經過期或不存在。' };
  if (p.status !== 'submitted' || !p.data.result) return { error: 'not-submitted', message: '要先交卷才能訂正。' };
  const wrongIds = p.data.result.order.filter(qid => { const it = p.data.result.items.find(i => i.id === qid); return it.correct === false || it.marked === false; });
  const want = new Set(ids?.length ? ids.filter(x => wrongIds.includes(x)) : wrongIds);
  if (!want.size) return { error: 'nothing-to-fix', message: '沒有答錯的題目，不需要訂正。' };
  const rng = seededRng(Date.now() % 2 ** 31);
  const shuffle = a => { const r = [...a]; for (let i = r.length - 1; i > 0; i--){ const j = Math.floor(rng() * (i + 1)); [r[i], r[j]] = [r[j], r[i]]; } return r; };
  const qs = p.data.result.order.filter(qid => want.has(qid)).map((qid, i) => {
    const q = p.data.questions.find(x => x.id === qid);
    const copy = { ...q, id: `f${i + 1}`, from: qid };
    if (Array.isArray(copy.choices) && q.type !== 'match' && q.type !== 'wbank') copy.choices = shuffle(copy.choices);
    if (Array.isArray(copy.chunks)) copy.chunks = shuffle(copy.chunks);
    return copy;
  });
  const section = { id: 'fix', name: '訂正', n: qs.length, pts: 0, passages: p.data.sections.flatMap(s => s.passages), questionIds: qs.map(q => q.id) };
  const fid = newId();
  cache.putPaper({ id: fid, n: qs.length, ttlDays,
    settings: { ...p.settings, kind: 'fix', from: id }, data: { sections: [section], questions: qs, answers: {}, self: {}, plan: null } });
  return { id: fid, paper: paperView(cache.getPaper(fid)) };
}

/** 歷史列表 */
export function historyList(cache){
  return cache.papers(50).map(r => ({ id: r.id, createdAt: r.created_at, expiresAt: r.expires_at, n: r.n, status: r.status,
    score: r.score, submittedAt: r.submitted_at, kind: r.settings.kind ?? 'normal', from: r.settings.from ?? null,
    difficulty: r.settings.difficulty, difficultyName: DIFFICULTY_NAME[r.settings.difficulty], setIds: r.settings.setIds, articleIds: r.settings.articleIds }));
}
