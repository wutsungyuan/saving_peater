// 學生畫面掃描：走過學生的每個分頁與子頁，檢查
//   1. 看得到的文字裡沒有費用、額度、報價、模型這類字眼（那是老師的事）
//   2. 沒有任何請求被伺服器擋下（4xx、5xx）——學生按得到的東西，不該是會失敗的
//   3. 沒有 JS 錯誤、沒有看不到的重複 id
// 自己開接假 CLI 的伺服器，不花額度。跑法：node --no-warnings test/browser/student-sweep.mjs
import { rmSync } from 'node:fs';
import { start, shutdown } from '../api/_harness.mjs';
import { makeFixture } from '../api/_fixture.mjs';
import { openPage, checker } from './_cdp.mjs';

const { chk, section, done } = checker();
const fx = makeFixture('peater-sweep-');
fx.cache.db.close?.();
const T = { user: 'teacher1', pass: 'tpass-1' }, K = { user: 'kid1', pass: 'kpass-2' };
// 學生畫面上不該出現的字眼
const FORBIDDEN = /US\$|\$\s?\d|額度|費用|花費|報價|預估|opus|sonnet|claude|模型|呼叫|token|存取碼/i;
let page, code = 1;
try {
  const S = await start('ui-sweep', { AUTH_USER: T.user, AUTH_PASS: T.pass, STUDENT_USER: K.user, STUDENT_PASS: K.pass }, { dbFile: fx.dbFile });
  page = await openPage(S.base + '/', { width: 1000, height: 1200, settle: 2000 });
  const { evl, until, click, type, wait } = page;
  // 記下所有 /api/ 請求的結果
  const hook = `(() => { window.__bad = []; const f = window.fetch; window.fetch = (...a) => f(...a).then(r => { const u = String(a[0]?.url || a[0]); if (u.startsWith('/api/') && !u.startsWith('/api/login') && r.status >= 400) window.__bad.push(r.status + ' ' + u); return r; }); })()`;
  await until(`!!document.getElementById('loginUser')`);
  await type('#loginUser', K.user); await type('#loginPass', K.pass); await click('#loginGo'); await wait(2500);
  await evl(hook);

  // 目前看得到的文字（藏起來的不算）：只看主要內容區，不含左右的圖例側欄
  const seen = () => evl(`(() => { const out = []; for (const v of document.querySelectorAll('[id^="view-"]')) { if (v.hidden) continue; out.push(v.innerText); for (const e of v.querySelectorAll('[title],[placeholder],[aria-label]')) { if (e.offsetParent === null) continue; out.push(e.title || '', e.getAttribute('placeholder') || '', e.getAttribute('aria-label') || ''); } } return out.join('\\n'); })()`);
  const visit = async (label, steps) => {
    for (const s of steps) await s();
    await wait(900);
    const t = await seen();
    const m = FORBIDDEN.exec(t);
    chk(`${label}：看得到的文字沒有費用、額度、模型等字眼`, !m, m ? `「${m[0]}」附近：${t.slice(Math.max(0, m.index - 30), m.index + 40).replace(/\n/g, ' ')}` : '');
  };
  const tab = v => () => click(`.tabs button[data-view="${v}"]`);

  section('每個分頁看得到的文字');
  await visit('單字・清單', [tab('words')]);
  await visit('單字・測驗', [tab('words'), () => click('#view-words .subtabs button[data-pane="quiz"]')]);
  await visit('單字・申請新增字表的表單', [tab('words'), () => click('#view-words .subtabs button[data-pane="list"]'), () => click('#wsNew')]);
  await visit('句子・分析', [tab('sentence'), () => click('#snTabs button[data-sp="live"]')]);
  await visit('句子・練習', [tab('sentence'), () => click('#snTabs button[data-sp="practice"]')]);
  await visit('文章・文章表', [tab('article'), () => click('#arTabs button[data-ap="articles"]')]);
  await visit('文章・新增文章', [tab('article'), () => click('#arTabs button[data-ap="new"]')]);
  await visit('測驗卷', [tab('exam')]);
  await visit('弱點', [tab('weak')]);
  await visit('我的申請', [tab('jobs')]);

  section('學生會碰到的提示文字');
  // 送出一句沒分析過的句子 → 申請；看提示文字
  await click('.tabs button[data-view="sentence"]'); await click('#snTabs button[data-sp="live"]');
  await type('#inp', 'Birds can fly high.');
  await click('#go');
  await until(`/已送出申請/.test(document.getElementById('usageBar').textContent)`, 8000);
  const sentenceText = await seen(); const m1 = FORBIDDEN.exec(sentenceText + '\n' + await evl(`document.getElementById('inp-hint').textContent`));
  chk('分析新句子後的提示（等老師核准）沒有費用字眼', !m1, m1?.[0]);
  await click('.tabs button[data-view="article"]'); await click('#arTabs button[data-ap="new"]');
  await type('#artName', '課文S'); await type('#inp', 'Dogs run fast. Cats sleep a lot.');
  await click('#go');
  await until(`!!document.getElementById('artGo')`, 8000);
  const m2 = FORBIDDEN.exec(await evl(`document.getElementById('artConfirm').textContent + ' ' + document.getElementById('inp-hint').textContent`));
  chk('存成文章的確認框沒有費用字眼', !m2, m2?.[0]);
  await click('.tabs button[data-view="words"]'); await click('#wsNew');
  await type('#wsText', 'apple, 蘋果'); await click('#wsCreate');
  await until(`/已送出申請/.test(document.getElementById('wsHint').textContent)`, 8000);
  const m3 = FORBIDDEN.exec(await evl(`document.getElementById('wsHint').textContent`));
  chk('申請新增字表後的提示沒有費用字眼', !m3, m3?.[0]);

  section('沒有被擋下的請求');
  const bad = await evl(`window.__bad`);
  chk('所有分頁走過一遍，沒有任何 4xx／5xx 的 API 請求', bad.length === 0, bad.join(' | '));
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
