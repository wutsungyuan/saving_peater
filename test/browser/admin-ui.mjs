// 老師後台的畫面：分頁、前後台切換、句子管理（搜尋、看分析、排除出題、重新分析、刪除）、學生紀錄。
// 自己開接假 CLI 的伺服器，不花額度。跑法：node --no-warnings test/browser/admin-ui.mjs
import { rmSync } from 'node:fs';
import { start, shutdown } from '../api/_harness.mjs';
import { makeFixture } from '../api/_fixture.mjs';
import { openPage, checker } from './_cdp.mjs';

const { chk, section, done } = checker();
const fx = makeFixture('peater-adminui-');
// 學生的作答（後台「學生紀錄」要看到）
const [w1] = fx.cache.wordsOf([fx.setId], 'student');
for (const ok of [true, false, true]) fx.cache.recordAttempt({ userToken: 'student', qtype: 'pattern', patternId: 3, correct: ok });
for (const ok of [false, false, true]) fx.cache.recordWordAttempt({ userToken: 'student', wordId: w1.id, mode: 'zh2en', correct: ok });
fx.cache.db.close?.();
const T = { user: 'teacher1', pass: 'tpass-1' }, K = { user: 'kid1', pass: 'kpass-2' };
let pages = [], code = 1;
const login = async (base, who, path) => {
  const p = await openPage(base + path, { width: 1100, height: 1200, settle: 2500 });
  pages.push(p);
  await p.until(`!!document.getElementById('loginUser')`);
  await p.type('#loginUser', who.user); await p.type('#loginPass', who.pass);
  await p.click('#loginGo'); await p.wait(2500);
  return p;
};
const visibleTabs = p => p.evl(`[...document.querySelectorAll('.tabs button')].filter(b => getComputedStyle(b).display !== 'none').sort((a, b) => a.getBoundingClientRect().left - b.getBoundingClientRect().left).map(b => b.innerText.replace(/\\d+$/, '').trim()).join()`);
const shown = (p, sel) => p.evl(`(() => { const e = document.querySelector(${JSON.stringify(sel)}); return !!e && getComputedStyle(e).display !== 'none'; })()`);
try {
  const S = await start('ui-admin', { AUTH_USER: T.user, AUTH_PASS: T.pass, STUDENT_USER: K.user, STUDENT_PASS: K.pass }, { dbFile: fx.dbFile });

  section('後台的分頁');
  const a = await login(S.base, T, '/admin');
  chk('body 標著後台、老師', await a.until(`document.body.dataset.app === 'admin' && document.body.dataset.role === 'teacher'`));
  chk('分頁：待審、測驗卷、單字表、文章表、句子、學生紀錄、費用與用量', await visibleTabs(a) === '待審,測驗卷,單字表,文章表,句子,學生紀錄,費用與用量', await visibleTabs(a));
  chk('一進來先看待審', await a.evl(`document.body.dataset.view === 'jobs' && !document.getElementById('view-jobs').hidden`));
  chk('有「回到前台」連結、沒有「進入後台」', await shown(a, '#frontLink') && !(await shown(a, '#adminLink')));
  chk('後台沒有學生用的分頁（句子分析、弱點）', !(await shown(a, '.tabs button[data-view="sentence"]')) && !(await shown(a, '.tabs button[data-view="weak"]')));

  section('後台：單字表與文章表是管理用');
  await a.click('.tabs button[data-view="words"]');
  await a.until(`document.querySelectorAll('#wsList button').length > 0`, 8000);
  chk('單字表：有「新增字表」，沒有「單字測驗」', await shown(a, '#wsNew') && !(await shown(a, '#view-words .subtabs button[data-pane="quiz"]')));
  await a.click('.tabs button[data-view="exam"]');
  chk('測驗卷：有「出卷」', await a.until(`getComputedStyle(document.querySelector('#pr-paper [data-pt="setup"]')).display !== 'none'`, 8000));
  await a.click('.tabs button[data-view="article"]');
  chk('文章表：沒有「新增文章」', await a.until(`!document.getElementById('an-articles').hidden`) && !(await shown(a, '#arTabs button[data-ap="new"]')));

  await a.until(`document.querySelectorAll('#artList .art-card').length >= 1`, 8000);
  await a.click('#artList .art-card');
  chk('後台文章表：點進一份，有「改名」「刪除」', await a.until(`!document.getElementById('artView').hidden`, 5000) && await shown(a, '#artRename') && await shown(a, '#artDelete'));
  await a.click('#artRename');
  chk('按「改名」：輸入框真的出現在畫面上', await a.evl(`(() => { const e = document.getElementById('artNewName'); return !!e && e.offsetParent !== null && e.getBoundingClientRect().height > 0; })()`));
  await a.type('#artNewName', '後台改的名字');
  await a.click('#artRenameOk');
  chk('改名成功：標題更新', await a.until(`document.getElementById('artTitle').textContent === '後台改的名字'`, 5000));

  section('句子管理');
  await a.click('.tabs button[data-view="sentences"]');
  chk('列出已分析的句子，顯示總數', await a.until(`document.querySelectorAll('#snList .srow').length >= 20 && /共 \\d+ 句/.test(document.getElementById('snCount').textContent)`, 8000));
  const firstText = await a.evl(`document.querySelector('#snList .srow .en').textContent`);
  const firstHash = await a.evl(`document.querySelector('#snList .srow').dataset.hash`);
  await a.type('#snQ', firstText);
  chk('搜尋整句：找得到那一句', await a.until(`[...document.querySelectorAll('#snList .srow')].some(r => r.dataset.hash === ${JSON.stringify(firstHash)})`, 5000));
  await a.type('#snQ', 'zzzqqq');
  chk('搜不到：顯示「沒有符合的句子」', await a.until(`/沒有符合的句子/.test(document.getElementById('snList').textContent)`, 5000));
  await a.type('#snQ', '');
  await a.until(`document.querySelectorAll('#snList .srow').length >= 20`, 5000);

  const hash = await a.evl(`document.querySelector('#snList .srow').dataset.hash`);
  await a.click('#snList .srow [data-sn="view"]');
  chk('看分析：展開完整分析卡', await a.until(`!!document.querySelector('#snList .srow .srow-detail .sent') && !document.querySelector('#snList .srow .srow-detail').hidden`, 5000));
  await a.click('#snList .srow [data-sn="view"]');
  chk('再按收起', await a.evl(`document.querySelector('#snList .srow .srow-detail').hidden`));

  await a.click('#snList .srow [data-sn="exclude"]');
  chk('排除出題：那一列標上「已排除出題」，按鈕變「恢復出題」', await a.until(`!!document.querySelector('#snList .srow.ex') && /恢復出題/.test(document.querySelector('#snList .srow.ex').textContent)`, 5000));
  await a.evl(`(() => { const s = document.getElementById('snFilter'); s.value = 'excluded'; s.dispatchEvent(new Event('change')); })()`);
  chk('篩選「已排除出題」：只剩這一句', await a.until(`document.querySelectorAll('#snList .srow').length === 1 && document.querySelector('#snList .srow').dataset.hash === ${JSON.stringify(hash)}`, 5000));
  await a.click('#snList .srow [data-sn="exclude"]');
  chk('恢復後從「已排除」清單消失', await a.until(`document.querySelectorAll('#snList .srow').length === 0`, 5000));
  await a.evl(`(() => { const s = document.getElementById('snFilter'); s.value = 'all'; s.dispatchEvent(new Event('change')); })()`);
  await a.until(`document.querySelectorAll('#snList .srow').length >= 20`, 5000);

  const calls0 = S.calls().length;
  await a.click('#snList .srow [data-sn="reanalyze"]');
  chk('重新分析：先顯示報價與確認鈕，還沒呼叫模型', await a.until(`/預估 US\\$\\d/.test(document.querySelector('#snList .srow .srow-msg').textContent) && !!document.querySelector('[data-sn="reanalyze-go"]')`, 5000) && S.calls().length === calls0);
  await a.click('[data-sn="reanalyze-no"]');
  chk('取消：沒有呼叫模型', S.calls().length === calls0 && await a.evl(`document.querySelector('#snList .srow .srow-msg').textContent === ''`));
  chk('被文章用到的句子：刪除鈕停用', await a.evl(`document.querySelector('#snList .srow [data-sn="delete"]').disabled === true`));

  section('沒有範圍的句子：歸進文章表');
  chk('預設（全部）看不到歸類區', !(await shown(a, '#snAssign')));
  await a.evl(`(() => { const s = document.getElementById('snFilter'); s.value = 'unused'; s.dispatchEvent(new Event('change')); })()`);
  chk('篩選「沒有被文章用到」：出現歸類區', await a.until(`document.querySelectorAll('#snList .srow').length > 0`, 5000) && await shown(a, '#snAssign'));
  const nUnused = await a.evl(`snState.total`);
  await a.click('#snAssignGo');
  chk('沒填名稱：提示先輸入，不會往下', await a.evl(`/請先輸入範圍名稱/.test(document.getElementById('snAssignMsg').textContent)`));
  await a.type('#snAssignName', '後台歸類');
  await a.click('#snAssignGo');
  chk('預覽：寫出會歸入「後台歸類」幾句、新建，還沒動資料', await a.until(`!!document.getElementById('snAssignOk') && document.getElementById('snAssignMsg').textContent.includes('後台歸類') && document.getElementById('snAssignMsg').textContent.includes('新建')`, 5000) && await a.evl(`fetch('/api/articles').then(r => r.json()).then(d => d.articles.every(x => x.name !== '後台歸類'))`), await a.evl(`document.getElementById('snAssignMsg').textContent`));
  await a.click('#snAssignNo');
  chk('取消：訊息收起來', await a.evl(`document.getElementById('snAssignMsg').textContent === ''`));
  await a.click('#snAssignGo');
  await a.until(`!!document.getElementById('snAssignOk')`, 5000);
  await a.click('#snAssignOk');
  chk('確定後：顯示已歸入，「沒有範圍」的清單只剩無法分析的句子', await a.until(`/已歸入 \\d+ 句/.test(document.getElementById('snAssignMsg').textContent) && document.querySelectorAll('#snList .srow').length < ${nUnused} && [...document.querySelectorAll('#snList .srow')].every(r => /無法分析/.test(r.textContent))`, 8000), await a.evl(`document.getElementById('snAssignMsg').textContent`));
  chk('後端真的建了文章表「後台歸類」', await a.evl(`fetch('/api/articles').then(r => r.json()).then(d => d.articles.some(x => x.name === '後台歸類' && x.sentences > 0))`));
  await a.evl(`(() => { const s = document.getElementById('snFilter'); s.value = 'all'; s.dispatchEvent(new Event('change')); })()`);
  chk('切回全部：歸類區收起', await a.until(`document.getElementById('snAssign').hidden`, 5000));

  section('學生紀錄');
  await a.click('.tabs button[data-view="students"]');
  chk('看到學生的紀錄（整體 4 題對 2、句型、單字）', await a.until(`/50%/.test(document.getElementById('studHead').textContent) && /五大句型/.test(document.getElementById('studCharts').textContent) && /最弱的單字/.test(document.getElementById('studCharts').textContent)`, 8000), (await a.evl(`document.getElementById('studHead').textContent.slice(0, 120)`)));
  chk('後台看學生紀錄：沒有「針對弱點練習」「複習單字」按鈕', !(await a.evl(`!!document.getElementById('weakPractice') || !!document.getElementById('weakWords')`)));
  await a.click('#studTabs button[data-src="quiz"]');
  chk('可以切來源：單字測驗只有單字面向', await a.until(`/最弱的單字/.test(document.getElementById('studCharts').textContent) && !/五大句型/.test(document.getElementById('studCharts').textContent)`, 5000));

  section('整理學生紀錄（刪除）');
  const studentW = () => a.evl(`fetch('/api/weakness?as=student').then(r => r.json())`);          // 用老師的登入狀態讀學生的統計
  await a.evl(`document.getElementById('recBox').open = true; document.getElementById('recBox').dispatchEvent(new Event('toggle'))`);
  chk('展開：有範圍、日期、單字表、熟練度選項', await a.until(`document.querySelectorAll('#recSets .tchip').length >= 1`, 5000) && await shown(a, '#recKind') && await shown(a, '#recFrom') && await shown(a, '#recReset'));
  await a.click('#recPreview');
  chk('預覽：寫明會刪多少（句子 3、單字 3），有「確定刪除」', await a.until(`/句子作答 3 筆、單字作答 3 筆/.test(document.getElementById('recResult').textContent) && !!document.getElementById('recGo')`, 5000), await a.evl(`document.getElementById('recResult').textContent`));
  await a.evl(`(() => { const k = document.getElementById('recKind'); k.value = 'practice'; k.dispatchEvent(new Event('change')); })()`);
  chk('預覽之後又改了條件：確認鈕消失，要求重新預覽', await a.until(`!document.getElementById('recGo') && /重新預覽/.test(document.getElementById('recMsg').textContent)`, 3000));
  await a.click('#recPreview');
  chk('只選「句子練習」：句子 3、單字 0', await a.until(`/句子作答 3 筆、單字作答 0 筆/.test(document.getElementById('recResult').textContent)`, 5000));
  await a.click('#recGo');
  chk('第一次按：只是變成「再按一次」，資料還在', await a.evl(`/再按一次/.test(document.getElementById('recGo').textContent)`) && (await studentW()).sources.practice.total === 3);
  await a.click('#recGo');
  chk('第二次才刪：顯示已刪除與備份檔名', await a.until(`/已刪除：句子作答 3 筆/.test(document.getElementById('recResult').textContent) && /before-delete/.test(document.getElementById('recResult').textContent)`, 8000), await a.evl(`document.getElementById('recResult').textContent`));
  chk('刪除紀錄多了一列', await a.until(`document.querySelectorAll('#recAudit tbody tr').length === 1 && /句子練習/.test(document.getElementById('recAudit').textContent)`, 5000));
  chk('上面的學生統計跟著更新（句子面向沒了、單字還在）', await a.until(`!/五大句型/.test(document.getElementById('studCharts').textContent) && /最弱的單字/.test(document.getElementById('studCharts').textContent)`, 8000));
  chk('伺服器上句子練習紀錄真的沒了，單字的還在', (await studentW()).sources.practice.total === 0 && (await studentW()).sources.quiz.total === 3);

  section('費用與用量');
  await a.click('.tabs button[data-view="history"]');
  chk('費用與用量頁讀得到', await a.until(`!document.getElementById('view-history').hidden`));

  section('前台：老師也只看到前台');
  const f = await login(S.base, T, '/');
  chk('前台分頁：單字、句子、文章、測驗卷、弱點', await f.until(`document.body.dataset.app === 'front'`) && await visibleTabs(f) === '單字,句子,文章,測驗卷,弱點', await visibleTabs(f));
  chk('有「進入後台」連結，連到 /admin', await f.until(`getComputedStyle(document.getElementById('adminLink')).display !== 'none' && document.getElementById('adminLink').getAttribute('href') === '/admin'`));
  chk('前台沒有「新增字表」（那是後台的事）', !(await shown(f, '#wsNew')));

  section('學生打 /admin');
  const s = await openPage(S.base + '/', { width: 800, height: 700, settle: 2000 }); pages.push(s);
  await s.until(`!!document.getElementById('loginUser')`);
  await s.type('#loginUser', K.user); await s.type('#loginPass', K.pass); await s.click('#loginGo'); await s.wait(2500);
  chk('學生的前台沒有「進入後台」', !(await shown(s, '#adminLink')));
  const st = await s.evl(`fetch('/admin').then(async r => [r.status, await r.text()])`);
  chk('學生直接開 /admin → 403，只有老師能用', st[0] === 403 && /只有老師能用/.test(st[1]), JSON.stringify(st).slice(0, 80));

  section('其他');
  chk('後台沒有 JS 錯誤', a.errors.length === 0, a.errors.join(' | '));
  chk('前台沒有 JS 錯誤', f.errors.length === 0, f.errors.join(' | '));
  code = done();
} catch (e) {
  console.log('ERR', e.stack || e.message); code = 1;
} finally {
  for (const p of pages) try { p.close(); } catch {}
  process.exitCode = code;
  await shutdown().catch(() => {});
  try { rmSync(fx.dir, { recursive: true, force: true }); } catch {}
}
