// 路由：分析、拍照辨識、範例、歷史、統計。
// 每條路由是 { match, handler }。handler 沒有送出回應時，server 會繼續比對下一條（和原本的 if 串列一致）。
import { join } from 'node:path';
import { analyze, extractProse, fixPronounCase, MODEL } from '../analyzer.mjs';
import { splitSentences, splitDialogue, dialogueUnits, splitInlineSpeakers } from '../segment.mjs';
import { hasBlank } from '../exercises.mjs';
import { writeFile, unlink, mkdir } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { STUDENT_OCR_PER_DAY, ROOT, MAX_CHARS, MAX_SENTENCES, MAX_ARTICLE_CHARS, MAX_ARTICLE_SENTENCES, COLD_START_USD, CONCURRENCY, AUTH_ON, HISTORY_DAYS } from '../config.mjs';
import { cache } from '../context.mjs';
import { readBody, pool, authed, roleOf, denyStudent, decodeImage } from '../http.mjs';
import { loginAvailable, studentAccount } from '../auth.mjs';
import { submitJob } from '../jobs.mjs';

const r3 = n => Math.round(n * 1000) / 1000;
/** 報價：不呼叫模型。用最近的分析紀錄估每句花費；要呼叫模型時再加上冷快取的暖機成本。 */
function quoteOf(segs){
  const cachedN = segs.filter(seg => cache.has(seg.text)).length;
  const toAnalyze = segs.length - cachedN;
  const unit = cache.analysisUnitCost();
  const base = unit.perSentence * toAnalyze;
  return { cached: cachedN, toAnalyze,
    unitCost: { perSentence: r3(unit.perSentence), samples: unit.samples, source: unit.source },
    estimate: { low: r3(base * 0.8), high: r3(base * 1.3 + (toAnalyze ? COLD_START_USD : 0)),
                seconds: Math.round(toAnalyze * unit.msPerSentence / 1000) } };
}

async function handleAnalyze(req, res, url){
  if (!authed(req, url)){
    res.writeHead(401, { 'content-type':'application/json' });
    return res.end('{"error":"unauthorized"}');
  }
  let body = {};
  try { body = JSON.parse(await readBody(req)) || {}; }
  catch { res.writeHead(400, { 'content-type':'application/json' }); return res.end('{"error":"bad json"}'); }
  const article = body.article === true;          // 文章模式：上限較高（要存成文章表的長文）
  const dryRun = body.dryRun === true;            // 只報價，不呼叫模型、不動快取
  const maxChars = article ? MAX_ARTICLE_CHARS : MAX_CHARS;
  const maxSentences = article ? MAX_ARTICLE_SENTENCES : MAX_SENTENCES;

  const text = splitInlineSpeakers(String(body.text ?? '').trim());       // 考卷的「?B:」黏在一起的對話先拆開
  if (!text){ res.writeHead(400, { 'content-type':'application/json' }); return res.end('{"error":"empty"}'); }
  if (text.length > maxChars){
    res.writeHead(413, { 'content-type':'application/json' });
    return res.end(JSON.stringify({ error: `too long`, maxChars, got: text.length, article }));
  }

  // 對話題（A: … / B: …）：拆掉說話者標記再分析，但記下誰說的、對方說了什麼。
  // 不這樣做的話「A: What did you make for…」會把標記當成句子的一部分。
  const turns = splitDialogue(text);
  let segs, dlg = null;
  if (turns){
    dlg = dialogueUnits(turns);                     // 一個人說了好幾句時，每句各自分析
    segs = dlg.map(u => ({ text: u.text }));
  } else {
    segs = splitSentences(text);
  }
  const truncated = segs.length > maxSentences;
  if (truncated) segs = segs.slice(0, maxSentences);

  // 報價：不呼叫模型，也不算快取命中。用最近的分析紀錄估每句花費；
  // 要呼叫模型時再加上冷快取的暖機成本（上限才加，下限假設快取是熱的）。
  if (dryRun){
    const q = quoteOf(segs);
    res.writeHead(200, { 'content-type':'application/json; charset=utf-8' });
    // 學生看不到費用，只知道有幾句要送老師核准
    const view = roleOf(req, url) === 'student' ? { cached: q.cached, toAnalyze: q.toAnalyze } : q;
    return res.end(JSON.stringify({ total: segs.length, truncated, article, limits: { maxChars, maxSentences }, ...view }));
  }

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

  // 對話：告訴前端每一句是誰說的、屬於第幾次發言，讓同一個人說的幾句排在一起、只標一次名字
  send('meta', { total: segs.length, truncated, maxSentences, article, model: MODEL,
    ...(dlg ? { dialogue: dlg.slice(0, segs.length).map(u => ({ speaker: u.speaker, turn: u.turn, text: u.text })) } : {}) });
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

  // 學生：沒分析過的句子要老師核准才會呼叫模型。快取命中的上面已經推出去了，其餘開一張申請單就結束。
  if (misses.length && roleOf(req, url) === 'student'){
    const first = misses[0].seg.text;
    const job = submitJob(cache, { kind: 'analyze', by: 'student',
      payload: { text, article, saveAs: body.saveAs ? String(body.saveAs).trim().slice(0, 60) : null },
      dedupOn: JSON.stringify([text, body.saveAs || null]),
      quote: { total: segs.length, ...quoteOf(segs) },
      summary: `${body.saveAs ? '存成文章「' + String(body.saveAs).trim().slice(0, 30) + '」・' : ''}分析 ${misses.length} 句：${first.length > 40 ? first.slice(0, 40) + '…' : first}` });
    send('approval', { jobId: job.id, toAnalyze: misses.length, total: segs.length, status: job.status, reused: job.reused });
    stopBeat();
    send('done', { ms: Date.now() - t0, total: segs.length, cached, analyzed: 0, failed: 0, usage, model: MODEL, halted: null, pendingApproval: job.id });
    res.end();
    return;
  }

  // ---- 一句分析完成後的收尾：核對原句、存快取、推給前端 ----
  const toUsage = (u = {}, costUsd = 0) => ({
    inputTokens: (u.input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0),
    outputTokens: u.output_tokens ?? 0,
    cacheReadTokens: u.cache_read_input_tokens ?? 0,
    costUsd,
  });
  const addUsage = one => { for (const k of Object.keys(usage)) usage[k] += one[k]; };
  const share = (one, n) => Object.fromEntries(Object.entries(one).map(([k, v]) => [k, v / n]));   // 一批的花費平均分給每一句

  const finishOne = ({ seg, i }, sentence, one) => {
    sentence.index = i;
    // 對話的話，把對方說的話一起存起來
    const dlgMeta = dlg ? {
      speaker: dlg[i]?.speaker ?? null,
      context: dlg.filter(u => u.turn !== dlg[i]?.turn).map(t => `${t.speaker}: ${t.text}`).join('\n') || null,
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
  };
  const failOne = ({ seg, i }, e) => {
    failed++;
    const kind = e.kind || 'other';
    if (kind === 'rate-limit' || kind === 'auth'){
      halted = kind;   // 這類錯誤重試也沒用，立刻停掉其餘工作
      if (!closed) send('halted', { kind, index: i, message: String(e.message).slice(0, 400) });
    } else if (!closed) {
      send('failed', { index: i, original: seg.text, kind, message: String(e.message).slice(0, 300) });
    }
  };
  const progress = () => { if (!closed) send('progress', { done: cached + analyzed + failed, total: segs.length }); };

  // 單句分析（一批裡對不上的句子、或只剩一句時）
  const single = async (member, extra = null) => {
    if (closed || halted) return;
    try {
      const { data, meta } = await analyze(member.seg.text);
      const sentence = data?.sentences?.[0];
      if (!sentence) throw new Error('模型沒有回傳句子');
      const one = toUsage(meta?.usage, meta?.costUsd ?? 0);
      addUsage(one);
      // 模型把我們送的一句拆成好幾句：只取第一句會悄悄丟掉後面的內容，所以當作失敗讓使用者看見
      if ((data?.sentences?.length ?? 0) > 1 && sentence.original && sentence.original.trim() !== member.seg.text.trim())
        throw Object.assign(new Error('模型把這一句拆成了多句，沒有存。請把這一句拆開再分析。'), { kind: 'split' });
      if (extra) for (const k of Object.keys(one)) one[k] += extra[k];
      finishOne(member, sentence, one);
    } catch (e){ failOne(member, e); }
    progress();
  };

  // 多句併成一次呼叫：每次呼叫都要重讀約 34K tokens 的系統提示，逐句送就是付 N 次
  // （實測六句整批比逐句省 40% 費用、49% 時間）。模型可能漏句或併句，所以用原句對回去，
  // 對不上的單獨再送一次 —— 寧可多花也不給錯的結果。
  const GROUP = Math.max(1, Number(process.env.ANALYZE_GROUP || 6));
  const groups = [];
  for (let g = 0; g < misses.length; g += GROUP) groups.push(misses.slice(g, g + GROUP));

  await pool(groups, CONCURRENCY, async group => {
    if (closed || halted) return;
    if (group.length === 1) return single(group[0]);
    let got = [], batch = null;
    try {
      const { data, meta } = await analyze(group.map(m => m.seg.text).join(' '));
      got = data?.sentences ?? [];
      batch = toUsage(meta?.usage, meta?.costUsd ?? 0);
      addUsage(batch);
    } catch (e){
      const kind = e.kind || 'other';
      if (kind === 'rate-limit' || kind === 'auth'){ for (const m of group) failOne(m, e); progress(); return; }
      // 整批失敗（格式跑掉、逾時…）：每一句退回單句分析
    }
    const part = batch ? share(batch, group.length) : null;
    const byText = new Map();
    for (const s of got) if (s?.original) byText.set(String(s.original).trim(), s);
    const missed = [];
    for (const m of group){
      const hit = byText.get(m.seg.text.trim());
      if (hit && part){ finishOne(m, hit, { ...part }); progress(); }
      else missed.push(m);
    }
    for (const m of missed) await single(m, part);
  });

  stopBeat();
  const ms = Date.now() - t0;
  cache.log({ chars: text.length, sentences: segs.length, cached, analyzed, ms, text, ...usage });
  if (!closed){
    send('done', { ms, total: segs.length, cached, analyzed, failed, usage, model: MODEL, halted });
    res.end();
  }
}

export const routes = [
  {
    match: (req, url) => req.method === 'POST' && url.pathname === '/api/analyze',
    handler: (req, res, url) => handleAnalyze(req, res, url),
  },
  {
    match: (req, url) => url.pathname === '/api/health',
    handler: async (req, res, url) => {
      res.writeHead(200, { 'content-type':'application/json' });
      return res.end(JSON.stringify({ ok: true, model: MODEL, maxChars: MAX_CHARS,
        maxSentences: MAX_SENTENCES, articleMaxChars: MAX_ARTICLE_CHARS,
        articleMaxSentences: MAX_ARTICLE_SENTENCES, authRequired: AUTH_ON,
        loginAvailable, loggedIn: authed(req, url), role: roleOf(req, url), studentAccount }));
    },
  },
    // 拍照辨識：課本上的英文句子 → 文字，填進分析的輸入框
    // 之後完全走原本的流程（斷句 → 逐句分析 → 快取），和自己貼上一段沒有差別。
  {
    match: (req, url) => req.method === 'POST' && url.pathname === '/api/analyze-ocr',
    handler: async (req, res, url) => {
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
      // 學生：每天有免審的辨識張數，直接辨識；超過才開申請單（照片先存在申請單裡，核准後才辨識，辨識完就清掉）
      const student = roleOf(req, url) === 'student';
      if (student && cache.studentOcrToday() >= STUDENT_OCR_PER_DAY){
        const job = submitJob(cache, { kind: 'ocr', by: 'student', payload: { image: b.image, mode: b.mode === 'article' ? 'article' : 'sentence' },
          summary: `辨識課本照片（${Math.round(img.buf.length / 1024)} KB）・超過今天免審的辨識張數` });
        res.writeHead(202, { 'content-type':'application/json; charset=utf-8' });
        return res.end(JSON.stringify({ pending: true, jobId: job.id, reused: job.reused }));
      }
      const dir = join(ROOT, 'data', 'tmp');
      const file = join(dir, `ocr-${randomBytes(8).toString('hex')}.${img.ext}`);
      const t0 = Date.now();
      try {
        await mkdir(dir, { recursive: true });
        await writeFile(file, img.buf);
        const { text: rawText, filled, usage } = await extractProse(file);
        const text = splitInlineSpeakers(rawText);                  // 模型常照印刷把「?B:」黏著抄下來，這裡拆成兩行
        // 和單字表辨識分開記 —— 兩者抄的東西不一樣，歷史上要看得出來
        cache.log({ kind:'ocr-text', chars: img.buf.length,
          sentences: text ? splitSentences(text).length : 0,
          cached:0, analyzed:0, ms: Date.now() - t0,
          text: text || '（照片裡沒有抄到英文句子）', byRole: student ? 'student' : null, ...usage });
        res.writeHead(200, { 'content-type':'application/json; charset=utf-8' });
        return res.end(JSON.stringify({ text, filled, usage: student ? {} : usage }));      // 學生看不到費用
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
    },
  },
    // 範例句：讓標籤能改抓分析過的真實句子
  {
    match: (req, url) => url.pathname === '/api/samples',
    handler: async (req, res, url) => {
      const kind = url.searchParams.get('kind');
      res.writeHead(200, { 'content-type':'application/json; charset=utf-8' });
      if (!kind) return res.end(JSON.stringify({ counts: cache.sampleCounts() }));
      const n = Number(url.searchParams.get('n')) || 0;
      return res.end(JSON.stringify(cache.sampleOf(kind, n) ?? { total: 0 }));
    },
  },
  {
    match: (req, url) => url.pathname === '/api/history',
    handler: async (req, res, url) => {
      if (!authed(req, url)){ res.writeHead(401, { 'content-type':'application/json' }); return res.end('{"error":"unauthorized"}'); }
      if (denyStudent(req, res, url)) return;
      const id = url.searchParams.get('id');
      res.writeHead(200, { 'content-type':'application/json; charset=utf-8' });
      if (id) return res.end(JSON.stringify({ text: cache.historyText(Number(id)) }));
      return res.end(JSON.stringify({
        retainDays: HISTORY_DAYS,
        usage: cache.usageSummary(),
        items: cache.history(40),
      }));
    },
  },
  {
    match: (req, url) => url.pathname === '/api/stats',
    handler: async (req, res, url) => {
      if (!authed(req, url)){ res.writeHead(401, { 'content-type':'application/json' }); return res.end('{"error":"unauthorized"}'); }
      if (denyStudent(req, res, url)) return;
      res.writeHead(200, { 'content-type':'application/json; charset=utf-8' });
      return res.end(JSON.stringify(cache.stats(), null, 2));
    },
  },
];
