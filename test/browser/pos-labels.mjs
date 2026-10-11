// 詞性標籤排版：換行的長句、「全部詞性」模式下，相鄰的短字（is a）標籤不能黏在一起，
// 錯開到下一排的標籤也不能壓到下一行的字。用真的 Chrome 量每個標籤的位置。
// 跑法：node --no-warnings test/browser/pos-labels.mjs   （自己開伺服器，不需要先開）
import { readFileSync } from 'node:fs';
import { start, shutdown } from '../api/_harness.mjs';
import { openPage, checker } from './_cdp.mjs';

const { chk, section, done } = checker();
const sentence = JSON.parse(readFileSync(new URL('./fixtures/jobs-sentence.json', import.meta.url), 'utf8'));
let page, code = 1;
try {
  const S = await start('ui-poslabels');
  for (const width of [360, 390, 430]) {
    section(`寬度 ${width}px：全部詞性`);
    page = await openPage(S.base + '/', { width, height: 900, settle: 2000 });
    await page.click('.tabs button[data-view="sentence"]');
    await page.evl(`(() => { document.getElementById('out').innerHTML = renderSentence(${JSON.stringify(sentence)}, false); })()`);
    await page.click('#posSeg button[data-pm="all"]');
    await page.evl(`layoutPosLabels()`); await page.wait(500);
    const m = await page.evl(`(() => {
      const labels = [...document.querySelectorAll('#out .plbl')].map(l => { const r = l.getBoundingClientRect(); return { t: l.textContent.trim(), l: r.left, r: r.right, top: r.top, bot: r.bottom, w: r.width }; }).filter(x => x.w > 0);
      // 同一排（top 差不到 4px）的標籤：相鄰兩個之間要有空隙
      let touch = 0;
      for (let i = 0; i < labels.length; i++) for (let j = i + 1; j < labels.length; j++) {
        const a = labels[i], b = labels[j];
        if (Math.abs(a.top - b.top) < 4 && Math.min(a.r, b.r) - Math.max(a.l, b.l) > -3 && Math.max(a.l, b.l) < Math.min(a.r, b.r) + 3) touch++;
      }
      return { n: labels.length, touch, labels: labels.map(x => x.t + '@' + Math.round(x.l) + ',' + Math.round(x.top)).join(' ') };
    })()`);
    chk('有標出全部詞性', m.n >= 12, JSON.stringify(m));
    chk('同一排的標籤不會黏在一起（v°art）', m.touch === 0, m.labels);
    await page.shot(`pos-labels-${width}.png`);
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
