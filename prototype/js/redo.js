// 訂正：把答錯的原題重出，答錯的排前面（句子練習與單字測驗共用）。
// 經典腳本（不是 ES module）：和其他 js/*.js 共用全域，由 index.html 依固定順序載入，順序不能換。

// ---- 訂正：把答錯的原題重出 ----
// 訂正就是把原本那題做對，所以題型不換。只有選項順序會打散。
let wsWrong = { quizId: null, ids: [] };
let quizWrong = { quizId: null, ids: [] };

el('wsFix').addEventListener('click', () => {
  if (!wsWrong.ids.length) return;
  startWordQuiz({ redoFrom: wsWrong.quizId, redoIds: wsWrong.ids });
});
el('quizFix').addEventListener('click', () => {
  if (!quizWrong.ids.length) return;
  startQuiz({ redoFrom: quizWrong.quizId, redoIds: quizWrong.ids });
});

/** 批改後把答錯的排到最前面 —— 要訂正的東西不該埋在一堆答對的裡面。
 *  題號保持原本的順序編號，那是當下那份測驗的題號，改掉反而對不上。 */
function wrongFirst(outEl, results, idOf){
  const wrong = [], right = [];
  for (const r of results){
    const card = document.getElementById(idOf(r));
    if (card) (r.correct ? right : wrong).push(card);
  }
  // id 字首打錯的話一張都抓不到，畫面看起來只是「沒重排」，很難發現。
  if (results.length && !wrong.length && !right.length)
    console.error('[wrongFirst] 找不到任何題目卡片，id 對不上：', idOf(results[0]));
  if (!wrong.length || !right.length) return;      // 全對或全錯就不用重排
  const frag = document.createDocumentFragment();
  for (const c of wrong) frag.appendChild(c);
  const div = document.createElement('div');
  div.className = 'okdiv';
  div.textContent = `以下 ${right.length} 題答對了`;
  frag.appendChild(div);
  for (const c of right) frag.appendChild(c);
  outEl.appendChild(frag);                          // appendChild 會搬移節點，等於重排
}

/** 交卷的錯誤訊息要出現在交卷鍵旁邊。
 *  原本插在題目列表最上方，使用者在頁尾按交卷根本看不到，
 *  而且用 insertAdjacentHTML 會一直疊上去。 */
function quizMsg(actionsId, text){
  const row = el(actionsId);
  let p = row.parentNode.querySelector('.quizmsg');
  if (!p){
    p = document.createElement('p');
    p.className = 'msg quizmsg';
    row.after(p);
  }
  p.textContent = text;
  p.hidden = false;
  p.scrollIntoView({ block: 'center', behavior: 'smooth' });
}
const clearQuizMsg = id => el(id).parentNode.querySelector('.quizmsg')?.remove();



/** 手機上出完題直接捲到第一題 —— 字表、統計、測驗設定全在上面，
 *  不捲的話要滑很久才看得到題目。桌機畫面放得下，不動。 */
function scrollToFirstQuestion(container){
  if (!matchMedia('(max-width:560px)').matches) return;
  const first = container.firstElementChild;
  first?.scrollIntoView({ behavior: 'smooth', block: 'start' });
}
