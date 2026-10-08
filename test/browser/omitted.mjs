// 「S、V 省略」標籤：句型寫 S+V+C，但原句沒有 S 或 V（感嘆句、祈使句）時，
// 標題旁要標出省略了哪些，圖上才對得起來。一般句子與已標「不是完整句子」的不能誤標。
// 資料用本機快取裡真的分析結果，不呼叫模型。
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';

const CHROME = process.env.CHROME || [
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
].find(existsSync);
if (!CHROME) throw new Error('找不到 Chrome，請用環境變數 CHROME 指定');
const PORT = 9362, BASE = process.env.BASE || 'http://127.0.0.1:8787/';
const DB = fileURLToPath(new URL('../../data/cache.db', import.meta.url));

const db = new DatabaseSync(DB, { readOnly: true });
const get = like => { const r = db.prepare('select result from sentences where original like ? limit 1').get(like); return r && JSON.parse(r.result); };
const exclam = get('What a lovely little dog!');
const normal = get('It was raining, but we went out anyway.');
if (!normal) throw new Error('快取裡找不到一般句子，無法測試');

const chrome = spawn(CHROME, ['--headless', '--disable-gpu', '--no-sandbox', '--hide-scrollbars',
  `--remote-debugging-port=${PORT}`, '--window-size=420,900', 'about:blank'], { stdio: 'ignore' });
const wait = ms => new Promise(r => setTimeout(r, ms));
let ws, id = 0; const pend = new Map(); const errs = [];
const send = (m, p = {}) => new Promise((res, rej) => { const i = ++id; pend.set(i, { res, rej }); ws.send(JSON.stringify({ id: i, method: m, params: p })); });
const evl = async e => (await send('Runtime.evaluate', { expression: e, returnByValue: true, awaitPromise: true })).result.value;
const pass = []; const chk = (n, c) => { pass.push(c); console.log(`  ${c ? '✓' : '✗'} ${n}`); };

try {
  for (let i = 0; i < 40; i++) { try { await fetch(`http://127.0.0.1:${PORT}/json/version`); break; } catch { await wait(250); } }
  let t; try { t = await (await fetch(`http://127.0.0.1:${PORT}/json/new?${BASE}`, { method: 'PUT' })).json(); } catch {}
  if (!t?.webSocketDebuggerUrl) t = (await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json()).find(x => x.type === 'page');
  ws = new WebSocket(t.webSocketDebuggerUrl); await new Promise(r => ws.onopen = r);
  ws.onmessage = e => {
    const m = JSON.parse(e.data);
    if (m.method === 'Runtime.exceptionThrown') errs.push(m.params.exceptionDetails.exception?.description || m.params.exceptionDetails.text);
    if (m.id && pend.has(m.id)) { const p = pend.get(m.id); pend.delete(m.id); m.error ? p.rej(new Error(m.error.message)) : p.res(m.result); }
  };
  await send('Runtime.enable'); await send('Page.enable');
  await send('Page.navigate', { url: BASE }); await wait(2500);

  // 回傳這句渲染出來的標籤文字
  const badges = async sent => evl(`(() => {
    const h = document.createElement('div');
    h.innerHTML = renderSentence(${JSON.stringify(sent)}, false);
    return [...h.querySelectorAll('.badges .badge')].map(b => b.textContent.trim());
  })()`);
  const clone = o => JSON.parse(JSON.stringify(o));

  if (exclam) {
    const b = await badges(exclam);
    chk('感嘆句（只有 C）標出「S、V 省略」', b.includes('S、V 省略'));
  } else console.log('  - 快取沒有感嘆句，略過這項');

  chk('一般句子不標省略', !(await badges(normal)).some(x => x.includes('省略')));

  const noS = clone(normal); noS.clauses[0].constituents = noS.clauses[0].constituents.filter(c => c.role !== 'S');
  chk('只缺主詞時標「S 省略」（祈使句）', (await badges(noS)).includes('S 省略'));

  const noV = clone(normal); noV.clauses[0].constituents = noV.clauses[0].constituents.filter(c => c.role !== 'V');
  chk('只缺動詞時標「V 省略」', (await badges(noV)).includes('V 省略'));

  const frag = clone(noS); frag.issue = 'fragment';
  chk('已標「不是完整句子」的不重複標', !(await badges(frag)).some(x => x.includes('省略')));

  const blank = clone(noS); blank.original = 'I _____ a dog.';
  chk('填空題不標省略', !(await badges(blank)).some(x => x.includes('省略')));

  chk('頁面沒有未捕捉的例外', errs.length === 0);
  if (errs.length) console.log(errs);
} catch (e) { console.log('ERR', e.message); pass.push(false); }
chrome.kill();
console.log(pass.every(Boolean) ? `\n全部通過 (${pass.length})` : `\n有失敗 (${pass.filter(x => !x).length}/${pass.length})`);
process.exit(pass.every(Boolean) ? 0 : 1);
