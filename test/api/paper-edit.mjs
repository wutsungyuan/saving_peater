// 老師編修卷子：草稿 → 換題、刪題、改名 → 發佈給學生；學生只看得到已發佈的；老師看得到學生的逐題作答。假 CLI，不花額度。
// 跑法：node --no-warnings test/api/paper-edit.mjs
import { rmSync } from 'node:fs';
import { start, J, chk, section, finish } from './_harness.mjs';
import { makeFixture, readPaper } from './_fixture.mjs';

const T = { user: 'teacher1', pass: 'teacher pass 123' }, K = { user: 'kid1', pass: 'kid pass 456' };
const cookieFrom = r => (r.headers.get('set-cookie') || '').split(';')[0];
const withCookie = c => ({ headers: { cookie: c } });
const fx = makeFixture('peater-pedit-');
fx.cache.db.close?.();
const SC = { setIds: [fx.setId], articleIds: [fx.artId], n: 36, saver: true, mode: 'custom', types: ['mc', 'reorder', 'fix', 'fill', 'match'], seed: 21 };
const sum = qs => qs.reduce((a, q) => a + q.pts, 0);

try {
  const S = await start('pedit', { AUTH_USER: T.user, AUTH_PASS: T.pass, STUDENT_USER: K.user, STUDENT_PASS: K.pass }, { dbFile: fx.dbFile });
  const B = S.base;
  const tk = cookieFrom(await J(B, '/api/login', { method: 'POST', body: T }));
  const sk = cookieFrom(await J(B, '/api/login', { method: 'POST', body: K }));
  const t = (p, o = {}) => J(B, p, { ...withCookie(tk), ...o }), s = (p, o = {}) => J(B, p, { ...withCookie(sk), ...o });
  const edit = (body, who = t) => who('/api/paper-edit', { method: 'POST', body });

  section('出成草稿：學生看不到');
  let r = await t('/api/papers', { method: 'POST', body: { ...SC, draft: true, title: '第一單元複習' } });
  const id = r.json.id;
  chk('老師出卷 draft:true → 草稿', r.status === 200 && r.json.paper.status === 'draft', r.text.slice(0, 120));
  chk('老師的歷史看得到草稿，帶標題', (await t('/api/papers')).json.papers.find(p => p.id === id)?.status === 'draft' && (await t('/api/papers')).json.papers.find(p => p.id === id).title === '第一單元複習');
  chk('學生的歷史看不到草稿', !(await s('/api/papers')).json.papers.some(p => p.id === id));
  chk('學生直接取草稿 → 410', (await s('/api/paper?id=' + id)).status === 410);
  chk('草稿不能存檔、不能交卷', (await s('/api/paper-save', { method: 'POST', body: { id, answers: {} } })).status === 409 && (await s('/api/paper-submit', { method: 'POST', body: { id, answers: {} } })).status === 409);
  r = await t('/api/paper?id=' + id + '&admin=1');
  chk('老師看到含答案的版本', r.status === 200 && r.json.editable === true && r.json.sections[0].questions[0].answer?.length >= 1 && r.json.title === '第一單元複習', r.text.slice(0, 100));
  chk('一般取法（沒帶 admin）不含答案', !('answer' in (await t('/api/paper?id=' + id)).json.sections[0].questions[0]));
  chk('學生不能編修 → 403', (await edit({ id, action: 'publish' }, s)).status === 403);

  section('改名');
  r = await edit({ id, action: 'rename', title: '期中複習 A' });
  chk('改名成功', r.status === 200 && r.json.paper.title === '期中複習 A');

  section('換一題：同題型、不重複、分數不變');
  const full = (await t('/api/paper?id=' + id + '&admin=1')).json;
  const qs0 = full.sections.flatMap(x => x.questions);
  const target = qs0.find(q => q.section === 'mc' && !q.passageId);
  const keysBefore = new Set(qs0.map(q => q.meta?.key));
  r = await edit({ id, action: 'swap', questionId: target.id });
  const after = r.json.paper.sections.flatMap(x => x.questions);
  const swapped = after.find(q => q.id === target.id);
  chk('換題成功：同一個編號、同題型、同分數', r.status === 200 && swapped && swapped.type === target.type && swapped.pts === target.pts && swapped.section === 'mc', r.text.slice(0, 120));
  chk('換進來的題不是原本卷子裡有的', !keysBefore.has(swapped.meta?.key), swapped.meta?.key);
  chk('總題數與總分不變（100）', after.length === qs0.length && sum(after) === 100, String(sum(after)));
  chk('沒有呼叫模型', S.calls().length === 0);

  section('刪一題：分數重新分配，滿分仍是 100');
  const delTarget = after.find(q => q.section === 'fill') || after.find(q => q.section === 'match');
  r = await edit({ id, action: 'remove', questionId: delTarget.id });
  const left = r.json.paper.sections.flatMap(x => x.questions);
  chk('刪題成功：少一題', r.status === 200 && left.length === after.length - 1 && !left.some(q => q.id === delTarget.id), r.text.slice(0, 120));
  chk('滿分仍然剛好 100', sum(left) === 100, String(sum(left)));
  chk('每個區塊的題數與標示一致', r.json.paper.sections.every(sec => sec.n === sec.questions.length) && r.json.paper.n === left.length);
  const dbq = readPaper(fx.dbFile, id).data;
  chk('資料庫裡的 n 與題目數一致', readPaper(fx.dbFile, id).data.questions.length === left.length);
  chk('找不到的題 → 409', (await edit({ id, action: 'remove', questionId: 'q999' })).status === 409);

  section('閱讀、克漏字等綁文章的題不能單題編修');
  const SC2 = { setIds: [fx.setId], articleIds: [fx.artId], n: 30, saver: false, mode: 'custom', types: ['mc', 'cloze'], seed: 5, draft: true, confirm: true };
  r = await t('/api/papers', { method: 'POST', body: SC2 });
  if (r.status === 200){
    const idc = r.json.id, cq = (await t('/api/paper?id=' + idc + '&admin=1')).json.sections.flatMap(x => x.questions).find(q => q.passageId);
    r = cq ? await edit({ id: idc, action: 'remove', questionId: cq.id }) : { status: 0 };
    chk('克漏字的題：刪、換都不行（綁文章）', cq && r.status === 409 && /文章/.test(r.json.message) && (await edit({ id: idc, action: 'swap', questionId: cq.id })).status === 409, r.text?.slice(0, 100));
  } else chk('（略）這個素材出不了克漏字', true);

  section('至少留 10 題');
  const SC3 = { ...SC, n: 25, seed: 33, draft: true };
  r = await t('/api/papers', { method: 'POST', body: SC3 });
  const id3 = r.json.id; let cur = r.json.paper.sections.flatMap(x => x.questions); let guard = 0, lastErr = null;
  while (cur.length > 10 && guard++ < 30){
    const q = cur.find(x => !x.passageId); const rr = await edit({ id: id3, action: 'remove', questionId: q.id });
    if (rr.status !== 200){ lastErr = rr; break; }
    cur = rr.json.paper.sections.flatMap(x => x.questions);
    if (sum(cur) !== 100){ lastErr = { text: '分數不是 100：' + sum(cur) }; break; }
  }
  chk('一路刪下去每一步滿分都是 100', !lastErr || lastErr.json?.error === 'cannot-rescore', lastErr?.text?.slice(0, 120));
  if (cur.length === 10){
    r = await edit({ id: id3, action: 'remove', questionId: cur[0].id });
    chk('剩 10 題再刪 → 擋下', r.status === 409 && r.json.error === 'too-few', r.text.slice(0, 100));
  } else chk('（刪到分數分不出 100 時有擋下）', lastErr?.json?.error === 'cannot-rescore');

  section('發佈、學生作答、老師看逐題作答');
  r = await edit({ id, action: 'publish' });
  chk('發佈：草稿 → 作答中', r.status === 200 && r.json.paper.status === 'open' && r.json.paper.editable === false);
  chk('學生的歷史出現了這份、拿得到卷子（沒有答案）', (await s('/api/papers')).json.papers.some(p => p.id === id) && !('answer' in (await s('/api/paper?id=' + id)).json.sections[0].questions[0]));
  chk('已發佈的不能改題目 → 409，提示先收回', (await edit({ id, action: 'remove', questionId: left[0].id })).status === 409);
  chk('發佈兩次 → 409', (await edit({ id, action: 'publish' })).status === 409);
  r = await edit({ id, action: 'unpublish' });
  chk('學生還沒作答：可以收回成草稿', r.status === 200 && r.json.paper.status === 'draft' && !(await s('/api/papers')).json.papers.some(p => p.id === id));
  await edit({ id, action: 'publish' });
  const pub = (await s('/api/paper?id=' + id)).json, q1 = pub.sections[0].questions[0];
  await s('/api/paper-save', { method: 'POST', body: { id, answers: { [q1.id]: ['x'] } } });
  r = await edit({ id, action: 'unpublish' });
  chk('學生已經開始作答：不能收回 → 409', r.status === 409 && r.json.error === 'has-answers');
  const mine = pub.sections.flatMap(x => x.questions);
  const sub = await s('/api/paper-submit', { method: 'POST', body: { id, answers: Object.fromEntries(mine.map(q => [q.id, q.inputMode === 'choice' ? [String(q.choices[0].value)] : ['x']])) } });
  chk('學生交卷', sub.status === 200 && sub.json.paper.status === 'submitted');
  r = await t('/api/paper?id=' + id);
  chk('老師看到學生每一題的作答、對錯、參考答案', r.status === 200 && r.json.result.items.length === mine.length && r.json.result.items.every(i => 'given' in i && 'expected' in i && 'correct' in i), r.text.slice(0, 100));
  chk('交卷後不能改題目、不能收回', (await edit({ id, action: 'remove', questionId: mine[0].id })).status === 409 && (await edit({ id, action: 'unpublish' })).status === 409);

  section('清理：草稿不被「最近幾份」清掉');
  const c = (await import('../../src/cache.mjs')).openCache(S.dbFile);
  for (let i = 0; i < 25; i++) c.putPaper({ id: 'bulk' + i, n: 25, settings: { n: 25 }, data: { sections: [], questions: [], answers: {}, self: {} } });
  c.prunePapers({ keep: 20 });
  chk('草稿還在', Boolean(c.getPaper(id3)) && c.getPaper(id3).status === 'draft');
  chk('一般卷子只留最近 20 份', c.papers(100).filter(p => p.status !== 'draft').length === 20);
  c.close();
  await finish();
} catch (e) { await finish(e); } finally { try { rmSync(fx.dir, { recursive: true, force: true }); } catch {} }
