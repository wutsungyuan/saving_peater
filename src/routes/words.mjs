// 路由：單字表：建立、辨識、測驗、交卷。
// 每條路由是 { match, handler }。handler 沒有送出回應時，server 會繼續比對下一條（和原本的 if 串列一致）。
import { join } from 'node:path';
import { analyzeMany, fixPronounCase, MODEL } from '../analyzer.mjs';
import { hasBlank } from '../exercises.mjs';
import { parseWordList, enrich, generateWordQuiz, gradeWord, WORD_MODES, extractFromImage, wordsToText, searchWords } from '../wordset.mjs';
import { writeFile, unlink, mkdir } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { ROOT } from '../config.mjs';
import { cache } from '../context.mjs';
import { readBody, authed, roleOf, denyStudent, userOf, decodeImage } from '../http.mjs';
import { submitJob } from '../jobs.mjs';
import { STUDENT_OCR_PER_DAY } from '../config.mjs';
import { setIdList, redoQuestions, exampleSentences, visibleIds, visibleRows } from './shared.mjs';

export const routes = [
    // ---------- 單字表 ----------
  {
    match: (req, url) => url.pathname === '/api/wordsets',
    handler: async (req, res, url) => {
      const userToken = userOf(req, url, url.searchParams.get('user'));
      if (req.method === 'GET'){
        if (!authed(req, url)){ res.writeHead(401, { 'content-type':'application/json' }); return res.end('{"error":"unauthorized"}'); }
        res.writeHead(200, { 'content-type':'application/json; charset=utf-8' });
        return res.end(JSON.stringify({ sets: visibleRows(req, url, cache.wordsets(userToken)) }));
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
        // 學生：整理單字要呼叫模型，開申請單，老師核准後才建立
        if (roleOf(req, url) === 'student'){
          const appendTo0 = Number(b.appendTo) || 0;
          const target = appendTo0 ? (cache.wordsets('anon').find(x => x.id === appendTo0)?.name ?? '字表') : (b.name || '單字');
          const job = submitJob(cache, { kind: 'wordset', by: 'student', payload: { name: b.name || '單字', text: b.text || '', appendTo: appendTo0 || undefined, note: b.note || undefined },
            quote: { words: items.length },
            summary: `${appendTo0 ? '加到字表' : '新增字表'}「${target}」：${items.length} 個字` });
          res.writeHead(202, { 'content-type':'application/json; charset=utf-8' });
          return res.end(JSON.stringify({ pending: true, jobId: job.id, reused: job.reused, words: items.length }));
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
        if (denyStudent(req, res, url)) return;
        const ids = setIdList(url.searchParams.get('ids'), url.searchParams.get('id'));
        const n = ids.length ? cache.deleteWordset(ids) : 0;
        res.writeHead(200, { 'content-type':'application/json' });
        return res.end(JSON.stringify({ ok: true, deleted: n }));
      }
    },
  },
    // 拍照辨識：讀課本單字表的照片，抄成可編輯的文字給使用者核對
  {
    match: (req, url) => req.method === 'POST' && url.pathname === '/api/wordset-ocr',
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
      const { buf, ext } = img;
      // 學生：每天有免審的辨識張數，直接辨識；超過才開申請單
      const student = roleOf(req, url) === 'student';
      if (student && cache.studentOcrToday() >= STUDENT_OCR_PER_DAY){
        const job = submitJob(cache, { kind: 'wordset-ocr', by: 'student', payload: { image: b.image },
          summary: `辨識單字表照片（${Math.round(buf.length / 1024)} KB）・超過今天免審的辨識張數` });
        res.writeHead(202, { 'content-type':'application/json; charset=utf-8' });
        return res.end(JSON.stringify({ pending: true, jobId: job.id, reused: job.reused }));
      }
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
          text: text || '（照片裡沒有抄到單字）', byRole: student ? 'student' : null, ...usage });
        res.writeHead(200, { 'content-type':'application/json; charset=utf-8' });
        return res.end(JSON.stringify({ words, text, usage: student ? {} : usage }));      // 學生看不到費用
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
    },
  },
  {
    // 搜尋單字：跨所有字表，英文或中文都可以。不呼叫模型。
    match: (req, url) => req.method === 'GET' && url.pathname === '/api/wordsearch',
    handler: async (req, res, url) => {
      if (!authed(req, url)){ res.writeHead(401, { 'content-type':'application/json' }); return res.end('{"error":"unauthorized"}'); }
      const userToken = userOf(req, url, url.searchParams.get('user'));
      const q = String(url.searchParams.get('q') || '').trim().slice(0, 60);
      res.writeHead(200, { 'content-type':'application/json; charset=utf-8' });
      if (!q) return res.end(JSON.stringify({ q, words: [], total: 0 }));
      const hits = searchWords(cache.wordsOf(visibleRows(req, url, cache.wordsets(userToken)).map(s => s.id), userToken), q);
      for (const w of hits)
        for (const sn of w.senses ?? [])
          if (sn.example) sn.analyzed = Boolean(cache.get(String(sn.example).trim()));
      return res.end(JSON.stringify({ q, words: hits, total: hits.length }));
    },
  },
  {
    match: (req, url) => url.pathname === '/api/wordset',
    handler: async (req, res, url) => {
      const userToken = userOf(req, url, url.searchParams.get('user'));
      const ids = visibleIds(req, url, 'wordset', setIdList(url.searchParams.get('ids'), url.searchParams.get('id')));
      if (req.method === 'GET' && !authed(req, url)){ res.writeHead(401, { 'content-type':'application/json' }); return res.end('{"error":"unauthorized"}'); }
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
    },
  },
    // 批次分析字表的例句：多句併成一次呼叫，比逐句省四成
  {
    match: (req, url) => req.method === 'POST' && url.pathname === '/api/wordset-analyze',
    handler: async (req, res, url) => {
      if (!authed(req, url)){ res.writeHead(401, { 'content-type':'application/json' }); return res.end('{"error":"unauthorized"}'); }
      if (denyStudent(req, res, url)) return;
      let b = {};
      try { b = JSON.parse(await readBody(req)) || {}; } catch {}
      const userToken = userOf(req, url, b.userToken);
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
    },
  },
  {
    match: (req, url) => req.method === 'POST' && url.pathname === '/api/wordquiz',
    handler: async (req, res, url) => {
      if (!authed(req, url)){ res.writeHead(401, { 'content-type':'application/json' }); return res.end('{"error":"unauthorized"}'); }
      let b = {};
      try { b = JSON.parse(await readBody(req)) || {}; } catch {}
      const userToken = userOf(req, url, b.userToken);
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
      const words = cache.wordsOf(visibleIds(req, url, 'wordset', setIdList(b.setIds, b.setId)), userToken);
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
    },
  },
  {
    match: (req, url) => req.method === 'POST' && url.pathname === '/api/wordattempts',
    handler: async (req, res, url) => {
      if (!authed(req, url)){ res.writeHead(401, { 'content-type':'application/json' }); return res.end('{"error":"unauthorized"}'); }
      let b = {};
      try { b = JSON.parse(await readBody(req)) || {}; } catch {}
      const quiz = cache.getQuiz(b.quizId);
      if (!quiz){
        res.writeHead(410, { 'content-type':'application/json; charset=utf-8' });
        return res.end(JSON.stringify({ error:'quiz-expired', message:'這份測驗已失效，請重新出題。' }));
      }
      const userToken = userOf(req, url, b.userToken);
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
    },
  },
];
