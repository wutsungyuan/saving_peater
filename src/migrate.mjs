// 資料庫遷移引擎：零依賴（node:sqlite）。
//
// 版本號存在 SQLite 的 PRAGMA user_version。每次開啟資料庫時，把「版本號比目前大」的遷移依序套用：
//   - 套用前先備份整個資料庫（VACUUM INTO，產生一份獨立、完整的 .db），只保留最近幾份。
//   - 每一版在同一個交易裡執行；中途失敗就整版復原，資料庫停在上一個版本，並把錯誤丟出去。
//   - 資料庫的版本比程式還新（例如在舊分支開了新分支用過的資料庫）就直接拒絕，避免舊程式把新結構弄壞。
//   - 全新的空資料庫不備份（沒有東西可以失去）。

import { existsSync, mkdirSync, readdirSync, unlinkSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { MIGRATIONS } from './migrations.mjs';

const userVersion = db => Number(db.prepare('PRAGMA user_version').get().user_version);
const hasUserTables = db => db.prepare(
  "SELECT COUNT(*) n FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'").get().n > 0;

function checkList(migrations){
  let prev = 0;
  for (const m of migrations){
    if (!Number.isInteger(m.version) || m.version !== prev + 1)
      throw new Error(`遷移清單的版本號必須從 1 開始連續遞增，卻在 ${m.version} 前面是 ${prev}`);
    prev = m.version;
  }
  return prev;
}

const stamp = d => new Date(d).toISOString().replace(/[-:T]/g, '').slice(0, 14);

/** 備份到 <資料庫所在資料夾>/backups/，檔名帶來源版本與時間。回傳路徑。 */
function backup(db, file, from, keep, now){
  const dir = join(dirname(file), 'backups');
  mkdirSync(dir, { recursive: true });
  const base = basename(file, '.db');
  let path = join(dir, `${base}.v${from}-${stamp(now)}.db`);
  for (let i = 2; existsSync(path); i++) path = join(dir, `${base}.v${from}-${stamp(now)}-${i}.db`);
  db.exec(`VACUUM INTO '${path.replace(/'/g, "''")}'`);
  // 只留最近 keep 份。依檔名裡的時間戳記（再依同秒的序號）排序，不靠檔案修改時間，
  // 因為連續快速備份時修改時間可能相同。
  const key = f => { const m = /-(\d{14})(?:-(\d+))?\.db$/.exec(f); return m ? m[1] + String(m[2] || 1).padStart(4, '0') : ''; };
  const mine = readdirSync(dir).filter(f => f.startsWith(base + '.v') && key(f))
    .sort((a, b) => key(b).localeCompare(key(a)));
  for (const old of mine.slice(keep)) { try { unlinkSync(join(dir, old)); } catch {} }
  return path;
}

/**
 * @param db        DatabaseSync
 * @param opts.file       資料庫檔案路徑；':memory:' 或沒給就不備份
 * @param opts.migrations 預設用 migrations.mjs；測試可以傳自己的
 * @param opts.keep       備份保留份數，預設 5
 * @param opts.now        目前時間（測試用）
 * @returns { from, to, applied: [版本號], backup: 路徑或 null }
 */
export function migrate(db, { file, migrations = MIGRATIONS, keep = 5, now = Date.now() } = {}){
  const latest = checkList(migrations);
  const from = userVersion(db);
  if (from > latest)
    throw new Error(`資料庫的版本是 ${from}，比這份程式認得的最新版本 ${latest} 還新。` +
      `請改用較新的程式，或換一份資料庫；為了避免弄壞資料，這次沒有做任何修改。`);
  const pending = migrations.filter(m => m.version > from);
  if (!pending.length) return { from, to: from, applied: [], backup: null };

  const real = file && file !== ':memory:' && existsSync(file);
  const path = real && hasUserTables(db) ? backup(db, file, from, keep, now) : null;

  const applied = [];
  for (const m of pending){
    db.exec('BEGIN');
    try {
      m.up(db);
      db.exec(`PRAGMA user_version = ${m.version}`);
      db.exec('COMMIT');
    } catch (e){
      try { db.exec('ROLLBACK'); } catch {}
      const err = new Error(`資料庫遷移第 ${m.version} 版（${m.name}）失敗，已復原：${e.message}` +
        (path ? `。升級前的備份在 ${path}` : ''));
      err.cause = e; err.version = m.version; err.backup = path;
      throw err;
    }
    applied.push(m.version);
  }
  return { from, to: applied[applied.length - 1], applied, backup: path };
}

export { userVersion };
