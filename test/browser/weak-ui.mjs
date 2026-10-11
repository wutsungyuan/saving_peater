// 弱點頁：單字測驗、句子練習、測驗卷三個來源的綜合與切換。自己開接假 CLI 的伺服器，不花額度。
// 跑法：node --no-warnings test/browser/weak-ui.mjs
import { rmSync } from 'node:fs';
import { start, shutdown } from '../api/_harness.mjs';
import { makeFixture } from '../api/_fixture.mjs';
import { openPage, checker } from './_cdp.mjs';

const { chk, section, done } = checker();
const fx = makeFixture('peater-weakui-');
const U = 'stu';
const [w1, w2] = fx.cache.wordsOf([fx.setId], U);
for (const ok of [true, true, false, false]) fx.cache.recordAttempt({ userToken: U, qtype: 'pattern', patternId: 3, correct: ok });
for (const ok of [false, false, true]) fx.cache.recordWordAttempt({ userToken: U, wordId: w1.id, mode: 'zh2en', correct: ok });
for (const ok of [true, true, true]) fx.cache.recordWordAttempt({ userToken: U, wordId: w2.id, mode: 'en2zh', correct: ok });
fx.cache.db.close?.();
let page, code = 1;
try {
  const S = await start('ui-weak', {}, { dbFile: fx.dbFile });
  page = await openPage(S.base + '/', { width: 1000, height: 1200, settle: 1500 });
  await page.send('Page.addScriptToEvaluateOnNewDocument', { source: "localStorage.setItem('analyzer-user', 'stu')" });
  await page.send('Page.reload'); await page.wait(2500);
  const { evl, until, click } = page;
  const text = () => evl(`document.getElementById('view-weak').textContent`);

  section('來源切換');
  await click('.tabs button[data-view="weak"]');
  chk('有四個來源：全部、單字測驗、句子練習、測驗卷，各帶作答數', await until(`[...document.querySelectorAll('#wkTabs button')].map(b => b.textContent.replace(/ +/g, '')).join() === '全部10,單字測驗6,句子練習4,測驗卷'`), await evl(`[...document.querySelectorAll('#wkTabs button')].map(b => b.textContent).join('|')`));
  chk('全部：整體 60%（10 題對 6）、有「各來源」', /60%/.test(await text()) && /各來源/.test(await text()) && /6 \/ 10/.test(await text()));
  chk('全部：句子面向與單字面向都在', /五大句型/.test(await text()) && /最弱的單字/.test(await text()) && /單字題型/.test(await text()));
  chk('全部：有「複習單字」與「針對弱點練習句子」', await evl(`!!document.getElementById('weakWords') && !!document.getElementById('weakPractice')`));

  await click('#wkTabs button[data-src="quiz"]');
  chk('單字測驗：只有單字面向（最弱的單字、單字題型），沒有句型時態', await until(`/最弱的單字/.test(document.getElementById('view-weak').textContent) && !/五大句型/.test(document.getElementById('view-weak').textContent)`));
  chk('最弱的單字排第一是答錯最多的那個字', await evl(`(() => { const r = [...document.querySelectorAll('#weakCharts .wk-sec')].find(s => /最弱的單字/.test(s.textContent)); return r.querySelector('.name').textContent.trim().toLowerCase().startsWith(${JSON.stringify(w1.term.toLowerCase())}); })()`));
  chk('單字測驗：6 題、正確率 67%', /6 題/.test(await text()) && /67%/.test(await text()), (await text()).slice(0, 200));

  await click('#wkTabs button[data-src="practice"]');
  chk('句子練習：有句型，沒有單字面向', await until(`/五大句型/.test(document.getElementById('view-weak').textContent) && !/最弱的單字/.test(document.getElementById('view-weak').textContent)`));
  chk('句子練習：4 題、50%', /4 題/.test(await text()) && /50%/.test(await text()));

  await click('#wkTabs button[data-src="exam"]');
  chk('測驗卷：還沒有作答 → 提示', await until(`/還沒有作答紀錄/.test(document.getElementById('view-weak').textContent)`));

  section('複習單字');
  await click('#wkTabs button[data-src="quiz"]');
  await until(`!!document.getElementById('weakWords')`);
  await click('#weakWords');
  chk('按「複習單字」：跳到單字、出現「← 返回弱點」', await until(`document.body.dataset.view === 'words' && /返回弱點/.test(document.getElementById('backBtn').textContent)`));

  section('其他');
  chk('沒有 JS 錯誤', page.errors.length === 0, page.errors.join(' | '));
  code = done();
} catch (e) {
  console.log('ERR', e.stack || e.message); code = 1;
} finally {
  try { page?.close(); } catch {}
  process.exitCode = code;
  await shutdown().catch(() => {});
  try { rmSync(fx.dir, { recursive: true, force: true }); } catch {}
}
