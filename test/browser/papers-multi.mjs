// 老師一次出好幾份卷子（難度可以不同）：每份先是草稿，在後台列表裡一起管理；發佈哪幾份，學生就只看到那幾份。
// 自己開接假 CLI 的伺服器，不花額度。跑法：node --no-warnings test/browser/papers-multi.mjs
import { rmSync } from 'node:fs';
import { start, shutdown } from '../api/_harness.mjs';
import { makeFixture } from '../api/_fixture.mjs';
import { openPage, checker } from './_cdp.mjs';

const { chk, section, done } = checker();
const fx = makeFixture('peater-multi-');
fx.cache.db.close?.();
const T = { user: 'teacher1', pass: 'tpass-1' }, K = { user: 'kid1', pass: 'kpass-2' };
let pages = [], code = 1;
const login = async (base, who, path) => {
  const p = await openPage(base + path, { width: 1000, height: 1200, settle: 2500 });
  pages.push(p);
  await p.until(`!!document.getElementById('loginUser')`);
  await p.type('#loginUser', who.user); await p.type('#loginPass', who.pass);
  await p.click('#loginGo'); await p.wait(2500);
  return p;
};
try {
  const S = await start('ui-papers-multi', { AUTH_USER: T.user, AUTH_PASS: T.pass, STUDENT_USER: K.user, STUDENT_PASS: K.pass }, { dbFile: fx.dbFile });
  const a = await login(S.base, T, '/admin');
  const { evl, until, click } = a;
  const set = (sel, v) => evl(`(() => { const e = document.querySelector(${JSON.stringify(sel)}); e.value = ${JSON.stringify(v)}; e.dispatchEvent(new Event('input', { bubbles: true })); e.dispatchEvent(new Event('change', { bubbles: true })); })()`);
  const ready = () => until(`!document.getElementById('pStart').disabled`, 15000);

  const makeOne = async (diff, n, first) => {
    await click('.tabs button[data-view="exam"]');
    await until(`!!document.querySelector('#pr-paper [data-pt="setup"]')`, 8000);
    await click('#pr-paper [data-pt="setup"]');                         // 在列表或編修畫面時，要按「出卷」才回到設定頁
    await until(`!!document.getElementById('pStart')`, 8000);
    if (first){ await evl(`document.querySelectorAll('#pr-paper [data-scope][aria-pressed="true"]').forEach(b => b.click())`); await click('[data-scope="set"]'); }
    await until(`!!document.getElementById('pN')`, 8000);
    await set('#pN', String(n)); await set('#pDiff', diff);
    if (!(await ready())) return false;
    await click('#pStart');
    return until(`document.querySelectorAll('#pr-paper .pa-q').length === ${n} && /草稿/.test(document.querySelector('.pa-head').textContent)`, 20000);
  };

  section('老師連出三份（簡單、中等、困難）：每份都先是草稿');
  chk('第一份（簡單 30 題）→ 草稿編輯畫面', await makeOne('easy', 30, true));
  await click('[data-ped="back"]');
  chk('回到列表：看到這份草稿', await until(`document.querySelectorAll('#pr-paper tbody tr').length === 1 && /草稿/.test(document.getElementById('pr-paper').textContent)`, 8000));
  chk('第二份（中等 30 題）', await makeOne('mid', 30, false));
  await click('[data-ped="back"]');
  chk('第三份（困難 30 題）', await makeOne('hard', 30, false));
  await click('[data-ped="back"]');
  chk('列表有三份草稿，難度各自標出來', await until(`document.querySelectorAll('#pr-paper tbody tr').length === 3`, 8000) && await evl(`(() => { const t = document.getElementById('pr-paper').textContent; return /簡單/.test(t) && /中等/.test(t) && /困難/.test(t) && document.querySelectorAll('#pr-paper .tag.t-prog').length === 3; })()`), await evl(`document.getElementById('pr-paper').innerText.slice(0, 200)`));

  section('發佈其中兩份');
  await click('[data-pub]');
  chk('第一份發佈：狀態變成「已發佈・作答中」，列表少一個「發佈」鈕', await until(`document.querySelectorAll('[data-pub]').length === 2 && /已發佈・作答中/.test(document.getElementById('pr-paper').textContent)`, 8000));
  await click('[data-pub]');
  chk('第二份發佈', await until(`document.querySelectorAll('[data-pub]').length === 1`, 8000));

  section('學生只看到已發佈的兩份');
  const s = await login(S.base, K, '/');
  await s.click('.tabs button[data-view="exam"]');
  chk('學生的卷子列表：2 份作答中，沒有草稿', await s.until(`document.querySelectorAll('#pr-paper tbody tr').length === 2 && !/草稿/.test(document.getElementById('pr-paper').textContent) && [...document.querySelectorAll('#pr-paper tbody tr')].every(r => /作答中/.test(r.textContent))`, 8000), await s.evl(`document.getElementById('pr-paper').innerText.slice(0, 200)`));
  chk('學生沒有「出卷」', await s.evl(`getComputedStyle(document.querySelector('#pr-paper [data-pt="setup"]')).display === 'none'`));
  await s.click('[data-open]');
  chk('按「繼續」進入作答畫面', await s.until(`document.querySelectorAll('#pr-paper [data-qcard]').length === 30`, 8000));

  section('其他');
  chk('老師沒有 JS 錯誤', a.errors.length === 0, a.errors.join(' | '));
  chk('學生沒有 JS 錯誤', s.errors.length === 0, s.errors.join(' | '));
  code = done();
} catch (e) {
  console.log('ERR', e.stack || e.message); code = 1;
} finally {
  for (const p of pages) try { p.close(); } catch {}
  process.exitCode = code;
  await shutdown().catch(() => {});
  try { rmSync(fx.dir, { recursive: true, force: true }); } catch {}
}
