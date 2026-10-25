// 老師後台：/admin 入口、句子管理（列表、搜尋、篩選、看分析、排除出題、重新分析、刪除）、看學生的紀錄。假 CLI，不花額度。
// 跑法：node --no-warnings test/api/admin.mjs
import { rmSync } from 'node:fs';
import { start, J, chk, section, finish } from './_harness.mjs';
import { makeFixture } from './_fixture.mjs';

const T = { user: 'teacher1', pass: 'teacher pass 123' }, K = { user: 'kid1', pass: 'kid pass 456' };
const cookieFrom = r => (r.headers.get('set-cookie') || '').split(';')[0];
const withCookie = c => ({ headers: { cookie: c } });
const fx = makeFixture('peater-admin-');
fx.cache.db.close?.();
const ENV = { AUTH_USER: T.user, AUTH_PASS: T.pass, STUDENT_USER: K.user, STUDENT_PASS: K.pass, ANALYZE_GROUP: '1' };

try {
  const S = await start('admin', ENV, { dbFile: fx.dbFile });
  const B = S.base;
  const tk = cookieFrom(await J(B, '/api/login', { method: 'POST', body: T }));
  const sk = cookieFrom(await J(B, '/api/login', { method: 'POST', body: K }));
  const get = (p, ck = tk) => J(B, p, withCookie(ck));
  const post = (p, body, ck = tk) => J(B, p, { method: 'POST', ...withCookie(ck), body });

  section('/admin 入口');
  let r = await fetch(B + '/admin'); let html = await r.text();
  chk('沒登入：送出同一份頁面（頁面自己會跳出登入框）', r.status === 200 && /view-sentences/.test(html));
  r = await fetch(B + '/admin', { headers: { cookie: tk } });
  chk('老師：200', r.status === 200 && /view-sentences/.test(await r.text()));
  r = await fetch(B + '/admin/', { headers: { cookie: tk } });
  chk('/admin/ 也可以', r.status === 200);
  r = await fetch(B + '/admin', { headers: { cookie: sk } }); html = await r.text();
  chk('學生：403，明確說只有老師能用，不是 not found', r.status === 403 && /只有老師能用/.test(html) && !/view-sentences/.test(html));
  r = await fetch(B + '/administrator');
  chk('其他網址照舊 404', r.status === 404);

  section('學生與沒登入都不能用句子管理');
  for (const [m, p, body] of [['GET', '/api/admin/sentences'], ['GET', '/api/admin/sentence?hash=x'], ['POST', '/api/admin/sentence-exclude', { hash: 'x', excluded: true }],
    ['DELETE', '/api/admin/sentence?hash=x'], ['POST', '/api/admin/sentence-reanalyze', { hash: 'x' }]]) {
    const a = await J(B, p, { method: m, ...withCookie(sk), ...(body ? { body } : {}) });
    const n = await J(B, p, { method: m, ...(body ? { body } : {}) });
    chk(`${m} ${p}：學生 403、沒登入 401`, a.status === 403 && n.status === 401, `${a.status}/${n.status}`);
  }

  section('列表、搜尋、篩選');
  r = await get('/api/admin/sentences?limit=5');
  chk('列表：有總數、每句有原文、翻譯、句型、命中數、使用情形', r.status === 200 && r.json.total > 20 && r.json.items.length === 5 && r.json.items.every(x => x.original && 'translation' in x && 'hits' in x && 'usedInArticles' in x), r.text.slice(0, 160));
  const first = r.json.items[0];
  r = await get(`/api/admin/sentences?q=${encodeURIComponent(first.original.split(' ')[0])}&limit=100`);
  chk('搜尋原文：找得到', r.json.items.some(x => x.hash === first.hash));
  r = await get('/api/admin/sentences?q=zzzqqq');
  chk('搜不到 → 空', r.json.total === 0 && r.json.items.length === 0);
  r = await get('/api/admin/sentences?limit=5&offset=5');
  chk('分頁：offset', r.json.items.length === 5 && !r.json.items.some(x => x.hash === first.hash));
  r = await get('/api/admin/sentences?filter=unused&limit=100');
  chk('篩選「沒有被文章用到」：結果都沒被用到', r.json.items.length > 0 && r.json.items.every(x => x.usedInArticles === 0));

  section('看完整分析');
  r = await get('/api/admin/sentence?hash=' + first.hash);
  chk('完整分析（含 clauses、words）、哪些文章用到', r.status === 200 && r.json.data?.clauses?.length && r.json.data?.words?.length && Array.isArray(r.json.usedIn), r.text.slice(0, 120));
  chk('找不到的 hash → 404', (await get('/api/admin/sentence?hash=nope')).status === 404);

  section('排除出題');
  const before = (await post('/api/paper-preview', { setIds: [fx.setId], articleIds: [fx.artId], n: 30 })).json.scope.sentences;
  const inArt = (await get('/api/admin/sentences?limit=100&filter=all')).json.items.find(x => x.usedInArticles > 0);
  r = await post('/api/admin/sentence-exclude', { hash: inArt.hash, excluded: true });
  chk('排除成功', r.status === 200 && r.json.excluded === true);
  chk('篩選「已排除出題」找得到', (await get('/api/admin/sentences?filter=excluded')).json.items.map(x => x.hash).join() === inArt.hash);
  const after = (await post('/api/paper-preview', { setIds: [fx.setId], articleIds: [fx.artId], n: 30 })).json.scope.sentences;
  chk('測驗卷的素材池少了一句', after === before - 1, `${before} → ${after}`);
  chk('但畫面照常能顯示（分析還在快取）', (await get('/api/admin/sentence?hash=' + inArt.hash)).json.data?.original === inArt.original);
  await post('/api/admin/sentence-exclude', { hash: inArt.hash, excluded: false });
  const back = (await post('/api/paper-preview', { setIds: [fx.setId], articleIds: [fx.artId], n: 30 })).json.scope.sentences;
  chk('恢復後素材池回來', back === before);

  section('刪除');
  r = await J(B, '/api/admin/sentence?hash=' + inArt.hash, { method: 'DELETE', ...withCookie(tk) });
  chk('還在文章表裡的不能刪 → 409，說明在哪篇文章', r.status === 409 && r.json.articles.length >= 1 && /文章表/.test(r.json.message), r.text.slice(0, 120));
  await J(B, '/api/analyze', { method: 'POST', ...withCookie(tk), body: { text: 'Birds can fly high.' } });
  const bird = (await get('/api/admin/sentences?q=Birds%20can%20fly')).json.items[0];
  chk('老師自己分析了一句，沒被文章用到', bird && bird.usedInArticles === 0);
  r = await J(B, '/api/admin/sentence?hash=' + bird.hash, { method: 'DELETE', ...withCookie(tk) });
  chk('沒被用到的可以刪', r.status === 200 && (await get('/api/admin/sentences?q=Birds%20can%20fly')).json.total === 0);

  section('沒有範圍的句子：歸進文章表');
  for (const s of ['Fish swim fast.', 'Dogs bark loudly.']) await J(B, '/api/analyze', { method: 'POST', ...withCookie(tk), body: { text: s } });
  for (const [p, body] of [['/api/admin/sentences-assign', { mode: 'name', name: 'x' }]]) {
    const a = await J(B, p, { method: 'POST', ...withCookie(sk), body }), n = await J(B, p, { method: 'POST', body });
    chk('學生 403、沒登入 401', a.status === 403 && n.status === 401, `${a.status}/${n.status}`);
  }
  r = await post('/api/admin/sentences-assign', { mode: 'name', name: '', q: 'Fish swim' });
  chk('歸入指定名稱但沒填名稱 → 400', r.status === 400 && r.json.error === 'no-name');
  const arts0 = (await get('/api/articles')).json.articles.length;
  r = await post('/api/admin/sentences-assign', { mode: 'name', name: '動物句', q: 'Fish swim' });
  chk('預覽：1 句、新建「動物句」，不改資料', r.status === 200 && r.json.total === 1 && r.json.groups[0].name === '動物句' && r.json.groups[0].exists === false && (await get('/api/articles')).json.articles.length === arts0, r.text);
  r = await post('/api/admin/sentences-assign', { mode: 'name', name: '動物句', q: 'Fish swim', confirm: true });
  chk('確認：歸入 1 句', r.status === 200 && r.json.added === 1, r.text);
  const an = (await get('/api/articles')).json.articles.find(a => a.name === '動物句');
  chk('文章表「動物句」有 1 句', an?.sentences === 1);
  chk('那句不再是「沒有範圍」', !(await get('/api/admin/sentences?filter=unused&q=Fish%20swim')).json.items.length);
  r = await post('/api/admin/sentences-assign', { mode: 'name', name: '動物句', q: 'Fish swim' });
  chk('已歸入的不會再被列出', r.json.total === 0);
  r = await post('/api/admin/sentences-assign', { mode: 'by-date', q: 'Dogs bark' });
  const day = `句子 ${new Date().getMonth() + 1}/${new Date().getDate()}`;
  chk('依日期預覽：今天分析的 → 「句子 月/日」', r.json.total === 1 && r.json.groups[0].name === day, r.text);
  r = await post('/api/admin/sentences-assign', { mode: 'by-date', q: 'Dogs bark', confirm: true });
  chk('依日期歸入', r.status === 200 && r.json.added === 1 && (await get('/api/articles')).json.articles.find(a => a.name === day)?.sentences === 1);
  const exA = await post('/api/exercises', { count: 5, types: ['tense'], articleIds: [an.id], userToken: 't-assign' });
  chk('歸入後，句子練習選這個範圍抽得到', exA.status === 200 && exA.json.scope[0] === '動物句');

  section('重新分析：先報價、確認才呼叫、失敗保留舊的');
  await J(B, '/api/analyze', { method: 'POST', ...withCookie(tk), body: { text: 'Explode now please.' } });
  const ex = (await get('/api/admin/sentences?q=Explode')).json.items[0];
  const calls0 = S.calls().length;
  r = await post('/api/admin/sentence-reanalyze', { hash: ex.hash });
  chk('沒確認 → 409 附報價，沒呼叫模型', r.status === 409 && r.json.error === 'confirm-required' && r.json.quote.estimate.high > 0 && S.calls().length === calls0, r.text.slice(0, 120));
  r = await post('/api/admin/sentence-reanalyze', { hash: ex.hash, confirm: true });
  chk('確認後重新分析成功、呼叫一次模型', r.status === 200 && S.calls().length === calls0 + 1);
  chk('句子還在、命中數與時間更新（新的一筆）', (await get('/api/admin/sentences?q=Explode')).json.items[0].createdAt >= ex.createdAt);
  await post('/api/admin/sentence-exclude', { hash: ex.hash, excluded: true });
  await post('/api/admin/sentence-reanalyze', { hash: ex.hash, confirm: true });
  chk('排除標記在重新分析後保留', (await get('/api/admin/sentences?q=Explode')).json.items[0].excluded === true);

  const F = await start('admin-fail', { ...ENV, FAKE_FAIL_MATCH: 'Explode' }, { dbFile: fx.dbFile });
  const tkF = cookieFrom(await J(F.base, '/api/login', { method: 'POST', body: T }));
  const old = (await J(F.base, '/api/admin/sentences?q=Explode', withCookie(tkF))).json.items[0];
  r = await J(F.base, '/api/admin/sentence-reanalyze', { method: 'POST', ...withCookie(tkF), body: { hash: ex.hash, confirm: true } });
  chk('模型失敗 → 502，說明保留了原本的結果', r.status === 502 && /已保留原本的結果/.test(r.json.message), r.text.slice(0, 160));
  const kept = (await J(F.base, '/api/admin/sentences?q=Explode', withCookie(tkF))).json.items[0];
  chk('原本的分析沒有被弄丟（句子、時間、排除標記都在）', kept && kept.hash === old.hash && kept.createdAt === old.createdAt && kept.excluded === true, JSON.stringify(kept));
  chk('還能正常顯示', (await J(F.base, '/api/admin/sentence?hash=' + ex.hash, withCookie(tkF))).json.data?.clauses?.length > 0);

  section('老師在後台看學生的紀錄');
  await post('/api/exercises', { count: 2, types: ['pattern'] }, sk).then(async q => post('/api/attempts', { quizId: q.json.quizId, answers: {} }, sk));
  r = await get('/api/weakness?as=student', tk);
  chk('as=student：老師看到學生的作答（不是自己的）', r.json.overall.total > 0, r.text.slice(0, 100));
  r = await get('/api/weakness', tk);
  chk('不帶 as：老師看到的是自己的（沒作答）', r.json.overall.total === 0);
  r = await get('/api/weakness?as=student&user=teacher', sk);
  chk('學生帶 as=student 沒有特別效果：看到的仍是自己的', r.json.overall.total > 0);
  await finish();
} catch (e) { await finish(e); } finally { try { rmSync(fx.dir, { recursive: true, force: true }); } catch {} }
