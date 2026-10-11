// 新增字表表單、字表例句分析、處理中指示、拍照／拖曳／貼上的單字辨識。
// 經典腳本（不是 ES module）：和其他 js/*.js 共用全域，由 index.html 依固定順序載入，順序不能換。

// ---- 例句的句型分析 ----
// 分析過的句子存在同一個快取裡，所以批次分析過之後，
// 點單句的「分析」是瞬間完成且不花額度的。
let wsExamples = { total: 0, cached: 0 };

/** 只更新例句的分析進度，不動畫面其他部分。
 *  從「分析」分頁分析過例句後切回來，數字要跟著變 ——
 *  原本只有 selectSet() 會算，而那只在切換字表時才跑。 */
async function refreshExamples(){
  if (!wsSel.length || API === false) return;
  try {
    const d = await fetch(`/api/wordset?ids=${selParam()}&user=${encodeURIComponent(USER)}`)
      .then(r => r.json());
    const changed = (d.examples?.cached ?? -1) !== wsExamples.cached;
    wsExamples = d.examples || wsExamples;
    renderAnalyzeBtn();
    // 有新分析過的例句才重畫，否則會把使用者正在看的位置洗掉
    if (changed && d.words){ wsWordsCache = d.words; renderWordList(); }
  } catch { /* 拿不到就維持原本的數字 */ }
}

function renderAnalyzeBtn(){
  const b = el('wsAnalyze');
  const left = wsExamples.total - wsExamples.cached;
  if (!wsExamples.total){ b.hidden = true; return; }
  b.hidden = false;
  b.disabled = false;
  b.textContent = left ? `批次分析例句（還有 ${left} 句）` : `例句都分析過了（${wsExamples.total} 句）`;
  b.classList.toggle('danger', !left);
}

el('wsAnalyze').addEventListener('click', async () => {
  const left = wsExamples.total - wsExamples.cached;
  if (!left) {                                  // 都分析過了，直接去分析頁看
    jumpTo('sentence', { sub: 'live' });
    return;
  }
  const b = el('wsAnalyze');
  b.disabled = true;
  // 改用串流：每 8 句一批，跑完就存檔並回報進度。
  // 幾十句要跑好幾分鐘，沒有進度的話看起來就像當掉了。
  let done = 0, cost = 0;
  const show = () => { b.textContent = `分析中…${done} / ${left} 句（${money(cost)}）`; };
  show();
  try {
    const res = await fetch('/api/wordset-analyze', {
      method:'POST', headers:{ 'content-type':'application/json', ...(TOKEN?{'x-auth-token':TOKEN}:{}) },
      body: JSON.stringify({ setIds: wsSel, userToken: USER }),
    });
    if (!res.ok || !res.body){
      const d = await res.json().catch(() => ({}));
      b.textContent = d.message || '分析失敗'; b.disabled = false; return;
    }
    const reader = res.body.getReader();
    const dec = new TextDecoder();
    let buf = '', failed = null;
    for (;;){
      const { value, done: fin } = await reader.read();
      if (fin) break;
      buf += dec.decode(value, { stream: true });
      const parts = buf.split('\n\n'); buf = parts.pop() ?? '';
      for (const p of parts){
        const ev = /^event: (\w+)/m.exec(p)?.[1];
        const dataLine = /^data: (.*)$/m.exec(p)?.[1];
        if (!ev || !dataLine) continue;
        let d; try { d = JSON.parse(dataLine); } catch { continue; }
        if (ev === 'progress'){ done = d.done; cost = d.costUsd ?? cost; show(); }
        else if (ev === 'failed') failed = d;
        else if (ev === 'done'){ done = d.analyzed; cost = d.usage?.costUsd ?? cost; }
      }
    }
    await refreshExamples();
    loadHistory?.();
    el('wsHint').textContent = failed
      ? `${failed.message}（已完成的 ${failed.analyzed} 句已經存起來，再按一次會從沒分析的接著跑）`
      : `分析完 ${done} 句（參考費用 ${money(cost)}）。現在點任何例句的「分析」都是瞬間的。`;
  } catch (e){
    el('wsHint').textContent = '連線中斷：' + e.message + '（已完成的部分已經存起來，再按一次會接著跑）';
    await refreshExamples();
  } finally { b.disabled = false; renderAnalyzeBtn(); }
});

// 點例句的「分析」：切到分析頁，命中快取的話瞬間出結果
// 綁在整個分頁上 —— 單字卡渲染在 #wsWords，測驗在 #wsOut，
// 綁錯容器就等於沒綁（之前就是綁在 #wsOut 上，點了完全沒反應）。
el('view-words').addEventListener('click', e => {
  const b = e.target.closest('.exan');
  if (!b) return;
  const text = b.dataset.an;
  jumpTo('sentence', { sub: 'live' });
  setInput(text);
  analyzeLive(text);
});


/** 只選一份字表時，可以把新的字「加進那一份」而不是另開一份。
 *  家教每次加幾個字到同一單元，不該每次都開新字表。 */

/** 新增狀態下只做一件事：把字加到某一份。
 *  所以字表卡、多選、刪除全部收起來，避免和「要加到哪裡」混淆。 */
function setFormMode(on){
  el('wsBar').hidden = on;
  el('wsList').hidden = on;
  el('wsNew').textContent = on ? '← 回到單字表' : '＋ 新增字表';
}

function renderFormActions(){
  const dl = el('wsSetNames');
  if (!dl) return;
  dl.innerHTML = wsAllSets.map(x => `<option value="${esc(x.name)}">${x.word_count} 字</option>`).join('');
  syncDest();
}

/** 輸入的名稱決定目標：和既有字表同名就是加進那一份，否則建新的。 */
function destOf(){
  const v = el('wsName').value.trim();
  const hit = wsAllSets.find(x => x.name.toLowerCase() === v.toLowerCase());
  return { value: v, setId: hit ? hit.id : 0, set: hit };
}
function syncDest(){
  const d = destOf();
  const hint = el('wsDestHint');
  if (d.setId){
    hint.className = 'desthint';
    hint.innerHTML = `會加進既有的 <b>${esc(d.set.name)}</b>（目前 ${d.set.word_count} 字）。` +
      `那份已經有的字會自動略過，不會重複，也不會重複花額度。`;
    el('wsCreate').textContent = '加進這份字表';
  } else {
    hint.className = 'desthint new';
    hint.innerHTML = d.value
      ? `會建立新字表 <b>${esc(d.value)}</b>。`
      : `沒有輸入名稱就會建立一份新字表。`;
    el('wsCreate').textContent = '建立新字表';
  }
  el('wsHint').textContent = d.setId
    ? '只有新字會送去整理，之後測驗都不再花費。'
    : '建立時花一次額度整理詞性、意思、例句與音節；之後測驗都不再花費。';
}

/** 建立或加入。appendTo 有值就是加進既有字表。 */
async function submitWordset(appendTo){
  const text = el('wsText').value.trim();
  if (!text) return;
  el('wsCreate').disabled = true;
  wsBusy(true, appendTo ? '加入中' : '整理中', '每個字要查詞性、意思、例句與音節，大約一分鐘');
  el('wsHint').textContent = appendTo ? '加入中…' : '整理中…';
  try {
    const d = await fetch('/api/wordsets', {
      method:'POST', headers:{ 'content-type':'application/json', ...(TOKEN?{'x-auth-token':TOKEN}:{}) },
      body: JSON.stringify({ name: el('wsName').value.trim() || null, text, appendTo: appendTo || undefined }),
    }).then(r => r.json());
    if (d.error){ el('wsHint').textContent = d.message || d.error; return; }
    const dup = d.skipped ? `（有 ${d.skipped} 個字那份已經有了，略過）` : '';
    el('wsHint').textContent = d.count
      ? (d.appended ? `已加入 ${d.count} 個字${dup}。` : `建立完成：${d.count} 個字。`)
      : (d.message || `沒有新增${dup}。`);
    if (d.count){
      el('wsText').value = ''; el('wsName').value = '';
      el('wsForm').hidden = true; setFormMode(false);
    }
    wsSel = [d.id]; wsCurrent = d.id;
    await loadWordsets();
  } catch (e){ el('wsHint').textContent = (appendTo ? '加入' : '建立') + '失敗：' + e.message; }
  finally { wsBusy(false); el('wsCreate').disabled = false; el('wsPhoto').disabled = false; }
}

/** 輸入框上的進度指示。模型要跑十秒到一分鐘，沒有動的東西會讓人以為當掉了。 */
/** 兩個輸入框共用。prefix 是 'ws'（單字表）或 'an'（分析）。 */
const busyTimers = {};
function showBusy(prefix, on, main = '', sub = ''){
  const box = el(prefix + 'Busy');
  if (!box) return;
  const wrap = box.closest('.ta-wrap');
  clearInterval(busyTimers[prefix]);
  if (!on){ box.hidden = true; wrap?.classList.remove('busyon'); return; }
  wrap?.classList.add('busyon');
  el(prefix + 'BusyMain').textContent = main;
  el(prefix + 'BusySub').textContent = sub;
  el(prefix + 'BusyT').textContent = '0 秒';
  box.hidden = false;
  box.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  const t0 = Date.now();
  busyTimers[prefix] = setInterval(() => {
    el(prefix + 'BusyT').textContent = `${Math.round((Date.now() - t0) / 1000)} 秒`;
  }, 250);
}
// 用函式宣告而不是 const —— 會提升，不管在哪裡呼叫都不會踩到 TDZ
function wsBusy(on, main, sub){ showBusy('ws', on, main, sub); }
function anBusy(on, main, sub){ showBusy('an', on, main, sub); }
// Windows 之後也會用到，鍵位提示跟著平台走
if (!/Mac|iP(hone|ad|od)/.test(navigator.platform || navigator.userAgent))
  for (const id of ['pasteKey', 'pasteKey2']) { const n = el(id); if (n) n.textContent = 'Ctrl+V'; }

/** 拖曳時一次丟多張：挑出全部圖片 */
function imagesFromTransfer(dt){
  return [...(dt?.files || [])].filter(f => f.type?.startsWith('image/'));
}

/** 從拖曳或貼上的事件裡挑出第一張圖片 */
function imageFromTransfer(dt){
  if (!dt) return null;
  for (const f of dt.files || []) if (f.type?.startsWith('image/')) return f;
  for (const it of dt.items || []){
    if (it.kind === 'file' && it.type?.startsWith('image/')){
      const f = it.getAsFile();
      if (f) return f;
    }
  }
  return null;
}

/** 一次選多張時，同一個字可能出現在兩張（跨頁）。以英文部分（逗號前）比對，已經有的就略過。 */
function mergeWordLines(old, add){
  const head = l => l.split(/[,，]/)[0].trim().toLowerCase();
  const seen = new Set(old.split('\n').filter(l => l.trim()).map(head));
  const fresh = add.split('\n').filter(l => l.trim() && !seen.has(head(l)));
  return { text: [old, ...fresh].filter(Boolean).join('\n'), added: fresh.length, dup: add.split('\n').filter(l => l.trim()).length - fresh.length };
}

/** 選圖、拖曳、貼上三種來源都走這裡。可以一次給多張，依序辨識、逐張接在文字框後面。 */
async function handleImageFile(files){
  const list = [].concat(files || []).filter(Boolean);
  if (!list.length) return;
  el('wsPhoto').disabled = true; el('wsCreate').disabled = true;
  let ok = 0, dupTotal = 0, cost = 0; const failed = [];
  try {
    for (let i = 0; i < list.length; i++){
      const tag = list.length > 1 ? `第 ${i + 1}／${list.length} 張：` : '';
      wsBusy(true, tag + '讀取照片', '縮圖中');
      el('wsHint').textContent = tag + '讀取照片…';
      try {
        const image = await shrinkImage(list[i]);
        if (!image){ failed.push(`第 ${i + 1} 張讀不到`); continue; }
        wsBusy(true, tag + '辨識中', '把課本上的單字抄下來，大約十秒');
        el('wsHint').textContent = tag + '辨識中…';
        const d = await fetch('/api/wordset-ocr', {
          method:'POST', headers:{ 'content-type':'application/json', ...(TOKEN?{'x-auth-token':TOKEN}:{}) },
          body: JSON.stringify({ image }),
        }).then(r => r.json());
        if (d.error === 'unauthorized') showTokenBanner('存取碼不對或還沒輸入，所以照片沒辦法辨識。請輸入存取碼。');
        if (d.error){ failed.push(`第 ${i + 1} 張：${d.message || d.error}`); continue; }
        if (!d.words.length){ failed.push(`第 ${i + 1} 張沒抄到單字`); continue; }
        // 填進文字框讓使用者核對再建立 —— 辨識可能有誤，不直接拿去花額度充實
        const m = mergeWordLines(el('wsText').value.trim(), d.text);
        el('wsText').value = m.text;
        el('wsText').dispatchEvent(new Event('input'));
        ok++; dupTotal += m.dup; cost += d.usage.costUsd || 0;
      } catch (err){
        failed.push(`第 ${i + 1} 張辨識失敗：${err.message}`);
      }
    }
    const total = el('wsText').value.split('\n').filter(l => l.trim()).length;
    const parts = [];
    if (ok) parts.push(`辨識了 ${ok} 張，目前共 ${total} 行（參考費用 ${money(cost)}）${dupTotal ? `，略過 ${dupTotal} 個重複的字` : ''}。請核對上面的內容，刪掉不考的部分再按建立字表。`);
    if (failed.length) parts.push('失敗：' + failed.join('；') + '。');
    el('wsHint').textContent = parts.join(' ');
  } finally { wsBusy(false); el('wsPhoto').disabled = false; el('wsCreate').disabled = false; }
}

el('wsPhoto').addEventListener('click', () => el('wsFile').click());
el('wsFile').addEventListener('change', e => {
  const fs = [...(e.target.files || [])];
  e.target.value = '';                          // 讓同一張照片可以再選一次
  handleImageFile(fs);
});

// ---- 拖曳：整個單字分頁都能接，表單沒開就自動打開 ----
const openFormFor = (msg) => {
  if (el('wsForm').hidden){ el('wsForm').hidden = false; setFormMode(true); }
  if (msg) el('wsHint').textContent = msg;
};
let dragDepth = 0;
const wordsView = el('view-words');
wordsView.addEventListener('dragenter', e => {
  if (![...(e.dataTransfer?.types || [])].includes('Files')) return;
  e.preventDefault();
  if (dragDepth++ === 0) wordsView.classList.add('dropping');
});
wordsView.addEventListener('dragover', e => {
  if ([...(e.dataTransfer?.types || [])].includes('Files')){
    e.preventDefault();
    e.dataTransfer.dropEffect = 'copy';
  }
});
wordsView.addEventListener('dragleave', () => {
  if (--dragDepth <= 0){ dragDepth = 0; wordsView.classList.remove('dropping'); }
});
wordsView.addEventListener('drop', e => {
  const f = imagesFromTransfer(e.dataTransfer);
  if (!f.length && !(e.dataTransfer?.files?.length)) return;   // 不是檔案就讓瀏覽器自己處理
  e.preventDefault();
  dragDepth = 0; wordsView.classList.remove('dropping');
  if (!f.length){ openFormFor('拖進來的不是圖片。請拖 JPG 或 PNG 的課本照片。'); return; }
  openFormFor('');
  handleImageFile(f);
});

// ---- 貼上：從 LINE 之類的地方複製圖片，直接 ⌘V ----
wordsView.addEventListener('paste', e => {
  const f = imageFromTransfer(e.clipboardData);
  if (!f) return;                                // 貼文字就照常貼進輸入框
  e.preventDefault();
  openFormFor('');
  handleImageFile(f);
});

el('wsNew').addEventListener('click', () => {
  const f = el('wsForm'); f.hidden = !f.hidden;
  setFormMode(!f.hidden);
  if (!f.hidden){
    renderFormActions();
  }
});
el('wsCancel').addEventListener('click', () => {
  el('wsForm').hidden = true; setFormMode(false);
});
el('wsCreate').addEventListener('click', () => submitWordset(destOf().setId));
for (const ev of ['input', 'change']) el('wsName').addEventListener(ev, syncDest);

el('wsDel').addEventListener('click', async () => {
  const del = el('wsDel');
  if (!wsSel.length) return;
  // 刪除會連同那些字表的所有練習進度一起消失，所以要按兩次
  if (del.dataset.armed !== '1'){
    const names = wsSel.map(id =>
      document.querySelector(`.wchip[data-id="${id}"]`)?.firstChild?.textContent?.trim() ?? '')
      .filter(Boolean);
    del.dataset.armed = '1';
    del.textContent = names.length === 1
      ? `再按一次刪除「${names[0]}」`
      : `再按一次刪除這 ${names.length} 份`;
    del.title = names.join('、');
    clearTimeout(del._t);
    del._t = setTimeout(() => { del.dataset.armed = '0'; del.textContent = delLabel(); }, 4000);
    return;
  }
  clearTimeout(del._t);
  del.dataset.armed = '0';
  await fetch(`/api/wordsets?ids=${selParam()}`, { method:'DELETE',
    headers: TOKEN ? { 'x-auth-token': TOKEN } : {} });
  wsSel = []; wsCurrent = null; await loadWordsets();
});

el('wsList').addEventListener('click', async e => {
  const b = e.target.closest('.wchip');
  if (b) return selectSet(Number(b.dataset.id));
  if (e.target.id === 'wsMore'){
    el('wsList').dataset.expanded = el('wsList').dataset.expanded === '1' ? '0' : '1';
    return loadWordsets();
  }
});

/** 多選時按鈕與說明要跟著變 */
const delLabel = () => wsSel.length > 1 ? `刪除選取的 ${wsSel.length} 份` : '刪除目前字表';
function renderSelInfo(){
  const info = el('wsSelInfo');
  if (info) info.textContent = wsSel.length > 1
    ? `已選 ${wsSel.length} 份字表，共 ${wsMerged.words} 個字` +
      (wsMerged.dup ? `（其中 ${wsMerged.dup} 個在多份裡都有，已合併成一張卡，例句與詞義都保留）。` : '。')
    : '點字表可以加選或取消，至少要留一份。';
  const d = el('wsDel');
  if (d && d.dataset.armed !== '1') d.textContent = delLabel();
}

/** 單字分頁底下的兩個子頁：預設看清單，要考試才切到測驗 */
function showPane(which){
  for (const b of document.querySelectorAll('.subtabs button'))
    b.setAttribute('aria-pressed', String(b.dataset.pane === which));
  el('pane-list').hidden = which !== 'list';
  el('pane-quiz').hidden = which !== 'quiz';
}
for (const b of document.querySelectorAll('.subtabs button'))
  b.addEventListener('click', () => { Spk.stop(); showPane(b.dataset.pane); });
el('wsStart').addEventListener('click', startWordQuiz);
el('wsSubmit').addEventListener('click', submitWordQuiz);
el('wsAgain').addEventListener('click', startWordQuiz);
