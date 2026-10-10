// 分析頁連後端：送出文字、接 SSE 串流、逐句顯示、中斷與提示。
// 經典腳本（不是 ES module）：和其他 js/*.js 共用全域，由 index.html 依固定順序載入，順序不能換。

// ---- 後端連線 ----
const goBtn = document.getElementById('go');
const hintEl = document.getElementById('inp-hint');
let API = null;   // null = 尚未確認, false = 無後端（靜態展示）, true = 可用

// 需要權杖時，從網址 ?token= 取得並記住（分享給別人時帶著這個參數）
let TOKEN = '';
try {
  const q = new URLSearchParams(location.search).get('token');
  if (q){ TOKEN = q; localStorage.setItem('analyzer-token', q); }
  else TOKEN = localStorage.getItem('analyzer-token') || '';
} catch { /* 無痕模式等情況，忽略 */ }

/** 沒有（或存取碼不對）時：頁面最上面出現一個輸入框，輸入後記住、重新整理。手機不用再去編網址。 */
function showTokenBanner(msg){
  let b = document.getElementById('tokenBanner');
  if (!b){
    b = document.createElement('div'); b.id = 'tokenBanner'; b.className = 'token-banner';
    b.innerHTML = '<p class="tb-msg"></p><div class="row"><input type="text" id="tokenInput" placeholder="貼上存取碼" autocomplete="off" autocapitalize="off" spellcheck="false"><button class="primary" type="button" id="tokenSave">儲存並重新載入</button></div>';
    document.body.insertBefore(b, document.body.firstChild);
    document.getElementById('tokenSave').onclick = () => {
      const v = document.getElementById('tokenInput').value.trim(); if (!v) return;
      try { localStorage.setItem('analyzer-token', v); } catch {}
      location.href = location.pathname + '?token=' + encodeURIComponent(v);
    };
  }
  b.querySelector('.tb-msg').textContent = msg;
  b.hidden = false;
}

// 同網域的 /api/ 請求一律自動帶存取碼；收到 401 就跳出輸入框。這樣每個頁面（單字、歷史、弱點…）
// 不必各自記得帶，也不會因為忘了帶而讀不到資料。
const _fetch = window.fetch.bind(window);
window.fetch = (input, init = {}) => {
  const url = typeof input === 'string' ? input : input?.url || '';
  if (!url.startsWith('/api/') || !TOKEN) return _fetch(input, init).then(noteUnauthorized(url));
  const headers = new Headers(init.headers || {});
  if (!headers.has('x-auth-token')) headers.set('x-auth-token', TOKEN);
  return _fetch(input, { ...init, headers }).then(noteUnauthorized(url));
};
const noteUnauthorized = url => res => {
  if (res.status === 401 && url.startsWith('/api/')) showTokenBanner(TOKEN ? '存取碼不對，請重新輸入。' : '這個網站需要存取碼才能使用。請輸入存取碼（只要輸入一次，這個瀏覽器會記住）。');
  return res;
};

fetch('/api/health').then(r => r.ok ? r.json() : Promise.reject()).then(h => {
  API = h;
  updateCount();
  loadSampleCounts();
  if (typeof refreshArticleNames === 'function') refreshArticleNames();     // articles.js 在後面載入，這裡已經是非同步，一定有了
  if (h.authRequired && !TOKEN) showTokenBanner('這個網站需要存取碼才能使用。請輸入存取碼（只要輸入一次，這個瀏覽器會記住）。');
  hintEl.textContent = h.authRequired && !TOKEN
    ? '這個後端需要存取權杖。請用帶有 ?token=… 的網址開啟。'
    : `已連上分析後端（${h.model}）。可貼上一句話或一段文章，上限 ${h.maxChars} 字 / ${h.maxSentences} 句。`;
}).catch(() => {
  API = false;
  // 文章表要存在後端，展示模式用不到：藏起來，不要讓人以為可以用
  document.getElementById('artNameRow')?.setAttribute('hidden', '');
  document.getElementById('anTabs')?.setAttribute('hidden', '');
  hintEl.textContent = '展示模式：沒有連上後端，請點下方範例標籤。要分析任意輸入請在本機執行 npm start。';
  // 這三個分頁在展示模式下沒有資料可用，明確標出來，不要讓人以為點不動
  for (const v of ['words', 'practice', 'weak', 'history']){
    const b = document.querySelector(`.tabs button[data-view="${v}"]`);
    if (!b) continue;
    b.classList.add('needs-api');
    b.title = '需要後端才能使用。請在本機執行 npm start 後開啟 http://127.0.0.1:8787';
  }
  document.querySelector('.tabs')?.insertAdjacentHTML('afterend',
    '<p class="demo-note">「單字」「句子練習」「弱點」「歷史」需要本機後端才能使用。' +
    '這個線上版只能看分析範例與試聽朗讀。</p>');
});

function placeholder(index, original, state){
  return `<article class="sent pending" data-index="${index}">
    <div class="badges"><span class="badge idx">${index + 1}</span>
      <span class="badge"><span class="spin"></span>${esc(state)}</span></div>
    <div class="body"><p class="line">${esc(original)}</p></div></article>`;
}

/** opts.article：文章模式（上限較高，存文章表用）。回傳 { total, done, failed, halted, truncated, interrupted, error }，
 *  呼叫端（例如存成文章表）靠它判斷是不是全部都分析成功。 */
let dlgInfo = null;       // 對話：每一句是誰說的、第幾次發言
/** 對話：同一個人說的幾句框成一組。上面先放說話者、整段原文與整段翻譯，下面再接每一句的分析卡。 */
function groupDialogue(slots, trans){
  const turns = new Map();
  for (const [i, html] of [...slots.entries()].sort((a, b) => a[0] - b[0])){
    const d = dlgInfo[i]; if (!d) continue;
    if (!turns.has(d.turn)) turns.set(d.turn, { speaker: d.speaker, idx: [] });
    turns.get(d.turn).idx.push([i, html]);
  }
  return [...turns.values()].map(t => {
    const en = t.idx.map(([i]) => dlgInfo[i].text).join(' ');
    const zh = t.idx.map(([i]) => trans.get(i)).filter(Boolean).join('');
    return `<section class="turn-group"><div class="turn-head"><span class="who">${esc(t.speaker)}</span>
      <p class="turn-en">${esc(en)}</p>${zh ? `<p class="turn-zh">${esc(zh)}</p>` : ''}</div>${t.idx.map(([, h]) => h).join('')}</section>`;
  }).join('');
}
async function analyzeLive(text, opts = {}){
  curKind = null;                   // 分析自己的句子時不是在看範例
  goBtn.disabled = true;
  Spk.stop();
  usageBar.hidden = true;
  out.innerHTML = '<p class="msg">斷句中…</p>';
  const t0 = Date.now();
  let total = 0, done = 0, gotDone = false;
  const summary = { total: 0, done: false, failed: 0, halted: null, truncated: false, interrupted: false, error: null };
  const slots = new Map();
  const trans = new Map();        // 對話：每一句的翻譯，組成整段翻譯用
  const settled = new Set();      // 已有結果（成功或失敗）的句子

  // 伺服器若中途消失，瀏覽器的 fetch 串流不一定會結束（實測砍掉後端後 read() 會一直懸著，
  // 且 AbortController 也打不斷已開始讀取的 body），所以讓每次讀取跟逾時賽跑。
  // 後端每 8 秒送一次心跳，30 秒收不到任何資料就代表後端真的不在了，
  // 不會誤殺還在分析的長句。
  const STALL_MS = 30_000;
  const ctrl = new AbortController();

  const paint = () => {
    out.innerHTML = dlgInfo ? groupDialogue(slots, trans) : [...slots.entries()].sort((a, b) => a[0] - b[0]).map(([, html]) => html).join('');
    if (out.dataset.mode === 'full') openAll(true);
    layoutPosLabels();
  };

  try {
    const res = await fetch('/api/analyze', {
      method: 'POST',
      signal: ctrl.signal,
      headers: { 'content-type': 'application/json', ...(TOKEN ? { 'x-auth-token': TOKEN } : {}) },
      body: JSON.stringify({ text, article: opts.article === true }),
    });
    if (!res.ok){
      const e = await res.json().catch(() => ({}));
      summary.error = e.error || String(res.status);
      out.innerHTML = `<p class="msg">${esc(
        e.error === 'too long' ? `文章太長了（${e.got} 字），目前上限 ${e.maxChars} 字。請分批貼上。` :
        e.error === 'empty' ? '請先輸入英文。' :
        res.status === 401 ? '存取權杖不正確或未提供。請用帶有 ?token=… 的網址開啟。' :
        '分析失敗：' + (e.error || res.status))}</p>`;
      return summary;
    }

    const reader = res.body.getReader();
    const dec = new TextDecoder();
    let buf = '';
    const readOrStall = () => {
      let timer;
      return Promise.race([
        reader.read(),
        new Promise((_, rej) => { timer = setTimeout(() => rej(new Error('stalled')), STALL_MS); }),
      ]).finally(() => clearTimeout(timer));
    };
    for (;;){
      const { value, done: fin } = await readOrStall();
      if (fin) break;
      buf += dec.decode(value, { stream: true });
      const parts = buf.split('\n\n');
      buf = parts.pop();
      for (const chunk of parts){
        const ev = /^event: (.+)$/m.exec(chunk)?.[1];
        const dataLine = /^data: (.+)$/m.exec(chunk)?.[1];
        if (!ev || !dataLine) continue;
        const d = JSON.parse(dataLine);

        if (ev === 'meta'){
          total = d.total; dlgInfo = d.dialogue || null;
          summary.total = d.total; summary.truncated = Boolean(d.truncated);
          for (let i = 0; i < total; i++) slots.set(i, placeholder(i, '', '分析中'));
          paint();
          hintEl.textContent = d.truncated
            ? `這段文章超過 ${d.maxSentences} 句，只分析前 ${d.maxSentences} 句。`
            : `共 ${total} 句，分析中…`;
        } else if (ev === 'sentence'){
          slots.set(d.index, renderSentence(d.sentence, total > 1)); trans.set(d.index, d.sentence?.translation || '');
          settled.add(d.index);
          paint();
        } else if (ev === 'failed'){
          summary.failed++;
          slots.set(d.index, `<article class="sent"><div class="badges">
            <span class="badge idx">${d.index + 1}</span><span class="badge warn">分析失敗</span></div>
            <div class="body"><p class="line">${esc(d.original)}</p>
            <p class="fallback">${esc(d.message)}</p></div></article>`);
          settled.add(d.index);
          paint();
        } else if (ev === 'halted'){
          summary.halted = d.kind;
          const msg = d.kind === 'rate-limit'
            ? 'Claude 訂閱額度似乎已用盡，剩下的句子沒有送出。等額度重置後再試，已完成的句子仍會保留在快取。'
            : 'Claude 認證失效。請在終端機執行 claude 重新登入後再試。';
          usageBar.innerHTML = `<span class="u halt"><b>⚠</b> ${esc(msg)}</span>
            <span class="note">原始訊息：${esc(d.message)}</span>`;
          usageBar.hidden = false;
          markUnfinished(slots, settled, total, '沒有送出分析');
          paint();
        } else if (ev === 'progress'){
          done = d.done;
          hintEl.textContent = `分析中 ${done} / ${d.total} 句…`;
        } else if (ev === 'done'){
          gotDone = true; summary.done = true;
          showUsage(d);
          hintEl.textContent = '可以再貼新的一段，或切到「句子練習」從這些句子出題。';
        }
      }
    }
    if (!gotDone && total && settled.size < total){
      summary.interrupted = true;
      markUnfinished(slots, settled, total, '分析被中斷');
      paint();
      showInterrupted(total - settled.size, text, opts);
    }
  } catch (e){
    summary.error = e.message;
    if (total && settled.size < total){
      summary.interrupted = true;
      markUnfinished(slots, settled, total, '分析中斷');
      paint();
      showInterrupted(total - settled.size, text, opts);
    } else {
      out.innerHTML = `<p class="msg">連線失敗：${esc(e.message)}。` +
        `請確認後端有在執行（npm start）後再試一次。</p>`;
    }
  } finally {
    try { ctrl.abort(); } catch { /* 釋放連線，失敗無妨 */ }
    goBtn.disabled = false;
  }
  return summary;
}

/** 把還在轉圈的句子換成「未完成」狀態，不要讓它永遠轉下去 */
function markUnfinished(slots, settled, total, reason){
  for (let i = 0; i < total; i++){
    if (settled.has(i)) continue;
    slots.set(i, `<article class="sent"><div class="badges">
      <span class="badge idx">${i + 1}</span><span class="badge warn">${esc(reason)}</span></div>
      <div class="body"><p class="zh" style="border:0;padding:0;margin:0">
        這句還沒分析完。按下方的「重新分析」即可補上 —— 已完成的句子都在快取裡，不會重跑。
      </p></div></article>`);
  }
}

function showInterrupted(n, text, opts = {}){
  usageBar.innerHTML = `<span class="u halt"><b>⚠</b> 分析在完成前中斷，還有 ${n} 句沒有結果。</span>
    <span class="note">最常見的原因是後端重新啟動或停止。已完成的句子都存進快取了，
      按「重新分析」只會處理剩下那幾句。</span>
    <button class="retry" type="button">重新分析</button>`;
  usageBar.hidden = false;
  // 存文章表的分析中斷時，重試要連「存成文章表」一起做（opts.retry 由 articles.js 提供）
  usageBar.querySelector('.retry')?.addEventListener('click', () => (opts.retry ? opts.retry() : analyzeLive(text, opts)));
}

goBtn.addEventListener('click', () => {
  const text = inpEl.value.trim();
  if (!text) return;
  // 填了文章名稱 → 存成文章表（流程在 articles.js）；沒填就是原本的分析
  if (API && typeof articleNameValue === 'function' && articleNameValue()){ analyzeAsArticle(articleNameValue(), text); return; }
  if (API){ analyzeLive(text); return; }
  // 展示模式：比對內建範例
  const norm = s => s.trim().replace(/\s+/g, ' ').toLowerCase();
  const hit = Object.keys(DATA).find(k => norm(DATA[k].input) === norm(text));
  if (hit) render(hit);
  else hintEl.textContent = API === false
    ? '展示模式只能顯示內建範例。要分析任意輸入，請在本機執行 npm start 後開啟 http://127.0.0.1:8787'
    : '正在確認後端連線，請稍候再按一次。';
});
inpEl.addEventListener('keydown', e => {
  if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') goBtn.click();
});

const tipEl = document.getElementById('tip');
function showTip(w){
  const c = w.closest('.c');
  const p = POS[w.dataset.pos] || { zh:w.dataset.pos, why:'' };
  const r = c ? ROLE[c.dataset.role] : null;
  const kase = w.dataset.case ? CASE[w.dataset.case] : null;
  tipEl.innerHTML = `<span class="t-word">${esc(w.dataset.text)}</span>
    <span class="t-ln"><span class="t-k">${esc(w.dataset.pos)}</span>${esc(kase ? kase.zh : p.zh)}
      <span class="t-why">${esc(kase ? kase.why : p.why)}</span></span>
    ${r ? `<span class="t-ln"><span class="t-k">${esc(r.code)}</span>${esc(r.zh)}
      <span class="t-why">${esc(r.why)}</span></span>` : ''}
    ${w.dataset.v3 ? `<span class="t-ln"><span class="t-k">三態</span><span class="t-v3">${esc(w.dataset.v3)}</span>
      <span class="t-why">${w.dataset.irr === '1' ? '不規則變化，要背起來' : '規則變化，過去式與過去分詞都是 ＋ed'}</span></span>` : ''}`;
  tipEl.dataset.show = '1';
  const b = w.getBoundingClientRect(), t = tipEl.getBoundingClientRect();
  let left = b.left + b.width / 2 - t.width / 2;
  left = Math.max(16, Math.min(left, window.innerWidth - t.width - 16));
  let top = b.top - t.height - 10;
  if (top < 8) top = b.bottom + 10;
  tipEl.style.left = left + 'px';
  tipEl.style.top = top + 'px';
}
const hideTip = () => { tipEl.dataset.show = '0'; };
out.addEventListener('pointerover', e => { const w = e.target.closest('.w'); w ? showTip(w) : hideTip(); });
out.addEventListener('pointerleave', hideTip);
out.addEventListener('focusin', e => { const w = e.target.closest('.w'); if (w) showTip(w); });
out.addEventListener('focusout', hideTip);
window.addEventListener('scroll', hideTip, { passive: true });
document.addEventListener('keydown', e => { if (e.key === 'Escape') hideTip(); });

let rz;
window.addEventListener('resize', () => { clearTimeout(rz); rz = setTimeout(layoutPosLabels, 120); });
document.fonts?.ready.then(layoutPosLabels);

render('p1');          // 分析分頁先備好範例，切過去就看得到
autoGrow(); updateCount();
