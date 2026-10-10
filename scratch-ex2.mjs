import fs from 'node:fs';
const edit = (f, pairs) => { let s = fs.readFileSync(f, 'utf8'); for (const [a, b] of pairs){ if (!s.includes(a)) throw new Error(f + ' nf: ' + a.slice(0, 60)); s = s.replace(a, () => b); } fs.writeFileSync(f, s); };
edit('src/exercises.mjs', [["  for (const rec of shuffle(records))\n    for (const t of wanted){", "  for (const rec of shuffle(records.filter(r => wholeSentence(r.data))))     // 口語短句（Right. / Wow!）不出文法題\n    for (const t of wanted){"]]);
edit('src/papers/gen.mjs', [["  return pool.records.filter(r => r.data.translation && (r.data.original.split(/\s+/).length >= 3)).map(r => ({", "  return pool.records.filter(r => r.data.translation && !r.data.issue && (r.data.original.split(/\s+/).length >= 3)).map(r => ({"]]);
