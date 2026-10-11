// 單字搜尋：英文或中文都可以，單字本身優先，其次中文意思、字族與易混淆字、例句。
// 跑法：node --no-warnings test/word-search.mjs
import { searchWords } from '../src/wordset.mjs';

let fail = 0;
const chk = (name, ok, detail = '') => { console.log(`${ok ? '  ✓' : '  ✗'} ${name}${ok ? '' : '  ' + detail}`); if (!ok) fail++; };
const w = (term, senses, extra = {}) => ({ term, senses, confusable: [], family: [], ...extra });
const words = [
  w('end', [{ pos: 'v', zh: '結束', example: 'The movie will end at nine.' }]),
  w('finish', [{ pos: 'v', zh: '完成；結束', example: 'Please finish your homework.' }]),
  w('ending', [{ pos: 'n', zh: '結局' }]),
  w('start', [{ pos: 'v', zh: '開始' }], { confusable: [{ word: 'begin', zh: '開始' }] }),
  w('tend', [{ pos: 'v', zh: '傾向' }]),
  w('teach', [{ pos: 'v', zh: '教導', example: 'She will end the class soon.' }]),
];
const terms = (q, n) => searchWords(words, q, n).map(x => x.term).join();

chk('英文：完全相同排最前面，其次開頭相同，再來包含', terms('end') === 'end,ending,tend,finish,teach' || terms('end').startsWith('end,ending,tend'), terms('end'));
chk('英文不分大小寫', terms('FINISH') === 'finish');
chk('中文：找到有這個意思的字（結束 → end、finish）', terms('結束').split(',').slice(0, 2).sort().join() === 'end,finish', terms('結束'));
chk('中文意思完全相同的排在只是包含的前面', terms('結束').startsWith('end'), terms('結束'));
chk('中文：找到字族與易混淆字（begin 搜到 start）', terms('begin') === 'start', terms('begin'));
chk('例句也搜得到，但排最後', terms('class') === 'teach');
chk('空白或沒結果 → 空', terms('') === '' && terms('   ') === '' && terms('zzz') === '');
chk('結果數量有上限', searchWords(words, 'e', 2).length === 2);
console.log(fail ? `\n有失敗 (${fail})` : '\n全部通過');
process.exit(fail ? 1 : 0);
