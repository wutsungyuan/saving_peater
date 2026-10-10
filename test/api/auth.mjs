// 帳號密碼登入：session cookie、輸錯鎖定、登出、舊存取碼仍可用、資料庫不存原碼。
// 跑法：node --no-warnings test/api/auth.mjs
import { DatabaseSync } from 'node:sqlite';
import { start, J, chk, section, finish } from './_harness.mjs';

const USER = 'yuan', PASS = 'correct horse battery';
const cookieFrom = r => (r.headers.get('set-cookie') || '').split(';')[0];
const withCookie = c => ({ headers: { cookie: c } });

try {
  const S = await start('auth', { AUTH_USER: USER, AUTH_PASS: PASS, AUTH_TOKEN: 'legacy-token' });
  const B = S.base;

  section('沒登入');
  let r = await J(B, '/api/health');
  chk('health 公開：需要驗證、可以登入、尚未登入', r.status === 200 && r.json.authRequired === true && r.json.loginAvailable === true && r.json.loggedIn === false, r.text);
  for (const p of ['/api/history', '/api/stats', '/api/weakness?user=anon', '/api/wordsets?user=anon', '/api/articles', '/api/papers'])
    chk(`GET ${p} 沒登入 → 401`, (await J(B, p)).status === 401);
  chk('POST /api/analyze 沒登入 → 401', (await J(B, '/api/analyze', { method: 'POST', body: { text: 'Hi.' } })).status === 401);

  section('登入');
  r = await J(B, '/api/login', { method: 'POST', body: { user: USER, pass: 'wrong' } });
  chk('密碼錯 → 401，沒有 cookie', r.status === 401 && !r.headers.get('set-cookie') && /不對/.test(r.json.message), r.text);
  r = await J(B, '/api/login', { method: 'POST', body: { user: 'nobody', pass: PASS } });
  chk('帳號錯 → 401（訊息不透露是帳號還是密碼錯）', r.status === 401 && r.json.message === '帳號或密碼不對。');
  r = await J(B, '/api/login', { method: 'POST', body: { user: USER, pass: PASS } });
  const ck = cookieFrom(r), setCookie = r.headers.get('set-cookie') || '';
  chk('正確 → 200，發 cookie', r.status === 200 && r.json.ok && ck.startsWith('sp_session=') && ck.length > 40, setCookie);
  chk('cookie 是 HttpOnly + SameSite=Lax（JavaScript 讀不到、跨站不帶）', /HttpOnly/.test(setCookie) && /SameSite=Lax/.test(setCookie) && /Max-Age=\d+/.test(setCookie), setCookie);

  section('登入之後');
  for (const p of ['/api/history', '/api/stats', '/api/weakness?user=anon', '/api/wordsets?user=anon', '/api/articles', '/api/papers'])
    chk(`GET ${p} 帶 cookie → 200`, (await J(B, p, withCookie(ck))).status === 200);
  r = await J(B, '/api/health', withCookie(ck));
  chk('health 顯示已登入', r.json.loggedIn === true);
  chk('可以分析（cookie 通過驗證）', (await J(B, '/api/papers', { method: 'POST', ...withCookie(ck), body: { setIds: [], articleIds: [] } })).status === 400);   // 驗證過了，被擋在「沒選範圍」
  chk('亂寫的 cookie → 401', (await J(B, '/api/history', withCookie('sp_session=' + 'a'.repeat(64)))).status === 401);

  section('資料庫只存雜湊');
  const db = new DatabaseSync(S.dbFile, { readOnly: true });
  const rows = db.prepare('SELECT id, expires_at FROM sessions').all(); db.close();
  const raw = ck.split('=')[1];
  chk('sessions 表有一筆、存的不是 cookie 原碼', rows.length === 1 && rows[0].id !== raw && rows[0].id.length === 64 && !JSON.stringify(rows).includes(raw), JSON.stringify(rows));
  chk('到期日約 90 天後', Math.abs(rows[0].expires_at - (Date.now() + 90 * 86400_000)) < 120_000);

  section('舊的存取碼仍可用（腳本、測試）');
  chk('x-auth-token 標頭', (await J(B, '/api/stats', { token: 'legacy-token' })).status === 200);
  chk('?token= 參數', (await J(B, '/api/stats?token=legacy-token')).status === 200);
  chk('錯的存取碼 → 401', (await J(B, '/api/stats', { token: 'nope' })).status === 401);

  section('登出');
  r = await J(B, '/api/logout', { method: 'POST', ...withCookie(ck) });
  chk('登出 → 200，要求瀏覽器清掉 cookie', r.status === 200 && /Max-Age=0/.test(r.headers.get('set-cookie') || ''));
  chk('登出後這個 cookie 失效', (await J(B, '/api/history', withCookie(ck))).status === 401);

  section('輸錯太多次 → 暫時鎖住');
  const L = await start('auth-lock', { AUTH_USER: USER, AUTH_PASS: PASS });
  let last;
  for (let i = 0; i < 5; i++) last = await J(L.base, '/api/login', { method: 'POST', body: { user: USER, pass: 'bad' + i } });
  chk('前 5 次都是 401', last.status === 401);
  r = await J(L.base, '/api/login', { method: 'POST', body: { user: USER, pass: 'bad' } });
  chk('第 6 次 → 429，說明要等多久', r.status === 429 && r.json.retryAfter > 200 && /分鐘/.test(r.json.message), r.text);
  r = await J(L.base, '/api/login', { method: 'POST', body: { user: USER, pass: PASS } });
  chk('鎖住期間連正確的密碼也不行', r.status === 429);
  chk('沒設 AUTH_TOKEN 時，只能靠登入', (await J(L.base, '/api/stats', { token: 'legacy-token' })).status === 401);

  section('沒有設帳號密碼');
  const N = await start('auth-none', {});
  r = await J(N.base, '/api/health');
  chk('health：不需要驗證、不提供登入', r.json.authRequired === false && r.json.loginAvailable === false && r.json.loggedIn === true, r.text);
  chk('任何人都能讀（本機模式）', (await J(N.base, '/api/stats')).status === 200);
  chk('登入 → 400（沒有可登入的帳號）', (await J(N.base, '/api/login', { method: 'POST', body: { user: 'a', pass: 'b' } })).status === 400);

  section('只設舊存取碼（現有的部署方式）');
  const T = await start('auth-token-only', { AUTH_TOKEN: 'tok' });
  r = await J(T.base, '/api/health');
  chk('health：需要驗證、沒有帳密可登入', r.json.authRequired === true && r.json.loginAvailable === false && r.json.loggedIn === false, r.text);
  chk('帶存取碼可以用、不帶不行', (await J(T.base, '/api/stats', { token: 'tok' })).status === 200 && (await J(T.base, '/api/stats')).status === 401);
  await finish();
} catch (e) { await finish(e); }
