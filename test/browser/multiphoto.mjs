// 一次選多張照片：單字分頁與分析分頁。
// 辨識 API 用假回應取代（不花額度），驗證的是前端的累加、去重、失敗續跑與可捲動。
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';

const CHROME = process.env.CHROME || [
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
].find(existsSync);
if (!CHROME) throw new Error('找不到 Chrome，請用環境變數 CHROME 指定');
const PORT = 9361, BASE = process.env.BASE || 'http://127.0.0.1:8787/';
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

  // 假的辨識 API：依序回傳預先排好的結果
  await evl(`
    window.__q = { words: [], analyze: [] };
    const realFetch = window.fetch.bind(window);
    window.fetch = (url, opt) => {
      const key = String(url).includes('wordset-ocr') ? 'words' : String(url).includes('analyze-ocr') ? 'analyze' : null;
      if (!key) return realFetch(url, opt);
      const r = window.__q[key].shift();
      return Promise.resolve(new Response(JSON.stringify(r), { status: 200, headers: { 'content-type': 'application/json' } }));
    };
    window.__files = n => Array.from({ length: n }, (_, i) => new File(['x'], 'p' + i + '.jpg', { type: 'image/jpeg' }));
  `);

  chk('單字分頁的檔案輸入允許多選', await evl(`document.getElementById('wsFile').multiple`));
  chk('分析分頁的檔案輸入允許多選', await evl(`document.getElementById('anFile').multiple`));
  chk('檔案輸入沒有 capture（不會強制開相機）',
      await evl(`!document.getElementById('wsFile').hasAttribute('capture') && !document.getElementById('anFile').hasAttribute('capture')`));
  chk('單字表文字框可以捲動', (await evl(`getComputedStyle(document.getElementById('wsText')).overflowY`)) === 'auto');

  // ---- 單字：三張，第二張失敗，第三張有一個字和第一張重複 ----
  const many = Array.from({ length: 12 }, (_, i) => `word${i}, 字${i}`).join('\n');
  await evl(`
    document.getElementById('wsText').value = '';
    window.__q.words = [
      { words: new Array(12).fill(1), text: ${JSON.stringify(many)}, usage: { costUsd: 0.01 } },
      { error: 'other', message: '壞了' },
      { words: [1, 2], text: 'Word0, 重複\\nteach, 教導', usage: { costUsd: 0.01 } },
    ];
  `);
  await evl(`handleImageFile(window.__files(3))`);
  const lines = (await evl(`document.getElementById('wsText').value`)).split('\n').filter(Boolean);
  const hint = await evl(`document.getElementById('wsHint').textContent`);
  chk('三張依序累加（12 + 1 個新字 = 13 行）', lines.length === 13);
  chk('第一張的內容還在', lines[0] === 'word0, 字0');
  chk('重複的字（大小寫不同）被略過', !lines.some(l => l.startsWith('Word0')));
  chk('第三張的新字有接上', lines.at(-1) === 'teach, 教導');
  chk('提示說明哪一張失敗', hint.includes('第 2 張') && hint.includes('壞了'));
  chk('提示說明略過了重複', hint.includes('略過 1'));
  chk('跑完按鈕恢復可按', await evl(`!document.getElementById('wsPhoto').disabled && !document.getElementById('wsCreate').disabled`));

  // ---- 單字：全部失敗時，文字框維持原狀 ----
  await evl(`window.__q.words = [{ error: 'other', message: 'x' }, { words: [], text: '', usage: {} }]`);
  await evl(`handleImageFile(window.__files(2))`);
  chk('全部失敗時舊內容不變', (await evl(`document.getElementById('wsText').value`)).split('\n').filter(Boolean).length === 13);

  // ---- 分析：兩張，第二張的第一行與第一張重複 ----
  await evl(`
    curKind = null; setInput('');
    window.__q.analyze = [
      { text: 'I like cats.\\nShe runs.', usage: { costUsd: 0.02 } },
      { text: 'she runs.\\nHe sleeps.', usage: { costUsd: 0.02 } },
    ];
  `);
  await evl(`handleAnalyzeImage(window.__files(2))`);
  const an = (await evl(`document.getElementById('inp').value`)).split('\n').filter(Boolean);
  chk('分析：兩張累加並去掉重複行（3 行）', an.length === 3 && an[2] === 'He sleeps.');
  chk('分析：提示顯示張數與總行數', (await evl(`document.getElementById('inp-hint').textContent`)).includes('辨識了 2 張'));

  // ---- 分析：輸入框裡是範例句時，第一張直接取代，不接在範例後面 ----
  await evl(`
    curKind = 'p1'; setInput('This is an example.');
    window.__q.analyze = [{ text: 'Real line.', usage: { costUsd: 0.01 } }];
  `);
  await evl(`handleAnalyzeImage(window.__files(1))`);
  chk('分析：範例句會被取代', (await evl(`document.getElementById('inp').value`)) === 'Real line.');

  // ---- 單張仍然可用（舊呼叫方式傳單一 File）----
  await evl(`document.getElementById('wsText').value = ''; window.__q.words = [{ words: [1], text: 'solo, 單獨', usage: { costUsd: 0 } }]`);
  await evl(`handleImageFile(window.__files(1)[0])`);
  chk('單張（直接傳 File）也能運作', (await evl(`document.getElementById('wsText').value`)) === 'solo, 單獨');

  chk('頁面沒有未捕捉的例外', errs.length === 0);
  if (errs.length) console.log(errs);
} catch (e) { console.log('ERR', e.message); pass.push(false); }
chrome.kill();
console.log(pass.every(Boolean) ? `\n全部通過 (${pass.length})` : `\n有失敗 (${pass.filter(x => !x).length}/${pass.length})`);
process.exit(pass.every(Boolean) ? 0 : 1);
