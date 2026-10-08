// 逐句快取。key = 正規化後句子的 SHA-256，所以同一句出現在不同文章裡也能命中。
// 用 node:sqlite（Node 22 內建，零依賴）。

import { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { normalize } from './segment.mjs';

export const hashOf = (sentence) =>
  createHash('sha256').update(normalize(sentence), 'utf8').digest('hex');

/** 把存起來的「A: 內容」拆成 { speaker, text }。多行就取第一行當代表。 */
function parseContext(raw){
  const line = String(raw).split('\n')[0].trim();
  const m = /^([A-Za-z][A-Za-z]{0,9})\s*[:：]\s*(.+)$/.exec(line);
  return m ? { speaker: m[1], text: m[2] } : { speaker: '', text: line };
}

export function openCache(file = 'data/cache.db'){
  mkdirSync(dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec(`
    PRAGMA journal_mode = WAL;
    CREATE TABLE IF NOT EXISTS sentences (
      hash       TEXT PRIMARY KEY,
      original   TEXT NOT NULL,
      result     TEXT NOT NULL,      -- 單句分析結果 JSON
      model      TEXT NOT NULL,
      pattern_id INTEGER,            -- 攤平，之後做弱點統計用
      tense_time TEXT,
      tense_aspect TEXT,
      in_scope   INTEGER,
      issue      TEXT,
      created_at INTEGER NOT NULL,
      hits       INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS attempts (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      user_token TEXT NOT NULL,
      qtype      TEXT NOT NULL,          -- pattern | tense | pos | verb-forms | error-fix
      sentence_hash TEXT,
      pattern_id INTEGER,                -- 作答當下該題涉及的句型（弱點統計用）
      tense_time TEXT, tense_aspect TEXT,
      pos        TEXT,
      pron_case  TEXT,
      correct    INTEGER NOT NULL,
      answer     TEXT, expected TEXT,
      created_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_attempts_user ON attempts(user_token, created_at);
    CREATE TABLE IF NOT EXISTS wordsets (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL, note TEXT, created_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS words (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      set_id INTEGER NOT NULL, idx INTEGER NOT NULL,
      term TEXT NOT NULL, syllables TEXT, spell_tip TEXT,
      data TEXT NOT NULL,                 -- senses / confusable / family 的完整 JSON
      UNIQUE(set_id, term)
    );
    CREATE INDEX IF NOT EXISTS idx_words_set ON words(set_id, idx);
    CREATE TABLE IF NOT EXISTS word_attempts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_token TEXT NOT NULL, word_id INTEGER NOT NULL, sense_idx INTEGER,
      mode TEXT NOT NULL, correct INTEGER NOT NULL,
      answer TEXT, expected TEXT, created_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_wattempts ON word_attempts(user_token, created_at);
    -- Leitner 間隔複習：答對往上一盒、答錯打回第一盒，到期的優先出
    CREATE TABLE IF NOT EXISTS word_progress (
      user_token TEXT NOT NULL, word_id INTEGER NOT NULL,
      box INTEGER NOT NULL DEFAULT 0, due_at INTEGER NOT NULL DEFAULT 0,
      correct INTEGER NOT NULL DEFAULT 0, total INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (user_token, word_id)
    );
    CREATE TABLE IF NOT EXISTS requests (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      chars      INTEGER, sentences INTEGER, cached INTEGER, analyzed INTEGER,
      ms         INTEGER, created_at INTEGER NOT NULL,
      kind       TEXT DEFAULT 'analyze',  -- analyze（分析句子）| wordset（建立字表）
      ref_id     INTEGER,              -- kind=wordset 時是該字表的 id
      text       TEXT,                 -- 原文，供歷史紀錄重新顯示（由 TTL 自動清理）
      input_tokens INTEGER DEFAULT 0, output_tokens INTEGER DEFAULT 0,
      cache_read_tokens INTEGER DEFAULT 0, cost_usd REAL DEFAULT 0
    );
    CREATE INDEX IF NOT EXISTS idx_requests_time ON requests(created_at DESC);
  
    CREATE TABLE IF NOT EXISTS quizzes (
      id         TEXT PRIMARY KEY,
      kind       TEXT,              -- sentence（句型練習）| word（單字測驗）
      data       TEXT NOT NULL,     -- 題目含答案的 JSON
      created_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_quizzes_at ON quizzes(created_at);
`);

  // 既有資料庫補欄位（node:sqlite 沒有 IF NOT EXISTS，用 PRAGMA 檢查）
  const cols = t => new Set(db.prepare(`PRAGMA table_info(${t})`).all().map(c => c.name));
  const addCol = (t, name, decl) => { if (!cols(t).has(name)) db.exec(`ALTER TABLE ${t} ADD COLUMN ${name} ${decl}`); };
  for (const [n, d] of [['text','TEXT'], ['kind',"TEXT DEFAULT 'analyze'"], ['ref_id','INTEGER'], ['input_tokens','INTEGER DEFAULT 0'],
                        ['output_tokens','INTEGER DEFAULT 0'], ['cache_read_tokens','INTEGER DEFAULT 0'],
                        ['cost_usd','REAL DEFAULT 0']]) addCol('requests', n, d);
  for (const [n, d] of [['input_tokens','INTEGER DEFAULT 0'], ['output_tokens','INTEGER DEFAULT 0'],
                        ['cost_usd','REAL DEFAULT 0'],
                        // 對話題：這句是誰說的、對方說了什麼。出題時要一起呈現，
                        // 否則「make...for」和「made...some cards」的對照就斷了。
                        ['speaker','TEXT'], ['context','TEXT']]) addCol('sentences', n, d);
  addCol('attempts', 'pron_case', 'TEXT');
  // 訂正的作答要留紀錄但不計入統計與排程
  addCol('attempts', 'is_fix', 'INTEGER DEFAULT 0');
  addCol('word_attempts', 'is_fix', 'INTEGER DEFAULT 0');

  const qGet  = db.prepare('SELECT result FROM sentences WHERE hash = ?');
  const qHit  = db.prepare('UPDATE sentences SET hits = hits + 1 WHERE hash = ?');
  const qPut  = db.prepare(`INSERT OR REPLACE INTO sentences
    (hash, original, result, model, pattern_id, tense_time, tense_aspect, in_scope, issue, created_at, hits,
     input_tokens, output_tokens, cost_usd, speaker, context)
    VALUES (?,?,?,?,?,?,?,?,?,?, COALESCE((SELECT hits FROM sentences WHERE hash = ?), 0), ?,?,?,?,?)`);
  const qLog  = db.prepare(`INSERT INTO requests
    (chars, sentences, cached, analyzed, ms, created_at, kind, ref_id, text,
     input_tokens, output_tokens, cache_read_tokens, cost_usd)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`);
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
        row.cacheReadTokens ?? 0, row.costUsd ?? 0);
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
        (user_token,qtype,sentence_hash,pattern_id,tense_time,tense_aspect,pos,pron_case,correct,is_fix,answer,expected,created_at)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
        a.userToken, a.qtype, a.sentenceHash ?? null, a.patternId ?? null,
        a.tenseTime ?? null, a.tenseAspect ?? null, a.pos ?? null, a.pronCase ?? null,
        a.correct ? 1 : 0, a.isFix ? 1 : 0, a.answer ?? null, a.expected ?? null, Date.now());
    },

    /** 弱點統計：11 個維度（5 句型 + 6 必學時態）＋ 詞性與題型 */
    weakness(userToken){
      const q = (sql, ...p) => db.prepare(sql).all(userToken, ...p);
      const overall = db.prepare(
        `SELECT COUNT(*) total, COALESCE(SUM(correct),0) correct FROM attempts
          WHERE user_token = ? AND COALESCE(is_fix,0) = 0`).get(userToken);
      return {
        overall,
        byType: q(`SELECT qtype, COUNT(*) total, SUM(correct) correct FROM attempts
          WHERE user_token = ? AND COALESCE(is_fix,0) = 0 GROUP BY qtype ORDER BY qtype`),
        byPattern: q(`SELECT pattern_id, COUNT(*) total, SUM(correct) correct FROM attempts
          WHERE user_token = ? AND COALESCE(is_fix,0) = 0 AND pattern_id IS NOT NULL
                      GROUP BY pattern_id ORDER BY pattern_id`),
        byTense: q(`SELECT tense_time, tense_aspect, COUNT(*) total, SUM(correct) correct FROM attempts
          WHERE user_token = ? AND COALESCE(is_fix,0) = 0 AND tense_time IS NOT NULL
                    GROUP BY tense_time, tense_aspect`),
        byPos: q(`SELECT pos, COUNT(*) total, SUM(correct) correct FROM attempts
          WHERE user_token = ? AND COALESCE(is_fix,0) = 0 AND pos IS NOT NULL GROUP BY pos ORDER BY pos`),
        byCase: q(`SELECT pron_case, COUNT(*) total, SUM(correct) correct FROM attempts
          WHERE user_token = ? AND COALESCE(is_fix,0) = 0 AND pron_case IS NOT NULL GROUP BY pron_case`),
        recent: q(`SELECT qtype, correct, answer, expected,
                     datetime(created_at/1000,'unixepoch','localtime') t
                   FROM attempts
          WHERE user_token = ? AND COALESCE(is_fix,0) = 0 ORDER BY created_at DESC LIMIT 20`),
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
    pickSentences(limit = 40){
      return db.prepare(`SELECT hash, result, speaker, context FROM sentences
        WHERE issue IS NULL AND pattern_id IS NOT NULL
        ORDER BY RANDOM() LIMIT ?`).all(limit)
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
      return db.prepare(`SELECT s.id, s.name, s.note, s.created_at,
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

    /** 記錄單字作答並更新 Leitner 盒子 */
    recordWordAttempt(a){
      db.prepare(`INSERT INTO word_attempts
        (user_token, word_id, sense_idx, mode, correct, is_fix, answer, expected, created_at)
        VALUES (?,?,?,?,?,?,?,?,?)`).run(
        a.userToken, a.wordId, a.senseIdx ?? null, a.mode,
        a.correct ? 1 : 0, a.isFix ? 1 : 0, a.answer ?? null, a.expected ?? null, Date.now());

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
        const box = a.correct ? Math.min(cur.box + 1, INTERVALS.length - 1) : 0;
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
      return { words: ws.length, attempts, correct, mastered, weak, byWord };
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
    prune(days){
      const cutoff = Date.now() - days * 86400_000;
      const n = db.prepare('SELECT COUNT(*) n FROM sentences WHERE created_at < ?').get(cutoff).n;
      db.prepare('DELETE FROM sentences WHERE created_at < ?').run(cutoff);
      return n;
    },
    stats(){
      return { ...qStats.get(), patterns: qPatterns.all(), tenses: qTenses.all() };
    },
    close(){ db.close(); },
  };
}
