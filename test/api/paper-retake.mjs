// 重考與釘選：已交卷的卷子原樣再發一次（打亂選項、不呼叫模型）；釘選的不會過期、不被「最近 20 份」清掉。
// 假 CLI，不花額度。跑法：node --no-warnings test/api/paper-retake.mjs
import { start, J, chk, section, finish } from './_harness.mjs';

const T = { user: 'teacher1', pass: 'teacher pass 123' }, K = { user: 'kid1', pass: 'kid pass 456' };
const cookieFrom = r => (r.headers.get('set-cookie') || '').split(';')[0];
const withCookie = c => ({ headers: { cookie: c } });
const png = 'data:image/png;base64,' + Buffer.concat([Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]), Buffer.alloc(200)]).toString('base64');

try {
  const S = await start('retake', { AUTH_USER: T.user, AUTH_PASS: T.pass, STUDENT_USER: K.user, STUDENT_PASS: K.pass });
  const B = S.base;
  const tk = cookieFrom(await J(B, '/api/login', { method: 'POST', body: T })), sk = cookieFrom(await J(B, '/api/login', { method: 'POST', body: K }));
  const t = (p, o = {}) => J(B, p, { ...withCookie(tk), ...o }), s = (p, o = {}) => J(B, p, { ...withCookie(sk), ...o });
  const post = (p, body, who = t) => who(p, { method: 'POST', body });

  // 準備：匯入考卷（3 題）→ 發佈 → 學生作答（全對）→ 交卷
  const imp = await post('/api/exam-import', { images: [png], title: '期中考' });
  const id = imp.json.id;
  await post('/api/paper-edit', { id, action: 'publish' });
  const orig = (await t('/api/paper?id=' + id + '&admin=1')).json;
  const answers = Object.fromEntries(orig.sections.flatMap(x => x.questions).map(q => [q.id, q.answer]));
  const sub = await post('/api/paper-submit', { id, answers }, s);
  chk('準備：原卷已交卷', sub.status === 200 && sub.json.paper.status === 'submitted', sub.text.slice(0, 150));

  section('權限與狀態');
  chk('學生不能重考 → 403', (await post('/api/paper-retake', { id }, s)).status === 403);
  chk('學生不能釘選 → 403', (await post('/api/paper-pin', { id, pinned: true }, s)).status === 403);
  chk('沒登入 → 401', (await J(B, '/api/paper-retake', { method: 'POST', body: { id } })).status === 401);
  chk('不存在的卷子 → 410', (await post('/api/paper-retake', { id: 'pnope' })).status === 410);
  const draft = (await post('/api/exam-import', { images: [png], title: '草稿卷' })).json.id;
  chk('還沒交卷（草稿）的不能重考 → 409', (await post('/api/paper-retake', { id: draft })).status === 409);

  section('重考：沿用題目、直接發佈、打亂選項');
  const callsBefore2 = S.calls().length;
  let r = await post('/api/paper-retake', { id });
  chk('成功，名稱自動接（重考 1）', r.status === 200 && r.json.title === '期中考（重考 1）', r.text.slice(0, 200));
  const rid = r.json.id;
  chk('不呼叫模型（不花額度）', S.calls().length === callsBefore2);
  const sv = (await s('/api/paper?id=' + rid)).json;
  chk('學生看得到：已發佈（open）、沒有作答、沒有分數', sv.status === 'open' && Object.keys(sv.answers).length === 0 && sv.score == null);
  const rq = (await t('/api/paper?id=' + rid + '&admin=1')).json.sections.flatMap(x => x.questions);
  const oq = orig.sections.flatMap(x => x.questions);
  chk('題數、題幹、答案、配分都沿用', rq.length === oq.length && rq.every((q, i) => q.question === oq[i].question && JSON.stringify(q.answer) === JSON.stringify(oq[i].answer) && q.pts === oq[i].pts));
  chk('每題選項的集合不變（只是順序可能不同）', rq.every((q, i) => JSON.stringify(q.choices.map(c => c.label).sort()) === JSON.stringify(oq[i].choices.map(c => c.label).sort())));
  // 打亂有機率和原順序相同；多重考幾次，至少有一次順序不同才算有打亂
  let shuffled = false;
  for (let i = 0; i < 6 && !shuffled; i++){
    const x = (await post('/api/paper-retake', { id })).json.id;
    const q2 = (await t('/api/paper?id=' + x + '&admin=1')).json.sections.flatMap(y => y.questions);
    shuffled = q2.some((q, k) => JSON.stringify(q.choices.map(c => c.label)) !== JSON.stringify(oq[k].choices.map(c => c.label)));
  }
  chk('選項順序確實有被打亂', shuffled);
  const hist = (await t('/api/papers')).json.papers;
  chk('歷史裡有重考卷，標示 retakeOf = 原卷、不是訂正', hist.some(p => p.id === rid && p.retakeOf === id && p.kind === 'normal'));
  chk('原卷分數沒被動到', hist.find(p => p.id === id).score === sub.json.paper.score);
  chk('同一份再重考 → 名稱的號碼往上加', (await post('/api/paper-retake', { id })).json.title.startsWith('期中考（重考 '));

  section('重考卷作答：照常計分');
  const sub2 = await post('/api/paper-submit', { id: rid, answers: Object.fromEntries(rq.map(q => [q.id, q.answer])) }, s);
  chk('依原答案作答 → 滿分（打亂不影響批改）', sub2.status === 200 && sub2.json.paper.result.wrong === 0 && sub2.json.paper.score === sub.json.paper.score, sub2.text.slice(0, 200));
  r = await post('/api/paper-retake', { id: rid, title: '週末加強' });
  chk('重考卷也能再重考；可自己取名', r.status === 200 && r.json.title === '週末加強');
  chk('訂正卷不能重考 → 409', (await (async () => { const bad = await post('/api/paper-submit', { id: (await post('/api/paper-retake', { id })).json.id, answers: {} }, s); const fx = await post('/api/paper-redo', { id: bad.json.paper.id }, s); return post('/api/paper-retake', { id: fx.json.id }); })()).status === 409);

  section('釘選：不會過期、不被份數清掉');
  r = await post('/api/paper-pin', { id, pinned: true });
  chk('釘選成功', r.status === 200 && r.json.pinned === true);
  let h = (await t('/api/papers')).json.papers.find(p => p.id === id);
  chk('歷史標示已釘選、到期日在幾十年後', h.pinned === true && h.expiresAt > Date.now() + 50 * 365 * 86400_000);
  chk('用這份卷子重考，新卷子不會繼承釘選', !(await t('/api/papers')).json.papers.find(p => p.id === rid).pinned);
  const c = (await import('../../src/cache.mjs')).openCache(S.dbFile);
  for (let i = 0; i < 25; i++) c.putPaper({ id: 'bulk' + i, n: 25, settings: { n: 25 }, data: { sections: [], questions: [], answers: {}, self: {} } });
  c.prunePapers({ keep: 20 });
  chk('清理：釘選的卷子沒被「最近 20 份」清掉', Boolean(c.getPaper(id)));
  chk('一般卷子只留最近 20 份（釘選的不算在內）', c.papers(200).filter(p => p.status !== 'draft' && !p.settings.pinned).length === 20);
  chk('歷史列表裡，釘選的卷子即使很舊、被擠出最近 50 份也看得到', c.papers(5).some(p => p.id === id));
  c.close();

  r = await post('/api/paper-pin', { id, pinned: false });
  h = (await t('/api/papers')).json.papers.find(p => p.id === id);
  chk('取消釘選：重新計 30 天，不會馬上消失', r.json.pinned === false && !h.pinned && h.expiresAt > Date.now() + 25 * 86400_000 && h.expiresAt < Date.now() + 35 * 86400_000);
  await finish();
} catch (e) { await finish(e); }
