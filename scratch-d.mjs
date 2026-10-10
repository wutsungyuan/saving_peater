import fs from 'node:fs';
const edit = (f, pairs) => { let s = fs.readFileSync(f, 'utf8'); for (const [a, b] of pairs){ if (!s.includes(a)) throw new Error(f + ' nf: ' + a.slice(0, 50)); s = s.replace(a, () => b); } fs.writeFileSync(f, s); };
edit('src/segment.mjs', [[
`/** 換行也是句子邊界。`,
`/** 對話拆成「一句一個單位」：一個人說的話裡有好幾句（Wow! You have a snowboard?）要各自分析，
 *  不然模型只回第一句、原句和送出去的對不上，後面的句子就丟了。
 *  回傳 [{ text, speaker, turn }]；turn 是第幾個人說的（同一個人說的句子 turn 相同）。 */
export function dialogueUnits(turns){
  const out = [];
  turns.forEach((t, turn) => {
    const parts = splitSentences(t.text).map(s => s.text.trim()).filter(Boolean);
    for (const text of parts.length ? parts : [t.text]) out.push({ text, speaker: t.speaker, turn });
  });
  return out;
}

/** 換行也是句子邊界。`]]);
edit('src/routes/analyze.mjs', [
["import { splitSentences, splitDialogue } from '../segment.mjs';", "import { splitSentences, splitDialogue, dialogueUnits } from '../segment.mjs';"],
[`    dlg = turns;
    segs = turns.map(t => ({ text: t.text }));`, `    dlg = dialogueUnits(turns);                     // 一個人說了好幾句時，每句各自分析
    segs = dlg.map(u => ({ text: u.text }));`],
[`        context: dlg.filter((_, k) => k !== i).map(t => \`\${t.speaker}: \${t.text}\`).join('\n') || null,`,
 `        context: dlg.filter(u => u.turn !== dlg[i]?.turn).map(t => \`\${t.speaker}: \${t.text}\`).join('\n') || null,`],
]);
edit('src/articles.mjs', [
["import { splitSentences, splitDialogue } from './segment.mjs';", "import { splitSentences, splitDialogue, dialogueUnits } from './segment.mjs';"],
["if (turns) return turns.map(t => ({ para: 0, text: t.text.trim() })).filter(s => s.text);", "if (turns) return dialogueUnits(turns).map(u => ({ para: 0, text: u.text.trim() })).filter(s => s.text);"],
]);
