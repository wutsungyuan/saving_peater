// 單字與句子路由共用的小工具。
import { cache } from '../context.mjs';
import { roleOf } from '../http.mjs';

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
