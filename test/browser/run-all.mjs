// 依序跑所有瀏覽器測試，最後列出每一支的結果。
//   BASE=http://127.0.0.1:8788/ node --no-warnings test/browser/run-all.mjs
// 要先把伺服器跑起來；測試會連到「你本機的資料庫」，所以用開發版（8788）測，不要碰正式服務。
import { spawnSync } from 'node:child_process';
import { readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const dir = fileURLToPath(new URL('./', import.meta.url));
const SKIP = new Set(['run-all.mjs', '_env.mjs', 'shot.mjs']);          // shot 只是抓圖給人看，沒有斷言
const only = process.argv.slice(2);
const files = readdirSync(dir).filter(f => f.endsWith('.mjs') && !SKIP.has(f) && (!only.length || only.includes(f.replace('.mjs', '')))).sort();
const rows = [];
for (const f of files) {
  const t0 = Date.now();
  const r = spawnSync(process.execPath, ['--no-warnings', dir + f], { encoding: 'utf8', timeout: 180000, env: process.env });
  const out = (r.stdout || '') + (r.stderr || '');
  const fails = (out.match(/^\s*✗/gm) || []).length, passes = (out.match(/^\s*✓/gm) || []).length;
  const ok = r.status === 0 && !fails;
  rows.push({ f, ok, passes, fails, sec: ((Date.now() - t0) / 1000).toFixed(0), out });
  console.log(`${ok ? '✓' : '✗'} ${f.padEnd(20)} 通過 ${String(passes).padStart(3)}  失敗 ${fails}  ${((Date.now() - t0) / 1000).toFixed(0)}s${r.status !== 0 && !fails ? '  (結束碼 ' + r.status + ')' : ''}`);
}
for (const r of rows.filter(x => !x.ok)) { console.log(`\n--- ${r.f} 的輸出（最後 25 行）---`); console.log(r.out.trim().split('\n').slice(-25).join('\n')); }
const bad = rows.filter(x => !x.ok).length;
console.log(bad ? `\n${bad}/${rows.length} 支有問題` : `\n全部 ${rows.length} 支通過`);
process.exit(bad ? 1 : 0);
