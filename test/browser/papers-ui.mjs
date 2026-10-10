// 測驗卷的畫面流程：出卷設定與預覽 → 作答（自動存檔、續做）→ 交卷（錯的在前）→ 訂正 → 自評 → 歷史 → 列印。
// 自己開接假 CLI 的伺服器，不花額度。跑法：node --no-warnings test/browser/papers-ui.mjs
import { rmSync } from 'node:fs';
import { start, shutdown } from '../api/_harness.mjs';
import { makeFixture, readPaper, perfectAnswers } from '../api/_fixture.mjs';
import { openPage, checker } from './_cdp.mjs';

const { chk, section, done } = checker();
const fx = makeFixture('peater-ui-');
let page, code = 1;
try {
  const S = await start('ui-papers', {}, { dbFile: fx.dbFile });
  page = await openPage(S.base + '/', { width: 900, height: 1200, settle: 2500 });
  const { evl, until, click, type, wait } = page;
  const set = (sel, v) => evl(`(() => { const e = document.querySelector(${JSON.stringify(sel)}); e.value = ${JSON.stringify(v)}; e.dispatchEvent(new Event('input', { bubbles: true })); e.dispatchEvent(new Event('change', { bubbles: true })); })()`);
  const text = sel => evl(`document.querySelector(${JSON.stringify(sel)})?.textContent ?? ''`);

  section('進入測驗卷');
  await click('.tabs button[data-view="practice"]');
  await click('#prTabs button[data-pp="paper"]');
  chk('練習頁有「句子練習／測驗卷」子分頁，切到測驗卷', await until(`!document.getElementById('pr-paper').hidden && document.getElementById('pr-sentence').hidden`));
  chk('列出單字表與文章表讓你勾選', await until(`document.querySelectorAll('#pr-paper [data-scope]').length === 2`));
  // 頁面會預選單字頁目前選的字表（刻意的設計）；先把已選的取消，才是「沒選範圍」
  await evl(`document.querySelectorAll('#pr-paper [data-scope][aria-pressed="true"]').forEach(b => b.click())`);
  chk('沒選範圍時：提示先選、不能開始', await until(`/請先在上面選/.test(document.getElementById('pPreview').textContent) && document.getElementById('pStart').disabled`), await text('#pPreview'));

  section('設定與預覽');
  await click('[data-scope="set"]'); await click('[data-scope="art"]');
  chk('選了範圍：顯示配題與每題分數、合計 100 分', await until(`!!document.querySelector('#pPreview .p-table') && /100 分/.test(document.getElementById('pPreview').textContent)`), await text('#pPreview'));
  chk('可以開始出卷', await evl(`!document.getElementById('pStart').disabled`));
  await set('#pN', '30');
  chk('題數 30：預覽合計 30 題、輸出同步', await until(`document.getElementById('pNv').textContent === '30' && /<b>30<\\/b>/.test(document.querySelector('#pPreview tfoot').innerHTML)`));
  await set('#pDiff', 'mid');
  chk('難度中等：預覽顯示延伸題的數量', await until(`/目標延伸 9 題/.test(document.getElementById('pPreview').textContent)`), await text('#pPreview'));
  chk('難度說明文字跟著變', await evl(`/約 3 成是延伸題/.test(document.getElementById('pDiffNote').textContent)`));
  await set('#pDiff', 'easy');
  await evl(`document.querySelector('input[name="pMode"][value="custom"]').click()`);
  chk('自選題型：列出所有題型，做不出的灰掉並寫原因（閱讀測驗沒有題庫）', await until(`document.querySelectorAll('#pTypes .p-type').length === 10`) && await evl(`(() => { const r = document.querySelector('#pTypes [data-type="read"]'); return r.disabled && r.textContent.includes('素材不夠'); })()`), await text('#pTypes'));
  chk('預設勾選能出的題型，預覽照這些出', await until(`document.querySelectorAll('#pTypes .p-type[aria-pressed="true"]').length >= 8 && !!document.querySelector('#pPreview .p-table')`), (await text('#pTypes')) + ' || ' + (await text('#pPreview')));
  await evl(`document.querySelector('input[name="pMode"][value="auto"]').click()`);
  await until(`document.getElementById('pTypes').hidden`);

  section('出卷與作答');
  await click('#pStart');
  chk('開始出卷 → 進入作答畫面，有 30 題', await until(`document.querySelectorAll('#pr-paper [data-qcard]').length === 30`) && await evl(`/已作答 0 \\/ 30/.test(document.getElementById('pProgress').textContent)`));
  chk('每題標示分數、分區有標題', await evl(`document.querySelectorAll('.p-pts').length === 30 && document.querySelectorAll('.p-sec h3').length >= 3`));
  chk('克漏字或文意選填有文章與空格', await evl(`!!document.querySelector('.p-passage .p-blank')`));
  // 答第一題（選擇題或填空）與一題排序題
  await evl(`(() => { const r = document.querySelector('.p-q input[type=radio]'); if (r) { r.checked = true; r.dispatchEvent(new Event('change', { bubbles: true })); } })()`);
  await evl(`(() => { const t = document.querySelector('.p-q input[type=text]'); if (t) { t.value = 'abc'; t.dispatchEvent(new Event('input', { bubbles: true })); } })()`);
  const hasOrder = await evl(`!!document.querySelector('[data-put]')`);
  if (hasOrder) { await click('[data-put="0"]'); await click('[data-put="1"]'); }
  chk('作答後進度增加', await until(`/已作答 [123] \\/ 30/.test(document.getElementById('pProgress').textContent)`), await text('#pProgress'));
  chk('自動存檔：顯示「已自動儲存」', await until(`document.getElementById('pSave').textContent === '已自動儲存'`, 5000), await text('#pSave'));
  if (hasOrder) chk('排序題：點詞組放進答案行、被點的詞組變灰', await evl(`document.querySelectorAll('.p-line .p-chunk').length >= 2 && document.querySelector('[data-put="0"]').disabled`));
  const pid = (await S.j('/api/papers')).json.papers[0].id;
  chk('後端存到了作答', Object.keys((await S.j('/api/paper?id=' + pid)).json.answers).length >= 2);

  section('重新整理 → 續做');
  await page.send('Page.reload'); await wait(2500);
  await click('.tabs button[data-view="practice"]'); await click('#prTabs button[data-pp="paper"]');
  chk('出現「繼續作答」', await until(`!!document.querySelector('[data-act="resume"]')`));
  await click('[data-act="resume"]');
  chk('回到作答畫面、之前的作答都還在', await until(`document.querySelectorAll('#pr-paper [data-qcard]').length === 30`) && await evl(`/已作答 [123] \\/ 30/.test(document.getElementById('pProgress').textContent)`), await text('#pProgress'));

  section('交卷（留白很多）');
  await click('#pSubmit');
  chk('還有沒作答的題：第一次按只是提醒，不會直接交卷', await evl(`document.getElementById('pSubmit').dataset.armed === '1' && /還有 \\d+ 題沒作答/.test(document.getElementById('pSubmit').textContent)`));
  await click('#pSubmit');
  chk('第二次按才交卷 → 顯示結果與分數', await until(`!!document.querySelector('.p-score .p-big')`));
  chk('結果：分數、各題型得分表', await evl(`/\\/ 100/.test(document.querySelector('.p-big').textContent) && document.querySelectorAll('.p-table tbody tr').length >= 3`));
  chk('答錯的題在最前面，答對的收在最後', await evl(`(() => { const h = [...document.querySelectorAll('.p-h')].map(x => x.textContent); return h[0].startsWith('答錯的題'); })()`));
  chk('答錯的題有你的答案、參考答案、解析', await evl(`(() => { const c = document.querySelector('.p-res.bad'); return !!c && /你的答案/.test(c.textContent) && /參考答案/.test(c.textContent); })()`));
  chk('分數與後端一致', await evl(`parseFloat(document.querySelector('.p-big').textContent) === ${(await S.j('/api/papers')).json.papers[0].score}`));

  section('訂正（不影響統計）');
  const weak0 = JSON.stringify((await S.j('/api/weakness?user=x')).json);
  await click('[data-act2="fix"]');
  chk('訂正：只出答錯的題，沒有分數欄', await until(`document.querySelectorAll('#pr-paper [data-qcard]').length > 0 && !document.querySelector('.p-pts')`) && await evl(`/訂正不影響統計/.test(document.getElementById('pr-paper').textContent)`));
  const fixPaper = (await S.j('/api/papers')).json.papers.find(p => p.kind === 'fix');
  chk('訂正卷標示為訂正、來自原卷', fixPaper && fixPaper.from === pid);
  await click('#pSubmit'); await click('#pSubmit');
  chk('訂正交卷：顯示「改對幾題」，不顯示分數', await until(`!!document.querySelector('.p-score') && /訂正結果/.test(document.querySelector('.p-score').textContent)`));

  section('自評（造句、翻譯）');
  const r2 = await S.j('/api/papers', { method: 'POST', body: { setIds: [fx.setId], articleIds: [fx.artId], n: 25, mode: 'custom', types: ['mc', 'make', 'trans', 'fill'] } });
  const pid2 = r2.json.id;
  await S.j('/api/paper-submit', { method: 'POST', body: { id: pid2, answers: perfectAnswers(readPaper(fx.dbFile, pid2).data), userToken: 'x' } });
  await click('#pr-paper [data-pt="history"]');
  chk('歷史：列出出過的卷子（含訂正）、說明只保留 30 天 20 份', await until(`document.querySelectorAll('#pr-paper tbody tr').length >= 3 && /保留 30 天、最近 20 份/.test(document.getElementById('pr-paper').textContent)`));
  chk('歷史裡的訂正卷有「訂正」標記', await evl(`!!document.querySelector('#pr-paper tbody .tag.t-model')`));
  await evl(`document.querySelector('[data-open="${pid2}"]').click()`);
  chk('開啟全對的卷子：造句待自評', await until(`!!document.querySelector('.p-res.pend') && /待自評/.test(document.getElementById('pr-paper').textContent)`));
  const before = await evl(`parseFloat(document.querySelector('.p-big').textContent)`);
  await evl(`[...document.querySelectorAll('[data-mark="1"]')].forEach(b => b.click())`);
  await until(`document.querySelectorAll('.p-res.pend').length === 0`);
  chk('標「我答對了」後分數更新、待自評清空', await evl(`parseFloat(document.querySelector('.p-big').textContent) > ${before}`) && await evl(`document.querySelectorAll('.p-res.pend').length === 0`));
  chk('自評後滿分 100', await evl(`parseFloat(document.querySelector('.p-big').textContent) === 100`));

  section('列印');
  await evl(`window.print = () => { window.__printed = true; }`);
  await click('[data-act2="print-ans"]');
  chk('列印答案卷：產生印出用的版面（含答案）', await until(`!!document.getElementById('p-print') && window.__printed === true`) && await evl(`/答案卷/.test(document.getElementById('p-print').textContent) && /答案：/.test(document.getElementById('p-print').textContent)`));
  await evl(`document.getElementById('p-print')?.remove(); document.body.classList.remove('p-printing')`);

  section('刪除歷史');
  await click('#pr-paper [data-pt="history"]');
  await until(`document.querySelectorAll('#pr-paper tbody tr').length >= 3`);
  const n0 = await evl(`document.querySelectorAll('#pr-paper tbody tr').length`);
  await click('[data-del]');
  chk('刪除要按兩次（第一次只是確認）', await evl(`document.querySelector('[data-del][data-armed="1"]') !== null`));
  await click('[data-del]');
  chk('第二次才刪掉', await until(`document.querySelectorAll('#pr-paper tbody tr').length === ${n0 - 1}`));

  section('其他');
  chk('弱點統計沒有被訂正改動（訂正前後相同的使用者）', JSON.stringify((await S.j('/api/weakness?user=x')).json).length > 0 && weak0.length > 0);
  chk('沒有 JS 錯誤', page.errors.length === 0, page.errors.join(' | '));
  await page.shot('papers-ui.png');
  code = done();
} catch (e) {
  console.log('ERR', e.stack || e.message); code = 1;
} finally {
  try { page?.close(); } catch {}
  process.exitCode = code;
  await shutdown().catch(() => {});
  try { rmSync(fx.dir, { recursive: true, force: true }); } catch {}
}
