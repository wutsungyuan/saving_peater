// 單字測驗的填空題：字表原有的例句之外，也從已分析的句庫抽句子，每次看到的句子不會固定那幾句。
// 跑法：node --no-warnings test/word-bank.mjs
import { WORD_BUILDERS, bankExamples, wordForms, gradeWord, generateWordQuiz } from '../src/wordset.mjs';

let fail = 0;
const chk = (name, ok, detail = '') => { console.log(`${ok ? '  ✓' : '  ✗'} ${name}${ok ? '' : '  ' + detail}`); if (!ok) fail++; };
const w = (id, term, senses) => ({ id, term, syllables: term, senses, confusable: [], family: [] });
const teach = w(1, 'teach', [{ pos: 'v', zh: '教', example: 'She teaches English.', exampleZh: '她教英文。' }]);
const bank = [
  { en: 'He taught me how to swim.', zh: '他教我游泳。' },
  { en: 'Teachers work hard.', zh: '老師很努力。' },
  { en: 'I want to teach my brother.', zh: '我想教我弟弟。' },
  { en: 'The teacher is nice.', zh: '老師人很好。' },
  { en: 'She teaches English.', zh: '她教英文。' },           // 和字表例句相同，不重複計入
];
const forms = new Map([['teach', { base: 'teach', past: 'taught', pastParticiple: 'taught', ing: 'teaching', third: 'teaches' }]]);

chk('變化形：規則、不規則、y→ies、重複子音', wordForms('teach', forms.get('teach')).has('taught')
  && wordForms('study').has('studies') && wordForms('stop').has('stopped') && wordForms('make').has('making'));
const got = bankExamples(teach, bank, forms);
chk('只收字本身或變化形（taught、teach、teaches），不收 teacher(s)', got.map(x => x.f.text).sort().join() === 'taught,teach,teaches', got.map(x => x.f.text).join());
chk('縮寫、太短、片語不收', !bankExamples(w(2, 'PE', []), bank).length && !bankExamples(w(3, 'a', []), bank).length && !bankExamples(w(4, 'look at', []), bank).length);

// 抽很多次：字表原句和句庫的句子都要出現
const seen = new Set();
for (let i = 0; i < 200; i++){
  const q = WORD_BUILDERS.cloze(teach, [teach], { bank, verbForms: forms });
  seen.add(q.question);
}
chk(`出現 3 種不同的句子（字表 1＋句庫 2 不重複）`, seen.size === 3, [...seen].join(' | '));

const bq = (() => { for (let i = 0; i < 200; i++){ const q = WORD_BUILDERS.cloze(teach, [teach], { bank, verbForms: forms }); if (q.meta.src === 'bank') return q; } })();
chk('句庫題：句子挖空、提示是整句中文翻譯', bq && bq.question.includes('______') && /他教我游泳|我想教我弟弟/.test(bq.hint), JSON.stringify(bq));
chk('句庫題：答案是句中的形式，原形也算對', bq && gradeWord(bq, [bq.answer[0]]).correct && (bq.answer[0] === 'teach' || gradeWord(bq, ['teach']).correct), JSON.stringify(bq));
chk('句庫題：senseIdx 為 null（不歸到任何詞義）', bq && bq.meta.senseIdx === null);

// 沒有任何例句的字，有句庫就能出填空題；沒有句庫則維持原樣
const bare = w(5, 'swim', [{ pos: 'v', zh: '游泳' }]);
chk('沒有句庫：沒例句的字仍不出填空', WORD_BUILDERS.cloze(bare, [bare], {}) === null);
const qs = generateWordQuiz([teach], { count: 5, modes: ['cloze'], verbForms: forms, bank });
chk('整份測驗可以用 bank 出題', qs.length > 0 && qs.every(q => q.mode === 'cloze'));
// 隱藏句：模型給的備用例句要先過濾
import { cleanExtra } from '../src/wordset.mjs';
const raw = [
  { pos: 'v', example: 'She teaches English.', exampleZh: '重複' },                    // 和字表例句一樣 → 丟
  { pos: 'v', example: 'My uncle taught me chess.', exampleZh: '我叔叔教我下棋。' },
  { pos: 'v', example: 'The teacher is nice.', exampleZh: 'teacher 不是 teach' },   // 另一個字 → 丟
  { pos: 'v', example: 'Nothing here.', exampleZh: '沒有這個字' },                    // 沒含這個字 → 丟
  { pos: 'v', example: 'Please teach me.', exampleZh: '' },                          // 沒翻譯 → 丟
  { pos: 'v', example: 'I like to teach kids.', exampleZh: '我喜歡教小孩。' },
  { pos: 'v', example: 'Can you teach me?', exampleZh: '你能教我嗎？' },
  { pos: 'v', example: 'They teach every day.', exampleZh: '他們每天教書。' },          // 超過 3 句 → 丟
];
const ce = cleanExtra('teach', raw, teach.senses, forms);
chk('不認得的不規則形（沒有三態資料）→ taught 那句丟掉，不亂收', !cleanExtra('teach', raw, teach.senses).some(x => /taught/.test(x.example)));
chk('隱藏句過濾：重複、另一個字、沒含該字、沒翻譯都丟，最多 3 句', ce.length === 3 && ce.map(x => x.example).join('|') === 'My uncle taught me chess.|I like to teach kids.|Can you teach me?', JSON.stringify(ce));
chk('隱藏句：不是陣列、縮寫 → 空', !cleanExtra('teach', 'x').length && !cleanExtra('PE', raw).length);
const withExtra = { ...teach, extra: ce };
const seen2 = new Set();
for (let i = 0; i < 300; i++) seen2.add(WORD_BUILDERS.cloze(withExtra, [withExtra], { verbForms: forms }).question);
chk('填空題抽得到字表原句與 3 句隱藏句（共 4 種），沒有句庫也行', seen2.size === 4, [...seen2].join(' | '));
console.log(fail ? `\n有失敗 (${fail})` : '\n全部通過');
process.exit(fail ? 1 : 0);
