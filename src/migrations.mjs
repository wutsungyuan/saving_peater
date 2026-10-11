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

/** 第 2 版：文章表。
 *  文章表只存「句子的順序」：article_items 指向 sentences 表裡的分析結果（用 hash），
 *  所以同一句出現在多篇文章或單字例句裡都不會重複分析、重複花錢。 */
function articles(db){
  db.exec(`
    CREATE TABLE articles (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      name       TEXT NOT NULL,
      created_at INTEGER NOT NULL
    );
    CREATE TABLE article_items (
      article_id INTEGER NOT NULL,
      idx        INTEGER NOT NULL,           -- 在整份文章表裡的順序
      para       INTEGER NOT NULL,           -- 段落編號（閱讀測驗與克漏字要用）
      hash       TEXT NOT NULL,              -- sentences.hash
      PRIMARY KEY (article_id, idx)
    );
    CREATE INDEX idx_article_items_hash ON article_items(hash);
  `);
}

/** 第 3 版：測驗卷與題庫。
 *  papers 是快取性質：帶到期時間，到期自動清除（歷史只用快取）。
 *  questions 是題庫：模型出的題存起來重複用，不隨歷史清除（重出要花錢），改設上限淘汰。 */
function papers(db){
  db.exec(`
    CREATE TABLE papers (
      id           TEXT PRIMARY KEY,
      created_at   INTEGER NOT NULL,
      expires_at   INTEGER NOT NULL,
      n            INTEGER NOT NULL,
      settings     TEXT NOT NULL,            -- 範圍、難度、題型等出卷設定（JSON）
      data         TEXT NOT NULL,            -- 題目（含答案）、作答、批改結果（JSON）
      status       TEXT NOT NULL DEFAULT 'open',   -- open | submitted
      score        REAL,
      submitted_at INTEGER
    );
    CREATE INDEX idx_papers_time ON papers(created_at DESC);
    CREATE TABLE questions (
      id         TEXT PRIMARY KEY,
      type       TEXT NOT NULL,              -- read | cloze-dist | mc | reorder | fix | trans ...
      src        TEXT NOT NULL,              -- scope | ext-free | ext-model
      ref        TEXT,                       -- 來源：文章 id 或字表 id 的組合鍵
      anchors    TEXT,                       -- 延伸題依據的單字、句子或文章（JSON）
      payload    TEXT NOT NULL,              -- 題目本體（JSON）
      created_at INTEGER NOT NULL,
      used       INTEGER NOT NULL DEFAULT 0,
      wrong      INTEGER NOT NULL DEFAULT 0
    );
    CREATE INDEX idx_questions_type ON questions(type, ref);
  `);
}

function sessions(db){
  db.exec(`
    CREATE TABLE sessions (
      id         TEXT PRIMARY KEY,           -- session 碼的 SHA-256（資料庫不存原碼）
      created_at INTEGER NOT NULL,
      expires_at INTEGER NOT NULL
    );
    CREATE INDEX idx_sessions_exp ON sessions(expires_at);
  `);
}

/** 第 5 版：作答紀錄標出「來源」，弱點頁才能分開看單字測驗、句子練習、測驗卷。
 *  舊紀錄：句子作答 qtype 是 paper-* 的來自測驗卷，其餘當成句子練習；單字作答當成單字測驗（舊資料分不出測驗卷裡的單字題）。 */
function sources(db){
  db.exec(`
    ALTER TABLE attempts ADD COLUMN source TEXT;
    ALTER TABLE word_attempts ADD COLUMN source TEXT;
    UPDATE attempts SET source = CASE WHEN qtype LIKE 'paper-%' THEN 'exam' ELSE 'practice' END;
    UPDATE word_attempts SET source = 'quiz';
    CREATE INDEX idx_attempts_source ON attempts(user_token, source);
    CREATE INDEX idx_wattempts_source ON word_attempts(user_token, source);
  `);
}

/** 第 6 版：登入 session 記下角色（teacher | student）。既有的 session 都是以前唯一那組帳密登入的，視為老師。 */
function sessionRoles(db){
  db.exec(`ALTER TABLE sessions ADD COLUMN role TEXT NOT NULL DEFAULT 'teacher';`);
}

/** 第 7 版：申請單（花費關卡）。學生要花額度的操作先開一張申請單，老師核准後才在背景執行。
 *  status：pending 待審 | approved 已核准等待執行 | running 執行中 | done 完成 | failed 失敗 | rejected 被拒絕 | cancelled 學生撤回 */
function jobs(db){
  db.exec(`
    CREATE TABLE jobs (
      id           TEXT PRIMARY KEY,
      kind         TEXT NOT NULL,             -- analyze | ocr | wordset | ai-grade
      status       TEXT NOT NULL,
      dedup        TEXT,                      -- 同一件事重複送出時合併成一張（kind + 內容的雜湊）
      payload      TEXT NOT NULL,             -- 執行時要重送的請求內容（JSON）
      quote        TEXT,                      -- 報價（只有老師看得到）
      summary      TEXT,                      -- 列表上看的一行說明
      requested_by TEXT NOT NULL,
      note         TEXT,                      -- 老師的備註（拒絕理由）
      result       TEXT,                      -- 執行結果（JSON）
      cost_usd     REAL DEFAULT 0,
      created_at   INTEGER NOT NULL,
      decided_at   INTEGER,
      started_at   INTEGER,
      finished_at  INTEGER
    );
    CREATE INDEX idx_jobs_status ON jobs(status, created_at);
    CREATE INDEX idx_jobs_dedup ON jobs(dedup, status);
  `);
}

/** 第 8 版：請求紀錄記下是哪個角色做的。學生每天免審的照片辨識張數靠這個算。 */
function requestRoles(db){
  db.exec(`ALTER TABLE requests ADD COLUMN by_role TEXT;`);
}

/** 第 9 版：老師可以把分析有誤的句子標成「排除出題」。句子仍在快取裡（畫面照常顯示），只是練習與測驗卷不再用它出題。 */
function sentenceExcluded(db){
  db.exec(`ALTER TABLE sentences ADD COLUMN excluded INTEGER NOT NULL DEFAULT 0;`);
}

export const MIGRATIONS = [
  { version: 1, name: 'baseline', up: baseline },
  { version: 2, name: 'articles', up: articles },
  { version: 3, name: 'papers-and-questions', up: papers },
  { version: 4, name: 'sessions', up: sessions },
  { version: 5, name: 'attempt-sources', up: sources },
  { version: 6, name: 'session-roles', up: sessionRoles },
  { version: 7, name: 'jobs', up: jobs },
  { version: 8, name: 'request-roles', up: requestRoles },
  { version: 9, name: 'sentence-excluded', up: sentenceExcluded },
];
