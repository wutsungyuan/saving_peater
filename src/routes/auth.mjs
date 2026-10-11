// 路由：登入、登出。公開（登入本身不能要求已登入）。
import { readBody, sendJson } from '../http.mjs';
import { login, logout, setCookie, clearCookie } from '../auth.mjs';

export const routes = [
  { match: (req, url) => url.pathname === '/api/login' && req.method === 'POST', handler: async (req, res) => {
      let b = {}; try { b = JSON.parse(await readBody(req, 5e3)) || {}; } catch {}
      const r = login(req, b.user, b.pass);
      if (r.error){
        const status = r.error === 'locked' ? 429 : r.error === 'login-disabled' ? 400 : 401;
        res.setHeader('cache-control', 'no-store');
        return sendJson(res, status, { error: r.error, message: r.message, retryAfter: r.retryAfter });
      }
      res.setHeader('set-cookie', setCookie(r.cookie));
      return sendJson(res, 200, { ok: true, role: r.role });
    } },
  { match: (req, url) => url.pathname === '/api/logout' && req.method === 'POST', handler: async (req, res) => {
      logout(req);
      res.setHeader('set-cookie', clearCookie());
      return sendJson(res, 200, { ok: true });
    } },
];
