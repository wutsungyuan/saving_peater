// 路由：申請單。學生看自己的、撤回待審的；老師看全部、核准或拒絕。
import { cache } from '../context.mjs';
import { readBody, authed, roleOf, denyStudent, sendJson } from '../http.mjs';
import { decideJob, cancelJob } from '../jobs.mjs';

const body = async req => { try { return JSON.parse(await readBody(req, 1e5)) || {}; } catch { return {}; } };
const deny = res => sendJson(res, 401, { error: 'unauthorized' });

/** 給前端看的樣子。照片太大不送；學生看不到報價與費用。 */
function view(job, role){
  const payload = { ...job.payload };
  if (payload.image){ payload.hasImage = true; delete payload.image; }
  const v = { id: job.id, kind: job.kind, status: job.status, summary: job.summary, by: job.by, note: job.note, payload,
    result: job.result, createdAt: job.createdAt, decidedAt: job.decidedAt, startedAt: job.startedAt, finishedAt: job.finishedAt };
  if (role === 'teacher'){ v.quote = job.quote; v.costUsd = job.costUsd; }
  return v;
}

export const routes = [
  // 列表。老師：status=pending（待審）或 status=history（已處理）；學生：自己的全部
  { match: (req, url) => url.pathname === '/api/jobs' && req.method === 'GET', handler: async (req, res, url) => {
      if (!authed(req, url)) return deny(res);
      const role = roleOf(req, url);
      const q = url.searchParams.get('status') || 'all';
      const statuses = q === 'pending' ? ['pending'] : q === 'history' ? ['approved', 'running', 'done', 'failed', 'rejected', 'cancelled'] : null;
      const jobs = cache.jobs({ statuses, by: role === 'student' ? 'student' : null, limit: 60 });
      return sendJson(res, 200, { jobs: jobs.map(j => view(j, role)), pending: cache.countJobs('pending') });
    } },
  // 徽章用的數字：老師要審的有幾張；學生是自己進行中的（待審、執行中）幾張
  { match: (req, url) => url.pathname === '/api/jobs-count' && req.method === 'GET', handler: async (req, res, url) => {
      if (!authed(req, url)) return deny(res);
      if (roleOf(req, url) === 'student'){
        const mine = cache.jobs({ by: 'student', statuses: ['pending', 'approved', 'running'], limit: 100 });
        return sendJson(res, 200, { active: mine.length });
      }
      return sendJson(res, 200, { pending: cache.countJobs('pending') });
    } },
  // 老師：核准、拒絕、重新執行
  { match: (req, url) => url.pathname === '/api/job-decide' && req.method === 'POST', handler: async (req, res, url) => {
      if (!authed(req, url)) return deny(res);
      if (denyStudent(req, res, url)) return;
      const b = await body(req);
      const r = decideJob(cache, b.id, b.action, b.note);
      return r.error ? sendJson(res, r.error === 'not-found' ? 404 : 409, r) : sendJson(res, 200, { ok: true, job: view(r.job, 'teacher') });
    } },
  // 學生：撤回還沒審的申請
  { match: (req, url) => url.pathname === '/api/job-cancel' && req.method === 'POST', handler: async (req, res, url) => {
      if (!authed(req, url)) return deny(res);
      const b = await body(req);
      const r = cancelJob(cache, b.id, 'student');
      return r.error ? sendJson(res, r.error === 'not-found' ? 404 : 409, r) : sendJson(res, 200, { ok: true });
    } },
];
