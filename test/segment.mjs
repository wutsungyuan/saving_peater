// 斷句：縮寫不誤切、真正的句尾要切。跑法：node --no-warnings test/segment.mjs
import { splitSentences, splitDialogue, dialogueUnits } from '../src/segment.mjs';

let fail = 0;
const chk = (name, ok, detail = '') => { console.log(`${ok ? '  ✓' : '  ✗'} ${name}${ok ? '' : '  ' + detail}`); if (!ok) fail++; };
const texts = s => splitSentences(s).map(x => x.text);
const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);

chk('Mr. 不切', eq(texts('Mr. Smith is here. He is nice.'), ['Mr. Smith is here.', 'He is nice.']));
chk('U.S. 不切', eq(texts('He lives in the U.S. now. She left.'), ['He lives in the U.S. now.', 'She left.']));
chk('小數不切', eq(texts('Pi is 3.14 today. Yes.'), ['Pi is 3.14 today.', 'Yes.']));
chk('J. K. Rowling 不切', eq(texts('J. K. Rowling wrote it. I read it.'), ['J. K. Rowling wrote it.', 'I read it.']));
chk('No. 後面接大寫的句子 → 句尾要切（以前黏成一句，後面就丟了）', eq(texts("No. I can't make up my mind because all the clubs are interesting. What about you?"),
  ['No.', "I can't make up my mind because all the clubs are interesting.", 'What about you?']), JSON.stringify(texts("No. I can't make up")));
chk('No. 5 當「第 5 號」不切', eq(texts('See No. 5 on the list. Then go.'), ['See No. 5 on the list.', 'Then go.']));
chk('He sat. 句尾要切（sat 也是縮寫表裡的字）', eq(texts('He sat. Then he left.'), ['He sat.', 'Then he left.']));
chk('Sat. 3 pm 不切', eq(texts('Meet on Sat. 3 pm please. Thanks.'), ['Meet on Sat. 3 pm please.', 'Thanks.']));
const turns = splitDialogue("Yuki: No. I can't make up my mind because all the clubs are interesting. What about you?\nCody: I'm thinking about the video game design club.");
chk('對話：一個人說的話拆成 3 句', eq(dialogueUnits(turns).filter(u => u.turn === 0).map(u => u.text), ['No.', "I can't make up my mind because all the clubs are interesting.", 'What about you?']));
console.log(fail ? `\n有失敗 (${fail})` : '\n全部通過 (10)');
process.exit(fail ? 1 : 0);
