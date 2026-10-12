// 斷句：縮寫不誤切、真正的句尾要切。跑法：node --no-warnings test/segment.mjs
import { splitSentences, splitDialogue, dialogueUnits, splitInlineSpeakers } from '../src/segment.mjs';

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

// 考卷對話題：「?B:」黏在一起（使用者實際遇到：這三句整句分析失敗，「模型把這一句拆成了多句」）
const inl = t => splitInlineSpeakers(t);
chk('?B: 黏在一起 → 拆成兩行、拿掉 B:（第 9 題）', inl('Do you have time to play soccer with me?B: Sorry, I am not free now. I need to finish my piano lesson first.') === 'Do you have time to play soccer with me?\nSorry, I am not free now. I need to finish my piano lesson first.', JSON.stringify(inl('Do you have time to play soccer with me?B: Sorry, I am not free now.')));
chk('?B: 黏在一起（第 10 題，句中有 Ms. 縮寫）', inl('Hello, may I speak to Ms. Lin?B: Hold on, please. I will go get her.') === 'Hello, may I speak to Ms. Lin?\nHold on, please. I will go get her.');
chk('?B: 黏在一起（第 11 題）', inl("What are you looking for?B: My keys. I can't find them anywhere.") === "What are you looking for?\nMy keys. I can't find them anywhere.");
chk('拆完以後每一句都切得開（沒有 B: 殘留）', eq(inl("What are you looking for?B: My keys. I can't find them anywhere.").split('\n').flatMap(texts), ['What are you looking for?', 'My keys.', "I can't find them anywhere."]));
chk('有空格的「! B:」也拆；行首的 A: 一起拿掉', inl('A: I won the lottery yesterday! B: Really? Or are you pulling my leg?') === 'I won the lottery yesterday!\nReally? Or are you pulling my leg?', JSON.stringify(inl('A: I won the lottery yesterday! B: Really?')));
chk('一般句子不動', inl('I like cats. She runs fast.') === 'I like cats. She runs fast.');
chk('Plan B: / Vitamin C: 這種不是說話者，不動', inl('Plan B: we stay home. Vitamin C: it helps.') === 'Plan B: we stay home. Vitamin C: it helps.');
chk('每行都有標記的正常對話：不動（交給 splitDialogue）', inl('A: How are you?\nB: Fine, thanks.') === 'A: How are you?\nB: Fine, thanks.');
chk('已經分行、沒有標記的：不動', inl('Do you have time?\nSorry, I am not free.') === 'Do you have time?\nSorry, I am not free.');
chk('空字串、undefined 不會出錯', inl('') === '' && inl(undefined) === '');
console.log(fail ? `\n有失敗 (${fail})` : '\n全部通過 (20)');
process.exit(fail ? 1 : 0);
