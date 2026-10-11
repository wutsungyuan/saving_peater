// 登入畫面：整頁蓋住（背後的畫面看不到也點不到）、錯誤紅字、顯示密碼、打到一半不會被清掉、手機寬度排得下、登入後進入。
// 自己開接假 CLI 的伺服器，不花額度。跑法：node --no-warnings test/browser/login-ui.mjs
import { start, shutdown } from '../api/_harness.mjs';
import { openPage, checker } from './_cdp.mjs';

const { chk, section, done } = checker();
let pages = [], code = 1;
try {
  const S = await start('ui-login-screen', { AUTH_USER: 'teacher1', AUTH_PASS: 'tpass-1', STUDENT_USER: 'kid1', STUDENT_PASS: 'kpass-2' });

  section('桌機');
  const p = await openPage(S.base + '/', { width: 1100, height: 700, settle: 2500 }); pages.push(p);
  const { evl, until, click, type, wait } = p;
  chk('沒登入：出現登入畫面', await until(`!!document.getElementById('loginUser') && !!document.querySelector('.login-screen')`));
  chk('整頁蓋住（涵蓋整個視窗）', await evl(`(() => { const r = document.querySelector('.login-screen').getBoundingClientRect(); return r.left === 0 && r.top === 0 && r.width === innerWidth && r.height === innerHeight && getComputedStyle(document.querySelector('.login-screen')).position === 'fixed'; })()`));
  chk('卡片有標題、帳號、密碼欄、顯示密碼、登入鈕', await evl(`!!document.querySelector('.login-card h1') && !!document.querySelector('label[for="loginUser"]') && !!document.querySelector('label[for="loginPass"]') && !!document.getElementById('loginShow') && !!document.getElementById('loginGo')`));
  chk('畫面正中央點到的是登入卡片，不是背後的頁面', await evl(`!!document.elementFromPoint(innerWidth / 2, innerHeight / 2).closest('.login-screen')`));
  chk('背後的畫面被標成不可操作（inert），鍵盤跳不進去', await evl(`document.querySelector('.page').inert === true`));
  chk('背後沒有「載入失敗」之類的錯誤字', !(await evl(`/載入失敗|Cannot read/.test(document.getElementById('wsList')?.innerText || '')`)));
  chk('一進來游標就在帳號欄', await evl(`document.activeElement.id === 'loginUser'`));
  chk('欄位用 autocomplete（密碼管理員與手機鍵盤可以帶入）', await evl(`document.getElementById('loginUser').autocomplete === 'username' && document.getElementById('loginPass').autocomplete === 'current-password'`));

  section('輸入與錯誤');
  await type('#loginUser', 'teacher1'); await type('#loginPass', 'wrong');
  // 同時有別的請求收到 401 → 登入畫面不能被重建，打到一半的內容要還在
  await evl(`fetch('/api/stats'); fetch('/api/wordsets?user=x');`); await wait(800);
  chk('同時有別的請求被擋（401）：打到一半的帳號密碼還在', await evl(`document.getElementById('loginUser').value === 'teacher1' && document.getElementById('loginPass').value === 'wrong'`));
  chk('只有一個登入畫面（沒有重複出現）', await evl(`document.querySelectorAll('.login-screen').length === 1`));
  await click('#loginShow');
  chk('「顯示密碼」：密碼欄變成明碼', await evl(`document.getElementById('loginPass').type === 'text'`));
  await click('#loginShow');
  chk('再按一次：變回隱藏', await evl(`document.getElementById('loginPass').type === 'password'`));
  await click('#loginGo');
  chk('密碼錯：紅字「帳號或密碼不對」', await until(`document.querySelector('.login-screen').classList.contains('err') && /帳號或密碼不對/.test(document.querySelector('.tb-msg').textContent)`, 5000) && await evl(`getComputedStyle(document.querySelector('.tb-msg')).color.replace(/\\s/g, '') === 'rgb(168,42,30)'`));
  chk('密碼錯後：帳號保留、密碼被選取方便重打、按鈕可以再按', await evl(`document.getElementById('loginUser').value === 'teacher1' && !document.getElementById('loginGo').disabled`));

  section('登入成功');
  await type('#loginPass', 'tpass-1');
  await click('#loginGo');
  chk('登入成功：登入畫面消失、進到主畫面', await until(`!document.querySelector('.login-screen') && document.body.dataset.role === 'teacher' && document.querySelector('.page').inert !== true`, 10000));
  chk('登入後單字頁正常（沒有載入失敗）', await until(`document.querySelectorAll('#wsList button, #wsList .hint').length > 0 && !/載入失敗/.test(document.getElementById('wsList').innerText)`, 8000));
  chk('桌機：沒有 JS 錯誤', p.errors.length === 0, p.errors.join(' | '));

  section('手機寬度（390px）');
  const m = await openPage(S.base + '/', { width: 390, height: 760, settle: 2500 }); pages.push(m);
  chk('手機：登入畫面出現', await m.until(`!!document.getElementById('loginUser')`));
  chk('卡片完整排在畫面內，沒有橫向捲動', await m.evl(`(() => { const r = document.querySelector('.login-card').getBoundingClientRect(); return r.left >= 0 && r.right <= innerWidth && document.documentElement.scrollWidth <= innerWidth; })()`));
  chk('輸入框字級 16px（iPhone 才不會自動放大整頁）', await m.evl(`parseFloat(getComputedStyle(document.getElementById('loginUser')).fontSize) >= 16 && parseFloat(getComputedStyle(document.getElementById('loginPass')).fontSize) >= 16`));
  chk('按鈕夠大（高度 ≥ 40px）', await m.evl(`document.getElementById('loginGo').getBoundingClientRect().height >= 40`));
  await m.type('#loginUser', 'kid1'); await m.type('#loginPass', 'kpass-2'); await m.click('#loginGo');
  chk('學生登入：進到前台，角色是學生', await m.until(`!document.querySelector('.login-screen') && document.body.dataset.role === 'student'`, 10000));
  chk('手機：沒有 JS 錯誤', m.errors.length === 0, m.errors.join(' | '));
  code = done();
} catch (e) {
  console.log('ERR', e.stack || e.message); code = 1;
} finally {
  for (const p of pages) try { p.close(); } catch {}
  process.exitCode = code;
  await shutdown().catch(() => {});
}
