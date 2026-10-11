// 學生介面導覽：頂層分頁（單字／句子／文章…）、句子練習在「句子」底下、單字搜尋（中英文、跨字表）、返回鈕。
// 自己開接假 CLI 的伺服器，不花額度。跑法：node --no-warnings test/browser/nav-ui.mjs
import { rmSync } from 'node:fs';
import { start, shutdown } from '../api/_harness.mjs';
import { makeFixture, W } from '../api/_fixture.mjs';
import { openPage, checker } from './_cdp.mjs';

const { chk, section, done } = checker();
const fx = makeFixture('peater-nav-');
// 第二份字表：搜尋要跨字表找得到（畫面上只選第一份）
fx.cache.createWordset('Unit2', [
  W('finish', 'v', '完成；結束', 'Please finish your homework.', '請完成你的功課。'),
  W('end', 'v', '結束', 'The movie will end at nine.', '電影九點結束。'),
]);
fx.cache.db.close?.();
let page, code = 1;
try {
  const S = await start('ui-nav', {}, { dbFile: fx.dbFile });
  page = await openPage(S.base + '/', { width: 1000, height: 1100, settle: 2500 });
  const { evl, until, click, type, wait } = page;

  section('頂層分頁與子頁');
  chk('頂層（老師看到的）：單字、句子、文章、測驗卷、弱點、待審、歷史', await evl(`[...document.querySelectorAll('.tabs button')].filter(b => getComputedStyle(b).display !== 'none').map(b => b.textContent.trim()).join() === '單字,句子,文章,測驗卷,弱點,待審,歷史'`));
  chk('單字底下：單字清單、單字測驗', await evl(`[...document.querySelectorAll('#view-words .subtabs button')].map(b => b.textContent.trim()).join() === '單字清單,單字測驗'`));
  chk('沒有獨立的「句子練習」頂層分頁', await evl(`!document.getElementById('view-practice') && ![...document.querySelectorAll('.tabs button')].some(b => /練習/.test(b.textContent))`));
  await click('.tabs button[data-view="sentence"]');
  chk('句子：預設是句子分析，有輸入框', await until(`!document.getElementById('view-sentence').hidden && !document.getElementById('an-live').hidden && document.getElementById('sn-practice').hidden`));
  await click('#snTabs button[data-sp="practice"]');
  chk('句子練習在句子底下：切過去會出題', await until(`document.getElementById('an-live').hidden && !document.getElementById('sn-practice').hidden && document.querySelectorAll('#quizOut .q').length > 0`, 8000));
  await click('#snTabs button[data-sp="live"]');
  chk('切回句子分析', await until(`!document.getElementById('an-live').hidden && document.getElementById('sn-practice').hidden`));
  await click('.tabs button[data-view="article"]');
  chk('文章：預設是文章表，輸入框不在這', await until(`!document.getElementById('view-article').hidden && !document.getElementById('an-articles').hidden && document.getElementById('ar-new').hidden`));
  await click('#arTabs button[data-ap="new"]');
  chk('新增文章：同一個輸入框搬到這裡', await until(`!!document.querySelector('#ar-new #inp') && !document.getElementById('ar-new').hidden`));
  chk('新增文章：預設的範例句被清掉', await evl(`document.getElementById('inp').value === ''`));
  await click('.tabs button[data-view="sentence"]');
  chk('回到句子分析：輸入框搬回句子頁', await until(`!!document.querySelector('#view-sentence #inp') && document.getElementById('artNameRow').hidden`));

  section('單字搜尋');
  await click('.tabs button[data-view="words"]');
  await until(`document.querySelectorAll('#wsWords .wcard').length > 0`, 8000);
  chk('單字清單上方有搜尋框', await evl(`!!document.querySelector('#pane-list #wsSearch') && document.getElementById('wsSearchOut').hidden`));
  await type('#wsSearch', '蘋果');
  chk('中文搜尋：找到 apple', await until(`!document.getElementById('wsSearchOut').hidden && /apple/.test(document.getElementById('wsSearchOut').textContent) && document.getElementById('wsWords').hidden`, 5000), await evl(`document.getElementById('wsSearchOut').textContent.slice(0, 120)`));
  await type('#wsSearch', 'tea');
  chk('英文搜尋（部分字）：找到 teach', await until(`/teach/.test(document.getElementById('wsSearchOut').textContent)`, 5000));
  await type('#wsSearch', '結束');
  chk('跨字表：目前只選第一份，也找得到另一份字表的 end 與 finish', await until(`/finish/.test(document.getElementById('wsSearchOut').textContent) && /(^|[^a-z])end([^a-z]|$)/.test(document.getElementById('wsSearchOut').textContent)`, 5000), await evl(`document.getElementById('wsSearchOut').textContent.slice(0, 160)`));
  chk('結果標出來自哪份字表', await evl(`!!document.querySelector('#wsSearchOut .setof, #wsSearchOut .dupt')`));
  await type('#wsSearch', 'zzzqqq');
  chk('找不到：顯示提示', await until(`/找不到/.test(document.getElementById('wsSearchOut').textContent)`, 5000));
  await click('#wsSearchClear');
  chk('清除：回到原本的單字清單', await until(`document.getElementById('wsSearchOut').hidden && !document.getElementById('wsWords').hidden && document.getElementById('wsSearch').value === ''`));

  section('返回單字');
  await type('#wsSearch', 'apple');
  await until(`!!document.querySelector('#wsSearchOut .exan')`, 5000);
  await click('#wsSearchOut .exan');
  chk('從單字的例句按「分析」→ 進到句子分析', await until(`document.body.dataset.view === 'sentence' && !document.getElementById('an-live').hidden`));
  chk('上方出現「← 返回單字」', await evl(`!document.getElementById('backBar').hidden && /返回單字/.test(document.getElementById('backBtn').textContent)`));
  chk('例句分析出結果', await until(`document.querySelectorAll('#out article.sent').length === 1`, 15000));
  await click('#backBtn');
  chk('按返回：回到單字、返回鈕消失', await until(`document.body.dataset.view === 'words' && !document.getElementById('view-words').hidden && document.getElementById('backBar').hidden`));
  await click('#wsSearchClear');
  await click('.tabs button[data-view="history"]');
  await click('.tabs button[data-view="sentence"]');
  chk('自己點分頁過去：不顯示返回鈕', await evl(`document.getElementById('backBar').hidden`));

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
