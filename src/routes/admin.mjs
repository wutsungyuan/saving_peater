// 路由：老師後台。句子管理（列表、看分析、排除出題、重新分析、刪除）。全部只有老師能用。
import { cache } from '../context.mjs';
import { COLD_START_USD, DB_FILE } from '../config.mjs';
import { mkdirSync, readdirSync, unlinkSync } from 'node:fs';
import { dirname, join, basename } from 'node:path';
import { readBody, authed, denyStudent, sendJson } from '../http.mjs';
import { internalCall } from '../internal.mjs';

const body = async req => { try { return JSON.parse(await readBody(req, 1e5)) || {}; } catch { return {}; } };
/** 驗證並限定老師。通過回 false，沒通過已經回應了（呼叫端直接 return）。 */
function teacherOnly(req, res, url){
  if (!authed(req, url)){ sendJson(res, 401, { error: 'unauthorized' }); return true; }
  return denyStudent(req, res, url);
}
const r3 = n => Math.round(n * 1000) / 1000;

/** 整理前端送來的條件。日期是本機時間的 YYYY-MM-DD：起（含當天）、迄（含當天，所以內部算到隔天 0 點）。 */
function recordFilter(b = {}){
  const kind = ['practice', 'quiz', 'exam'].includes(b.kind) ? b.kind : 'all';
  const day = (s, add = 0) => { const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(s ?? '')); if (!m) return null; const d = new Date(+m[1], +m[2] - 1, +m[3] + add); return Number.isNaN(d.getTime()) ? null : d.getTime(); };
  const setIds = [...new Set((Array.isArray(b.setIds) ? b.setIds : []).map(Number).filter(n => Number.isInteger(n) && n > 0))].slice(0, 50);
  return { kind, from: day(b.from), to: day(b.to, 1), setIds, resetProgress: b.resetProgress === true };
}
const describe = f => ({ kind: f.kind, from: f.from, to: f.to, setIds: f.setIds, resetProgress: f.resetProgress });

export const routes = [
  // 學生練習紀錄的整理：先預覽會刪多少
  { match: (req, url) => url.pathname === '/api/admin/records-preview' && req.method === 'POST', handler: async (req, res, url) => {
      if (teacherOnly(req, res, url)) return;
      const f = recordFilter(await body(req));
      return sendJson(res, 200, { counts: cache.recordsCount(f), filter: describe(f), audit: cache.auditList(10) });
    } },
  // 真的刪：要帶 confirm:true；先備份整個資料庫、一個交易刪完、留操作紀錄
  { match: (req, url) => url.pathname === '/api/admin/records-delete' && req.method === 'POST', handler: async (req, res, url) => {
      if (teacherOnly(req, res, url)) return;
      const b = await body(req), f = recordFilter(b);
      const counts = cache.recordsCount(f);
      if (b.confirm !== true) return sendJson(res, 409, { error: 'confirm-required', message: '要先確認才會刪。', counts });
      if (!counts.attempts && !counts.wordAttempts && !counts.progress) return sendJson(res, 200, { ok: true, deleted: counts, backup: null, message: '沒有符合條件的紀錄。' });
      const dir = join(dirname(DB_FILE), 'backups'); mkdirSync(dir, { recursive: true });
      const path = join(dir, `${basename(DB_FILE, '.db')}.before-delete-${new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14)}-${Math.random().toString(36).slice(2, 6)}.db`);
      cache.backupTo(path);
      const deleted = cache.deleteRecords(f);
      cache.audit('teacher', 'records-delete', { filter: describe(f), deleted, backup: basename(path) });
      // 只留最近 10 份這種備份
      try { const mine = readdirSync(dir).filter(x => x.includes('.before-delete-')).sort(); for (const old of mine.slice(0, Math.max(0, mine.length - 10))) unlinkSync(join(dir, old)); } catch {}
      return sendJson(res, 200, { ok: true, deleted, backup: basename(path), audit: cache.auditList(10) });
    } },
  // ---- 內容管理：字表與文章表的清單、改名、對學生隱藏、刪除（先預覽、先備份）----
  { match: (req, url) => url.pathname === '/api/admin/content' && req.method === 'GET', handler: async (req, res, url) => {
      if (teacherOnly(req, res, url)) return;
      return sendJson(res, 200, {
        wordsets: cache.wordsets('student').map(s => ({ id: s.id, name: s.name, note: s.note, count: s.word_count, hidden: Boolean(s.hidden), createdAt: s.created_at })),
        articles: cache.articles().map(a => ({ id: a.id, name: a.name, count: a.sentences, hidden: Boolean(a.hidden), createdAt: a.created_at })),
      });
    } },
  // 改名（字表另可改備註）／隱藏。只改有帶的欄位
  { match: (req, url) => url.pathname === '/api/admin/content-update' && req.method === 'POST', handler: async (req, res, url) => {
      if (teacherOnly(req, res, url)) return;
      const b = await body(req), kind = b.kind === 'article' ? 'article' : b.kind === 'wordset' ? 'wordset' : null, id = Number(b.id);
      if (!kind || !Number.isInteger(id)) return sendJson(res, 400, { error: 'bad-request', message: '缺少 kind 或 id。' });
      const exists = kind === 'article' ? cache.getArticle(id) : cache.wordsets('student').find(s => s.id === id);
      if (!exists) return sendJson(res, 404, { error: 'not-found', message: '找不到這一份。' });
      if (b.name !== undefined){
        const name = String(b.name).trim().slice(0, 60);
        if (!name) return sendJson(res, 400, { error: 'no-name', message: '名稱不能空白。' });
        if (kind === 'article'){
          const dup = cache.articleByName(name);
          if (dup && dup.id !== id) return sendJson(res, 409, { error: 'name-taken', message: `已經有一份文章表叫「${dup.name}」，換個名稱。` });
          cache.renameArticle(id, name);
        } else cache.renameWordset(id, name, b.note === undefined ? undefined : String(b.note).trim().slice(0, 200));
      } else if (b.note !== undefined && kind === 'wordset') cache.renameWordset(id, exists.name, String(b.note).trim().slice(0, 200));
      if (b.hidden !== undefined) cache.setHidden(kind, id, b.hidden === true);
      return sendJson(res, 200, { ok: true });
    } },
  // 刪除前的預覽：會連帶刪掉多少
  { match: (req, url) => url.pathname === '/api/admin/content-delete-preview' && req.method === 'POST', handler: async (req, res, url) => {
      if (teacherOnly(req, res, url)) return;
      const b = await body(req), kind = b.kind === 'article' ? 'article' : 'wordset';
      const ids = (Array.isArray(b.ids) ? b.ids : []).map(Number).filter(Number.isInteger).slice(0, 50);
      return sendJson(res, 200, { kind, ...cache.deletePreview(kind, ids) });
    } },
  // 真的刪：要帶 confirm:true；先備份整個資料庫。字表連作答與熟練度一起刪，文章表只刪順序
  { match: (req, url) => url.pathname === '/api/admin/content-delete' && req.method === 'POST', handler: async (req, res, url) => {
      if (teacherOnly(req, res, url)) return;
      const b = await body(req), kind = b.kind === 'article' ? 'article' : 'wordset';
      const ids = (Array.isArray(b.ids) ? b.ids : []).map(Number).filter(Number.isInteger).slice(0, 50);
      if (!ids.length) return sendJson(res, 400, { error: 'bad-request', message: '沒有指定要刪的項目。' });
      const preview = cache.deletePreview(kind, ids);
      if (b.confirm !== true) return sendJson(res, 409, { error: 'confirm-required', message: '要先確認才會刪。', ...preview });
      const dir = join(dirname(DB_FILE), 'backups'); mkdirSync(dir, { recursive: true });
      const path = join(dir, `${basename(DB_FILE, '.db')}.before-delete-${kind}-${new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14)}-${Math.random().toString(36).slice(2, 6)}.db`);
      cache.backupTo(path);
      const deleted = kind === 'article' ? cache.deleteArticles(ids) : cache.deleteWordset(ids);
      try { const mine = readdirSync(dir).filter(x => x.includes('.before-delete-')).sort(); for (const old of mine.slice(0, Math.max(0, mine.length - 10))) unlinkSync(join(dir, old)); } catch {}
      return sendJson(res, 200, { ok: true, deleted, backup: basename(path), ...preview });
    } },
  // 列表：q 搜尋原文與翻譯；filter 篩選；limit、offset 分頁
  { match: (req, url) => url.pathname === '/api/admin/sentences' && req.method === 'GET', handler: async (req, res, url) => {
      if (teacherOnly(req, res, url)) return;
      const q = String(url.searchParams.get('q') || '').trim().slice(0, 80);
      const filter = ['excluded', 'issue', 'outscope', 'unused'].includes(url.searchParams.get('filter')) ? url.searchParams.get('filter') : 'all';
      const limit = Math.min(100, Math.max(1, Number(url.searchParams.get('limit')) || 50));
      const offset = Math.max(0, Number(url.searchParams.get('offset')) || 0);
      return sendJson(res, 200, { ...cache.sentenceList({ q, filter, limit, offset }), limit, offset });
    } },
  // 把還沒有範圍的句子歸進文章表。mode：name（全部歸到 name 這一份，同名接在後面）| by-date（依分析日期分批，每天一份「句子 月/日」）。
  // 先預覽（不改資料），帶 confirm:true 才真的歸。已經在文章表裡的句子不會被動到。
  { match: (req, url) => url.pathname === '/api/admin/sentences-assign' && req.method === 'POST', handler: async (req, res, url) => {
      if (teacherOnly(req, res, url)) return;
      const b = await body(req);
      const mode = b.mode === 'by-date' ? 'by-date' : 'name';
      const name = String(b.name ?? '').trim().slice(0, 60);
      if (mode === 'name' && !name) return sendJson(res, 400, { error: 'no-name', message: '請輸入要歸入的範圍名稱。' });
      const list = cache.unassignedSentences(String(b.q ?? '').trim().slice(0, 80));
      const day = t => { const d = new Date(t); return `句子 ${d.getMonth() + 1}/${d.getDate()}`; };
      const groups = new Map();
      for (const s of list){ const g = mode === 'name' ? name : day(s.createdAt); (groups.get(g) ?? groups.set(g, []).get(g)).push(s.hash); }
      const preview = [...groups].map(([n, hs]) => ({ name: n, count: hs.length, exists: Boolean(cache.articleByName(n)) }));
      if (b.confirm !== true) return sendJson(res, 200, { total: list.length, groups: preview });
      let added = 0;
      for (const [n, hs] of groups){
        const hit = cache.articleByName(n);
        added += cache.saveArticle({ name: n, appendTo: hit?.id ?? null, items: hs.map(hash => ({ para: 0, hash })) }).added;
      }
      return sendJson(res, 200, { ok: true, added, groups: preview });
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
