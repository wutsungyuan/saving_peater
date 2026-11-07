// 文字題答錯時說明錯在哪（空格、少字、多字、拼錯）。
// 跑法：node --no-warnings test/word-diagnose.mjs
import { diagnoseText } from '../src/wordset.mjs';

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

console.log(fail ? `\n${fail} 項失敗` : '\n全部通過');
process.exit(fail ? 1 : 0);
