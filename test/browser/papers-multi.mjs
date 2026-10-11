// 同時出好幾份卷子：每份各自設定（難度可以不同），沒交卷的都留著，出卷頁列出來可以各自繼續。
// 自己開接假 CLI 的伺服器，不花額度。跑法：node --no-warnings test/browser/papers-multi.mjs
import { start, shutdown } from '../api/_harness.mjs';
import { makeFixture } from '../api/_fixture.mjs';
import { openPage, checker } from './_cdp.mjs';

const { chk, section, done } = checker();
const fx = makeFixture('peater-multi-');
let page, code = 1;
try {
  const S = await start('ui-papers-multi', {}, { dbFile: fx.dbFile });
  page = await openPage(S.base + '/admin', { width: 900, height: 1200, settle: 2500 });
  const { evl, until, click } = page;
  const set = (sel, v) => evl(`(() => { const e = document.querySelector(${JSON.stringify(sel)}); e.value = ${JSON.stringify(v)}; e.dispatchEvent(new Event('input', { bubbles: true })); e.dispatchEvent(new Event('change', { bubbles: true })); })()`);
  const ready = () => until(`!document.getElementById('pStart').disabled`, 15000);

  section('出第一份（簡單）');
  await click('.tabs button[data-view="exam"]');
  await until(`document.querySelectorAll('#pr-paper [data-scope]').length === 2`);
  await evl(`document.querySelectorAll('#pr-paper [data-scope][aria-pressed="true"]').forEach(b => b.click())`);
  await click('[data-scope="set"]');
  await until(`!!document.getElementById('pN')`);
  await set('#pN', '30'); await set('#pDiff', 'easy');
  chk('可以開始', await ready());
  await click('#pStart');
  chk('進入作答畫面', await until(`document.querySelectorAll('#pr-paper [data-qcard]').length === 30`));
  const id1 = await evl(`P.paper.id`);
  chk('作答畫面有「先放著，再出一份新卷」', await evl(`!!document.querySelector('[data-act2="newpaper"]')`));

  section('先放著，再出第二份（中等）');
  await click('[data-act2="newpaper"]');
  chk('回到出卷設定，並提示有 1 份沒交卷', await until(`!!document.getElementById('pResume') && /有 1 份/.test(document.getElementById('pResume').textContent)`), await evl(`document.querySelector('#pr-paper').textContent.slice(0,80)`));
  await click('[data-scope="set"]');
  await evl(`(() => { const b = document.querySelector('#pr-paper [data-scope="set"]'); if (b.getAttribute('aria-pressed') !== 'true') b.click(); })()`);
  await set('#pDiff', 'mid');
  chk('設定可以重選，可以開始', await ready());
  await click('#pStart');
  chk('第二份：作答畫面', await until(`document.querySelectorAll('#pr-paper [data-qcard]').length > 0 && P.paper.id !== ${JSON.stringify(id1)}`));
  const id2 = await evl(`P.paper.id`);

  section('第三份（困難）');
  await click('[data-act2="newpaper"]');
  chk('提示有 2 份沒交卷、每份各有按鈕', await until(`/有 2 份/.test(document.getElementById('pResume')?.textContent ?? '') && document.querySelectorAll('#pResume [data-act="resume"]').length === 2`));
  await evl(`(() => { const b = document.querySelector('#pr-paper [data-scope="set"]'); if (b.getAttribute('aria-pressed') !== 'true') b.click(); })()`);
  await set('#pDiff', 'hard');
  await until(`!document.getElementById('pStart').disabled`, 15000);
  await click('#pStart');
  await until(`document.querySelectorAll('#pr-paper [data-qcard]').length > 0 && P.paper.id !== ${JSON.stringify(id2)}`);
  await click('[data-act2="newpaper"]');
  chk('提示有 3 份沒交卷', await until(`/有 3 份/.test(document.getElementById('pResume')?.textContent ?? '')`));

  section('各自繼續');
  const names = await evl(`[...document.querySelectorAll('#pResume [data-act="resume"]')].map(b => b.textContent).join('|')`);
  chk('三份的難度各自標出來（簡單、中等、困難）', /簡單/.test(names) && /中等/.test(names) && /困難/.test(names), names);
  await click('#pResume [data-act="resume"]');
  chk('按第 1 份 → 回到第一份卷子', await until(`P.paper && P.paper.id === ${JSON.stringify(id1)} && document.querySelectorAll('#pr-paper [data-qcard]').length === 30`));
  const st = (await S.j('/api/papers')).json.papers;
  chk('伺服器上 3 份都還在作答中', st.filter(p => p.status === 'open').length === 3);
  chk('沒有 JS 錯誤', page.errors.length === 0, page.errors.join(' | '));
  code = done();
} catch (e) {
  console.log('ERR', e.stack || e.message); code = 1;
} finally {
  try { page?.close(); } catch {}
  process.exitCode = code;
  await shutdown().catch(() => {});
}
