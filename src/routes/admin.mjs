// 路由：老師後台。句子管理（列表、看分析、排除出題、重新分析、刪除）。全部只有老師能用。
import { cache } from '../context.mjs';
import { COLD_START_USD } from '../config.mjs';
import { readBody, authed, denyStudent, sendJson } from '../http.mjs';
import { internalCall } from '../internal.mjs';

const body = async req => { try { return JSON.parse(await readBody(req, 1e5)) || {}; } catch { return {}; } };
/** 驗證並限定老師。通過回 false，沒通過已經回應了（呼叫端直接 return）。 */
function teacherOnly(req, res, url){
  if (!authed(req, url)){ sendJson(res, 401, { error: 'unauthorized' }); return true; }
  return denyStudent(req, res, url);
}
const r3 = n => Math.round(n * 1000) / 1000;

export const routes = [
  // 列表：q 搜尋原文與翻譯；filter 篩選；limit、offset 分頁
  { match: (req, url) => url.pathname === '/api/admin/sentences' && req.method === 'GET', handler: async (req, res, url) => {
      if (teacherOnly(req, res, url)) return;
      const q = String(url.searchParams.get('q') || '').trim().slice(0, 80);
      const filter = ['excluded', 'issue', 'outscope', 'unused'].includes(url.searchParams.get('filter')) ? url.searchParams.get('filter') : 'all';
      const limit = Math.min(100, Math.max(1, Number(url.searchParams.get('limit')) || 50));
      const offset = Math.max(0, Number(url.searchParams.get('offset')) || 0);
      return sendJson(res, 200, { ...cache.sentenceList({ q, filter, limit, offset }), limit, offset });
    } },
  // 一句的完整分析與使用情形
  { match: (req, url) => url.pathname === '/api/admin/sentence' && req.method === 'GET', handler: async (req, res, url) => {
      if (teacherOnly(req, res, url)) return;
      const hash = String(url.searchParams.get('hash') || '');
      const row = cache.sentenceRow(hash);
      if (!row) return sendJson(res, 404, { error: 'not-found', message: '找不到這一句。' });
      let data = null; try { data = JSON.parse(row.result); } catch {}
      return sendJson(res, 200, { hash, original: row.original, data, excluded: Boolean(row.excluded), hits: row.hits, model: row.model,
        createdAt: row.created_at, costUsd: row.cost_usd, usedIn: cache.sentenceUsage(hash) });
    } },
  // 排除出題／恢復
  { match: (req, url) => url.pathname === '/api/admin/sentence-exclude' && req.method === 'POST', handler: async (req, res, url) => {
      if (teacherOnly(req, res, url)) return;
      const b = await body(req);
      const n = cache.setSentenceExcluded(b.hash, b.excluded === true);
      return n ? sendJson(res, 200, { ok: true, excluded: b.excluded === true }) : sendJson(res, 404, { error: 'not-found', message: '找不到這一句。' });
    } },
  // 刪除：被文章表用到的不能刪
  { match: (req, url) => url.pathname === '/api/admin/sentence' && req.method === 'DELETE', handler: async (req, res, url) => {
      if (teacherOnly(req, res, url)) return;
      const r = cache.deleteSentence(url.searchParams.get('hash'));
      if (r.error) return sendJson(res, 409, { error: r.error, articles: r.articles, message: `這句還在文章表「${r.articles.map(a => a.name).join('、')}」裡，要先從文章移除才能刪。` });
      return r.deleted ? sendJson(res, 200, { ok: true }) : sendJson(res, 404, { error: 'not-found', message: '找不到這一句。' });
    } },
  // 重新分析：先報價（不呼叫模型），confirm:true 才執行。失敗時舊的結果會放回去。
  { match: (req, url) => url.pathname === '/api/admin/sentence-reanalyze' && req.method === 'POST', handler: async (req, res, url) => {
      if (teacherOnly(req, res, url)) return;
      const b = await body(req);
      const row = cache.sentenceRow(b.hash);
      if (!row) return sendJson(res, 404, { error: 'not-found', message: '找不到這一句。' });
      const unit = cache.analysisUnitCost();
      const estimate = { low: r3(unit.perSentence * 0.8), high: r3(unit.perSentence * 1.3 + COLD_START_USD), seconds: Math.round(unit.msPerSentence / 1000) };
      if (b.confirm !== true) return sendJson(res, 409, { error: 'confirm-required', message: '要先確認費用才會呼叫模型。', quote: { estimate } });
      cache.removeSentenceRow(row.hash);
      let ok = false, err = null;
      try {
        const r = await internalCall('POST', '/api/analyze', { text: row.original });
        const done = r.events?.find(e => e.event === 'done')?.data;
        ok = r.status === 200 && cache.has(row.original) && !done?.failed;
        if (!ok) err = r.events?.find(e => e.event === 'failed' || e.event === 'halted')?.data?.message || r.json?.error || '分析沒有成功';
      } catch (e){ err = String(e.message || e); }
      if (!ok){
        cache.restoreSentenceRow(row);                // 失敗：把原本的結果放回去，不要弄丟
        return sendJson(res, 502, { error: 'reanalyze-failed', message: `重新分析失敗，已保留原本的結果。${err ? '（' + String(err).slice(0, 120) + '）' : ''}` });
      }
      // 新結果沿用原本的排除標記與命中次數
      if (row.excluded) cache.setSentenceExcluded(row.hash, true);
      return sendJson(res, 200, { ok: true });
    } },
];
