// 字表裡兩個字中文意思相同（end / finish 都是「結束」）：題目要靠情境分辨，沒有例句時兩個都算對。
// 跑法：node --no-warnings test/word-synonym.mjs
import { WORD_BUILDERS, gradeWord, synonymsOf } from '../src/wordset.mjs';
import { generateType } from '../src/papers/gen.mjs';
import { seededRng } from '../src/papers/plan.mjs';

let fail = 0;
const chk = (name, ok, detail = '') => { console.log(`${ok ? '  ✓' : '  ✗'} ${name}${ok ? '' : '  ' + detail}`); if (!ok) fail++; };
const w = (id, term, senses) => ({ id, term, syllables: term, senses, confusable: [], family: [] });
const end = w(1, 'end', [{ pos: 'v', zh: '結束', example: 'The movie will end at nine.', exampleZh: '電影九點結束。' }]);
const fin = w(2, 'finish', [{ pos: 'v', zh: '完成；結束', example: 'Please finish your homework.', exampleZh: '請完成你的功課。' }]);
const bare = w(3, 'stop', [{ pos: 'v', zh: '停止' }]);
const bareEnd = w(4, 'over', [{ pos: 'adj', zh: '結束' }]);
const all = [end, fin, bare, bareEnd];

chk('找得到同義字', synonymsOf(end, end.senses[0], all).map(x => x.term).sort().join() === 'finish,over');
const q = WORD_BUILDERS.zh2en(end, all);
chk('有例句：改成看情境填空，句子挖空且附中文', q.question.includes('______') && /電影九點結束/.test(q.hint), JSON.stringify(q));
chk('情境題答案是 end，不收 finish', gradeWord(q, ['end']).correct && !gradeWord(q, ['finish']).correct);
const q2 = WORD_BUILDERS.zh2en(bareEnd, all);
chk('沒有例句：中文提示，兩個都算對', gradeWord(q2, ['over']).correct && gradeWord(q2, ['end']).correct && /兩個都算對/.test(q2.explain), JSON.stringify(q2));
const q3 = WORD_BUILDERS.zh2en(bare, all);
chk('沒有同義字：維持原樣', q3.question === '停止' && !q3.alsoAccept.length);

// 測驗卷選擇題：同義字不能當干擾選項
const extra = [w(5, 'begin', [{ pos: 'v', zh: '開始' }]), w(6, 'ask', [{ pos: 'v', zh: '問' }]), w(7, 'run', [{ pos: 'v', zh: '跑' }])];
const withConf = { ...end, confusable: [{ word: 'finish', zh: '結束' }] };
const pool = { words: [withConf, fin, ...extra], articles: [], sentences: [], records: [] };
let bad = 0, seen = 0;
for (let seed = 1; seed <= 30; seed++){
  const items = generateType('mc', 10, pool, seededRng(seed)).questions;
  for (const it of items) if (it.skill === 'word-zh2en' && it.answer[0] === 'end'){ seen++; if (it.choices.some(c => c.value === 'finish')) bad++; }
}
console.log(`    （測到 ${seen} 題 end 的選擇題）`);
chk('選擇題的選項裡沒有 finish', bad === 0, String(bad));
console.log(fail ? `\n有失敗 (${fail})` : '\n全部通過');
process.exit(fail ? 1 : 0);
