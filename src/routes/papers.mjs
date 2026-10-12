// 路由：測驗卷。預覽、出卷、作答存檔、交卷、自評、訂正、歷史。全部要驗證。
import { join } from 'node:path';
import { writeFile, unlink, mkdir } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { cache } from '../context.mjs';
import { PAPER_DAYS, ROOT } from '../config.mjs';
import { readBody, authed, roleOf, denyStudent, userOf, sendJson, decodeImage } from '../http.mjs';
import { extractExam } from '../analyzer.mjs';
import { buildExamQuestions, saveExamDraft, analysisText } from '../papers/examimport.mjs';
import { submitJob } from '../jobs.mjs';
import { editPaper, paperAdminView } from '../papers/edit.mjs';
import { aiGradePaper, previewPaper, createPaper, paperView, saveAnswers, submitPaper, markSelf, createFixPaper, historyList } from '../papers/paper.mjs';

const body = async req => { try { return JSON.parse(await readBody(req, 2e6)) || {}; } catch { return {}; } };
const guard = (handler, method) => async (req, res, url) => {
  if (!authed(req, url)) return sendJson(res, 401, { error: 'unauthorized' });
  if (method && req.method !== method) return sendJson(res, 405, { error: 'method-not-allowed' });
  return handler(req, res, url);
};
const fail = (res, r, status = 400) => sendJson(res, r.error === 'expired' ? 410 : status, r);

export const routes = [

  // 考卷重現：老師上傳學校考卷的照片（可多張），選擇題原樣存成草稿。只有老師能用（要花辨識額度）。
  { match: (req, url) => url.pathname === '/api/exam-import', handler: guard(async (req, res, url) => {
      if (denyStudent(req, res, url)) return;
      let b = {};
      try { b = JSON.parse(await readBody(req, 40e6)) || {}; } catch { return sendJson(res, 413, { error: 'too-large', message: '圖片太大，請少選幾張或壓縮後再試。' }); }
      const images = (Array.isArray(b.images) ? b.images : []).slice(0, 6);
      if (!images.length) return sendJson(res, 400, { error: 'no-image', message: '請選一張考卷的照片。' });
      const decoded = images.map(decodeImage), bad = decoded.find(d => d.error);
      if (bad) return sendJson(res, bad.code, { error: bad.error, message: bad.message });

      const dir = join(ROOT, 'data', 'tmp'), t0 = Date.now();
      const raw = [], failed = []; let cost = 0, inTok = 0, outTok = 0;
      await mkdir(dir, { recursive: true });
      for (let i = 0; i < decoded.length; i++){
        const file = join(dir, 'exam-' + randomBytes(8).toString('hex') + '.' + decoded[i].ext);
        try {
          await writeFile(file, decoded[i].buf);
          const r = await extractExam(file);
          raw.push(...r.questions); cost += r.usage.costUsd || 0; inTok += r.usage.inputTokens || 0; outTok += r.usage.outputTokens || 0;
        } catch (e){
          if (e.kind === 'rate-limit' || e.kind === 'auth')
            return sendJson(res, e.kind === 'rate-limit' ? 429 : 500, { error: e.kind, message: e.kind === 'rate-limit' ? 'Claude 訂閱額度似乎已用盡，等額度重置後再試。' : 'Claude 認證失效，請在終端機執行 claude 重新登入。' });
          failed.push('第 ' + (i + 1) + ' 張：' + String(e.message).slice(0, 120));
        } finally { await unlink(file).catch(() => {}); }
      }
      const { questions, skipped } = buildExamQuestions(raw);
      cache.log({ kind: 'exam-ocr', chars: decoded.reduce((a, d) => a + d.buf.length, 0), sentences: questions.length, cached: 0, analyzed: 0, ms: Date.now() - t0,
        text: '考卷重現：' + questions.length + ' 題', inputTokens: inTok, outputTokens: outTok, costUsd: cost });
      if (!questions.length)
        return sendJson(res, 422, { error: 'no-questions', message: failed.length ? '辨識失敗：' + failed.join('；') : '照片裡沒有找到有選項的選擇題。請確認照片清楚、整張考卷都拍進來了。', skipped });
      const saved = saveExamDraft(cache, questions, { title: b.title, ttlDays: PAPER_DAYS });
      const sentences = questions.map(q => q.meta.filled && analysisText(q.meta.filled)).filter(Boolean).join('\n');
      return sendJson(res, 200, { ok: true, id: saved.id, title: saved.title, n: questions.length, flagged: questions.filter(q => q.meta.check.length).length,
        skipped, failed, sentences, usage: { costUsd: cost } });
    }, 'POST') },

  { match: (req, url) => url.pathname === '/api/paper-preview', handler: guard(async (req, res, url) => {
      if (denyStudent(req, res, url)) return;
      const pb = await body(req); pb.userToken = userOf(req, url, pb.userToken);
      const r = previewPaper(cache, pb);
      return r.error ? fail(res, r) : sendJson(res, 200, r);
    }, 'POST') },

  { match: (req, url) => url.pathname === '/api/papers', handler: guard(async (req, res, url) => {
      // 草稿是老師還在整理的，學生看不到
      if (req.method === 'GET') return sendJson(res, 200, { papers: historyList(cache, { includeDrafts: roleOf(req, url) !== 'student' }), keepDays: PAPER_DAYS });
      if (req.method === 'DELETE'){ if (denyStudent(req, res, url)) return; const n = cache.deletePaper(url.searchParams.get('id')); return sendJson(res, 200, { ok: true, deleted: n }); }
      if (req.method === 'POST'){
        if (denyStudent(req, res, url)) return;
        const pb = await body(req); pb.userToken = userOf(req, url, pb.userToken);
        const r = await createPaper(cache, pb, { ttlDays: PAPER_DAYS });
        return r.error ? fail(res, r, r.error === 'confirm-required' ? 409 : 400) : sendJson(res, 200, r);
      }
      return sendJson(res, 405, { error: 'method-not-allowed' });
    }) },

  { match: (req, url) => url.pathname === '/api/paper' && req.method === 'GET', handler: guard(async (req, res, url) => {
      const p = cache.getPaper(url.searchParams.get('id'));
      const teacher = roleOf(req, url) === 'teacher';
      if (!p || (p.status === 'draft' && !teacher)) return sendJson(res, 410, { error: 'expired', message: '這份卷子已經過期或不存在。' });
      // 老師帶 admin=1：題目含答案與解說（編修、檢視學生的作答用）
      return sendJson(res, 200, teacher && url.searchParams.get('admin') === '1' ? paperAdminView(p) : paperView(p));
    }) },

  // 老師編修：改名、換題、刪題、發佈、收回
  { match: (req, url) => url.pathname === '/api/paper-edit', handler: guard(async (req, res, url) => {
      if (denyStudent(req, res, url)) return;
      const b = await body(req); const r = editPaper(cache, b.id, b, { ttlDays: PAPER_DAYS });
      return r.error ? fail(res, r, r.error === 'expired' ? 410 : 409) : sendJson(res, 200, r);
    }, 'POST') },

  { match: (req, url) => url.pathname === '/api/paper-save', handler: guard(async (req, res) => {
      const b = await body(req); const r = saveAnswers(cache, b.id, b.answers);
      return r.error ? fail(res, r, 409) : sendJson(res, 200, r);
    }, 'POST') },

  { match: (req, url) => url.pathname === '/api/paper-submit', handler: guard(async (req, res, url) => {
      const b = await body(req); const r = submitPaper(cache, b.id, { answers: b.answers, userToken: userOf(req, url, b.userToken) });
      return r.error ? fail(res, r, r.error === 'draft' ? 409 : 400) : sendJson(res, 200, r);
    }, 'POST') },

  { match: (req, url) => url.pathname === '/api/paper-self', handler: guard(async (req, res) => {
      const b = await body(req); const r = markSelf(cache, b.id, b.marks);
      return r.error ? fail(res, r, 409) : sendJson(res, 200, r);
    }, 'POST') },

  { match: (req, url) => url.pathname === '/api/paper-ai-grade', handler: guard(async (req, res, url) => {
      const b = await body(req);
      if (roleOf(req, url) === 'student'){          // 學生：先算報價，開申請單，老師核准後才呼叫模型
        const q = await aiGradePaper(cache, b.id, { confirm: false });
        if (q.error !== 'confirm-required') return fail(res, q);
        const job = submitJob(cache, { kind: 'ai-grade', by: 'student', payload: { id: String(b.id) }, quote: q.quote,
          summary: `AI 批改測驗卷（造句與翻譯 ${q.quote.count} 題）` });
        return sendJson(res, 202, { pending: true, jobId: job.id, reused: job.reused });
      } const r = await aiGradePaper(cache, b.id, { confirm: b.confirm === true });
      return r.error ? fail(res, r, r.error === 'confirm-required' ? 409 : r.error === 'grade-failed' ? 502 : 400) : sendJson(res, 200, r);
    }, 'POST') },

  { match: (req, url) => url.pathname === '/api/paper-redo', handler: guard(async (req, res) => {
      const b = await body(req); const r = createFixPaper(cache, b.id, { ids: Array.isArray(b.ids) ? b.ids : null, ttlDays: PAPER_DAYS });
      return r.error ? fail(res, r, 409) : sendJson(res, 200, r);
    }, 'POST') },
];
