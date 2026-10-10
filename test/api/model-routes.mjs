// 「會呼叫模型」的路由測試：用假的 Claude CLI（test/fake-claude.mjs），完整跑過分析串流、拍照辨識、建字表，
// 不花任何額度。重構拆檔前後都要通過。
// 跑法：node --no-warnings test/api/model-routes.mjs
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, readFileSync, existsSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:net';
import { fileURLToPath } from 'node:url';

const ROOT = join(fileURLToPath(new URL('.', import.meta.url)), '..', '..');
const FAKE = join(ROOT, 'test', 'fake-claude.mjs');
const tmp = mkdtempSync(join(tmpdir(), 'peater-model-'));
const wait = ms => new Promise(r => setTimeout(r, ms));
const freePort = () => new Promise(res => { const s = createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)); }); });

async function start(name, env = {}) {
  const port = await freePort();
  const dir = join(tmp, name); const log = join(dir, 'calls.jsonl'), counter = join(dir, 'counter');
  const { mkdirSync } = await import('node:fs'); mkdirSync(dir, { recursive: true });
  const child = spawn(process.execPath, ['--no-warnings', 'src/server.mjs'], {
    cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, PORT: String(port), HOST: '127.0.0.1', DB_FILE: join(dir, 'cache.db'),
      CLAUDE_BIN: process.execPath, CLAUDE_ARGS_PREFIX: JSON.stringify([FAKE]), FAKE_LOG: log, FAKE_COUNTER: counter, ...env },
  });
  let out = ''; child.stdout.on('data', d => out += d); child.stderr.on('data', d => out += d);
  const base = `http://127.0.0.1:${port}`;
  for (let i = 0; i < 60; i++) { try { if ((await fetch(base + '/api/health')).ok) break; } catch {} await wait(200); }
  const calls = () => existsSync(log) ? readFileSync(log, 'utf8').trim().split('\n').filter(Boolean).map(l => JSON.parse(l)) : [];
  return { base, child, calls, out: () => out };
}
const J = async (base, path, opt = {}) => {
  const r = await fetch(base + path, { ...opt, headers: { 'content-type': 'application/json' }, body: opt.body === undefined ? undefined : JSON.stringify(opt.body) });
  const text = await r.text(); let json = null; try { json = JSON.parse(text); } catch {}
  return { status: r.status, json, text };
};
/** 讀 SSE：回傳 [{event, data}]，遇到 done / halted 以外也一路讀到連線結束 */
async function sse(base, path, body) {
  const r = await fetch(base + path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const ct = r.headers.get('content-type') || '';
  if (!ct.includes('event-stream')) return { status: r.status, json: await r.json().catch(() => null), events: [] };
  const text = await r.text(); const events = [];
  for (const block of text.split('\n\n')) {
    const ev = /^event: (.+)$/m.exec(block)?.[1]; const data = /^data: (.+)$/m.exec(block)?.[1];
    if (ev && data) events.push({ event: ev, data: JSON.parse(data) });
  }
  return { status: r.status, events };
}
const evs = (r, name) => r.events.filter(e => e.event === name).map(e => e.data);
const png = 'data:image/png;base64,' + Buffer.concat([Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]), Buffer.alloc(200)]).toString('base64');

const results = [];
const chk = (name, cond, detail = '') => { results.push(Boolean(cond)); console.log(`  ${cond ? '✓' : '✗'} ${name}${cond ? '' : '  ' + detail}`); };
const fresh = (tag, n) => Array.from({ length: n }, (_, i) => `${tag} number ${i + 1} walks home.`);

const servers = [];
try {
  const S = await start('main'); servers.push(S); const B = S.base;

  console.log('分析串流（逐句呼叫、快取、報價）');
  const text5 = fresh('Alpha', 5).join(' ');
  let r = await sse(B, '/api/analyze', { text: text5 });
  chk('SSE：meta → 5 句 → done', r.status === 200 && evs(r, 'meta')[0]?.total === 5 && evs(r, 'sentence').length === 5 && evs(r, 'done').length === 1, JSON.stringify(r.events.map(e => e.event)));
  chk('done：分析 5、快取 0、失敗 0、有花費', evs(r, 'done')[0].analyzed === 5 && evs(r, 'done')[0].cached === 0 && evs(r, 'done')[0].failed === 0 && evs(r, 'done')[0].usage.costUsd > 0, JSON.stringify(evs(r, 'done')[0]));
  chk('每句都是新分析（cached:false）、結構完整', evs(r, 'sentence').every(s => s.cached === false && s.sentence.clauses?.[0]?.pattern?.id === 1 && s.sentence.words?.length > 0));
  chk('逐句呼叫：呼叫了 5 次、每次 1 句', S.calls().length === 5 && S.calls().every(c => c.kind === 'analyze' && c.sentences === 1), JSON.stringify(S.calls()));
  r = await sse(B, '/api/analyze', { text: text5 });
  chk('同樣的文字再送：全部命中快取、不再呼叫', evs(r, 'done')[0].cached === 5 && evs(r, 'done')[0].analyzed === 0 && S.calls().length === 5, JSON.stringify(evs(r, 'done')[0]));
  chk('快取命中先推出（cached:true）', evs(r, 'sentence').every(s => s.cached === true));
  r = await J(B, '/api/analyze', { method: 'POST', body: { text: text5, dryRun: true } });
  chk('報價：已全部快取 → 待分析 0', r.json.toAnalyze === 0 && r.json.cached === 5);
  r = await sse(B, '/api/analyze', { text: [...fresh('Alpha', 3), ...fresh('Bravo', 2)].join(' ') });
  chk('3 句舊的 + 2 句新的：快取 3、分析 2', evs(r, 'done')[0].cached === 3 && evs(r, 'done')[0].analyzed === 2, JSON.stringify(evs(r, 'done')[0]));

  console.log('文章模式：超過一般上限也能整篇分析');
  r = await sse(B, '/api/analyze', { text: fresh('Charlie', 30).join(' ') });
  chk('一般模式 30 句 → 截斷成 25 句', evs(r, 'meta')[0].truncated === true && evs(r, 'meta')[0].total === 25, JSON.stringify(evs(r, 'meta')[0]));
  r = await sse(B, '/api/analyze', { text: fresh('Delta', 40).join(' '), article: true });
  chk('文章模式 40 句 → 全部分析', evs(r, 'meta')[0].total === 40 && evs(r, 'meta')[0].truncated === false && evs(r, 'done')[0].analyzed === 40 && evs(r, 'meta')[0].article === true, JSON.stringify(evs(r, 'done')[0]));
  r = await sse(B, '/api/analyze', { text: fresh('Delta', 40).join(' '), article: true });
  chk('同一篇文章再送一次：全部從快取接續', evs(r, 'done')[0].cached === 40 && evs(r, 'done')[0].analyzed === 0);

  console.log('拍照辨識');
  r = await J(B, '/api/analyze-ocr', { method: 'POST', body: { image: png } });
  chk('analyze-ocr 回傳辨識文字與花費', r.status === 200 && r.json.text === 'I like cats.\nShe runs fast.' && r.json.usage?.costUsd > 0, r.text.slice(0, 160));
  r = await J(B, '/api/wordset-ocr', { method: 'POST', body: { image: png } });
  chk('wordset-ocr 回傳單字與可編輯文字', r.status === 200 && r.json.words?.length === 3 && /apple, 蘋果/.test(r.json.text), r.text.slice(0, 160));
  const tmpDir = join(ROOT, 'data', 'tmp');
  chk('辨識用的暫存圖片已清掉', !existsSync(tmpDir) || readdirSync(tmpDir).filter(f => f.startsWith('ocr-')).length === 0, existsSync(tmpDir) ? readdirSync(tmpDir).join(',') : '');

  console.log('建立字表（模型整理）與字表例句分析（批次）');
  r = await J(B, '/api/wordsets', { method: 'POST', body: { name: 'FakeSet', text: 'dog, 狗\ncat, 貓' } });
  chk('建立字表：2 個字', r.status === 200 && r.json.count === 2 && r.json.name === 'FakeSet' && r.json.id > 0, r.text.slice(0, 160));
  const setId = r.json.id;
  r = await J(B, '/api/wordsets');
  chk('字表列表看得到，字數 2', r.json.sets.some(s => s.id === setId && s.word_count === 2));
  r = await J(B, '/api/wordsets', { method: 'POST', body: { appendTo: setId, text: 'dog\nbird, 鳥' } });
  chk('附加：重複的字略過、只新增 1 個', r.status === 200 && r.json.count === 1 && r.json.skipped === 1 && r.json.appended === true, r.text.slice(0, 160));
  r = await J(B, '/api/wordsets', { method: 'POST', body: { appendTo: setId, text: 'dog\ncat' } });
  chk('附加：全部重複 → 不呼叫模型、count 0', r.status === 200 && r.json.count === 0 && /都已經有了/.test(r.json.message || ''), r.text.slice(0, 160));
  const before = S.calls().length;
  r = await sse(B, '/api/wordset-analyze', { setIds: [setId] });
  const wdone = evs(r, 'done')[0] ?? r.events.at(-1)?.data;
  chk('字表例句分析：用批次呼叫（3 句只呼叫 1 次）', S.calls().length === before + 1 && S.calls().at(-1).sentences === 3, JSON.stringify(S.calls().slice(before)));
  chk('字表例句分析：串流有完成事件', r.events.length > 0 && JSON.stringify(wdone).includes('3'), JSON.stringify(r.events.map(e => e.event)));
  r = await J(B, '/api/wordset-analyze', { method: 'POST', body: { setIds: [setId] } });
  chk('再分析一次：例句都已快取 → 不呼叫', r.status === 200 && (r.json?.analyzed === 0 || r.json?.cached === 3) && S.calls().length === before + 1, r.text.slice(0, 160));
  r = await J(B, '/api/history');
  const kinds = new Set(r.json.items.map(i => i.kind));
  chk('歷史紀錄有分析、字表、辨識的紀錄', kinds.has('analyze') && kinds.has('wordset') && r.json.usage.all.cost_usd > 0, JSON.stringify([...kinds]) + ' ' + r.json.usage?.all?.cost_usd);

  console.log('失敗情況');
  const F = await start('ratelimit', { FAKE_FAIL_AFTER: '2' }); servers.push(F);
  r = await sse(F.base, '/api/analyze', { text: fresh('Echo', 8).join(' ') });
  const halted = evs(r, 'halted')[0], fd = evs(r, 'done')[0];
  chk('額度用盡 → 送出 halted(rate-limit)，不再硬試', halted?.kind === 'rate-limit' && fd?.halted === 'rate-limit', JSON.stringify(r.events.map(e => e.event)));
  chk('用盡前成功的 2 句已經存進快取', fd.analyzed === 2, JSON.stringify(fd));
  r = await J(F.base, '/api/analyze', { method: 'POST', body: { text: fresh('Echo', 8).join(' '), dryRun: true } });
  chk('之後重送會從快取接續（已快取 2、待分析 6）', r.json.cached === 2 && r.json.toAnalyze === 6, r.text.slice(0, 120));

  const G = await start('onefail', { FAKE_FAIL_MATCH: 'Explode' }); servers.push(G);
  r = await sse(G.base, '/api/analyze', { text: 'Fine one walks. Explode this sentence now. Fine two walks.' });
  const gd = evs(r, 'done')[0], gf = evs(r, 'failed');
  chk('單句失敗：其他句照常完成', gd.analyzed === 2 && gd.failed === 1 && gf.length === 1 && /Explode/.test(gf[0].original), JSON.stringify(gd));
  chk('失敗的那句沒有被存進快取', (await J(G.base, '/api/analyze', { method: 'POST', body: { text: 'Explode this sentence now.', dryRun: true } })).json.cached === 0);

  // 模型偶爾回一般文字（不是 JSON）：同一句自動再問一次，使用者不會看到失敗
  const H = await start('badjson', { FAKE_BAD_TEXT_FIRST: '1' }); servers.push(H);
  r = await sse(H.base, '/api/analyze', { text: 'People here speak Australian English.' });
  const hd = evs(r, 'done')[0];
  chk('第一次回非 JSON → 自動重試一次，最後成功、沒有失敗', hd.analyzed === 1 && hd.failed === 0 && evs(r, 'sentence').length === 1, JSON.stringify(hd));
  chk('兩次呼叫的花費都計入', hd.usage.costUsd >= 0.02, JSON.stringify(hd.usage));
} catch (e) {
  console.log('ERR', e.stack || e.message); results.push(false);
} finally {
  for (const s of servers) s.child.kill();
  await wait(400);
  try { rmSync(tmp, { recursive: true, force: true }); } catch {}
}
const fail = results.filter(x => !x).length;
console.log(fail ? `\n有失敗 (${fail}/${results.length})` : `\n全部通過 (${results.length})`);
process.exit(fail ? 1 : 0);
