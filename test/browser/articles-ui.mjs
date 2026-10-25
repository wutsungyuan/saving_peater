// 文章表的畫面流程：自己開接假 CLI 的伺服器（不花額度），在真的 Chrome 裡走一遍。
//   輸入 → 填文章名稱 → 報價與確認 → 分析 → 存成文章表 → 清單 → 檢視 → 標單字 → 展開分析 → 改名 → 刪除
// 跑法：node --no-warnings test/browser/articles-ui.mjs   （不需要先開伺服器）
import { start, shutdown } from '../api/_harness.mjs';
import { openPage, checker } from './_cdp.mjs';

const { chk, section, done } = checker();
let page, code = 1;
try {
  const S = await start('ui-articles', { ANALYZE_GROUP: '1' });                               // 沒設 AUTH_TOKEN：頁面不需要 token
  // 先建一份字表，之後檢視文章表時標單字用
  await S.j('/api/wordsets', { method: 'POST', body: { name: '字表一', text: 'breakfast, 早餐\nschool, 學校' } });
  const base = S.calls().length;                                      // 建字表那次也算一次呼叫，之後的計數都相對於它

  page = await openPage(S.base + '/', { width: 1000, height: 1100, settle: 2500 });
  const { evl, until, click, type, wait } = page;
  await click('.tabs button[data-view="sentence"]');
  await wait(300);

  section('句子頁與文章頁');
  chk('前台的頂層分頁：單字／句子／文章／測驗卷／弱點', await evl(`[...document.querySelectorAll('.tabs button')].filter(b => getComputedStyle(b).display !== 'none').map(b => b.innerText.trim()).join() === '單字,句子,文章,測驗卷,弱點'`));
  chk('句子頁有「句子分析／句子練習」兩個子頁', await evl(`[...document.querySelectorAll('#snTabs button')].map(b => b.textContent.trim()).join() === '句子分析,句子練習'`));
  chk('句子分析：有「範圍（選填）」欄，按鈕仍是「分析」', await evl(`!document.getElementById('artNameRow').hidden && document.getElementById('artNameLbl').textContent.includes('範圍') && document.getElementById('go').textContent.trim() === '分析'`));
  await click('.tabs button[data-view="article"]');
  chk('文章頁有「文章表／新增文章」兩個子頁', await evl(`[...document.querySelectorAll('#arTabs button')].map(b => b.textContent.trim()).join() === '文章表,新增文章'`));
  await click('#arTabs button[data-ap="new"]');
  await wait(200);
  chk('新增文章：輸入框搬過來，有文章名稱欄，按鈕是「分析並存成文章」', await evl(`!document.getElementById('artNameRow').hidden && !!document.querySelector('#ar-new #inp') && document.getElementById('go').textContent.trim() === '分析並存成文章'`));
  chk('新增文章沒有範例句標籤', await evl(`document.querySelector('#ar-new .chips-group').hidden`));
  await type('#inp', 'Hello there.');
  await click('#go');
  chk('沒填文章名稱就按分析：提示先填名稱，不呼叫模型', await evl(`/請先填文章名稱/.test(document.getElementById('inp-hint').textContent)`) && S.calls().length === base);
  await type('#artName', '課文A');
  chk('填了名稱：提示會建立新的', await evl(`document.getElementById('go').textContent.includes('存成文章') && document.getElementById('artDest').textContent.includes('建立新的文章表')`));

  section('報價與確認');
  const text = 'I get up at seven. I eat breakfast.\\n\\nThen I go to school. School is fun.';
  await type('#inp', text.replace(/\\n/g, '\n'));
  await click('#go');
  chk('先顯示報價與確認按鈕，還沒呼叫模型', await until(`!document.getElementById('artConfirm').hidden && !!document.getElementById('artGo')`) && S.calls().length === base, JSON.stringify(S.calls()));
  chk('報價寫明句數、已快取、預估花費與時間', await evl(`/4 句要請模型分析/.test(document.getElementById('artConfirm').textContent) && /預估花費 \\$\\d/.test(document.getElementById('artConfirm').textContent) && /分鐘/.test(document.getElementById('artConfirm').textContent)`), await evl(`document.getElementById('artConfirm').textContent`));
  await click('#artNo');
  chk('取消：沒有呼叫模型', S.calls().length === base && await evl(`/沒有呼叫模型/.test(document.getElementById('inp-hint').textContent)`));
  await click('#go');
  await until(`!!document.getElementById('artGo')`);

  section('分析並存檔');
  await click('#artGo');
  chk('分析完成後顯示「已存成文章表」', await until(`/已存成文章表「課文A」：新增 4 句/.test(document.getElementById('inp-hint').textContent)`, 20000), await evl(`document.getElementById('inp-hint').textContent`));
  chk('模型被呼叫 4 次（每句一次）', S.calls().length === base + 4, JSON.stringify(S.calls().length));
  chk('分析結果有顯示在下方', await evl(`document.querySelectorAll('#out article.sent').length === 4`));
  const saved = (await S.j('/api/articles')).json.articles;
  chk('後端真的有這份文章表（4 句、2 段）', saved.length === 1 && saved[0].sentences === 4 && saved[0].paragraphs === 2, JSON.stringify(saved));
  chk('名稱欄的下拉選單有這份', await evl(`[...document.querySelectorAll('#artNames option')].some(o => o.value === '課文A')`));

  section('同名再存一次 → 附加');
  await type('#inp', 'Tonight I read a book. School is fun.');
  chk('提示會附加到既有的文章表', await evl(`/會附加到文章表「課文A」/.test(document.getElementById('artDest').textContent)`));
  await click('#go');
  await until(`!!document.getElementById('artGo')`);
  chk('只有 1 句新的要分析（重複的不收費）', await evl(`/1 句要請模型分析/.test(document.getElementById('artConfirm').textContent)`), await evl(`document.getElementById('artConfirm').textContent`));
  await click('#artGo');
  chk('附加成功、略過重複的 1 句', await until(`/已附加到文章表「課文A」：新增 1 句（略過重複的 1 句），共 5 句/.test(document.getElementById('inp-hint').textContent)`, 20000), await evl(`document.getElementById('inp-hint').textContent`));

  section('全部分析過 → 不報價直接存');
  await type('#artName', '課文B');
  await type('#inp', 'I get up at seven.');
  await click('#go');
  chk('全部已分析過：直接存成文章表，不跳確認', await until(`/已存成文章表「課文B」/.test(document.getElementById('inp-hint').textContent)`, 8000) && S.calls().length === base + 5, `calls=${S.calls().length - base}`);

  section('文章表清單與檢視');
  await click('#arTabs button[data-ap="articles"]');
  chk('清單列出兩份', await until(`document.querySelectorAll('#artList .art-card').length === 2`));
  await evl(`[...document.querySelectorAll('#artList .art-card')].find(c => c.textContent.includes('課文A')).click()`);
  chk('檢視：依段落顯示、有翻譯', await until(`document.querySelectorAll('#artBody .art-para').length === 3 && !!document.querySelector('#artBody .art-zh')`) && await evl(`document.getElementById('artTitle').textContent === '課文A'`));
  await evl(`(() => { const s = document.getElementById('artSets'); s.value = s.options[1].value; s.dispatchEvent(new Event('change')); })()`);
  chk('標出單字表的字（breakfast、school 有標記）', await until(`document.querySelectorAll('#artBody mark.sw').length >= 2`) && await evl(`/用到 2 個/.test(document.getElementById('artCover').textContent)`), await evl(`document.getElementById('artCover').textContent`));
  await click('#artBody .art-more');
  chk('展開分析：顯示句子卡片', await until(`!!document.querySelector('#artBody .art-detail:not([hidden]) article.sent')`));
  await evl(`document.querySelector('#artBody .art-detail .w').dispatchEvent(new PointerEvent('pointerover', { bubbles: true }))`);
  chk('文章表展開的分析卡：游標移到（手機按住）單字會跳出詞性提示', await until(`document.getElementById('tip').dataset.show === '1' && document.querySelector('#tip .t-word').textContent.length > 0 && document.querySelector('#tip .t-k').textContent.length > 0`), await evl(`document.getElementById('tip').innerText`));
  await evl(`document.getElementById('artBody').dispatchEvent(new PointerEvent('pointerleave'))`);
  chk('離開單字後提示收起來', await until(`document.getElementById('tip').dataset.show === '0'`));
  await click('#artBody .art-detail .more');
  chk('展開後的「詳解」按鈕有反應（點了會展開詳細說明）', await until(`document.querySelector('#artBody .art-detail .more').getAttribute('aria-expanded') === 'true' && !document.querySelector('#artBody .art-detail .more').nextElementSibling.hidden`));
  await click('#artBody .art-detail .more');
  chk('再點一次收起', await until(`document.querySelector('#artBody .art-detail .more').getAttribute('aria-expanded') === 'false'`));
  chk('「朗讀」按鈕有接上（點了不會出錯）', await evl(`(() => { const b = document.querySelector('#artBody .art-detail .say'); if (!b) return true; b.click(); return true; })()`) && page.errors.length === 0, page.errors.join(' | '));

  section('改名與刪除');
  await click('#artRename');
  chk('按「改名」：輸入框真的出現在畫面上（不只是存在於網頁裡）', await evl(`(() => { const e = document.getElementById('artNewName'); return !!e && e.offsetParent !== null && e.getBoundingClientRect().height > 0; })()`));
  await type('#artNewName', '第一課');
  await click('#artRenameOk');
  chk('改名後標題更新', await until(`document.getElementById('artTitle').textContent === '第一課'`));
  await click('#artDelete');
  chk('刪除要按兩次（第一次只是確認）', await evl(`document.getElementById('artDelete').dataset.armed === '1'`) && (await S.j('/api/articles')).json.articles.length === 2);
  await click('#artDelete');
  chk('第二次才真的刪除，回到清單', await until(`document.querySelectorAll('#artList .art-card').length === 1`) && (await S.j('/api/articles')).json.articles.length === 1);

  section('其他');
  chk('沒有 JS 錯誤', page.errors.length === 0, page.errors.join(' | '));
  await page.shot('articles-ui.png');

  section('對話：同一個人說的話框成一組');
  const p4 = await openPage(S.base + '/', { width: 420, height: 900, settle: 2500 });
  await p4.click('.tabs button[data-view="sentence"]'); await p4.wait(300);
  await p4.type('#inp', 'Jamie: Great. And here is a picture of me.\nZac: Wow! You have a snowboard?');
  await p4.click('#go');
  chk('分析後出現 2 組（Jamie、Zac），每組 2 張卡', await p4.until(`document.querySelectorAll('#out .turn-group').length === 2 && [...document.querySelectorAll('#out .turn-group')].every(g => g.querySelectorAll('article.sent').length === 2)`, 20000), await p4.evl(`document.getElementById('out').innerText.slice(0, 200)`));
  chk('每組上面有說話者與整段原文', await p4.evl(`(() => { const g = document.querySelectorAll('#out .turn-group'); return g[0].querySelector('.who').textContent === 'Jamie' && g[1].querySelector('.turn-en').textContent === 'Wow! You have a snowboard?'; })()`), await p4.evl(`document.querySelector('#out .turn-group').innerText`));
  p4.close();

  section('句子分析歸進範圍，句子練習可以選範圍');
  const bucket = await evl(`dailyBucketName()`);
  chk('剛才那次沒填範圍的分析，自動歸入當天的「句子 月/日」', /^句子 \d+\/\d+$/.test(bucket) && (await S.j('/api/articles')).json.articles.some(a => a.name === bucket && a.sentences === 4), JSON.stringify((await S.j('/api/articles')).json.articles));
  const p7 = await openPage(S.base + '/', { width: 1000, height: 1100, settle: 2500 });
  await p7.click('.tabs button[data-view="sentence"]'); await p7.wait(300);
  chk('句子分析：範圍欄的提示說明不填會歸入哪一份', await p7.evl(`document.getElementById('artName').placeholder.includes('${bucket}')`));
  await p7.type('#artName', '我的範圍');
  await p7.type('#inp', 'The dog runs fast.');
  await p7.click('#go');
  chk('填了範圍：走報價確認流程（和新增文章一樣）', await p7.until(`!!document.getElementById('artGo')`, 8000));
  await p7.click('#artGo');
  chk('分析後存進「我的範圍」', await p7.until(`/已存成文章表「我的範圍」：新增 1 句/.test(document.getElementById('inp-hint').textContent)`, 20000), await p7.evl(`document.getElementById('inp-hint').textContent`));
  await p7.type('#artName', '');
  await p7.type('#inp', 'The cat sleeps all day.');
  await p7.click('#go');
  chk('沒填範圍：直接分析，並提示歸入當天的範圍', await p7.until(`new RegExp('已歸入範圍「${bucket}」').test(document.getElementById('inp-hint').textContent)`, 20000), await p7.evl(`document.getElementById('inp-hint').textContent`));
  await p7.click('#snTabs button[data-sp="practice"]');
  chk('句子練習：列出範圍（文章表）可選，預設一個都不選', await p7.until(`document.querySelectorAll('#qscope .tchip').length >= 2 && !document.querySelector('#qscope .tchip[aria-pressed="true"]')`, 8000), await p7.evl(`document.getElementById('qscope').innerText`));
  await p7.evl(`[...document.querySelectorAll('#qscope .tchip')].find(b => b.textContent.includes('我的範圍')).click()`);
  chk('點一下選取，再點取消', await p7.evl(`document.querySelectorAll('#qscope .tchip[aria-pressed="true"]').length === 1`));
  await p7.click('#quizStart');
  chk('選了範圍出題：提示寫出範圍名稱', await p7.until(`/範圍「我的範圍」有 \\d+ 句可出題/.test(document.getElementById('quizHint').textContent)`, 8000), await p7.evl(`document.getElementById('quizHint').textContent`));
  chk('練習頁沒有 JS 錯誤', p7.errors.length === 0, p7.errors.join(' | '));
  p7.close();

  section('沒帶存取碼：出現輸入框，輸入後可用');
  const S3 = await start('ui-token', { AUTH_TOKEN: 'secret123' });
  const p3 = await openPage(S3.base + '/', { width: 420, height: 900, settle: 2500 });
  chk('沒有存取碼：頁面最上面出現輸入框', await p3.until(`!!document.getElementById('tokenBanner') && !document.getElementById('tokenBanner').hidden`), await p3.evl(`document.body.innerText.slice(0, 80)`));
  await p3.type('#tokenInput', 'secret123');
  await p3.click('#tokenSave');
  await p3.wait(2500);
  chk('輸入後重新載入：輸入框消失、存取碼被記住', await p3.evl(`!document.getElementById('tokenBanner') && localStorage.getItem('analyzer-token') === 'secret123'`));
  chk('之後的請求有帶存取碼（提示變成已連上）', await p3.until(`/已連上分析後端/.test(document.getElementById('inp-hint').textContent)`));
  await p3.evl(`fetch('/api/stats').then(r => { window.__st = r.status; })`);
  chk('頁面自己發的 /api/ 請求會自動帶存取碼（唯讀 API 也要驗證）', await p3.until(`window.__st === 200`));
  await p3.click('.tabs button[data-view="history"]'); await p3.wait(800);
  chk('歷史頁讀得到資料、沒有跳出輸入框', await p3.evl(`!document.getElementById('tokenBanner') && document.getElementById('view-history') && !document.getElementById('view-history').hidden`));
  p3.close();
  const p5 = await openPage(S3.base + '/', { width: 420, height: 900, settle: 2000 });      // 另一個沒存過存取碼的瀏覽器
  await p5.evl(`localStorage.clear()`); await p5.send('Page.reload'); await p5.wait(2500);
  await p5.evl(`fetch('/api/history').then(r => { window.__h = r.status; })`);
  chk('沒帶存取碼讀歷史 → 401，並跳出輸入框', await p5.until(`window.__h === 401 && !!document.getElementById('tokenBanner') && !document.getElementById('tokenBanner').hidden`));
  p5.close();

  section('帳號密碼登入');
  const S6 = await start('ui-login', { AUTH_USER: 'yuan', AUTH_PASS: 'pw-123' });
  const p6 = await openPage(S6.base + '/', { width: 420, height: 900, settle: 2500 });
  chk('沒登入：最上面出現帳號、密碼欄與登入鈕', await p6.until(`!!document.getElementById('loginUser') && document.getElementById('loginPass').type === 'password' && !!document.getElementById('loginGo')`), await p6.evl(`document.body.innerText.slice(0, 60)`));
  chk('密碼欄有 autocomplete=current-password（密碼管理員、手機鍵盤可以帶入）', await p6.evl(`document.getElementById('loginPass').autocomplete === 'current-password' && document.getElementById('loginUser').autocomplete === 'username'`));
  await p6.type('#loginUser', 'yuan'); await p6.type('#loginPass', 'wrong');
  await p6.click('#loginGo');
  chk('密碼錯：顯示「帳號或密碼不對」，仍停在登入框', await p6.until(`/帳號或密碼不對/.test(document.querySelector('#tokenBanner .tb-msg').textContent)`));
  await p6.type('#loginPass', 'pw-123');
  await p6.click('#loginGo');
  await p6.wait(2500);
  chk('登入成功：登入框消失、出現「登出」', await p6.evl(`!document.getElementById('tokenBanner') && !document.getElementById('logoutBtn').hidden`));
  await p6.evl(`fetch('/api/history').then(r => { window.__lh = r.status; })`);
  chk('登入後讀得到歷史（cookie 自動帶上，不必每個頁面處理）', await p6.until(`window.__lh === 200`));
  await p6.send('Page.reload'); await p6.wait(2500);
  chk('重新整理仍是登入狀態', await p6.evl(`!document.getElementById('tokenBanner') && !document.getElementById('logoutBtn').hidden`));
  await p6.click('#logoutBtn'); await p6.wait(2500);
  chk('登出後回到登入框', await p6.until(`!!document.getElementById('loginUser')`));
  p6.close();

  section('分析中：明顯提示不要離開；中途離開 → 下次提示接續');
  const S2 = await start('ui-articles-slow', { FAKE_DELAY_MS: '1500' });
  const p2 = await openPage(S2.base + '/', { width: 1000, height: 1100, settle: 2500 });
  await p2.click('.tabs button[data-view="article"]'); await p2.click('#arTabs button[data-ap="new"]'); await p2.wait(300);
  await p2.type('#inp', 'I like tea. We eat lunch. They read books. She sings well.');
  await p2.type('#artName', '離開測試');
  await p2.click('#go');
  await p2.until(`!!document.getElementById('artGo')`);
  await p2.click('#artGo');
  chk('輸入框上蓋著「文章分析中，請不要離開」', await p2.until(`!document.getElementById('anBusy').hidden && /請不要離開/.test(document.getElementById('anBusyMain').textContent)`), await p2.evl(`document.getElementById('anBusyMain').textContent`));
  chk('記下「分析未完成」', await p2.evl(`!!localStorage.getItem('analyzer-art-pending')`));
  await p2.send('Page.reload'); await p2.wait(2500);
  await p2.click('.tabs button[data-view="article"]');
  chk('重新整理（離開）後進文章頁：直接停在「新增文章」，提示「上次分析沒有完成」與「按此繼續」', await p2.until(`!document.getElementById('artConfirm').hidden && /沒有完成/.test(document.getElementById('artConfirm').textContent) && !!document.getElementById('artResume')`), await p2.evl(`document.getElementById('artConfirm').textContent`));
  await p2.click('.tabs button[data-view="article"]'); await p2.click('#arTabs button[data-ap="new"]');
  await p2.click('#artResume');
  chk('按「按此繼續」：文字與名稱帶回來（還有句子沒分析就先給報價；伺服器已跑完就直接存）', await p2.until(`(!!document.getElementById('artGo') || /已存成文章表/.test(document.getElementById('inp-hint').textContent)) && document.getElementById('artName').value === '離開測試' && /tea/.test(document.getElementById('inp').value)`), await p2.evl(`document.getElementById('inp-hint').textContent + '|' + document.getElementById('artName').value + '|' + document.getElementById('inp').value.slice(0,30)`));
  if (await p2.evl(`!!document.getElementById('artGo') && !document.getElementById('artConfirm').hidden`)) await p2.click('#artGo');
  chk('跑完存成文章表後，未完成的記號清掉', await p2.until(`/已存成文章表/.test(document.getElementById('inp-hint').textContent) && !localStorage.getItem('analyzer-art-pending')`, 30000), await p2.evl(`document.getElementById('inp-hint').textContent`));
  chk('分析結束後蓋板拿掉', await p2.evl(`document.getElementById('anBusy').hidden`));
  p2.close();
  code = done();
} catch (e) {
  console.log('ERR', e.stack || e.message); code = 1;
} finally {
  try { page?.close(); } catch {}
  // finish() 會 process.exit，所以把結果碼先存好
  const c = code;
  process.exitCode = c;
  await shutdown().catch(() => {});
}
