// 導覽：頂層分頁（單字／句子／文章／測驗卷／弱點／歷史）、「句子」與「文章」的子頁、返回鈕。
// 經典腳本（不是 ES module）：和其他 js/*.js 共用全域，由 index.html 依固定順序載入，順序不能換。
//
// 結構：單字 → 句子 → 文章。
//   單字：單字清單、單字測驗（子頁在 words.js / panes）
//   句子：句子分析、句子練習
//   文章：文章表、新增文章
// 句子分析與新增文章共用同一個輸入框與結果區（#an-live），用 anMode 切換成哪一種用法，
// 切換時把整塊搬到對應的子頁裡，所以輸入、拍照、分析、朗讀、提示便條的程式都不用分兩份。

const VIEWS = ['words', 'sentence', 'article', 'exam', 'weak', 'jobs', 'sentences', 'students', 'history'];
const VIEW_NAMES = { words: '單字', sentence: '句子', article: '文章', exam: '測驗卷', weak: '弱點', jobs: '申請', sentences: '句子', students: '學生紀錄', history: '歷史' };
/** 現在是後台（/admin）還是前台。後台是老師管理用的，前台是學生練習用的；同一份頁面，分頁與按鈕不同。 */
const isAdminApp = () => document.body.dataset.app === 'admin';
let curView = 'words';
let anMode = 'sentence';          // 'sentence'：只分析、不存；'article'：分析並存成文章表
let snPane = 'live';              // 句子頁目前的子頁：live | practice
let arPane = 'articles';          // 文章頁目前的子頁：articles | new
let backTo = null;                // 從別的分頁跳過來時記下來源：{ view, scroll }

const needApi = msg => `<p class="msg">${msg}需要後端。請在本機執行 npm start 後開啟 http://127.0.0.1:8787</p>`;

// ---- 返回鈕：跳到別的分頁時，目的地上方出現「← 返回○○」----
function updateBackBar(){
  const bar = el('backBar'), show = Boolean(backTo) && backTo.view !== curView;
  bar.hidden = !show;
  if (show) el('backBtn').textContent = `← 返回${VIEW_NAMES[backTo.view]}`;
}
el('backBtn').addEventListener('click', () => {
  const b = backTo; backTo = null;
  if (!b) return;
  showView(b.view, { keepBack: false });
  setTimeout(() => window.scrollTo({ top: b.scroll || 0 }), 200);     // 清單是非同步重畫的，等一下再捲回去
});

/** 程式導向另一個分頁（例如單字清單的例句按「分析」）。會記下來源，目的地出現返回鈕。 */
function jumpTo(view, opts = {}){
  const from = { view: curView, scroll: window.scrollY };
  showView(view, { ...opts, keepBack: true });
  backTo = from.view === view ? null : from;
  updateBackBar();
}

// ---- 句子分析／新增文章共用的輸入區 ----
function setAnMode(mode){
  const changed = mode !== anMode;
  anMode = mode;
  const live = el('an-live');
  if (mode === 'article') el('ar-new').appendChild(live);
  else el('view-sentence').insertBefore(live, el('sn-practice'));
  el('artNameRow').hidden = mode !== 'article' || API === false;
  const chips = live.querySelector('.chips-group'); if (chips) chips.hidden = mode === 'article';
  // 輸入框預設放著一句內建範例；新增文章用不到，清掉（自己打的內容不動）
  if (mode === 'article' && Object.values(DATA).some(d => d.input === inpEl.value)){ inpEl.value = ''; if (typeof updateCount === 'function') updateCount(); }
  if (changed && !goBtn.disabled){               // 換用法時，上一次的結果不要留在畫面上
    out.innerHTML = ''; usageBar.hidden = true; curKind = null;
    el('artConfirm').hidden = true;
  }
  if (typeof syncArticleDest === 'function') syncArticleDest();
}

function showSentencePane(which, { auto = true } = {}){
  snPane = which;
  for (const b of document.querySelectorAll('#snTabs button')) b.setAttribute('aria-pressed', String(b.dataset.sp === which));
  Spk.stop();
  if (which === 'live'){
    setAnMode('sentence');
    el('an-live').hidden = false; el('sn-practice').hidden = true;
  } else {
    el('an-live').hidden = true; el('sn-practice').hidden = false;
    if (API === false) quizOut.innerHTML = needApi('句子練習');
    else if (auto && !currentQuiz) startQuiz();
  }
}
el('snTabs').addEventListener('click', e => { const b = e.target.closest('button[data-sp]'); if (b) showSentencePane(b.dataset.sp); });

function showArticlePane(which){
  arPane = which;
  for (const b of document.querySelectorAll('#arTabs button')) b.setAttribute('aria-pressed', String(b.dataset.ap === which));
  Spk.stop();
  if (which === 'new'){
    setAnMode('article');
    el('an-live').hidden = false; el('ar-new').hidden = false; el('an-articles').hidden = true;
    if (typeof showPendingNotice === 'function') showPendingNotice();
  } else {
    el('ar-new').hidden = true; el('an-articles').hidden = false;
    el('artView').hidden = true; el('artList').hidden = false;
    if (API === false) el('artList').innerHTML = needApi('文章表');
    else loadArticles();
  }
}
el('arTabs').addEventListener('click', e => { const b = e.target.closest('button[data-ap]'); if (b) showArticlePane(b.dataset.ap); });

// ---- 頂層分頁 ----
function showView(v, { sub = null, keepBack = false, auto = true } = {}){
  curView = v;
  if (!keepBack) backTo = null;
  for (const x of document.querySelectorAll('.tabs button')) x.setAttribute('aria-pressed', String(x.dataset.view === v));
  Spk.stop();
  document.body.dataset.view = v;        // 給 CSS 用：邊緣把手只在句子、文章分頁出現
  for (const name of VIEWS) el(`view-${name}`).hidden = name !== v;
  updateBackBar();
  if (v === 'words'){
    if (API === false) el('wsList').innerHTML =
      '<span class="hint">單字表需要後端。請在本機執行 npm start 後開啟 http://127.0.0.1:8787</span>';
    else { loadWordsets(); refreshExamples(); }
  }
  if (v === 'sentence') showSentencePane(sub || snPane, { auto });
  // 有沒做完的文章分析時，進文章頁直接停在「新增文章」，提示才看得到
  if (v === 'article') showArticlePane(sub || (typeof getPending === 'function' && getPending() ? 'new' : arPane));
  if (v === 'exam') loadPaperHome();
  if (v === 'weak'){
    if (API === false) el('weakCharts').innerHTML = needApi('弱點統計');
    else loadWeakness();
  }
  if (v === 'jobs') loadJobs();
  if (v === 'sentences') loadSentences();
  if (v === 'students') loadStudentRecords();
  if (v === 'history'){
    if (API === false) historyOut.innerHTML = needApi('歷史紀錄');
    else loadHistory();
  }
}
for (const b of document.querySelectorAll('.tabs button')) b.addEventListener('click', () => showView(b.dataset.view));
setAnMode('sentence');
