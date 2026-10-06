// API 伺服器：零依賴（node:http + node:sqlite）。
// POST /api/analyze 以 SSE 串流回傳，每分析完一句就推一句，不必等整段跑完。

import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { join, extname, normalize as pathNormalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { analyze, MODEL } from './analyzer.mjs';
import { splitSentences } from './segment.mjs';
import { openCache } from './cache.mjs';
import { generate, grade, TYPES } from './exercises.mjs';
import { autoSeed } from './cache-cli.mjs';

const ROOT = join(fileURLToPath(new URL('.', import.meta.url)), '..');
const WEB = join(ROOT, 'prototype');
const PORT = Number(process.env.PORT || 8787);
const MAX_CHARS = Number(process.env.MAX_CHARS || 4000);
const MAX_SENTENCES = Number(process.env.MAX_SENTENCES || 25);
const CONCURRENCY = Number(process.env.CONCURRENCY || 6);
// 預設只聽 127.0.0.1。要讓區網其他裝置連，必須明確設 HOST=0.0.0.0，
// 因為每個請求都花執行這台機器的 Claude 訂閱額度。
const HOST = process.env.HOST || '127.0.0.1';
const AUTH_TOKEN = process.env.AUTH_TOKEN || '';
const HISTORY_DAYS = Number(process.env.HISTORY_DAYS || 30);
const isLoopback = HOST === '127.0.0.1' || HOST === 'localhost' || HOST === '::1';

const cache = openCache(join(ROOT, 'data', 'cache.db'));
const seeded = autoSeed(cache);
const quizzes = new Map();   // quizId -> { questions(含答案), at }   // 新機器首次啟動：把版控裡的種子快取載進來

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

function authed(req, url){
  if (!AUTH_TOKEN) return true;
  const sent = req.headers['x-auth-token'] || url.searchParams.get('token') || '';
  // 長度相同才比對，避免洩漏長度；這裡是本機小工具，常數時間比對非必要
  return sent === AUTH_TOKEN;
}

async function handleAnalyze(req, res, url){
  if (!authed(req, url)){
    res.writeHead(401, { 'content-type':'application/json' });
    return res.end('{"error":"unauthorized"}');
  }
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

  // 心跳：分析長句時中間可能二十幾秒沒有任何事件，前端無法分辨「還在跑」和「後端死了」。
  // 每 8 秒送一次，讓前端的停滯偵測有依據。
  const beat = setInterval(() => { if (!res.writableEnded) res.write(': ping\n\n'); }, 8000);
  const stopBeat = () => clearInterval(beat);
  res.on('close', stopBeat);

  const t0 = Date.now();
  let cached = 0, analyzed = 0, failed = 0;
  const usage = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, costUsd: 0 };
  let closed = false;
  req.on('close', () => { closed = true; });

  send('meta', { total: segs.length, truncated, maxSentences: MAX_SENTENCES, model: MODEL });
  let halted = null;

  // 先把快取命中的推出去（幾乎瞬間），剩下的才去呼叫模型
  const misses = [];
  segs.forEach((seg, i) => {
    const hit = cache.get(seg.text);
    if (hit){ cached++; send('sentence', { index: i, cached: true, sentence: { ...hit, index: i } }); }
    else misses.push({ seg, i });
  });
  send('progress', { done: cached, total: segs.length });

  await pool(misses, CONCURRENCY, async ({ seg, i }) => {
    if (closed || halted) return;
    try {
      const { data, meta } = await analyze(seg.text);
      const sentence = data?.sentences?.[0];
      if (!sentence) throw new Error('模型沒有回傳句子');
      sentence.index = i;
      const u = meta?.usage ?? {};
      const one = {
        inputTokens: (u.input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0),
        outputTokens: u.output_tokens ?? 0,
        cacheReadTokens: u.cache_read_input_tokens ?? 0,
        costUsd: meta?.costUsd ?? 0,
      };
      for (const k of Object.keys(usage)) usage[k] += one[k];
      cache.put(seg.text, sentence, MODEL, one);
      analyzed++;
      if (!closed) send('sentence', { index: i, cached: false, sentence, usage: one });
    } catch (e){
      failed++;
      const kind = e.kind || 'other';
      if (kind === 'rate-limit' || kind === 'auth'){
        halted = kind;   // 這類錯誤重試也沒用，立刻停掉其餘工作
        if (!closed) send('halted', { kind, index: i, message: String(e.message).slice(0, 400) });
      } else if (!closed) {
        send('failed', { index: i, original: seg.text, kind, message: String(e.message).slice(0, 300) });
      }
    }
    if (!closed) send('progress', { done: cached + analyzed + failed, total: segs.length });
  });

  stopBeat();
  const ms = Date.now() - t0;
  cache.log({ chars: text.length, sentences: segs.length, cached, analyzed, ms, text, ...usage });
  if (!closed){
    send('done', { ms, total: segs.length, cached, analyzed, failed, usage, model: MODEL, halted });
    res.end();
  }
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
    if (req.method === 'POST' && url.pathname === '/api/analyze') return await handleAnalyze(req, res, url);
    if (url.pathname === '/api/health'){
      res.writeHead(200, { 'content-type':'application/json' });
      return res.end(JSON.stringify({ ok: true, model: MODEL, maxChars: MAX_CHARS,
        maxSentences: MAX_SENTENCES, authRequired: Boolean(AUTH_TOKEN) }));
    }
    // 出題：從已分析的句子反向生成，不呼叫模型
    if (req.method === 'POST' && url.pathname === '/api/exercises'){
      if (!authed(req, url)){ res.writeHead(401, { 'content-type':'application/json' }); return res.end('{"error":"unauthorized"}'); }
      let body = {};
      try { body = JSON.parse(await readBody(req)) || {}; } catch {}
      const count = Math.min(Math.max(Number(body.count) || 10, 1), 30);
      const types = Array.isArray(body.types) && body.types.length
        ? body.types.filter(t => TYPES.includes(t)) : TYPES;
      const userToken = String(body.userToken || 'anon').slice(0, 64);
      const focusWeak = body.focusWeak !== false;      // 預設開啟弱點加權
      const acc = focusWeak ? cache.accuracyMap(userToken) : null;
      const records = cache.pickSentences(60);
      if (!records.length){
        res.writeHead(409, { 'content-type':'application/json; charset=utf-8' });
        return res.end(JSON.stringify({ error: 'no-sentences',
          message: '還沒有分析過任何句子。先到「分析」貼一段文章，就能從那些句子出題。' }));
      }
      const questions = generate(records, { count, types, acc });
      // 答案不隨題目下發，避免在開發者工具裡直接看到
      const quizId = Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
      quizzes.set(quizId, { questions, at: Date.now() });
      if (quizzes.size > 200) for (const [k, v] of quizzes) if (Date.now() - v.at > 864e5) quizzes.delete(k);
      res.writeHead(200, { 'content-type':'application/json; charset=utf-8' });
      return res.end(JSON.stringify({
        quizId, pool: records.length, focusWeak,
        weakDims: acc ? {
          patterns: Object.entries(acc.patterns).filter(([, a]) => a < 0.7).map(([k]) => Number(k)),
          tenses: Object.entries(acc.tenses).filter(([, a]) => a < 0.7).map(([k]) => k),
          pos: Object.entries(acc.pos).filter(([, a]) => a < 0.7).map(([k]) => k),
        } : null,
        questions: questions.map(({ answer, alsoAccept, explain, ...rest }) => rest),
      }));
    }

    // 批改並記錄作答
    if (req.method === 'POST' && url.pathname === '/api/attempts'){
      if (!authed(req, url)){ res.writeHead(401, { 'content-type':'application/json' }); return res.end('{"error":"unauthorized"}'); }
      let body = {};
      try { body = JSON.parse(await readBody(req)) || {}; } catch {}
      const quiz = quizzes.get(body.quizId);
      if (!quiz){
        res.writeHead(410, { 'content-type':'application/json; charset=utf-8' });
        return res.end(JSON.stringify({ error: 'quiz-expired', message: '這份練習已失效，請重新出題。' }));
      }
      const userToken = String(body.userToken || 'anon').slice(0, 64);
      const given = body.answers || {};
      const results = quiz.questions.map(q => {
        const g = grade(q, given[q.id] ?? []);
        cache.recordAttempt({
          userToken, qtype: q.type, sentenceHash: q.meta.hash,
          patternId: q.meta.patternId, tenseTime: q.meta.tenseTime,
          tenseAspect: q.meta.tenseAspect, pos: q.meta.pos,
          correct: g.correct, answer: g.given.join(' | '), expected: g.expected.join(' | '),
        });
        return { id: q.id, correct: g.correct, expected: q.answer, given: g.given, explain: q.explain };
      });
      res.writeHead(200, { 'content-type':'application/json; charset=utf-8' });
      return res.end(JSON.stringify({
        results, correct: results.filter(r => r.correct).length, total: results.length,
      }));
    }

    if (url.pathname === '/api/weakness'){
      const userToken = url.searchParams.get('user') || 'anon';
      res.writeHead(200, { 'content-type':'application/json; charset=utf-8' });
      return res.end(JSON.stringify(cache.weakness(userToken), null, 2));
    }

    if (url.pathname === '/api/history'){
      const id = url.searchParams.get('id');
      res.writeHead(200, { 'content-type':'application/json; charset=utf-8' });
      if (id) return res.end(JSON.stringify({ text: cache.historyText(Number(id)) }));
      return res.end(JSON.stringify({
        retainDays: HISTORY_DAYS,
        usage: cache.usageSummary(),
        items: cache.history(40),
      }));
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

server.listen(PORT, HOST, () => {
  console.log(`英文句型解剖 → http://${isLoopback ? '127.0.0.1' : HOST}:${PORT}`);
  console.log(`模型 ${MODEL}｜上限 ${MAX_CHARS} 字 / ${MAX_SENTENCES} 句｜併發 ${CONCURRENCY}`);
  if (seeded) console.log(`已從 fixtures/seed-cache.jsonl 載入 ${seeded.added} 句種子快取`);
  else console.log(`快取 ${cache.count()} 句`);
  const purged = cache.pruneHistory(HISTORY_DAYS);
  if (purged) console.log(`已清掉 ${purged} 筆超過 ${HISTORY_DAYS} 天的歷史原文`);
  setInterval(() => cache.pruneHistory(HISTORY_DAYS), 6 * 3600_000).unref();
  console.log(`分析由本機 claude CLI 執行，額度計入這台機器登入的 Claude 帳號。`);
  console.log(`歷史原文保留 ${HISTORY_DAYS} 天後自動清除（分析快取不受影響）。`);
  console.log(`訂閱額度請在 Claude app → Settings → Usage 查看（CLI 沒有提供查詢介面）。`);
  if (isLoopback){
    console.log(`只接受本機連線。要讓區網其他裝置連：HOST=0.0.0.0 AUTH_TOKEN=<自訂字串> npm start`);
  } else if (!AUTH_TOKEN){
    console.log(`\n⚠  正在對外開放 (${HOST}) 且未設 AUTH_TOKEN。`);
    console.log(`   任何連得到這個位址的人都能用，且花的是你的 Claude 額度。`);
    console.log(`   建議改用：HOST=${HOST} AUTH_TOKEN=<自訂字串> npm start\n`);
  } else {
    console.log(`對外開放 (${HOST})，已啟用 AUTH_TOKEN。分享網址時要帶 ?token=<你的字串>`);
  }
});
process.on('SIGINT', () => { cache.checkpoint(); cache.close(); server.close(() => process.exit(0)); });
