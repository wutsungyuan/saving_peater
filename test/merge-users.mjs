// 合併使用者代碼：手機與筆電各自產生的隨機代碼，合併成一個身分。跑法：node --no-warnings test/merge-users.mjs
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openCache } from '../src/cache.mjs';

let fail = 0;
const chk = (name, ok, detail = '') => { console.log(`${ok ? '  ✓' : '  ✗'} ${name}${ok ? '' : '  ' + detail}`); if (!ok) fail++; };
const dir = mkdtempSync(join(tmpdir(), 'peater-merge-'));
const cache = openCache(join(dir, 'c.db'));
const setId = cache.createWordset('字表', [
  { term: 'apple', syllables: 'ap-ple', senses: [{ pos: 'n', zh: '蘋果' }], confusable: [], family: [] },
  { term: 'teach', syllables: 'teach', senses: [{ pos: 'v', zh: '教' }], confusable: [], family: [] },
]);
const [apple, teach] = cache.wordsOf([setId], 'x');
const wa = (u, w, ok) => cache.recordWordAttempt({ userToken: u, wordId: w.id, mode: 'zh2en', correct: ok });
const sa = (u, ok) => cache.recordAttempt({ userToken: u, qtype: 'pattern', patternId: 3, correct: ok });
// 手機：apple 練 4 次對 4（盒子升到 4）、句子 3 題
for (let i = 0; i < 4; i++) wa('phone', apple, true);
for (const ok of [true, false, true]) sa('phone', ok);
// 筆電：apple 練 2 次對 1（盒子 0）、teach 練 2 次對 2、句子 2 題
wa('laptop', apple, true); wa('laptop', apple, false);
wa('laptop', teach, true); wa('laptop', teach, true);
sa('laptop', true); sa('laptop', false);
// 另一個不相干的代碼，不能被動到
wa('other', apple, true);

const list = cache.userTokens();
chk('列出所有代碼與作答數', list.length === 3 && list.find(u => u.token === 'phone').sentences === 3 && list.find(u => u.token === 'laptop').words === 4, JSON.stringify(list));

const r = cache.mergeUsers('student', ['phone', 'laptop']);
chk('作答紀錄改名：句子 5、單字 8', r.attempts === 5 && r.wordAttempts === 8, JSON.stringify(r));
const after = cache.userTokens();
chk('合併後只剩 student 與不相干的 other', after.map(u => u.token).sort().join() === 'other,student', after.map(u => u.token).join());
const w = Object.fromEntries(cache.wordsOf([setId], 'student').map(x => [x.term, x]));
chk('apple：答對與作答次數相加（5/6），盒子取練得最多的那筆（手機的 4）', w.apple.correct === 5 && w.apple.total === 6 && w.apple.box === 4, JSON.stringify(w.apple));
chk('teach：只有筆電有，原樣帶過來', w.teach.correct === 2 && w.teach.total === 2);
chk('不相干的代碼沒被動到', cache.wordsOf([setId], 'other').find(x => x.term === 'apple').total === 1);
chk('舊代碼的熟練度不留殘餘', cache.wordsOf([setId], 'phone').every(x => x.total === 0) && cache.wordsOf([setId], 'laptop').every(x => x.total === 0));
chk('目標代碼自己原本就有的紀錄也保留（再合併一次不重複）', (() => { const before = cache.weakness('student').overall.total; cache.mergeUsers('student', ['student', 'nobody']); return cache.weakness('student').overall.total === before; })());
cache.close(); rmSync(dir, { recursive: true, force: true });
console.log(fail ? `\n有失敗 (${fail})` : '\n全部通過');
process.exit(fail ? 1 : 0);
