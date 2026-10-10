// 弱點頁。
// 經典腳本（不是 ES module）：和其他 js/*.js 共用全域，由 index.html 依固定順序載入，順序不能換。

// ===== 弱點 =====
const PATTERN_NAMES = { 1:'句型一', 2:'句型二', 3:'句型三', 4:'句型四', 5:'句型五' };
const PATTERN_FORM  = { 1:'S+V', 2:'S+V+C', 3:'S+V+O', 4:'S+V+IO+DO', 5:'S+V+O+C' };
// 國中必學 6 種時態，照講義順序
const CORE_TENSES = [
  ['present-simple','現在簡單式'], ['present-progressive','現在進行式'],
  ['past-simple','過去簡單式'],    ['past-progressive','過去進行式'],
  ['future-simple','未來式'],      ['present-perfect','現在完成式'],
];
// 超出國中範圍但可能被作答到的時態
const EXTRA_TENSES = {
  'present-perfect-progressive':'現在完成進行式', 'past-perfect':'過去完成式',
  'past-perfect-progressive':'過去完成進行式', 'future-progressive':'未來進行式',
  'future-perfect':'未來完成式', 'future-perfect-progressive':'未來完成進行式',
  'past-future-simple':'過去未來式', 'past-future-progressive':'過去未來進行式',
  'past-future-perfect':'過去未來完成式', 'past-future-perfect-progressive':'過去未來完成進行式',
};
const QTYPE_NAMES = { 'pattern':'句型判斷', 'tense':'時態填空', 'pos':'詞性判斷',
  'verb-forms':'動詞三態', 'error-fix':'改錯',
  'pronoun-case':'代名詞格位', 'pronoun-fill':'代名詞填空' };
const MIN_N = 2;   // 少於這個作答數就標為資料不足，不下判斷

/** 一列：名稱、長條、百分比、分數、狀態標籤。數字與標籤都在，不靠顏色辨識 */
function wkRow(name, sub, correct, total){
  if (!total) return `<div class="wk-row none">
    <div class="name">${esc(name)}${sub ? `<small>${esc(sub)}</small>` : ''}</div>
    <div class="wk-track"><div class="wk-fill" style="width:0"></div></div>
    <div class="wk-val"><b>—</b><span class="frac">未作答</span><span class="tag">無資料</span></div></div>`;
  const pct = Math.round(correct / total * 100);
  const thin = total < MIN_N;
  const cls = thin ? 'none' : pct >= 80 ? 'good' : pct >= 50 ? 'mid' : 'bad';
  const tag = thin ? '資料不足' : pct >= 80 ? '熟練' : pct >= 50 ? '待加強' : '最弱';
  return `<div class="wk-row ${cls}">
    <div class="name">${esc(name)}${sub ? `<small>${esc(sub)}</small>` : ''}</div>
    <div class="wk-track"><div class="wk-fill" style="width:${pct}%"></div></div>
    <div class="wk-val"><b>${pct}%</b><span class="frac">${correct}/${total}</span>
      <span class="tag">${tag}</span></div></div>`;
}

function wkSection(title, cap, rows){
  return `<div class="wk-sec"><h4>${esc(title)}</h4><p class="cap">${esc(cap)}</p>
    <div class="wk-rows">${rows}</div></div>`;
}

async function loadWeakness(){
  const head = document.getElementById('weakHead');
  const charts = document.getElementById('weakCharts');
  charts.innerHTML = '<p class="msg">載入中…</p>';
  try {
    const w = await fetch(`/api/weakness?user=${encodeURIComponent(USER)}`).then(r => r.json());
    const o = w.overall || { total: 0, correct: 0 };
    if (!o.total){
      head.innerHTML = '';
      charts.innerHTML = `<div class="wk-empty">還沒有作答紀錄。<br>
        先到「句子練習」做一份，這裡就會依句型、時態、詞性、題型統計你的正確率，
        並在之後出題時優先挑你最弱的部分。</div>`;
      return;
    }

    const pct = Math.round(o.correct / o.total * 100);
    head.innerHTML = `<div class="wk-hero">
      <div><div class="n">${pct}%</div><div class="lbl">整體正確率<br>${o.correct} / ${o.total} 題</div></div>
      <div class="sep"></div>
      <div><div class="lbl" style="margin:0">出題時會依這些數字加權，<br>
        最弱的維度出現機率最高（全錯約 2.5 倍、全對約 0.25 倍）。</div></div>
      <button class="primary cta" id="weakPractice">針對弱點練習</button></div>`;

    const byP = new Map((w.byPattern || []).map(r => [r.pattern_id, r]));
    const patternRows = [1,2,3,4,5].map(id => {
      const r = byP.get(id);
      return wkRow(PATTERN_NAMES[id], PATTERN_FORM[id], r?.correct ?? 0, r?.total ?? 0);
    }).join('');

    const byT = new Map((w.byTense || []).map(r => [`${r.tense_time}-${r.tense_aspect}`, r]));
    const tenseRows = CORE_TENSES.map(([k, zh]) => {
      const r = byT.get(k);
      return wkRow(zh, '', r?.correct ?? 0, r?.total ?? 0);
    }).join('');
    const extraTense = (w.byTense || []).filter(r =>
      !CORE_TENSES.some(([k]) => k === `${r.tense_time}-${r.tense_aspect}`));
    const extraRows = extraTense.map(r => {
      const k = `${r.tense_time}-${r.tense_aspect}`;
      return wkRow(EXTRA_TENSES[k] || k, '超出範圍', r.correct, r.total);
    }).join('');

    const posRows = (w.byPos || []).sort((a, b) => a.correct / a.total - b.correct / b.total)
      .map(r => wkRow(POS[r.pos]?.zh || r.pos, r.pos, r.correct, r.total)).join('');

    const CASE_ORDER = [['subject','主格'],['object','受格'],['possessive','所有格'],
      ['possessive-pron','所有格代名詞'],['reflexive','反身代名詞']];
    const byC = new Map((w.byCase || []).map(r => [r.pron_case, r]));
    const caseRows = (w.byCase || []).length
      ? CASE_ORDER.map(([k, zh]) => { const r = byC.get(k);
          return wkRow(zh, '', r?.correct ?? 0, r?.total ?? 0); }).join('')
      : '';

    const typeRows = (w.byType || []).sort((a, b) => a.correct / a.total - b.correct / b.total)
      .map(r => wkRow(QTYPE_NAMES[r.qtype] || r.qtype, '', r.correct, r.total)).join('');

    charts.innerHTML =
      wkSection('五大句型', '五種都列出來，沒作答過的標為無資料。', patternRows) +
      wkSection('時態', '國中必學的 6 種固定列出；超出範圍的作答另外列在下方。',
        tenseRows + extraRows) +
      (caseRows ? wkSection('代名詞格位', '五種格位固定列出，沒作答過的標為無資料。', caseRows) : '') +
      (posRows ? wkSection('詞性', '依正確率由低到高排序。', posRows) : '') +
      (typeRows ? wkSection('題型', '哪一種題目最常答錯。', typeRows) : '');

    document.getElementById('weakPractice')?.addEventListener('click', () => {
      document.querySelector('.tabs button[data-view="practice"]').click();
      startQuiz();
    });
  } catch (e){
    charts.innerHTML = `<p class="msg">載入失敗：${esc(e.message)}</p>`;
  }
}

// 分頁切換
for (const b of document.querySelectorAll('.tabs button')){
  b.addEventListener('click', () => {
    for (const x of document.querySelectorAll('.tabs button')) x.setAttribute('aria-pressed', String(x === b));
    Spk.stop();
    const v = b.dataset.view;
    document.body.dataset.view = v;      // 給 CSS 用：邊緣把手只在分析分頁出現
    for (const name of ['analyze', 'words', 'practice', 'weak', 'history'])
      document.getElementById(`view-${name}`).hidden = name !== v;
    if (v === 'words'){
      if (API === false) el('wsList').innerHTML =
        '<span class="hint">單字表需要後端。請在本機執行 npm start 後開啟 http://127.0.0.1:8787</span>';
      else { loadWordsets(); refreshExamples(); }
    }
    if (v === 'practice'){
      if (API === false) quizOut.innerHTML = '<p class="msg">句子練習需要後端。請在本機執行 npm start 後開啟 http://127.0.0.1:8787</p>';
      else if (!currentQuiz && API) startQuiz();
    }
    if (v === 'weak'){
      if (API === false) document.getElementById('weakCharts').innerHTML =
        '<p class="msg">弱點統計需要後端。請在本機執行 npm start 後開啟 http://127.0.0.1:8787</p>';
      else loadWeakness();
    }
    if (v === 'history'){
      if (API === false) historyOut.innerHTML = '<p class="msg">歷史紀錄需要後端。請在本機執行 npm start 後開啟 http://127.0.0.1:8787</p>';
      else loadHistory();
    }
  });
}
