// 路由：文章表。所有端點都要驗證（含讀取），因為文章是使用者的課文內容。
// 存文章表不呼叫模型：句子要先分析過（分析走 /api/analyze，article:true），這裡只存順序。
import { cache } from '../context.mjs';
import { readBody, authed, sendJson } from '../http.mjs';
import { saveArticle, articleView } from '../articles.mjs';
import { setIdList } from './shared.mjs';

const deny = res => sendJson(res, 401, { error: 'unauthorized' });
const body = async req => { try { return JSON.parse(await readBody(req, 2e6)) || {}; } catch { return {}; } };

export const routes = [
  {
    match: (req, url) => url.pathname === '/api/articles',
    handler: async (req, res, url) => {
      if (!authed(req, url)) return deny(res);
      if (req.method === 'GET') return sendJson(res, 200, { articles: cache.articles() });
      if (req.method === 'POST'){
        const b = await body(req);
        const r = saveArticle(cache, { name: b.name, text: b.text, appendTo: b.appendTo });
        if (r.error === 'not-analyzed') return sendJson(res, 409, { ...r, missing: r.missing.slice(0, 20) });
        if (r.error) return sendJson(res, 400, r);
        return sendJson(res, 200, r);
      }
      if (req.method === 'DELETE'){
        const ids = setIdList(url.searchParams.get('ids'), url.searchParams.get('id'));
        return sendJson(res, 200, { ok: true, deleted: ids.length ? cache.deleteArticles(ids) : 0 });
      }
    },
  },
  {
    match: (req, url) => url.pathname === '/api/article' && req.method === 'GET',
    handler: async (req, res, url) => {
      if (!authed(req, url)) return deny(res);
      // sets：要標出哪些單字表的單字（選填）
      const sets = setIdList(url.searchParams.get('sets'));
      const words = sets.length ? cache.wordsOf(sets, 'anon') : [];
      const v = articleView(cache, Number(url.searchParams.get('id')), words);
      return v ? sendJson(res, 200, v) : sendJson(res, 404, { error: 'not-found', message: '找不到這份文章表。' });
    },
  },
  {
    match: (req, url) => url.pathname === '/api/article-rename' && req.method === 'POST',
    handler: async (req, res, url) => {
      if (!authed(req, url)) return deny(res);
      const b = await body(req);
      const name = String(b.name ?? '').trim();
      if (!name) return sendJson(res, 400, { error: 'no-name', message: '請輸入文章名稱。' });
      const n = cache.renameArticle(b.id, name);
      return n ? sendJson(res, 200, { ok: true }) : sendJson(res, 404, { error: 'not-found', message: '找不到這份文章表。' });
    },
  },
];
