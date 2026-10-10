// 路由：測驗卷。預覽、出卷、作答存檔、交卷、自評、訂正、歷史。全部要驗證。
import { cache } from '../context.mjs';
import { PAPER_DAYS } from '../config.mjs';
import { readBody, authed, sendJson } from '../http.mjs';
import { previewPaper, createPaper, paperView, saveAnswers, submitPaper, markSelf, createFixPaper, historyList } from '../papers/paper.mjs';

const body = async req => { try { return JSON.parse(await readBody(req, 2e6)) || {}; } catch { return {}; } };
const guard = (handler, method) => async (req, res, url) => {
  if (!authed(req, url)) return sendJson(res, 401, { error: 'unauthorized' });
  if (method && req.method !== method) return sendJson(res, 405, { error: 'method-not-allowed' });
  return handler(req, res, url);
};
const fail = (res, r, status = 400) => sendJson(res, r.error === 'expired' ? 410 : status, r);

export const routes = [
  { match: (req, url) => url.pathname === '/api/paper-preview', handler: guard(async (req, res) => {
      const r = previewPaper(cache, await body(req));
      return r.error ? fail(res, r) : sendJson(res, 200, r);
    }, 'POST') },

  { match: (req, url) => url.pathname === '/api/papers', handler: guard(async (req, res, url) => {
      if (req.method === 'GET') return sendJson(res, 200, { papers: historyList(cache), keepDays: PAPER_DAYS });
      if (req.method === 'DELETE'){ const n = cache.deletePaper(url.searchParams.get('id')); return sendJson(res, 200, { ok: true, deleted: n }); }
      if (req.method === 'POST'){
        const r = createPaper(cache, await body(req), { ttlDays: PAPER_DAYS });
        return r.error ? fail(res, r, r.error === 'confirm-required' ? 409 : 400) : sendJson(res, 200, r);
      }
      return sendJson(res, 405, { error: 'method-not-allowed' });
    }) },

  { match: (req, url) => url.pathname === '/api/paper' && req.method === 'GET', handler: guard(async (req, res, url) => {
      const p = cache.getPaper(url.searchParams.get('id'));
      return p ? sendJson(res, 200, paperView(p)) : sendJson(res, 410, { error: 'expired', message: '這份卷子已經過期或不存在。' });
    }) },

  { match: (req, url) => url.pathname === '/api/paper-save', handler: guard(async (req, res) => {
      const b = await body(req); const r = saveAnswers(cache, b.id, b.answers);
      return r.error ? fail(res, r, 409) : sendJson(res, 200, r);
    }, 'POST') },

  { match: (req, url) => url.pathname === '/api/paper-submit', handler: guard(async (req, res) => {
      const b = await body(req); const r = submitPaper(cache, b.id, { answers: b.answers, userToken: String(b.userToken || 'anon').slice(0, 64) });
      return r.error ? fail(res, r) : sendJson(res, 200, r);
    }, 'POST') },

  { match: (req, url) => url.pathname === '/api/paper-self', handler: guard(async (req, res) => {
      const b = await body(req); const r = markSelf(cache, b.id, b.marks);
      return r.error ? fail(res, r, 409) : sendJson(res, 200, r);
    }, 'POST') },

  { match: (req, url) => url.pathname === '/api/paper-redo', handler: guard(async (req, res) => {
      const b = await body(req); const r = createFixPaper(cache, b.id, { ids: Array.isArray(b.ids) ? b.ids : null, ttlDays: PAPER_DAYS });
      return r.error ? fail(res, r, 409) : sendJson(res, 200, r);
    }, 'POST') },
];
