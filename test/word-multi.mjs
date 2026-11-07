// 多義字的英翻中：複選題（全部意思都要選出來）。單義字、測驗卷維持單選。
// 跑法：node --no-warnings test/word-multi.mjs
import { WORD_BUILDERS, gradeWord, generateWordQuiz } from '../src/wordset.mjs';

let fail = 0;
const chk = (name, ok, detail = '') => { console.log(`${ok ? '  ✓' : '  ✗'} ${name}${ok ? '' : '  ' + detail}`); if (!ok) fail++; };
const w = (id, term, senses) => ({ id, term, syllables: term, senses, confusable: [], family: [] });
const light = w(1, 'light', [{ pos: 'n', zh: '燈；光' }, { pos: 'adj', zh: '輕的' }, { pos: 'adj', zh: '淺色的' }, { pos: 'v', zh: '點燃' }]);
const book = w(2, 'book', [{ pos: 'n', zh: '書' }]);
const dup = w(3, 'fine', [{ pos: 'adj', zh: '好的' }, { pos: 'adj', zh: '好的' }]);        // 兩個意思一樣，其實只有一個
const others = ['蘋果', '跑', '大的', '快樂的', '老師', '吃', '水', '桌子'].map((zh, i) => w(10 + i, `x${i}`, [{ pos: i % 2 ? 'adj' : 'n', zh }]));
const all = [light, book, dup, ...others];

for (let i = 0; i < 40; i++){
  const q = WORD_BUILDERS.en2zh(light, all, { multi: true });
  if (!(q.multi && q.inputMode === 'choice')) { chk('多義字出複選題', false, JSON.stringify(q)); break; }
  if (i === 0){
    chk('最多考 3 個意思，取前面的', q.answer.join() === '燈；光,輕的,淺色的', q.answer.join());
    chk('選項 5 個（3 個答案＋2 個干擾）', q.choices.length === 5, String(q.choices.length));
    chk('題目說明有幾個意思、可複選', /有 3 個意思/.test(q.prompt) && /複選/.test(q.hint), q.prompt + q.hint);
    chk('解說列出所有意思（含沒考的第 4 個）', /點燃/.test(q.explain), q.explain);
    chk('meta 標記複選、senseIdx 為第一個答案', q.meta.multi === true && q.meta.senseIdx === 0);
  }
  if (q.choices.some(c => c.value === '點燃')) { chk('干擾項不能是這個字自己的意思', false, JSON.stringify(q.choices)); break; }
  if (i === 39) chk('干擾項不含這個字自己的任何意思（40 次）', true);
}

const q = WORD_BUILDERS.en2zh(light, all, { multi: true });
chk('全選對（順序不拘）算對', gradeWord(q, [...q.answer].reverse()).correct);
chk('少選算錯', !gradeWord(q, q.answer.slice(1)).correct);
chk('多選算錯', !gradeWord(q, [...q.answer, q.choices.find(c => !q.answer.includes(c.value)).value]).correct);
chk('沒選算錯', !gradeWord(q, []).correct && !gradeWord(q, ['']).correct);

const two = WORD_BUILDERS.en2zh(w(20, 'play', [{ pos: 'v', zh: '玩' }, { pos: 'v', zh: '演奏' }]), all, { multi: true });
chk('2 個意思配 3 個干擾項，一共 5 個選項', two.choices.length === 5 && two.answer.length === 2, JSON.stringify(two.choices));

const single = WORD_BUILDERS.en2zh(book, all, { multi: true });
chk('單義字維持單選', !single.multi && single.answer.length === 1);
chk('兩個意思重複的字當單義字', !WORD_BUILDERS.en2zh(dup, all, { multi: true }).multi);
chk('沒開 multi（測驗卷）時多義字也維持單選', !WORD_BUILDERS.en2zh(light, all).multi);

const tiny = [light, book];
chk('其他字太少湊不出干擾項：退回單選，不出壞題', !WORD_BUILDERS.en2zh(light, tiny, { multi: true })?.multi);

const quiz = generateWordQuiz(all, { count: all.length, modes: ['en2zh'] });
chk('整份測驗：多義字是複選、其他是單選', quiz.some(x => x.multi) && quiz.some(x => !x.multi), JSON.stringify(quiz.map(x => [x.term, !!x.multi])));

console.log(fail ? `\n${fail} 項失敗` : '\n全部通過');
process.exit(fail ? 1 : 0);
