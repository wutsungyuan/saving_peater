// 字表編修：看單字、移動（到新字表或既有字表）、移除、合併。假 CLI，不花額度。
// 跑法：node --no-warnings test/api/wordset-edit.mjs
import { rmSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { start, J, chk, section, finish } from './_harness.mjs';
import { makeFixture, W } from './_fixture.mjs';

const T = { user: 'teacher1', pass: 'teacher pass 123' }, K = { user: 'kid1', pass: 'kid pass 456' };
const cookieFrom = r => (r.headers.get('set-cookie') || '').split(';')[0];
const withCookie = c => ({ headers: { cookie: c } });
const fx = makeFixture('peater-wsedit-');
const setB = fx.cache.createWordset('第二份', [W('apple', 'n', '蘋果', 'x', 'y'), W('zebra', 'n', '斑馬', 'x', 'y')]);
const words = fx.cache.wordsOf([fx.setId], 'student');
const byTerm = Object.fromEntries(words.map(w => [w.term, w]));
fx.cache.recordWordAttempt({ userToken: 'student', wordId: byTerm.teach.id, mode: 'zh2en', correct: true });
fx.cache.recordWordAttempt({ userToken: 'student', wordId: byTerm.lend.id, mode: 'zh2en', correct: true });
fx.cache.db.close?.();
const ENV = { AUTH_USER: T.user, AUTH_PASS: T.pass, STUDENT_USER: K.user, STUDENT_PASS: K.pass, ANALYZE_GROUP: '1' };

try {
  const S = await start('wordset-edit', ENV, { dbFile: fx.dbFile });
  const B = S.base;
  const tk = cookieFrom(await J(B, '/api/login', { method: 'POST', body: T }));
  const sk = cookieFrom(await J(B, '/api/login', { method: 'POST', body: K }));
  const get = (p, ck = tk) => J(B, p, withCookie(ck));
  const post = (p, body, ck = tk) => J(B, p, { method: 'POST', ...withCookie(ck), body });
  const sets = async () => (await get('/api/admin/content')).json.wordsets;
  const wordsIn = async id => (await get(`/api/admin/wordset-words?id=${id}`)).json.words;

  section('只有老師能用');
  for (const [m, p, body] of [['GET', `/api/admin/wordset-words?id=${fx.setId}`], ['POST', '/api/admin/wordset-move', { from: fx.setId, wordIds: [1], newName: 'x' }],
    ['POST', '/api/admin/wordset-remove', { from: fx.setId, wordIds: [1], confirm: true }], ['POST', '/api/admin/wordset-merge', { from: [setB], into: fx.setId }]]) {
    const a = await J(B, p, { method: m, ...withCookie(sk), ...(body ? { body } : {}) });
    const n = await J(B, p, { method: m, ...(body ? { body } : {}) });
    chk(`${m} ${p.split('?')[0]}：學生 403、沒登入 401`, a.status === 403 && n.status === 401, `${a.status}/${n.status}`);
  }

  section('看單字');
  let r = await get(`/api/admin/wordset-words?id=${fx.setId}`);
  chk('列出 10 個字，帶詞義與作答次數', r.status === 200 && r.json.words.length === 10 && r.json.words.find(w => w.term === 'teach').zh === '教導' && r.json.words.find(w => w.term === 'teach').attempts === 1, r.text.slice(0, 160));
  chk('不存在的字表 → 404', (await get('/api/admin/wordset-words?id=9999')).status === 404);

  section('移動到新字表（拆分）');
  r = await post('/api/admin/wordset-move', { from: fx.setId, wordIds: [byTerm.teach.id, byTerm.lend.id], newName: '  加強  ', note: '要加強' });
  chk('建立新字表並搬 2 個字', r.status === 200 && r.json.moved === 2 && r.json.created === true && r.json.skipped.length === 0, r.text.slice(0, 160));
  const newId = r.json.to;
  let all = await sets();
  chk('新字表名稱已去空白、備註帶入、2 個字', all.find(s => s.id === newId)?.name === '加強' && all.find(s => s.id === newId).note === '要加強' && all.find(s => s.id === newId).count === 2);
  chk('原字表剩 8 個', all.find(s => s.id === fx.setId).count === 8);
  const moved = await wordsIn(newId);
  chk('移動的字進度跟著走（作答次數還在）', moved.find(w => w.term === 'teach')?.attempts === 1 && moved.find(w => w.term === 'lend')?.attempts === 1);
  chk('學生端看得到新字表與其單字', (await get('/api/wordsets', sk)).json.sets.some(s => s.id === newId)
    && (await get(`/api/wordset?ids=${newId}`, sk)).json.words.some(w => w.term === 'teach' && w.total === 1));
  chk('新字表名稱空白 → 400', (await post('/api/admin/wordset-move', { from: fx.setId, wordIds: [byTerm.piano.id], newName: '  ' })).status === 400);
  chk('沒勾單字 → 400', (await post('/api/admin/wordset-move', { from: fx.setId, wordIds: [], newName: 'x' })).status === 400);
  const before = (await sets()).length;
  r = await post('/api/admin/wordset-move', { from: fx.setId, wordIds: [byTerm.teach.id], newName: '空的' });
  chk('單字不在來源字表 → 搬 0 個，不留下空字表', r.status === 200 && r.json.moved === 0 && (await sets()).length === before);

  section('移動到既有字表：同字跳過、留在原處');
  r = await post('/api/admin/wordset-move', { from: fx.setId, wordIds: [byTerm.apple.id, byTerm.piano.id], to: setB });
  chk('apple 目標已有 → 跳過，piano 搬過去', r.status === 200 && r.json.moved === 1 && r.json.skipped.join() === 'apple', r.text.slice(0, 160));
  chk('apple 仍在原字表', (await wordsIn(fx.setId)).some(w => w.term === 'apple') && !(await wordsIn(fx.setId)).some(w => w.term === 'piano'));
  chk('搬到同一份 → 400', (await post('/api/admin/wordset-move', { from: fx.setId, wordIds: [byTerm.school.id], to: fx.setId })).status === 400);
  chk('目標不存在 → 404', (await post('/api/admin/wordset-move', { from: fx.setId, wordIds: [byTerm.school.id], to: 9999 })).status === 404);

  section('移除單字：先預覽、要確認、先備份');
  r = await post('/api/admin/wordset-remove', { from: newId, wordIds: [moved.find(w => w.term === 'teach').id] });
  chk('預覽：1 字、1 筆作答、1 筆熟練度，沒刪', r.status === 409 && r.json.error === 'confirm-required' && r.json.words === 1 && r.json.attempts === 1 && r.json.progress === 1 && (await wordsIn(newId)).length === 2, r.text.slice(0, 160));
  r = await post('/api/admin/wordset-remove', { from: newId, wordIds: [moved.find(w => w.term === 'teach').id], confirm: true });
  chk('確認後移除，回報備份檔', r.status === 200 && r.json.removed.words === 1 && /before-delete-words/.test(r.json.backup) && readdirSync(join(fx.dir, 'backups')).includes(r.json.backup), r.text.slice(0, 160));
  chk('字已不在', (await wordsIn(newId)).map(w => w.term).join() === 'lend');
  chk('沒勾單字 → 400', (await post('/api/admin/wordset-remove', { from: newId, wordIds: [] })).status === 400);

  section('合併');
  r = await post('/api/admin/wordset-merge', { from: [newId], into: fx.setId });
  chk('整份併入，來源字表刪除', r.status === 200 && r.json.moved === 1 && r.json.deleted === 1 && r.json.kept.length === 0, r.text.slice(0, 160));
  all = await sets();
  chk('來源字表不見、字進了目標且作答還在', !all.some(s => s.id === newId) && (await wordsIn(fx.setId)).find(w => w.term === 'lend')?.attempts === 1);
  r = await post('/api/admin/wordset-merge', { from: [setB], into: fx.setId });
  chk('有同字（apple）→ 該字留在來源，來源字表保留', r.status === 200 && r.json.kept.join() === 'apple' && r.json.deleted === 0 && (await sets()).some(s => s.id === setB), r.text.slice(0, 160));
  chk('合併到不存在的字表 → 404', (await post('/api/admin/wordset-merge', { from: [setB], into: 9999 })).status === 404);
  await finish();
} catch (e) { await finish(e); } finally { try { rmSync(fx.dir, { recursive: true, force: true }); } catch {} }
