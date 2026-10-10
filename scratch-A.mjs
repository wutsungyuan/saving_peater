import fs from 'node:fs';
const edit = (f, pairs) => { let s = fs.readFileSync(f, 'utf8'); for (const [a, b] of pairs){ if (!s.includes(a)) throw new Error(f + ' nf: ' + a.slice(0, 60)); s = s.replace(a, () => b); } fs.writeFileSync(f, s); };
edit('src/papers/pool.mjs', [
["      byPara.get(it.para).push({ hash: it.hash, original: it.sentence.original, data: it.sentence });",
 "      byPara.get(it.para).push({ hash: it.hash, original: it.sentence.original, data: it.sentence, speaker: it.speaker || null });"],
["    articles.push({ id: a.id, name: a.name,\n      paragraphs: [...byPara.entries()].sort((x, y) => x[0] - y[0]).map(([para, sentences]) => ({ para, sentences })) });",
 "    // 對話課文：文章表的「段」就是一次發言（para = 第幾次發言），帶說話者。出題時用說話者名字標出誰說的。\n    const paragraphs = [...byPara.entries()].sort((x, y) => x[0] - y[0]).map(([para, sentences]) => ({ para, sentences, speaker: sentences[0]?.speaker ?? null }));\n    articles.push({ id: a.id, name: a.name, dialogue: paragraphs.length >= 2 && paragraphs.every(p => p.speaker), paragraphs });"],
["export const haveOf = pool => ({ words: pool.words.length > 0, sent: pool.records.length > 0, art: pool.articles.some(a => a.paragraphs.length) });",
 "export const haveOf = pool => ({ words: pool.words.length > 0, sent: pool.records.length > 0, art: pool.articles.some(a => a.paragraphs.length),\n  dlg: pool.articles.some(a => a.dialogue) });"],
]);
// 文章文字：對話每次發言一行、前面標說話者；一般文章維持原樣（段落空一行）
edit('src/papers/gen.mjs', [
["const textOfParas = paras => paras.map(p => p.map(s => s.text).join(' ')).join('\n\n');", "const textOfParas = paras => paras.map(p => p.map(s => s.text).join(' ')).join('\n\n');\n/** 組出短文：對話課文每次發言一行，前面標說話者（Jamie: …）；一般文章段落之間空一行 */\nconst passageText = (art, paras) => art.dialogue\n  ? paras.map(p => `${art.paragraphs.find(x => x.para === p.para)?.speaker ?? ''}: ${p.items.join(' ')}`).join('\n')\n  : paras.map(p => p.items.join(' ')).join('\n\n');"],
["    const passage = { title: art.name, text: paras.map(p => p.items.map(i => i.text).join(' ')).join('\n\n') };", "    const passage = { title: art.name, text: passageText(art, paras.map(p => ({ para: p.para, items: p.items.map(i => i.text) }))) };"],
["text: paras.map(p => p.items.join(' ')).join('\n\n'), bank: bank.map(x => x.value) }", "text: passageText(art, paras), bank: bank.map(x => x.value) }"],
]);
edit('prototype/js/papers.js', [["return esc(text).replace(/\((\d+)\)/g, '<b class=\"p-blank\">($1)</b>').replace(/\n\n/g, '</p><p>');", "return esc(text).replace(/\((\d+)\)/g, '<b class=\"p-blank\">($1)</b>').replace(/\n\n/g, '</p><p>').replace(/\n/g, '<br>');"]]);
