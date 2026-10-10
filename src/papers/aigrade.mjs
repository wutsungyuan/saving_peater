// 造句與中翻英的「請 AI 批改」（選用）。
// 預設不用：交卷後程式只做能做的檢查，其餘由自評。按下按鈕、看過報價並確認後，
// 把這份卷子所有要批改的題打包成「一次」呼叫（不是一題一次），結果寫進自評欄位：
//   data.self[題號] = 對／錯   （之後學生仍可自己改）
//   data.ai[題號]   = { correct, comment, fix }
// 不計入統計（造句、翻譯本來就不計），也不影響原本的作答紀錄。

import { callExam } from './model.mjs';
import { EXAM_GRADE_PROMPT, COLD_START_USD } from '../config.mjs';

const PER_CALL = 0.02, PER_ITEM = 0.006;          // 保守的預設單價（美元）；有歷史紀錄後用實際平均
const asText = v => String(Array.isArray(v) ? v[0] ?? '' : v ?? '').trim();

/** 這份卷子有哪些題可以請 AI 批改：開放題、有作答、還沒被 AI 批改過 */
export function gradeCandidates(data){
  return data.questions.filter(q => q.inputMode === 'open' && asText(data.answers[q.id]) && !data.ai?.[q.id]);
}

/** 報價：不呼叫模型 */
export function gradeQuote(cache, data){
  const n = gradeCandidates(data).length;
  if (!n) return { count: 0, calls: 0, estimate: { low: 0, high: 0, seconds: 0 } };
  const u = cache.paperGradeUnit?.();
  const perItem = u?.perItem ?? PER_ITEM, perCall = u?.perCall ?? PER_CALL;
  const base = perCall + perItem * n, r3 = x => Math.round(x * 1000) / 1000;
  return { count: n, calls: 1, estimate: { low: r3(base * 0.8), high: r3(base * 1.3 + COLD_START_USD), seconds: Math.round(8 + n * 1.5), unit: u ? 'history' : 'default' } };
}

const itemOf = (q, answer) => q.type === 'make'
  ? { id: q.id, type: 'make', term: q.checkTerm, task: q.prompt, answer }
  : { id: q.id, type: 'trans', zh: q.question, reference: q.answer?.[0] ?? '', answer };

/** 驗證模型回來的結果：每題都要有、correct 是布林；回傳 { ok: Map, missing: [id] } */
export function validateGrades(raw, ids){
  const ok = new Map();
  for (const r of Array.isArray(raw?.results) ? raw.results : []){
    if (!ids.includes(r?.id) || typeof r.correct !== 'boolean' || ok.has(r.id)) continue;
    const text = x => (typeof x === 'string' && x.trim() ? x.trim().slice(0, 200) : null);
    ok.set(r.id, { correct: r.correct, comment: text(r.comment), fix: r.correct ? null : text(r.fix) });
  }
  return { ok, missing: ids.filter(id => !ok.has(id)) };
}

/**
 * 執行批改。回傳 { ok, graded, missing, costUsd } 或 { error }。
 * apply(results) 由呼叫端提供：把結果寫進卷子並重算分數。
 */
export async function runAiGrade(cache, data, { capUsd } = {}){
  const list = gradeCandidates(data);
  if (!list.length) return { error: 'nothing-to-grade', message: '沒有需要批改的造句或翻譯題（沒作答的題不會批改）。' };
  const ids = list.map(q => q.id);
  let results = new Map(), cost = 0, calls = 0, lastErr = null;
  for (let round = 0; round < 2 && ids.length > results.size; round++){
    const pending = list.filter(q => !results.has(q.id));
    const t0 = Date.now();
    try {
      const res = await callExam({ items: pending.map(q => itemOf(q, asText(data.answers[q.id]))) }, { promptFile: EXAM_GRADE_PROMPT, maxBudgetUsd: capUsd });
      calls++; cost += res.usage.costUsd;
      const v = validateGrades(res.data, pending.map(q => q.id));
      for (const [id, g] of v.ok) results.set(id, g);
      cache.log({ kind: 'paper-grade', chars: 0, sentences: pending.length, cached: 0, analyzed: v.ok.size, ms: Date.now() - t0,
        text: `AI 批改 ${v.ok.size} / ${pending.length} 題`, ...res.usage });
    } catch (e){ lastErr = { kind: e.kind || 'other', message: String(e.message).slice(0, 300) }; break; }   // 額度用盡、認證失效、逾時：不硬試
  }
  if (!results.size) return { error: 'grade-failed', message: lastErr?.kind === 'rate-limit' ? '額度用盡了，這次沒有批改。仍可以自己自評。' : `AI 批改失敗：${lastErr?.message ?? '模型沒有回傳可用的結果'}`, kind: lastErr?.kind ?? 'parse' };
  return { ok: true, results, graded: results.size, missing: ids.filter(id => !results.has(id)), costUsd: cost, calls, error: lastErr };
}

/** 把結果寫進卷子資料（self + ai）。回傳要不要重算分數用的資料已更新 */
export function applyGrades(data, results){
  data.ai ??= {};
  for (const [id, g] of results){ data.ai[id] = g; data.self[id] = g.correct; }
}

