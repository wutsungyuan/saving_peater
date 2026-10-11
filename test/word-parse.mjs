// 單字表文字解析：一行用 / 隔開的相近字要拆成各自的單字。跑法：node --no-warnings test/word-parse.mjs
import { parseWordList, splitAlternatives } from '../src/wordset.mjs';

let fail = 0;
const chk = (name, ok, detail = '') => { console.log(`${ok ? '  ✓' : '  ✗'} ${name}${ok ? '' : '  ' + detail}`); if (!ok) fail++; };
const terms = text => parseWordList(text).map(w => w.term).join('|');

chk('normally / generally → 兩個字', terms('normally / generally') === 'normally|generally', terms('normally / generally'));
chk('沒有空白的 normally/generally 也拆', terms('normally/generally') === 'normally|generally');
chk('片語：hardly ever / almost never → 兩個片語', terms('hardly ever / almost never') === 'hardly ever|almost never', terms('hardly ever / almost never'));
chk('一行三個也拆', terms('seldom / rarely / hardly') === 'seldom|rarely|hardly');
chk('中文也用 / 分開、段數一樣 → 各給各的', JSON.stringify(parseWordList('often / frequently, 常常 / 頻繁地')) === JSON.stringify([{ term: 'often', zh: '常常' }, { term: 'frequently', zh: '頻繁地' }]));
chk('中文只有一段 → 兩個字共用', JSON.stringify(parseWordList('normally / generally, 通常')) === JSON.stringify([{ term: 'normally', zh: '通常' }, { term: 'generally', zh: '通常' }]));
chk('沒有中文 → zh 是 null', parseWordList('seldom / rarely').every(w => w.zh === null));
chk('帶句點的縮寫不拆（a.m./p.m.）', terms('a.m./p.m.') === 'a.m./p.m.', terms('a.m./p.m.'));
chk('單一單字照舊', terms('lesson, 課程') === 'lesson' && terms('look for') === 'look for');
chk('拆開後重複的字去重', terms('often / frequently\nfrequently\noften') === 'often|frequently', terms('often / frequently\nfrequently\noften'));
chk('註解行與空行照舊略過', terms('# 頻率副詞\n\nalways\n/ 隨手寫的') === 'always', terms('# 頻率副詞\n\nalways\n/ 隨手寫的'));
chk('splitAlternatives 單獨用：不是純英文就原樣', splitAlternatives('3/4').length === 1 && splitAlternatives('3/4')[0].term === '3/4');
console.log(fail ? `\n有失敗 (${fail})` : '\n全部通過');
process.exit(fail ? 1 : 0);
