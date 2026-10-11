// 後台編修卷子的畫面：改名、換一題、刪一題（要按兩次）、分數重新分配、發佈與收回。假 CLI，不花額度。
// 跑法：node --no-warnings test/browser/paper-edit-ui.mjs
import { rmSync } from 'node:fs';
import { start, shutdown } from '../api/_harness.mjs';
import { makeFixture } from '../api/_fixture.mjs';
import { openPage, checker } from './_cdp.mjs';

const { chk, section, done } = checker();
const fx = makeFixture('peater-peui-');
fx.cache.db.close?.();
let page, code = 1;
try {
  const S = await start('ui-paper-edit', {}, { dbFile: fx.dbFile });
  const r = await S.j('/api/papers', { method: 'POST', body: { setIds: [fx.setId], articleIds: [fx.artId], n: 36, saver: true, mode: 'custom', types: ['mc', 'reorder', 'fix', 'fill', 'match'], seed: 21, draft: true } });
  const id = r.json.id;
  page = await openPage(S.base + '/admin', { width: 1000, height: 1200, settle: 2500 });
  const { evl, until, click, type } = page;
  const sum = () => evl(`[...document.querySelectorAll('.pa-q .p-pts')].reduce((a, e) => a + parseFloat(e.textContent), 0)`);

  section('從列表打開草稿');
  await click('.tabs button[data-view="exam"]');
  await until(`!!document.querySelector('#pr-paper [data-pt="history"]')`, 8000);
  await click('#pr-paper [data-pt="history"]');
  chk('列表：這份是草稿，按鈕是「編輯」「發佈」「刪除」', await until(`/草稿/.test(document.getElementById('pr-paper').textContent) && !!document.querySelector('[data-open]') && /編輯/.test(document.querySelector('[data-open]').textContent) && !!document.querySelector('[data-pub]') && !!document.querySelector('[data-del]')`, 8000));
  await click('[data-open]');
  chk('編修畫面：36 題、每題有答案', await until(`document.querySelectorAll('.pa-q').length === 36 && document.querySelectorAll('.pa-ans').length === 36`, 8000));
  chk('滿分 100', await sum() === 100, String(await sum()));
  chk('選擇題的正確選項標了勾', await evl(`!!document.querySelector('.pa-choices li.ok')`));

  section('改名');
  await type('#paTitle', '期中複習 A');
  await click('[data-ped="rename"]');
  chk('儲存名稱：提示已儲存', await until(`/已儲存名稱/.test(document.getElementById('paMsg').textContent)`, 5000));

  section('換一題');
  // 這個範圍的素材不多，某些題型可能已經沒有別的題可換（畫面會說明）；逐一試，至少要有一題換成功
  const swapIds = await evl(`[...document.querySelectorAll('[data-ped="swap"]')].filter(x => !x.disabled).map(x => x.dataset.qid)`);
  let swappedId = null, txt0 = '', noCand = 0;
  for (const qid of swapIds.slice(0, 12)){
    txt0 = await evl(`document.getElementById(${JSON.stringify('pq-' + qid)}).textContent`);
    await click(`[data-ped="swap"][data-qid="${qid}"]`);
    await until(`document.getElementById('paMsg').textContent !== ''`, 5000);
    const m = await evl(`document.getElementById('paMsg').textContent`);
    if (/已換成別的題/.test(m)){ swappedId = qid; break; }
    if (/沒有別的同類型題目/.test(m)) noCand++;
    await evl(`document.getElementById('paMsg').textContent = ''`);
  }
  const txt1 = swappedId ? await evl(`document.getElementById(${JSON.stringify('pq-' + swappedId)}).textContent`) : '';
  const n1 = await evl(`document.querySelectorAll('.pa-q').length`), s1 = await sum();
  chk('換一題：提示已換、題目內容變了、題數與總分不變', swappedId && txt1 !== txt0 && n1 === 36 && s1 === 100, JSON.stringify({ swappedId, noCand, n1, s1 }));
  chk('沒有呼叫模型', S.calls().length === 0);

  section('刪一題（要按兩次）');
  const delId = await evl(`document.querySelectorAll('[data-ped="remove"]:not([disabled])')[2].dataset.qid`);
  await click(`[data-ped="remove"][data-qid="${delId}"]`);
  chk('第一次按：只是變成「再按一次確定刪除」，題目還在', await evl(`/再按一次/.test(document.querySelector('[data-ped="remove"][data-qid="${delId}"]').textContent) && document.querySelectorAll('.pa-q').length === 36`));
  await click(`[data-ped="remove"][data-qid="${delId}"]`);
  chk('第二次才刪：35 題、提示分數重新分配', await until(`document.querySelectorAll('.pa-q').length === 35 && /重新分配/.test(document.getElementById('paMsg').textContent)`, 5000));
  chk('刪題後滿分仍然是 100', await sum() === 100, String(await sum()));
  chk('標題寫的是「滿分 100 分」，卷子標題保留', await evl(`/滿分 100 分/.test(document.querySelector('.pa-head').textContent) && document.getElementById('paTitle').value === '期中複習 A'`));

  section('發佈與收回');
  await click('[data-ped="publish"]');
  chk('發佈：換題與刪除鈕消失，出現「收回成草稿」', await until(`!!document.querySelector('[data-ped="unpublish"]') && !document.querySelector('[data-ped="swap"]') && !document.querySelector('[data-ped="remove"]')`, 5000));
  await click('[data-ped="unpublish"]');
  chk('收回：變回草稿，又能編修', await until(`!!document.querySelector('[data-ped="publish"]') && !!document.querySelector('[data-ped="swap"]')`, 5000));
  await click('[data-ped="back"]');
  chk('回到列表：用新名稱顯示、35 題', await until(`/期中複習 A/.test(document.getElementById('pr-paper').textContent) && /35 題/.test(document.getElementById('pr-paper').textContent)`, 5000));

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
