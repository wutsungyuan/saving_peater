// 路由：句子練習：出題、交卷、弱點。
// 每條路由是 { match, handler }。handler 沒有送出回應時，server 會繼續比對下一條（和原本的 if 串列一致）。
import { generate, grade, TYPES } from '../exercises.mjs';
import { cache } from '../context.mjs';
import { readBody, pool, authed } from '../http.mjs';
import { redoQuestions } from './shared.mjs';

export const routes = [
    // 出題：從已分析的句子反向生成，不呼叫模型
  {
    match: (req, url) => req.method === 'POST' && url.pathname === '/api/exercises',
    handler: async (req, res, url) => {
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
    },
  },
    // 批改並記錄作答
  {
    match: (req, url) => req.method === 'POST' && url.pathname === '/api/attempts',
    handler: async (req, res, url) => {
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
    },
  },
  {
    match: (req, url) => url.pathname === '/api/weakness',
    handler: async (req, res, url) => {
      if (!authed(req, url)){ res.writeHead(401, { 'content-type':'application/json' }); return res.end('{"error":"unauthorized"}'); }
      const userToken = url.searchParams.get('user') || 'anon';
      res.writeHead(200, { 'content-type':'application/json; charset=utf-8' });
      return res.end(JSON.stringify(cache.weakness(userToken, url.searchParams.get('source') || 'all'), null, 2));
    },
  },
];
