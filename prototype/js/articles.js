// 文章表：分析頁的「文章名稱」欄、存成文章表的流程（報價 → 確認 → 分析 → 存檔）、文章表清單與檢視。
// 經典腳本（不是 ES module）：和其他 js/*.js 共用全域，由 index.html 依固定順序載入，順序不能換。

const artHeaders = () => ({ 'content-type': 'application/json', ...(TOKEN ? { 'x-auth-token': TOKEN } : {}) });
const artApi = async (path, opt = {}) => {
  const r = await fetch(path, { ...opt, headers: artHeaders(), body: opt.body === undefined ? undefined : JSON.stringify(opt.body) });
  const json = await r.json().catch(() => ({}));
  return { ok: r.ok, status: r.status, json };
};

let artCache = [];                    // 文章表清單
let artCurrent = null;                // 正在看的文章表 id

const articleNameValue = () => (el('artName')?.value || '').trim();
const money2 = n => '$' + Number(n || 0).toFixed(2);

// ---- 文章名稱欄：下拉選既有、提示會建立還是附加 ----
async function refreshArticleNames(){
  if (API === false) return;
  const d = await artApi('/api/articles');
  if (!d.ok) return;
  artCache = d.json.articles || [];
  el('artNames').innerHTML = artCache.map(a => `<option value="${esc(a.name)}"></option>`).join('');
  syncArticleDest();
}
function syncArticleDest(){
  const name = articleNameValue();
  const hit = artCache.find(a => a.name.toLowerCase() === name.toLowerCase());
  el('artDest').textContent = !name ? ''
    : hit ? `會附加到文章表「${hit.name}」（目前 ${hit.sentences} 句）。` : `會建立新的文章表「${name}」。`;
  goBtn.textContent = name ? '分析並存成文章表' : '分析';
}
el('artName').addEventListener('input', syncArticleDest);

// ---- 存成文章表：先報價（不呼叫模型）→ 確認 → 分析 → 存檔 ----
async function analyzeAsArticle(name, text){
  goBtn.disabled = true;
  usageBar.hidden = true;
  el('artConfirm').hidden = true; el('artConfirm').innerHTML = '';
  hintEl.textContent = '先算一下要分析幾句、大概花多少…';
  const q = await artApi('/api/analyze', { method: 'POST', body: { text, article: true, dryRun: true } });
  goBtn.disabled = false;
  if (!q.ok){
    const e = q.json;
    hintEl.textContent = e.error === 'too long' ? `文章太長了（${e.got} 字），文章模式上限 ${e.maxChars} 字。請分批存。`
      : q.status === 401 ? '存取權杖不正確或未提供。請用帶有 ?token=… 的網址開啟。' : '無法估價：' + (e.error || q.status);
    return;
  }
  const p = q.json;
  const run = () => runArticle(name, text);
  if (!p.toAnalyze){ hintEl.textContent = `共 ${p.total} 句，全部分析過了，直接存成文章表。`; return run(); }
  const mins = Math.max(1, Math.round(p.estimate.seconds / 60));
  const box = el('artConfirm');
  box.innerHTML = `<p class="ac-title">這份文章共 ${p.total} 句，其中 <b>${p.toAnalyze} 句要請模型分析</b>${p.cached ? `（另外 ${p.cached} 句以前分析過，不花額度）` : ''}。</p>
    <p class="ac-cost">預估花費 <b>${money2(p.estimate.low)}～${money2(p.estimate.high)}</b>，約 ${mins} 分鐘。</p>
    <p class="hint">${p.truncated ? `超過 ${p.limits.maxSentences} 句的部分不會處理，也就不會存成文章表，請分批。` : ''}費用是依你最近的分析紀錄估的參考值。按下確定才會呼叫模型。</p>
    <div class="row"><button class="primary" type="button" id="artGo">確定，開始分析</button>
    <button class="linky" type="button" id="artNo">取消</button></div>`;
  box.hidden = false;
  hintEl.textContent = '';
  box.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  el('artNo').onclick = () => { box.hidden = true; hintEl.textContent = '已取消，沒有呼叫模型。'; };
  el('artGo').onclick = () => { box.hidden = true; run(); };
}

// ---- 分析到一半離開：記下來，下次進來提示可以接續 ----
const PENDING_KEY = 'analyzer-art-pending';
const setPending = v => { try { v ? localStorage.setItem(PENDING_KEY, JSON.stringify(v)) : localStorage.removeItem(PENDING_KEY); } catch {} };
const getPending = () => { try { return JSON.parse(localStorage.getItem(PENDING_KEY) || 'null'); } catch { return null; } };
const leaveWarn = e => { e.preventDefault(); e.returnValue = ''; };

async function runArticle(name, text){
  setPending({ name, text, at: Date.now() });
  window.addEventListener('beforeunload', leaveWarn);
  anBusy(true, '文章分析中，請不要離開這個畫面', '離開或切到別的 app 會中斷分析（已分析好的句子會保留，之後可以接續）');
  let s;
  try { s = await analyzeLive(text, { article: true, retry: () => runArticle(name, text) }); }
  finally { anBusy(false); window.removeEventListener('beforeunload', leaveWarn); }
  if (s.truncated){ setPending(null); hintEl.textContent = '文章超過上限，沒有存成文章表。請分批貼上。'; return; }
  if (s.error || s.halted || s.interrupted || s.failed || !s.done){
    hintEl.textContent = s.failed ? `有 ${s.failed} 句分析失敗，沒有存成文章表。重新分析會只處理失敗的句子。`
      : '分析沒有完成，所以沒有存成文章表。已完成的句子都在快取裡，重新分析只會處理剩下的。';
    return;
  }
  const r = await artApi('/api/articles', { method: 'POST', body: { name, text } });
  if (!r.ok){
    hintEl.textContent = r.json.message || ('存成文章表失敗：' + (r.json.error || r.status));
    return;
  }
  setPending(null);
  const d = r.json;
  hintEl.innerHTML = `已${d.appended ? '附加到' : '存成'}文章表「${esc(d.name)}」：新增 ${d.added} 句` +
    `${d.skipped ? `（略過重複的 ${d.skipped} 句）` : ''}，共 ${d.total} 句。 ` +
    `<button class="linky" type="button" id="artSee">看文章表</button>`;
  el('artSee').onclick = () => { showAnalyzePane('articles'); openArticle(d.id); };
  await refreshArticleNames();
}

// ---- 分析頁的兩個子分頁 ----
function showAnalyzePane(which){
  for (const b of document.querySelectorAll('#anTabs button')) b.setAttribute('aria-pressed', String(b.dataset.ap === which));
  el('an-live').hidden = which !== 'live';
  el('an-articles').hidden = which !== 'articles';
  if (which === 'articles'){ el('artView').hidden = true; el('artList').hidden = false; loadArticles(); }
}
el('anTabs').addEventListener('click', e => { const b = e.target.closest('button[data-ap]'); if (b) showAnalyzePane(b.dataset.ap); });

// ---- 文章表清單 ----
async function loadArticles(){
  const box = el('artList');
  box.innerHTML = '<p class="msg">讀取中…</p>';
  const d = await artApi('/api/articles');
  if (!d.ok){ box.innerHTML = `<p class="msg">${d.status === 401 ? '存取權杖不正確或未提供。' : '讀不到文章表。'}</p>`; return; }
  artCache = d.json.articles || [];
  if (!artCache.length){
    box.innerHTML = `<div class="box"><p style="margin:0">還沒有文章表。</p>
      <p class="hint" style="margin:8px 0 0">到「即時分析」輸入英文（或拍課本照片），填上「文章名稱」，分析完成後就會存在這裡。
      同一個名稱再存一次會接在後面，一次選多張照片也可以。</p></div>`;
    return;
  }
  box.innerHTML = `<div class="usage-cards">${artCache.map(a => `
    <button type="button" class="art-card" data-id="${a.id}">
      <b>${esc(a.name)}</b>
      <span>${a.sentences} 句・${a.paragraphs} 段</span>
      <span class="hint">${new Date(a.created_at).toLocaleDateString('zh-TW')}</span>
    </button>`).join('')}</div>`;
}
el('artList').addEventListener('click', e => { const c = e.target.closest('.art-card'); if (c) openArticle(Number(c.dataset.id)); });

// ---- 單篇檢視：依段落顯示原文與翻譯，點句子展開分析；可標出單字表的字 ----
const artSentences = new Map();       // index → 分析結果（點開才渲染）
function highlightTerms(original, terms){
  let html = esc(original);
  for (const t of terms){
    const w = String(t).replace(/[^A-Za-z' ]/g, '').trim();
    if (!w || /\s/.test(w)) continue;                          // 片語不標（比對規則複雜，標了容易標錯）
    const stem = w.length > 4 ? w.slice(0, -1) : w;
    html = html.replace(new RegExp(`\\b(${w}|${stem}[a-z]{0,4})\\b`, 'i'), '<mark class="sw">$1</mark>');
  }
  return html;
}
async function loadArtSets(){
  const d = await fetch(`/api/wordsets?user=${encodeURIComponent(USER)}`).then(r => r.json()).catch(() => ({ sets: [] }));
  const cur = el('artSets').value;
  el('artSets').innerHTML = '<option value="">不標</option>' +
    (d.sets || []).map(s => `<option value="${s.id}">${esc(s.name)}（${s.word_count} 字）</option>`).join('');
  el('artSets').value = cur;
}
async function openArticle(id){
  artCurrent = id;
  el('artList').hidden = true; el('artView').hidden = false;
  el('artConfirm').hidden = true;
  el('artBody').innerHTML = '<p class="msg">讀取中…</p>';
  await loadArtSets();
  const sets = el('artSets').value;
  const d = await artApi(`/api/article?id=${id}${sets ? `&sets=${sets}` : ''}`);
  if (!d.ok){ el('artBody').innerHTML = '<p class="msg">找不到這份文章表。</p>'; return; }
  const a = d.json;
  el('artTitle').textContent = a.name;
  el('artCover').textContent = a.coverage
    ? `這份單字表有 ${a.coverage.words} 個字，這份文章用到 ${a.coverage.hit} 個：${a.coverage.hitTerms.join('、') || '（沒有）'}` : `共 ${a.sentences} 句`;
  artSentences.clear();
  el('artBody').innerHTML = a.paragraphs.map(p => `
    <section class="art-para"><h4>${p.speaker ? `<span class="who">${esc(p.speaker)}</span>` : `第 ${p.para + 1} 段`}</h4>${p.sentences.map(s => {
      artSentences.set(s.index, s.sentence);
      return `<div class="art-sent" data-index="${s.index}">
        <p class="art-en">${s.missing ? esc('（這句的分析已不在快取裡）') : highlightTerms(s.original, s.words)}</p>
        <p class="art-zh">${esc(s.translation || '')}</p>
        ${s.sentence ? '<button class="linky art-more" type="button">展開分析</button><div class="art-detail" hidden></div>' : ''}
      </div>`; }).join('')}</section>`).join('');
}
el('artSets').addEventListener('change', () => { if (artCurrent != null) openArticle(artCurrent); });
el('artBody').addEventListener('click', e => {
  const btn = e.target.closest('.art-more'); if (!btn) return;
  const row = btn.closest('.art-sent'), box = row.querySelector('.art-detail');
  if (box.hidden && !box.innerHTML){ box.innerHTML = renderSentence(artSentences.get(Number(row.dataset.index)), false); }
  box.hidden = !box.hidden;
  btn.textContent = box.hidden ? '展開分析' : '收起分析';
  if (!box.hidden) layoutPosLabels();
});
el('artBack').addEventListener('click', () => { artCurrent = null; el('artView').hidden = true; el('artList').hidden = false; loadArticles(); });

// ---- 改名與刪除（頁內操作，不用瀏覽器的對話框）----
el('artRename').addEventListener('click', () => {
  const c = el('artConfirm');
  c.hidden = false;
  c.innerHTML = `<div class="row"><input type="text" id="artNewName" maxlength="60" value="${esc(el('artTitle').textContent)}" aria-label="新的文章名稱">
    <button class="primary" type="button" id="artRenameOk">改名</button><button class="linky" type="button" id="artRenameNo">取消</button>
    <span class="hint" id="artRenameMsg"></span></div>`;
  el('artNewName').focus();
  el('artRenameNo').onclick = () => { c.hidden = true; };
  el('artRenameOk').onclick = async () => {
    const r = await artApi('/api/article-rename', { method: 'POST', body: { id: artCurrent, name: el('artNewName').value } });
    if (!r.ok){ el('artRenameMsg').textContent = r.json.message || '改名失敗'; return; }
    c.hidden = true; await openArticle(artCurrent); await refreshArticleNames();
  };
});
el('artDelete').addEventListener('click', async e => {
  const b = e.currentTarget;
  if (b.dataset.armed !== '1'){                                // 第一次按：進入確認狀態；第二次才真的刪
    b.dataset.armed = '1'; b.textContent = '再按一次確定刪除';
    setTimeout(() => { b.dataset.armed = '0'; b.textContent = '刪除'; }, 4000);
    return;
  }
  b.dataset.armed = '0'; b.textContent = '刪除';
  const r = await artApi(`/api/articles?ids=${artCurrent}`, { method: 'DELETE' });
  if (r.ok){ artCurrent = null; el('artView').hidden = true; el('artList').hidden = false; await loadArticles(); await refreshArticleNames(); }
});

// ---- 上次分析沒完成：提示接續 ----
function showPendingNotice(){
  const p = getPending(), box = el('artConfirm');
  if (!p || !box || !box.hidden) return;
  const n = (p.text.match(/[.!?](s|$)/g) || []).length;
  box.innerHTML = `<p class="ac-title">上次「${esc(p.name)}」的分析沒有完成（約 ${n} 句）。</p>
    <p class="hint">已經分析好的句子還在，接續只會處理剩下的，也會先給你看報價。</p>
    <div class="row"><button class="primary" type="button" id="artResume">按此繼續</button>
    <button class="linky" type="button" id="artDrop">放棄</button></div>`;
  box.hidden = false;
  el('artResume').onclick = () => { box.hidden = true; el('inp').value = p.text; if (typeof updateCount === 'function') updateCount(); el('artName').value = p.name; analyzeAsArticle(p.name, p.text); };
  el('artDrop').onclick = () => { setPending(null); box.hidden = true; };
}
showPendingNotice();

// ---- 展開後的完整分析卡：「詳解」「朗讀」按鈕（即時分析頁的處理只掛在那一頁，這裡要自己接）----
el('artBody').addEventListener('click', e => {
  const more = e.target.closest('.more');
  if (more){
    const open = more.getAttribute('aria-expanded') !== 'true';
    more.setAttribute('aria-expanded', String(open));
    more.textContent = open ? '收起 －' : '詳解 ＋';
    more.nextElementSibling.hidden = !open;
    return;
  }
  const say = e.target.closest('.say');
  if (say && typeof toggleSay === 'function') toggleSay(say.closest('.sent'));
});
