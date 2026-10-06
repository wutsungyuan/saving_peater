// 逐句快取。key = 正規化後句子的 SHA-256，所以同一句出現在不同文章裡也能命中。
// 用 node:sqlite（Node 22 內建，零依賴）。

import { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { normalize } from './segment.mjs';

export const hashOf = (sentence) =>
  createHash('sha256').update(normalize(sentence), 'utf8').digest('hex');

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
      correct    INTEGER NOT NULL,
      answer     TEXT, expected TEXT,
      created_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_attempts_user ON attempts(user_token, created_at);
    CREATE TABLE IF NOT EXISTS requests (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      chars      INTEGER, sentences INTEGER, cached INTEGER, analyzed INTEGER,
      ms         INTEGER, created_at INTEGER NOT NULL,
      text       TEXT,                 -- 原文，供歷史紀錄重新顯示（由 TTL 自動清理）
      input_tokens INTEGER DEFAULT 0, output_tokens INTEGER DEFAULT 0,
      cache_read_tokens INTEGER DEFAULT 0, cost_usd REAL DEFAULT 0
    );
    CREATE INDEX IF NOT EXISTS idx_requests_time ON requests(created_at DESC);
  `);

  // 既有資料庫補欄位（node:sqlite 沒有 IF NOT EXISTS，用 PRAGMA 檢查）
  const cols = t => new Set(db.prepare(`PRAGMA table_info(${t})`).all().map(c => c.name));
  const addCol = (t, name, decl) => { if (!cols(t).has(name)) db.exec(`ALTER TABLE ${t} ADD COLUMN ${name} ${decl}`); };
  for (const [n, d] of [['text','TEXT'], ['input_tokens','INTEGER DEFAULT 0'],
                        ['output_tokens','INTEGER DEFAULT 0'], ['cache_read_tokens','INTEGER DEFAULT 0'],
                        ['cost_usd','REAL DEFAULT 0']]) addCol('requests', n, d);
  for (const [n, d] of [['input_tokens','INTEGER DEFAULT 0'], ['output_tokens','INTEGER DEFAULT 0'],
                        ['cost_usd','REAL DEFAULT 0']]) addCol('sentences', n, d);

  const qGet  = db.prepare('SELECT result FROM sentences WHERE hash = ?');
  const qHit  = db.prepare('UPDATE sentences SET hits = hits + 1 WHERE hash = ?');
  const qPut  = db.prepare(`INSERT OR REPLACE INTO sentences
    (hash, original, result, model, pattern_id, tense_time, tense_aspect, in_scope, issue, created_at, hits,
     input_tokens, output_tokens, cost_usd)
    VALUES (?,?,?,?,?,?,?,?,?,?, COALESCE((SELECT hits FROM sentences WHERE hash = ?), 0), ?,?,?)`);
  const qLog  = db.prepare(`INSERT INTO requests
    (chars, sentences, cached, analyzed, ms, created_at, text, input_tokens, output_tokens, cache_read_tokens, cost_usd)
    VALUES (?,?,?,?,?,?,?,?,?,?,?)`);
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
    put(sentence, result, model, usage = {}){
      const h = hashOf(sentence);
      const main = result?.clauses?.find(c => c.role === 'main') ?? result?.clauses?.[0];
      qPut.run(h, sentence, JSON.stringify(result), model,
        main?.pattern?.id ?? null, main?.tense?.time ?? null, main?.tense?.aspect ?? null,
        result?.inScope === false ? 0 : 1, result?.issue ?? null, Date.now(), h,
        usage.inputTokens ?? 0, usage.outputTokens ?? 0, usage.costUsd ?? 0);
    },
    log(row){
      qLog.run(row.chars, row.sentences, row.cached, row.analyzed, row.ms, Date.now(),
        row.text ?? null, row.inputTokens ?? 0, row.outputTokens ?? 0,
        row.cacheReadTokens ?? 0, row.costUsd ?? 0);
    },

    /** 分析歷史：最近幾次請求 */
    history(limit = 30){
      return db.prepare(`SELECT id, chars, sentences, cached, analyzed, ms, created_at,
          substr(text, 1, 160) preview, length(text) full_len,
          input_tokens, output_tokens, cache_read_tokens, cost_usd
        FROM requests WHERE text IS NOT NULL ORDER BY created_at DESC LIMIT ?`).all(limit);
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
        (user_token,qtype,sentence_hash,pattern_id,tense_time,tense_aspect,pos,correct,answer,expected,created_at)
        VALUES (?,?,?,?,?,?,?,?,?,?,?)`).run(
        a.userToken, a.qtype, a.sentenceHash ?? null, a.patternId ?? null,
        a.tenseTime ?? null, a.tenseAspect ?? null, a.pos ?? null,
        a.correct ? 1 : 0, a.answer ?? null, a.expected ?? null, Date.now());
    },

    /** 弱點統計：11 個維度（5 句型 + 6 必學時態）＋ 詞性與題型 */
    weakness(userToken){
      const q = (sql, ...p) => db.prepare(sql).all(userToken, ...p);
      const overall = db.prepare(
        'SELECT COUNT(*) total, COALESCE(SUM(correct),0) correct FROM attempts WHERE user_token = ?').get(userToken);
      return {
        overall,
        byType: q(`SELECT qtype, COUNT(*) total, SUM(correct) correct FROM attempts
                   WHERE user_token = ? GROUP BY qtype ORDER BY qtype`),
        byPattern: q(`SELECT pattern_id, COUNT(*) total, SUM(correct) correct FROM attempts
                      WHERE user_token = ? AND pattern_id IS NOT NULL
                      GROUP BY pattern_id ORDER BY pattern_id`),
        byTense: q(`SELECT tense_time, tense_aspect, COUNT(*) total, SUM(correct) correct FROM attempts
                    WHERE user_token = ? AND tense_time IS NOT NULL
                    GROUP BY tense_time, tense_aspect`),
        byPos: q(`SELECT pos, COUNT(*) total, SUM(correct) correct FROM attempts
                  WHERE user_token = ? AND pos IS NOT NULL GROUP BY pos ORDER BY pos`),
        recent: q(`SELECT qtype, correct, answer, expected,
                     datetime(created_at/1000,'unixepoch','localtime') t
                   FROM attempts WHERE user_token = ? ORDER BY created_at DESC LIMIT 20`),
      };
    },

    /** 取出可出題的句子（之後 M4 可依弱點加權） */
    pickSentences(limit = 40){
      return db.prepare(`SELECT hash, result FROM sentences
        WHERE issue IS NULL AND pattern_id IS NOT NULL
        ORDER BY RANDOM() LIMIT ?`).all(limit)
        .map(r => { try { return { hash: r.hash, data: JSON.parse(r.result) }; } catch { return null; } })
        .filter(Boolean);
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
