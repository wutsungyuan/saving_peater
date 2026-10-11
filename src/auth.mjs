// 登入：一組帳號密碼（環境變數 AUTH_USER / AUTH_PASS，只在這台機器上設定，不進程式碼）。
// 登入成功發一個隨機的 session 碼，放在 HttpOnly cookie；資料庫只存它的雜湊，所以資料庫外流也拿不到可用的碼。
// 沒有做帳號管理：只有這一組帳密。舊的 AUTH_TOKEN（x-auth-token 標頭或 ?token=）仍然可用，給腳本與測試。

import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { AUTH_USER, AUTH_PASS, STUDENT_USER, STUDENT_PASS, SESSION_DAYS } from './config.mjs';
import { cache } from './context.mjs';

export const COOKIE = 'sp_session';
const sha = s => createHash('sha256').update(String(s)).digest();
const same = (a, b) => timingSafeEqual(sha(a), sha(b));          // 先各自雜湊再比，長度不同也是常數時間

// 老師帳號（AUTH_USER / AUTH_PASS）與學生帳號（STUDENT_USER / STUDENT_PASS，選填，且不能和老師同名）
const ACCOUNTS = [
  { role: 'teacher', user: AUTH_USER, pass: AUTH_PASS },
  ...(STUDENT_USER && STUDENT_PASS && STUDENT_USER !== AUTH_USER ? [{ role: 'student', user: STUDENT_USER, pass: STUDENT_PASS }] : []),
].filter(a => a.user && a.pass);
export const loginAvailable = ACCOUNTS.length > 0;
export const studentAccount = ACCOUNTS.some(a => a.role === 'student');

export function cookieOf(req, name = COOKIE){
  for (const part of String(req.headers.cookie || '').split(';')){
    const i = part.indexOf('=');
    if (i > 0 && part.slice(0, i).trim() === name) return decodeURIComponent(part.slice(i + 1).trim());
  }
  return '';
}

/** 目前這個請求的登入角色：teacher | student，沒登入回 null */
export function sessionRole(req){
  const c = cookieOf(req);
  return c ? cache.sessionRole(sha(c).toString('hex')) : null;
}
/** 目前這個請求的 cookie 是不是有效的登入 */
export const sessionOk = req => sessionRole(req) !== null;

// 連續輸錯會被暫時鎖住（以來源位址計）：5 次錯 → 鎖 5 分鐘。區網內也不讓人無限猜密碼。
const fails = new Map();
const MAX_FAILS = 5, LOCK_MS = 5 * 60_000;
const ipOf = req => req.socket?.remoteAddress || 'unknown';
export function lockedFor(req, now = Date.now()){
  const f = fails.get(ipOf(req));
  return f && f.until > now ? Math.ceil((f.until - now) / 1000) : 0;
}

/** 驗證帳密。成功回 { cookie }，失敗回 { error, retryAfter? } */
export function login(req, user, pass, now = Date.now()){
  if (!loginAvailable) return { error: 'login-disabled', message: '這台伺服器沒有設定帳號密碼。' };
  const wait = lockedFor(req, now);
  if (wait) return { error: 'locked', retryAfter: wait, message: `輸錯太多次，請 ${Math.ceil(wait / 60)} 分鐘後再試。` };
  // 每個帳號的帳密都比完，不因帳號錯就提早結束（也不因為是哪一個角色而花不同的時間）
  let role = null;
  for (const a of ACCOUNTS){
    const ok = same(String(user ?? ''), a.user) & same(String(pass ?? ''), a.pass);
    if (ok && !role) role = a.role;
  }
  const ip = ipOf(req);
  if (!role){
    const f = fails.get(ip) ?? { n: 0, until: 0 };
    f.n += 1; if (f.n >= MAX_FAILS){ f.until = now + LOCK_MS; f.n = 0; }
    fails.set(ip, f);
    return { error: 'bad-credentials', message: '帳號或密碼不對。' };
  }
  fails.delete(ip);
  const id = randomBytes(32).toString('hex');
  cache.createSession(sha(id).toString('hex'), SESSION_DAYS, role);
  return { cookie: id, role };
}

export function logout(req){
  const c = cookieOf(req);
  if (c) cache.deleteSession(sha(c).toString('hex'));
}

export const setCookie = id => `${COOKIE}=${id}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${SESSION_DAYS * 86400}`;
export const clearCookie = () => `${COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`;
