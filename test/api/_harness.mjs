// API 測試的共用輔助：開暫時的伺服器（可接假的 Claude CLI）、打 API、讀 SSE、斷言與收尾。
import { spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:net';
import { fileURLToPath } from 'node:url';

export const ROOT = join(fileURLToPath(new URL('.', import.meta.url)), '..', '..');
export const FAKE = join(ROOT, 'test', 'fake-claude.mjs');
export const tmp = mkdtempSync(join(tmpdir(), 'peater-t-'));
export const wait = ms => new Promise(r => setTimeout(r, ms));
const freePort = () => new Promise(res => { const s = createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)); }); });

const servers = [];
/** 開一個伺服器。預設接假的 Claude CLI；env 可注入 FAKE_*、AUTH_TOKEN 等。dbFile 可共用同一個資料庫。 */
export async function start(name, env = {}, { dbFile } = {}) {
  const port = await freePort();
  const dir = join(tmp, name); mkdirSync(dir, { recursive: true });
  const log = join(dir, 'calls.jsonl'), counter = join(dir, 'counter');
  const child = spawn(process.execPath, ['--no-warnings', 'src/server.mjs'], {
    cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, PORT: String(port), HOST: '127.0.0.1', DB_FILE: dbFile || join(dir, 'cache.db'),
      CLAUDE_BIN: process.execPath, CLAUDE_ARGS_PREFIX: JSON.stringify([FAKE]), FAKE_LOG: log, FAKE_COUNTER: counter, ...env },
  });
  let out = ''; child.stdout.on('data', d => out += d); child.stderr.on('data', d => out += d);
  const base = `http://127.0.0.1:${port}`;
  let up = false;
  for (let i = 0; i < 60 && !up; i++) { try { up = (await fetch(base + '/api/health')).ok; } catch {} if (!up) await wait(200); }
  if (!up) { child.kill(); throw new Error('伺服器沒有起來：' + out); }
  const s = {
    base, child, out: () => out, dbFile: dbFile || join(dir, 'cache.db'),
    calls: () => existsSync(log) ? readFileSync(log, 'utf8').trim().split('\n').filter(Boolean).map(l => JSON.parse(l)) : [],
    /** 打 API，token 預設帶上（有設 AUTH_TOKEN 才需要） */
    j: (path, opt = {}) => J(base, path, { token: env.AUTH_TOKEN, ...opt }),
    sse: (path, body) => sse(base, path, body, env.AUTH_TOKEN),
  };
  servers.push(s);
  return s;
}

export async function J(base, path, opt = {}) {
  const { token, headers, body, ...rest } = opt;
  const r = await fetch(base + path, {
    ...rest,
    headers: { 'content-type': 'application/json', ...(token ? { 'x-auth-token': token } : {}), ...(headers || {}) },
    body: body === undefined ? undefined : (typeof body === 'string' ? body : JSON.stringify(body)),
  });
  const text = await r.text(); let json = null; try { json = JSON.parse(text); } catch {}
  return { status: r.status, json, text, headers: r.headers };
}

/** 讀 SSE：回傳 { status, events:[{event,data}] }；不是串流就回 json */
export async function sse(base, path, body, token) {
  const r = await fetch(base + path, { method: 'POST', headers: { 'content-type': 'application/json', ...(token ? { 'x-auth-token': token } : {}) }, body: JSON.stringify(body) });
  if (!(r.headers.get('content-type') || '').includes('event-stream')) return { status: r.status, json: await r.json().catch(() => null), events: [] };
  const text = await r.text(); const events = [];
  for (const block of text.split('\n\n')) {
    const ev = /^event: (.+)$/m.exec(block)?.[1]; const data = /^data: (.+)$/m.exec(block)?.[1];
    if (ev && data) events.push({ event: ev, data: JSON.parse(data) });
  }
  return { status: r.status, events };
}
export const evs = (r, name) => r.events.filter(e => e.event === name).map(e => e.data);

const results = [];
export const section = title => console.log(title);
export const chk = (name, cond, detail = '') => { results.push(Boolean(cond)); console.log(`  ${cond ? '✓' : '✗'} ${name}${cond ? '' : '  ' + String(detail).slice(0, 300)}`); };
export const fresh = (tag, n) => Array.from({ length: n }, (_, i) => `${tag} number ${i + 1} walks home.`);

/** 只關伺服器與清暫存，不結束程序（瀏覽器測試自己印結果） */
export async function shutdown() {
  for (const s of servers) s.child.kill();
  await wait(400);
  try { rmSync(tmp, { recursive: true, force: true }); } catch {}
}

/** 收尾：關伺服器、清暫存、印結果並結束 */
export async function finish(err) {
  if (err) { console.log('ERR', err.stack || err.message); results.push(false); }
  await shutdown();
  const fail = results.filter(x => !x).length;
  console.log(fail ? `\n有失敗 (${fail}/${results.length})` : `\n全部通過 (${results.length})`);
  process.exit(fail ? 1 : 0);
}
