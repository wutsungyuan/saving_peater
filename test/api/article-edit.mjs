// 文章表編修：看句子、移動（拆分）、移除、調順序、合併。假 CLI，不花額度。
// 跑法：node --no-warnings test/api/article-edit.mjs
import { rmSync } from 'node:fs';
import { start, J, chk, section, finish } from './_harness.mjs';
import { makeFixture } from './_fixture.mjs';

const T = { user: 'teacher1', pass: 'teacher pass 123' }, K = { user: 'kid1', pass: 'kid pass 456' };
const cookieFrom = r => (r.headers.get('set-cookie') || '').split(';')[0];
const withCookie = c => ({ headers: { cookie: c } });
const fx = makeFixture('peater-artedit-');
const hs = fx.cache.db.prepare('SELECT hash FROM article_items WHERE article_id = ? ORDER BY idx').all(fx.artId).map(r => r.hash);
const artB = fx.cache.saveArticle({ name: '第二篇', items: [{ para: 0, hash: hs[0] }, { para: 0, hash: hs[1] }] }).id;
// 題庫：兩份文章表各有一題以它為範圍的題
fx.cache.putQuestions([{ id: 'q-a', type: 'read', src: 'scope', ref: String(fx.artId), payload: { x: 1 } }, { id: 'q-b', type: 'read', src: 'scope', ref: String(artB), payload: { x: 1 } }]);
fx.cache.db.close?.();
const ENV = { AUTH_USER: T.user, AUTH_PASS: T.pass, STUDENT_USER: K.user, STUDENT_PASS: K.pass, ANALYZE_GROUP: '1' };

try {
  const S = await start('article-edit', ENV, { dbFile: fx.dbFile });
  const B = S.base;
  const tk = cookieFrom(await J(B, '/api/login', { method: 'POST', body: T }));
  const sk = cookieFrom(await J(B, '/api/login', { method: 'POST', body: K }));
  const get = (p, ck = tk) => J(B, p, withCookie(ck));
  const post = (p, body, ck = tk) => J(B, p, { method: 'POST', ...withCookie(ck), body });
  const arts = async () => (await get('/api/admin/content')).json.articles;
  const sents = async id => (await get(`/api/admin/article-sentences?id=${id}`)).json.sentences;
  const N = hs.length;

  section('只有老師能用');
  for (const [m, p, body] of [['GET', `/api/admin/article-sentences?id=${fx.artId}`], ['POST', '/api/admin/article-move', { from: fx.artId, hashes: [hs[0]], newName: 'x' }],
    ['POST', '/api/admin/article-remove', { from: fx.artId, hashes: [hs[0]], confirm: true }], ['POST', '/api/admin/article-reorder', { id: fx.artId, hashes: hs }],
    ['POST', '/api/admin/article-merge', { from: [artB], into: fx.artId }]]) {
    const a = await J(B, p, { method: m, ...withCookie(sk), ...(body ? { body } : {}) });
    const n = await J(B, p, { method: m, ...(body ? { body } : {}) });
    chk(`${m} ${p.split('?')[0]}：學生 403、沒登入 401`, a.status === 403 && n.status === 401, `${a.status}/${n.status}`);
  }

  section('看句子');
  let r = await get(`/api/admin/article-sentences?id=${fx.artId}`);
  chk(`列出 ${N} 句，依序、帶原文`, r.status === 200 && r.json.sentences.length === N && r.json.sentences[0].hash === hs[0] && r.json.sentences[0].original.length > 5, r.text.slice(0, 120));
  chk('不存在 → 404', (await get('/api/admin/article-sentences?id=9999')).status === 404);

  section('調順序');
  const paras0 = (await sents(fx.artId)).map(s => s.para);
  const swapped = [hs[1], hs[0], ...hs.slice(2)];
  r = await post('/api/admin/article-reorder', { id: fx.artId, hashes: swapped });
  chk('換前兩句', r.status === 200 && (await sents(fx.artId)).slice(0, 2).map(s => s.hash).join() === [hs[1], hs[0]].join());
  chk('段落編號留在原位置（順序仍由小到大）', (await sents(fx.artId)).map(s => s.para).join() === paras0.join());
  chk('少一句 → 400', (await post('/api/admin/article-reorder', { id: fx.artId, hashes: swapped.slice(1) })).status === 400);
  chk('有不屬於這份的 → 400', (await post('/api/admin/article-reorder', { id: fx.artId, hashes: [...swapped.slice(1), 'nope'] })).status === 400);
  chk('調順序後該文章表的題庫作廢、別份的還在', fx.cache && (await (async () => {
    const { DatabaseSync } = await import('node:sqlite'); const d = new DatabaseSync(fx.dbFile, { readOnly: true });
    const q = d.prepare('SELECT id FROM questions WHERE ref IN (?,?)').all(String(fx.artId), String(artB)).map(x => x.id); d.close(); return q.join() === 'q-b'; })()));

  section('移動到新文章表（拆分）');
  r = await post('/api/admin/article-move', { from: fx.artId, hashes: [hs[10], hs[11], hs[12]], newName: '  加強句  ' });
  chk('建立新文章表並搬 3 句', r.status === 200 && r.json.moved === 3 && r.json.created === true, r.text.slice(0, 120));
  const newId = r.json.to;
  chk('新表 3 句、名稱去空白；原表少 3 句', (await arts()).find(a => a.id === newId)?.name === '加強句' && (await arts()).find(a => a.id === newId).count === 3 && (await arts()).find(a => a.id === fx.artId).count === N - 3);
  chk('新表的順序與段落正確（自成段落）', (await sents(newId)).map(s => s.hash).join() === [hs[10], hs[11], hs[12]].join() && new Set((await sents(newId)).map(s => s.para)).size === 1);
  chk('名稱重複 → 409', (await post('/api/admin/article-move', { from: fx.artId, hashes: [hs[2]], newName: '加強句' })).status === 409);
  chk('名稱空白 → 400；沒勾 → 400', (await post('/api/admin/article-move', { from: fx.artId, hashes: [hs[2]], newName: ' ' })).status === 400 && (await post('/api/admin/article-move', { from: fx.artId, hashes: [], newName: 'z' })).status === 400);
  const n0 = (await arts()).length;
  r = await post('/api/admin/article-move', { from: fx.artId, hashes: [hs[10]], newName: '空的' });
  chk('句子不在來源 → 搬 0 句，不留下空文章表', r.status === 200 && r.json.moved === 0 && (await arts()).length === n0);

  section('移動到既有文章表：已有的句子略過');
  r = await post('/api/admin/article-move', { from: fx.artId, hashes: [hs[0], hs[5]], to: artB });
  chk('hs0 目標已有 → 跳過，hs5 搬過去', r.status === 200 && r.json.moved === 1 && r.json.skipped === 1, r.text.slice(0, 120));
  chk('hs0 仍在原表、hs5 在目標最後', (await sents(fx.artId)).some(s => s.hash === hs[0]) && (await sents(artB)).at(-1).hash === hs[5]);
  chk('搬到自己 → 400；目標不存在 → 404', (await post('/api/admin/article-move', { from: fx.artId, hashes: [hs[2]], to: fx.artId })).status === 400 && (await post('/api/admin/article-move', { from: fx.artId, hashes: [hs[2]], to: 9999 })).status === 404);

  section('拿掉句子：先預覽、要確認');
  r = await post('/api/admin/article-remove', { from: newId, hashes: [hs[10], hs[11]] });
  chk('預覽：2 句、2 句會沒有範圍，沒動', r.status === 409 && r.json.sentences === 2 && r.json.orphaned === 2 && (await sents(newId)).length === 3, r.text.slice(0, 120));
  r = await post('/api/admin/article-remove', { from: artB, hashes: [hs[0]] });
  chk('hs0 另一份還在用 → 不算沒有範圍', r.status === 409 && r.json.sentences === 1 && r.json.orphaned === 0);
  r = await post('/api/admin/article-remove', { from: newId, hashes: [hs[10], hs[11]], confirm: true });
  chk('確認後拿掉', r.status === 200 && r.json.removed.sentences === 2 && (await sents(newId)).map(s => s.hash).join() === hs[12]);
  chk('句子分析還在句子庫', (await get('/api/admin/sentences?limit=1')).json.total >= N);
  chk('沒勾 → 400', (await post('/api/admin/article-remove', { from: newId, hashes: [] })).status === 400);

  section('合併');
  r = await post('/api/admin/article-merge', { from: [newId], into: fx.artId });
  chk('整份併入，來源刪除', r.status === 200 && r.json.moved === 1 && r.json.deleted === 1 && !(await arts()).some(a => a.id === newId) && (await sents(fx.artId)).at(-1).hash === hs[12], r.text.slice(0, 120));
  r = await post('/api/admin/article-merge', { from: [artB], into: fx.artId });
  chk('有重複句 → 略過重複，來源仍刪除', r.status === 200 && r.json.duplicates >= 1 && r.json.deleted === 1 && !(await arts()).some(a => a.id === artB), r.text.slice(0, 120));
  chk('合併到不存在 → 404', (await post('/api/admin/article-merge', { from: [fx.artId], into: 9999 })).status === 404);
  await finish();
} catch (e) { await finish(e); } finally { try { rmSync(fx.dir, { recursive: true, force: true }); } catch {} }
