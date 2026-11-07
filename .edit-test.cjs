const fs = require('fs'); const f = 'test/word-diagnose.mjs'; let t = fs.readFileSync(f, 'utf8');
const rep = (a, b) => { if (!t.includes(a)) throw new Error('missing: ' + a.slice(0, 50)); t = t.replace(a, b); };
rep("chk('多一個字母：kind=spell，指出哪個字', d.kind === 'spell' && d.marks.join() === 'stomachh' && /stomach/.test(d.note), JSON.stringify(d));",
    "chk('片語多一個字母：中性對照（不判斷拼錯），標出 stomachh', d.kind === 'diff' && d.marks.join() === 'stomachh' && d.note === '你寫「stomachh」，正解是「stomach」', JSON.stringify(d));");
rep("chk('少一個字母：kind=spell', d.kind === 'spell' && d.marks.join() === 'stomch', JSON.stringify(d));",
    "chk('片語少一個字母：同樣中性對照', d.kind === 'diff' && d.marks.join() === 'stomch', JSON.stringify(d));");
rep("chk(\"少字：kind=words，說少了 one's，沒有字被標紅\", d.kind === 'words' && /少了 one's/.test(d.note) && !d.marks.length, JSON.stringify(d));",
    "chk(\"少字：說少了「one's」，沒有字被標紅\", d.kind === 'diff' && d.note === \"少了「one's」\" && !d.marks.length, JSON.stringify(d));");
rep("chk('多字：標出多的字', d.kind === 'words' && /多了 now/.test(d.note) && d.marks.join() === 'now', JSON.stringify(d));",
    "chk('多字：標出多的字', d.kind === 'diff' && d.note === '多了「now」' && d.marks.join() === 'now', JSON.stringify(d));");
rep("chk('stomach 多一個 h：說 stomachh 拼錯，附 stomach 的提示', s.note === 'stomachh 拼錯了，應該是 stomach' && s.tip, JSON.stringify(s));",
    "chk('stomach 多一個 h：中性對照，附 stomach 的提示（錯的就是提示講的那個字）', s.note === '你寫「stomachh」，正解是「stomach」' && s.tip, JSON.stringify(s));");
rep("chk('stomach 少一個字母：附提示', s.note === 'stomch 拼錯了，應該是 stomach' && s.tip, JSON.stringify(s));",
    "chk('stomach 少一個字母：附提示', s.note === '你寫「stomch」，正解是「stomach」' && s.tip, JSON.stringify(s));");
rep("chk('拼錯的是 butterflies（stomach 寫對）：不附 stomach 的提示', /butterfies 拼錯了，應該是 butterflies/.test(s.note) && !s.tip, JSON.stringify(s));",
    "chk('錯的是 butterflies（stomach 寫對）：不附 stomach 的提示', s.note === '你寫「butterfies」，正解是「butterflies」' && !s.tip, JSON.stringify(s));");
rep("chk('缺開頭的 get b：butterflies 少字母、另外少了 get，不是亂配', s.note === 'utterflies 拼錯了，應該是 butterflies；少了 get' && !s.tip, JSON.stringify(s));",
    "chk('缺開頭的 get b：只對照「你寫 utterflies／正解 get butterflies」，不亂配、不說拼錯', s.note === '你寫「utterflies」，正解是「get butterflies」' && !s.tip, JSON.stringify(s));");
rep("chk('少了 one\'s', s.note === \"少了 one's\" && !s.tip, JSON.stringify(s));",
    "chk('少了 one\'s', s.note === \"少了「one's」\" && !s.tip, JSON.stringify(s));\n" +
    "// 片語裡單複數、時態不同：只中性對照，不說「拼錯」，也不附拼字提示\n" +
    "for (const [g, note] of [[\"get butterfly in one's stomach\", '你寫「butterfly」，正解是「butterflies」'], [\"gets butterflies in one's stomach\", '你寫「gets」，正解是「get」'],\n" +
    "  [\"got butterflies in one's stomach\", '你寫「got」，正解是「get」'], [\"get butterflys in one's stomach\", '你寫「butterflys」，正解是「butterflies」']]){\n" +
    "  s = shown(g);\n" +
    "  chk(`片語：${g.split(' ').find(w => /butterfl|gets|got/.test(w))} 只對照、不說拼錯、不附提示`, s.note === note && !/拼錯/.test(s.note) && !s.tip, JSON.stringify(s));\n}");
fs.writeFileSync(f, t);
