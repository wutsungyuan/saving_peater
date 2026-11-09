// 口說：比對語音辨識的結果和單字。跑法：node --no-warnings test/word-speak.mjs
import { spokenMatch, WORD_BUILDERS, gradeWord, generateWordQuiz, WORD_MODES, ALL_WORD_MODES } from '../src/wordset.mjs';

let fail = 0;
const chk = (name, ok, detail = '') => { console.log(`${ok ? '  ✓' : '  ✗'} ${name}${ok ? '' : '  ' + detail}`); if (!ok) fail++; };

chk('大小寫、標點不影響', spokenMatch('Lesson.', 'lesson'));
chk('唸成別的字算錯', !spokenMatch('listen', 'lesson'));
chk('空白算錯', !spokenMatch('', 'lesson') && !spokenMatch('   ', 'lesson'));
chk('片語逐字比對', spokenMatch('get butterflies in my stomach', "get butterflies in one's stomach"));
chk('片語少一個字算錯', !spokenMatch('get butterflies in stomach', "get butterflies in one's stomach"));
chk("one's 唸 your／his 都算對", spokenMatch("get butterflies in your stomach", "get butterflies in one's stomach") && spokenMatch("get butterflies in his stomach", "get butterflies in one's stomach"));
chk('sb 唸 someone／him 算對', spokenMatch('look after someone', 'look after sb') && spokenMatch('look after him', 'look after sb'));
chk('其他字不能亂代換', !spokenMatch('look after the', 'look after sb'));
chk('辨識出阿拉伯數字：2 ＝ two', spokenMatch('2', 'two') && spokenMatch('15', 'fifteen') && spokenMatch('21', 'twenty-one') && spokenMatch('100', 'one hundred'));
chk('數字不對算錯', !spokenMatch('3', 'two'));
chk('連字號與空格：twenty-one ＝ twenty one', spokenMatch('twenty one', 'twenty-one'));
chk('連寫：ice cream ＝ icecream', spokenMatch('icecream', 'ice cream') && spokenMatch('ice cream', 'icecream'));
chk('撇號：don\'t', spokenMatch("don't", 'dont') && spokenMatch('dont', "don't"));
chk('字表寫 a/b，唸哪個都算', spokenMatch('colour', 'color/colour') && spokenMatch('color', 'color/colour'));
chk('括號裡的字不用唸：(be) good at', spokenMatch('good at', '(be) good at'));

const w = { id: 1, term: 'lesson', syllables: 'les-son', senses: [{ pos: 'n', zh: '課' }], confusable: [], family: [] };
const q = WORD_BUILDERS.speak(w);
chk('題目欄位', q.mode === 'speak' && q.inputMode === 'speak' && q.speak === 'lesson' && q.answer[0] === 'lesson' && q.question === 'lesson', JSON.stringify(q));
chk('縮寫不出口說題', WORD_BUILDERS.speak({ ...w, term: 'ROC' }) === null && WORD_BUILDERS.speak({ ...w, term: 'Mr.' }) === null);
let g = gradeWord(q, ['lessen', 'Lesson']);
chk('多次嘗試：任何一次唸對就算對', g.correct && !g.skipped && g.given.join() === 'lessen,Lesson', JSON.stringify(g));
g = gradeWord(q, ['listen', 'lessen']);
chk('都沒唸對：算錯、不是跳過', !g.correct && !g.skipped);
g = gradeWord(q, []);
chk('一次都沒聽到＝跳過（不計分）', !g.correct && g.skipped);
g = gradeWord(q, ['', ' ']);
chk('空白字串也是跳過', g.skipped);

chk('預設題型不含口說（要前端確認可用才要求）', !WORD_MODES.includes('speak') && ALL_WORD_MODES.includes('speak'));
const words = ['apple', 'book', 'cat', 'dog'].map((t, i) => ({ ...w, id: i + 1, term: t, box: 0, total: 0, correct: 0, dueAt: 0 }));
const quiz = generateWordQuiz(words, { count: 4, modes: ['speak'] });
chk('只選口說：整份都是口說題', quiz.length === 4 && quiz.every(x => x.mode === 'speak'), JSON.stringify(quiz.map(x => x.mode)));
chk('沒指定題型時不會出口說', generateWordQuiz(words, { count: 8 }).every(x => x.mode !== 'speak'));

console.log(fail ? `\n${fail} 項失敗` : '\n全部通過');
process.exit(fail ? 1 : 0);
