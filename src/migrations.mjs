// 資料庫遷移清單。每一版只能新增，不能改寫已經發布的版本。
// 引擎在 migrate.mjs：依 PRAGMA user_version 決定要套用哪些，套用前自動備份，每一版在交易裡執行。

/** 第 1 版：到目前為止累積的所有結構。
 *  全部是冪等的（IF NOT EXISTS、欄位已存在就略過），所以對「還沒有版本號、
 *  但結構已經是最新」的既有資料庫也能安全套用，之後它就有版本號了。 */
function baseline(db){
  db.exec(`
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
}

export const MIGRATIONS = [
  { version: 1, name: 'baseline', up: baseline },
];
