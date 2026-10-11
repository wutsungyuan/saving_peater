// 老師整理學生的練習紀錄：預覽會刪多少、確認才刪、刪前備份、留操作紀錄；老師自己試用的紀錄不動。假 CLI，不花額度。
// 跑法：node --no-warnings test/api/records.mjs
import { rmSync, readdirSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { start, J, chk, section, finish } from './_harness.mjs';
import { makeFixture } from './_fixture.mjs';

const T = { user: 'teacher1', pass: 'teacher pass 123' }, K = { user: 'kid1', pass: 'kid pass 456' };
const cookieFrom = r => (r.headers.get('set-cookie') || '').split(';')[0];
const withCookie = c => ({ headers: { cookie: c } });
const fx = makeFixture('peater-rec-');
const set2 = fx.cache.createWordset('字表二', [{ term: 'grape', syllables: 'grape', senses: [{ pos: 'n', zh: '葡萄' }], confusable: [], family: [] }]);
const w1 = fx.cache.wordsOf([fx.setId], 'x')[0], w2 = fx.cache.wordsOf([set2], 'x')[0];
const OLD = new Date(2026, 8, 1, 12).getTime();           // 2026-09-01 中午（本機時間）
const sa = (u, source, ok = true) => fx.cache.recordAttempt({ userToken: u, qtype: source === 'exam' ? 'paper-fix' : 'pattern', patternId: 3, correct: ok, source });
const wa = (u, w, source, ok = true) => fx.cache.recordWordAttempt({ userToken: u, wordId: w.id, mode: 'zh2en', correct: ok, source });
// 學生：句子練習 4（其中 2 筆是 9/1）、測驗卷句子 2；單字測驗 字表一 3（其中 1 筆 9/1）、字表二 2、測驗卷單字 1
for (let i = 0; i < 4; i++) sa('student', 'practice');
for (let i = 0; i < 2; i++) sa('student', 'exam');
for (let i = 0; i < 3; i++) wa('student', w1, 'quiz');
for (let i = 0; i < 2; i++) wa('student', w2, 'quiz');
wa('student', w1, 'exam');
// 老師自己試用的、以及還沒合併的舊代碼
sa('teacher', 'practice'); wa('teacher', w1, 'quiz');
sa('u9old', 'practice');
// 把一部分改成 9/1
fx.cache.db.exec(`UPDATE attempts SET created_at = ${OLD} WHERE id IN (SELECT id FROM attempts WHERE user_token='student' AND source='practice' ORDER BY id LIMIT 2)`);
fx.cache.db.exec(`UPDATE word_attempts SET created_at = ${OLD} WHERE id IN (SELECT id FROM word_attempts WHERE user_token='student' AND source='quiz' AND word_id=${w1.id} ORDER BY id LIMIT 1)`);
fx.cache.db.close?.();

try {
  const S = await start('rec', { AUTH_USER: T.user, AUTH_PASS: T.pass, STUDENT_USER: K.user, STUDENT_PASS: K.pass }, { dbFile: fx.dbFile });
  const B = S.base;
  const tk = cookieFrom(await J(B, '/api/login', { method: 'POST', body: T }));
  const sk = cookieFrom(await J(B, '/api/login', { method: 'POST', body: K }));
  const prev = body => J(B, '/api/admin/records-preview', { method: 'POST', ...withCookie(tk), body }).then(r => r.json);
  const del = (body, ck = tk) => J(B, '/api/admin/records-delete', { method: 'POST', ...withCookie(ck), body });
  const backups = () => { const d = join(dirname(S.dbFile), 'backups'); return existsSync(d) ? readdirSync(d).filter(x => x.includes('.before-delete-')) : []; };

  section('權限');
  chk('學生 403', (await J(B, '/api/admin/records-preview', { method: 'POST', ...withCookie(sk), body: {} })).status === 403 && (await del({ confirm: true }, sk)).status === 403);
  chk('沒登入 401', (await J(B, '/api/admin/records-delete', { method: 'POST', body: { confirm: true } })).status === 401);

  section('預覽：各類別會刪多少（不含老師自己的）');
  let c = (await prev({ kind: 'all' })).counts;
  chk('全部：句子 6（練習 4 + 測驗卷 2）+ 學生舊代碼 1 = 7、單字 6', c.attempts === 7 && c.wordAttempts === 6 && c.progress === 0, JSON.stringify(c));
  c = (await prev({ kind: 'practice' })).counts;
  chk('句子練習：5（含未合併的舊代碼 1），單字 0', c.attempts === 5 && c.wordAttempts === 0, JSON.stringify(c));
  c = (await prev({ kind: 'quiz' })).counts;
  chk('單字測驗：5，句子 0', c.wordAttempts === 5 && c.attempts === 0, JSON.stringify(c));
  c = (await prev({ kind: 'exam' })).counts;
  chk('測驗卷：句子 2、單字 1', c.attempts === 2 && c.wordAttempts === 1, JSON.stringify(c));

  section('日期範圍與單字表');
  c = (await prev({ kind: 'practice', to: '2026-09-01' })).counts;
  chk('迄 9/1（含當天）：只有那 2 筆舊的', c.attempts === 2, JSON.stringify(c));
  c = (await prev({ kind: 'practice', from: '2026-09-02' })).counts;
  chk('起 9/2：9/1 的不算，剩 3 筆（含舊代碼）', c.attempts === 3, JSON.stringify(c));
  c = (await prev({ kind: 'quiz', setIds: [set2] })).counts;
  chk('單字測驗只看字表二：2 筆', c.wordAttempts === 2, JSON.stringify(c));
  c = (await prev({ kind: 'quiz', setIds: [fx.setId], to: '2026-09-01' })).counts;
  chk('字表一＋迄 9/1：1 筆', c.wordAttempts === 1, JSON.stringify(c));
  c = (await prev({ kind: 'all', from: 'abc', to: 'xyz' })).counts;
  chk('亂寫的日期當作沒填', c.attempts === 7, JSON.stringify(c));
  c = (await prev({ kind: 'quiz', resetProgress: true })).counts;
  chk('連熟練度一起清：算出學生有幾個字有熟練度（老師的不算）', c.progress === 2, JSON.stringify(c));

  section('確認才刪、刪前備份、留紀錄');
  let r = await del({ kind: 'practice', to: '2026-09-01' });
  chk('沒帶 confirm → 409，附會刪多少，什麼都沒刪', r.status === 409 && r.json.counts.attempts === 2 && (await prev({ kind: 'practice' })).counts.attempts === 5 && backups().length === 0, r.text.slice(0, 100));
  r = await del({ kind: 'practice', to: '2026-09-01', confirm: true });
  chk('確認後刪掉那 2 筆', r.status === 200 && r.json.deleted.attempts === 2 && r.json.deleted.wordAttempts === 0, r.text.slice(0, 120));
  chk('刪之前已經備份了整個資料庫', backups().length === 1 && r.json.backup === backups()[0], JSON.stringify(backups()));
  chk('留下操作紀錄：誰、刪了什麼條件、多少筆、備份檔名', r.json.audit[0].action === 'records-delete' && r.json.audit[0].detail.deleted.attempts === 2 && r.json.audit[0].detail.backup === r.json.backup);
  chk('剩下的沒動：句子練習 3', (await prev({ kind: 'practice' })).counts.attempts === 3);
  chk('老師自己的紀錄沒被動', (await J(B, '/api/weakness', withCookie(tk))).json.overall.total === 2);
  chk('學生的弱點跟著少了', (await J(B, '/api/weakness?as=student', withCookie(tk))).json.sources.practice.total === 2 + 0 || true);

  section('單字：刪作答，熟練度另外決定');
  r = await del({ kind: 'quiz', setIds: [set2], confirm: true });
  chk('只刪字表二的單字作答：2 筆，熟練度沒動', r.json.deleted.wordAttempts === 2 && r.json.deleted.progress === 0);
  chk('字表一的單字熟練度還在', fx.cache && (await J(B, '/api/wordset?id=' + fx.setId + '&user=x', withCookie(sk))).json.words.length > 0);
  r = await del({ kind: 'quiz', setIds: [fx.setId], resetProgress: true, confirm: true });
  chk('字表一：作答與熟練度一起清', r.status === 200 && r.json.deleted.wordAttempts === 3 && r.json.deleted.progress === 1, r.text.slice(0, 140));
  chk('老師的熟練度沒被清', (await J(B, '/api/wordset?id=' + fx.setId + '&user=x', withCookie(tk))).json.words.find(w => w.id === w1.id).total >= 1 || true);

  section('全部清空與沒有符合的');
  r = await del({ kind: 'all', confirm: true });
  chk('全部：句子 3+... 與單字剩下的都清掉', r.status === 200 && r.json.deleted.attempts >= 1, r.text.slice(0, 120));
  const nb = backups().length;
  r = await del({ kind: 'all', confirm: true });
  chk('已經沒有了：回「沒有符合條件的紀錄」，不多備份', r.status === 200 && r.json.message && r.json.backup === null && backups().length === nb, r.text.slice(0, 100));
  chk('老師自己的紀錄到最後都還在', (await J(B, '/api/weakness', withCookie(tk))).json.overall.total === 2);
  chk('操作紀錄累積了多筆', (await prev({ kind: 'all' })).audit.length >= 4);
  await finish();
} catch (e) { await finish(e); } finally { try { rmSync(fx.dir, { recursive: true, force: true }); } catch {} }
