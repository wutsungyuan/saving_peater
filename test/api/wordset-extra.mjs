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
// 一句分析過的句子帶有 teach 的三態，字卡才看得到
fx.cache.put('My uncle taught me chess.', { index: 0, original: 'My uncle taught me chess.', translation: '我叔叔教我下棋。', words: [], notes: [], inScope: true, issue: null,
  clauses: [{ text: 'My uncle taught me chess', role: 'main', verb: { lemma: 'teach', form: 'taught', irregular: true, forms: { base: 'teach', past: 'taught', pastParticiple: 'taught', ing: 'teaching', third: 'teaches' } } }] }, 'test', {});
const setC = fx.cache.createWordset('同時按', [W('pond', 'n', '池塘', 'The pond is small.', '池塘很小。'), W('hill', 'n', '山丘', 'The hill is green.', '山丘很綠。')]);
const setD = fx.cache.createWordset('已有隱藏句', [
  W('farm', 'n', '農場', 'The farm is big.', '農場很大。', { extra: [{ pos: 'n', example: 'We visited a farm last summer.', exampleZh: '我們去年夏天參觀了一座農場。' }] }),
  W('barn', 'n', '穀倉', 'The barn is red.', '穀倉是紅的。', { extra: [{ pos: 'n', example: 'The horse sleeps in the barn.', exampleZh: '馬睡在穀倉裡。' }] }),
]);
fx.cache.db.close?.();
const ENV = { AUTH_USER: T.user, AUTH_PASS: T.pass, STUDENT_USER: K.user, STUDENT_PASS: K.pass, ANALYZE_GROUP: '1', FAKE_EXTRA_BAD: '1', FAKE_DELAY_MS: '400' };
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

  // 確認後是串流（SSE）：把事件讀出來
  const evs = text => [...text.matchAll(/^event: (\w+)\ndata: (.*)$/gm)].map(m => ({ ev: m[1], d: JSON.parse(m[2]) }));
  const last = (text, name) => evs(text).filter(e => e.ev === name).at(-1)?.d;
  const countKind = k => S.calls().filter(c => c.kind === k).length;
  const sentenceTotal = async () => (await J(B, '/api/admin/sentences?limit=1', withCookie(tk))).json.total;

  section('補隱藏句：先預覽，確認才呼叫模型');
  const calls0 = S.calls().length, s0 = await sentenceTotal();
  let r = await post('/api/admin/wordset-extra', { id: setB });
  chk('預覽：1 個字要補（river 已有、PE 是縮寫），river 的 1 句還沒分析，沒呼叫模型',
    r.status === 409 && r.json.words === 1 && r.json.batches === 1 && r.json.unanalyzed === 1 && r.json.estimate === 4 && S.calls().length === calls0, r.text.slice(0, 200));
  r = await post('/api/admin/wordset-extra', { id: setB, confirm: true });
  const done1 = last(r.text, 'done');
  chk('確認後：補 1 個字、分析 2 句（lake 新的 1 句＋river 原本的 1 句）', r.status === 200 && done1?.filled === 1 && done1?.analyzed === 2, r.text.slice(0, 300));
  chk('先寫例句、再分析（stage 依序）', evs(r.text).filter(e => e.ev === 'stage').map(e => e.d.stage).join() === 'write,analyze');
  chk('模型呼叫：寫例句 1 次、分析 1 次', countKind('wordset-extra') === 1 && countKind('analyze') === 1, JSON.stringify(S.calls().map(c => c.kind)));
  let ex = extrasOf(fx.dbFile, setB);
  chk('lake 有隱藏句；模型給的壞句（沒含這個字）被濾掉，只剩 1 句', ex.lake.length === 1 && /lake/.test(ex.lake[0].example) && ex.lake[0].exampleZh, JSON.stringify(ex.lake));
  chk('river 原本的隱藏句沒被動；PE 沒有', ex.river.length === 1 && ex.river[0].example === 'We swam in the river.' && ex.PE.length === 0);
  chk('隱藏句已進句子庫：句子清單多 2 句、查得到', await sentenceTotal() === s0 + 2 && (await J(B, '/api/admin/sentences?q=swam', withCookie(tk))).json.total >= 1);
  r = await post('/api/admin/wordset-extra', { id: setB, confirm: true });
  chk('再按一次：都補好也分析過了，不再呼叫模型', r.status === 200 && r.json.words === 0 && countKind('wordset-extra') === 1 && countKind('analyze') === 1, r.text.slice(0, 160));

  section('已有隱藏句但沒分析（先前補過的）：只分析，不再寫例句');
  r = await post('/api/admin/wordset-extra', { id: setD });
  chk('預覽：0 個字要補、2 句待分析', r.status === 409 && r.json.words === 0 && r.json.unanalyzed === 2, r.text.slice(0, 160));
  const w0 = countKind('wordset-extra');
  r = await post('/api/admin/wordset-extra', { id: setD, confirm: true });
  chk('只分析 2 句，沒有寫例句', last(r.text, 'done')?.analyzed === 2 && last(r.text, 'done')?.filled === 0 && countKind('wordset-extra') === w0, r.text.slice(0, 300));

  section('同一份同時按兩次：第二個被擋下，只花一次額度');
  const busySet = setC;
  const n0 = countKind('wordset-extra');
  const [p1, p2] = await Promise.all([post('/api/admin/wordset-extra', { id: busySet, confirm: true }), (async () => { await new Promise(r => setTimeout(r, 120)); return post('/api/admin/wordset-extra', { id: busySet, confirm: true }); })()]);
  chk('第一個成功、第二個 409 busy', last(p1.text, 'done')?.filled === 2 && p2.status === 409 && p2.json.error === 'busy', `${p1.status}/${p2.status} ${p2.text.slice(0, 100)}`);
  chk('寫例句的模型只被呼叫 1 次', countKind('wordset-extra') === n0 + 1);
  chk('做完後這份可以再用（沒有卡在忙碌）', (await post('/api/admin/wordset-extra', { id: busySet, confirm: true })).status === 200);

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
  section('字卡：動詞附三態、隱藏句不外送');
  const ws = (await J(B, `/api/wordset?id=${setNew}`, withCookie(sk))).json.words;
  chk('回應裡沒有 extra 欄位', ws.length === 2 && ws.every(w => !('extra' in w)));
  const wf = (await J(B, `/api/wordset?id=${fx.setId}`, withCookie(sk))).json.words;
  const teach = wf.find(w => w.term === 'teach'), apple = wf.find(w => w.term === 'apple');
  chk('teach 帶三態 teach／taught／taught，標不規則', teach.verbForms?.past === 'taught' && teach.verbForms.pastParticiple === 'taught' && teach.verbForms.irregular === true, JSON.stringify(teach.verbForms));
  chk('名詞（apple）、形容詞（cloudy）不帶三態', !apple.verbForms && !wf.find(w => w.term === 'cloudy').verbForms);
  const sr = (await J(B, '/api/wordsearch?q=teach', withCookie(sk))).json.words;
  chk('搜尋結果也帶三態', sr.some(w => w.term === 'teach' && w.verbForms?.base === 'teach'));
  await finish();
} catch (e) { await finish(e); } finally { try { rmSync(fx.dir, { recursive: true, force: true }); } catch {} }
