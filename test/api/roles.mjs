// 角色：老師與學生兩組帳密。學生不能用花錢與管理的功能；作答紀錄由伺服器記在固定的身分下，不看瀏覽器自報的代碼。
// 跑法：node --no-warnings test/api/roles.mjs
import { rmSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { start, J, chk, section, finish } from './_harness.mjs';
import { makeFixture } from './_fixture.mjs';

const T = { user: 'teacher1', pass: 'teacher pass 123' }, K = { user: 'kid1', pass: 'kid pass 456' };
const cookieFrom = r => (r.headers.get('set-cookie') || '').split(';')[0];
const withCookie = c => ({ headers: { cookie: c } });
const fx = makeFixture('peater-roles-');
fx.cache.db.close?.();
const fx2 = makeFixture('peater-roles2-'); fx2.cache.db.close?.();
const attemptUsers = dbFile => { const d = new DatabaseSync(dbFile, { readOnly: true }); const r = d.prepare('SELECT DISTINCT user_token FROM attempts').all().map(x => x.user_token); d.close(); return r; };

try {
  const S = await start('roles', { AUTH_USER: T.user, AUTH_PASS: T.pass, STUDENT_USER: K.user, STUDENT_PASS: K.pass }, { dbFile: fx.dbFile });
  const B = S.base;

  section('兩組帳號登入');
  let r = await J(B, '/api/login', { method: 'POST', body: T });
  const tk = cookieFrom(r);
  chk('老師登入 → role teacher', r.status === 200 && r.json.role === 'teacher' && tk.startsWith('sp_session='), r.text);
  r = await J(B, '/api/login', { method: 'POST', body: K });
  const sk = cookieFrom(r);
  chk('學生登入 → role student', r.status === 200 && r.json.role === 'student' && sk.startsWith('sp_session='), r.text);
  chk('health 顯示各自的角色、有學生帳號', (await J(B, '/api/health', withCookie(tk))).json.role === 'teacher' && (await J(B, '/api/health', withCookie(sk))).json.role === 'student' && (await J(B, '/api/health')).json.studentAccount === true);
  chk('沒登入：role 是 null', (await J(B, '/api/health')).json.role === null);
  r = await J(B, '/api/login', { method: 'POST', body: { user: K.user, pass: T.pass } });
  chk('學生帳號配老師密碼 → 401（帳密要成對）', r.status === 401);
  const db = new DatabaseSync(S.dbFile, { readOnly: true });
  const roles = db.prepare('SELECT role FROM sessions ORDER BY created_at').all().map(x => x.role); db.close();
  chk('sessions 表記著角色', roles.join() === 'teacher,student', roles.join());

  section('學生：花錢與管理的功能 → 403');
  for (const [m, p, body] of [
    ['GET', '/api/history'], ['GET', '/api/stats'],
    ['DELETE', '/api/wordsets?id=1'],
    ['POST', '/api/wordset-ocr', {}], ['POST', '/api/wordset-analyze', { setId: 1 }],
    ['DELETE', '/api/articles?ids=1'],
    ['POST', '/api/paper-preview', {}], ['POST', '/api/papers', {}], ['DELETE', '/api/papers?id=x'],
  ]) {
    r = await J(B, p, { method: m, ...withCookie(sk), ...(body ? { body } : {}) });
    chk(`${m} ${p} → 403`, r.status === 403 && r.json.error === 'forbidden', `${r.status} ${r.text.slice(0, 80)}`);
  }

  section('學生：要花額度的改成申請（細節見 jobs.mjs）');
  r = await J(B, '/api/wordsets', { method: 'POST', ...withCookie(sk), body: { name: 'x', text: 'apple' } });
  chk('建字表 → 202 申請單，不是 403 也不是直接建', r.status === 202 && r.json.pending === true, r.text.slice(0, 100));
  r = await J(B, '/api/job-decide', { method: 'POST', ...withCookie(sk), body: { id: r.json.jobId, action: 'approve' } });
  chk('學生不能核准 → 403', r.status === 403);

  section('學生：前台功能照常');
  for (const p of ['/api/wordsets?user=x', '/api/wordsearch?q=a&user=x', '/api/weakness?user=x', '/api/articles', '/api/papers'])
    chk(`GET ${p} → 200`, (await J(B, p, withCookie(sk))).status === 200);
  r = await J(B, '/api/exercises', { method: 'POST', ...withCookie(sk), body: { count: 3, types: ['pattern'] } });
  chk('出練習題 → 200', r.status === 200 && r.json.quizId, r.text.slice(0, 100));

  section('老師：全部都能用');
  chk('history、stats → 200', (await J(B, '/api/history', withCookie(tk))).status === 200 && (await J(B, '/api/stats', withCookie(tk))).status === 200);
  r = await J(B, '/api/paper-preview', { method: 'POST', ...withCookie(tk), body: { setIds: [], articleIds: [] } });
  chk('出卷預覽：驗證過了（被擋在「沒選範圍」，不是 403）', r.status === 400, `${r.status} ${r.text.slice(0, 80)}`);

  section('作答紀錄記在固定身分下，不看瀏覽器自報的代碼');
  const quiz = r2 => r2.json;
  const practice = async (ck, claimed) => {
    const q = await J(B, '/api/exercises', { method: 'POST', ...withCookie(ck), body: { count: 2, types: ['pattern'], userToken: claimed } });
    const a = await J(B, '/api/attempts', { method: 'POST', ...withCookie(ck), body: { quizId: q.json.quizId, userToken: claimed, answers: {} } });
    return a.status;
  };
  chk('學生自報 evil-token 作答 → 200', await practice(sk, 'evil-token') === 200);
  chk('紀錄記在 student', attemptUsers(S.dbFile).join() === 'student', attemptUsers(S.dbFile).join());
  chk('老師作答 → 記在 teacher（不混進學生的紀錄）', await practice(tk, 'whatever') === 200 && attemptUsers(S.dbFile).sort().join() === 'student,teacher', attemptUsers(S.dbFile).join());
  chk('學生看弱點，看到的是自己的（不是自報代碼的）', (await J(B, '/api/weakness?user=teacher', withCookie(sk))).json.overall.total > 0);

  section('沒有學生帳號：和以前一樣只有一組，唯一的使用者就是學生');
  const O = await start('roles-one', { AUTH_USER: T.user, AUTH_PASS: T.pass }, { dbFile: fx2.dbFile });
  r = await J(O.base, '/api/login', { method: 'POST', body: T });
  const ok = cookieFrom(r);
  chk('登入 → 老師，health 沒有學生帳號', r.json.role === 'teacher' && (await J(O.base, '/api/health')).json.studentAccount === false);
  const q = await J(O.base, '/api/exercises', { method: 'POST', ...withCookie(ok), body: { count: 2, types: ['pattern'], userToken: 'phone-abc' } });
  await J(O.base, '/api/attempts', { method: 'POST', ...withCookie(ok), body: { quizId: q.json.quizId, userToken: 'phone-abc', answers: {} } });
  chk('手機、筆電都記在同一個身分（student），不再各自一份', attemptUsers(fx2.dbFile).join() === 'student', attemptUsers(fx2.dbFile).join());

  section('學生帳號名稱和老師相同 → 忽略學生帳號');
  const D = await start('roles-dup', { AUTH_USER: T.user, AUTH_PASS: T.pass, STUDENT_USER: T.user, STUDENT_PASS: 'other' });
  r = await J(D.base, '/api/login', { method: 'POST', body: { user: T.user, pass: 'other' } });
  chk('用學生那組密碼登不進去', r.status === 401);
  chk('health：沒有學生帳號', (await J(D.base, '/api/health')).json.studentAccount === false);

  section('舊存取碼 = 老師');
  const L = await start('roles-token', { AUTH_TOKEN: 'tok', STUDENT_USER: K.user, STUDENT_PASS: K.pass, AUTH_USER: T.user, AUTH_PASS: T.pass });
  chk('帶存取碼可以看 stats（老師的權限）', (await J(L.base, '/api/stats', { token: 'tok' })).status === 200);
  await finish();
} catch (e) { await finish(e); } finally { for (const d of [fx.dir, fx2.dir]) try { rmSync(d, { recursive: true, force: true }); } catch {} }
