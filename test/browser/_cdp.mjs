// 瀏覽器測試輔助：啟動 headless Chrome、用 CDP 操作頁面。新的測試用這個，不要再各自複製一份。
import { spawn } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createServer } from 'node:net';
import { CHROME, OUT } from './_env.mjs';

const wait = ms => new Promise(r => setTimeout(r, ms));
const freePort = () => new Promise(res => { const s = createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)); }); });

/** 開一個頁面。size：視窗寬高；mobile:true 模擬手機（觸控、窄螢幕）。 */
export async function openPage(url, { width = 1000, height = 900, mobile = false, settle = 2500 } = {}) {
  const port = await freePort();
  const chrome = spawn(CHROME, ['--headless', '--disable-gpu', '--no-sandbox', '--hide-scrollbars',
    `--remote-debugging-port=${port}`, `--window-size=${width},${height}`, 'about:blank'], { stdio: 'ignore' });
  for (let i = 0; i < 60; i++) { try { await fetch(`http://127.0.0.1:${port}/json/version`); break; } catch { await wait(250); } }
  let t; try { t = await (await fetch(`http://127.0.0.1:${port}/json/new?about:blank`, { method: 'PUT' })).json(); } catch {}
  if (!t?.webSocketDebuggerUrl) t = (await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()).find(x => x.type === 'page');
  const ws = new WebSocket(t.webSocketDebuggerUrl); await new Promise(r => ws.onopen = r);
  let id = 0; const pend = new Map(); const errors = [];
  ws.onmessage = e => {
    const m = JSON.parse(e.data);
    if (m.method === 'Runtime.exceptionThrown') errors.push(m.params.exceptionDetails.exception?.description || m.params.exceptionDetails.text);
    if (m.id && pend.has(m.id)) { const p = pend.get(m.id); pend.delete(m.id); m.error ? p.rej(new Error(m.error.message)) : p.res(m.result); }
  };
  const send = (method, params = {}) => new Promise((res, rej) => { const i = ++id; pend.set(i, { res, rej }); ws.send(JSON.stringify({ id: i, method, params })); });
  const evl = async expr => {
    const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
    return r.result.value;
  };
  await send('Runtime.enable'); await send('Page.enable');
  if (mobile) await send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 2, mobile: true });
  await send('Page.navigate', { url });
  await wait(settle);
  /** 輪詢直到條件成立（回傳 true）或逾時 */
  const until = async (expr, ms = 8000, step = 150) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { if (await evl(expr).catch(() => false)) return true; await wait(step); } return false; };
  const click = sel => evl(`(() => { const e = document.querySelector(${JSON.stringify(sel)}); if (!e) return false; e.click(); return true; })()`);
  const type = (sel, text) => evl(`(() => { const e = document.querySelector(${JSON.stringify(sel)}); e.focus(); e.value = ${JSON.stringify(text)}; e.dispatchEvent(new Event('input', { bubbles: true })); return true; })()`);
  const shot = async name => { mkdirSync(OUT, { recursive: true }); const r = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true }); writeFileSync(join(OUT, name), Buffer.from(r.data, 'base64')); return join(OUT, name); };
  const close = () => { try { ws.close(); } catch {} chrome.kill(); };
  return { send, evl, until, click, type, shot, wait, errors, close };
}

/** 斷言收集器：和其他測試一致的輸出格式 */
export function checker() {
  const results = [];
  return {
    chk: (name, cond, detail = '') => { results.push(Boolean(cond)); console.log(`  ${cond ? '✓' : '✗'} ${name}${cond ? '' : '  ' + String(detail).slice(0, 300)}`); },
    section: t => console.log(t),
    done: () => { const f = results.filter(x => !x).length; console.log(f ? `\n有失敗 (${f}/${results.length})` : `\n全部通過 (${results.length})`); return f ? 1 : 0; },
  };
}
