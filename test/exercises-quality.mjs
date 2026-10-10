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
console.log(fail ? `\n有失敗 (${fail})` : '\n全部通過 (5)');
process.exit(fail ? 1 : 0);
