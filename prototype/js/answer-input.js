// 作答欄位強化：擋掉輸入法、貼上、自動完成。
// 經典腳本（不是 ES module）：和其他 js/*.js 共用全域，由 index.html 依固定順序載入，順序不能換。

/* ---- 作答欄位強化 ----
 * 網頁「無法」關閉作業系統的輸入法本身（注音／拼音的選字視窗一定會跳出來），
 * 能做的是讓它打出來的字進不了欄位，效果上等同禁用：
 *   1. 關掉瀏覽器自己的自動完成、拼字檢查、自動修正、自動大寫
 *   2. 欄位名稱隨機，瀏覽器記不住上次打過什麼
 *   3. 擋掉貼上與拖放
 *   4. 偵測到輸入法組字就提示，組完把非英文字元濾掉
 */
const ANSWER_ALLOWED = /[^A-Za-z0-9 '’\-.,?!]/g;

function hardenAnswerInput(inp){
  if (inp.dataset.hardened) return;
  inp.dataset.hardened = '1';
  inp.setAttribute('autocomplete', 'off');
  inp.setAttribute('autocorrect', 'off');
  inp.setAttribute('autocapitalize', 'off');
  inp.setAttribute('spellcheck', 'false');
  inp.setAttribute('inputmode', 'text');
  inp.setAttribute('name', 'a' + Math.random().toString(36).slice(2, 8));

  let note = null, timer = null;
  const warn = (msg) => {
    if (!note){
      note = document.createElement('div');
      note.className = 'ime-warn';
      inp.parentElement?.appendChild(note);
    }
    note.textContent = msg;
    note.dataset.show = '1';
    clearTimeout(timer);
    timer = setTimeout(() => { if (note) note.dataset.show = '0'; }, 2600);
  };

  const strip = () => {
    // 全形英數先轉半形再過濾 —— 輸入法停在全形時打 free 不該整個消失
    const half = inp.value.replace(/[\uFF01-\uFF5E]/g,
      c => String.fromCharCode(c.charCodeAt(0) - 0xFEE0)).replace(/\u3000/g, ' ');
    const clean = half.replace(ANSWER_ALLOWED, '');
    if (clean !== inp.value){
      const atEnd = inp.selectionStart === inp.value.length;
      inp.value = clean;
      if (atEnd) inp.setSelectionRange(clean.length, clean.length);
      warn('作答請切換成英文輸入法，這一格只收英文。');
    }
  };

  // 組字過程中不能動 value，否則輸入法會錯亂；等組完再濾
  let composing = false;
  inp.addEventListener('compositionstart', () => {
    composing = true;
    warn('偵測到中文輸入法，請切換成英文再作答。');
  });
  inp.addEventListener('compositionend', () => { composing = false; strip(); });
  inp.addEventListener('input', () => { if (!composing) strip(); });

  inp.addEventListener('paste', e => { e.preventDefault(); warn('作答時不能貼上，請自己拼出來。'); });
  inp.addEventListener('drop',  e => { e.preventDefault(); warn('作答時不能拖放文字。'); });
}

/** 把一個容器裡所有作答欄位都強化 */
function hardenAnswers(root){
  for (const inp of root.querySelectorAll('.q-blanks input')) hardenAnswerInput(inp);
}
