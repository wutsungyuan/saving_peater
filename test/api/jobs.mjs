// 申請單（花費關卡）：學生要花額度的操作先開申請單，老師核准後才在背景執行。假 CLI，不花額度。
// 跑法：node --no-warnings test/api/jobs.mjs
import { rmSync } from 'node:fs';
import { start, J, chk, section, finish, wait } from './_harness.mjs';
import { makeFixture } from './_fixture.mjs';

const T = { user: 'teacher1', pass: 'teacher pass 123' }, K = { user: 'kid1', pass: 'kid pass 456' };
const cookieFrom = r => (r.headers.get('set-cookie') || '').split(';')[0];
const withCookie = c => ({ headers: { cookie: c } });
const png = 'data:image/png;base64,' + Buffer.concat([Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]), Buffer.alloc(200)]).toString('base64');
const fx = makeFixture('peater-jobs-');
fx.cache.db.close?.();

// 帶 cookie 的 SSE
async function sseAs(base, ck, body){
  const r = await fetch(base + '/api/analyze', { method: 'POST', headers: { 'content-type': 'application/json', cookie: ck }, body: JSON.stringify(body) });
  const text = await r.text(), events = [];
  for (const block of text.split('\n\n')){
    const ev = /^event: (.+)$/m.exec(block)?.[1], data = /^data: (.+)$/m.exec(block)?.[1];
    if (ev && data) events.push({ event: ev, data: JSON.parse(data) });
  }
  return { status: r.status, events, json: events.length ? null : JSON.parse(text || 'null') };
}
const ev = (r, name) => r.events.filter(e => e.event === name).map(e => e.data);

try {
  const S = await start('jobs', { AUTH_USER: T.user, AUTH_PASS: T.pass, STUDENT_USER: K.user, STUDENT_PASS: K.pass, ANALYZE_GROUP: '6' }, { dbFile: fx.dbFile });
  const B = S.base;
  const tk = cookieFrom(await J(B, '/api/login', { method: 'POST', body: T }));
  const sk = cookieFrom(await J(B, '/api/login', { method: 'POST', body: K }));
  const jobsAs = async (ck, q = '') => (await J(B, '/api/jobs' + q, withCookie(ck))).json;
  const waitJob = async (ck, id, ok = ['done', 'failed']) => {
    for (let i = 0; i < 80; i++){ const j = (await jobsAs(ck)).jobs.find(x => x.id === id); if (j && ok.includes(j.status)) return j; await wait(150); }
    return null;
  };
  const decide = (id, action, note) => J(B, '/api/job-decide', { method: 'POST', ...withCookie(tk), body: { id, action, note } });

  section('學生分析新句子 → 申請單，不呼叫模型');
  const text1 = 'I like tea. We eat lunch.';
  let r = await sseAs(B, sk, { text: text1 });
  const a1 = ev(r, 'approval')[0], d1 = ev(r, 'done')[0];
  chk('收到 approval 事件：2 句等核准', r.status === 200 && a1?.toAnalyze === 2 && a1.jobId && a1.status === 'pending', JSON.stringify(r.events.map(e => e.event)));
  chk('串流結束時標明 pendingApproval，沒有任何一句被分析', d1?.pendingApproval === a1.jobId && d1.analyzed === 0 && ev(r, 'sentence').length === 0);
  chk('沒有呼叫模型', S.calls().length === 0, JSON.stringify(S.calls()));

  section('學生看不到費用；老師看得到報價');
  let sj = await jobsAs(sk);
  chk('學生看自己的申請：待審、沒有報價與費用', sj.jobs.length === 1 && sj.jobs[0].status === 'pending' && !('quote' in sj.jobs[0]) && !('costUsd' in sj.jobs[0]), JSON.stringify(sj.jobs[0]));
  const tj = await jobsAs(tk, '?status=pending');
  chk('老師看到待審：有報價（句數與預估費用區間）', tj.jobs.length === 1 && tj.jobs[0].quote.toAnalyze === 2 && tj.jobs[0].quote.estimate.high > 0 && /分析 2 句/.test(tj.jobs[0].summary), JSON.stringify(tj.jobs[0]));
  r = await J(B, '/api/analyze', { method: 'POST', ...withCookie(sk), body: { text: text1, article: true, dryRun: true } });
  chk('學生的 dryRun 報價：只有句數，沒有費用', r.json.toAnalyze === 2 && !('estimate' in r.json) && !('unitCost' in r.json), r.text);
  r = await J(B, '/api/analyze', { method: 'POST', ...withCookie(tk), body: { text: text1, article: true, dryRun: true } });
  chk('老師的 dryRun 報價：有費用', r.json.estimate?.high > 0);
  chk('徽章數字：老師待審 1、學生進行中 1', (await J(B, '/api/jobs-count', withCookie(tk))).json.pending === 1 && (await J(B, '/api/jobs-count', withCookie(sk))).json.active === 1);

  section('同樣的內容重複送出 → 沿用同一張');
  r = await sseAs(B, sk, { text: text1 });
  chk('同一張申請單，沒有多開', ev(r, 'approval')[0].jobId === a1.jobId && ev(r, 'approval')[0].reused === true && (await jobsAs(tk, '?status=pending')).jobs.length === 1);

  section('學生不能自己核准');
  r = await J(B, '/api/job-decide', { method: 'POST', ...withCookie(sk), body: { id: a1.jobId, action: 'approve' } });
  chk('學生核准 → 403', r.status === 403);

  section('老師核准 → 背景執行，結果進快取');
  r = await decide(a1.jobId, 'approve');
  chk('核准成功', r.status === 200 && ['approved', 'running', 'done'].includes(r.json.job.status), r.text.slice(0, 120));
  const done1 = await waitJob(tk, a1.jobId);
  chk('跑完：done，2 句分析好', done1?.status === 'done' && done1.result.analyzed === 2 && done1.result.failed === 0, JSON.stringify(done1));
  chk('老師看得到這次花費', done1.costUsd > 0, String(done1?.costUsd));
  chk('模型只被呼叫一次（2 句併成一批）', S.calls().length === 1, String(S.calls().length));
  r = await sseAs(B, sk, { text: text1 });
  chk('學生再按分析：2 句直接出結果，不用申請、不呼叫模型', ev(r, 'sentence').length === 2 && ev(r, 'approval').length === 0 && S.calls().length === 1);
  sj = await jobsAs(sk);
  chk('學生看到自己的申請完成了，仍沒有費用', sj.jobs[0].status === 'done' && !('costUsd' in sj.jobs[0]));

  section('一部分已分析、一部分是新的');
  r = await sseAs(B, sk, { text: 'I like tea. They read books.' });
  chk('已分析的那句照常出，新的那句開申請單', ev(r, 'sentence').length === 1 && ev(r, 'approval')[0]?.toAnalyze === 1, JSON.stringify(r.events.map(e => e.event)));
  const jMix = ev(r, 'approval')[0].jobId;

  section('拒絕與撤回');
  r = await decide(jMix, 'reject', '這週先不加');
  chk('拒絕：附備註', r.json.job.status === 'rejected' && r.json.job.note === '這週先不加');
  chk('拒絕的不會執行', S.calls().length === 1);
  sj = await jobsAs(sk);
  chk('學生看得到被拒絕與理由', sj.jobs.find(x => x.id === jMix).note === '這週先不加');
  r = await decide(jMix, 'approve');
  chk('已拒絕的不能再核准 → 409', r.status === 409);
  r = await sseAs(B, sk, { text: 'Birds can fly high.' });
  const jCancel = ev(r, 'approval')[0].jobId;
  r = await J(B, '/api/job-cancel', { method: 'POST', ...withCookie(sk), body: { id: jCancel } });
  chk('學生撤回待審的申請', r.status === 200 && (await jobsAs(sk)).jobs.find(x => x.id === jCancel).status === 'cancelled');
  r = await J(B, '/api/job-cancel', { method: 'POST', ...withCookie(sk), body: { id: a1.jobId } });
  chk('審過的不能撤回 → 409', r.status === 409);

  section('分析並存成文章');
  r = await sseAs(B, sk, { text: 'Dogs run fast. Cats sleep a lot.', article: true, saveAs: '課文X' });
  const jArt = ev(r, 'approval')[0].jobId;
  chk('文章申請單的說明寫著要存成哪份文章', /課文X/.test((await jobsAs(tk, '?status=pending')).jobs.find(x => x.id === jArt).summary));
  await decide(jArt, 'approve');
  const doneArt = await waitJob(tk, jArt);
  chk('跑完：文章已存好', doneArt?.status === 'done' && doneArt.result.articleId && doneArt.result.articleName === '課文X', JSON.stringify(doneArt));
  chk('學生的文章表看得到', (await J(B, '/api/articles', withCookie(sk))).json.articles.some(a => a.name === '課文X'));

  section('拍照辨識');
  r = await J(B, '/api/analyze-ocr', { method: 'POST', ...withCookie(sk), body: { image: png, mode: 'sentence' } });
  chk('學生辨識 → 202，開申請單，沒呼叫模型', r.status === 202 && r.json.pending && r.json.jobId && S.calls().length === 2, r.text.slice(0, 100));
  const jOcr = r.json.jobId;
  chk('老師的列表不帶整張照片', !JSON.stringify(await jobsAs(tk, '?status=pending')).includes('base64'));
  await decide(jOcr, 'approve');
  const doneOcr = await waitJob(sk, jOcr);
  chk('核准後辨識完成，學生拿到文字', doneOcr?.status === 'done' && doneOcr.result.text === 'I like cats.\nShe runs fast.', JSON.stringify(doneOcr));
  r = await J(B, '/api/analyze-ocr', { method: 'POST', ...withCookie(tk), body: { image: png } });
  chk('老師自己辨識：直接執行', r.status === 200 && r.json.text);

  section('建單字表');
  r = await J(B, '/api/wordsets', { method: 'POST', ...withCookie(sk), body: { name: '學生申請的字表', text: 'apple, 蘋果\nbanana, 香蕉' } });
  chk('學生建字表 → 202，開申請單', r.status === 202 && r.json.pending && r.json.words === 2, r.text.slice(0, 100));
  const jWs = r.json.jobId;
  chk('核准前字表還沒有', !(await J(B, '/api/wordsets?user=x', withCookie(sk))).json.sets.some(s => s.name === '學生申請的字表'));
  await decide(jWs, 'approve');
  const doneWs = await waitJob(tk, jWs);
  chk('核准後建好', doneWs?.status === 'done' && doneWs.result.count === 2, JSON.stringify(doneWs));
  chk('字表出現在列表', (await J(B, '/api/wordsets?user=x', withCookie(sk))).json.sets.some(s => s.name === '學生申請的字表'));
  r = await J(B, '/api/wordsets?id=1', { method: 'DELETE', ...withCookie(sk) });
  chk('學生仍然不能刪字表 → 403', r.status === 403);

  section('AI 批改');
  r = await J(B, '/api/papers', { method: 'POST', ...withCookie(tk), body: { setIds: [fx.setId], articleIds: [fx.artId], n: 30, saver: true, seed: 11, mode: 'custom', types: ['mc', 'trans', 'make'] } });
  const paper = r.json.paper, pid = r.json.id;
  const openQs = paper.sections.flatMap(s => s.questions).filter(x => x.inputMode === 'open');
  const ans = {}; openQs.forEach((x, i) => { ans[x.id] = [i === 0 ? 'He wrong borrow book.' : 'I borrowed a book from my aunt yesterday.']; });
  await J(B, '/api/paper-submit', { method: 'POST', ...withCookie(sk), body: { id: pid, answers: ans } });
  const callsBeforeGrade = S.calls().length;
  r = await J(B, '/api/paper-ai-grade', { method: 'POST', ...withCookie(sk), body: { id: pid } });
  chk('學生請 AI 批改 → 202，開申請單，沒呼叫模型', r.status === 202 && r.json.pending && S.calls().length === callsBeforeGrade, r.text.slice(0, 120));
  const jGr = r.json.jobId;
  chk('老師看到報價（題數與預估費用）', (await jobsAs(tk, '?status=pending')).jobs.find(x => x.id === jGr).quote.count >= 2);
  await decide(jGr, 'approve');
  const doneGr = await waitJob(tk, jGr);
  chk('核准後批改完成', doneGr?.status === 'done', JSON.stringify(doneGr));
  chk('卷子上有 AI 批改結果', (await J(B, `/api/paper?id=${pid}`, withCookie(sk))).json.result.items.some(i => i.ai));

  section('失敗可以重新執行');
  const failText = 'Explode now please. Fine here.';
  const SF = await start('jobs-fail', { AUTH_USER: T.user, AUTH_PASS: T.pass, STUDENT_USER: K.user, STUDENT_PASS: K.pass, FAKE_FAIL_MATCH: 'Explode', ANALYZE_GROUP: '1' });
  const tkF = cookieFrom(await J(SF.base, '/api/login', { method: 'POST', body: T })), skF = cookieFrom(await J(SF.base, '/api/login', { method: 'POST', body: K }));
  r = await sseAs(SF.base, skF, { text: failText });
  const jF = ev(r, 'approval')[0].jobId;
  await J(SF.base, '/api/job-decide', { method: 'POST', ...withCookie(tkF), body: { id: jF, action: 'approve' } });
  let jf; for (let i = 0; i < 80 && !(jf = (await J(SF.base, '/api/jobs', withCookie(tkF))).json.jobs.find(x => x.id === jF && ['done', 'failed'].includes(x.status))); i++) await wait(150);
  chk('有一句失敗 → failed，說明已分析的保留', jf?.status === 'failed' && jf.result.failed === 1 && /重新執行只會處理失敗/.test(jf.result.error), JSON.stringify(jf));
  r = await J(SF.base, '/api/job-decide', { method: 'POST', ...withCookie(tkF), body: { id: jF, action: 'retry' } });
  chk('老師可以重新執行失敗的申請', r.status === 200 && ['approved', 'running', 'failed'].includes(r.json.job.status));
  await finish();
} catch (e) { await finish(e); } finally { try { rmSync(fx.dir, { recursive: true, force: true }); } catch {} }
