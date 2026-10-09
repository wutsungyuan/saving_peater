// 朗讀按鈕：iPhone 的語音清單常常晚到、甚至一直是空的，按鈕不能因此消失。
// 用 addScriptToEvaluateOnNewDocument 在頁面載入前把 speechSynthesis 換成各種狀況。
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';

const CHROME = process.env.CHROME || [
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
].find(existsSync);
if (!CHROME) throw new Error('找不到 Chrome，請用環境變數 CHROME 指定');
const PORT = 9363, BASE = process.env.BASE || 'http://127.0.0.1:8787/';
const chrome = spawn(CHROME, ['--headless', '--disable-gpu', '--no-sandbox', '--hide-scrollbars',
  `--remote-debugging-port=${PORT}`, '--window-size=420,900', 'about:blank'], { stdio: 'ignore' });
const wait = ms => new Promise(r => setTimeout(r, ms));
let ws, id = 0; const pend = new Map(); const errs = [];
const send = (m, p = {}) => new Promise((res, rej) => { const i = ++id; pend.set(i, { res, rej }); ws.send(JSON.stringify({ id: i, method: m, params: p })); });
const evl = async e => (await send('Runtime.evaluate', { expression: e, returnByValue: true, awaitPromise: true })).result.value;
const pass = []; const chk = (n, c) => { pass.push(c); console.log(`  ${c ? '✓' : '✗'} ${n}`); };

// 一次測一種情況：stub 是頁面載入前要執行的腳本
async function scenario(name, stub) {
  console.log(name);
  await send('Page.navigate', { url: 'about:blank' }); await wait(300);
  const { identifier } = await send('Page.addScriptToEvaluateOnNewDocument', { source: stub });
  await send('Page.navigate', { url: BASE }); await wait(3500);
  const r = await evl(`(() => {
    const first = document.querySelector('.sayx');
    const dem = document.querySelector('.say');
    const shown = el => !!el && getComputedStyle(el).display !== 'none' && el.getBoundingClientRect().width > 0;
    return { speechClass: document.body.classList.contains('has-speech'),
             sayx: document.querySelectorAll('.sayx').length, firstShown: shown(first),
             ctl: !document.getElementById('spkCtl').hidden };
  })()`);
  await send('Page.removeScriptToEvaluateOnNewDocument', { identifier });
  return r;
}

try {
  for (let i = 0; i < 40; i++) { try { await fetch(`http://127.0.0.1:${PORT}/json/version`); break; } catch { await wait(250); } }
  let t; try { t = await (await fetch(`http://127.0.0.1:${PORT}/json/new?about:blank`, { method: 'PUT' })).json(); } catch {}
  if (!t?.webSocketDebuggerUrl) t = (await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json()).find(x => x.type === 'page');
  ws = new WebSocket(t.webSocketDebuggerUrl); await new Promise(r => ws.onopen = r);
  ws.onmessage = e => {
    const m = JSON.parse(e.data);
    if (m.method === 'Runtime.exceptionThrown') errs.push(m.params.exceptionDetails.exception?.description || m.params.exceptionDetails.text);
    if (m.id && pend.has(m.id)) { const p = pend.get(m.id); pend.delete(m.id); m.error ? p.rej(new Error(m.error.message)) : p.res(m.result); }
  };
  await send('Runtime.enable'); await send('Page.enable');

  // 1) 語音清單一直是空的（iOS WebView 的情況），但有 speechSynthesis
  const empty = await scenario('語音清單一直是空的', `
    Object.defineProperty(window.speechSynthesis, 'getVoices', { value: () => [] });`);
  chk('has-speech 有開（不等清單）', empty.speechClass);
  chk('朗讀控制列有顯示', empty.ctl);
  if (empty.sayx === 0) console.log('  - 本機資料庫沒有單字，略過單字清單的按鈕檢查');
  else { chk('單字清單有朗讀鈕', empty.sayx > 0); chk('朗讀鈕看得到', empty.firstShown); }

  // 2) 清單晚 4 秒才有（超過舊程式的 2.5 秒上限）
  const late = await scenario('語音清單晚 4 秒才出現', `
    (() => { const real = speechSynthesis.getVoices.bind(speechSynthesis); const t0 = Date.now();
      Object.defineProperty(speechSynthesis, 'getVoices', { value: () => Date.now() - t0 < 4000 ? [] : real() }); })();`);
  chk('晚到時 has-speech 也有開', late.speechClass);
  if (late.sayx) chk('晚到時單字清單仍有朗讀鈕', late.firstShown);

  // 3) 瀏覽器根本沒有語音合成：按鈕要藏起來，不能出現按了沒反應的鈕
  const none = await scenario('完全沒有 speechSynthesis', `
    Object.defineProperty(window, 'speechSynthesis', { value: undefined, configurable: true });`);
  chk('沒有語音合成時 has-speech 不開', !none.speechClass);
  if (none.sayx) chk('沒有語音合成時朗讀鈕是藏起來的', !none.firstShown);

  chk('頁面沒有未捕捉的例外', errs.length === 0);
  if (errs.length) console.log(errs);
} catch (e) { console.log('ERR', e.message); pass.push(false); }
chrome.kill();
console.log(pass.every(Boolean) ? `\n全部通過 (${pass.length})` : `\n有失敗 (${pass.filter(x => !x).length}/${pass.length})`);
process.exit(pass.every(Boolean) ? 0 : 1);
