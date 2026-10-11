#!/usr/bin/env node
// 快取可攜工具：匯出成 JSONL 帶著走，到新機器匯入。
// 用法:
//   node src/cache-cli.mjs export [檔案] [--since YYYY-MM-DD]
//   node src/cache-cli.mjs import <檔案> [--force]
//   node src/cache-cli.mjs seed            # 匯出成 fixtures/seed-cache.jsonl（進版控，新機器自動載入）
//   node src/cache-cli.mjs prune <天數>
//   node src/cache-cli.mjs info
//   node src/cache-cli.mjs users                          # 列出作答紀錄用過的使用者代碼
//   node src/cache-cli.mjs merge-users <目標> <來源...>   # 把來源代碼的紀錄合併到目標（例如 student）；先備份

import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { openCache } from './cache.mjs';

const ROOT = join(fileURLToPath(new URL('.', import.meta.url)), '..');
export const SEED_FILE = join(ROOT, 'fixtures', 'seed-cache.jsonl');
const DB = join(ROOT, 'data', 'cache.db');

const toJsonl = rows => rows.map(r => JSON.stringify(r)).join('\n') + '\n';
const fromJsonl = txt => txt.split('\n').filter(l => l.trim()).map(l => JSON.parse(l));

/** 新機器首次啟動時自動載入種子（伺服器會呼叫） */
export function autoSeed(cache, seedFile = SEED_FILE){
  if (cache.count() > 0 || !existsSync(seedFile)) return null;
  const rows = fromJsonl(readFileSync(seedFile, 'utf8'));
  const r = cache.importRows(rows);
  return r.added ? r : null;
}

function main(){
  const [cmd, ...rest] = process.argv.slice(2);
  const flag = n => rest.includes(`--${n}`);
  const val  = n => { const i = rest.indexOf(`--${n}`); return i === -1 ? null : rest[i + 1]; };
  const positional = rest.filter((a, i) => !a.startsWith('--') && !(i > 0 && rest[i - 1].startsWith('--')));
  const cache = openCache(DB);

  if (cmd === 'export' || cmd === 'seed'){
    const file = cmd === 'seed' ? SEED_FILE : (positional[0] || join(ROOT, 'cache-export.jsonl'));
    const sinceStr = val('since');
    const since = sinceStr ? Date.parse(sinceStr) : 0;
    if (sinceStr && Number.isNaN(since)){ console.error(`--since 日期格式錯誤: ${sinceStr}`); process.exit(1); }
    const rows = cache.exportAll({ since });
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, toJsonl(rows));
    console.log(`匯出 ${rows.length} 句 → ${file}`);
    if (cmd === 'seed') console.log('這個檔案可以進版控，新機器首次啟動會自動載入。');

  } else if (cmd === 'import'){
    const file = positional[0];
    if (!file){ console.error('用法: import <檔案> [--force]'); process.exit(1); }
    const rows = fromJsonl(readFileSync(file, 'utf8'));
    const r = cache.importRows(rows, { force: flag('force') });
    console.log(`匯入 ${r.total} 句：新增 ${r.added}、已存在而合併命中數 ${r.merged}、覆蓋 ${r.replaced}、格式錯誤 ${r.bad}`);
    console.log(`目前共 ${cache.count()} 句`);

  } else if (cmd === 'prune'){
    const days = Number(positional[0]);
    if (!Number.isFinite(days) || days <= 0){ console.error('用法: prune <天數>'); process.exit(1); }
    console.log(`刪除 ${cache.prune(days)} 句（超過 ${days} 天），剩 ${cache.count()} 句`);

  } else if (cmd === 'info'){
    cache.checkpoint();
    const st = cache.stats();
    console.log(`資料庫  ${DB}`);
    console.log(`句子數  ${st.sentences}｜快取命中 ${st.cache_hits} 次｜請求 ${st.requests} 次`);
    console.log(`句型分佈 ${st.patterns.map(p => `句型${p.pattern_id}:${p.n}`).join('  ') || '—'}`);
    console.log(`WAL 已 checkpoint，現在可以安全直接複製 data/cache.db`);

  } else if (cmd === 'users'){
    const fmt = t => t ? new Date(t).toLocaleString('zh-TW') : '—';
    const list = cache.userTokens();
    if (!list.length) console.log('還沒有作答紀錄。');
    for (const u of list) console.log(`${u.token.padEnd(14)} 句子作答 ${String(u.sentences).padStart(4)}　單字作答 ${String(u.words).padStart(4)}　${fmt(u.first)} ～ ${fmt(u.last)}`);

  } else if (cmd === 'merge-users'){
    const [target, ...from] = positional;
    if (!target || !from.length){ console.error('用法: merge-users <目標代碼> <來源代碼...>（例如 merge-users student u9luzosss ubfle0go0）'); process.exit(1); }
    const known = new Set(cache.userTokens().map(u => u.token));
    const missing = from.filter(t => !known.has(t));
    if (missing.length){ console.error(`找不到這些代碼：${missing.join('、')}（用 users 看有哪些）`); process.exit(1); }
    // 合併前先備份整個資料庫（VACUUM INTO），出錯或合併錯人都能還原
    const dir = join(dirname(DB), 'backups'); mkdirSync(dir, { recursive: true });
    const path = join(dir, `cache.before-merge-${new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14)}.db`);
    cache.db.exec(`VACUUM INTO '${path.replace(/'/g, "''")}'`);
    const r = cache.mergeUsers(target, from);
    console.log(`已備份到 ${path}`);
    console.log(`合併 ${from.length} 個代碼 → ${target}：句子作答 ${r.attempts} 筆、單字作答 ${r.wordAttempts} 筆、單字熟練度 ${r.progress} 個字`);

  } else {
    console.log(`快取可攜工具

  export [檔案] [--since YYYY-MM-DD]   匯出成 JSONL
  import <檔案> [--force]              匯入（預設保留本機既有，只合併命中數）
  seed                                 匯出到 fixtures/seed-cache.jsonl（進版控，新機器自動載入）
  prune <天數>                         刪除超過天數的紀錄
  info                                 狀態，並 checkpoint WAL 讓 .db 可直接複製
  users                                列出作答紀錄用過的使用者代碼（各有多少作答、何時）
  merge-users <目標> <來源...>         把來源代碼的紀錄合併到目標；先備份整個資料庫`);
  }
  cache.close();
}

if (import.meta.url === `file://${process.argv[1]}`) main();
