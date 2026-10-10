// 資料庫遷移引擎測試：全新、既有（沒有版本號）、很舊（缺欄位）、失敗復原、版本太新、備份保留份數。
// 跑法：node --no-warnings test/migrate.mjs
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, existsSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, basename } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { migrate, userVersion } from '../src/migrate.mjs';
import { MIGRATIONS } from '../src/migrations.mjs';
import { openCache } from '../src/cache.mjs';

const tmp = mkdtempSync(join(tmpdir(), 'peater-mig-'));
const results = [];
const t = async (name, fn) => {
  try { await fn(); results.push(true); console.log(`  ✓ ${name}`); }
  catch (e) { results.push(false); console.log(`  ✗ ${name}\n      ${e.message.split('\n')[0]}`); }
};
const fresh = name => join(tmp, name);
const tables = db => db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all().map(r => r.name);
const colsOf = (db, tbl) => new Set(db.prepare(`PRAGMA table_info(${tbl})`).all().map(c => c.name));
// 備份資料夾由同一個資料夾裡的資料庫共用，所以只算「這個檔案」的備份（檔名以它的名字開頭）
const backups = file => {
  const d = join(file, '..', 'backups'), base = basename(file, '.db') + '.v';
  return existsSync(d) ? readdirSync(d).filter(f => f.startsWith(base)).sort() : [];
};
const LATEST = MIGRATIONS.at(-1).version;

console.log('全新資料庫');
await t('建立全部結構、版本號到最新、不產生備份', () => {
  const f = fresh('new.db'); const db = new DatabaseSync(f);
  const r = migrate(db, { file: f });
  assert.equal(r.from, 0); assert.equal(r.to, LATEST); assert.equal(r.backup, null);
  assert.equal(userVersion(db), LATEST);
  for (const need of ['sentences', 'attempts', 'wordsets', 'words', 'word_attempts', 'word_progress', 'requests', 'quizzes'])
    assert.ok(tables(db).includes(need), '缺少 ' + need);
  assert.equal(backups(f).length, 0);
  db.close();
});
await t('在記憶體資料庫也能跑（不備份）', () => {
  const db = new DatabaseSync(':memory:');
  const r = migrate(db, { file: ':memory:' });
  assert.equal(r.to, LATEST); assert.equal(r.backup, null);
});

console.log('既有資料庫（結構是最新的，但還沒有版本號：正式機現在的狀態）');
await t('套用後有版本號、資料原封不動、升級前先備份', () => {
  const f = fresh('legacy.db'); let db = new DatabaseSync(f);
  MIGRATIONS[0].up(db);                                   // 模擬：用舊程式建好的資料庫，user_version 還是 0
  db.prepare("INSERT INTO sentences (hash, original, result, model, created_at) VALUES ('h1','I like cats.','{}','opus',1)").run();
  db.prepare("INSERT INTO wordsets (name, created_at) VALUES ('Unit1', 1)").run();
  assert.equal(userVersion(db), 0);
  const r = migrate(db, { file: f });
  assert.equal(r.from, 0); assert.equal(r.to, LATEST); assert.ok(r.backup && existsSync(r.backup));
  assert.equal(db.prepare('SELECT COUNT(*) n FROM sentences').get().n, 1);
  // 備份本身是一份能獨立開啟、內容完整的資料庫
  const b = new DatabaseSync(r.backup, { readOnly: true });
  assert.equal(b.prepare('SELECT original FROM sentences').get().original, 'I like cats.');
  assert.equal(b.prepare('SELECT name FROM wordsets').get().name, 'Unit1');
  b.close(); db.close();
});
await t('再開一次不會重複備份，也不會重複遷移', () => {
  const f = fresh('legacy.db'); const db = new DatabaseSync(f);
  const before = backups(f).length;
  const r = migrate(db, { file: f });
  assert.deepEqual(r.applied, []); assert.equal(r.backup, null);
  assert.equal(backups(f).length, before);
  db.close();
});
await t('經過 openCache 開啟也一樣（正式伺服器走的路）', () => {
  const f = fresh('viacache.db'); let db = new DatabaseSync(f);
  MIGRATIONS[0].up(db); db.prepare("INSERT INTO sentences (hash, original, result, model, created_at) VALUES ('h','Hi.','{}','m',1)").run(); db.close();
  const c = openCache(f);
  assert.equal(c.stats().sentences, 1);
  const chk = new DatabaseSync(f, { readOnly: true });
  assert.equal(userVersion(chk), LATEST); assert.equal(backups(f).length, 1); chk.close();
});

console.log('很舊的資料庫（缺很多欄位）');
await t('補齊欄位、舊資料不遺失', () => {
  const f = fresh('old.db'); const db = new DatabaseSync(f);
  db.exec(`
    CREATE TABLE sentences (hash TEXT PRIMARY KEY, original TEXT NOT NULL, result TEXT NOT NULL, model TEXT NOT NULL,
      pattern_id INTEGER, tense_time TEXT, tense_aspect TEXT, in_scope INTEGER, issue TEXT,
      created_at INTEGER NOT NULL, hits INTEGER NOT NULL DEFAULT 0);
    CREATE TABLE requests (id INTEGER PRIMARY KEY AUTOINCREMENT, chars INTEGER, sentences INTEGER, cached INTEGER,
      analyzed INTEGER, ms INTEGER, created_at INTEGER NOT NULL);
    CREATE TABLE attempts (id INTEGER PRIMARY KEY AUTOINCREMENT, user_token TEXT NOT NULL, qtype TEXT NOT NULL,
      sentence_hash TEXT, pattern_id INTEGER, tense_time TEXT, tense_aspect TEXT, pos TEXT, correct INTEGER NOT NULL,
      answer TEXT, expected TEXT, created_at INTEGER NOT NULL);
    CREATE TABLE word_attempts (id INTEGER PRIMARY KEY AUTOINCREMENT, user_token TEXT NOT NULL, word_id INTEGER NOT NULL,
      sense_idx INTEGER, mode TEXT NOT NULL, correct INTEGER NOT NULL, answer TEXT, expected TEXT, created_at INTEGER NOT NULL);
    INSERT INTO sentences (hash, original, result, model, created_at) VALUES ('old1', 'She runs.', '{}', 'opus', 5);
    INSERT INTO requests (chars, sentences, created_at) VALUES (10, 1, 6);
    INSERT INTO attempts (user_token, qtype, correct, created_at) VALUES ('u', 'pattern', 1, 7);
  `);
  migrate(db, { file: f });
  for (const c of ['speaker', 'context', 'cost_usd', 'input_tokens']) assert.ok(colsOf(db, 'sentences').has(c), 'sentences 缺 ' + c);
  for (const c of ['text', 'kind', 'ref_id', 'cost_usd', 'cache_read_tokens']) assert.ok(colsOf(db, 'requests').has(c), 'requests 缺 ' + c);
  for (const c of ['pron_case', 'is_fix']) assert.ok(colsOf(db, 'attempts').has(c), 'attempts 缺 ' + c);
  assert.ok(colsOf(db, 'word_attempts').has('is_fix'));
  assert.equal(db.prepare("SELECT original FROM sentences WHERE hash='old1'").get().original, 'She runs.');
  assert.equal(db.prepare('SELECT chars FROM requests').get().chars, 10);
  assert.equal(db.prepare("SELECT COALESCE(is_fix,0) f FROM attempts").get().f, 0);
  db.close();
});

console.log('失敗與保護');
const mk = (n, sql, fail) => ({ version: n, name: 'v' + n, up(db) { db.exec(sql); if (fail) throw new Error('故意失敗'); } });
await t('某一版失敗：整版復原、停在上一版、錯誤帶版本與備份路徑', () => {
  const f = fresh('fail.db'); const db = new DatabaseSync(f);
  migrate(db, { file: f, migrations: [mk(1, 'CREATE TABLE a (x INTEGER); INSERT INTO a VALUES (1);')] });
  let err;
  try { migrate(db, { file: f, migrations: [mk(1, ''), mk(2, 'CREATE TABLE b (y INTEGER); ALTER TABLE a ADD COLUMN z TEXT;', true)] }); }
  catch (e) { err = e; }
  assert.ok(err, '應該要丟錯'); assert.match(err.message, /第 2 版/); assert.equal(err.version, 2);
  assert.equal(userVersion(db), 1);
  assert.ok(!tables(db).includes('b'), 'b 表應該被復原');
  assert.ok(!colsOf(db, 'a').has('z'), 'a.z 欄位應該被復原');
  assert.equal(db.prepare('SELECT x FROM a').get().x, 1);
  assert.ok(err.backup && existsSync(err.backup), '失敗前已經備份');
  db.close();
});
await t('第 N 版失敗時，前面成功的版本保留', () => {
  const f = fresh('partial.db'); const db = new DatabaseSync(f);
  let err;
  try { migrate(db, { file: f, migrations: [mk(1, 'CREATE TABLE a (x INTEGER);'), mk(2, 'CREATE TABLE b (y INTEGER);'), mk(3, 'CREATE TABLE c (z INTEGER);', true)] }); }
  catch (e) { err = e; }
  assert.equal(userVersion(db), 2); assert.ok(tables(db).includes('a') && tables(db).includes('b') && !tables(db).includes('c'));
  db.close();
});
await t('資料庫比程式還新 → 拒絕，且完全不修改', () => {
  const f = fresh('newer.db'); const db = new DatabaseSync(f);
  db.exec('CREATE TABLE keep (x INTEGER); INSERT INTO keep VALUES (42); PRAGMA user_version = 99;');
  assert.throws(() => migrate(db, { file: f }), /比這份程式認得的最新版本/);
  assert.equal(userVersion(db), 99); assert.equal(db.prepare('SELECT x FROM keep').get().x, 42);
  assert.equal(backups(f).length, 0);
  db.close();
});
await t('遷移清單的版本號必須連續', () => {
  const db = new DatabaseSync(':memory:');
  assert.throws(() => migrate(db, { file: ':memory:', migrations: [mk(1, ''), mk(3, '')] }), /連續/);
  assert.throws(() => migrate(db, { file: ':memory:', migrations: [mk(2, '')] }), /連續/);
});

console.log('備份保留份數');
await t('只留最近 keep 份，留下的是最新的', () => {
  const f = fresh('keep.db'); const db = new DatabaseSync(f);
  db.exec('CREATE TABLE seed (x INTEGER); INSERT INTO seed VALUES (1);');       // 有資料才會備份
  const list = [];
  for (let v = 1; v <= 5; v++) {
    list.push(mk(v, `CREATE TABLE t${v} (x INTEGER);`));
    migrate(db, { file: f, migrations: list.slice(), keep: 2, now: Date.UTC(2026, 9, 10, 12, v) });   // 每次差一分鐘
  }
  const left = backups(f);
  assert.equal(left.length, 2, '留下 ' + left.join(', '));
  assert.ok(left.every(n => /v3-|v4-/.test(n)), '應該留最新的兩份：' + left.join(', '));
  db.close();
});

try { rmSync(tmp, { recursive: true, force: true }); } catch {}
const fail = results.filter(x => !x).length;
console.log(fail ? `\n有失敗 (${fail}/${results.length})` : `\n全部通過 (${results.length})`);
process.exit(fail ? 1 : 0);
