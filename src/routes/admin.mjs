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
  // ---- 字表編修：看單字、移動到別份（或新字表）、移除、合併 ----
  { match: (req, url) => url.pathname === '/api/admin/wordset-words' && req.method === 'GET', handler: async (req, res, url) => {
      if (teacherOnly(req, res, url)) return;
      const id = Number(url.searchParams.get('id'));
      if (!cache.wordsets('student').some(s => s.id === id)) return sendJson(res, 404, { error: 'not-found', message: '找不到這份字表。' });
      return sendJson(res, 200, { id, words: cache.wordsetWords(id) });
    } },
  // 移動：to 是既有字表 id，或 newName 建新字表。目標已有同字的跳過、留在原處
  { match: (req, url) => url.pathname === '/api/admin/wordset-move' && req.method === 'POST', handler: async (req, res, url) => {
      if (teacherOnly(req, res, url)) return;
      const b = await body(req), from = Number(b.from), sets = cache.wordsets('student');
      const wordIds = (Array.isArray(b.wordIds) ? b.wordIds : []).map(Number).filter(Number.isInteger).slice(0, 500);
      if (!sets.some(s => s.id === from)) return sendJson(res, 404, { error: 'not-found', message: '找不到來源字表。' });
      if (!wordIds.length) return sendJson(res, 400, { error: 'no-words', message: '請先勾選要移動的單字。' });
      let to = Number(b.to), created = false;
      if (b.newName !== undefined){
        const name = String(b.newName).trim().slice(0, 60);
        if (!name) return sendJson(res, 400, { error: 'no-name', message: '新字表要有名稱。' });
        to = cache.createWordset(name, [], String(b.note ?? '').trim().slice(0, 200) || null); created = true;
      } else if (!sets.some(s => s.id === to)) return sendJson(res, 404, { error: 'not-found', message: '找不到目標字表。' });
      if (to === from) return sendJson(res, 400, { error: 'same-set', message: '來源和目標是同一份。' });
      const r = cache.moveWords(from, wordIds, to);
      if (created && !r.moved) cache.deleteWordset([to]);
      return sendJson(res, 200, { ok: true, to: created && !r.moved ? null : to, created: created && r.moved > 0, ...r });
    } },
  // 移除單字（連作答與熟練度）：先預覽，帶 confirm:true 才刪，先備份
  { match: (req, url) => url.pathname === '/api/admin/wordset-remove' && req.method === 'POST', handler: async (req, res, url) => {
      if (teacherOnly(req, res, url)) return;
      const b = await body(req), from = Number(b.from);
      const wordIds = (Array.isArray(b.wordIds) ? b.wordIds : []).map(Number).filter(Number.isInteger).slice(0, 500);
      if (!cache.wordsets('student').some(s => s.id === from)) return sendJson(res, 404, { error: 'not-found', message: '找不到這份字表。' });
      const preview = cache.removeWords(from, wordIds, { dryRun: true });
      if (!preview.words) return sendJson(res, 400, { error: 'no-words', message: '請先勾選要移除的單字。' });
      if (b.confirm !== true) return sendJson(res, 409, { error: 'confirm-required', message: '要先確認才會刪。', ...preview });
      const dir = join(dirname(DB_FILE), 'backups'); mkdirSync(dir, { recursive: true });
      const path = join(dir, `${basename(DB_FILE, '.db')}.before-delete-words-${new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14)}-${Math.random().toString(36).slice(2, 6)}.db`);
      cache.backupTo(path);
      const removed = cache.removeWords(from, wordIds);
      try { const mine = readdirSync(dir).filter(x => x.includes('.before-delete-')).sort(); for (const old of mine.slice(0, Math.max(0, mine.length - 10))) unlinkSync(join(dir, old)); } catch {}
      return sendJson(res, 200, { ok: true, removed, backup: basename(path) });
    } },
  // 合併：把 from 們的單字全部移進 into，空了的來源字表刪掉；同字衝突的留在來源（來源不刪）
  { match: (req, url) => url.pathname === '/api/admin/wordset-merge' && req.method === 'POST', handler: async (req, res, url) => {
      if (teacherOnly(req, res, url)) return;
      const b = await body(req), into = Number(b.into), sets = cache.wordsets('student');
      const from = [...new Set((Array.isArray(b.from) ? b.from : []).map(Number).filter(n => Number.isInteger(n) && n !== into))].slice(0, 50);
      if (!sets.some(s => s.id === into) || !from.length || !from.every(id => sets.some(s => s.id === id)))
        return sendJson(res, 404, { error: 'not-found', message: '找不到要合併的字表。' });
      let moved = 0, kept = [], deleted = 0;
      for (const id of from){
        const r = cache.moveWords(id, cache.wordsetWords(id).map(w => w.id), into);
        moved += r.moved;
        if (r.skipped.length) kept.push(...r.skipped);
        else deleted += cache.deleteWordset([id]);
      }
      return sendJson(res, 200, { ok: true, moved, deleted, kept });
    } },
  // ---- 文章表編修：看句子、移動（拆分）、移除、調順序、合併 ----
  { match: (req, url) => url.pathname === '/api/admin/article-sentences' && req.method === 'GET', handler: async (req, res, url) => {
      if (teacherOnly(req, res, url)) return;
      const id = Number(url.searchParams.get('id'));
      if (!cache.getArticle(id)) return sendJson(res, 404, { error: 'not-found', message: '找不到這份文章表。' });
      return sendJson(res, 200, { id, sentences: cache.articleSentences(id) });
    } },
  { match: (req, url) => url.pathname === '/api/admin/article-move' && req.method === 'POST', handler: async (req, res, url) => {
      if (teacherOnly(req, res, url)) return;
      const b = await body(req), from = Number(b.from);
      const hashes = (Array.isArray(b.hashes) ? b.hashes : []).map(String).slice(0, 500);
      if (!cache.getArticle(from)) return sendJson(res, 404, { error: 'not-found', message: '找不到來源文章表。' });
      if (!hashes.length) return sendJson(res, 400, { error: 'no-sentences', message: '請先勾選要移動的句子。' });
      let to = Number(b.to), created = false;
      if (b.newName !== undefined){
        const name = String(b.newName).trim().slice(0, 60);
        if (!name) return sendJson(res, 400, { error: 'no-name', message: '新文章表要有名稱。' });
        const dup = cache.articleByName(name);
        if (dup) return sendJson(res, 409, { error: 'name-taken', message: `已經有一份文章表叫「${dup.name}」，換個名稱。` });
        to = cache.saveArticle({ name, items: [] }).id; created = true;
      } else if (!cache.getArticle(to)) return sendJson(res, 404, { error: 'not-found', message: '找不到目標文章表。' });
      if (to === from) return sendJson(res, 400, { error: 'same-set', message: '來源和目標是同一份。' });
      const r = cache.moveArticleItems(from, hashes, to);
      if (created && !r.moved) cache.deleteArticles([to]);
      return sendJson(res, 200, { ok: true, to: created && !r.moved ? null : to, created: created && r.moved > 0, ...r });
    } },
  // 移除句子：先預覽（會有幾句變成「沒有範圍」），帶 confirm:true 才動。句子分析留在句子庫，不用備份
  { match: (req, url) => url.pathname === '/api/admin/article-remove' && req.method === 'POST', handler: async (req, res, url) => {
      if (teacherOnly(req, res, url)) return;
      const b = await body(req), from = Number(b.from);
      const hashes = (Array.isArray(b.hashes) ? b.hashes : []).map(String).slice(0, 500);
      if (!cache.getArticle(from)) return sendJson(res, 404, { error: 'not-found', message: '找不到這份文章表。' });
      const preview = cache.removeArticleItems(from, hashes, { dryRun: true });
      if (!preview.sentences) return sendJson(res, 400, { error: 'no-sentences', message: '請先勾選要移除的句子。' });
      if (b.confirm !== true) return sendJson(res, 409, { error: 'confirm-required', message: '要先確認才會移除。', ...preview });
      return sendJson(res, 200, { ok: true, removed: cache.removeArticleItems(from, hashes) });
    } },
  // 調順序：hashes 是新的完整順序
  { match: (req, url) => url.pathname === '/api/admin/article-reorder' && req.method === 'POST', handler: async (req, res, url) => {
      if (teacherOnly(req, res, url)) return;
      const b = await body(req);
      if (!cache.getArticle(Number(b.id))) return sendJson(res, 404, { error: 'not-found', message: '找不到這份文章表。' });
      if (!cache.reorderArticle(Number(b.id), b.hashes)) return sendJson(res, 400, { error: 'bad-order', message: '順序和現有的句子對不上，請重新整理。' });
      return sendJson(res, 200, { ok: true });
    } },
  // 合併：from 們的句子全部接進 into，來源文章表刪除（同句已在 into 的略過）
  { match: (req, url) => url.pathname === '/api/admin/article-merge' && req.method === 'POST', handler: async (req, res, url) => {
      if (teacherOnly(req, res, url)) return;
      const b = await body(req), into = Number(b.into);
      const from = [...new Set((Array.isArray(b.from) ? b.from : []).map(Number).filter(n => Number.isInteger(n) && n !== into))].slice(0, 50);
      if (!cache.getArticle(into) || !from.length || !from.every(id => cache.getArticle(id)))
        return sendJson(res, 404, { error: 'not-found', message: '找不到要合併的文章表。' });
      let moved = 0, dup = 0;
      for (const id of from){
        const r = cache.moveArticleItems(id, cache.articleSentences(id).map(x => x.hash), into);
        moved += r.moved; dup += r.skipped;
      }
      const deleted = cache.deleteArticles(from);
      return sendJson(res, 200, { ok: true, moved, duplicates: dup, deleted });
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
