// 學生登入的畫面：看不到老師才能用的功能（新增與刪除字表、批次分析、歷史用量、出卷）；老師登入則全部都在。
// 自己開接假 CLI 的伺服器，不花額度。跑法：node --no-warnings test/browser/student-ui.mjs
import { rmSync } from 'node:fs';
import { start, shutdown } from '../api/_harness.mjs';
import { makeFixture } from '../api/_fixture.mjs';
import { openPage, checker } from './_cdp.mjs';

const { chk, section, done } = checker();
const fx = makeFixture('peater-stuui-');
fx.cache.db.close?.();
const T = { user: 'teacher1', pass: 'tpass-1' }, K = { user: 'kid1', pass: 'kpass-2' };
let pages = [], code = 1;
const login = async (base, who, path = '/') => {
  const p = await openPage(base + path, { width: 1000, height: 1100, settle: 2500 });
  pages.push(p);
  await p.until(`!!document.getElementById('loginUser')`);
  await p.type('#loginUser', who.user); await p.type('#loginPass', who.pass);
  await p.click('#loginGo');
  await p.wait(2500);                                    // 登入成功會重新載入頁面
  return p;
};
const shown = (p, sel) => p.evl(`(() => { const e = document.querySelector(${JSON.stringify(sel)}); return !!e && getComputedStyle(e).display !== 'none'; })()`);
try {
  const S = await start('ui-student', { AUTH_USER: T.user, AUTH_PASS: T.pass, STUDENT_USER: K.user, STUDENT_PASS: K.pass }, { dbFile: fx.dbFile });

  section('學生');
  const s = await login(S.base, K);
  chk('登入後 body 標著 student', await s.until(`document.body.dataset.role === 'student'`));
  chk('看不到「歷史」分頁（費用與用量）', !(await shown(s, '.tabs button[data-view="history"]')));
  chk('看得到單字、句子、文章、測驗卷、弱點', await s.evl(`['words','sentence','article','exam','weak'].every(v => getComputedStyle(document.querySelector('.tabs button[data-view="' + v + '"]')).display !== 'none')`));
  await s.until(`document.querySelectorAll('#wsList .chip, #wsList button').length > 0`, 8000);
  chk('單字：沒有「刪除目前字表」、「批次分析例句」；「新增字表」改成「申請新增字表」', !(await shown(s, '#wsDel')) && !(await shown(s, '#wsAnalyze')) && await shown(s, '#wsNew .student-label') && !(await shown(s, '#wsNew .teacher-label')));
  chk('單字：分頁有「我的申請」、沒有「待審」', await shown(s, '.tabs button.student-only') && !(await shown(s, '.tabs button.admin-only[data-view="jobs"]')));
  chk('單字搜尋框還在', await shown(s, '#wsSearch'));
  await s.click('.tabs button[data-view="exam"]');
  chk('測驗卷：沒有「出卷」，直接是自己的卷子列表', await s.until(`!!document.querySelector('#pr-paper') && getComputedStyle(document.querySelector('#pr-paper [data-pt="setup"]')).display === 'none' && !document.getElementById('pStart')`, 8000));
  await s.click('.tabs button[data-view="article"]');
  await s.click('#arTabs button[data-ap="articles"]');
  chk('文章：文章表可以看，沒有刪除', await s.evl(`!document.getElementById('an-articles').hidden`));
  const direct = await s.evl(`fetch('/api/stats').then(r => r.status)`);
  chk('直接打 /api/stats → 403（不是只有藏按鈕）', direct === 403, String(direct));
  chk('沒有 JS 錯誤', s.errors.length === 0, s.errors.join(' | '));

  section('老師');
  const t = await login(S.base, T, '/admin');
  chk('登入後是後台', await t.until(`document.body.dataset.app === 'admin'`));
  chk('登入後 body 標著 teacher', await t.until(`document.body.dataset.role === 'teacher'`));
  chk('後台有「費用與用量」分頁', await shown(t, '.tabs button[data-view="history"]'));
  await t.until(`document.querySelectorAll('#wsList .chip, #wsList button').length > 0`, 8000);
  chk('單字：有「新增字表」，分頁有「待審」', await shown(t, '#wsNew .teacher-label') && await shown(t, '.tabs button.admin-only[data-view="jobs"]'));
  await t.click('.tabs button[data-view="exam"]');
  chk('測驗卷：有「出卷」與開始出卷鈕', await t.until(`getComputedStyle(document.querySelector('#pr-paper [data-pt="setup"]')).display !== 'none'`, 8000));
  chk('沒有 JS 錯誤', t.errors.length === 0, t.errors.join(' | '));
  code = done();
} catch (e) {
  console.log('ERR', e.stack || e.message); code = 1;
} finally {
  for (const p of pages) try { p.close(); } catch {}
  process.exitCode = code;
  await shutdown().catch(() => {});
  try { rmSync(fx.dir, { recursive: true, force: true }); } catch {}
}
