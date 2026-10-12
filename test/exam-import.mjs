// 考卷重現的純邏輯：填空還原、成對選項、分數分配、預設名稱。不開伺服器。
// 跑法：node --no-warnings test/exam-import.mjs
import { fillStem, analysisText, buildExamQuestions, examPoints, defaultExamTitle, optionParts } from '../src/papers/examimport.mjs';

let fail = 0;
const chk = (name, ok, extra = '') => { console.log((ok ? '  ✓ ' : '  ✗ ') + name + (ok ? '' : '  ' + extra)); if (!ok) fail++; };
const section = s => console.log('\n' + s);

section('填空還原');
chk('雙空格（用 ; 分隔）：第 18 題', fillStem('Oh no, I forgot my ______. Can you ______ me one? My hands are so cold.', 'gloves; lend') === 'Oh no, I forgot my gloves. Can you lend me one? My hands are so cold.', fillStem('Oh no, I forgot my ______. Can you ______ me one? My hands are so cold.', 'gloves; lend'));
chk('雙空格：第 8 題', fillStem('I think English is a little ______, but it is very ______. I like it!', 'difficult; interesting') === 'I think English is a little difficult, but it is very interesting. I like it!');
chk('雙空格：第 19 題', fillStem('The ______ is very good. He can hold his breath ______ for two minutes.', 'swimmer; underwater') === 'The swimmer is very good. He can hold his breath underwater for two minutes.');
chk('單空格', fillStem('In ______, the weather is usually very cold.', 'winter') === 'In winter, the weather is usually very cold.');
chk('空格在句首：第一個字母大寫', fillStem('______ lots of rain in Taipei last night.', 'there was') === 'There was lots of rain in Taipei last night.');
chk('X 代表不填（X/ to）', fillStem('I gave ______ the book ______ him.', 'X/ to') === 'I gave the book to him.', fillStem('I gave ______ the book ______ him.', 'X/ to'));
chk('選項成組的數量和空格對不上 → null（交給「請核對」）', fillStem('I forgot my ______ and ______.', 'gloves') === null);
chk('optionParts：單空格不拆開（選項裡有分號也整個保留）', optionParts('a; b', 1).length === 1 && optionParts('a; b', 2).length === 2);

section('給分析用的句子');
chk('去掉印刷的中文註解與 A: B: 標記，每個人說的話一行',
  analysisText('A: I won the lottery(中樂透) yesterday! B: Really? Or are you pulling my leg?') === 'I won the lottery yesterday!\nReally? Or are you pulling my leg?',
  JSON.stringify(analysisText('A: I won the lottery(中樂透) yesterday! B: Really? Or are you pulling my leg?')));
chk('沒有對話標記的句子原樣保留', analysisText('The swimmer is very good.') === 'The swimmer is very good.');

section('整理模型抄出的題目');
const raw = [
  { no: 1, stem: 'In _____, it often snows.', options: ['spring', 'summer', 'autumn', 'winter'], answer: 3 },
  { no: 18, stem: 'Oh no, I forgot my _____. Can you _____ me one?', options: ['jacket; borrow', 'gloves; lend', 'camera; send', 'violin; teach'], answer: 1 },
  { no: 5, stem: 'Or are you _____?', options: ['(A) making up my mind', '(B) signing up', '(C) missing out', '(D) pulling my leg'], answer: 3 },
  { no: 99, stem: 'No blank here.', options: ['a', 'b', 'c', 'd'], answer: 0 },
  { no: 7, stem: 'Only one option ______.', options: ['a'], answer: 0 },
  { no: 8, stem: 'Bad answer ______ and ______.', options: ['a; b', 'c; d', 'e; f', 'g'], answer: 9 },
  { no: 9, stem: 'Two blanks ______ and ______.', options: ['one', 'two', 'three', 'four'], answer: 1 },
];
const { questions, skipped } = buildExamQuestions(raw);
chk('收進 5 題、略過 2 題（沒有空格、只有一個選項）', questions.length === 5 && skipped.length === 2 && skipped.map(s => s.no).join() === '99,7', JSON.stringify(skipped));
const q18 = questions[1];
chk('第 18 題：空格換成 ______、答案是整組選項', q18.question.includes('______') && q18.answer[0] === 'gloves; lend' && q18.choices.length === 4);
chk('第 18 題：兩個空格有提示，完整句子寫在解說裡', q18.prompt.includes('2 個空格') && q18.explain === '完整句子：Oh no, I forgot my gloves. Can you lend me one?', q18.explain);
chk('(A) (B) 標記被拿掉', questions[2].choices.map(c => c.label).join('|') === 'making up my mind|signing up|missing out|pulling my leg');
chk('答案超出範圍：標「請核對」並預設第一個', questions[3].meta.check.some(x => x.includes('沒有給出答案')) && questions[3].answer[0] === 'a; b');
chk('空格數和選項組數不合：標「請核對」，完整句子留空', questions[4].meta.check.some(x => x.includes('選項卻不是 2 組')) && questions[4].meta.filled === null && questions[4].explain === '', JSON.stringify(questions[4].meta));
chk('正常的題沒有「請核對」', questions[0].meta.check.length === 0 && questions[1].meta.check.length === 0);
chk('記下原卷題號', questions[1].meta.examNo === 18);

section('分數');
for (const n of [3, 7, 23, 25, 30, 33, 41, 60]){
  const p = examPoints(n), sum = p.reduce((a, b) => a + b, 0);
  chk(`${n} 題合計剛好 100 分，每題差距不超過 0.5`, sum === 100 && Math.max(...p) - Math.min(...p) <= 0.5, `${sum}`);
}

section('預設名稱');
const d = new Date(2026, 9, 12);
chk('沒填：日期＋考卷重現', defaultExamTitle([], d) === '2026-10-12 考卷重現');
chk('同一天已有：加（2）', defaultExamTitle(['2026-10-12 考卷重現'], d) === '2026-10-12 考卷重現（2）');
chk('（2）也有了：加（3）', defaultExamTitle(['2026-10-12 考卷重現', '2026-10-12 考卷重現（2）'], d) === '2026-10-12 考卷重現（3）');
chk('別天的不影響', defaultExamTitle(['2026-10-11 考卷重現'], d) === '2026-10-12 考卷重現');

console.log(fail ? `\n${fail} 項失敗` : '\n全部通過');
process.exit(fail ? 1 : 0);
