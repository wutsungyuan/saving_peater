// 模型回覆的 JSON 容錯解析：fence、前後多餘文字、兩個物件、字串裡的括號。
// 跑法：node --no-warnings test/parse-json.mjs
import { parseModelJson } from '../src/analyzer.mjs';

let fail = 0;
const chk = (name, ok, detail = '') => { console.log(`${ok ? '  ✓' : '  ✗'} ${name}${ok ? '' : '  ' + detail}`); if (!ok) fail++; };
const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);

chk('純 JSON', eq(parseModelJson('{"a":1}'), { a: 1 }));
chk('markdown fence', eq(parseModelJson('```json\n{"a":1}\n```'), { a: 1 }));
chk('前後有說明文字', eq(parseModelJson('好的：{"a":1} 以上。'), { a: 1 }));
chk('兩個物件 → 取第一個（以前會 Unexpected non-whitespace）', eq(parseModelJson('{"a":1}\n{"b":2}'), { a: 1 }));
chk('字串裡有括號與跳脫引號', eq(parseModelJson('說明 {"a":"x}y\\"z","b":{"c":2}} 之後 {"q":1}'), { a: 'x}y"z', b: { c: 2 } }));
let threw = false; try { parseModelJson('I like cats.'); } catch { threw = true; }
chk('完全不是 JSON → 丟錯', threw);
console.log(fail ? `\n有失敗 (${fail})` : '\n全部通過 (6)');
process.exit(fail ? 1 : 0);
