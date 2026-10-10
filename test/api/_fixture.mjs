// 測驗卷測試用的資料庫：真實分析過的種子句子、一份字表（10 個字，含字族與易混淆字）、一份文章表（26 句）。
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { openCache } from '../../src/cache.mjs';
import { autoSeed } from '../../src/cache-cli.mjs';

export const W = (term, pos, zh, example, exampleZh, extra = {}) => ({ term, syllables: term, senses: [{ pos, zh, example, exampleZh }], confusable: [], family: [], ...extra });

export function makeFixture(prefix = 'peater-fx-') {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  const dbFile = join(dir, 'cache.db');
  const cache = openCache(dbFile); autoSeed(cache);
  const setId = cache.createWordset('字表', [
    W('apple', 'n', '蘋果', 'I eat an apple every day.', '我每天吃一顆蘋果。', { family: [{ word: 'apples', pos: 'n', zh: '蘋果（複數）' }] }),
    W('teach', 'v', '教導', 'She teaches English at school.', '她在學校教英文。', { confusable: [{ word: 'learn', zh: '學習' }] }),
    W('lend', 'v', '借（出）', 'Can you lend me your pen?', '你可以借我你的筆嗎？', { confusable: [{ word: 'borrow', zh: '借（入）' }] }),
    W('cloudy', 'adj', '多雲的', 'It is cloudy this morning.', '今天早上多雲。', { family: [{ word: 'cloud', pos: 'n', zh: '雲' }] }),
    W('family', 'n', '家人', 'I love my family.', '我愛我的家人。'),
    W('piano', 'n', '鋼琴', 'She plays the piano well.', '她鋼琴彈得很好。', { confusable: [{ word: 'love', zh: '愛' }] }),
    W('homework', 'n', '作業', 'I do my homework at night.', '我晚上寫作業。'),
    W('school', 'n', '學校', 'We go to school every day.', '我們每天上學。'),
    W('breakfast', 'n', '早餐', 'I eat breakfast at seven.', '我七點吃早餐。'),
    W('weather', 'n', '天氣', 'How is the weather today?', '今天天氣如何？'),
  ]);
  const rows = cache.db.prepare("SELECT hash FROM sentences WHERE issue IS NULL AND length(original) BETWEEN 20 AND 70 ORDER BY hash LIMIT 26").all();
  const artId = cache.saveArticle({ name: '文章', items: rows.map((s, i) => ({ para: i < 13 ? 0 : 1, hash: s.hash })) }).id;
  return { dir, dbFile, cache, setId, artId };
}

/** 從資料庫讀卷子（含答案） */
export const readPaper = (dbFile, id) => {
  const d = new DatabaseSync(dbFile, { readOnly: true });
  const r = d.prepare('SELECT data, status, score FROM papers WHERE id = ?').get(id);
  d.close();
  return r && { ...r, data: JSON.parse(r.data) };
};
/** 「全對」的作答（造句用一個含指定字的句子） */
export const perfectAnswers = data => Object.fromEntries(data.questions.map(q => [q.id,
  q.inputMode === 'choice' ? [String(q.answer[0])] : q.inputMode === 'text' ? q.answer.map(String)
  : q.inputMode === 'order' ? q.orders[0]
  : q.type === 'make' ? [`I like ${q.checkTerm} very much.`] : [q.answer[0]]]));
