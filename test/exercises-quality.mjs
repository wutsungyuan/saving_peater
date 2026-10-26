// 文法題的句子品質：口語短句、片語、省略主詞或動詞的句子不出「第幾句型」之類的題。
// 跑法：node --no-warnings test/exercises-quality.mjs
import { generate } from '../src/exercises.mjs';

let fail = 0;
const chk = (name, ok, detail = '') => { console.log(`${ok ? '  ✓' : '  ✗'} ${name}${ok ? '' : '  ' + detail}`); if (!ok) fail++; };
const cons = roles => roles.map((role, i) => ({ text: role, role, start: i * 2, end: i * 2 + 1 }));
const rec = (original, { roles = ['S', 'V', 'O'], issue = null, pattern = 3 } = {}) => ({ hash: original,
  data: { original, translation: 'x', issue, words: original.split(' ').map((t, i) => ({ text: t.replace(/[.!?]/g, ''), pos: 'n', start: i * 2, end: i * 2 + 1 })),
    clauses: [{ role: 'main', pattern: { id: pattern, name: '句型', label: 'S+V' }, constituents: cons(roles), verb: { lemma: 'be' },
      tense: { time: 'present', aspect: 'simple', label: '現在簡單式', formula: 'S+V' } }], notes: [] } });
const run = records => generate(records, { count: 40, types: ['pattern', 'pos'] });

const good = rec('I borrowed a book from my aunt.');
const out = run([good, rec('Right.', { roles: ['C'], pattern: 2 }), rec('Wow!', { roles: [] }), rec('Thanks.', { roles: ['O'] }),
  rec('Great news.', { roles: ['C'], pattern: 2 }), rec('Open the door now.', { roles: ['V', 'O'] }), rec('A beautiful hat here.', { issue: 'fragment' })]);
const used = new Set(out.map(q => q.sentence));
chk('完整的句子照常出題', used.has('I borrowed a book from my aunt.'));
chk('一個字的口語短句（Right. / Wow! / Thanks.）不出題', !used.has('Right.') && !used.has('Wow!') && !used.has('Thanks.'), [...used].join(' | '));
chk('兩個字的短句不出', !used.has('Great news.'));
chk('標成片語（fragment）的句子不出', !used.has('A beautiful hat here.'));
chk('句型題：缺主詞的祈使句不出（圖上標不出 S）', !out.some(q => q.type === 'pattern' && q.sentence === 'Open the door now.'));

// 有文法錯誤的句子（故意寫錯、或小朋友寫錯的）：只出「改錯」，不拿來出時態、詞性、句型
const bad = rec('She go to school every day.');
bad.data.notes = [{ type: 'error', span: 'go', correction: 'goes', message: '第三人稱單數動詞要加 es。', errorCode: 'subject-verb' }];
const mixed = generate([good, bad], { count: 40, types: ['pattern', 'pos', 'tense', 'error-fix'] });
chk('有錯的句子不出句型、詞性、時態題', !mixed.some(q => q.sentence === bad.data.original && q.type !== 'error-fix'), JSON.stringify(mixed.filter(q => q.sentence === bad.data.original).map(q => q.type)));
chk('有錯的句子照常出改錯題', mixed.some(q => q.sentence === bad.data.original && q.type === 'error-fix'));
chk('沒有錯的句子不受影響', mixed.some(q => q.sentence === good.data.original && q.type !== 'error-fix'));
chk('只選句型、詞性時，有錯的句子完全不出', !generate([good, bad], { count: 40, types: ['pattern', 'pos'] }).some(q => q.sentence === bad.data.original));
// 時態填空：縮寫、否定不出；現在簡單式 be 動詞降低機率
const tenseRec = (original, lemma, time = 'present', vw = lemma === 'be' ? 'is' : lemma) => { const r = rec(original, { roles: ['S', 'V'] }); r.data.clauses[0].verb = { lemma }; r.data.clauses[0].tense.time = time;
  const i = original.split(' ').findIndex(w => w.toLowerCase().replace(/[^a-z'’]/g, '') === vw);
  const words = original.split(' '); let off = 0; for (let k = 0; k < i; k++) off += words[k].length + 1;
  r.data.clauses[0].constituents = [{ text: words[0], role: 'S', start: 0, end: words[0].length }, { text: words[i], role: 'V', start: off, end: off + words[i].length }]; return r; };
const tn = (r, n = 1) => { let c = 0; for (let k = 0; k < n; k++) c += generate([r], { count: 5, types: ['tense'] }).length; return c; };
chk('縮寫（It\'s）不出時態題', tn(tenseRec("It's too windy to fly a kite.", 'be', 'present', "it's"), 30) === 0);
const pool = [tenseRec('This cup is dirty today.', 'be'), tenseRec('I heard a sound last night.', 'hear', 'past', 'heard')];
let beN = 0; for (let k = 0; k < 600; k++) if (generate(pool, { count: 1, types: ['tense'] })[0].sentence.includes('cup')) beN++;
chk('現在簡單式 be 動詞被抽中的機會較低（約三成），但仍會出', beN > 80 && beN < 280, String(beN));
chk('其他動詞的時態題照常出', tn(tenseRec('I heard a sound last night.', 'hear', 'past', 'heard'), 5) === 5);
console.log(fail ? `\n有失敗 (${fail})` : '\n全部通過 (12)');
process.exit(fail ? 1 : 0);
