// 隱藏句：建立字表時一併產出、補隱藏句的老師功能、填空題會抽到。假 CLI，不花額度。
// 跑法：node --no-warnings test/api/wordset-extra.mjs
import { rmSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { start, J, chk, section, finish } from './_harness.mjs';
import { makeFixture, W } from './_fixture.mjs';

const T = { user: 'teacher1', pass: 'teacher pass 123' }, K = { user: 'kid1', pass: 'kid pass 456' };
const cookieFrom = r => (r.headers.get('set-cookie') || '').split(';')[0];
const withCookie = c => ({ headers: { cookie: c } });
const fx = makeFixture('peater-wsextra-');
// 第二份：有一個字已經有隱藏句、一個縮寫
const setB = fx.cache.createWordset('補句用', [
  W('river', 'n', '河', 'The river is wide.', '河很寬。', { extra: [{ pos: 'n', example: 'We swam in the river.', exampleZh: '我們在河裡游泳。' }] }),
  W('lake', 'n', '湖', 'The lake is calm.', '湖很平靜。'),
  W('PE', 'n', '體育', 'We have PE today.', '我們今天有體育課。'),
]);
fx.cache.db.close?.();
const ENV = { AUTH_USER: T.user, AUTH_PASS: T.pass, STUDENT_USER: K.user, STUDENT_PASS: K.pass, ANALYZE_GROUP: '1', FAKE_EXTRA_BAD: '1' };
const extrasOf = (file, setId) => {
  const d = new DatabaseSync(file, { readOnly: true });
  const o = Object.fromEntries(d.prepare('SELECT term, data FROM words WHERE set_id = ?').all(setId).map(r => [r.term, JSON.parse(r.data).extra ?? []]));
  d.close(); return o;
};

try {
  const S = await start('wordset-extra', ENV, { dbFile: fx.dbFile });
  const B = S.base;
  const tk = cookieFrom(await J(B, '/api/login', { method: 'POST', body: T }));
  const sk = cookieFrom(await J(B, '/api/login', { method: 'POST', body: K }));
  const post = (p, body, ck = tk) => J(B, p, { method: 'POST', ...withCookie(ck), body });

  section('只有老師能用');
  const a = await post('/api/admin/wordset-extra', { id: setB, confirm: true }, sk), n = await J(B, '/api/admin/wordset-extra', { method: 'POST', body: { id: setB } });
  chk('學生 403、沒登入 401', a.status === 403 && n.status === 401, `${a.status}/${n.status}`);
  chk('不存在的字表 → 404', (await post('/api/admin/wordset-extra', { id: 9999 })).status === 404);

  section('補隱藏句：先預覽，確認才呼叫模型');
  const calls0 = S.calls().length;
  let r = await post('/api/admin/wordset-extra', { id: setB });
  chk('預覽：只算 lake（river 已有、PE 是縮寫），沒呼叫模型', r.status === 409 && r.json.words === 1 && r.json.batches === 1 && S.calls().length === calls0, r.text.slice(0, 160));
  r = await post('/api/admin/wordset-extra', { id: setB, confirm: true });
  chk('確認後補 1 個字，呼叫 1 次', r.status === 200 && r.json.filled === 1 && S.calls().length === calls0 + 1, r.text.slice(0, 160));
  let ex = extrasOf(fx.dbFile, setB);
  chk('lake 有隱藏句；模型給的壞句（沒含這個字）被濾掉，只剩 1 句', ex.lake.length === 1 && /lake/.test(ex.lake[0].example) && ex.lake[0].exampleZh, JSON.stringify(ex.lake));
  chk('river 原本的隱藏句沒被動；PE 沒有', ex.river.length === 1 && ex.river[0].example === 'We swam in the river.' && ex.PE.length === 0);
  r = await post('/api/admin/wordset-extra', { id: setB, confirm: true });
  chk('再按一次：都有了，不再呼叫模型', r.status === 200 && r.json.words === 0 && S.calls().length === calls0 + 1, r.text.slice(0, 160));

  section('建立字表時一併產出');
  r = await post('/api/wordsets', { name: '新字表', text: 'bridge\ncave' });
  chk('建立成功', r.status === 200 && r.json.count === 2, r.text.slice(0, 160));
  ex = extrasOf(fx.dbFile, r.json.id);
  chk('每個字都有 2 句隱藏句，且含該字', ex.bridge.length === 2 && ex.bridge.every(x => /bridge/.test(x.example) && x.exampleZh) && ex.cave.length === 2, JSON.stringify(ex));

  section('字卡不顯示、填空題會抽到');
  const setNew = r.json.id, seen = new Set();
  let okAll = true;
  for (let i = 0; i < 15; i++){
    const q = await post('/api/wordquiz', { setId: setNew, modes: ['cloze'], count: 10 });
    okAll &&= q.status === 200 && (q.json.questions ?? []).length > 0 && q.json.questions.every(x => x.mode === 'cloze');
    for (const x of q.json.questions ?? []) seen.add(x.question);
  }
  chk('填空題出得來', okAll);
  const all = [...seen].join(' | ');
  chk('字表原句和兩句隱藏句都抽得到（bridge）', /I use the word ______ every day/.test(all) && /We talked about ______ after school/.test(all) && /My teacher likes ______ very much/.test(all), all);
  await finish();
} catch (e) { await finish(e); } finally { try { rmSync(fx.dir, { recursive: true, force: true }); } catch {} }
