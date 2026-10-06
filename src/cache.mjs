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
      ms         INTEGER, created_at INTEGER NOT NULL
    );
  `);

  const qGet  = db.prepare('SELECT result FROM sentences WHERE hash = ?');
  const qHit  = db.prepare('UPDATE sentences SET hits = hits + 1 WHERE hash = ?');
  const qPut  = db.prepare(`INSERT OR REPLACE INTO sentences
    (hash, original, result, model, pattern_id, tense_time, tense_aspect, in_scope, issue, created_at, hits)
    VALUES (?,?,?,?,?,?,?,?,?,?, COALESCE((SELECT hits FROM sentences WHERE hash = ?), 0))`);
  const qLog  = db.prepare(`INSERT INTO requests (chars, sentences, cached, analyzed, ms, created_at)
    VALUES (?,?,?,?,?,?)`);
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
    put(sentence, result, model){
      const h = hashOf(sentence);
      const main = result?.clauses?.find(c => c.role === 'main') ?? result?.clauses?.[0];
      qPut.run(h, sentence, JSON.stringify(result), model,
        main?.pattern?.id ?? null, main?.tense?.time ?? null, main?.tense?.aspect ?? null,
        result?.inScope === false ? 0 : 1, result?.issue ?? null, Date.now(), h);
    },
    log(row){ qLog.run(row.chars, row.sentences, row.cached, row.analyzed, row.ms, Date.now()); },

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
            r.created_at || Date.now(), r.hash);
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
