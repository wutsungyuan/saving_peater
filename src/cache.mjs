// 逐句快取。key = 正規化後句子的 SHA-256，所以同一句出現在不同文章裡也能命中。
// 用 node:sqlite（Node 22 內建，零依賴）。

import { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { normalize } from './segment.mjs';
import { migrate } from './migrate.mjs';

/** 單字熟練度（Leitner 盒子）的推進規則。
 *  拼寫類題型（看中文拼、聽寫、克漏字、動詞變化）要自己寫出來才算會，答對才能一路升到最高盒；
 *  認得類題型（英選中、詞義辨析）有選項可以猜、看過就認得，答對最多只推到 RECOG_CAP 盒，
 *  不會因為選擇題做多了就被當成「已背熟」（筆試考的是拼寫）。答錯一律回到第 0 盒。 */
export const SPELL_MODES = ['zh2en', 'listen', 'cloze', 'forms'];
export const RECOG_CAP = 2;
export const RECOG_MODES = ['en2zh', 'sense'];
/** 統計卡「最近」的視窗：會拼、認得各自最近這麼多次作答 */
export const RECENT_N = 100;
export const BOX_MAX = 5;
export function nextBox(box, mode, correct){
  if (!correct) return 0;
  if (SPELL_MODES.includes(mode)) return Math.min(box + 1, BOX_MAX);
  return Math.max(box, Math.min(box + 1, RECOG_CAP));
}

const hashOf = (sentence) =>
  createHash('sha256').update(normalize(sentence), 'utf8').digest('hex');

/** 把存起來的「A: 內容」拆成 { speaker, text }。多行就取第一行當代表。 */
function parseContext(raw){
  const line = String(raw).split('\n')[0].trim();
  const m = /^([A-Za-z][A-Za-z]{0,9})\s*[:：]\s*(.+)$/.exec(line);
  return m ? { speaker: m[1], text: m[2] } : { speaker: '', text: line };
}

let _verbFormsCache = null, _verbFormsCount = -1;

export function openCache(file = 'data/cache.db'){
  mkdirSync(dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec('PRAGMA journal_mode = WAL;');
  migrate(db, { file });

  const qGet  = db.prepare('SELECT result FROM sentences WHERE hash = ?');
  const qHit  = db.prepare('UPDATE sentences SET hits = hits + 1 WHERE hash = ?');
  const qPut  = db.prepare(`INSERT OR REPLACE INTO sentences
    (hash, original, result, model, pattern_id, tense_time, tense_aspect, in_scope, issue, created_at, hits,
     input_tokens, output_tokens, cost_usd, speaker, context)
    VALUES (?,?,?,?,?,?,?,?,?,?, COALESCE((SELECT hits FROM sentences WHERE hash = ?), 0), ?,?,?,?,?)`);
  const qLog  = db.prepare(`INSERT INTO requests
    (chars, sentences, cached, analyzed, ms, created_at, kind, ref_id, text,
     input_tokens, output_tokens, cache_read_tokens, cost_usd, by_role)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
  const qStats = db.prepare(`SELECT
      (SELECT COUNT(*) FROM sentences) AS sentences,
      (SELECT COALESCE(SUM(hits),0) FROM sentences) AS cache_hits,
      (SELECT COUNT(*) FROM requests) AS requests`);
  const qPatterns = db.prepare(`SELECT pattern_id, COUNT(*) n FROM sentences
    WHERE pattern_id IS NOT NULL GROUP BY pattern_id ORDER BY pattern_id`);
  const qTenses = db.prepare(`SELECT tense_time, tense_aspect, COUNT(*) n FROM sentences
    WHERE tense_time IS NOT NULL GROUP BY tense_time, tense_aspect ORDER BY n DESC`);

  return {
    db,
    get(sentence){
      const h = hashOf(sentence);
      const row = qGet.get(h);
      if (!row) return null;
      qHit.run(h);
      try { return JSON.parse(row.result); } catch { return null; }
    },
    /** 只問「有沒有」，不算命中。報價用，不能污染 hits。 */
    has(sentence){ return Boolean(qGet.get(hashOf(sentence))); },
    /** 取分析結果但不算命中（出題、報價用，不能污染 hits） */
    peek(sentence){
      const row = qGet.get(hashOf(sentence));
      if (!row) return null;
      try { return JSON.parse(row.result); } catch { return null; }
    },
    /** 依最近的分析紀錄估每句的花費與時間；沒有足夠紀錄就用預設值。
     *  只取一次分析 5 句以上的紀錄：單句那種常是冷快取，會把平均拉高。 */
    analysisUnitCost(){
      const r = db.prepare(`SELECT SUM(cost_usd) c, SUM(analyzed) n, SUM(ms) ms FROM (
          SELECT cost_usd, analyzed, ms FROM requests
          WHERE kind = 'analyze' AND analyzed >= 5 AND cost_usd > 0 ORDER BY id DESC LIMIT 20)`).get();
      return r?.n >= 5
        ? { perSentence: r.c / r.n, msPerSentence: r.ms / r.n, samples: r.n, source: 'history' }
        : { perSentence: 0.035, msPerSentence: 8000, samples: 0, source: 'default' };
    },
    /** 依最近的出題紀錄估每題花費與時間（kind='paper-gen'，analyzed 欄位記入庫題數）；紀錄不夠就回 null，由呼叫端用預設值 */
    paperGenUnit(){
      const r = db.prepare(`SELECT SUM(cost_usd) c, SUM(analyzed) n, SUM(ms) ms, COUNT(*) calls FROM (
          SELECT cost_usd, analyzed, ms FROM requests
          WHERE kind = 'paper-gen' AND analyzed >= 3 AND cost_usd > 0 ORDER BY id DESC LIMIT 20)`).get();
      if (!(r?.n >= 5)) return null;
      return { perCall: Math.min(0.05, r.c / r.calls * 0.15), perQuestion: r.c / r.n * 0.85, msPerCall: 8000, msPerQuestion: r.ms / r.n, samples: r.n, source: 'history' };
    },
    // ---------- 登入 session（只存雜湊）----------
    createSession(idHash, days, role = 'teacher'){
      const now = Date.now();
      db.prepare('INSERT OR REPLACE INTO sessions (id, created_at, expires_at, role) VALUES (?,?,?,?)').run(idHash, now, now + days * 86400_000, role);
    },
    /** 有效的 session 回傳角色（teacher | student），沒有或過期回 null */
    sessionRole(idHash){
      const r = db.prepare('SELECT expires_at, role FROM sessions WHERE id = ?').get(idHash);
      return r && r.expires_at > Date.now() ? r.role : null;
    },
    sessionValid(idHash){ return this.sessionRole(idHash) !== null; },
    deleteSession(idHash){ db.prepare('DELETE FROM sessions WHERE id = ?').run(idHash); },
    pruneSessions(){ return db.prepare('DELETE FROM sessions WHERE expires_at <= ?').run(Date.now()).changes; },

    /** AI 批改的單價（依最近的紀錄）；紀錄不夠回 null */
    paperGradeUnit(){
      const r = db.prepare(`SELECT SUM(cost_usd) c, SUM(analyzed) n, COUNT(*) calls FROM (
          SELECT cost_usd, analyzed FROM requests WHERE kind = 'paper-grade' AND analyzed >= 1 AND cost_usd > 0 ORDER BY id DESC LIMIT 20)`).get();
      if (!(r?.n >= 5)) return null;
      return { perCall: Math.min(0.05, r.c / r.calls * 0.4), perItem: Math.max(0.002, (r.c / r.calls * 0.6) / (r.n / r.calls)) };
    },
    put(sentence, result, model, usage = {}, meta = {}){
      const h = hashOf(sentence);
      const main = result?.clauses?.find(c => c.role === 'main') ?? result?.clauses?.[0];
      qPut.run(h, sentence, JSON.stringify(result), model,
        main?.pattern?.id ?? null, main?.tense?.time ?? null, main?.tense?.aspect ?? null,
        result?.inScope === false ? 0 : 1, result?.issue ?? null, Date.now(), h,
        usage.inputTokens ?? 0, usage.outputTokens ?? 0, usage.costUsd ?? 0,
        meta.speaker ?? null, meta.context ?? null);
    },
    log(row){
      qLog.run(row.chars, row.sentences, row.cached, row.analyzed, row.ms, Date.now(),
        row.kind ?? 'analyze', row.refId ?? null, row.text ?? null,
        row.inputTokens ?? 0, row.outputTokens ?? 0,
        row.cacheReadTokens ?? 0, row.costUsd ?? 0, row.byRole ?? null);
    },
    /** 學生今天（本機時間）已經辨識了幾張照片（句子與單字表都算） */
    studentOcrToday(){
      const d = new Date(); d.setHours(0, 0, 0, 0);
      return Number(db.prepare("SELECT COUNT(*) n FROM requests WHERE kind IN ('ocr-text','ocr') AND by_role = 'student' AND created_at >= ?").get(d.getTime()).n);
    },

    /** 分析歷史：最近幾次請求 */
    history(limit = 30){
      // 不濾掉 text 為空的 —— 原文過期清掉後，用量紀錄仍要看得到
      return db.prepare(`SELECT r.id, COALESCE(r.kind,'analyze') kind, r.ref_id,
          r.chars, r.sentences, r.cached, r.analyzed, r.ms, r.created_at,
          substr(r.text, 1, 300) preview, length(r.text) full_len,
          r.input_tokens, r.output_tokens, r.cache_read_tokens, r.cost_usd,
          (w.id IS NOT NULL) AS ref_alive      -- 字表是否還在（可能已被刪除）
        FROM requests r LEFT JOIN wordsets w ON w.id = r.ref_id
        ORDER BY r.created_at DESC LIMIT ?`).all(limit);
    },
    historyText(id){
      return db.prepare('SELECT text FROM requests WHERE id = ?').get(id)?.text ?? null;
    },
    /** 用量累計：今天 / 本月 / 全部 */
    usageSummary(){
      const q = since => db.prepare(`SELECT COUNT(*) requests,
          COALESCE(SUM(sentences),0) sentences, COALESCE(SUM(analyzed),0) analyzed,
          COALESCE(SUM(cached),0) cached, COALESCE(SUM(input_tokens),0) input_tokens,
          COALESCE(SUM(output_tokens),0) output_tokens,
          COALESCE(SUM(cache_read_tokens),0) cache_read_tokens,
          COALESCE(SUM(cost_usd),0) cost_usd
        FROM requests WHERE created_at >= ?`).get(since);
      const d = new Date(); d.setHours(0,0,0,0);
      const m = new Date(); m.setDate(1); m.setHours(0,0,0,0);
      return { today: q(d.getTime()), month: q(m.getTime()), all: q(0) };
    },
    /** 定時清理：刪掉超過天數的歷史原文（分析快取本身不動，那是重複利用的資產） */
    pruneHistory(days){
      const cutoff = Date.now() - days * 86400_000;
      const n = db.prepare('SELECT COUNT(*) n FROM requests WHERE created_at < ? AND text IS NOT NULL').get(cutoff).n;
      db.prepare('UPDATE requests SET text = NULL WHERE created_at < ?').run(cutoff);
      return n;
    },

    recordAttempt(a){
      db.prepare(`INSERT INTO attempts
        (user_token,qtype,sentence_hash,pattern_id,tense_time,tense_aspect,pos,pron_case,correct,is_fix,answer,expected,created_at,source)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
        a.userToken, a.qtype, a.sentenceHash ?? null, a.patternId ?? null,
        a.tenseTime ?? null, a.tenseAspect ?? null, a.pos ?? null, a.pronCase ?? null,
        a.correct ? 1 : 0, a.isFix ? 1 : 0, a.answer ?? null, a.expected ?? null, Date.now(), a.source ?? 'practice');
    },

    // ---------- 申請單（花費關卡）----------
    createJob(j){
      db.prepare(`INSERT INTO jobs (id, kind, status, dedup, payload, quote, summary, requested_by, created_at)
        VALUES (?,?,?,?,?,?,?,?,?)`).run(j.id, j.kind, 'pending', j.dedup ?? null, JSON.stringify(j.payload ?? {}),
        j.quote ? JSON.stringify(j.quote) : null, j.summary ?? null, j.by, Date.now());
    },
    getJob(id){
      const r = db.prepare('SELECT * FROM jobs WHERE id = ?').get(String(id));
      return r ? this._job(r) : null;
    },
    _job(r){
      return { id: r.id, kind: r.kind, status: r.status, dedup: r.dedup, payload: JSON.parse(r.payload), quote: r.quote ? JSON.parse(r.quote) : null,
        summary: r.summary, by: r.requested_by, note: r.note, result: r.result ? JSON.parse(r.result) : null, costUsd: r.cost_usd,
        createdAt: r.created_at, decidedAt: r.decided_at, startedAt: r.started_at, finishedAt: r.finished_at };
    },
    /** 列出申請單。statuses：只看這些狀態；by：只看某人的；新的在前 */
    jobs({ statuses = null, by = null, limit = 50 } = {}){
      const where = [], p = [];
      if (statuses?.length){ where.push(`status IN (${statuses.map(() => '?').join(',')})`); p.push(...statuses); }
      if (by){ where.push('requested_by = ?'); p.push(by); }
      return db.prepare(`SELECT * FROM jobs ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY created_at DESC LIMIT ?`)
        .all(...p, limit).map(r => this._job(r));
    },
    pendingJobByDedup(dedup){
      const r = db.prepare("SELECT * FROM jobs WHERE dedup = ? AND status IN ('pending','approved','running') ORDER BY created_at DESC LIMIT 1").get(dedup);
      return r ? this._job(r) : null;
    },
    countJobs(status){ return Number(db.prepare('SELECT COUNT(*) n FROM jobs WHERE status = ?').get(status).n); },
    /** 更新欄位（只允許這幾個）：status note result costUsd decidedAt startedAt finishedAt payload */
    updateJob(id, f){
      const map = { status: 'status', note: 'note', costUsd: 'cost_usd', decidedAt: 'decided_at', startedAt: 'started_at', finishedAt: 'finished_at' };
      const sets = [], p = [];
      for (const [k, col] of Object.entries(map)) if (k in f){ sets.push(`${col} = ?`); p.push(f[k]); }
      if ('result' in f){ sets.push('result = ?'); p.push(f.result == null ? null : JSON.stringify(f.result)); }
      if ('payload' in f){ sets.push('payload = ?'); p.push(JSON.stringify(f.payload)); }
      if (!sets.length) return 0;
      return Number(db.prepare(`UPDATE jobs SET ${sets.join(', ')} WHERE id = ?`).run(...p, String(id)).changes);
    },
    /** 太舊的、已經結束的申請單清掉（保留天數內的都留著給老師回頭看） */
    pruneJobs(days = 60){
      return Number(db.prepare("DELETE FROM jobs WHERE status IN ('done','failed','rejected','cancelled') AND created_at < ?").run(Date.now() - days * 86400_000).changes);
    },

    // ---------- 句子管理（老師後台）----------
    /** 被排除出題的句子 hash 集合（測驗卷的素材池用） */
    excludedHashes(){ return new Set(db.prepare('SELECT hash FROM sentences WHERE excluded = 1').all().map(r => r.hash)); },
    /** 列出已分析的句子。q：比對原文與翻譯；filter：all | excluded | issue（有問題：無法分析或有錯誤標註）| outscope（超出範圍）| unused（沒有被任何文章用到） */
    sentenceList({ q = '', filter = 'all', limit = 50, offset = 0 } = {}){
      const where = [], p = [];
      if (q){ where.push('(s.original LIKE ? OR s.result LIKE ?)'); p.push('%' + q + '%', '%' + q + '%'); }
      if (filter === 'excluded') where.push('s.excluded = 1');
      else if (filter === 'issue') where.push("(s.issue IS NOT NULL OR s.result LIKE '%\"type\":\"error\"%')");
      else if (filter === 'outscope') where.push('s.in_scope = 0');
      else if (filter === 'unused') where.push('NOT EXISTS (SELECT 1 FROM article_items i WHERE i.hash = s.hash)');
      const W = where.length ? 'WHERE ' + where.join(' AND ') : '';
      const total = Number(db.prepare(`SELECT COUNT(*) n FROM sentences s ${W}`).get(...p).n);
      const rows = db.prepare(`SELECT s.hash, s.original, s.result, s.pattern_id, s.tense_time, s.tense_aspect, s.in_scope, s.issue, s.speaker,
          s.hits, s.created_at, s.excluded, s.model,
          (SELECT COUNT(*) FROM article_items i WHERE i.hash = s.hash) used
        FROM sentences s ${W} ORDER BY s.created_at DESC, s.hash LIMIT ? OFFSET ?`).all(...p, limit, offset);
      return { total, items: rows.map(r => {
        let tr = '', errors = 0;
        try { const d = JSON.parse(r.result); tr = d.translation ?? ''; errors = (d.notes ?? []).filter(n => n.type === 'error').length; } catch {}
        return { hash: r.hash, original: r.original, translation: tr, patternId: r.pattern_id, tense: r.tense_time ? `${r.tense_time}-${r.tense_aspect}` : null,
          inScope: r.in_scope == null ? null : Boolean(r.in_scope), issue: r.issue, errors, speaker: r.speaker, hits: r.hits, createdAt: r.created_at,
          excluded: Boolean(r.excluded), model: r.model, usedInArticles: Number(r.used) };
      }) };
    },
    /** 還沒歸進任何文章表（沒有範圍）、而且分析成功的句子，依分析時間排。q 比對原文與翻譯（和 sentenceList 一樣）。 */
    unassignedSentences(q = ''){
      const p = [];
      let w = 'issue IS NULL AND NOT EXISTS (SELECT 1 FROM article_items i WHERE i.hash = s.hash)';
      if (q){ w += ' AND (s.original LIKE ? OR s.result LIKE ?)'; p.push('%' + q + '%', '%' + q + '%'); }
      return db.prepare(`SELECT s.hash, s.created_at FROM sentences s WHERE ${w} ORDER BY s.created_at, s.hash`).all(...p)
        .map(r => ({ hash: r.hash, createdAt: r.created_at }));
    },
    sentenceRow(hash){ return db.prepare('SELECT * FROM sentences WHERE hash = ?').get(String(hash)) ?? null; },
    /** 這一句被哪些文章表用到 */
    sentenceUsage(hash){
      return db.prepare(`SELECT DISTINCT a.id, a.name FROM article_items i JOIN articles a ON a.id = i.article_id WHERE i.hash = ? ORDER BY a.name`).all(String(hash));
    },
    setSentenceExcluded(hash, flag){ return Number(db.prepare('UPDATE sentences SET excluded = ? WHERE hash = ?').run(flag ? 1 : 0, String(hash)).changes); },
    /** 刪除一句。被文章表用到的不能刪（文章會缺句），回 { error:'in-use', articles } */
    deleteSentence(hash){
      const used = this.sentenceUsage(hash);
      if (used.length) return { error: 'in-use', articles: used };
      return { deleted: Number(db.prepare('DELETE FROM sentences WHERE hash = ?').run(String(hash)).changes) };
    },
    /** 重新分析前先把舊的拿掉；失敗時用 restoreSentenceRow 放回去 */
    removeSentenceRow(hash){ db.prepare('DELETE FROM sentences WHERE hash = ?').run(String(hash)); },
    restoreSentenceRow(row){
      const cols = Object.keys(row);
      db.prepare(`INSERT OR REPLACE INTO sentences (${cols.join(',')}) VALUES (${cols.map(() => '?').join(',')})`).run(...cols.map(c => row[c]));
    },

    // ---------- 學生練習紀錄的整理（老師後台）----------
    /** 條件 → 各表的 WHERE。f：{ kind: all|practice|quiz|exam, from, to（毫秒；to 不含）, setIds }。
     *  只動學生的紀錄：user_token 不是 'teacher'（老師自己試用的不算）。
     *  句子作答（attempts）只有 practice 與 exam 兩種來源，單字作答（word_attempts）只有 quiz 與 exam。 */
    _recWhere(table, f){
      const sentence = table === 'attempts';
      const applies = f.kind === 'all' || f.kind === 'exam' || f.kind === (sentence ? 'practice' : 'quiz');
      if (!applies) return null;
      const w = ["user_token != 'teacher'"], p = [];
      if (f.kind !== 'all'){ w.push('source = ?'); p.push(f.kind); }
      if (f.from){ w.push('created_at >= ?'); p.push(f.from); }
      if (f.to){ w.push('created_at < ?'); p.push(f.to); }
      if (!sentence && f.setIds?.length){ w.push(`word_id IN (SELECT id FROM words WHERE set_id IN (${f.setIds.map(() => '?').join(',')}))`); p.push(...f.setIds); }
      return { sql: w.join(' AND '), p };
    },
    recordsCount(f){
      const n = (table) => { const c = this._recWhere(table, f); return c ? Number(db.prepare(`SELECT COUNT(*) n FROM ${table} WHERE ${c.sql}`).get(...c.p).n) : 0; };
      let progress = 0;
      if (f.resetProgress){
        const w = ["user_token != 'teacher'"], p = [];
        if (f.setIds?.length){ w.push(`word_id IN (SELECT id FROM words WHERE set_id IN (${f.setIds.map(() => '?').join(',')}))`); p.push(...f.setIds); }
        progress = Number(db.prepare(`SELECT COUNT(*) n FROM word_progress WHERE ${w.join(' AND ')}`).get(...p).n);
      }
      return { attempts: n('attempts'), wordAttempts: n('word_attempts'), progress };
    },
    /** 刪除（一個交易）。呼叫前要先備份。回傳實際刪掉的筆數。 */
    deleteRecords(f){
      db.exec('BEGIN');
      try {
        const del = (table) => { const c = this._recWhere(table, f); return c ? Number(db.prepare(`DELETE FROM ${table} WHERE ${c.sql}`).run(...c.p).changes) : 0; };
        const attempts = del('attempts'), wordAttempts = del('word_attempts');
        let progress = 0;
        if (f.resetProgress){
          const w = ["user_token != 'teacher'"], p = [];
          if (f.setIds?.length){ w.push(`word_id IN (SELECT id FROM words WHERE set_id IN (${f.setIds.map(() => '?').join(',')}))`); p.push(...f.setIds); }
          progress = Number(db.prepare(`DELETE FROM word_progress WHERE ${w.join(' AND ')}`).run(...p).changes);
        }
        db.exec('COMMIT');
        return { attempts, wordAttempts, progress };
      } catch (e){ db.exec('ROLLBACK'); throw e; }
    },
    /** 備份整個資料庫到指定路徑（VACUUM INTO） */
    backupTo(path){ db.exec(`VACUUM INTO '${String(path).replace(/'/g, "''")}'`); return path; },
    audit(actor, action, detail){ db.prepare('INSERT INTO audit_log (created_at, actor, action, detail) VALUES (?,?,?,?)').run(Date.now(), actor, action, detail == null ? null : JSON.stringify(detail)); },
    auditList(limit = 20){ return db.prepare('SELECT id, created_at, actor, action, detail FROM audit_log ORDER BY created_at DESC, id DESC LIMIT ?').all(limit).map(r => ({ id: r.id, at: r.created_at, actor: r.actor, action: r.action, detail: r.detail ? JSON.parse(r.detail) : null })); },

    /** 作答紀錄用過哪些使用者代碼、各有多少作答、最早與最近一筆。合併舊代碼前先看這個。 */
    userTokens(){
      const m = new Map();
      const add = (rows, key) => { for (const r of rows){
        const x = m.get(r.user_token) ?? { token: r.user_token, sentences: 0, words: 0, first: null, last: null };
        x[key] += r.n; x.first = x.first == null ? r.first : Math.min(x.first, r.first); x.last = x.last == null ? r.last : Math.max(x.last, r.last);
        m.set(r.user_token, x); } };
      add(db.prepare('SELECT user_token, COUNT(*) n, MIN(created_at) first, MAX(created_at) last FROM attempts GROUP BY user_token').all(), 'sentences');
      add(db.prepare('SELECT user_token, COUNT(*) n, MIN(created_at) first, MAX(created_at) last FROM word_attempts GROUP BY user_token').all(), 'words');
      return [...m.values()].sort((a, b) => b.last - a.last);
    },

    /** 把幾個使用者代碼的紀錄合併成一個（例如手機與筆電各自產生的隨機代碼 → 'student'）。
     *  作答紀錄直接改名；單字熟練度同一個字有好幾筆時，盒子與到期日取練得最多的那筆，答對與作答次數相加。 */
    mergeUsers(target, from){
      const src = [...new Set(from)].filter(t => t && t !== target);
      if (!src.length) return { attempts: 0, wordAttempts: 0, progress: 0 };
      const ph = src.map(() => '?').join(',');
      db.exec('BEGIN');
      try {
        const a = db.prepare(`UPDATE attempts SET user_token = ? WHERE user_token IN (${ph})`).run(target, ...src).changes;
        const w = db.prepare(`UPDATE word_attempts SET user_token = ? WHERE user_token IN (${ph})`).run(target, ...src).changes;
        const rows = db.prepare(`SELECT user_token, word_id, box, due_at, correct, total FROM word_progress WHERE user_token IN (${ph}, ?)`).all(...src, target);
        const best = new Map();
        for (const r of rows){
          const x = best.get(r.word_id);
          if (!x) best.set(r.word_id, { ...r });
          else {
            const top = r.total > x.total ? r : x;
            best.set(r.word_id, { word_id: r.word_id, box: top.box, due_at: top.due_at, correct: x.correct + r.correct, total: x.total + r.total });
          }
        }
        db.prepare(`DELETE FROM word_progress WHERE user_token IN (${ph}, ?)`).run(...src, target);
        const ins = db.prepare('INSERT INTO word_progress (user_token, word_id, box, due_at, correct, total) VALUES (?,?,?,?,?,?)');
        for (const r of best.values()) ins.run(target, r.word_id, r.box, r.due_at, r.correct, r.total);
        db.exec('COMMIT');
        return { attempts: Number(a), wordAttempts: Number(w), progress: best.size };
      } catch (e){ db.exec('ROLLBACK'); throw e; }
    },

    /** 弱點統計：11 個維度（5 句型 + 6 必學時態）＋ 詞性與題型，加上單字面向與測驗卷成績。
     *  source：all | practice（句子練習）| quiz（單字測驗）| exam（測驗卷）。句子面向只看 attempts，單字面向只看 word_attempts。 */
    weakness(userToken, source = 'all'){
      const src = ['practice', 'quiz', 'exam'].includes(source) ? source : 'all';
      const C = src === 'all' ? '' : ' AND source = ?', P = src === 'all' ? [] : [src];
      const q = (sql, ...p) => db.prepare(sql).all(userToken, ...p, ...P);
      const one = sql => db.prepare(sql).get(userToken, ...P);
      const sent = one(`SELECT COUNT(*) total, COALESCE(SUM(correct),0) correct FROM attempts
          WHERE user_token = ? AND COALESCE(is_fix,0) = 0${C}`);
      const word = one(`SELECT COUNT(*) total, COALESCE(SUM(correct),0) correct FROM word_attempts
          WHERE user_token = ? AND COALESCE(is_fix,0) = 0${C}`);
      // 三個來源各自的作答數與正確率（不受篩選影響，總覽用）。測驗卷＝句子與單字兩邊 source='exam' 的加總。
      const cnt = (table, s) => db.prepare(`SELECT COUNT(*) total, COALESCE(SUM(correct),0) correct FROM ${table}
          WHERE user_token = ? AND COALESCE(is_fix,0) = 0 AND source = ?`).get(userToken, s);
      const ex = [cnt('attempts', 'exam'), cnt('word_attempts', 'exam')];
      const sources = { practice: cnt('attempts', 'practice'), quiz: cnt('word_attempts', 'quiz'),
        exam: { total: ex[0].total + ex[1].total, correct: ex[0].correct + ex[1].correct } };
      return {
        source: src,
        overall: { total: sent.total + word.total, correct: sent.correct + word.correct },
        sources,
        byType: q(`SELECT qtype, COUNT(*) total, SUM(correct) correct FROM attempts
          WHERE user_token = ? AND COALESCE(is_fix,0) = 0${C} GROUP BY qtype ORDER BY qtype`),
        byPattern: q(`SELECT pattern_id, COUNT(*) total, SUM(correct) correct FROM attempts
          WHERE user_token = ? AND COALESCE(is_fix,0) = 0${C} AND pattern_id IS NOT NULL
                      GROUP BY pattern_id ORDER BY pattern_id`),
        byTense: q(`SELECT tense_time, tense_aspect, COUNT(*) total, SUM(correct) correct FROM attempts
          WHERE user_token = ? AND COALESCE(is_fix,0) = 0${C} AND tense_time IS NOT NULL
                    GROUP BY tense_time, tense_aspect`),
        byPos: q(`SELECT pos, COUNT(*) total, SUM(correct) correct FROM attempts
          WHERE user_token = ? AND COALESCE(is_fix,0) = 0${C} AND pos IS NOT NULL GROUP BY pos ORDER BY pos`),
        byCase: q(`SELECT pron_case, COUNT(*) total, SUM(correct) correct FROM attempts
          WHERE user_token = ? AND COALESCE(is_fix,0) = 0${C} AND pron_case IS NOT NULL GROUP BY pron_case`),
        recent: q(`SELECT qtype, correct, answer, expected,
                     datetime(created_at/1000,'unixepoch','localtime') t
                   FROM attempts
          WHERE user_token = ? AND COALESCE(is_fix,0) = 0${C} ORDER BY created_at DESC LIMIT 20`),
        words: {
          ...word,
          byMode: q(`SELECT mode, COUNT(*) total, SUM(correct) correct FROM word_attempts
            WHERE user_token = ? AND COALESCE(is_fix,0) = 0${C} GROUP BY mode ORDER BY mode`),
          // 同一個字出現在多份字表時合併計算；至少作答 2 次才排進最弱的字
          weakest: q(`SELECT lower(w.term) term, COUNT(*) total, SUM(a.correct) correct
            FROM word_attempts a JOIN words w ON w.id = a.word_id
            WHERE a.user_token = ? AND COALESCE(a.is_fix,0) = 0${C.replace('source', 'a.source')}
            GROUP BY lower(w.term) HAVING COUNT(*) >= 2
            ORDER BY CAST(SUM(a.correct) AS REAL) / COUNT(*), COUNT(*) DESC, lower(w.term) LIMIT 10`),
          bySet: q(`SELECT s.name, COUNT(*) total, SUM(a.correct) correct
            FROM word_attempts a JOIN words w ON w.id = a.word_id JOIN wordsets s ON s.id = w.set_id
            WHERE a.user_token = ? AND COALESCE(a.is_fix,0) = 0${C.replace('source', 'a.source')}
            GROUP BY s.id ORDER BY s.created_at DESC`),
        },
        papers: src === 'all' || src === 'exam' ? this.paperSummary() : null,
      };
    },

    /** 測驗卷成績：最近幾份的分數，以及各題型累計得分率。卷子是快取（預設保留 30 天、最近 20 份），所以是「近期」。 */
    paperSummary(limit = 10){
      const rows = db.prepare(`SELECT id, score, submitted_at, n, settings, data FROM papers
          WHERE status = 'submitted' ORDER BY submitted_at DESC LIMIT ?`).all(limit)
        .map(r => ({ ...r, settings: JSON.parse(r.settings), data: JSON.parse(r.data) }))
        .filter(r => r.settings.kind !== 'fix');                 // 訂正卷不算成績
      const bySection = new Map();
      for (const r of rows)
        for (const s of r.data.result?.bySection ?? []){
          const x = bySection.get(s.name) ?? { name: s.name, score: 0, total: 0 };
          x.score += s.score; x.total += s.total; bySection.set(s.name, x);
        }
      return {
        trend: rows.map(r => ({ id: r.id, at: r.submitted_at, score: r.score, n: r.n, difficulty: r.settings.difficultyName ?? '' })).reverse(),
        bySection: [...bySection.values()],
      };
    },

    /** 各維度的正確率，給出題加權用。沒作答過的維度回 null（視為中性） */
    accuracyMap(userToken){
      const toMap = (rows, key) => Object.fromEntries(rows
        .filter(r => r.total >= 2)                       // 樣本太少不足以判斷強弱
        .map(r => [key(r), r.correct / r.total]));
      const q = sql => db.prepare(sql).all(userToken);
      return {
        patterns: toMap(q(`SELECT pattern_id, COUNT(*) total, SUM(correct) correct FROM attempts
          WHERE user_token = ? AND COALESCE(is_fix,0) = 0 AND pattern_id IS NOT NULL GROUP BY pattern_id`), r => r.pattern_id),
        tenses: toMap(q(`SELECT tense_time, tense_aspect, COUNT(*) total, SUM(correct) correct FROM attempts
          WHERE user_token = ? AND COALESCE(is_fix,0) = 0 AND tense_time IS NOT NULL GROUP BY tense_time, tense_aspect`),
          r => `${r.tense_time}-${r.tense_aspect}`),
        pos: toMap(q(`SELECT pos, COUNT(*) total, SUM(correct) correct FROM attempts
          WHERE user_token = ? AND COALESCE(is_fix,0) = 0 AND pos IS NOT NULL GROUP BY pos`), r => r.pos),
        cases: toMap(q(`SELECT pron_case, COUNT(*) total, SUM(correct) correct FROM attempts
          WHERE user_token = ? AND COALESCE(is_fix,0) = 0 AND pron_case IS NOT NULL GROUP BY pron_case`), r => r.pron_case),
      };
    },

    /** 取出可出題的句子（之後 M4 可依弱點加權） */
    pickSentences(limit = 40, { articleIds } = {}){
      // articleIds 有值：只從這些文章表的句子抽（範圍）；沒給就是整個句子庫
      const ids = (articleIds ?? []).map(Number).filter(Number.isFinite);
      const scope = ids.length ? `AND hash IN (SELECT hash FROM article_items WHERE article_id IN (${ids.map(() => '?').join(',')}))` : '';
      return db.prepare(`SELECT hash, result, speaker, context FROM sentences
        WHERE issue IS NULL AND pattern_id IS NOT NULL AND excluded = 0 ${scope}
        ORDER BY RANDOM() LIMIT ?`).all(...ids, limit)
        .map(r => { try {
          const data = JSON.parse(r.result);
          // 對話題要把對方說的話一起帶出去，否則出題時看不出前後情境。
          // context 存的是「A: 內容」，說話者要從那一行拆出來，
          // 不能用 r.speaker —— 那是「這句」的說話者，不是對方的。
          if (r.context) data.context = parseContext(r.context);
          return { hash: r.hash, data };
        } catch { return null; } })
        .filter(Boolean);
    },

    // ---------- 單字表 ----------
    createWordset(name, words, note){
      const now = Date.now();
      db.exec('BEGIN');
      try {
        const r = db.prepare('INSERT INTO wordsets (name, note, created_at) VALUES (?,?,?)')
          .run(name, note ?? null, now);
        const setId = Number(r.lastInsertRowid);
        const ins = db.prepare(`INSERT OR REPLACE INTO words
          (set_id, idx, term, syllables, spell_tip, data) VALUES (?,?,?,?,?,?)`);
        words.forEach((w, i) => ins.run(setId, i, w.term, w.syllables ?? null, w.spellTip ?? null,
          JSON.stringify({ senses: w.senses ?? [], confusable: w.confusable ?? [], family: w.family ?? [] })));
        db.exec('COMMIT');
        return setId;
      } catch (e){ db.exec('ROLLBACK'); throw e; }
    },

    wordsets(userToken){
      return db.prepare(`SELECT s.id, s.name, s.note, s.created_at, s.hidden,
          (SELECT COUNT(*) FROM words w WHERE w.set_id = s.id) AS word_count,
          (SELECT COUNT(*) FROM words w JOIN word_progress p
             ON p.word_id = w.id AND p.user_token = ? WHERE w.set_id = s.id AND p.box >= 3) AS mastered
        FROM wordsets s ORDER BY s.created_at DESC, s.id DESC`).all(userToken);
    },

    /** 取出一份字表的所有單字，附上該使用者的進度 */
    /** 把單字加進既有字表。同一份裡已經有的字直接略過（不覆蓋已累積的進度）。 */
    appendWords(setId, words){
      const id = Number(setId);
      const have = new Set(db.prepare('SELECT term FROM words WHERE set_id = ?').all(id)
        .map(r => r.term.toLowerCase()));
      const fresh = words.filter(w => !have.has(String(w.term).toLowerCase()));
      if (!fresh.length) return { added: 0, skipped: words.length };
      let idx = (db.prepare('SELECT COALESCE(MAX(idx), -1) m FROM words WHERE set_id = ?').get(id).m) + 1;
      db.exec('BEGIN');
      try {
        const ins = db.prepare(`INSERT INTO words
          (set_id, idx, term, syllables, spell_tip, data) VALUES (?,?,?,?,?,?)`);
        for (const w of fresh)
          ins.run(id, idx++, w.term, w.syllables ?? null, w.spellTip ?? null,
            JSON.stringify({ senses: w.senses ?? [], confusable: w.confusable ?? [], family: w.family ?? [] }));
        db.exec('COMMIT');
      } catch (e){ db.exec('ROLLBACK'); throw e; }
      return { added: fresh.length, skipped: words.length - fresh.length };
    },

    /** 某份字表已經有哪些字（小寫），用來在呼叫模型之前先濾掉重複的 */
    termsOf(setId){
      return new Set(db.prepare('SELECT term FROM words WHERE set_id = ?').all(Number(setId))
        .map(r => r.term.toLowerCase()));
    },

    /** 可以一次吃多份字表 —— 複習時常常要跨單元一起練。
     *  多選時同一個字會合併成一張卡（詞義與例句取聯集，進度相加）。 */
    wordsOf(setIds, userToken){
      const ids = (Array.isArray(setIds) ? setIds : [setIds]).map(Number).filter(Number.isFinite);
      if (!ids.length) return [];
      const qs = ids.map(() => '?').join(',');
      const rows = db.prepare(`SELECT w.id, w.idx, w.set_id, w.term, w.syllables, w.spell_tip, w.data,
          COALESCE(p.box,0) box, COALESCE(p.due_at,0) due_at,
          COALESCE(p.correct,0) correct, COALESCE(p.total,0) total
        FROM words w LEFT JOIN word_progress p ON p.word_id = w.id AND p.user_token = ?
        WHERE w.set_id IN (${qs}) ORDER BY w.set_id, w.idx`).all(userToken, ...ids)
        .map(r => { const d = JSON.parse(r.data);
          return { id:r.id, idx:r.idx, setId:r.set_id, term:r.term, syllables:r.syllables,
                   spellTip:r.spell_tip, ...d,
                   box:r.box, dueAt:r.due_at, correct:r.correct, total:r.total }; });

      if (ids.length < 2) return rows;

      // 同一個字可能出現在多份字表（例如整頁的字表包含了小範圍那份）。
      // 單份內允許重複沒問題，但多選時要合併成一張卡：
      // 詞義與例句取聯集（不同字表可能給不同例句），作答次數相加、盒子取最前面的，
      // 這樣熟練度反映的是這個字被練了多少，和你選了幾份字表無關。
      const groups = new Map();
      for (const w of rows){
        const k = w.term.toLowerCase();
        groups.set(k, [...(groups.get(k) ?? []), w]);
      }
      const senseKey = sn => `${sn.pos}|${sn.zh}`;
      return [...groups.values()].map(g => {
        if (g.length === 1) return g[0];
        // 以練得最多的那筆當主體 —— 之後作答要記到某一個 word_id 上
        const main = g.reduce((a, b) =>
          (b.total > a.total || (b.total === a.total && b.box > a.box)) ? b : a);
        const senses = [], seen = new Set();
        for (const w of g) for (const sn of w.senses ?? [])
          if (!seen.has(senseKey(sn))){ seen.add(senseKey(sn)); senses.push(sn); }
        const uniq = (arr, f) => {
          const m = new Map();
          for (const x of arr) if (!m.has(f(x))) m.set(f(x), x);
          return [...m.values()];
        };
        // 進度直接用 main 那一筆，不相加 —— 作答會同步寫到所有重複的列，
        // 相加的話同一次作答會被算兩次。
        return { ...main, senses,
          confusable: uniq(g.flatMap(w => w.confusable ?? []), c => c.word),
          family:     uniq(g.flatMap(w => w.family ?? []),     c => c.word),
          mergedFrom: g.map(w => w.setId),
          mergedIds:  g.map(w => w.id) };
      });
    },

    /** 刪字表會連同該字表的作答與熟練度一起刪掉（同一個交易，要嘛全成要嘛全退）。
     *  句子分析快取不受影響 —— 那是以句子為單位，和字表無關。 */
    deleteWordset(setIds){
      const ids = (Array.isArray(setIds) ? setIds : [setIds]).map(Number).filter(Number.isFinite);
      if (!ids.length) return 0;
      const qs = ids.map(() => '?').join(',');
      db.exec('BEGIN');
      try {
        db.prepare(`DELETE FROM word_attempts WHERE word_id IN (SELECT id FROM words WHERE set_id IN (${qs}))`).run(...ids);
        db.prepare(`DELETE FROM word_progress WHERE word_id IN (SELECT id FROM words WHERE set_id IN (${qs}))`).run(...ids);
        db.prepare(`DELETE FROM words WHERE set_id IN (${qs})`).run(...ids);
        const r = db.prepare(`DELETE FROM wordsets WHERE id IN (${qs})`).run(...ids);
        db.exec('COMMIT');
        return r.changes;
      } catch (e){ db.exec('ROLLBACK'); throw e; }
    },

    /** 依新規則把歷史作答重播一遍，重算每個字的盒子（不動作答紀錄與 correct／total）。
     *  同一個字（不分大小寫）在多份字表的列合併成一條時間線，重算後寫回所有列。
     *  dryRun 只回傳統計，不寫入。 */
    recomputeWordProgress({ dryRun = false } = {}){
      const INTERVALS = [10*60e3, 60*60e3, 24*3600e3, 3*24*3600e3, 7*24*3600e3, 14*24*3600e3];
      const rows = db.prepare(`SELECT a.user_token u, lower(w.term) t, a.mode, a.correct, a.created_at
        FROM word_attempts a JOIN words w ON w.id = a.word_id
        WHERE COALESCE(a.is_fix,0) = 0 ORDER BY a.created_at, a.id`).all();
      const state = new Map();
      for (const r of rows){
        const k = r.u + '|' + r.t;
        const cur = state.get(k) ?? { u: r.u, t: r.t, box: 0, at: 0 };
        state.set(k, { ...cur, box: nextBox(cur.box, r.mode, r.correct), at: r.created_at });
      }
      const before = {}, after = {};
      const cnt = (m, v) => { m[v] = (m[v] ?? 0) + 1; };
      const cur = db.prepare('SELECT box FROM word_progress WHERE user_token = ? AND word_id = ?');
      const ids = db.prepare('SELECT id FROM words WHERE lower(term) = ?');
      const upd = db.prepare('UPDATE word_progress SET box = ?, due_at = ? WHERE user_token = ? AND word_id = ?');
      if (!dryRun) db.exec('BEGIN');
      try {
        for (const st of state.values()){
          for (const { id } of ids.all(st.t)){
            const c = cur.get(st.u, id);
            if (!c) continue;
            cnt(before, c.box); cnt(after, st.box);
            if (!dryRun) upd.run(st.box, st.at + INTERVALS[st.box], st.u, id);
          }
        }
        if (!dryRun) db.exec('COMMIT');
      } catch (e){ if (!dryRun) db.exec('ROLLBACK'); throw e; }
      const mastered = h => Object.entries(h).filter(([b]) => Number(b) >= 3).reduce((n, [, v]) => n + v, 0);
      return { before, after, masteredBefore: mastered(before), masteredAfter: mastered(after) };
    },

    /** 記錄單字作答並更新 Leitner 盒子 */
    recordWordAttempt(a){
      db.prepare(`INSERT INTO word_attempts
        (user_token, word_id, sense_idx, mode, correct, is_fix, answer, expected, created_at, source)
        VALUES (?,?,?,?,?,?,?,?,?,?)`).run(
        a.userToken, a.wordId, a.senseIdx ?? null, a.mode,
        a.correct ? 1 : 0, a.isFix ? 1 : 0, a.answer ?? null, a.expected ?? null, Date.now(), a.source ?? 'quiz');

      // 訂正是「把剛才那題做對」，答案都看過了，不該推進 Leitner 的盒子，
      // 也不該算進正確率 —— 否則答錯反而讓那個字更晚才再出現，整個反了。
      if (a.isFix) return;

      const INTERVALS = [10*60e3, 60*60e3, 24*3600e3, 3*24*3600e3, 7*24*3600e3, 14*24*3600e3];
      // 同一個字可能在多份字表各有一列。答對 lesson 就是答對 lesson，
      // 不該因為是從哪份字表考的而只更新其中一列，否則單看另一份會以為沒練過。
      const ids = (a.wordIds?.length ? a.wordIds : [a.wordId]).map(Number).filter(Number.isFinite);
      const qCur = db.prepare('SELECT box, correct, total FROM word_progress WHERE user_token = ? AND word_id = ?');
      const qSet = db.prepare(`INSERT OR REPLACE INTO word_progress
        (user_token, word_id, box, due_at, correct, total) VALUES (?,?,?,?,?,?)`);
      for (const wid of ids){
        const cur = qCur.get(a.userToken, wid) ?? { box: 0, correct: 0, total: 0 };
        const box = nextBox(cur.box, a.mode, a.correct);
        qSet.run(a.userToken, wid, box, Date.now() + INTERVALS[box],
          cur.correct + (a.correct ? 1 : 0), cur.total + 1);
      }
    },

    /** 統計直接由去重後的清單彙總 —— 另外寫一組 SQL 的話，
     *  跨字表合併時重複的字會被算兩次，卡片上的數字就和清單對不起來。 */
    wordStats(setIds, userToken){
      const ws = this.wordsOf(setIds, userToken);
      let attempts = 0, correct = 0, mastered = 0, weak = 0;
      for (const w of ws){
        attempts += w.total; correct += w.correct;
        if (w.box >= 3) mastered++;
        if (w.total > 0 && w.box === 0) weak++;
      }
      const byWord = ws
        .map(w => ({ term: w.term, box: w.box, correct: w.correct, total: w.total }))
        .sort((a, b) => a.box - b.box);
      // 認得（選擇題）和會拼（自己寫）分開算：兩者差很多，混在一起正確率會被選擇題拉高
      const ids = [...new Set(ws.flatMap(w => w.mergedIds ?? [w.id]))];
      const split = { recog: { attempts: 0, correct: 0 }, spell: { attempts: 0, correct: 0 } };
      // 最近 RECENT_N 次作答（會拼、認得各自取）：累積的數字被過去答錯拖著，這個才看得出現在的程度
      const recent = { recentRecog: { attempts: 0, correct: 0 }, recentSpell: { attempts: 0, correct: 0 } };
      if (ids.length){
        const qs = ids.map(() => '?').join(',');
        for (const r of db.prepare(`SELECT mode, COUNT(*) n, SUM(correct) c FROM word_attempts
            WHERE user_token = ? AND COALESCE(is_fix,0) = 0 AND word_id IN (${qs}) GROUP BY mode`).all(userToken, ...ids)){
          const t = SPELL_MODES.includes(r.mode) ? split.spell : split.recog;
          t.attempts += r.n; t.correct += r.c;
        }
        for (const [key, modes] of [['recentSpell', SPELL_MODES], ['recentRecog', RECOG_MODES]]){
          const r = db.prepare(`SELECT COUNT(*) n, COALESCE(SUM(correct),0) c FROM (SELECT correct FROM word_attempts
              WHERE user_token = ? AND COALESCE(is_fix,0) = 0 AND word_id IN (${qs}) AND mode IN (${modes.map(() => '?').join(',')})
              ORDER BY created_at DESC, id DESC LIMIT ?)`).get(userToken, ...ids, ...modes, RECENT_N);
          recent[key] = { attempts: Number(r.n), correct: Number(r.c) };
        }
      }
      return { words: ws.length, attempts, correct, mastered, weak, byWord, ...split, ...recent };
    },

    /** 匯出成可攜、可進版控、可合併的列陣列（依 hash 排序，git diff 才乾淨） */
    exportAll({ since = 0 } = {}){
      return db.prepare(`SELECT hash, original, result, model, created_at, hits
        FROM sentences WHERE created_at >= ? ORDER BY hash`).all(since);
    },

    /** 匯入：同 hash 預設保留本機既有的，只把命中次數加總；--force 才覆蓋 */
    importRows(rows, { force = false } = {}){
      const exists = db.prepare('SELECT hash, hits FROM sentences WHERE hash = ?');
      const bump = db.prepare('UPDATE sentences SET hits = hits + ? WHERE hash = ?');
      let added = 0, merged = 0, replaced = 0, bad = 0;
      db.exec('BEGIN');
      try {
        for (const r of rows){
          if (!r?.hash || !r?.original || !r?.result){ bad++; continue; }
          let parsed;
          try { parsed = typeof r.result === 'string' ? JSON.parse(r.result) : r.result; }
          catch { bad++; continue; }
          const cur = exists.get(r.hash);
          if (cur && !force){ bump.run(r.hits || 0, r.hash); merged++; continue; }
          const main = parsed?.clauses?.find(c => c.role === 'main') ?? parsed?.clauses?.[0];
          qPut.run(r.hash, r.original, JSON.stringify(parsed), r.model || 'unknown',
            main?.pattern?.id ?? null, main?.tense?.time ?? null, main?.tense?.aspect ?? null,
            parsed?.inScope === false ? 0 : 1, parsed?.issue ?? null,
            r.created_at || Date.now(), r.hash, 0, 0, 0);
          cur ? replaced++ : added++;
        }
        db.exec('COMMIT');
      } catch (e){ db.exec('ROLLBACK'); throw e; }
      return { added, merged, replaced, bad, total: rows.length };
    },

    /** 把 WAL 折回主檔，之後直接複製 cache.db 才不會漏資料 */
    checkpoint(){ db.exec('PRAGMA wal_checkpoint(TRUNCATE)'); },

    count(){ return db.prepare('SELECT COUNT(*) n FROM sentences').get().n; },

    /** 分析過的句子裡有動詞三態，拿來給單字測驗用 —— 不用再花額度問一次模型。
     *  回傳 { 原形小寫 → forms }。 */
    verbForms(){
      // 每次出題都重新 parse 全部句子太浪費，存起來，有新句子時才重算
      const n = db.prepare('SELECT COUNT(*) n FROM sentences').get().n;
      if (_verbFormsCache && _verbFormsCount === n) return _verbFormsCache;
      const out = new Map();
      for (const r of db.prepare(`SELECT result FROM sentences WHERE issue IS NULL`).all()){
        let d; try { d = JSON.parse(r.result); } catch { continue; }
        for (const cl of d.clauses ?? []){
          const f = cl.verb?.forms;
          if (!f?.base || !f.past || !f.pastParticiple) continue;
          const k = String(f.base).toLowerCase();
          if (!out.has(k)) out.set(k, { ...f, irregular: Boolean(cl.verb.irregular) });
        }
      }
      _verbFormsCache = out; _verbFormsCount = n;
      return out;
    },

    // ---------- 範例句：從分析過的句子裡挑，而不是只有內建那 12 句 ----------
    // 標籤的分類條件就寫在這裡。資料量小（上百句），直接掃 JSON 比另外建索引實際。
    sampleKinds(){
      const main = d => d.clauses?.find(c => c.role === 'main') ?? d.clauses?.[0];
      const roles = d => new Set((main(d)?.constituents ?? []).map(x => x.role));
      return {
        p1: d => main(d)?.pattern?.id === 1,
        p2: d => main(d)?.pattern?.id === 2,
        p3: d => main(d)?.pattern?.id === 3,
        p4: d => main(d)?.pattern?.id === 4,
        p5: d => main(d)?.pattern?.id === 5,
        standard:   d => ['M-manner','M-place','M-time','M-freq'].filter(r => roles(d).has(r)).length >= 2,
        compare45:  d => [4, 5].includes(main(d)?.pattern?.id),
        splitVerb:  d => (main(d)?.constituents ?? []).filter(x => x.role === 'V').length > 1,
        errorCase:  d => (d.notes ?? []).some(n => n.type === 'error'),
        compound:   d => (d.clauses ?? []).length > 1,
        outOfScope: d => d.inScope === false,
      };
    },

    /** 每個類別有幾句可用（給前端決定要不要顯示「換一句」） */
    sampleCounts(){
      const kinds = this.sampleKinds();
      const out = {};
      for (const k of Object.keys(kinds)) out[k] = 0;
      for (const r of this._allAnalyzed())
        for (const [k, f] of Object.entries(kinds)) if (f(r.data)) out[k]++;
      return out;
    },

    /** 取某一類的第 n 句（會繞回去，所以可以一直按「換一句」） */
    sampleOf(kind, n = 0){
      const f = this.sampleKinds()[kind];
      if (!f) return null;
      const hit = this._allAnalyzed().filter(r => f(r.data));
      if (!hit.length) return null;
      const i = ((n % hit.length) + hit.length) % hit.length;
      return { total: hit.length, index: i, sentence: hit[i].data, original: hit[i].original };
    },

    _allAnalyzed(){
      return db.prepare(`SELECT original, result FROM sentences
        WHERE issue IS NULL AND pattern_id IS NOT NULL ORDER BY created_at DESC`).all()
        .map(r => { try { return { original: r.original, data: JSON.parse(r.result) }; } catch { return null; } })
        .filter(Boolean);
    },

    // 出好的題目（含答案）。原本只放記憶體，伺服器一重啟就全部失效，
    // 作答到一半的人按交卷只會看到「這份測驗已失效」。
    putQuiz(id, kind, questions){
      db.prepare(`INSERT OR REPLACE INTO quizzes (id, kind, data, created_at)
        VALUES (?,?,?,?)`).run(id, kind, JSON.stringify(questions), Date.now());
    },
    /** 回傳 { kind, questions }。kind 以 -fix 結尾代表這份是訂正， */
    /** 批改時要把作答標成訂正，不計入統計也不推進 Leitner 的盒子。 */
    getQuiz(id){
      const r = db.prepare('SELECT kind, data FROM quizzes WHERE id = ?').get(id);
      return r ? { kind: r.kind || '', questions: JSON.parse(r.data) } : null;
    },
    pruneQuizzes(days = 7){
      db.prepare('DELETE FROM quizzes WHERE created_at < ?')
        .run(Date.now() - days * 86400_000);
    },
    // 文章表引用的句子不能被清掉，否則文章表會缺句
    prune(days){
      const cutoff = Date.now() - days * 86400_000;
      const keep = 'hash NOT IN (SELECT hash FROM article_items)';
      const n = db.prepare(`SELECT COUNT(*) n FROM sentences WHERE created_at < ? AND ${keep}`).get(cutoff).n;
      db.prepare(`DELETE FROM sentences WHERE created_at < ? AND ${keep}`).run(cutoff);
      return n;
    },

    // ---------- 文章表 ----------
    hashOf(sentence){ return hashOf(sentence); },
    articles(){
      return db.prepare(`SELECT a.id, a.name, a.created_at, a.hidden,
          (SELECT COUNT(*) FROM article_items i WHERE i.article_id = a.id) AS sentences,
          (SELECT COUNT(DISTINCT para) FROM article_items i WHERE i.article_id = a.id) AS paragraphs
        FROM articles a ORDER BY a.created_at DESC, a.id DESC`).all();
    },
    getArticle(id){ return db.prepare('SELECT id, name, created_at FROM articles WHERE id = ?').get(Number(id)) ?? null; },
    articleByName(name){
      return db.prepare('SELECT id, name FROM articles WHERE lower(name) = lower(?)').get(String(name).trim()) ?? null;
    },
    /** 把句子（依序、帶段落）存進文章表。appendTo 有值就接在後面，已經在這份裡的句子略過。 */
    saveArticle({ name, appendTo, items }){
      db.exec('BEGIN');
      try {
        let id = appendTo ? Number(appendTo) : null;
        if (id == null) id = Number(db.prepare('INSERT INTO articles (name, created_at) VALUES (?,?)').run(name, Date.now()).lastInsertRowid);
        else if (!db.prepare('SELECT 1 FROM articles WHERE id = ?').get(id)) throw Object.assign(new Error('這份文章表不存在'), { code: 'not-found' });
        const have = new Set(db.prepare('SELECT hash FROM article_items WHERE article_id = ?').all(id).map(r => r.hash));
        let idx = db.prepare('SELECT COALESCE(MAX(idx), -1) m FROM article_items WHERE article_id = ?').get(id).m + 1;
        const paraBase = db.prepare('SELECT COALESCE(MAX(para), -1) m FROM article_items WHERE article_id = ?').get(id).m + 1;
        const ins = db.prepare('INSERT INTO article_items (article_id, idx, para, hash) VALUES (?,?,?,?)');
        let added = 0, skipped = 0;
        for (const it of items){
          if (have.has(it.hash)){ skipped++; continue; }
          have.add(it.hash); ins.run(id, idx++, paraBase + it.para, it.hash); added++;
        }
        db.exec('COMMIT');
        return { id, added, skipped, total: have.size };
      } catch (e){ db.exec('ROLLBACK'); throw e; }
    },
    renameArticle(id, name){ return Number(db.prepare('UPDATE articles SET name = ? WHERE id = ?').run(name, Number(id)).changes); },

    // ---------- 內容管理：隱藏、改名、刪除預覽（字表與文章表共用）----------
    /** kind：'wordset' | 'article'。回傳對學生隱藏的 id 集合 */
    hiddenIds(kind){
      const t = kind === 'article' ? 'articles' : 'wordsets';
      return new Set(db.prepare(`SELECT id FROM ${t} WHERE hidden = 1`).all().map(r => r.id));
    },
    setHidden(kind, id, hidden){
      const t = kind === 'article' ? 'articles' : 'wordsets';
      return Number(db.prepare(`UPDATE ${t} SET hidden = ? WHERE id = ?`).run(hidden ? 1 : 0, Number(id)).changes);
    },
    renameWordset(id, name, note){
      return Number(note === undefined
        ? db.prepare('UPDATE wordsets SET name = ? WHERE id = ?').run(name, Number(id)).changes
        : db.prepare('UPDATE wordsets SET name = ?, note = ? WHERE id = ?').run(name, note || null, Number(id)).changes);
    },
    /** 刪除前先看會連帶刪掉什麼。字表連作答與熟練度一起刪；文章表只刪順序，句子分析留在句子庫（變成「沒有範圍」）。 */
    deletePreview(kind, ids){
      const list = (Array.isArray(ids) ? ids : [ids]).map(Number).filter(Number.isFinite);
      if (!list.length) return { items: [] };
      const qs = list.map(() => '?').join(',');
      if (kind === 'article'){
        const items = db.prepare(`SELECT a.id, a.name,
            (SELECT COUNT(*) FROM article_items i WHERE i.article_id = a.id) AS sentences,
            (SELECT COUNT(*) FROM article_items i WHERE i.article_id = a.id
               AND NOT EXISTS (SELECT 1 FROM article_items o WHERE o.hash = i.hash AND o.article_id NOT IN (${qs}))) AS orphaned
          FROM articles a WHERE a.id IN (${qs})`).all(...list, ...list);
        return { items, totals: { sentences: items.reduce((n, x) => n + x.sentences, 0), orphaned: items.reduce((n, x) => n + x.orphaned, 0) } };
      }
      const items = db.prepare(`SELECT s.id, s.name,
          (SELECT COUNT(*) FROM words w WHERE w.set_id = s.id) AS words,
          (SELECT COUNT(*) FROM word_attempts a WHERE a.word_id IN (SELECT id FROM words WHERE set_id = s.id)) AS attempts,
          (SELECT COUNT(*) FROM word_progress p WHERE p.word_id IN (SELECT id FROM words WHERE set_id = s.id)) AS progress
        FROM wordsets s WHERE s.id IN (${qs})`).all(...list);
      return { items, totals: { words: items.reduce((n, x) => n + x.words, 0), attempts: items.reduce((n, x) => n + x.attempts, 0), progress: items.reduce((n, x) => n + x.progress, 0) } };
    },
    /** 一份字表的單字（老師管理用）：附詞義摘要與作答筆數 */
    wordsetWords(setId){
      return db.prepare(`SELECT w.id, w.idx, w.term, w.data,
          (SELECT COUNT(*) FROM word_attempts a WHERE a.word_id = w.id) AS attempts
        FROM words w WHERE w.set_id = ? ORDER BY w.idx, w.id`).all(Number(setId))
        .map(r => { let zh = ''; try { zh = (JSON.parse(r.data).senses ?? []).map(s => s.zh).filter(Boolean).slice(0, 2).join('；'); } catch {}
          return { id: r.id, term: r.term, zh, attempts: r.attempts }; });
    },
    /** 把單字從 fromId 移到 toId（改 set_id，作答與熟練度跟著走）。目標已有同字的跳過、留在原處。 */
    moveWords(fromId, wordIds, toId){
      const from = Number(fromId), to = Number(toId);
      const ids = [...new Set((Array.isArray(wordIds) ? wordIds : []).map(Number).filter(Number.isInteger))];
      if (!ids.length || from === to) return { moved: 0, skipped: [] };
      const have = new Set(db.prepare('SELECT lower(term) t FROM words WHERE set_id = ?').all(to).map(r => r.t));
      const rows = ids.map(id => db.prepare('SELECT id, term FROM words WHERE id = ? AND set_id = ?').get(id, from)).filter(Boolean);
      let idx = db.prepare('SELECT COALESCE(MAX(idx), -1) m FROM words WHERE set_id = ?').get(to).m + 1;
      const skipped = []; let moved = 0;
      db.exec('BEGIN');
      try {
        const up = db.prepare('UPDATE words SET set_id = ?, idx = ? WHERE id = ?');
        for (const w of rows){
          const k = w.term.toLowerCase();
          if (have.has(k)){ skipped.push(w.term); continue; }
          up.run(to, idx++, w.id); have.add(k); moved++;
        }
        db.exec('COMMIT');
      } catch (e){ db.exec('ROLLBACK'); throw e; }
      return { moved, skipped };
    },
    /** 從字表移除單字（連作答與熟練度）。dryRun 只回傳筆數。 */
    removeWords(setId, wordIds, { dryRun = false } = {}){
      const ids = (Array.isArray(wordIds) ? wordIds : []).map(Number).filter(Number.isInteger)
        .filter(id => db.prepare('SELECT 1 FROM words WHERE id = ? AND set_id = ?').get(id, Number(setId)));
      if (!ids.length) return { words: 0, attempts: 0, progress: 0 };
      const qs = ids.map(() => '?').join(',');
      const cnt = t => Number(db.prepare(`SELECT COUNT(*) n FROM ${t} WHERE word_id IN (${qs})`).get(...ids).n);
      const out = { words: ids.length, attempts: cnt('word_attempts'), progress: cnt('word_progress') };
      if (dryRun) return out;
      db.exec('BEGIN');
      try {
        db.prepare(`DELETE FROM word_attempts WHERE word_id IN (${qs})`).run(...ids);
        db.prepare(`DELETE FROM word_progress WHERE word_id IN (${qs})`).run(...ids);
        db.prepare(`DELETE FROM words WHERE id IN (${qs})`).run(...ids);
        db.exec('COMMIT');
      } catch (e){ db.exec('ROLLBACK'); throw e; }
      return out;
    },
    /** 文章表的句子（依序），給老師編修用 */
    articleSentences(id){
      return db.prepare(`SELECT i.idx, i.para, i.hash, s.original FROM article_items i
          LEFT JOIN sentences s ON s.hash = i.hash WHERE i.article_id = ? ORDER BY i.idx`).all(Number(id))
        .map(r => ({ idx: r.idx, para: r.para, hash: r.hash, original: r.original ?? '' }));
    },
    /** 這份文章表的內容變了：以它為範圍的閱讀、回應題庫作廢（會依新內容重出）。已出的卷子是快照，不受影響。 */
    clearArticleBank(id){
      return Number(db.prepare("DELETE FROM questions WHERE ref = ? AND src = 'scope'").run(String(id)).changes);
    },
    /** 依給定順序重寫 idx（只留 rows 裡的句子）。呼叫端須在交易內。 */
    _rewriteItems(id, rows){
      db.prepare('DELETE FROM article_items WHERE article_id = ?').run(id);
      const ins = db.prepare('INSERT INTO article_items (article_id, idx, para, hash) VALUES (?,?,?,?)');
      rows.forEach((r, i) => ins.run(id, i, r.para, r.hash));
    },
    /** 把句子從 fromId 移到 toId（接在後面，自成新段落；目標已有的句子跳過、留在原處）。 */
    moveArticleItems(fromId, hashes, toId){
      const from = Number(fromId), to = Number(toId);
      const want = new Set((Array.isArray(hashes) ? hashes : []).map(String));
      if (!want.size || from === to) return { moved: 0, skipped: 0 };
      db.exec('BEGIN');
      try {
        const src = db.prepare('SELECT para, hash FROM article_items WHERE article_id = ? ORDER BY idx').all(from);
        const have = new Set(db.prepare('SELECT hash FROM article_items WHERE article_id = ?').all(to).map(r => r.hash));
        const take = [], stay = []; let skipped = 0;
        for (const r of src){
          if (!want.has(r.hash)) stay.push(r);
          else if (have.has(r.hash)){ stay.push(r); skipped++; }
          else { take.push(r); have.add(r.hash); }
        }
        if (take.length){
          const cur = db.prepare('SELECT para, hash FROM article_items WHERE article_id = ? ORDER BY idx').all(to);
          const base = cur.reduce((m, r) => Math.max(m, r.para), -1) + 1;
          const order = [...new Set(take.map(r => r.para))];
          this._rewriteItems(to, [...cur, ...take.map(r => ({ para: base + order.indexOf(r.para), hash: r.hash }))]);
          this._rewriteItems(from, stay);
        }
        db.exec('COMMIT');
        if (take.length){ this.clearArticleBank(from); this.clearArticleBank(to); }
        return { moved: take.length, skipped };
      } catch (e){ db.exec('ROLLBACK'); throw e; }
    },
    /** 從文章表拿掉句子（句子分析留在句子庫）。dryRun 只回傳筆數與會變成「沒有範圍」的句數。 */
    removeArticleItems(id, hashes, { dryRun = false } = {}){
      const aid = Number(id), want = new Set((Array.isArray(hashes) ? hashes : []).map(String));
      const src = db.prepare('SELECT para, hash FROM article_items WHERE article_id = ? ORDER BY idx').all(aid);
      const gone = src.filter(r => want.has(r.hash));
      const orphaned = gone.filter(r => !db.prepare('SELECT 1 FROM article_items WHERE hash = ? AND article_id != ?').get(r.hash, aid)).length;
      const out = { sentences: gone.length, orphaned };
      if (dryRun || !gone.length) return out;
      db.exec('BEGIN');
      try { this._rewriteItems(aid, src.filter(r => !want.has(r.hash))); db.exec('COMMIT'); }
      catch (e){ db.exec('ROLLBACK'); throw e; }
      this.clearArticleBank(aid);
      return out;
    },
    /** 調順序：hashes 是新的完整順序（必須剛好是現有的那些句子）；段落編號留在原位置，句子換到哪一段就屬於哪一段。回傳是否成功。 */
    reorderArticle(id, hashes){
      const aid = Number(id), list = (Array.isArray(hashes) ? hashes : []).map(String);
      const src = db.prepare('SELECT para, hash FROM article_items WHERE article_id = ? ORDER BY idx').all(aid);
      const by = new Map(src.map(r => [r.hash, r]));
      if (list.length !== src.length || new Set(list).size !== list.length || !list.every(h => by.has(h))) return false;
      db.exec('BEGIN');
      try { this._rewriteItems(aid, list.map((h, i) => ({ para: src[i].para, hash: h }))); db.exec('COMMIT'); }
      catch (e){ db.exec('ROLLBACK'); throw e; }
      this.clearArticleBank(aid);
      return true;
    },
    deleteArticles(ids){
      const list =(Array.isArray(ids) ? ids : [ids]).map(Number).filter(Number.isFinite);
      if (!list.length) return 0;
      const qs = list.map(() => '?').join(',');
      db.exec('BEGIN');
      try {
        db.prepare(`DELETE FROM article_items WHERE article_id IN (${qs})`).run(...list);
        const n = db.prepare(`DELETE FROM articles WHERE id IN (${qs})`).run(...list).changes;
        db.exec('COMMIT'); return Number(n);
      } catch (e){ db.exec('ROLLBACK'); throw e; }
    },
    /** 文章表的句子（依序），附上分析結果；分析結果不在快取裡的句子 sentence 是 null */
    articleItems(ids){
      const list = (Array.isArray(ids) ? ids : [ids]).map(Number).filter(Number.isFinite);
      if (!list.length) return [];
      const qs = list.map(() => '?').join(',');
      return db.prepare(`SELECT i.article_id, i.idx, i.para, i.hash, s.result, s.speaker FROM article_items i
          LEFT JOIN sentences s ON s.hash = i.hash WHERE i.article_id IN (${qs}) ORDER BY i.article_id, i.idx`).all(...list)
        .map(r => ({ articleId: r.article_id, idx: r.idx, para: r.para, hash: r.hash,
                     sentence: r.result ? JSON.parse(r.result) : null, speaker: r.speaker || null }));
    },

    // ---------- 測驗卷（快取性質，到期自動清除）----------
    putPaper({ id, n, settings, data, ttlDays = 30, status = 'open' }){
      const now = Date.now();
      db.prepare(`INSERT OR REPLACE INTO papers (id, created_at, expires_at, n, settings, data, status)
        VALUES (?,?,?,?,?,?,?)`).run(id, now, now + ttlDays * 86400_000, n, JSON.stringify(settings), JSON.stringify(data), status);
    },
    /** 更新卷子的部分欄位：settings、data、n、status、expiresAt */
    updatePaper(id, f){
      const sets = [], p = [];
      if ('settings' in f){ sets.push('settings = ?'); p.push(JSON.stringify(f.settings)); }
      if ('data' in f){ sets.push('data = ?'); p.push(JSON.stringify(f.data)); }
      if ('n' in f){ sets.push('n = ?'); p.push(f.n); }
      if ('status' in f){ sets.push('status = ?'); p.push(f.status); }
      if ('expiresAt' in f){ sets.push('expires_at = ?'); p.push(f.expiresAt); }
      if (!sets.length) return 0;
      return Number(db.prepare(`UPDATE papers SET ${sets.join(', ')} WHERE id = ?`).run(...p, String(id)).changes);
    },
    getPaper(id){
      const r = db.prepare('SELECT * FROM papers WHERE id = ? AND expires_at > ?').get(String(id), Date.now());
      return r ? { id: r.id, createdAt: r.created_at, expiresAt: r.expires_at, n: r.n, status: r.status,
                   score: r.score, submittedAt: r.submitted_at, settings: JSON.parse(r.settings), data: JSON.parse(r.data) } : null;
    },
    savePaperData(id, data){ db.prepare('UPDATE papers SET data = ? WHERE id = ?').run(JSON.stringify(data), String(id)); },
    submitPaper(id, data, score){
      db.prepare("UPDATE papers SET data = ?, status = 'submitted', score = ?, submitted_at = ? WHERE id = ?")
        .run(JSON.stringify(data), score, Date.now(), String(id));
    },
    papers(limit = 20){
      // 最近 limit 份，加上釘選的（釘選的不受份數限制）
      return db.prepare(`SELECT id, created_at, expires_at, n, status, score, submitted_at, settings FROM papers
          WHERE expires_at > ? AND (COALESCE(json_extract(settings, '$.pinned'), 0) = 1
            OR id IN (SELECT id FROM papers WHERE expires_at > ? ORDER BY created_at DESC LIMIT ?))
          ORDER BY created_at DESC`).all(Date.now(), Date.now(), limit)
        .map(r => ({ ...r, settings: JSON.parse(r.settings) }));
    },
    deletePaper(id){ return Number(db.prepare('DELETE FROM papers WHERE id = ?').run(String(id)).changes); },
    /** 清掉過期的，以及超過最近 keep 份的 */
    prunePapers({ keep = 20 } = {}){
      const a = db.prepare('DELETE FROM papers WHERE expires_at <= ?').run(Date.now()).changes;
      // 草稿是老師還在整理的卷子，不算進「最近 keep 份」，也不會因為份數被清掉（過期才清）。
      // 釘選的卷子也一樣：不算份數、不會被清掉（到期日設得很遠）
      const pin = "COALESCE(json_extract(settings, '$.pinned'), 0) = 1";
      const b = db.prepare(`DELETE FROM papers WHERE status != 'draft' AND NOT (${pin})
        AND id NOT IN (SELECT id FROM papers WHERE status != 'draft' AND NOT (${pin}) ORDER BY created_at DESC LIMIT ?)`).run(keep).changes;
      return Number(a) + Number(b);
    },

    // ---------- 題庫（模型出的題，存起來重複用）----------
    putQuestions(rows){
      const ins = db.prepare(`INSERT OR IGNORE INTO questions (id, type, src, ref, anchors, payload, created_at)
        VALUES (?,?,?,?,?,?,?)`);
      db.exec('BEGIN');
      try {
        for (const q of rows) ins.run(q.id, q.type, q.src, q.ref ?? null, q.anchors ? JSON.stringify(q.anchors) : null,
          JSON.stringify(q.payload), Date.now());
        db.exec('COMMIT');
      } catch (e){ db.exec('ROLLBACK'); throw e; }
      return rows.length;
    },
    /** 取題庫的題：用過次數少的、答錯多的優先 */
    questionsOf({ type, ref, src, limit = 200 }){
      const where = ['type = ?']; const args = [type];
      if (ref != null){ where.push('ref = ?'); args.push(String(ref)); }
      if (src){ where.push('src = ?'); args.push(src); }
      return db.prepare(`SELECT id, type, src, ref, anchors, payload, used, wrong FROM questions
          WHERE ${where.join(' AND ')} ORDER BY used ASC, wrong DESC, created_at DESC LIMIT ?`).all(...args, limit)
        .map(r => ({ id: r.id, type: r.type, src: r.src, ref: r.ref, used: r.used, wrong: r.wrong,
                     anchors: r.anchors ? JSON.parse(r.anchors) : null, payload: JSON.parse(r.payload) }));
    },
    bumpQuestions(ids, { wrong = false } = {}){
      const st = db.prepare(`UPDATE questions SET ${wrong ? 'wrong = wrong + 1' : 'used = used + 1'} WHERE id = ?`);
      for (const id of ids) st.run(String(id));
    },
    /** 題庫設上限，淘汰用得最多、最舊的（用得少的新題優先保留） */
    pruneQuestions(max = 500){
      return Number(db.prepare(`DELETE FROM questions WHERE id IN (
          SELECT id FROM questions ORDER BY used ASC, created_at DESC LIMIT -1 OFFSET ?)`).run(max).changes);
    },
    stats(){
      return { ...qStats.get(), patterns: qPatterns.all(), tenses: qTenses.all() };
    },
    close(){ db.close(); },
  };
}
