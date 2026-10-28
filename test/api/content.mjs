// 內容管理：字表與文章表的清單、改名、對學生隱藏、刪除（先預覽、先備份）。假 CLI，不花額度。
// 跑法：node --no-warnings test/api/content.mjs
import { rmSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { start, J, chk, section, finish } from './_harness.mjs';
import { makeFixture } from './_fixture.mjs';

const T = { user: 'teacher1', pass: 'teacher pass 123' }, K = { user: 'kid1', pass: 'kid pass 456' };
const cookieFrom = r => (r.headers.get('set-cookie') || '').split(';')[0];
const withCookie = c => ({ headers: { cookie: c } });
const fx = makeFixture('peater-content-');
const setB = fx.cache.createWordset('第二份', [{ term: 'zebra', syllables: 'ze-bra', senses: [{ pos: 'n', zh: '斑馬' }], confusable: [], family: [] }]);
const [apple] = fx.cache.wordsOf([fx.setId], 'student');
fx.cache.recordWordAttempt({ userToken: 'student', wordId: apple.id, mode: 'zh2en', correct: true });
const artB = fx.cache.saveArticle({ name: '第二篇', items: fx.cache.db.prepare('SELECT hash FROM article_items WHERE article_id = ? LIMIT 3').all(fx.artId).map((r, i) => ({ para: 0, hash: r.hash })) }).id;
fx.cache.db.close?.();
const ENV = { AUTH_USER: T.user, AUTH_PASS: T.pass, STUDENT_USER: K.user, STUDENT_PASS: K.pass, ANALYZE_GROUP: '1' };

try {
  const S = await start('content', ENV, { dbFile: fx.dbFile });
  const B = S.base;
  const tk = cookieFrom(await J(B, '/api/login', { method: 'POST', body: T }));
  const sk = cookieFrom(await J(B, '/api/login', { method: 'POST', body: K }));
  const get = (p, ck = tk) => J(B, p, withCookie(ck));
  const post = (p, body, ck = tk) => J(B, p, { method: 'POST', ...withCookie(ck), body });

  section('只有老師能用');
  for (const [m, p, body] of [['GET', '/api/admin/content'], ['POST', '/api/admin/content-update', { kind: 'wordset', id: 1, hidden: true }],
    ['POST', '/api/admin/content-delete-preview', { kind: 'wordset', ids: [1] }], ['POST', '/api/admin/content-delete', { kind: 'wordset', ids: [1], confirm: true }]]) {
    const a = await J(B, p, { method: m, ...withCookie(sk), ...(body ? { body } : {}) });
    const n = await J(B, p, { method: m, ...(body ? { body } : {}) });
    chk(`${m} ${p}：學生 403、沒登入 401`, a.status === 403 && n.status === 401, `${a.status}/${n.status}`);
  }

  section('清單');
  let r = await get('/api/admin/content');
  chk('字表與文章表都列出，帶筆數與隱藏狀態', r.status === 200 && r.json.wordsets.length === 2 && r.json.articles.length === 2
    && r.json.wordsets.every(s => s.hidden === false && s.count > 0) && r.json.articles.every(a => a.hidden === false && a.count > 0), r.text.slice(0, 200));

  section('改名');
  r = await post('/api/admin/content-update', { kind: 'wordset', id: setB, name: '  動物  ', note: '加強用' });
  chk('字表改名與備註', r.status === 200 && (await get('/api/admin/content')).json.wordsets.find(s => s.id === setB)?.name === '動物' && (await get('/api/admin/content')).json.wordsets.find(s => s.id === setB)?.note === '加強用');
  r = await post('/api/admin/content-update', { kind: 'wordset', id: setB, name: '   ' });
  chk('空白名稱 → 400', r.status === 400 && r.json.error === 'no-name');
  r = await post('/api/admin/content-update', { kind: 'article', id: artB, name: '文章' });
  chk('文章表改成已有的名稱 → 409', r.status === 409 && r.json.error === 'name-taken');
  r = await post('/api/admin/content-update', { kind: 'article', id: artB, name: '第二篇改' });
  chk('文章表改名', r.status === 200 && (await get('/api/admin/content')).json.articles.find(a => a.id === artB)?.name === '第二篇改');
  r = await post('/api/admin/content-update', { kind: 'article', id: 9999, name: 'x' });
  chk('不存在 → 404', r.status === 404);

  section('隱藏：學生看不到、選不到；老師照常');
  r = await post('/api/admin/content-update', { kind: 'wordset', id: setB, hidden: true });
  chk('隱藏字表', r.status === 200 && (await get('/api/admin/content')).json.wordsets.find(s => s.id === setB).hidden === true);
  chk('老師的字表列表仍看得到（帶 hidden）', (await get('/api/wordsets')).json.sets.some(s => s.id === setB && s.hidden));
  chk('學生的字表列表看不到', !(await get('/api/wordsets', sk)).json.sets.some(s => s.id === setB) && (await get('/api/wordsets', sk)).json.sets.some(s => s.id === fx.setId));
  r = await get(`/api/wordset?ids=${setB}`, sk);
  chk('學生直接用 id 取被隱藏字表的單字 → 空', r.status === 200 && r.json.words.length === 0);
  r = await get(`/api/wordset?ids=${setB}`);
  chk('老師取得到', r.json.words.length === 1);
  r = await post('/api/wordquiz', { setIds: [setB], count: 3 }, sk);
  chk('學生用被隱藏字表出單字測驗 → 409', r.status === 409);
  r = await get('/api/wordsearch?q=zebra', sk);
  chk('學生搜尋搜不到被隱藏字表的字', r.json.total === 0);
  r = await get('/api/wordsearch?q=zebra');
  chk('老師搜尋得到', r.json.total === 1);

  await post('/api/admin/content-update', { kind: 'article', id: artB, hidden: true });
  chk('學生的文章表列表看不到被隱藏的', !(await get('/api/articles', sk)).json.articles.some(a => a.id === artB) && (await get('/api/articles', sk)).json.articles.some(a => a.id === fx.artId));
  chk('老師的文章表列表看得到（帶 hidden）', (await get('/api/articles')).json.articles.some(a => a.id === artB && a.hidden));
  chk('學生直接開被隱藏的文章表 → 404', (await get(`/api/article?id=${artB}`, sk)).status === 404 && (await get(`/api/article?id=${artB}`)).status === 200);
  r = await post('/api/exercises', { count: 3, types: ['tense', 'pos', 'pattern'], articleIds: [artB] }, sk);
  chk('學生用被隱藏的範圍出句子練習 → 409，不退回整個句子庫', r.status === 409 && r.json.error === 'no-sentences-in-scope', r.text.slice(0, 120));
  r = await post('/api/exercises', { count: 3, types: ['tense', 'pos', 'pattern'], articleIds: [artB] });
  chk('老師可以用被隱藏的範圍出題', r.status === 200 && r.json.questions.length > 0, r.text.slice(0, 120));

  await post('/api/admin/content-update', { kind: 'wordset', id: setB, hidden: false });
  chk('取消隱藏後學生又看得到', (await get('/api/wordsets', sk)).json.sets.some(s => s.id === setB));

  section('刪除：先預覽、要確認、先備份');
  r = await post('/api/admin/content-delete-preview', { kind: 'wordset', ids: [fx.setId] });
  const it = r.json.items?.[0];
  chk('字表預覽：單字、作答、熟練度筆數', r.status === 200 && it.words === 10 && it.attempts === 1 && it.progress === 1 && r.json.totals.words === 10, r.text.slice(0, 200));
  r = await post('/api/admin/content-delete-preview', { kind: 'article', ids: [artB] });
  chk('文章表預覽：句子數與會變成「沒有範圍」的句子數', r.status === 200 && r.json.items[0].sentences === 3 && r.json.items[0].orphaned === 0, r.text.slice(0, 200));
  r = await post('/api/admin/content-delete', { kind: 'wordset', ids: [fx.setId] });
  chk('沒帶 confirm → 409，沒刪', r.status === 409 && r.json.error === 'confirm-required' && (await get('/api/admin/content')).json.wordsets.length === 2);
  r = await post('/api/admin/content-delete', { kind: 'wordset', ids: [fx.setId], confirm: true });
  chk('確認後刪除，回報備份檔名', r.status === 200 && r.json.deleted === 1 && /before-delete-wordset/.test(r.json.backup), r.text.slice(0, 200));
  chk('字表不見了', (await get('/api/admin/content')).json.wordsets.every(s => s.id !== fx.setId));
  chk('備份檔存在', readdirSync(join(fx.dir, 'backups')).some(f => f === r.json.backup));
  r = await post('/api/admin/content-delete', { kind: 'article', ids: [artB], confirm: true });
  chk('刪文章表', r.status === 200 && r.json.deleted === 1 && (await get('/api/admin/content')).json.articles.every(a => a.id !== artB));
  chk('刪文章表不會刪句子', (await get('/api/admin/sentences?limit=1')).json.total > 20);
  await finish();
} catch (e) { await finish(e); } finally { try { rmSync(fx.dir, { recursive: true, force: true }); } catch {} }
