import { openCache } from './cache.mjs';
import { autoSeed } from './cache-cli.mjs';
import { DB_FILE } from './config.mjs';

// 資料庫與快取：整個伺服器共用一份連線。

export const cache = openCache(DB_FILE);
export const seeded = autoSeed(cache);
// 題目（含答案）存進 SQLite，不放記憶體 —— 伺服器重啟時，
// 作答到一半的人才不會按交卷就看到「這份測驗已失效」。
