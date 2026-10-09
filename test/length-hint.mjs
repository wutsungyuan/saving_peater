// 中翻英題目的提示與批改：
//   - 提示要說「共幾個字母、分幾個音節」，而且不能洩漏任何字母
//   - 縮寫（ROC、PE、Rd.、Ms.）要標明是縮寫，批改忽略大小寫與句點
// 跑法：node --no-warnings test/length-hint.mjs
import assert from 'node:assert/strict';
import { lengthHint, abbrevHint, isAbbrev, gradeWord } from '../src/wordset.mjs';

let n = 0; const ok = (a, b, m) => { assert.equal(a, b, m); n++; };

// ---- 長度提示 ----
const hints = [
  ['cloud-y',            '共 6 個字母，分 2 個音節（5 ＋ 1）'],   // 小朋友看不懂的那題
  ['lend',               '共 4 個字母'],
  ['an-y-way',           '共 6 個字母，分 3 個音節（2 ＋ 1 ＋ 3）'],
  ['sum-mer va-ca-tion', '共 2 個字，字母數：6 ＋ 8'],
  ['ice cream',          '共 2 個字，字母數：3 ＋ 5'],
  ['',                   ''],
];
for (const [input, want] of hints){
  ok(lengthHint(input), want, input);
  assert.ok(!/[a-z]/i.test(lengthHint(input)), `洩漏字母：${input}`); n++;
}

// ---- 縮寫判斷與提示 ----
for (const t of ['ROC', 'PE', 'Rd.', 'Ms.', 'R.O.C.', 'P.E.']) ok(isAbbrev(t), true, t);
for (const t of ['Taiwan', 'lend', 'cloudy', 'I', 'not... at all', 'Mr', '']) ok(isAbbrev(t), false, t);
ok(abbrevHint('ROC'), '縮寫，共 3 個字母，有沒有加點都算對');
ok(abbrevHint('Rd.'), '縮寫，共 2 個字母，有沒有加點都算對');
ok(abbrevHint('cloudy'), '');
assert.ok(!/[a-z]/i.test(abbrevHint('ROC'))); n++;

// ---- 批改容錯 ----
const grade = (answer, given) => gradeWord({ answer: [answer] }, given).correct;
for (const g of ['ROC', 'roc', 'R.O.C.', 'r.o.c', ' R.O.C ']) ok(grade('ROC', g), true, `ROC ← ${g}`);
for (const g of ['PE', 'pe', 'P.E.']) ok(grade('PE', g), true, `PE ← ${g}`);
for (const g of ['Rd.', 'Rd', 'rd', 'R.d.']) ok(grade('Rd.', g), true, `Rd. ← ${g}`);
for (const g of ['Ms.', 'Ms', 'ms']) ok(grade('Ms.', g), true, `Ms. ← ${g}`);
ok(grade('not... at all', 'not at all'), true, 'not... at all ← not at all');
// 該錯的還是要錯
for (const g of ['RO', 'ROCC', 'R.O', '']) ok(grade('ROC', g), false, `ROC ← ${g}`);
ok(grade('cloudy', 'cloudi'), false, 'cloudy ← cloudi');
ok(grade('cloudy', 'Cloudy'), true, '大小寫不影響');
// 多格題（動詞三態）不受影響
ok(gradeWord({ answer: ['lent', 'lent'], accept: [['lent'], ['lent']] }, ['lent', 'lent']).correct, true);
ok(gradeWord({ answer: ['lent', 'lent'], accept: [['lent'], ['lent']] }, ['lend', 'lent']).correct, false);

console.log(`通過 (${n})`);
