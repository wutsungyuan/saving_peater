// 中翻英題目的長度提示：要說「共幾個字母、分幾個音節」，而且不能洩漏任何字母。
// 跑法：node --no-warnings test/length-hint.mjs
import assert from 'node:assert/strict';
import { lengthHint } from '../src/wordset.mjs';

const cases = [
  ['cloud-y',            '共 6 個字母，分 2 個音節（5 ＋ 1）'],   // 這是小朋友看不懂的那題
  ['lend',               '共 4 個字母'],
  ['an-y-way',           '共 6 個字母，分 3 個音節（2 ＋ 1 ＋ 3）'],
  ['sum-mer va-ca-tion', '共 2 個字，字母數：6 ＋ 8'],
  ['ice cream',          '共 2 個字，字母數：3 ＋ 5'],
  ['',                   ''],
];
for (const [input, want] of cases) assert.equal(lengthHint(input), want, input);

// 不可含任何英文字母（洩漏答案）
for (const [input] of cases) assert.ok(!/[a-z]/i.test(lengthHint(input)), `洩漏字母：${input}`);

console.log(`通過 (${cases.length * 2})`);
