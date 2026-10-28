// 單字熟練度：拼寫類題型才能升到高盒，選擇題（認得）最多推到第 2 盒；歷史可重算。
// 跑法：node --no-warnings test/word-box.mjs
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openCache, nextBox } from '../src/cache.mjs';

let fail = 0;
const chk = (name, ok, detail = '') => { console.log(`${ok ? '  ✓' : '  ✗'} ${name}${ok ? '' : '  ' + detail}`); if (!ok) fail++; };

chk('拼寫題答對一路升到 5', [0, 1, 2, 3, 4].every(b => nextBox(b, 'zh2en', true) === b + 1) && nextBox(5, 'cloze', true) === 5);
chk('聽寫、克漏字、動詞變化也算拼寫', ['listen', 'cloze', 'forms'].every(m => nextBox(3, m, true) === 4));
chk('選擇題（英選中、詞義辨析）最多推到 2', nextBox(0, 'en2zh', true) === 1 && nextBox(1, 'en2zh', true) === 2 && nextBox(2, 'en2zh', true) === 2 && nextBox(2, 'sense', true) === 2);
chk('選擇題答對不會讓已經高的盒子退回', nextBox(4, 'en2zh', true) === 4);
chk('任何題型答錯都回第 0 盒', ['zh2en', 'en2zh', 'listen'].every(m => nextBox(4, m, false) === 0));

const cache = openCache(join(mkdtempSync(join(tmpdir(), 'peater-box-')), 'c.db'));
const sid = cache.createWordset('字表', [
  { term: 'apple', syllables: 'ap-ple', senses: [{ pos: 'n', zh: '蘋果' }], confusable: [], family: [] },
  { term: 'teach', syllables: 'teach', senses: [{ pos: 'v', zh: '教' }], confusable: [], family: [] },
]);
const [apple, teach] = cache.wordsOf([sid], 's');
const rec = (w, mode, ok) => cache.recordWordAttempt({ userToken: 's', wordId: w.id, mode, correct: ok });
for (let i = 0; i < 6; i++) rec(apple, 'en2zh', true);
chk('英選中連續答對 6 次，盒子停在 2、不算背熟', cache.wordStats([sid], 's').byWord.find(x => x.term === 'apple').box === 2 && cache.wordStats([sid], 's').mastered === 0);
for (let i = 0; i < 3; i++) rec(apple, 'zh2en', true);
chk('再拼對 3 次才升到 5、算背熟', cache.wordStats([sid], 's').mastered === 1);
const st = cache.wordStats([sid], 's');
chk('統計分開算認得與會拼', st.recog.attempts === 6 && st.recog.correct === 6 && st.spell.attempts === 3 && st.spell.correct === 3, JSON.stringify([st.recog, st.spell]));

// 舊規則留下的盒子（全靠選擇題升上去的）可以重算
cache.db.prepare('INSERT OR REPLACE INTO word_progress (user_token, word_id, box, due_at, correct, total) VALUES (?,?,5,0,4,4)').run('s', teach.id);
for (let i = 0; i < 4; i++) cache.db.prepare(`INSERT INTO word_attempts (user_token, word_id, mode, correct, is_fix, created_at, source) VALUES ('s', ?, 'en2zh', 1, 0, ?, 'quiz')`).run(teach.id, 1000 + i);
const dry = cache.recomputeWordProgress({ dryRun: true });
chk('試算不寫入', cache.wordsOf([sid], 's').find(w => w.term === 'teach').box === 5 && dry.masteredAfter < dry.masteredBefore, JSON.stringify(dry));
cache.recomputeWordProgress();
const after = cache.wordsOf([sid], 's');
chk('重算後：只靠選擇題的字降到 2', after.find(w => w.term === 'teach').box === 2);
chk('重算後：有拼寫答對的字維持高盒', after.find(w => w.term === 'apple').box === 5);
chk('重算不改作答次數', after.find(w => w.term === 'apple').total === 9);
console.log(fail ? `\n有失敗 (${fail})` : '\n全部通過 (11)');
process.exit(fail ? 1 : 0);
