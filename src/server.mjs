// API 伺服器：零依賴（node:http + node:sqlite）。
// POST /api/analyze 以 SSE 串流回傳，每分析完一句就推一句，不必等整段跑完。

import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { join, extname, normalize as pathNormalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { analyze, analyzeMany, extractProse, fixPronounCase, MODEL } from './analyzer.mjs';
import { splitSentences, splitDialogue } from './segment.mjs';
import { openCache } from './cache.mjs';
import { generate, grade, TYPES, hasBlank } from './exercises.mjs';
import { parseWordList, enrich, generateWordQuiz, gradeWord, WORD_MODES,
         extractFromImage, wordsToText } from './wordset.mjs';
import { writeFile, unlink, mkdir } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
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
// 題目（含答案）存進 SQLite，不放記憶體 —— 伺服器重啟時，
// 作答到一半的人才不會按交卷就看到「這份測驗已失效」。

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

/** 解析前端送來的 data URL：驗 MIME、大小與檔頭。
 *  只信前端說的格式不夠 —— 檔頭才是真的。 */
function decodeImage(dataUrl){
  const m = /^data:image\/(jpeg|jpg|png|webp|heic|heif);base64,(.+)$/i.exec(String(dataUrl || ''));
  if (!m) return { error:'bad-image', code:400, message:'看不出這是圖片，請選 JPG 或 PNG。' };
  const buf = Buffer.from(m[2], 'base64');
  if (buf.length > 10e6) return { error:'too-large', code:413, message:'圖片超過 10MB。' };
  const sig = buf.subarray(0, 12);
  const isJpeg = sig[0] === 0xFF && sig[1] === 0xD8 && sig[2] === 0xFF;
  const isPng  = sig.subarray(0, 8).equals(Buffer.from([0x89,0x50,0x4E,0x47,0x0D,0x0A,0x1A,0x0A]));
  const isWebp = sig.subarray(0,4).toString() === 'RIFF' && sig.subarray(8,12).toString() === 'WEBP';
  const isHeic = sig.subarray(4,8).toString() === 'ftyp';
  if (!isJpeg && !isPng && !isWebp && !isHeic)
    return { error:'bad-image', code:400, message:'檔案內容不是圖片。' };
  return { buf, ext: isPng ? 'png' : isWebp ? 'webp' : isHeic ? 'heic' : 'jpg' };
}

/** 從查詢字串或 body 解析出字表 id 陣列（相容舊的單一 id） */
function setIdList(v, fallback){
  const raw = Array.isArray(v) ? v : String(v ?? fallback ?? '').split(',');
  return [...new Set(raw.map(Number).filter(n => Number.isFinite(n) && n > 0))].slice(0, 20);
}

/** 訂正：把答錯的原題重出一次。
 *  訂正就是把原本那題做對 —— 拼錯 interesting 的人要再拼一次 interesting，
 *  換成聽考或選擇題測的是別的東西。題型、單字、例句一律不換，
 *  只把選項順序打散，避免靠記得剛才的位置作答。 */
function redoQuestions(quizId, ids){
  const q = cache.getQuiz(quizId);
  if (!q) return null;
  const want = new Set(ids);
  const picked = q.questions.filter(x => want.has(x.id));
  return picked.map((q, i) => {
    const copy = { ...q, id: `${q.id.startsWith('w') ? 'w' : 'q'}f${i}${Date.now().toString(36).slice(-3)}` };
    if (Array.isArray(copy.choices)){
      const c = [...copy.choices];
      for (let j = c.length - 1; j > 0; j--){
        const k = Math.floor(Math.random() * (j + 1));
        [c[j], c[k]] = [c[k], c[j]];
      }
      copy.choices = c;
    }
    return copy;
  });
}

/** 把字表裡所有例句抓出來去重 */
function exampleSentences(words){
  const seen = new Set();
  for (const w of words)
    for (const sn of w.senses ?? [])
      if (sn.example) seen.add(String(sn.example).trim());
  return [...seen];
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

  // 對話題（A: … / B: …）：拆掉說話者標記再分析，但記下誰說的、對方說了什麼。
  // 不這樣做的話「A: What did you make for…」會把標記當成句子的一部分。
  const turns = splitDialogue(text);
  let segs, dlg = null;
  if (turns){
    dlg = turns;
    segs = turns.map(t => ({ text: t.text }));
  } else {
    segs = splitSentences(text);
  }
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
    if (hit){
      // 規則更新後，快取裡的舊結果也要補上代名詞格位（校正是冪等的，不必重新分析）
      if (hit.words) fixPronounCase(hit.words);
      cached++;
      send('sentence', { index: i, cached: true, sentence: { ...hit, index: i } });
    }
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
      // 對話的話，把對方說的話一起存起來（meta 這個名字上面已經用掉了）
      const dlgMeta = dlg ? {
        speaker: dlg[i]?.speaker ?? null,
        context: dlg.filter((_, k) => k !== i).map(t => `${t.speaker}: ${t.text}`).join('\n') || null,
      } : {};
      // 模型回傳的原句必須和我們送出去的一致，否則快取的鍵會對不上內容，
      // 之後查這一句永遠查不到，還會污染範例與題庫。
      if (sentence.original && sentence.original.trim() !== seg.text.trim()){
        console.error('[analyze] 模型回傳的原句與輸入不符，不寫入快取：',
          JSON.stringify(seg.text.slice(0, 60)), '→', JSON.stringify(String(sentence.original).slice(0, 60)));
      } else if (hasBlank(seg.text)){
        // 考卷的空格沒被還原成答案。這種句子拿來分析沒有意義，
        // 出題時也只會變成「兩個空格一個格子」那種看不懂的題目，所以不入庫。
        console.error('[analyze] 句子仍有未還原的空格，不寫入快取：', JSON.stringify(seg.text.slice(0, 60)));
      } else {
        cache.put(seg.text, sentence, MODEL, one, dlgMeta);
      }
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

// index.html 是給 Artifact 用的格式 —— 發布時平台會自動包上
// doctype、charset 與 viewport。我們自己送就得補，否則手機上會是
// quirks 模式加 980px 的版面寬度，整頁縮小到看不清楚。
// 骨架放這裡而不是寫進檔案，是為了不破壞 Artifact 的發布規則。
const HEAD = `<!doctype html>
<html lang="zh-Hant">
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="color-scheme" content="light">
`;

async function serveStatic(req, res, url){
  let rel = url.pathname === '/' ? 'index.html' : url.pathname.slice(1);
  rel = pathNormalize(rel).replace(/^(\.\.[/\\])+/, '');
  const file = join(WEB, rel);
  if (!file.startsWith(WEB)){ res.writeHead(403); return res.end('forbidden'); }
  try {
    const buf = await readFile(file);
    const isPage = extname(file) === '.html' && !buf.subarray(0, 200).toString().toLowerCase().includes('<!doctype');
    res.writeHead(200, { 'content-type': (MIME[extname(file)] || 'application/octet-stream') + '; charset=utf-8' });
    res.end(isPage ? Buffer.concat([Buffer.from(HEAD), buf]) : buf);
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
      // 訂正：把答錯的原題重出，題型不換
      if (body.redoFrom && Array.isArray(body.redoIds) && body.redoIds.length){
        const questions = redoQuestions(body.redoFrom, body.redoIds);
        if (!questions?.length){
          res.writeHead(410, { 'content-type':'application/json; charset=utf-8' });
          return res.end(JSON.stringify({ error:'quiz-expired', message:'原本那份練習已失效，請重新出題。' }));
        }
        const quizId = Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
        cache.putQuiz(quizId, 'sentence-fix', questions);
        res.writeHead(200, { 'content-type':'application/json; charset=utf-8' });
        return res.end(JSON.stringify({ quizId, pool: questions.length, focusWeak: false, weakDims: null,
          redo: true, questions: questions.map(({ answer, alsoAccept, accept, explain, ...rest }) => rest) }));
      }
      const records = cache.pickSentences(60);
      if (!records.length){
        res.writeHead(409, { 'content-type':'application/json; charset=utf-8' });
        return res.end(JSON.stringify({ error: 'no-sentences',
          message: '還沒有分析過任何句子。先到「分析」貼一段文章，就能從那些句子出題。' }));
      }
      const questions = generate(records, { count, types, acc });
      // 答案不隨題目下發，避免在開發者工具裡直接看到
      const quizId = Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
      cache.putQuiz(quizId, 'sentence', questions);
      res.writeHead(200, { 'content-type':'application/json; charset=utf-8' });
      return res.end(JSON.stringify({
        quizId, pool: records.length, focusWeak,
        weakDims: acc ? {
          patterns: Object.entries(acc.patterns).filter(([, a]) => a < 0.7).map(([k]) => Number(k)),
          tenses: Object.entries(acc.tenses).filter(([, a]) => a < 0.7).map(([k]) => k),
          pos: Object.entries(acc.pos).filter(([, a]) => a < 0.7).map(([k]) => k),
        } : null,
        questions: questions.map(({ answer, alsoAccept, accept, explain, ...rest }) => rest),
      }));
    }

    // 批改並記錄作答
    if (req.method === 'POST' && url.pathname === '/api/attempts'){
      if (!authed(req, url)){ res.writeHead(401, { 'content-type':'application/json' }); return res.end('{"error":"unauthorized"}'); }
      let body = {};
      try { body = JSON.parse(await readBody(req)) || {}; } catch {}
      const quiz = cache.getQuiz(body.quizId);
      if (!quiz){
        res.writeHead(410, { 'content-type':'application/json; charset=utf-8' });
        return res.end(JSON.stringify({ error: 'quiz-expired', message: '這份練習已失效，請重新出題。' }));
      }
      const userToken = String(body.userToken || 'anon').slice(0, 64);
      const given = body.answers || {};
      const isFix = quiz.kind.endsWith('-fix');     // 訂正不計入統計
      const results = quiz.questions.map(q => {
        const g = grade(q, given[q.id] ?? []);
        cache.recordAttempt({
          userToken, qtype: q.type, sentenceHash: q.meta.hash,
          patternId: q.meta.patternId, tenseTime: q.meta.tenseTime,
          tenseAspect: q.meta.tenseAspect, pos: q.meta.pos, pronCase: q.meta.case,
          correct: g.correct, isFix, answer: g.given.join(' | '), expected: g.expected.join(' | '),
        });
        return { id: q.id, hash: q.meta.hash, correct: g.correct, expected: q.answer, given: g.given, explain: q.explain };
      });
      res.writeHead(200, { 'content-type':'application/json; charset=utf-8' });
      return res.end(JSON.stringify({
        results, isFix, correct: results.filter(r => r.correct).length, total: results.length,
      }));
    }

    if (url.pathname === '/api/weakness'){
      const userToken = url.searchParams.get('user') || 'anon';
      res.writeHead(200, { 'content-type':'application/json; charset=utf-8' });
      return res.end(JSON.stringify(cache.weakness(userToken), null, 2));
    }

    // ---------- 單字表 ----------
    if (url.pathname === '/api/wordsets'){
      const userToken = String(url.searchParams.get('user') || 'anon').slice(0, 64);
      if (req.method === 'GET'){
        res.writeHead(200, { 'content-type':'application/json; charset=utf-8' });
        return res.end(JSON.stringify({ sets: cache.wordsets(userToken) }));
      }
      if (req.method === 'POST'){
        if (!authed(req, url)){ res.writeHead(401, { 'content-type':'application/json' }); return res.end('{"error":"unauthorized"}'); }
        let b = {};
        try { b = JSON.parse(await readBody(req)) || {}; } catch {}
        const items = parseWordList(b.text || '');
        if (!items.length){
          res.writeHead(400, { 'content-type':'application/json; charset=utf-8' });
          return res.end(JSON.stringify({ error:'empty', message:'看不到任何單字。一行一個，可以用逗號接中文。' }));
        }
        if (items.length > 60){
          res.writeHead(413, { 'content-type':'application/json; charset=utf-8' });
          return res.end(JSON.stringify({ error:'too-many', message:`一次最多 60 個字，這次有 ${items.length} 個。` }));
        }
        // 加進既有字表：先濾掉那份已經有的字，不用重複花額度充實
        const appendTo = Number(b.appendTo) || 0;
        let skippedExisting = 0;
        let todo = items;
        if (appendTo){
          const have = cache.termsOf(appendTo);
          todo = items.filter(w => !have.has(String(w.term).toLowerCase()));
          skippedExisting = items.length - todo.length;
          if (!todo.length){
            res.writeHead(200, { 'content-type':'application/json; charset=utf-8' });
            return res.end(JSON.stringify({ id: appendTo, count: 0, appended: true,
              skipped: skippedExisting, usage: { costUsd: 0, outputTokens: 0 },
              message: '這些字那份字表裡都已經有了，沒有新增。' }));
          }
        }
        const t0 = Date.now();
        try {
          const { words, usage } = await enrich(todo);
          let id, name, added;
          if (appendTo){
            const r = cache.appendWords(appendTo, words);
            id = appendTo; added = r.added;
            name = cache.wordsets('anon').find(x => x.id === appendTo)?.name ?? '字表';
          } else {
            name = b.name || '單字';            // 前端沒填時的後備（日期另外顯示）
            id = cache.createWordset(name, words, b.note || null);
            added = words.length;
          }
          // 建字表有呼叫模型，和分析一樣要進歷史紀錄
          cache.log({ kind:'wordset', refId:id, chars:(b.text||'').length, sentences:todo.length,
            cached:skippedExisting, analyzed:todo.length, ms: Date.now() - t0,
            text: `${name}\n${items.map(w => w.zh ? `${w.term}, ${w.zh}` : w.term).join('\n')}`,
            ...usage });
          res.writeHead(200, { 'content-type':'application/json; charset=utf-8' });
          return res.end(JSON.stringify({ id, name, count: added, appended: Boolean(appendTo),
            skipped: skippedExisting, usage }));
        } catch (e){
          const kind = e.kind || 'other';
          res.writeHead(kind === 'rate-limit' ? 429 : 500, { 'content-type':'application/json; charset=utf-8' });
          return res.end(JSON.stringify({ error: kind, message:
            kind === 'rate-limit' ? 'Claude 訂閱額度似乎已用盡，等額度重置後再建立字表。'
          : kind === 'auth' ? 'Claude 認證失效，請在終端機執行 claude 重新登入。'
          : '建立字表失敗：' + String(e.message).slice(0, 200) }));
        }
      }
      if (req.method === 'DELETE'){
        if (!authed(req, url)){ res.writeHead(401, { 'content-type':'application/json' }); return res.end('{"error":"unauthorized"}'); }
        const ids = setIdList(url.searchParams.get('ids'), url.searchParams.get('id'));
        const n = ids.length ? cache.deleteWordset(ids) : 0;
        res.writeHead(200, { 'content-type':'application/json' });
        return res.end(JSON.stringify({ ok: true, deleted: n }));
      }
    }

    // 拍照辨識：課本上的英文句子 → 文字，填進分析的輸入框
    // 之後完全走原本的流程（斷句 → 逐句分析 → 快取），和自己貼上一段沒有差別。
    if (req.method === 'POST' && url.pathname === '/api/analyze-ocr'){
      if (!authed(req, url)){ res.writeHead(401, { 'content-type':'application/json' }); return res.end('{"error":"unauthorized"}'); }
      let b = {};
      try { b = JSON.parse(await readBody(req, 14e6)) || {}; } catch {
        res.writeHead(413, { 'content-type':'application/json; charset=utf-8' });
        return res.end(JSON.stringify({ error:'too-large', message:'圖片太大，請用手機相簿壓縮後再試。' }));
      }
      const img = decodeImage(b.image);
      if (img.error){
        res.writeHead(img.code, { 'content-type':'application/json; charset=utf-8' });
        return res.end(JSON.stringify({ error: img.error, message: img.message }));
      }
      const dir = join(ROOT, 'data', 'tmp');
      const file = join(dir, `ocr-${randomBytes(8).toString('hex')}.${img.ext}`);
      const t0 = Date.now();
      try {
        await mkdir(dir, { recursive: true });
        await writeFile(file, img.buf);
        const { text, filled, usage } = await extractProse(file);
        // 和單字表辨識分開記 —— 兩者抄的東西不一樣，歷史上要看得出來
        cache.log({ kind:'ocr-text', chars: img.buf.length,
          sentences: text ? splitSentences(text).length : 0,
          cached:0, analyzed:0, ms: Date.now() - t0,
          text: text || '（照片裡沒有抄到英文句子）', ...usage });
        res.writeHead(200, { 'content-type':'application/json; charset=utf-8' });
        return res.end(JSON.stringify({ text, filled, usage }));
      } catch (e){
        const kind = e.kind || 'other';
        res.writeHead(kind === 'rate-limit' ? 429 : 500, { 'content-type':'application/json; charset=utf-8' });
        return res.end(JSON.stringify({ error: kind, message:
          kind === 'rate-limit' ? 'Claude 訂閱額度似乎已用盡，等額度重置後再試。'
        : kind === 'auth' ? 'Claude 認證失效，請在終端機執行 claude 重新登入。'
        : '辨識失敗：' + String(e.message).slice(0, 200) }));
      } finally {
        await unlink(file).catch(() => {});
      }
    }

    // 拍照辨識：讀課本單字表的照片，抄成可編輯的文字給使用者核對
    if (req.method === 'POST' && url.pathname === '/api/wordset-ocr'){
      if (!authed(req, url)){ res.writeHead(401, { 'content-type':'application/json' }); return res.end('{"error":"unauthorized"}'); }
      let b = {};
      try { b = JSON.parse(await readBody(req, 14e6)) || {}; } catch {
        res.writeHead(413, { 'content-type':'application/json; charset=utf-8' });
        return res.end(JSON.stringify({ error:'too-large', message:'圖片太大，請用手機相簿壓縮後再試。' }));
      }
      const img = decodeImage(b.image);
      if (img.error){
        res.writeHead(img.code, { 'content-type':'application/json; charset=utf-8' });
        return res.end(JSON.stringify({ error: img.error, message: img.message }));
      }
      const { buf, ext } = img;
      const dir = join(ROOT, 'data', 'tmp');
      const file = join(dir, `ocr-${randomBytes(8).toString('hex')}.${ext}`);
      const t0 = Date.now();
      try {
        await mkdir(dir, { recursive: true });
        await writeFile(file, buf);
        const { words, usage } = await extractFromImage(file);
        const text = wordsToText(words);
        cache.log({ kind:'ocr', chars: buf.length, sentences: words.length,
          cached:0, analyzed: words.length, ms: Date.now() - t0,
          text: text || '（照片裡沒有抄到單字）', ...usage });
        res.writeHead(200, { 'content-type':'application/json; charset=utf-8' });
        return res.end(JSON.stringify({ words, text, usage }));
      } catch (e){
        const kind = e.kind || 'other';
        res.writeHead(kind === 'rate-limit' ? 429 : 500, { 'content-type':'application/json; charset=utf-8' });
        return res.end(JSON.stringify({ error: kind, message:
          kind === 'rate-limit' ? 'Claude 訂閱額度似乎已用盡，等額度重置後再試。'
        : kind === 'auth' ? 'Claude 認證失效，請在終端機執行 claude 重新登入。'
        : '辨識失敗：' + String(e.message).slice(0, 200) }));
      } finally {
        await unlink(file).catch(() => {});      // 照片不留在硬碟上
      }
    }

    if (url.pathname === '/api/wordset'){
      const userToken = String(url.searchParams.get('user') || 'anon').slice(0, 64);
      const ids = setIdList(url.searchParams.get('ids'), url.searchParams.get('id'));
      res.writeHead(200, { 'content-type':'application/json; charset=utf-8' });
      const words = cache.wordsOf(ids, userToken);
      // 逐句標出例句分析過沒有，清單上的「分析」鍵才知道要顯示成哪一種
      for (const w of words)
        for (const sn of w.senses ?? [])
          if (sn.example) sn.analyzed = Boolean(cache.get(String(sn.example).trim()));
      const exs = exampleSentences(words);
      return res.end(JSON.stringify({
        words,
        stats: ids.length ? cache.wordStats(ids, userToken) : null,
        // 例句的句型分析狀態：已分析過的點了是瞬間，沒分析過的才要花額度
        examples: { total: exs.length, cached: exs.filter(t => cache.get(t)).length },
        merged: { sets: ids.length, words: words.length,
                  dup: words.filter(w => w.mergedFrom).length },
      }));
    }

    // 批次分析字表的例句：多句併成一次呼叫，比逐句省四成
    if (req.method === 'POST' && url.pathname === '/api/wordset-analyze'){
      if (!authed(req, url)){ res.writeHead(401, { 'content-type':'application/json' }); return res.end('{"error":"unauthorized"}'); }
      let b = {};
      try { b = JSON.parse(await readBody(req)) || {}; } catch {}
      const userToken = String(b.userToken || 'anon').slice(0, 64);
      const words = cache.wordsOf(setIdList(b.setIds, b.setId), userToken);
      const all = exampleSentences(words);
      const todo = all.filter(t => !cache.get(t));      // 已分析過的不重跑
      if (!todo.length){
        res.writeHead(200, { 'content-type':'application/json; charset=utf-8' });
        return res.end(JSON.stringify({ total: all.length, cached: all.length, analyzed: 0,
          usage: { costUsd: 0, outputTokens: 0 } }));
      }
      // 改用 SSE：一批（8 句）跑完就存檔並回報進度。
      // 幾十句塞在一個請求裡跑好幾分鐘，中途斷線會全部白做，畫面上也完全沒有動靜。
      res.writeHead(200, {
        'content-type':'text/event-stream; charset=utf-8',
        'cache-control':'no-cache, no-transform',
        'connection':'keep-alive',
        'x-accel-buffering':'no',
      });
      const send = (ev, d) => { if (!res.writableEnded) res.write(`event: ${ev}\ndata: ${JSON.stringify(d)}\n\n`); };
      const beat = setInterval(() => { if (!res.writableEnded) res.write(': ping\n\n'); }, 8000);
      send('meta', { total: all.length, cached: all.length - todo.length, todo: todo.length });
      const t0 = Date.now();
      const groupResults = [];
      let saved = 0, lastDone = 0;
      const total = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, costUsd: 0 };
      try {
        await analyzeMany(todo, {
          onGroup: ({ done, usage }) => {
            // 這一批剛完成的句子立刻寫進快取 —— 斷線最多只損失一批
            const n = Math.max(1, done - lastDone);
            const per = {
              inputTokens:  Math.round((usage.inputTokens  - total.inputTokens)  / n),
              outputTokens: Math.round((usage.outputTokens - total.outputTokens) / n),
              costUsd: (usage.costUsd - total.costUsd) / n,
            };
            for (let i = lastDone; i < done; i++){
              const r = groupResults[i];
              if (!r) continue;
              if (hasBlank(todo[i])) continue;    // 仍有未還原的空格就不入庫，理由同上
              try { fixPronounCase(r.words ?? []); cache.put(todo[i], r, MODEL, per); saved++; }
              catch (err){ console.error('存快取失敗：', todo[i].slice(0, 40), err.message); }
            }
            lastDone = done;
            Object.assign(total, usage);
            send('progress', { done: saved, total: todo.length, costUsd: usage.costUsd });
          },
          onDone: (i, s) => { groupResults[i] = s; },
        });
        clearInterval(beat);
        cache.log({ kind:'analyze', chars: todo.join(' ').length, sentences: todo.length,
          cached: all.length - todo.length, analyzed: saved, ms: Date.now() - t0,
          text: todo.join('\n'), ...total });
        send('done', { total: all.length, cached: all.length - todo.length,
          analyzed: saved, usage: total, ms: Date.now() - t0 });
        return res.end();
      } catch (e){
        clearInterval(beat);
        const kind = e.kind || 'other';
        // 已經存進去的不會白費，照樣記帳
        if (saved) cache.log({ kind:'analyze', chars: todo.join(' ').length, sentences: todo.length,
          cached: all.length - todo.length, analyzed: saved, ms: Date.now() - t0,
          text: todo.join('\n'), ...total });
        send('failed', { kind, analyzed: saved, message:
          kind === 'rate-limit' ? 'Claude 訂閱額度似乎已用盡，等額度重置後再試。'
        : '分析失敗：' + String(e.message).slice(0, 200) });
        return res.end();
      }
    }

    if (req.method === 'POST' && url.pathname === '/api/wordquiz'){
      let b = {};
      try { b = JSON.parse(await readBody(req)) || {}; } catch {}
      const userToken = String(b.userToken || 'anon').slice(0, 64);
      // 訂正：把答錯的原題重出，題型不換
      if (b.redoFrom && Array.isArray(b.redoIds) && b.redoIds.length){
        const questions = redoQuestions(b.redoFrom, b.redoIds);
        if (!questions?.length){
          res.writeHead(410, { 'content-type':'application/json; charset=utf-8' });
          return res.end(JSON.stringify({ error:'quiz-expired', message:'原本那份測驗已失效，請重新出題。' }));
        }
        const quizId = 'w' + Math.random().toString(36).slice(2,10) + Date.now().toString(36);
        cache.putQuiz(quizId, 'word-fix', questions);
        res.writeHead(200, { 'content-type':'application/json; charset=utf-8' });
        return res.end(JSON.stringify({ quizId, total: questions.length, redo: true,
          questions: questions.map(({ answer, alsoAccept, accept, explain, ...rest }) => rest) }));
      }
      const words = cache.wordsOf(setIdList(b.setIds, b.setId), userToken);
      if (!words.length){
        res.writeHead(409, { 'content-type':'application/json; charset=utf-8' });
        return res.end(JSON.stringify({ error:'empty-set', message:'這份字表沒有單字。' }));
      }
      const modes = Array.isArray(b.modes) && b.modes.length
        ? b.modes.filter(m => WORD_MODES.includes(m)) : WORD_MODES;
      // 三態直接取自分析過的句子，不用再問模型
      const questions = generateWordQuiz(words, {
        count: Math.min(Math.max(Number(b.count)||10,1),30), modes,
        verbForms: cache.verbForms(),
      });
      const quizId = 'w' + Math.random().toString(36).slice(2,10) + Date.now().toString(36);
      cache.putQuiz(quizId, 'word', questions);
      res.writeHead(200, { 'content-type':'application/json; charset=utf-8' });
      return res.end(JSON.stringify({ quizId, total: words.length,
        questions: questions.map(({ answer, alsoAccept, accept, explain, ...rest }) => rest) }));
    }

    if (req.method === 'POST' && url.pathname === '/api/wordattempts'){
      let b = {};
      try { b = JSON.parse(await readBody(req)) || {}; } catch {}
      const quiz = cache.getQuiz(b.quizId);
      if (!quiz){
        res.writeHead(410, { 'content-type':'application/json; charset=utf-8' });
        return res.end(JSON.stringify({ error:'quiz-expired', message:'這份測驗已失效，請重新出題。' }));
      }
      const userToken = String(b.userToken || 'anon').slice(0, 64);
      const given = b.answers || {};
      const isFix = quiz.kind.endsWith('-fix');     // 訂正不計入統計，也不推進 Leitner
      const results = quiz.questions.map(q => {
        const g = gradeWord(q, given[q.id] ?? []);
        cache.recordWordAttempt({ userToken, wordId: q.wordId, wordIds: q.wordIds, senseIdx: q.meta?.senseIdx,
          mode: q.mode, correct: g.correct, isFix,
          answer: g.given.join(' | '), expected: g.expected.join(' | ') });
        return { id:q.id, wordId:q.wordId, correct:g.correct, expected:q.answer, given:g.given, explain:q.explain, term:q.term };
      });
      res.writeHead(200, { 'content-type':'application/json; charset=utf-8' });
      return res.end(JSON.stringify({ results, isFix,
        correct: results.filter(r=>r.correct).length, total: results.length }));
    }

    // 範例句：讓標籤能改抓分析過的真實句子
    if (url.pathname === '/api/samples'){
      const kind = url.searchParams.get('kind');
      res.writeHead(200, { 'content-type':'application/json; charset=utf-8' });
      if (!kind) return res.end(JSON.stringify({ counts: cache.sampleCounts() }));
      const n = Number(url.searchParams.get('n')) || 0;
      return res.end(JSON.stringify(cache.sampleOf(kind, n) ?? { total: 0 }));
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
  cache.pruneQuizzes(7);                       // 一週前的題目沒人會再交卷
  if (purged) console.log(`已清掉 ${purged} 筆超過 ${HISTORY_DAYS} 天的歷史原文`);
  setInterval(() => { cache.pruneHistory(HISTORY_DAYS); cache.pruneQuizzes(7); }, 6 * 3600_000).unref();
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
