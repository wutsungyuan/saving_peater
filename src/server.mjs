// API 伺服器：零依賴（node:http + node:sqlite）。
// POST /api/analyze 以 SSE 串流回傳，每分析完一句就推一句，不必等整段跑完。
// 路由在 routes/，共用工具在 http.mjs，設定在 config.mjs，資料庫在 context.mjs。

import { createServer } from 'node:http';
import { MODEL } from './analyzer.mjs';
import { PORT, MAX_CHARS, MAX_SENTENCES, CONCURRENCY, HOST, AUTH_ON, AUTH_USER, AUTH_PASS, HISTORY_DAYS, PAPER_KEEP, QUESTION_MAX, isLoopback } from './config.mjs';
import { cache, seeded } from './context.mjs';
import { serveStatic } from './http.mjs';
import { routes as analyzeRoutes } from './routes/analyze.mjs';
import { routes as practiceRoutes } from './routes/practice.mjs';
import { routes as wordRoutes } from './routes/words.mjs';
import { routes as articleRoutes } from './routes/articles.mjs';
import { routes as paperRoutes } from './routes/papers.mjs';
import { routes as authRoutes } from './routes/auth.mjs';

const ROUTES = [...authRoutes, ...analyzeRoutes, ...practiceRoutes, ...wordRoutes, ...articleRoutes, ...paperRoutes];

const server = createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  try {
    for (const route of ROUTES){
      if (!route.match(req, url)) continue;
      await route.handler(req, res, url);
      // 處理完就結束；沒送出任何回應就繼續比對下一條（和原本 if 串列的行為一致）
      if (res.headersSent || res.writableEnded) return;
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
  // 測驗卷歷史是快取：過期或超過最近 20 份就清掉；題庫（模型出的題）不隨歷史清，只設上限
  const prunePapers = () => { cache.prunePapers({ keep: PAPER_KEEP }); cache.pruneQuestions(QUESTION_MAX); };
  prunePapers();
  if (purged) console.log(`已清掉 ${purged} 筆超過 ${HISTORY_DAYS} 天的歷史原文`);
  cache.pruneSessions();
  setInterval(() => { cache.pruneSessions(); cache.pruneHistory(HISTORY_DAYS); cache.pruneQuizzes(7); prunePapers(); }, 6 * 3600_000).unref();
  console.log(`分析由本機 claude CLI 執行，額度計入這台機器登入的 Claude 帳號。`);
  console.log(`歷史原文保留 ${HISTORY_DAYS} 天後自動清除（分析快取不受影響）。`);
  console.log(`訂閱額度請在 Claude app → Settings → Usage 查看（CLI 沒有提供查詢介面）。`);
  if (isLoopback){
    console.log(`只接受本機連線。要讓區網其他裝置連：HOST=0.0.0.0 AUTH_USER=<帳號> AUTH_PASS=<密碼> npm start`);
  } else if (!AUTH_ON){
    console.log(`\n⚠  正在對外開放 (${HOST}) 且沒有設任何驗證。`);
    console.log(`   任何連得到這個位址的人都能用，且花的是你的 Claude 額度。`);
    console.log(`   建議改用：HOST=${HOST} AUTH_USER=<帳號> AUTH_PASS=<密碼> npm start\n`);
  } else {
    console.log(`對外開放 (${HOST})，已啟用驗證（${AUTH_USER && AUTH_PASS ? '帳號密碼登入' : 'AUTH_TOKEN'}）。`);
  }
});
process.on('SIGINT', () => { cache.checkpoint(); cache.close(); server.close(() => process.exit(0)); });
