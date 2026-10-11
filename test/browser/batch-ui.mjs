// 單字表「批次分析例句」的畫面：一開始就說明在做什麼、顯示經過的秒數；做完更新；伺服器中途斷掉要說「中斷了」而不是「分析完」。
// 自己開接假 CLI 的伺服器，不花額度。跑法：node --no-warnings test/browser/batch-ui.mjs
import { rmSync } from 'node:fs';
import { start, shutdown } from '../api/_harness.mjs';
import { makeFixture, W } from '../api/_fixture.mjs';
import { openPage, checker } from './_cdp.mjs';

const { chk, section, done } = checker();
const mk = prefix => {
  const fx = makeFixture(prefix);
  fx.cache.createWordset('頻率副詞', [
    W('always', 'adv', '總是', 'Zebras always run fast.', '斑馬總是跑很快。'),
    W('usually', 'adv', '通常', 'Lions usually sleep a lot.', '獅子通常睡很多。'),
    W('never', 'adv', '從不', 'Frogs never fly high.', '青蛙從不飛高。'),
  ]);
  fx.cache.db.close?.();
  return fx;
};
const fx1 = mk('peater-batch1-'), fx2 = mk('peater-batch2-');
let pages = [], code = 1;
const open = async (S, ) => {
  const p = await openPage(S.base + '/admin', { width: 1100, height: 1200, settle: 2500 });
  pages.push(p);
  await p.until(`!!document.getElementById('loginUser')`);
  await p.type('#loginUser', 't1'); await p.type('#loginPass', 'tp-1'); await p.click('#loginGo'); await p.wait(2500);
  await p.click('.tabs button[data-view="words"]');
  await p.until(`document.querySelectorAll('#wsList button').length > 0`, 8000);
  await p.evl(`[...document.querySelectorAll('#wsList button')].find(b => /頻率副詞/.test(b.textContent))?.click()`);
  await p.until(`document.querySelectorAll('#wsWords .wcard').length === 3`, 8000);
  return p;
};
try {
  const S1 = await start('ui-batch', { AUTH_USER: 't1', AUTH_PASS: 'tp-1' }, { dbFile: fx1.dbFile });
  const a = await open(S1);

  section('批次分析：一開始就有明確的狀態');
  chk('按鈕寫著還有 3 句', await a.evl(`/還有 3 句/.test(document.getElementById('wsAnalyze').textContent)`));
  await a.click('#wsAnalyze');
  chk('馬上說明：每 8 句一批、每批約一分鐘、做完才更新、不要離開', await a.until(`/每 8 句一批，每批約一分鐘/.test(document.getElementById('wsHint').textContent) && /請不要離開/.test(document.getElementById('wsHint').textContent)`, 3000) || await a.evl(`/分析完 3 句/.test(document.getElementById('wsHint').textContent)`));
  chk('按鈕在跑的時候停用', await a.evl(`document.getElementById('wsAnalyze').disabled === true`) || await a.evl(`/例句都分析過了/.test(document.getElementById('wsAnalyze').textContent)`));
  chk('跑完：按鈕變「例句都分析過了（3 句）」、提示分析完 3 句', await a.until(`/例句都分析過了（3 句）/.test(document.getElementById('wsAnalyze').textContent) && /分析完 3 句/.test(document.getElementById('wsHint').textContent)`, 20000), await a.evl(`document.getElementById('wsHint').textContent`));
  chk('之後每個例句的「分析」鈕都是「已分析」狀態', await a.until(`document.querySelectorAll('#wsWords .exan.done').length === 3`, 5000));

  section('伺服器中途斷掉：說「中斷了」，不說「分析完」');
  const S2 = await start('ui-batch-slow', { AUTH_USER: 't1', AUTH_PASS: 'tp-1', FAKE_DELAY_MS: '6000' }, { dbFile: fx2.dbFile });
  const b = await open(S2);
  await b.click('#wsAnalyze');
  chk('跑的時候按鈕顯示經過的秒數', await b.until(`/分析中…0 \\/ 3 句（已 \\d+ 秒）/.test(document.getElementById('wsAnalyze').textContent)`, 4000), await b.evl(`document.getElementById('wsAnalyze').textContent`));
  await b.wait(1500);
  S2.child.kill();                                              // 伺服器突然消失（像是重新啟動）
  chk('提示「連線中斷了」，建議再按一次接著跑', await b.until(`/連線中斷/.test(document.getElementById('wsHint').textContent)`, 15000), await b.evl(`document.getElementById('wsHint').textContent`));
  chk('不會說「分析完」', await b.evl(`!/分析完 \\d+ 句/.test(document.getElementById('wsHint').textContent)`));
  chk('按鈕恢復可以再按', await b.until(`document.getElementById('wsAnalyze').disabled === false`, 5000));

  section('其他');
  chk('沒有 JS 錯誤', a.errors.length === 0, a.errors.join(' | '));
  code = done();
} catch (e) {
  console.log('ERR', e.stack || e.message); code = 1;
} finally {
  for (const p of pages) try { p.close(); } catch {}
  process.exitCode = code;
  await shutdown().catch(() => {});
  for (const fx of [fx1, fx2]) try { rmSync(fx.dir, { recursive: true, force: true }); } catch {}
}
