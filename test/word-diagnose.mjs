// 文字題答錯時說明錯在哪（空格、少字、多字、拼錯）。
// 跑法：node --no-warnings test/word-diagnose.mjs
import { diagnoseText, tipRelevant, WORD_BUILDERS, gradeWord } from '../src/wordset.mjs';

let fail = 0;
const chk = (name, ok, detail = '') => { console.log(`${ok ? '  ✓' : '  ✗'} ${name}${ok ? '' : '  ' + detail}`); if (!ok) fail++; };
const E = "get butterflies in one's stomach";

let d = diagnoseText("getbutterflies in one's stomach", E);
chk('少空格：kind=space、標出黏在一起的字、不是拼字錯', d.kind === 'space' && d.marks.join() === 'getbutterflies' && /空格/.test(d.note), JSON.stringify(d));
d = diagnoseText("get butterflies in one's stomachh", E);
chk('多一個字母：kind=spell，指出哪個字', d.kind === 'spell' && d.marks.join() === 'stomachh' && /stomach/.test(d.note), JSON.stringify(d));
d = diagnoseText("get butterflies in one's stomch", E);
chk('少一個字母：kind=spell', d.kind === 'spell' && d.marks.join() === 'stomch', JSON.stringify(d));
d = diagnoseText("get butterflies in stomach", E);
chk("少字：kind=words，說少了 one's，沒有字被標紅", d.kind === 'words' && /少了 one's/.test(d.note) && !d.marks.length, JSON.stringify(d));
d = diagnoseText("get butterflies in one's stomach now", E);
chk('多字：標出多的字', d.kind === 'words' && /多了 now/.test(d.note) && d.marks.join() === 'now', JSON.stringify(d));
d = diagnoseText("butterflies get in one's stomach", E);
chk('順序不對', d.kind === 'order', JSON.stringify(d));
d = diagnoseText('', E);
chk('沒作答', d.kind === 'blank');
chk('完全一樣（含大小寫、多空格）回 null', diagnoseText("Get  butterflies in one's stomach", E) === null);
d = diagnoseText('recieve', 'receive');
chk('單字拼錯', d.kind === 'spell' && d.marks.join() === 'recieve');
d = diagnoseText('zzz', 'lesson');
chk('寫成別的字：不說拼錯，kind=words（不顯示拼字提示）', d.kind === 'words' && /不是這個字/.test(d.note) && d.marks.join() === 'zzz', JSON.stringify(d));
d = diagnoseText('lessen', 'lesson');
chk('只差一個字母還是拼錯', d.kind === 'spell');
d = diagnoseText('', 'a');
chk('空白不拋錯', !!d);

// ---- 真實題目：片語 get butterflies in one's stomach（感到緊張），帶「stomach」的拼字提示 ----
const phrase = { id: 168, term: E, syllables: "get but-ter-flies in one's stom-ach", spellTip: 'stomach 結尾是 -ach，不是 -ake。',
  senses: [{ pos: 'phr', zh: '感到緊張', example: 'I get butterflies in my stomach before a test.', exampleZh: '考試前我會感到緊張。' }], confusable: [], family: [] };
const q = WORD_BUILDERS.zh2en(phrase, [phrase]);
// 和 /api/wordattempts 一樣的處理，回傳小朋友實際會看到的「錯在哪」與解說
const shown = given => {
  const g = gradeWord(q, [given]);
  if (g.correct) return null;
  const diag = diagnoseText(given, q.answer[0]);
  const tip = /\n拼字：([^\n]*)$/.exec(q.explain)?.[1];
  const explain = tip && !tipRelevant(tip, q.answer[0], diag) ? q.explain.replace(/\n拼字：[^\n]*$/, '') : q.explain;
  return { note: diag.note, marks: diag.marks.join(), tip: /拼字：/.test(explain) };
};
let s = shown("getbutterflies in one's stomach");
chk('【這題】少了 get 後面的空格：指出是 getbutterflies，應寫成 get butterflies；不附 stomach 提示',
  s.note === '「getbutterflies」中間少了空格，應該寫成 get butterflies' && s.marks === 'getbutterflies' && !s.tip, JSON.stringify(s));
s = shown("get butterflies in one's stomachh");
chk('stomach 多一個 h：說 stomachh 拼錯，附 stomach 的提示', s.note === 'stomachh 拼錯了，應該是 stomach' && s.tip, JSON.stringify(s));
s = shown("get butterflies in one's stomch");
chk('stomach 少一個字母：附提示', s.note === 'stomch 拼錯了，應該是 stomach' && s.tip, JSON.stringify(s));
s = shown("get butterfies in one's stomach");
chk('拼錯的是 butterflies（stomach 寫對）：不附 stomach 的提示', /butterfies 拼錯了，應該是 butterflies/.test(s.note) && !s.tip, JSON.stringify(s));
s = shown("utterflies in one's stomach");
chk('缺開頭的 get b：butterflies 少字母、另外少了 get，不是亂配', s.note === 'utterflies 拼錯了，應該是 butterflies；少了 get' && !s.tip, JSON.stringify(s));
s = shown("get butter flies in one's stomach");
chk('多切了空格：butter flies 要連寫', s.note === '「butter flies」多了空格，應該連在一起寫成 butterflies' && s.marks === 'butter,flies' && !s.tip, JSON.stringify(s));
s = shown("get butterflies in one's stom ach");
chk('stomach 被切開', /「stom ach」多了空格/.test(s.note) && !s.tip, JSON.stringify(s));
s = shown("get butterflies in stomach");
chk('少了 one\'s', s.note === "少了 one's" && !s.tip, JSON.stringify(s));
// 單字題的提示沒有提到任何字：有字拼錯就附
chk('單字題（提示沒提到字）拼錯就附提示', tipRelevant('中間有兩個 s。', 'lesson', diagnoseText('lesen', 'lesson')));
chk('單字題寫成別的字不附提示', !tipRelevant('中間有兩個 s。', 'lesson', diagnoseText('zzz', 'lesson')));

console.log(fail ? `\n${fail} 項失敗` : '\n全部通過');
process.exit(fail ? 1 : 0);
