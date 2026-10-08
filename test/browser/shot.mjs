// 用 CDP 驅動無頭 Chrome：切分頁、量溢出、截圖
import { spawn } from 'node:child_process';
import { mkdirSync } from 'node:fs';
// 截圖放專案裡的 test/browser/out（已 gitignore）
const OUT = new URL('./out/', import.meta.url).pathname;
mkdirSync(OUT, { recursive: true });

import { writeFileSync } from 'node:fs';

const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const PORT = 9333, W = Number(process.argv[2] || 390), H = Number(process.argv[3] || 900);
const TABS = (process.argv[4] || 'analyze,words,practice,weak,history').split(',');

const chrome = spawn(CHROME, ['--headless', '--disable-gpu', '--no-sandbox', '--hide-scrollbars',
  `--remote-debugging-port=${PORT}`, `--window-size=${W},${H}`, 'about:blank'],
  { stdio: ['ignore','ignore','ignore'] });

const wait = ms => new Promise(r => setTimeout(r, ms));
let ws, id = 0; const pend = new Map();
const send = (method, params = {}, sessionId) => new Promise((res, rej) => {
  const i = ++id; pend.set(i, { res, rej });
  ws.send(JSON.stringify({ id: i, method, params, sessionId }));
});

try {
  for (let i = 0; i < 40; i++){
    try { await fetch(`http://127.0.0.1:${PORT}/json/version`); break; } catch { await wait(250); }
  }
  // 新版 Chrome 的 /json/new 要 PUT；另外一定要挑 type==='page' 的 target，
  // 連到 browser target 會回「Target does not support metrics override」
  let t;
  try {
    t = await (await fetch(`http://127.0.0.1:${PORT}/json/new?http://127.0.0.1:8787/`,
      { method: 'PUT' })).json();
  } catch {}
  if (!t?.webSocketDebuggerUrl){
    const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
    t = list.find(x => x.type === 'page');
  }
  if (!t) throw new Error('找不到 page target');
  ws = new WebSocket(t.webSocketDebuggerUrl);
  await new Promise(r => ws.onopen = r);
  ws.onmessage = e => {
    const m = JSON.parse(e.data);
    if (m.id && pend.has(m.id)){ const p = pend.get(m.id); pend.delete(m.id); m.error ? p.rej(new Error(m.error.message)) : p.res(m.result); }
  };
  await send('Page.enable');
  await send('Emulation.setDeviceMetricsOverride', { width: W, height: H, deviceScaleFactor: 2, mobile: true });
  await send('Page.navigate', { url: 'http://127.0.0.1:8787/' });
  await wait(2500);

  for (const tab of TABS){
    await send('Runtime.evaluate', { expression:
      `document.querySelector('.tabs button[data-view="${tab}"]').click()`, awaitPromise: true });
    await wait(1400);
    const { result } = await send('Runtime.evaluate', { returnByValue: true, expression: `(() => {
      const de = document.documentElement;
      const over = [];
      for (const n of document.querySelectorAll('body *')){
        if (n.offsetParent === null && n !== document.body) continue;
        if (n.closest('.drawer:not(.open)')) continue;   // 收起來的抽屜本來就在畫面外
        const r = n.getBoundingClientRect();
        if (r.width > 0 && r.right > de.clientWidth + 1)
          over.push({ t: n.tagName.toLowerCase() + (n.id ? '#'+n.id : '') + (n.className && typeof n.className === 'string' ? '.'+n.className.trim().split(/\\s+/).slice(0,2).join('.') : ''),
                      right: Math.round(r.right), w: Math.round(r.width) });
      }
      // 只留最外層的幾個，避免整串子孫洗版
      const seen = new Set(); const top = [];
      for (const o of over){ if (!seen.has(o.t)){ seen.add(o.t); top.push(o); } }
      return { scrollW: de.scrollWidth, clientW: de.clientWidth, docH: de.scrollHeight, over: top.slice(0, 8) };
    })()` });
    const r = result.value;
    const bad = r.scrollW > r.clientW + 1;
    console.log(`  ${bad ? '✗' : '✓'} ${tab.padEnd(9)} scrollW=${r.scrollW} clientW=${r.clientW}${bad ? '  ← 橫向溢出' : ''}`);
    for (const o of r.over) console.log(`        ${o.t}  寬${o.w} 右緣${o.right}`);
    const shot = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true });
    writeFileSync(`${OUT}p-${tab}.png`, Buffer.from(shot.data, 'base64'));
  }
} finally { chrome.kill(); }
