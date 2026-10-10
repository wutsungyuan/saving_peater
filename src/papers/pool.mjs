// 測驗卷的素材池：把使用者選的單字表與文章表展開成「單字、已分析的句子、文章」，並算出已知字集與免費延伸字。
// 不呼叫模型。句子一律用 cache.peek 讀（不算命中）。

import { splitArticle } from '../articles.mjs';
import { hasBlank } from '../exercises.mjs';

const tokensOf = text => (String(text).toLowerCase().match(/[a-z]+(?:'[a-z]+)?/g) ?? []);

/**
 * @param cache
 * @param opts { setIds, articleIds, userToken }
 * @returns {
 *   words:[單字（含進度）], records:[{hash, data}] 已分析句子（文章句子 + 單字例句，去重）,
 *   articles:[{ id, name, paragraphs:[{ para, sentences:[{ hash, original, data }] }] }],
 *   known:Set<已知字>, extWords:[{ term, zh, pos, from, rel }] 免費延伸字（字族、易混淆字，不在字表裡）
 * }
 */
export function buildPool(cache, { setIds = [], articleIds = [], userToken = 'anon' } = {}){
  const words = setIds.length ? cache.wordsOf(setIds, userToken) : [];
  const seen = new Set();
  const records = [];
  const addRecord = (original, data) => {
    if (!data || !original || hasBlank(original)) return;
    const hash = cache.hashOf(original);
    if (seen.has(hash)) return;
    seen.add(hash);
    records.push({ hash, data: { ...data, original: data.original ?? original } });
  };

  // 文章：依段落保留順序（閱讀、克漏字、文意選填要用）
  const articles = [];
  for (const id of articleIds){
    const a = cache.getArticle(id);
    if (!a) continue;
    const byPara = new Map();
    for (const it of cache.articleItems([id])){
      if (!it.sentence) continue;                            // 分析結果不在快取裡的句子略過
      if (!byPara.has(it.para)) byPara.set(it.para, []);
      byPara.get(it.para).push({ hash: it.hash, original: it.sentence.original, data: it.sentence });
      addRecord(it.sentence.original, it.sentence);
    }
    articles.push({ id: a.id, name: a.name,
      paragraphs: [...byPara.entries()].sort((x, y) => x[0] - y[0]).map(([para, sentences]) => ({ para, sentences })) });
  }
  // 單字例句（字表建立時存的、分析過的才有）
  for (const w of words) for (const s of w.senses ?? []) if (s.example) addRecord(s.example, cache.peek(s.example));

  // 已知字集：字表的字 + 所有已分析句子（含文章）用到的字。延伸題的「新字上限」要用。
  const known = new Set();
  for (const w of words) for (const t of tokensOf(w.term)) known.add(t);
  for (const r of records) for (const t of tokensOf(r.data.original)) known.add(t);

  // 免費延伸字：字表裡每個字已經存好的字族詞與易混淆字（附詞性與中文），而且不在字表裡
  const inScope = new Set(words.map(w => String(w.term).toLowerCase()));
  const ext = new Map();
  for (const w of words){
    for (const [rel, list] of [['family', w.family], ['confusable', w.confusable]])
      for (const x of list ?? []){
        const term = String(x.word ?? '').trim();
        const key = term.toLowerCase();
        if (!term || !x.zh || /\s/.test(term) || inScope.has(key) || ext.has(key)) continue;
        ext.set(key, { term, zh: String(x.zh), pos: x.pos ?? null, from: w.term, rel });
      }
  }
  return { setIds, articleIds, words, records, articles, known, extWords: [...ext.values()] };
}

/** 兩份選取範圍有沒有素材（給配題用的布林） */
export const haveOf = pool => ({ words: pool.words.length > 0, sent: pool.records.length > 0, art: pool.articles.some(a => a.paragraphs.length) });

export { splitArticle };
