// 資料與常數、句子的渲染（成分、詞性、詳解）、側欄與圖例、輸入框、用量列。
// 經典腳本（不是 ES module）：和其他 js/*.js 共用全域，由 index.html 依固定順序載入，順序不能換。

const DATA = JSON.parse(document.getElementById('data').textContent);

// speech.js 若沒載入（例如單獨複製 index.html 出去），用這組空殼擋住，
// 讓頁面其餘功能完全不受影響。
const Spk = window.Speech || {
  ready: async () => false, available: () => false, voices: () => [],
  activeVoice: () => null, settings: { rate: 0.85 }, setSettings: () => {},
  speak: (_t, o) => o?.onError?.(new Error('朗讀模組未載入')), stop: () => {}, speaking: () => false,
};

const ROLE = {
  S:{code:'S',zh:'主詞',kind:'core',why:'做動作的人或事物'},
  V:{code:'V',zh:'動詞',kind:'core',why:'動作或狀態，含助動詞'},
  O:{code:'O',zh:'受詞',kind:'core',why:'動作的對象'},
  C:{code:'C',zh:'補語',kind:'core',why:'補充說明主詞或受詞「是什麼、怎麼樣」'},
  IO:{code:'IO',zh:'間接受詞',kind:'core',why:'收到東西的人'},
  DO:{code:'DO',zh:'直接受詞',kind:'core',why:'被給出去的東西'},
  'M-manner':{code:'方',zh:'方式修飾語',kind:'mod',why:'怎麼做 — 拿掉句子仍完整'},
  'M-place':{code:'地',zh:'地點修飾語',kind:'mod',why:'在哪裡 — 拿掉句子仍完整'},
  'M-time':{code:'時',zh:'時間修飾語',kind:'mod',why:'什麼時候 — 拿掉句子仍完整'},
  'M-freq':{code:'頻',zh:'頻率修飾語',kind:'mod',why:'多常發生 — 拿掉句子仍完整'},
  'M-other':{code:'修',zh:'修飾語',kind:'mod',why:'判斷句型時先忽略'},
};
const CASE = {
  subject:        { zh:'主格',       short:'主',   why:'當主詞，放在動詞前面' },
  object:         { zh:'受格',       short:'受',   why:'當動詞或介系詞的受詞' },
  possessive:     { zh:'所有格',     short:'所有', why:'後面一定接名詞，例如 my book' },
  'possessive-pron':{ zh:'所有格代名詞', short:'所代', why:'後面不接名詞，自己當名詞用' },
  reflexive:      { zh:'反身代名詞', short:'反身', why:'強調「自己」，例如 by himself' },
  other:          { zh:'代名詞',     short:'代',   why:'' },
};
// 右側欄的速查表（完整七人稱表太寬，這裡只列最常考的幾個）
const CASE_TABLE = [
  ['主',   'I / he / she / they'],
  ['受',   'me / him / her / them'],
  ['所有', 'my / his / her / their'],
  ['所代', 'mine / his / hers / theirs'],
  ['反身', 'myself / himself / herself'],
];
const POS = {
  adj:{zh:'形容詞',why:'修飾名詞，或當補語說明主詞怎麼樣。連結動詞後面要接這個'},
  adv:{zh:'副詞',why:'修飾動詞、形容詞或另一個副詞。不能當連結動詞的補語'},
  n:{zh:'名詞',why:'人、事、物的名稱'},
  pron:{zh:'代名詞',why:'代替名詞，當受詞要用受格 me / him / them'},
  v:{zh:'動詞',why:'動作或狀態'},
  aux:{zh:'助動詞',why:'幫主要動詞表達時態、否定或疑問'},
  prep:{zh:'介系詞',why:'後面接名詞組成介系詞片語，整組當修飾語'},
  conj:{zh:'連接詞',why:'連接單字、片語或子句'},
  art:{zh:'冠詞',why:'a / an / the，放在名詞前面'},
  num:{zh:'數詞',why:'表示數量或順序'},
  to:{zh:'不定詞 to',why:'後面接原形動詞'},
  interj:{zh:'感嘆詞',why:'表達情緒或引起注意'},
};
// 這兩個全檔都在用，宣告放最前面避免 TDZ
const el = id => document.getElementById(id);

// 範例句的狀態。宣告在最前面 —— render() 初始化時就會用到，
// 放後面會踩到 TDZ，整個頁面會死掉（之前 Spk 就是這樣壞過一次）。
let sampleCounts = {}, curKind = null, curIdx = -1;   // curIdx -1 = 正在顯示內建範例

const SAMPLES_A = [
  ['p1','句型一 S+V'],['p2','句型二 S+V+C'],['p3','句型三 S+V+O'],
  ['p4','句型四 S+V+IO+DO'],['p5','句型五 S+V+O+C'],
];
const SAMPLES_B = [
  ['standard','主動賓方地時'],['compare45','句型四／五對照'],['splitVerb','動詞分段'],
  ['errorCase','含文法錯誤'],['compound','對等連接詞'],['outOfScope','超出範圍'],
  ['paragraph','整段文章'],
];
const SAMPLES = [...SAMPLES_A, ...SAMPLES_B];
// 實詞：句子下方預設只標這些，虛詞改由游標提示與詳解呈現（短字如 a / I 的標籤會擠在一起）
const CONTENT_POS = new Set(['n','v','adj','adv','aux']);
const esc = s => String(s ?? '').replace(/[&<>"]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));

// ---- 左側欄：句子成分 ----
const CORE = ['S','V','O','C','IO','DO'];
const MODS = ['M-manner','M-place','M-time','M-freq'];
document.getElementById('rail-c').innerHTML = `<h3>句子成分</h3><ul>
  ${CORE.map(r => `<li style="--k:var(--c-${r.toLowerCase()})"><i style="background:var(--c-${r.toLowerCase()})"></i><em>${r}</em>${ROLE[r].zh}</li>`).join('')}
  <li class="div"></li>
  <li><i style="background:repeating-linear-gradient(90deg,var(--c-mod) 0 3px,transparent 3px 6px)"></i><em style="--k:var(--c-mod)">修</em>修飾語</li>
  ${MODS.map(r => `<li class="sub"><em>${ROLE[r].code}</em>${ROLE[r].zh.replace('修飾語','')}</li>`).join('')}
</ul><div class="foot">判斷句型前先把修飾語劃掉，看動詞後面還剩什麼。</div>`;

// ---- 右側欄：詞性 ----
const POS_ORDER = ['adj','adv','n','pron','v','aux','prep','conj','art','num','to'];
document.getElementById('rail-p').innerHTML = `<h3>詞性</h3><ul>
  ${POS_ORDER.map(p => {
    const hot = p === 'adj' || p === 'adv';
    const k = hot ? `var(--pos-${p})` : 'var(--muted)';
    return `<li class="${hot ? 'hot' : ''}"><em style="--k:${k}">${p}</em>${POS[p].zh}</li>`;
  }).join('')}
</ul>
  <h3 style="margin-top:14px">代名詞格位</h3>
  <ul>${CASE_TABLE.map(([k, v]) =>
    `<li><em style="--k:var(--pos-pron);min-width:2.8em">${k}</em>
       <span style="font-family:var(--font-en);font-size:.78rem">${v}</span></li>`).join('')}</ul>
  <div class="foot">所有格後面一定接名詞（my <b>book</b>），所有格代名詞後面不接（This is <b>mine</b>）。
    <br>切到「代名詞」模式可以只看格位。</div>
  <div class="foot" style="border:0;padding-top:4px;margin-top:4px">形容詞與副詞用顏色標出 —— 連結動詞後面只能接形容詞。<br><br>動詞標成 <b style="color:var(--c-v);font-family:var(--font-mono)">v°</b> 表示不規則變化，展開詳解可看三態。<br><br>目前只標實詞，虛詞（冠詞、介系詞、連接詞、代名詞）改用游標提示。</div>`;

// ---- 窄螢幕的橫向圖例 ----
document.getElementById('legend-inline').innerHTML = `
  <div class="lrow"><b>成分</b>${CORE.map(r =>
    `<span><i style="background:var(--c-${r.toLowerCase()})"></i><em style="color:var(--c-${r.toLowerCase()})">${r}</em>${ROLE[r].zh}</span>`).join('')}
    <span><i style="background:repeating-linear-gradient(90deg,var(--c-mod) 0 3px,transparent 3px 6px)"></i>修飾語（方／地／時／頻）</span></div>
  <div class="lrow"><b>詞性</b>
    <span><em style="color:var(--pos-adj)">adj</em>形容詞</span>
    <span><em style="color:var(--pos-adv)">adv</em>副詞</span>
    <span style="color:var(--faint)"><em>n ／ v ／ aux</em>其餘實詞以灰色標示</span><span><em style="color:var(--c-v)">v°</em>不規則動詞</span>
    <span><em style="color:var(--pos-pron)">主／受／所有／所代</em>代名詞格位</span></div>`;

/** 找出這個字所屬子句的動詞資料（用來顯示三態） */
function verbInfoFor(sent, w){
  for (const cl of sent.clauses || []){
    const v = cl.verb;
    if (!v?.forms) continue;
    if (String(v.form || '').split(/\s+/).includes(w.text)) return v;
  }
  return null;
}

/** 把原句切成「純文字」與「成分」交錯的片段 — 原文完整保留，不增不減 */
function segments(sent){
  const cs = (sent.clauses || []).flatMap(cl =>
    (cl.constituents || []).filter(c => Number.isInteger(c.start)));
  cs.sort((a, b) => a.start - b.start || b.end - a.end);
  const segs = [];
  let pos = 0;
  for (const c of cs){
    if (c.start < pos) continue;
    if (c.start > pos) segs.push({ plain:true, from:pos, to:c.start });
    segs.push({ c, from:c.start, to:c.end });
    pos = c.end;
  }
  if (pos < sent.original.length) segs.push({ plain:true, from:pos, to:sent.original.length });
  return segs;
}

/** 渲染原句的 [from,to) 區間：落在區間內的單字包成詞性 span，其餘（空白、標點）原樣輸出 */
function renderRange(sent, from, to){
  const ws = (sent.words || []).filter(w => Number.isInteger(w.start) && w.start >= from && w.end <= to);
  let html = '', pos = from;
  for (const w of ws){
    if (w.start > pos) html += esc(sent.original.slice(pos, w.start));
    const vb = (w.pos === 'v' || w.pos === 'aux') ? verbInfoFor(sent, w) : null;
    const cs = w.pos === 'pron' ? (CASE[w.case] ? w.case : 'other') : '';
    html += `<span class="w" data-pos="${esc(w.pos)}" data-text="${esc(w.text)}"
      data-s="${w.start}" data-e="${w.end}"${cs ? ` data-case="${esc(cs)}"` : ''} tabindex="0"${
      CONTENT_POS.has(w.pos) ? '' : ' data-fn="1"'}${
      vb ? ` data-v3="${esc([vb.forms.base, vb.forms.past, vb.forms.pastParticiple].join(' · '))}"` : ''}${
      vb?.irregular ? ' data-irr="1"' : ''}
      ><i class="plbl">${esc(cs ? CASE[cs].short : w.pos)}</i>${esc(w.text)}</span>`;
    pos = w.end;
  }
  if (pos < to) html += esc(sent.original.slice(pos, to));
  return html;
}

function renderLine(sent){
  return segments(sent).map(s => {
    const inner = renderRange(sent, s.from, s.to);
    if (s.plain) return inner;
    const r = ROLE[s.c.role] || { code:'?', kind:'mod' };
    return `<span class="c ${r.kind}" data-role="${esc(s.c.role)}"><i class="lbl">${esc(r.code)}</i>${inner}</span>`;
  }).join('');
}

function wordOrderTable(wo){
  const keys = ['主','動','賓','方','地','時'];
  if (!wo || keys.every(k => !wo[k])) return '';
  return `<div><h4>主、動、賓、方、地、時</h4><div class="wo-scroll"><table class="wo"><tr>
    ${keys.map(k => `<th>${k}</th>`).join('')}</tr><tr>
    ${keys.map(k => wo[k] ? `<td>${esc(wo[k])}</td>` : `<td class="none">—</td>`).join('')}
  </tr></table></div></div>`;
}

function posList(sent){
  const ws = sent.words || [];
  if (!ws.length) return '';
  return `<div><h4>逐字詞性</h4><div class="poslist">${ws.map(w => {
    const c = w.pos === 'pron' && CASE[w.case] ? w.case : '';
    return `<span class="poschip" data-pos="${esc(w.pos)}"${c ? ` data-case="${esc(c)}"` : ''}>` +
      `<b>${esc(w.text)}</b><em>${esc(c ? CASE[c].zh : w.pos)}</em></span>`;
  }).join('')}</div></div>`;
}

/** 動詞三態表：句中出現的那一格會被標出來 */
function verbFormsTable(v){
  const f = v?.forms; if (!f) return '';
  const used = String(v.form || '').split(/\s+/);
  const cols = [['原形','base'],['過去式','past'],['過去分詞','pastParticiple'],['-ing','ing'],['三單','third']];
  return `<div class="v3${v.irregular ? ' irr' : ''}">
    <div class="v3-head">動詞三態${v.irregular
      ? '<span class="v3-tag">不規則變化，要背</span>'
      : '<span class="v3-tag reg">規則變化（＋ed）</span>'}</div>
    <div class="wo-scroll"><table class="wo v3-table"><tr>${
      cols.map(([zh]) => `<th>${zh}</th>`).join('')}</tr><tr>${
      cols.map(([, k]) => {
        const val = f[k] || '—';
        const hit = used.includes(val);
        return `<td class="${hit ? 'hit' : ''}">${esc(val)}</td>`;
      }).join('')}</tr></table></div></div>`;
}

function clauseDetail(cl){
  const t = cl.tense || {}, v = cl.verb || {};
  const ev = (t.evidence || []).map(e => `<b>${esc(e)}</b>`).join('');
  return `<div class="cl">
    <div class="cl-head"><span class="tag">${cl.role === 'main' ? '主句' : '從屬子句'}${
      cl.connector ? ` / ${esc(cl.connector)}` : ''}</span><b>${esc(cl.pattern?.name || '')}</b>
      <code style="font-family:var(--font-mono);font-size:.82rem;color:var(--accent)"> ${esc(cl.pattern?.label || '')}</code></div>
    <div class="kv">
      時態：<b>${esc(t.label || '')}</b> <code>${esc(t.formula || '')}</code>
      ${t.inScope === false ? ' <span style="color:var(--err)">· 超出國中必學 6 種</span>' : ''}<br>
      ${ev ? `判斷線索：<span class="ev">${ev}</span><br>` : ''}
      動詞：<b>${esc(v.form || '')}</b> ← 原形 ${esc(v.lemma || '')}
    </div>
    ${verbFormsTable(v)}</div>`;
}

function renderSentence(sent, showIdx){
  const main = (sent.clauses || []).find(c => c.role === 'main') || (sent.clauses || [])[0] || {};
  const aligned = (sent.clauses || []).every(c => c.alignment?.ok !== false) && sent.wordAlignment?.ok !== false;
  const notes = sent.notes || [];
  const errs = notes.filter(n => n.type === 'error');

  const ISSUE = {
    'not-english':  '不是英文',
    'fragment':     '不是完整句子',
    'unintelligible':'無法辨識',
  };
  /** 考卷填空題本來就有空格，標成紅色的「不是完整句子」像是出錯了。
   *  句子裡有底線空格時改標中性的「填空題」，其餘情況照舊。 */
  const hasBlank = t => /_{2,}/.test(String(t ?? ''));
  const issueBadge = sent => {
    if (hasBlank(sent.original)) return '<span class="badge blank">填空題</span>';
    return sent.issue ? `<span class="badge warn">${esc(ISSUE[sent.issue] || sent.issue)}</span>` : '';
  };
  /** 句型寫 S+V+C 但原句沒有 S 或 V（祈使句省略 you、感嘆句省略 it is…）時，圖上自然只會有其餘成分。
   *  標出被省略的是哪些，避免標題和圖對不起來。已標「不是完整句子」或填空題的不重複。 */
  const omittedBadge = (cl, s) => {
    if (s.issue || hasBlank(s.original) || !cl.pattern?.label) return '';
    const have = new Set((cl.constituents || []).map(c => c.role));
    const miss = ['S', 'V'].filter(r => new RegExp('\\b' + r + '\\b').test(cl.pattern.label) && !have.has(r));
    return miss.length
      ? `<span class="badge" title="這句沒有寫出 ${miss.join('、')}，詳見下方提醒">${miss.join('、')} 省略</span>` : '';
  };
  const badges = [
    showIdx ? `<span class="badge idx">${(sent.index ?? 0) + 1}</span>` : '',
    issueBadge(sent),
    main.pattern?.name ? `<span class="badge"><b>${esc(main.pattern.name)}</b><code>${esc(main.pattern.label || '')}</code></span>` : '',
    omittedBadge(main, sent),
    main.tense?.label ? `<span class="badge"><b>${esc(main.tense.label)}</b></span>` : '',
    errs.length ? `<span class="badge warn">${errs.length} 處文法問題</span>` : '',
    sent.inScope === false ? `<span class="badge warn">超出國中範圍</span>` : '',
  ].filter(Boolean).join('');

  const line = aligned
    ? `<p class="line">${renderLine(sent)}</p>`
    : `<p class="line">${esc(sent.original)}</p>
       <p class="fallback">座標對齊失敗，已降級為清單顯示，原句未受影響。<br>${
         (main.constituents || []).map(c => `${esc(c.text)} — ${esc((ROLE[c.role] || {}).zh || c.role)}`).join('／')}</p>`;

  const noteHtml = notes.length ? `<div><h4>提醒</h4><div class="notes">${notes.map(n => {
    const isErr = n.type === 'error';
    return `<div class="note ${isErr ? 'error' : 'tip'}">
      <span class="tag">${isErr ? `文法問題 · ${esc(n.errorCode || '')}` : '學習提示'}</span>
      ${esc(n.message)}
      ${isErr && n.correction ? `<span class="fix"><s>${esc(n.span || '')}</s><i>→</i><b>${esc(n.correction)}</b></span>` : ''}
    </div>`;
  }).join('')}</div></div>` : '';

  const sayable = (sent.original || '').trim();
  return `<article class="sent" data-sent="${esc(sayable)}">
    <div class="badges">${badges}${sayable
      ? `<button class="say" type="button" aria-label="朗讀這句" title="朗讀這句">
           <span class="ico" aria-hidden="true"></span><span class="txt">朗讀</span></button>` : ''}</div>
    <div class="body">
      ${line}
      <p class="zh">${esc(sent.translation || '')}</p>
      ${(sent.clauses || []).length || (sent.words || []).length || (sent.notes || []).length
        ? '<button class="more" aria-expanded="false">詳解 ＋</button>' : ''}
      <div class="detail" hidden>
        ${wordOrderTable(sent.wordOrder)}
        ${posList(sent)}
        ${(sent.clauses || []).length ? `<div><h4>子句拆解</h4>${sent.clauses.map(clauseDetail).join('')}</div>` : ''}
        ${noteHtml}
      </div>
    </div></article>`;
}

const out = document.getElementById('out');

/** 詞性標籤防重疊：短字（in / the）的標籤會互相黏住，偵測到就錯開到第二列 */
function layoutPosLabels(){
  for (const line of out.querySelectorAll('.line')){
    const labels = [...line.querySelectorAll('.plbl')];
    for (const l of labels) l.classList.remove('lower');
    line.classList.remove('has-lower');
    if (out.dataset.posMode === 'off' || out.dataset.mode === 'clean' || !labels.length) continue;

    let rowRight = [-Infinity, -Infinity], lastTop = null, anyLower = false;
    for (const l of labels){
      const r = l.getBoundingClientRect();
      if (!r.width) continue;                                    // 隱藏的虛詞標籤不參與排版
      if (lastTop === null || Math.abs(r.top - lastTop) > 6) rowRight = [-Infinity, -Infinity]; // 換行就重置
      lastTop = r.top;
      const row = r.left < rowRight[0] + 2 ? 1 : 0;
      if (row === 1){ l.classList.add('lower'); anyLower = true; }
      rowRight[row] = r.right;
    }
    if (anyLower) line.classList.add('has-lower');
  }
}

function render(key){
  Spk.stop();
  const entry = DATA[key];
  if (!entry) return;
  const multi = entry.sentences.length > 1;
  out.innerHTML = entry.sentences.map(s => renderSentence(s, multi)).join('');
  setInput(entry.input);
  for (const c of document.querySelectorAll('.chips-group .chip'))
    c.setAttribute('aria-pressed', String(c.dataset.key === key));
  if (out.dataset.mode === 'full') openAll(true);
  layoutPosLabels();
  curKind = key; curIdx = -1;      // 點標籤＝回到內建範例
}

function openAll(open){
  for (const b of out.querySelectorAll('.more')){
    b.setAttribute('aria-expanded', String(open));
    b.textContent = open ? '收起 －' : '詳解 ＋';
    b.nextElementSibling.hidden = !open;
  }
}

const chipHtml = list => list.filter(([k]) => DATA[k])
  .map(([k, label]) => `<button class="chip" data-key="${k}" aria-pressed="false">${label}</button>`).join('');
document.getElementById('chips-a').innerHTML = chipHtml(SAMPLES_A);
document.getElementById('chips-b').innerHTML = chipHtml(SAMPLES_B);
document.querySelector('.chips-group').addEventListener('click', e => {
  const b = e.target.closest('.chip'); if (!b) return;
  // 再點一次同一個標籤＝換下一句（內建範例 → 自己分析過的 1、2、3… → 回到內建）
  if (b.dataset.key === curKind) nextSample();
  else render(b.dataset.key);
});

for (const b of document.querySelectorAll('.seg button')){
  b.addEventListener('click', () => {
    for (const x of document.querySelectorAll('.seg button')) x.setAttribute('aria-pressed', String(x === b));
    out.dataset.mode = b.dataset.mode;
    openAll(b.dataset.mode === 'full');
    layoutPosLabels();
  });
}

document.getElementById('posSeg').addEventListener('click', e => {
  const b = e.target.closest('button'); if (!b) return;
  for (const x of document.querySelectorAll('#posSeg button')) x.setAttribute('aria-pressed', String(x === b));
  out.dataset.posMode = b.dataset.pm;
  layoutPosLabels();
});

out.addEventListener('click', e => {
  const b = e.target.closest('.more'); if (!b) return;
  const open = b.getAttribute('aria-expanded') !== 'true';
  b.setAttribute('aria-expanded', String(open));
  b.textContent = open ? '收起 －' : '詳解 ＋';
  b.nextElementSibling.hidden = !open;
});


// 輸入框隨內容自動展開，最高 56vh，超過才出現內部捲軸
const inpEl = document.getElementById('inp');
const countEl = document.getElementById('inpCount');
function autoGrow(){
  inpEl.style.height = 'auto';
  const max = Math.max(160, Math.round(window.innerHeight * 0.56));
  const h = Math.min(inpEl.scrollHeight, max);
  inpEl.style.height = h + 'px';
  inpEl.style.overflowY = inpEl.scrollHeight > h + 1 ? 'auto' : 'hidden';
}
function updateCount(){
  const n = [...inpEl.value].length;
  const max = (API && API.maxChars) || 4000;
  countEl.textContent = `${n.toLocaleString('en-US')} / ${max.toLocaleString('en-US')} 字`;
  countEl.classList.toggle('near', n > max * 0.8 && n <= max);
  countEl.classList.toggle('over', n > max);
}
/** 程式設定內容後要手動呼叫，input 事件不會自己觸發 */
function setInput(text){ inpEl.value = text; autoGrow(); updateCount(); }
inpEl.addEventListener('input', () => { autoGrow(); updateCount(); });
window.addEventListener('resize', autoGrow);

const nf = n => Number(n || 0).toLocaleString('en-US');
const money = n => '$' + Number(n || 0).toFixed(n < 0.01 ? 4 : 3);
const usageBar = document.getElementById('usageBar');

function showUsage(d){
  const u = d.usage || {};
  const secs = (d.ms / 1000).toFixed(1);
  const parts = [
    `<span class="u">句數 <b>${d.total}</b></span>`,
    `<span class="u">耗時 <b>${secs}s</b></span>`,
  ];
  if (d.analyzed){
    parts.push(`<span class="u">輸入 <b>${nf(u.inputTokens + u.cacheReadTokens)}</b> tokens</span>`);
    parts.push(`<span class="u">輸出 <b>${nf(u.outputTokens)}</b> tokens</span>`);
    parts.push(`<span class="u cost">參考費用 <b>${money(u.costUsd)}</b></span>`);
  }
  if (d.cached) parts.push(`<span class="u saved">快取命中 <b>${d.cached}</b> 句（未重新分析）</span>`);
  if (d.failed) parts.push(`<span class="u">失敗 <b>${d.failed}</b> 句</span>`);
  if (d.analyzed)
    parts.push(`<span class="note">參考費用是依 Claude API 牌價換算的估算值，用來掌握用量規模。` +
      `實際分析走本機 Claude 訂閱，不會另外向你收費，但會消耗訂閱額度 —— ` +
      `剩餘額度請在 Claude app → Settings → Usage 查看。</span>`);
  else if (d.cached)
    parts.push(`<span class="note">這段全部命中快取，沒有重新呼叫模型，不消耗任何額度。</span>`);
  usageBar.innerHTML = parts.join('');
  usageBar.hidden = false;
}
