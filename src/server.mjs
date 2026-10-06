// API 伺服器：零依賴（node:http + node:sqlite）。
// POST /api/analyze 以 SSE 串流回傳，每分析完一句就推一句，不必等整段跑完。

import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { join, extname, normalize as pathNormalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { analyze, MODEL } from './analyzer.mjs';
import { splitSentences } from './segment.mjs';
import { openCache } from './cache.mjs';
import { autoSeed } from './cache-cli.mjs';

const ROOT = join(fileURLToPath(new URL('.', import.meta.url)), '..');
const WEB = join(ROOT, 'prototype');
const PORT = Number(process.env.PORT || 8787);
const MAX_CHARS = Number(process.env.MAX_CHARS || 4000);
const MAX_SENTENCES = Number(process.env.MAX_SENTENCES || 25);
const CONCURRENCY = Number(process.env.CONCURRENCY || 6);

const cache = openCache(join(ROOT, 'data', 'cache.db'));
const seeded = autoSeed(cache);   // 新機器首次啟動：把版控裡的種子快取載進來

const MIME = { '.html':'text/html', '.js':'text/javascript', '.css':'text/css',
  '.json':'application/json', '.svg':'image/svg+xml', '.ico':'image/x-icon' };

const readBody = (req, limit = 1e6) => new Promise((resolve, reject) => {
  let n = 0; const chunks = [];
  req.on('data', c => { n += c.length; if (n > limit) { reject(new Error('payload too large')); req.destroy(); } else chunks.push(c); });
  req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
  req.on('error', reject);
});

/** 併發池：固定 n 個 worker 取任務，先完成先回報 */
async function pool(items, n, fn){
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => {
    while (true){
      const i = next++;
      if (i >= items.length) return;
      await fn(items[i], i);
    }
  }));
}

async function handleAnalyze(req, res){
  let text = '';
  try { text = String(JSON.parse(await readBody(req))?.text ?? ''); }
  catch { res.writeHead(400, { 'content-type':'application/json' }); return res.end('{"error":"bad json"}'); }

  text = text.trim();
  if (!text){ res.writeHead(400, { 'content-type':'application/json' }); return res.end('{"error":"empty"}'); }
  if (text.length > MAX_CHARS){
    res.writeHead(413, { 'content-type':'application/json' });
    return res.end(JSON.stringify({ error: `too long`, maxChars: MAX_CHARS, got: text.length }));
  }

  let segs = splitSentences(text);
  const truncated = segs.length > MAX_SENTENCES;
  if (truncated) segs = segs.slice(0, MAX_SENTENCES);

  res.writeHead(200, {
    'content-type':'text/event-stream; charset=utf-8',
    'cache-control':'no-cache, no-transform',
    'connection':'keep-alive',
    'x-accel-buffering':'no',
  });
  const send = (event, data) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);

  const t0 = Date.now();
  let cached = 0, analyzed = 0, failed = 0;
  let closed = false;
  req.on('close', () => { closed = true; });

  send('meta', { total: segs.length, truncated, maxSentences: MAX_SENTENCES, model: MODEL });

  // 先把快取命中的推出去（幾乎瞬間），剩下的才去呼叫模型
  const misses = [];
  segs.forEach((seg, i) => {
    const hit = cache.get(seg.text);
    if (hit){ cached++; send('sentence', { index: i, cached: true, sentence: { ...hit, index: i } }); }
    else misses.push({ seg, i });
  });
  send('progress', { done: cached, total: segs.length });

  await pool(misses, CONCURRENCY, async ({ seg, i }) => {
    if (closed) return;
    try {
      const { data } = await analyze(seg.text);
      const sentence = data?.sentences?.[0];
      if (!sentence) throw new Error('模型沒有回傳句子');
      sentence.index = i;
      cache.put(seg.text, sentence, MODEL);
      analyzed++;
      if (!closed) send('sentence', { index: i, cached: false, sentence });
    } catch (e){
      failed++;
      if (!closed) send('failed', { index: i, original: seg.text, message: String(e.message).slice(0, 300) });
    }
    if (!closed) send('progress', { done: cached + analyzed + failed, total: segs.length });
  });

  const ms = Date.now() - t0;
  cache.log({ chars: text.length, sentences: segs.length, cached, analyzed, ms });
  if (!closed){ send('done', { ms, total: segs.length, cached, analyzed, failed }); res.end(); }
}

async function serveStatic(req, res, url){
  let rel = url.pathname === '/' ? 'index.html' : url.pathname.slice(1);
  rel = pathNormalize(rel).replace(/^(\.\.[/\\])+/, '');
  const file = join(WEB, rel);
  if (!file.startsWith(WEB)){ res.writeHead(403); return res.end('forbidden'); }
  try {
    const buf = await readFile(file);
    res.writeHead(200, { 'content-type': (MIME[extname(file)] || 'application/octet-stream') + '; charset=utf-8' });
    res.end(buf);
  } catch { res.writeHead(404, { 'content-type':'text/plain; charset=utf-8' }); res.end('not found'); }
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  try {
    if (req.method === 'POST' && url.pathname === '/api/analyze') return await handleAnalyze(req, res);
    if (url.pathname === '/api/health'){
      res.writeHead(200, { 'content-type':'application/json' });
      return res.end(JSON.stringify({ ok: true, model: MODEL, maxChars: MAX_CHARS, maxSentences: MAX_SENTENCES }));
    }
    if (url.pathname === '/api/stats'){
      res.writeHead(200, { 'content-type':'application/json; charset=utf-8' });
      return res.end(JSON.stringify(cache.stats(), null, 2));
    }
    if (req.method === 'GET') return await serveStatic(req, res, url);
    res.writeHead(405); res.end('method not allowed');
  } catch (e){
    if (!res.headersSent) res.writeHead(500, { 'content-type':'application/json' });
    res.end(JSON.stringify({ error: String(e.message).slice(0, 300) }));
  }
});

server.listen(PORT, () => {
  console.log(`英文句型解剖 → http://127.0.0.1:${PORT}`);
  console.log(`模型 ${MODEL}｜上限 ${MAX_CHARS} 字 / ${MAX_SENTENCES} 句｜併發 ${CONCURRENCY}`);
  if (seeded) console.log(`已從 fixtures/seed-cache.jsonl 載入 ${seeded.added} 句種子快取`);
  else console.log(`快取 ${cache.count()} 句`);
});
process.on('SIGINT', () => { cache.checkpoint(); cache.close(); server.close(() => process.exit(0)); });
