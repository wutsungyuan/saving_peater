// 後台「考卷重現」畫面：選照片 → 辨識 → 草稿 → 逐題核對、編輯 → 發佈；學生前台看不到這個入口。假 CLI，不花額度。
// 跑法：node --no-warnings test/browser/exam-import-ui.mjs
import { start, shutdown } from '../api/_harness.mjs';
import { openPage, checker } from './_cdp.mjs';

const { chk, section, done } = checker();
const pages = []; let code = 1;
const today = (() => { const d = new Date(), p = n => String(n).padStart(2, '0'); return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`; })();
// 第 5 題故意給壞掉的資料：兩個空格但選項只有一組 → 要出現「請核對」
const FAKE = JSON.stringify({ questions: [
  { no: 1, stem: 'In _____, the weather is usually very cold.', options: ['spring', 'summer', 'autumn', 'winter'], answer: 3 },
  { no: 18, stem: 'Oh no, I forgot my _____. Can you _____ me one?', options: ['jacket; borrow', 'gloves; lend', 'camera; send', 'violin; teach'], answer: 1 },
  { no: 5, stem: 'A: I won the lottery(中樂透) yesterday! B: Really? Or are you _____?', options: ['making up my mind', 'signing up', 'missing out', 'pulling my leg'], answer: 3 },
  { no: 6, stem: 'Two ______ and ______ here.', options: ['one', 'two', 'three', 'four'], answer: 0 },
  { no: 7, stem: 'He is a good ______.', options: ['swimmer', 'underwater', 'guest', 'robot'], answer: 0 },
  { no: 8, stem: 'I ______ it.', options: ['like', 'likes', 'liking', 'liked'], answer: 0 },
] });

try {
  const S = await start('ui-exam-import', { AUTH_USER: 't1', AUTH_PASS: 'tpass-1', STUDENT_USER: 'k1', STUDENT_PASS: 'kpass-2', FAKE_EXAM_JSON: FAKE });
  const login = async (p, u, pw) => { await p.until(`!!document.getElementById('loginUser')`); await p.type('#loginUser', u); await p.type('#loginPass', pw); await p.click('#loginGo'); };

  section('老師：進後台 → 測驗卷 → 考卷重現');
  const page = await openPage(S.base + '/admin', { width: 1000, height: 1300, settle: 2500 }); pages.push(page);
  const { evl, until, click, type, shot } = page;
  await login(page, 't1', 'tpass-1');
  chk('登入後進到後台', await until(`document.body.dataset.app === 'admin' && document.body.dataset.role === 'teacher'`, 10000));
  await click('.tabs button[data-view="exam"]');
  chk('測驗卷裡有「考卷重現」子頁', await until(`!!document.querySelector('#pr-paper [data-pt="exam"]')`, 8000));
  await click('#pr-paper [data-pt="exam"]');
  chk('考卷重現畫面：名稱欄、選擇照片、說明「答案是模型猜的」，辨識鈕一開始不能按', await until(`!!document.getElementById('exTitle') && /答案是模型猜的/.test(document.getElementById('pr-paper').textContent) && document.getElementById('exGo').disabled`, 5000));
  chk('名稱欄的提示是預設名稱（日期＋考卷重現）', await evl(`document.getElementById('exTitle').placeholder.includes(${JSON.stringify(today + ' 考卷重現')})`));

  section('選照片 → 辨識 → 存成草稿');
  await evl(`(async () => {
    const c = document.createElement('canvas'); c.width = 600; c.height = 400; const x = c.getContext('2d'); x.fillStyle = '#fff'; x.fillRect(0, 0, 600, 400); x.fillStyle = '#000'; x.fillText('exam', 40, 40);
    const b = await new Promise(r => c.toBlob(r, 'image/png')); const dt = new DataTransfer(); dt.items.add(new File([b], 'exam-p1.png', { type: 'image/png' }));
    const f = document.getElementById('exFile'); f.files = dt.files; f.dispatchEvent(new Event('change', { bubbles: true })); return true; })()`);
  chk('選了照片：顯示檔名、辨識鈕可以按', await evl(`/exam-p1\\.png/.test(document.getElementById('exFiles').textContent) && !document.getElementById('exGo').disabled`));
  await click('#exGo');
  chk('辨識完：顯示已存成草稿、預設名稱、6 題、其中 1 題請核對', await until(`/已存成草稿/.test(document.getElementById('exResult').textContent) && document.getElementById('exResult').textContent.includes(${JSON.stringify(today + ' 考卷重現')}) && /6 題/.test(document.getElementById('exResult').textContent) && /1 題請核對/.test(document.getElementById('exResult').textContent)`, 15000));
  chk('有「打開草稿核對」與「把完整句子帶到分析頁」', await evl(`!!document.querySelector('[data-exam="open"]') && !!document.querySelector('[data-exam="analyze"]')`));
  await shot('exam-import-result.png');

  section('打開草稿逐題核對');
  await click('[data-exam="open"]');
  chk('編修畫面：6 題、卷子名稱是預設名稱、標示草稿與「考卷重現」', await until(`document.querySelectorAll('.pa-q').length === 6 && document.getElementById('paTitle').value === ${JSON.stringify(today + ' 考卷重現')} && /草稿/.test(document.querySelector('.pa-head').textContent) && /考卷重現/.test(document.querySelector('.pa-head').textContent)`, 8000));
  chk('每題標「原卷第 N 題」', await evl(`[...document.querySelectorAll('.pa-q')].map(q => (q.textContent.match(/原卷第 (\\d+) 題/) || [])[1]).join() === '1,18,5,6,7,8'`));
  chk('第 18 題：兩個空格都在、四個成對選項、正確選項標勾', await evl(`(() => { const q = document.getElementById('pq-q2'); return (q.querySelector('.q-sent').textContent.match(/______/g) || []).length === 2 && q.querySelectorAll('.pa-choices li').length === 4 && q.querySelector('.pa-choices li.ok').textContent === 'gloves; lend'; })()`));
  chk('壞掉的第 6 題：顯示「請核對」警告', await evl(`/請核對/.test(document.getElementById('pq-q4').textContent) && !/請核對/.test(document.getElementById('pq-q1').textContent)`));
  chk('滿分 100 分（6 題：16.5 × 4 ＋ 17 × 2 之類，合計 100）', await evl(`[...document.querySelectorAll('.pa-q .p-pts')].reduce((a, e) => a + parseFloat(e.textContent), 0) === 100`));
  chk('考卷重現的題沒有「換一題」', await evl(`!document.querySelector('[data-ped="swap"]:not([hidden])')`));
  await shot('exam-import-draft.png');

  section('編輯第 6 題（修正壞掉的題）');
  await click('[data-ped="edit-open"][data-qid="q4"]');
  chk('出現編輯表單：題幹、4 個選項、單選鈕', await until(`!!document.getElementById('peStem') && document.querySelectorAll('.pe-opt').length === 4 && document.querySelectorAll('input[name="peAns"]').length === 4`, 3000));
  await type('#peStem', 'Two ______ and ______ here.');
  await evl(`(() => { const o = document.querySelectorAll('.pe-opt'); [['apples; pears'], ['dogs; cats'], ['men; women'], ['x']].forEach((v, i) => { o[i].value = v[0]; }); document.querySelectorAll('input[name="peAns"]')[1].checked = true; return true; })()`);
  await click('[data-ped="edit-save"]');
  chk('儲存後：回到卡片、警告消失、答案是第二個選項', await until(`!document.getElementById('peStem') && !/請核對/.test(document.getElementById('pq-q4').textContent) && document.querySelector('#pq-q4 .pa-choices li.ok')?.textContent === 'dogs; cats'`, 5000));
  chk('提示已儲存這一題', await evl(`/已儲存這一題/.test(document.getElementById('paMsg').textContent)`));
  await click('[data-ped="edit-open"][data-qid="q4"]'); await until(`!!document.getElementById('peStem')`);
  await type('#peStem', 'No blank in the stem.');
  await click('[data-ped="edit-save"]');
  chk('題幹沒有空格：表單留著並說明原因', await until(`!!document.getElementById('peStem') && /要有空格/.test(document.getElementById('peMsg').textContent)`, 5000));
  await click('[data-ped="edit-cancel"]');
  chk('取消：回到卡片，內容沒被改', await until(`!document.getElementById('peStem') && /Two/.test(document.getElementById('pq-q4').textContent)`, 3000));

  section('改名、發佈');
  await type('#paTitle', '第三次段考 Unit1-3');
  await click('[data-ped="rename"]');
  chk('改名', await until(`/已儲存名稱/.test(document.getElementById('paMsg').textContent)`, 5000));
  await click('[data-ped="publish"]');
  chk('發佈', await until(`/已發佈/.test(document.getElementById('paMsg').textContent)`, 5000));
  chk('已發佈：沒有編輯按鈕（要先收回）', await evl(`!document.querySelector('[data-ped="edit-open"]')`));

  section('帶到分析頁');
  await click('#pr-paper [data-pt="exam"]');
  await until(`!!document.getElementById('exResult')`);
  chk('回到考卷重現頁，上一份的結果還在', await evl(`/已存成草稿/.test(document.getElementById('exResult').textContent)`));
  await click('[data-exam="analyze"]');
  chk('切到句子分析頁，輸入框是填好答案的完整句子（沒有 A: B:、沒有中文註解）', await until(`document.body.dataset.view === 'sentence' || !!document.querySelector('#view-sentence:not([hidden])')`, 5000) && await evl(`(() => { const v = document.getElementById('inp').value; return v.includes('I won the lottery yesterday!') && v.includes('Can you lend me one?') && !/A:|B:|中樂透/.test(v); })()`));

  section('學生前台：看到發佈的卷子，沒有重現入口');
  const st = await openPage(S.base + '/', { width: 420, height: 800, settle: 2500 }); pages.push(st);
  await login(st, 'k1', 'kpass-2');
  chk('學生登入', await st.until(`document.body.dataset.role === 'student'`, 10000));
  await st.click('.tabs button[data-view="exam"]');
  chk('學生的測驗卷：看得到發佈的卷子與名稱', await st.until(`/第三次段考 Unit1-3/.test(document.getElementById('pr-paper').textContent)`, 8000));
  chk('學生看不到「考卷重現」入口（沒有這個按鈕，或按鈕是隱藏的）', await st.evl(`(() => { const b = document.querySelector('#pr-paper [data-pt="exam"]'); return !b || b.offsetParent === null; })()`));
  chk('學生的歷史只有發佈的 1 份，沒有草稿', await st.evl(`fetch('/api/papers').then(r => r.json()).then(j => j.papers.length === 1 && j.papers[0].status === 'open')`));

  section('歷史：再考一次、釘選（老師後台）');
  const pubId = await page.evl(`fetch('/api/papers').then(r => r.json()).then(j => j.papers.find(p => p.status === 'open').id)`);
  await page.evl(`fetch('/api/paper-submit', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ id: ${JSON.stringify(pubId)}, answers: {} }) }).then(r => r.status)`);
  await click('.tabs button[data-view="exam"]');
  await until(`!!document.querySelector('#pr-paper [data-pt="history"]')`, 8000);
  await click('#pr-paper [data-pt="history"]');
  chk('已交卷的主測驗有「再考一次」與「釘選」；還沒交卷的沒有再考', await until(`!!document.querySelector('[data-retake="${pubId}"]') && !!document.querySelector('[data-pin="${pubId}"]') && document.querySelectorAll('[data-retake]').length === 1`, 8000));
  await click(`[data-retake="${pubId}"]`);
  chk('第一次按：只是要求再按一次確認，還沒發佈', await evl(`/再按一次/.test(document.querySelector('[data-retake="${pubId}"]').textContent)`) && await evl(`fetch('/api/papers').then(r => r.json()).then(j => j.papers.filter(p => p.retakeOf).length === 0)`));
  await click(`[data-retake="${pubId}"]`);
  chk('再按一次：發佈，出現說明訊息與「（重考 1）」那一列', await until(`/已發佈「.*（重考 1）」/.test(document.getElementById('pHistMsg').textContent) && /（重考 1）/.test(document.getElementById('pr-paper').textContent)`, 8000));
  await click(`[data-pin="${pubId}"]`);
  chk('釘選：出現「📌 釘選」標記，按鈕變成「取消釘選」', await until(`/📌 釘選/.test(document.getElementById('pr-paper').textContent) && /取消釘選/.test(document.querySelector('[data-pin="${pubId}"]').textContent)`, 8000));
  await click(`[data-pin="${pubId}"]`);
  chk('取消釘選：標記消失', await until(`!/📌 釘選/.test(document.getElementById('pr-paper').textContent)`, 8000));

  section('手機尺寸：考卷重現的名稱欄不會把整頁撐寬');
  const mb = await openPage(S.base + '/admin', { width: 390, height: 844, mobile: true, settle: 2500 }); pages.push(mb);
  await login(mb, 't1', 'tpass-1');
  await mb.until(`document.body.dataset.app === 'admin'`, 10000);
  await mb.until(`(() => { if (document.body.dataset.view !== 'exam') document.querySelector('.tabs button[data-view="exam"]')?.click(); const b = document.querySelector('#pr-paper [data-pt="exam"]'); if (b) b.click(); return !!document.getElementById('exTitle'); })()`, 10000);
  chk('名稱欄在畫面內、整頁沒有橫向撐開', await mb.until(`!!document.getElementById('exTitle') && document.getElementById('exTitle').getBoundingClientRect().right <= document.getElementById('exTitle').closest('.box').getBoundingClientRect().right + 0.5 && document.documentElement.scrollWidth <= innerWidth`, 8000), JSON.stringify(await mb.evl(`({ txt: document.getElementById('pr-paper')?.textContent.slice(0, 80), view: document.body.dataset.view, right: document.getElementById('exTitle')?.getBoundingClientRect().right, sw: document.documentElement.scrollWidth, w: innerWidth })`)));

  section('老師登入前台：草稿不能在前台作答（不然交卷會被擋、顯示「還沒發佈」）');
  const tf = await openPage(S.base + '/', { width: 420, height: 800, settle: 2500 }); pages.push(tf);
  await login(tf, 't1', 'tpass-1');
  chk('老師登入前台', await tf.until(`document.body.dataset.role === 'teacher' && document.body.dataset.app !== 'admin'`, 10000));
  const png = 'data:image/png;base64,' + Buffer.concat([Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]), Buffer.alloc(200)]).toString('base64');
  chk('先用 API 再存一份草稿', await tf.evl(`fetch('/api/exam-import', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ images: [${JSON.stringify(png)}] }) }).then(r => r.json()).then(j => j.ok === true)`));
  chk('伺服器那邊確實有草稿', await tf.evl(`fetch('/api/papers').then(r => r.json()).then(j => j.papers.some(p => p.status === 'draft'))`));
  await tf.click('.tabs button[data-view="exam"]');
  await tf.until(`!!document.querySelector('#pr-paper [data-pt="history"]')`, 8000);
  await tf.click('#pr-paper [data-pt="history"]');
  chk('前台歷史：看得到發佈的卷子，沒有草稿、沒有「編輯／發佈」', await tf.until(`/第三次段考 Unit1-3/.test(document.getElementById('pr-paper').textContent) && !/草稿/.test(document.getElementById('pr-paper').textContent) && !document.querySelector('[data-pub]')`, 8000));
  chk('沒有 JS 錯誤', page.errors.length === 0 && st.errors.length === 0 && tf.errors.length === 0 && mb.errors.length === 0, [...page.errors, ...st.errors, ...tf.errors, ...mb.errors].join(' | '));
  code = done();
} catch (e) {
  console.log('ERR', e.stack || e.message); code = 1;
} finally {
  for (const p of pages) try { p.close(); } catch {}
  process.exitCode = code;
  await shutdown().catch(() => {});
}
