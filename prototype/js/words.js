// 單字頁：字表清單、選取、單字測驗、拍照縮圖（shrinkImage）。
// 經典腳本（不是 ES module）：和其他 js/*.js 共用全域，由 index.html 依固定順序載入，順序不能換。

// ===== 單字表 =====
const WMODES = [['zh2en','中考英'],['en2zh','英考中'],['listen','聽考'],
                ['cloze','例句填空'],['sense','詞義辨析'],['forms','動詞三態']];
const WMODE_NAME = Object.fromEntries(WMODES);
let wsSel = [];                    // 選取的字表 id（可多選）
let wsMerged = { dup: 0, words: 0 };       // 跨字表合併時有幾個字重複被併起來
let wsAllSets = [];                // 全部字表，新增表單要列出來當目標
let wsCurrent = null, wsQuiz = null, wsWordsCache = [];
const selParam = () => wsSel.join(',');

const wsModesSel = () => [...el('wsModes').querySelectorAll('[aria-pressed="true"]')].map(b => b.dataset.m);

el('wsModes').innerHTML = WMODES.map(([v,l]) =>
  `<button class="tchip" data-m="${v}" aria-pressed="true">${l}</button>`).join('');
el('wsModes').addEventListener('click', e => {
  const b = e.target.closest('.tchip'); if (!b) return;
  const on = b.getAttribute('aria-pressed') !== 'true';
  if (!on && wsModesSel().length <= 1) return;
  b.setAttribute('aria-pressed', String(on));
});

async function loadWordsets(){
  try {
    const d = await fetch(`/api/wordsets?user=${encodeURIComponent(USER)}`).then(r => r.json());
    wsAllSets = d.sets;
    if (!d.sets.length){
      el('wsList').innerHTML = '<span class="hint">還沒有字表。按「＋ 新增字表」貼上老師給的範圍。</span>';
      el('wsPanel').hidden = true;
      return;
    }
    const chip = x => {
      const d2 = new Date(x.created_at);
      const when = `${d2.getMonth()+1}/${d2.getDate()}`;
      return `<button class="wchip" data-id="${x.id}" aria-pressed="${wsSel.includes(x.id)}"
        title="建立於 ${d2.toLocaleString('zh-TW')}｜已背熟 ${x.mastered} 字">
        ${esc(x.name)}<small>${x.word_count} 字</small><small class="when">${when}</small></button>`;
    };
    // 字表會一直累積（家教每堂課一份），只先顯示最近幾份，其餘收起來
    const SHOWN = 6;
    const recent = d.sets.slice(0, SHOWN), rest = d.sets.slice(SHOWN);
    const restOpen = el('wsList').dataset.expanded === '1'
      || rest.some(x => wsSel.includes(x.id));   // 目前選的在舊的裡面就要展開
    el('wsList').dataset.expanded = restOpen ? '1' : '0';
    el('wsList').innerHTML = recent.map(chip).join('')
      + (restOpen ? rest.map(chip).join('') : '')
      + (rest.length ? `<button class="linky" id="wsMore" style="margin-left:4px">${
          restOpen ? '收起舊字表' : `更多 ${rest.length} 份`}</button>` : '')
      ;
    // 選取的字表被刪掉或還沒選過，就回到最新那一份
    wsSel = wsSel.filter(id => d.sets.some(x => x.id === id));
    if (!wsSel.length) await selectSet(d.sets[0].id, true);
    else { wsCurrent = wsSel[0]; renderSelInfo(); }
  } catch (e){
    el('wsList').innerHTML = `<span class="hint">載入失敗：${esc(e.message)}</span>`;
  }
}

/** 點字表就是加選／取消。至少要留一份，否則畫面上沒有東西可看。
 *  不另外做「多選模式」—— 多一個開關只是多一層操作，
 *  而刪除本來就有兩段確認擋著。 */
async function selectSet(id, only = false){
  if (only) wsSel = [id];
  else {
    wsSel = wsSel.includes(id) ? wsSel.filter(x => x !== id) : [...wsSel, id];
    if (!wsSel.length) wsSel = [id];          // 不允許一份都不選
  }
  wsSel.sort((a, b) => b - a);
  wsCurrent = wsSel[0];
  for (const b of el('wsList').querySelectorAll('.wchip'))
    b.setAttribute('aria-pressed', String(wsSel.includes(Number(b.dataset.id))));
  renderSelInfo();
  if (!el('wsForm').hidden) renderFormActions();
  const d = await fetch(`/api/wordset?ids=${selParam()}&user=${encodeURIComponent(USER)}`).then(r => r.json());
  wsWordsCache = d.words || [];
  wsMerged = d.merged || { dedup: 0 };
  renderSelInfo();
  wsExamples = d.examples || { total: 0, cached: 0 };
  renderAnalyzeBtn();
  const st = d.stats || { words:0, attempts:0, correct:0, mastered:0, weak:0 };
  const pct = st.attempts ? Math.round(st.correct / st.attempts * 100) : 0;
  el('wsStats').innerHTML =
    `<div class="ucard"><h4>單字</h4><div class="big">${st.words}</div>
       <div class="sub">共 ${wsWordsCache.reduce((a,w)=>a+(w.senses?.length||0),0)} 個意思</div></div>`
  + `<div class="ucard"><h4>已背熟</h4><div class="big">${st.mastered}</div>
       <div class="sub">連續答對 3 次以上<br>之後會隔比較久才再考</div></div>`
  + `<div class="ucard"><h4>待加強</h4><div class="big">${st.weak}</div>
       <div class="sub">最近答錯過<br>下次出題會優先挑</div></div>`
  + `<div class="ucard"><h4>正確率</h4><div class="big">${st.attempts ? pct + '%' : '—'}</div>
       <div class="sub">${st.correct} / ${st.attempts} 題</div></div>`;
  el('wsPanel').hidden = false;
  el('wsSummary').hidden = true;
  el('wsActions').hidden = true;
  el('wsOut').innerHTML = '';
  renderWordList();
}

/** 小朗讀鈕。一律產生，沒有語音能力時由 CSS（body 沒有 has-speech）藏起來。
 *  不能在這裡判斷 Spk.available()：iPhone 的語音清單載入得晚，單字清單先畫出來就永遠沒有按鈕了。 */
function sayBtn(text, label){
  return `<button class="sayx" type="button" data-say="${esc(text)}"
    aria-label="${esc(label)}" title="${esc(label)}"><span class="ico"></span></button>`;
}

/** 一張單字卡（單字清單與搜尋結果共用）。multi：同時有多份字表時顯示這個字來自哪一份。 */
function wordCardHtml(w, multi){
  const setName = id => wsAllSets.find(x => x.id === id)?.name ?? '';
  const tag = w.total === 0 ? '<span class="box-tag">還沒考過</span>'
    : w.box >= 3 ? `<span class="box-tag good">已背熟 ${w.correct}/${w.total}</span>`
    : `<span class="box-tag hot">再加強 ${w.correct}/${w.total}</span>`;
  return `<div class="wcard"><div class="top">
    <span class="term">${esc(w.term)}</span>
    ${w.syllables ? `<span class="syl">${esc(w.syllables)}</span>` : ''}
    ${sayBtn(w.term, '唸這個單字')}
    ${multi ? (w.mergedFrom
      ? `<span class="dupt" title="${esc(w.mergedFrom.map(setName).join('、'))}">合併 ${w.mergedFrom.length} 份</span>`
      : `<span class="setof" title="來自這份字表">${esc(setName(w.setId))}</span>`) : ''}
    ${tag}</div>
    ${(w.senses||[]).map(sn => `<div class="wsense"><b>${esc(sn.pos)}</b>${esc(sn.zh)}
      ${sn.example ? `<span class="ex"><span class="extxt">${esc(sn.example)}</span>${sayBtn(sn.example, '朗讀例句')}` +
        `<button class="exan${sn.analyzed ? ' done' : ''}" data-an="${esc(sn.example)}"
           title="${sn.analyzed ? '已分析過，點了馬上看句型與詞性，不花額度'
                                : '還沒分析，點了會花一次額度'}">分析</button></span>` : ''}
      ${sn.exampleZh ? `<span class="exz">${esc(sn.exampleZh)}</span>` : ''}</div>`).join('')}
    ${w.spellTip ? `<div class="wtip">拼字：${esc(w.spellTip)}</div>` : ''}
    ${(w.confusable||[]).length ? `<div class="wextra">易混淆：${w.confusable.map(c=>`${esc(c.word)}（${esc(c.zh)}）`).join('、')}</div>` : ''}
    ${(w.family||[]).length ? `<div class="wextra">衍生字：${w.family.map(c=>`${esc(c.word)}（${esc(c.zh)}）`).join('、')}</div>` : ''}
    </div>`;

}

function renderWordList(){
  const multi = wsSel.length > 1;
  el('wsWords').innerHTML = `<div class="wlist">${wsWordsCache.map(w => wordCardHtml(w, multi)).join('')}</div>`;
}

function renderWordQ(q, n){
  const body = q.inputMode === 'choice'
    ? `<div class="q-opts">${q.choices.map(c =>
        `<label class="q-opt"><input type="radio" name="${q.id}" value="${esc(c.value)}"> ${esc(c.label)}</label>`).join('')}</div>`
    // 多格題（動詞三態要填過去式與過去分詞）要有對應數量的輸入框
    : `<div class="q-blanks">${Array.from({ length: q.blanks || 1 }, (_, i) =>
        `<input type="text" data-q="${q.id}" data-i="${i}" autocomplete="off"
           spellcheck="false" autocapitalize="off"
           placeholder="${(q.blanks || 1) > 1 ? `第 ${i + 1} 格` : '填入答案'}">`).join('')}</div>`;
  const head = q.mode === 'listen'
    ? `<button class="q-speak" type="button" data-say="${esc(q.speak)}"><span class="ico"></span>播放</button>`
    : q.mode === 'zh2en' ? `<div class="q-zh">${esc(q.question)}</div>`
    : q.question ? `<div class="q-sent">${esc(q.question)}</div>` : '';
  return `<article class="q" id="wq-${q.id}">
    <div class="q-head"><span class="q-no">${n}</span>
      <span class="q-type">${esc(WMODE_NAME[q.mode])}</span>
      <span class="q-prompt">${esc(q.prompt)}</span></div>
    ${head}
    ${q.hint ? `<div class="q-hint">${esc(q.hint)}</div>` : ''}
    ${body}</article>`;
}

async function startWordQuiz(opts = {}){
  el('wsSummary').hidden = true; el('wsActions').hidden = true;
  el('wsAgain').hidden = true; el('wsFix').hidden = true; el('wsSubmit').disabled = false;
  clearQuizMsg('wsActions');
  showPane('quiz');                       // 出題一定是在測驗那一頁
  el('wsOut').innerHTML = '<p class="msg">出題中…</p>';
  try {
    const d = await fetch('/api/wordquiz', {
      method:'POST', headers:{ 'content-type':'application/json', ...(TOKEN?{'x-auth-token':TOKEN}:{}) },
      body: JSON.stringify({ setIds: wsSel, userToken: USER,
        count: Number(el('wsCount').value), modes: wsModesSel(),
        redoFrom: opts.redoFrom, redoIds: opts.redoIds }),
    }).then(r => r.json());
    if (d.error){ el('wsOut').innerHTML = `<p class="msg">${esc(d.message || d.error)}</p>`; return; }
    wsQuiz = d;
    el('wsOut').innerHTML = d.questions.map((q,i) => renderWordQ(q, i+1)).join('');
    hardenAnswers(el('wsOut'));
    el('wsActions').hidden = false;
    scrollToFirstQuestion(el('wsOut'));
    // 只有第一題本身是聽考才自動唸。先前用 querySelector('.q-speak') 會抓到
    // 整份測驗裡任何一題的聽考鈕，等於提前唸出後面題目的答案。
    const firstQ = d.questions[0];
    if (firstQ?.mode === 'listen')
      el('wsOut').querySelector(`#wq-${firstQ.id} .q-speak`)?.click();
  } catch (e){ el('wsOut').innerHTML = `<p class="msg">出題失敗：${esc(e.message)}</p>`; }
}

// 單字分頁裡所有 data-say 的按鈕統一處理（單字、例句、聽考的播放鈕）
el('view-words').addEventListener('click', e => {
  const b = e.target.closest('[data-say]');
  if (!b) return;
  if (b.classList.contains('on')){ Spk.stop(); return; }   // 再按一次停止
  for (const x of document.querySelectorAll('[data-say].on')) x.classList.remove('on');
  b.classList.add('on');
  Spk.speak(b.dataset.say, { onEnd: () => b.classList.remove('on') });
});

async function submitWordQuiz(){
  if (!wsQuiz) return;
  el('wsSubmit').disabled = true;
  const answers = {};
  for (const q of wsQuiz.questions)
    answers[q.id] = q.inputMode === 'choice'
      ? [el('wsOut').querySelector(`input[name="${q.id}"]:checked`)?.value ?? '']
      // 多格題要把每一格都收進來，只讀第一格的話第二格永遠是空的
      : [...el('wsOut').querySelectorAll(`input[data-q="${q.id}"]`)].map(x => x.value ?? '');
  try {
    const d = await fetch('/api/wordattempts', {
      method:'POST', headers:{ 'content-type':'application/json', ...(TOKEN?{'x-auth-token':TOKEN}:{}) },
      body: JSON.stringify({ quizId: wsQuiz.quizId, userToken: USER, answers }),
    }).then(r => r.json());
    if (d.error){ el('wsSubmit').disabled = false;
      quizMsg('wsActions', d.message || d.error); return; }

    const wrong = [];
    for (const r of d.results){
      const card = document.getElementById(`wq-${r.id}`);
      if (!card) continue;
      card.classList.add('graded', r.correct ? 'ok' : 'ng');
      for (const i of card.querySelectorAll('input')) i.disabled = true;
      if (!r.correct) wrong.push(r.term);
      card.insertAdjacentHTML('beforeend', `<div class="q-result">
        <span class="q-verdict">${r.correct ? '✓ 答對了' : '✗ 答錯了'}</span>${
        r.correct ? '' : `正解：<span class="q-ans">${esc(r.expected.join('　'))}</span>\n`}${esc(r.explain)}</div>`);
    }
    const pct = Math.round(d.correct / d.total * 100);
    el('wsSummary').innerHTML = `<div class="sum-score"><b>${d.correct}</b> / ${d.total} 答對（${pct}%）</div>`
      + (d.isFix
        ? `<div class="sum-break">這是訂正，<b>不列入正確率，也不會把那些字移出待加強</b> ——
            答案剛才已經看過了，再答對一次不代表背起來了。
            ${wrong.length ? `還是錯的：${esc([...new Set(wrong)].join('、'))}` : '下一輪會再考這些字。'}</div>`
        : wrong.length ? `<div class="sum-break">答錯的字：${esc([...new Set(wrong)].join('、'))}
            —— 這些會馬上回到待加強，下一輪優先出現。</div>`
          : `<div class="sum-break">全對。這些字會隔比較久才再考，先去練別的。</div>`);
    el('wsSummary').hidden = false;
    wrongFirst(el('wsOut'), d.results, r => `wq-${r.id}`);
    // 記下答錯的字，訂正時只考這幾個
    wsWrong = { quizId: wsQuiz.quizId, ids: d.results.filter(r => !r.correct).map(r => r.id) };
    el('wsFix').hidden = !wsWrong.ids.length;
    el('wsFix').textContent = `訂正錯題（${wsWrong.ids.length} 題）`;
    el('wsFix').title = '把答錯的原題再做一次。不列入正確率與待加強。';
    el('wsSummary').scrollIntoView({ behavior:'smooth', block:'nearest' });
    el('wsAgain').hidden = false;
    await selectSetStatsOnly();
  } catch (e){
    el('wsSubmit').disabled = false;
    quizMsg('wsActions', '交卷失敗：' + e.message);
  }
}

/** 交卷後只更新統計與清單，不動測驗結果 */
async function selectSetStatsOnly(){
  const d = await fetch(`/api/wordset?ids=${selParam()}&user=${encodeURIComponent(USER)}`).then(r => r.json());
  wsWordsCache = d.words || [];
  const st = d.stats;
  const pct = st.attempts ? Math.round(st.correct / st.attempts * 100) : 0;
  const cards = el('wsStats').querySelectorAll('.ucard .big');
  if (cards[1]) cards[1].textContent = st.mastered;
  if (cards[2]) cards[2].textContent = st.weak;
  if (cards[3]) cards[3].textContent = st.attempts ? pct + '%' : '—';
  const sub = el('wsStats').querySelectorAll('.ucard .sub');
  if (sub[3]) sub[3].textContent = `${st.correct} / ${st.attempts} 題`;
  renderWordList();
}


/** 上傳前先縮到最長邊 1600px —— 手機原圖動輒四五 MB，縮完約十分之一，
 *  辨識品質一樣但快很多也省額度。HEIC 之類瀏覽器畫不出來的就原樣送。 */
function shrinkImage(file, maxSide = 1600){
  return new Promise(resolve => {
    const reader = new FileReader();
    reader.onload = () => {
      const dataUrl = reader.result;
      const img = new Image();
      img.onload = () => {
        const scale = Math.min(1, maxSide / Math.max(img.width, img.height));
        if (scale === 1) return resolve(dataUrl);
        const c = document.createElement('canvas');
        c.width = Math.round(img.width * scale);
        c.height = Math.round(img.height * scale);
        c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
        try { resolve(c.toDataURL('image/jpeg', 0.85)); }
        catch { resolve(dataUrl); }
      };
      img.onerror = () => resolve(dataUrl);     // 瀏覽器讀不了（HEIC）就原樣送
      img.src = dataUrl;
    };
    reader.onerror = () => resolve(null);
    reader.readAsDataURL(file);
  });
}

// ===== 搜尋單字：英文或中文都可以，跨所有字表（不只目前選的）=====
let wsSearchTimer = null, wsSearchSeq = 0;
async function runWordSearch(){
  const q = el('wsSearch').value.trim(), out = el('wsSearchOut');
  el('wsSearchClear').hidden = !q;
  if (!q || API === false){ out.hidden = true; out.innerHTML = ''; el('wsWords').hidden = false; return; }
  const seq = ++wsSearchSeq;
  const d = await fetch(`/api/wordsearch?q=${encodeURIComponent(q)}&user=${encodeURIComponent(USER)}`).then(r => r.ok ? r.json() : null).catch(() => null);
  if (seq !== wsSearchSeq) return;                    // 打字比回應快：只認最後一次
  el('wsWords').hidden = true; out.hidden = false;
  if (!d){ out.innerHTML = '<p class="msg">搜尋失敗，請稍後再試。</p>'; return; }
  out.innerHTML = d.words.length
    ? `<p class="hint">在全部單字表裡找到 ${d.total} 個字。</p><div class="wlist">${d.words.map(w => wordCardHtml(w, true)).join('')}</div>`
    : `<p class="msg">找不到「${esc(q)}」。可以試試只打一部分，或換成中文／英文。</p>`;
}
el('wsSearch').addEventListener('input', () => { clearTimeout(wsSearchTimer); wsSearchTimer = setTimeout(runWordSearch, 250); });
el('wsSearch').addEventListener('keydown', e => { if (e.key === 'Escape'){ el('wsSearch').value = ''; runWordSearch(); } });
el('wsSearchClear').addEventListener('click', () => { el('wsSearch').value = ''; runWordSearch(); el('wsSearch').focus(); });
