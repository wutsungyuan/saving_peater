// 朗讀說完了，按鈕要自己回到「朗讀」。iPhone 常常說完了卻不送 end 事件，按鈕就一直停在「停止」。
// 這裡把 speechSynthesis 換成「說完了但不送 onend」的假貨，驗證輪詢與逾時保險真的會結束。
// 跑法：node --no-warnings test/browser/speech-end.mjs   （自己開伺服器，不需要先開）
import { start, shutdown } from '../api/_harness.mjs';
import { openPage, checker } from './_cdp.mjs';

const { chk, section, done } = checker();
// mode: 'noend' = 說完了（speaking 變 false）但不送 onend；'never' = speaking 永遠是 true 也不送 onend；'normal' = 正常送 onend
const stub = mode => `(() => {
  class U { constructor(t){ this.text = t; } }
  const synth = { speaking: false, pending: false, paused: false,
    getVoices(){ return [{ name: 'Samantha', lang: 'en-US', localService: true }]; },
    addEventListener(){}, resume(){},
    speak(u){ this.speaking = true; setTimeout(() => u.onstart && u.onstart(), 20);
      if (${JSON.stringify(mode)} === 'noend') setTimeout(() => { this.speaking = false; }, 600);
      if (${JSON.stringify(mode)} === 'normal') setTimeout(() => { this.speaking = false; u.onend && u.onend({}); }, 600); },
    cancel(){ this.speaking = false; } };
  Object.defineProperty(window, 'speechSynthesis', { value: synth, configurable: true });
  window.SpeechSynthesisUtterance = U;
})()`;

let page, code = 1;
try {
  const S = await start('ui-speech-end');
  for (const [mode, label, limit] of [['noend', '說完了但不送 end 事件（iPhone）', 4000], ['never', 'speaking 一直是 true 也不送 end（最壞的情況）', 9000], ['normal', '正常會送 end', 3000]]) {
    section(label);
    page = await openPage(S.base + '/', { width: 420, height: 900, settle: 1500 });
    await page.send('Page.addScriptToEvaluateOnNewDocument', { source: stub(mode) });
    await page.send('Page.reload'); await page.wait(2500);
    await page.click('.tabs button[data-view="analyze"]'); await page.wait(300);
    await page.type('#inp', 'We have great teachers.');
    await page.click('#go');
    chk('分析出一張卡、有朗讀按鈕', await page.until(`!!document.querySelector('#out .say')`, 15000));
    await page.click('#out .say');
    chk('按下去：按鈕變成「停止」', await page.until(`/停止/.test(document.querySelector('#out .say').textContent)`, 3000));
    const t0 = Date.now();
    const back = await page.until(`/朗讀/.test(document.querySelector('#out .say').textContent) && document.querySelector('#out .say').getAttribute('aria-pressed') !== 'true'`, limit);
    chk(`說完後 ${limit / 1000} 秒內按鈕自己回到「朗讀」`, back, await page.evl(`document.querySelector('#out .say').textContent`));
    if (back) console.log(`    （${((Date.now() - t0) / 1000).toFixed(1)} 秒）`);
    chk('卡片的「朗讀中」標記也清掉了', await page.evl(`!document.querySelector('#out .sent.saying')`));
    chk('再按一次可以重新朗讀', await (async () => { await page.click('#out .say'); return page.until(`/停止/.test(document.querySelector('#out .say').textContent)`, 3000); })());
    await page.click('#out .say');
    chk('朗讀中按「停止」立刻回到「朗讀」', await page.until(`/朗讀/.test(document.querySelector('#out .say').textContent)`, 2000));
    chk('沒有 JS 錯誤', page.errors.length === 0, page.errors.join(' | '));
    page.close();
  }
  code = done();
} catch (e) {
  console.log('ERR', e.stack || e.message); code = 1;
} finally {
  try { page?.close(); } catch {}
  process.exitCode = code;
  await shutdown().catch(() => {});
}
