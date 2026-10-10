// 文章表：把貼上的（或照片辨識出的）文章斷成「段落 → 句子」，存成句子 hash 的順序，並標出單字表的單字。
//
// 文章表只存順序，分析結果在 sentences 快取裡。所以存文章表之前，每一句都要已經分析過（分析本來就是先做的）。

import { splitSentences, splitDialogue, dialogueUnits } from './segment.mjs';
import { findForm } from './wordset.mjs';

/** 段落以空白行分開；沒有空白行就是同一段。回傳 [{ para, text }]，句子依序。
 *  斷句必須和分析時完全一樣（splitSentences，換行也是邊界），否則文章表裡的句子在快取裡會對不上。 */
export function splitArticle(text){
  // 對話（A: … / B: …）：分析時會拆掉說話者標記，每個人說的話各自一句，這裡要一致
  const turns = splitDialogue(String(text ?? '').trim());
  // 同一個人說的幾句放在同一段（para = 第幾次發言），文章表就會把一個人說的話排在一起
  if (turns) return dialogueUnits(turns).map(u => ({ para: u.turn, text: u.text.trim(), speaker: u.speaker })).filter(s => s.text);
  const paras = String(text ?? '').replace(/\r\n?/g, '\n').split(/\n\s*\n/).map(p => p.trim()).filter(Boolean);
  const out = [];
  paras.forEach((p, para) => { for (const s of splitSentences(p)) out.push({ para, text: s.text.trim() }); });
  return out.filter(s => s.text);
}

/**
 * 存成文章表。每一句都必須已在快取裡（分析過）；有沒分析的就回 { error:'not-analyzed', missing }。
 * name 有值且 appendTo 沒給：同名的文章表就接在後面（和單字表一樣），沒有同名的才建立新的。
 */
export function saveArticle(cache, { name, text, appendTo }){
  const segs = splitArticle(text);
  if (!segs.length) return { error: 'empty', message: '看不到任何句子。' };
  const missing = segs.filter(s => !cache.has(s.text)).map(s => s.text);
  if (missing.length) return { error: 'not-analyzed', missing, message: `還有 ${missing.length} 句沒有分析完，請先分析再存成文章表。` };

  let target = appendTo ? Number(appendTo) : null;
  const title = String(name ?? '').trim();
  if (target == null && title) target = cache.articleByName(title)?.id ?? null;
  if (target == null && !title) return { error: 'no-name', message: '請輸入文章名稱。' };
  const r = cache.saveArticle({ name: title, appendTo: target, items: segs.map(s => ({ para: s.para, hash: cache.hashOf(s.text) })) });
  return { ...r, name: cache.getArticle(r.id).name, appended: target != null };
}

/** 文章表整理成「段落 → 句子」的結構。words 有給時，標出每句含有哪些單字表單字。 */
export function articleView(cache, id, words = []){
  const a = cache.getArticle(id);
  if (!a) return null;
  const items = cache.articleItems([id]);
  const paras = new Map();
  for (const it of items){
    if (!paras.has(it.para)) paras.set(it.para, []);
    const original = it.sentence?.original ?? '';
    paras.get(it.para).push({
      index: it.idx, hash: it.hash, original,
      translation: it.sentence?.translation ?? null,
      missing: !it.sentence,
      words: words.length ? wordsIn(original, words) : [],
      sentence: it.sentence, speaker: it.speaker,
    });
  }
  const list = [...paras.entries()].sort((x, y) => x[0] - y[0]).map(([para, sentences]) => ({ para, sentences, speaker: sentences[0]?.speaker ?? null }));
  const covered = new Set(list.flatMap(p => p.sentences.flatMap(s => s.words)));
  return { id: a.id, name: a.name, createdAt: a.created_at, sentences: items.length, paragraphs: list,
           coverage: words.length ? { words: words.length, hit: covered.size, hitTerms: [...covered] } : null };
}

/** 這句話裡出現了哪些單字表單字（含變化形）。片語與 not...at all 這類也能比對。 */
export function wordsIn(text, words){
  const out = [];
  for (const w of words) if (findForm(text, w.term)) out.push(w.term);
  return out;
}
