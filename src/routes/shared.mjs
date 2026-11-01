// 單字與句子路由共用的小工具。
import { cache } from '../context.mjs';
import { roleOf } from '../http.mjs';
import { analyzeMany, fixPronounCase, MODEL } from '../analyzer.mjs';
import { hasBlank } from '../exercises.mjs';

/** 從查詢字串或 body 解析出字表 id 陣列（相容舊的單一 id） */
export function setIdList(v, fallback){
  const raw = Array.isArray(v) ? v : String(v ?? fallback ?? '').split(',');
  return [...new Set(raw.map(Number).filter(n => Number.isFinite(n) && n > 0))].slice(0, 20);
}

/** 學生看不到被老師隱藏的字表（kind='wordset'）或文章表（kind='article'）：把 id 清單裡隱藏的拿掉。老師不受影響。 */
export function visibleIds(req, url, kind, ids){
  if (roleOf(req, url) !== 'student') return ids;
  const hidden = cache.hiddenIds(kind);
  return ids.filter(id => !hidden.has(Number(id)));
}
/** 同上，用在列表（每列有 id 與 hidden 欄位） */
export function visibleRows(req, url, rows){
  return roleOf(req, url) === 'student' ? rows.filter(r => !r.hidden) : rows;
}

/** 訂正：把答錯的原題重出一次。
 *  訂正就是把原本那題做對 —— 拼錯 interesting 的人要再拼一次 interesting，
 *  換成聽考或選擇題測的是別的東西。題型、單字、例句一律不換，
 *  只把選項順序打散，避免靠記得剛才的位置作答。 */
export function redoQuestions(quizId, ids){
  const q = cache.getQuiz(quizId);
  if (!q) return null;
  const want = new Set(ids);
  const picked = q.questions.filter(x => want.has(x.id));
  return picked.map((q, i) => {
    const copy = { ...q, id: `${q.id.startsWith('w') ? 'w' : 'q'}f${i}${Date.now().toString(36).slice(-3)}` };
    if (Array.isArray(copy.choices)){
      const c = [...copy.choices];
      for (let j = c.length - 1; j > 0; j--){
        const k = Math.floor(Math.random() * (j + 1));
        [c[j], c[k]] = [c[k], c[j]];
      }
      copy.choices = c;
    }
    return copy;
  });
}

/** 把字表裡所有例句抓出來去重 */
export function exampleSentences(words){
  const seen = new Set();
  for (const w of words)
    for (const sn of w.senses ?? [])
      if (sn.example) seen.add(String(sn.example).trim());
  return [...seen];
}

/** 字裡的隱藏句（測驗用備用例句）原文，去重 */
export function hiddenSentences(words){
  const seen = new Set();
  for (const w of words) for (const x of w.extra ?? []) if (x?.example) seen.add(String(x.example).trim());
  return [...seen];
}

/** 把句子分析後存進句子庫：一批（8 句）做完就存，斷線最多損失一批。
 *  onProgress({ saved, total, costUsd })。失敗時丟出的錯誤帶 e.saved（已存幾句）與 e.total（已花的用量）。 */
export async function analyzeIntoCache(todo, onProgress = () => {}){
  const groupResults = [];
  let saved = 0, lastDone = 0;
  const total = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, costUsd: 0 };
  try {
    await analyzeMany(todo, {
      onGroup: ({ done, usage }) => {
        const n = Math.max(1, done - lastDone);
        const per = {
          inputTokens:  Math.round((usage.inputTokens  - total.inputTokens)  / n),
          outputTokens: Math.round((usage.outputTokens - total.outputTokens) / n),
          costUsd: (usage.costUsd - total.costUsd) / n,
        };
        for (let i = lastDone; i < done; i++){
          const r = groupResults[i];
          if (!r) continue;
          if (hasBlank(todo[i])) continue;    // 仍有未還原的空格就不入庫
          try { fixPronounCase(r.words ?? []); cache.put(todo[i], r, MODEL, per); saved++; }
          catch (err){ console.error('存快取失敗：', todo[i].slice(0, 40), err.message); }
        }
        lastDone = done;
        Object.assign(total, usage);
        onProgress({ saved, total: todo.length, costUsd: usage.costUsd });
      },
      onDone: (i, s) => { groupResults[i] = s; },
    });
  } catch (e){ e.saved = saved; e.total = total; throw e; }
  return { saved, total };
}
