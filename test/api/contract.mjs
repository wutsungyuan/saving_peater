// API 基準測試：只檢查「不呼叫模型」的路由，重構前後都要能通過。
// 自己開一個暫時的資料庫與伺服器，不碰正式資料；測完刪掉。
// 跑法：node --no-warnings test/api/contract.mjs
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:net';
import { fileURLToPath } from 'node:url';
import { openCache } from '../../src/cache.mjs';

const ROOT = join(fileURLToPath(new URL('.', import.meta.url)), '..', '..');
const tmp = mkdtempSync(join(tmpdir(), 'peater-api-'));
const DB = join(tmp, 'cache.db');

const freePort = () => new Promise(res => { const s = createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)); }); });
const wait = ms => new Promise(r => setTimeout(r, ms));

// ---- 先在暫時資料庫建一份字表（句子由伺服器啟動時自動載入種子）----
const W = (term, pos, zh, example, exampleZh, syllables) => ({
  term, syllables: syllables || term,
  senses: [{ pos, zh, example, exampleZh }], confusable: [], family: [],
});
{
  const c = openCache(DB);
  c.createWordset('測試字表', [
    W('apple', 'n', '蘋果', 'I eat an apple every day.', '我每天吃一顆蘋果。', 'ap-ple'),
    W('teach', 'v', '教導', 'She teaches English at school.', '她在學校教英文。'),
    W('lend', 'v', '借（出）', 'Can you lend me your pen?', '你可以借我你的筆嗎？'),
    W('cloudy', 'adj', '多雲的', 'It is cloudy this morning.', '今天早上多雲。', 'cloud-y'),
    W('season', 'n', '季節', 'Summer is my favorite season.', '夏天是我最喜歡的季節。', 'sea-son'),
    W('gloves', 'n', '手套', 'I wear gloves in winter.', '我冬天戴手套。'),
    W('quickly', 'adv', '快速地', 'He ran quickly to school.', '他很快跑到學校。', 'quick-ly'),
    W('ROC', 'n', '中華民國', 'The ROC flag is red, white, and blue.', '中華民國國旗是紅白藍三色。', 'R-O-C'),
  ]);
}

// ---- 啟動伺服器 ----
async function start(extraEnv = {}) {
  const port = await freePort();
  const child = spawn(process.execPath, ['--no-warnings', 'src/server.mjs'], {
    cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, PORT: String(port), HOST: '127.0.0.1', DB_FILE: DB, ...extraEnv },
  });
  let log = ''; child.stdout.on('data', d => log += d); child.stderr.on('data', d => log += d);
  const base = `http://127.0.0.1:${port}`;
  for (let i = 0; i < 60; i++) { try { const r = await fetch(base + '/api/health'); if (r.ok) return { base, child, log: () => log }; } catch {} await wait(200); }
  child.kill(); throw new Error('伺服器沒有起來：' + log);
}

const results = [];
const chk = (name, cond, detail = '') => { results.push(Boolean(cond)); console.log(`  ${cond ? '✓' : '✗'} ${name}${cond ? '' : '  ' + detail}`); };
const J = async (base, path, opt = {}) => {
  const r = await fetch(base + path, { ...opt, headers: { 'content-type': 'application/json', ...(opt.headers || {}) },
    body: opt.body === undefined ? undefined : (typeof opt.body === 'string' ? opt.body : JSON.stringify(opt.body)) });
  const text = await r.text(); let json = null; try { json = JSON.parse(text); } catch {}
  return { status: r.status, json, text, type: r.headers.get('content-type') || '' };
};

let main, authed;
try {
  main = await start();
  const B = main.base;

  console.log('基本與靜態檔');
  let r = await J(B, '/api/health');
  chk('health 回傳 ok 與設定', r.status === 200 && r.json.ok === true && r.json.maxSentences > 0 && r.json.authRequired === false);
  r = await J(B, '/');
  chk('首頁 200、是 HTML、有補上 doctype', r.status === 200 && r.type.includes('text/html') && /^<!doctype html>/i.test(r.text));
  r = await J(B, '/speech.js');
  chk('speech.js 200、是 JavaScript', r.status === 200 && r.type.includes('javascript'));
  r = await J(B, '/no-such-file.js');
  chk('不存在的檔案回 404', r.status === 404);
  r = await J(B, '/..%2f..%2fpackage.json');
  chk('路徑穿越不會讀到專案外的檔案', r.status !== 200 || !r.text.includes('grammar-analyzer'), `status ${r.status}`);

  console.log('唯讀 API');
  r = await J(B, '/api/stats');
  chk('stats 有句子數', r.status === 200 && typeof r.json.sentences === 'number' && r.json.sentences > 0, JSON.stringify(r.json)?.slice(0, 120));
  r = await J(B, '/api/samples');
  chk('samples 列出各類句子數', r.status === 200 && r.json.counts && typeof r.json.counts === 'object');
  const kind = Object.keys(r.json.counts || {}).find(k => r.json.counts[k] > 0);
  r = await J(B, `/api/samples?kind=${encodeURIComponent(kind)}&n=0`);
  chk('samples 取一句', r.status === 200 && r.json.sentence?.original && r.json.total > 0, JSON.stringify(r.json)?.slice(0, 100));
  r = await J(B, '/api/history');
  chk('history 200', r.status === 200);
  r = await J(B, '/api/weakness?user=t-contract');
  chk('weakness 200 且是物件', r.status === 200 && r.json && typeof r.json === 'object');

  console.log('字表');
  r = await J(B, '/api/wordsets?user=t-contract');
  const set = r.json?.sets?.find(x => x.name === '測試字表');
  chk('wordsets 列出測試字表與字數', r.status === 200 && set && set.word_count === 8, JSON.stringify(r.json)?.slice(0, 160));
  r = await J(B, `/api/wordset?id=${set.id}&user=t-contract`);
  chk('wordset 取出單字', r.status === 200 && (r.json.words?.length === 8), JSON.stringify(r.json)?.slice(0, 160));

  console.log('句子練習：出題、交卷、訂正不計入統計');
  const weakTotal = async () => { const w = (await J(B, '/api/weakness?user=t-fix')).json; return JSON.stringify(w); };
  const w0 = await weakTotal();
  r = await J(B, '/api/exercises', { method: 'POST', body: { count: 6, userToken: 't-fix' } });
  const ex = r.json;
  chk('exercises 出題', r.status === 200 && ex.quizId && ex.questions?.length > 0, r.text.slice(0, 120));
  chk('題目不含答案欄位', ex.questions.every(q => !('answer' in q) && !('explain' in q)));
  r = await J(B, '/api/attempts', { method: 'POST', body: { quizId: ex.quizId, userToken: 't-fix', answers: {} } });
  chk('attempts 交卷、題數相符、isFix=false', r.status === 200 && r.json.total === ex.questions.length && r.json.isFix === false, r.text.slice(0, 120));
  const w1 = await weakTotal();
  chk('第一次作答會進統計', w1 !== w0);
  const wrongIds = r.json.results.filter(x => !x.correct).map(x => x.id);
  chk('空白作答全部算錯（有錯題可訂正）', wrongIds.length > 0);
  r = await J(B, '/api/exercises', { method: 'POST', body: { redoFrom: ex.quizId, redoIds: wrongIds, userToken: 't-fix' } });
  chk('訂正：重出原題、標示 redo', r.status === 200 && r.json.redo === true && r.json.questions.length === wrongIds.length, r.text.slice(0, 120));
  const fixQuiz = r.json;
  r = await J(B, '/api/attempts', { method: 'POST', body: { quizId: fixQuiz.quizId, userToken: 't-fix', answers: {} } });
  chk('訂正交卷 isFix=true', r.status === 200 && r.json.isFix === true);
  chk('訂正不影響統計', (await weakTotal()) === w1);
  r = await J(B, '/api/exercises', { method: 'POST', body: { redoFrom: 'no-such-quiz', redoIds: ['x'] } });
  chk('訂正的原卷不存在 → 410', r.status === 410);
  r = await J(B, '/api/attempts', { method: 'POST', body: { quizId: 'no-such-quiz', answers: {} } });
  chk('交卷的測驗不存在 → 4xx', r.status >= 400 && r.status < 500, `status ${r.status}`);

  console.log('單字測驗：出題、交卷、訂正不推進進度');
  r = await J(B, '/api/wordquiz', { method: 'POST', body: { setIds: [set.id], count: 8, userToken: 't-word' } });
  const wq = r.json;
  chk('wordquiz 出題', r.status === 200 && wq.quizId && wq.questions?.length > 0, r.text.slice(0, 120));
  chk('單字題不含答案欄位', wq.questions.every(q => !('answer' in q) && !('explain' in q)));
  const progress = async () => JSON.stringify((await J(B, `/api/wordset?id=${set.id}&user=t-word`)).json.words?.map(w => [w.term, w.box, w.total]));
  const p0 = await progress();
  r = await J(B, '/api/wordattempts', { method: 'POST', body: { quizId: wq.quizId, userToken: 't-word', answers: {} } });
  chk('wordattempts 交卷', r.status === 200 && r.json.total === wq.questions.length && r.json.isFix === false, r.text.slice(0, 120));
  const p1 = await progress();
  chk('第一次作答會更新進度', p1 !== p0);
  const wWrong = r.json.results.filter(x => !x.correct).map(x => x.id);
  r = await J(B, '/api/wordquiz', { method: 'POST', body: { redoFrom: wq.quizId, redoIds: wWrong, userToken: 't-word' } });
  chk('單字訂正：重出原題', r.status === 200 && r.json.redo === true && r.json.questions.length === wWrong.length, r.text.slice(0, 120));
  r = await J(B, '/api/wordattempts', { method: 'POST', body: { quizId: r.json.quizId, userToken: 't-word', answers: {} } });
  chk('單字訂正交卷 isFix=true', r.status === 200 && r.json.isFix === true);
  chk('單字訂正不推進進度', (await progress()) === p1);
  r = await J(B, '/api/wordquiz', { method: 'POST', body: { setIds: [999999], count: 5 } });
  chk('空字表 → 409', r.status === 409, `status ${r.status}`);

  console.log('分析入口的輸入檢查（都在呼叫模型之前就擋下）');
  r = await J(B, '/api/analyze', { method: 'POST', body: '{壞掉的 json' });
  chk('壞 JSON → 400', r.status === 400);
  r = await J(B, '/api/analyze', { method: 'POST', body: { text: '   ' } });
  chk('空白 → 400', r.status === 400);
  r = await J(B, '/api/analyze', { method: 'POST', body: { text: 'a'.repeat(r.json ? 0 : 0) + 'x'.repeat(100000) } });
  chk('超長 → 413', r.status === 413, `status ${r.status}`);

  console.log('驗證（AUTH_TOKEN）');
  authed = await start({ AUTH_TOKEN: 'sekret' });
  r = await J(authed.base, '/api/health');
  chk('health 標示需要驗證', r.json.authRequired === true);
  r = await J(authed.base, '/api/exercises', { method: 'POST', body: { count: 3 } });
  chk('沒帶 token → 401', r.status === 401);
  r = await J(authed.base, '/api/exercises', { method: 'POST', body: { count: 3 }, headers: { 'x-auth-token': 'wrong' } });
  chk('token 錯誤 → 401', r.status === 401);
  r = await J(authed.base, '/api/exercises', { method: 'POST', body: { count: 3 }, headers: { 'x-auth-token': 'sekret' } });
  chk('header 帶對 token → 200', r.status === 200);
  r = await J(authed.base, '/api/exercises?token=sekret', { method: 'POST', body: { count: 3 } });
  chk('網址帶對 token → 200', r.status === 200);
  r = await J(authed.base, '/api/analyze', { method: 'POST', body: { text: 'Hello.' } });
  chk('分析沒帶 token → 401', r.status === 401);
  r = await J(authed.base, '/api/wordquiz', { method: 'POST', body: { setIds: [set.id] } });
  chk('單字測驗沒帶 token → 401', r.status === 401);
  r = await J(authed.base, '/api/wordattempts', { method: 'POST', body: { quizId: 'x', answers: {} } });
  chk('單字交卷沒帶 token → 401', r.status === 401);
  r = await J(authed.base, '/api/wordquiz', { method: 'POST', body: { setIds: [set.id], count: 3 }, headers: { 'x-auth-token': 'sekret' } });
  chk('單字測驗帶對 token → 200', r.status === 200);
  r = await J(authed.base, '/');
  chk('首頁不需要 token', r.status === 200);
} catch (e) {
  console.log('ERR', e.stack || e.message); results.push(false);
} finally {
  for (const s of [main, authed]) s?.child.kill();
  await wait(300);
  try { rmSync(tmp, { recursive: true, force: true }); } catch {}
}
const fail = results.filter(x => !x).length;
console.log(fail ? `\n有失敗 (${fail}/${results.length})` : `\n全部通過 (${results.length})`);
process.exit(fail ? 1 : 0);
