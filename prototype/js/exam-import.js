// 後台「測驗卷 → 考卷重現」：上傳學校考卷的照片（可多張），選擇題原樣存成草稿，核對後再發佈給學生。
// 經典腳本（不是 ES module）：和其他 js/*.js 共用全域，由 index.html 依固定順序載入，順序不能換。

const EX = { files: [], busy: false, done: null };

function renderExamImport(){
  P.tab = 'exam';
  const d = EX.done;
  pBox().innerHTML = `${pNav()}
  <div class="box p-setup">
    <label>學校的考卷，原樣重現成一份測驗卷</label>
    <p class="hint">拍下考卷（選擇題，可以一次選好幾張），程式把題幹、選項抄下來並由模型判斷答案，存成<b>草稿</b>。
      手寫的字會被忽略。<b>答案是模型猜的，發佈前請你逐題核對</b>；有疑問的題會標示「請核對」。</p>
    <div class="row"><label for="exTitle" class="hint">卷子名稱</label>
      <input type="text" id="exTitle" maxlength="60" size="34" placeholder="不填就用「${esc(exDefaultTitle())}」">
      <button type="button" id="exPick">選擇照片</button>
      <input type="file" id="exFile" accept="image/*" multiple hidden></div>
    <p class="hint" id="exFiles">${exFilesNote()}</p>
    <div class="row"><button type="button" class="primary" id="exGo" ${EX.files.length && !EX.busy ? '' : 'disabled'}>辨識並存成草稿</button>
      <span class="hint" id="exMsg"></span></div>
  </div>
  <div id="exResult">${d ? exResultHtml(d) : ''}</div>`;
}

const exPad = n => String(n).padStart(2, '0');
function exDefaultTitle(){ const t = new Date(); return `${t.getFullYear()}-${exPad(t.getMonth() + 1)}-${exPad(t.getDate())} 考卷重現`; }
const exFilesNote = () => EX.files.length ? `已選 ${EX.files.length} 張：${EX.files.map(f => esc(f.name || '照片')).join('、')}` : '還沒選照片。';

function exResultHtml(d){
  if (d.error) return `<div class="box"><p class="msg">${esc(d.message || '辨識失敗')}</p>${(d.skipped || []).length ? exSkipped(d.skipped) : ''}</div>`;
  return `<div class="box"><p><b>已存成草稿：${esc(d.title)}</b>　${d.n} 題${d.flagged ? `，其中 <b>${d.flagged} 題請核對</b>` : ''}。</p>
    <p class="hint">學生現在還看不到。打開草稿逐題核對答案，需要的話可以改題幹、選項、答案，沒問題再發佈。${d.usage?.costUsd ? `（參考費用 ${money(d.usage.costUsd)}）` : ''}</p>
    ${(d.skipped || []).length ? exSkipped(d.skipped) : ''}${(d.failed || []).length ? `<p class="hint">這些照片辨識失敗：${d.failed.map(esc).join('；')}</p>` : ''}
    <div class="row"><button type="button" class="primary" data-exam="open" data-id="${esc(d.id)}">打開草稿核對</button>
      ${d.sentences ? '<button type="button" data-exam="analyze">把完整句子帶到分析頁</button>' : ''}</div>
    ${d.sentences ? '<p class="hint">「帶到分析頁」只會把填好答案的完整句子放進輸入框，不會自動分析；之後在「句子練習」也練得到。</p>' : ''}</div>`;
}
const exSkipped = list => `<p class="hint">沒有收進來的題（沒有空格或沒有選項）：${list.map(s => `${s.no != null ? '第 ' + s.no + ' 題' : '一題'}（${esc(s.reason)}）`).join('、')}。</p>`;

pBox().addEventListener('click', async e => {
  const t = e.target;
  if (t.id === 'exPick'){ el('exFile').click(); return; }
  const a = t.closest('[data-exam]')?.dataset.exam;
  if (a === 'open'){ const r = await artApi(`/api/paper?id=${t.closest('[data-exam]').dataset.id}&admin=1`); if (r.ok) openPaper(r.json); return; }
  if (a === 'analyze'){ jumpTo('sentence', { sub: 'live' }); curKind = null; setInput(EX.done.sentences); return; }
  if (t.id === 'exGo') exRun();
});
pBox().addEventListener('change', e => {
  if (e.target.id !== 'exFile') return;
  EX.files = [...(e.target.files || [])].slice(0, 6); e.target.value = '';
  el('exFiles').innerHTML = exFilesNote();
  el('exGo').disabled = !EX.files.length || EX.busy;
});

async function exRun(){
  if (EX.busy || !EX.files.length) return;
  EX.busy = true; el('exGo').disabled = true; const msg = el('exMsg'), title = el('exTitle').value;
  try {
    const images = [];
    for (let i = 0; i < EX.files.length; i++){
      msg.textContent = `讀取照片 ${i + 1} / ${EX.files.length}…`;
      const img = await shrinkImage(EX.files[i], 2000);
      if (!img){ msg.textContent = `第 ${i + 1} 張讀不到，請換一張。`; return; }
      images.push(img);
    }
    msg.textContent = `辨識中…每張大約 20–60 秒，請不要關閉頁面。`;
    const r = await artApi('/api/exam-import', { method: 'POST', body: { images, title } });
    if (!r.ok){ EX.done = { error: true, message: r.json.message || '辨識失敗', skipped: r.json.skipped }; }
    else { EX.done = r.json; EX.files = []; }
  } catch (err){ EX.done = { error: true, message: '辨識失敗：' + err.message }; }
  finally { EX.busy = false; }
  if (P.tab === 'exam') renderExamImport();
}
