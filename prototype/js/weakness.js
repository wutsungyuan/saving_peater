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
  'pronoun-case':'代名詞格位', 'pronoun-fill':'代名詞填空',
  'paper-reorder':'句子重組（測驗卷）', 'paper-fix':'改錯（測驗卷）', 'paper-cloze':'克漏字（測驗卷）',
  'paper-wbank':'文意選填（測驗卷）', 'paper-reply':'情境應答（測驗卷）' };
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

// 弱點頁的來源：all 全部、quiz 單字測驗、practice 句子練習、exam 測驗卷
// 弱點頁的兩個版本：前台是自己的紀錄；後台「學生紀錄」是學生的（as=student，只有老師能這樣看），沒有練習用的按鈕
const WK_FRONT = { head: 'weakHead', charts: 'weakCharts', tabsId: 'wkTabs', source: 'all', as: null, cta: true };
const WK_STUDENT = { head: 'studHead', charts: 'studCharts', tabsId: 'studTabs', source: 'all', as: 'student', cta: false };
const loadStudentRecords = () => loadWeakness(WK_STUDENT);
const WK_SOURCES = [['all', '全部'], ['quiz', '單字測驗'], ['practice', '句子練習'], ['exam', '測驗卷']];

/** 句子面向：五大句型、時態、代名詞格位、詞性、題型（資料來自 attempts） */
function wkSentenceSections(w){
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

  const posRows = [...(w.byPos || [])].sort((a, b) => a.correct / a.total - b.correct / b.total)
    .map(r => wkRow(POS[r.pos]?.zh || r.pos, r.pos, r.correct, r.total)).join('');

  const CASE_ORDER = [['subject','主格'],['object','受格'],['possessive','所有格'],
    ['possessive-pron','所有格代名詞'],['reflexive','反身代名詞']];
  const byC = new Map((w.byCase || []).map(r => [r.pron_case, r]));
  const caseRows = (w.byCase || []).length
    ? CASE_ORDER.map(([k, zh]) => { const r = byC.get(k);
        return wkRow(zh, '', r?.correct ?? 0, r?.total ?? 0); }).join('')
    : '';

  const typeRows = [...(w.byType || [])].sort((a, b) => a.correct / a.total - b.correct / b.total)
    .map(r => wkRow(QTYPE_NAMES[r.qtype] || r.qtype, '', r.correct, r.total)).join('');

  return wkSection('五大句型', '五種都列出來，沒作答過的標為無資料。', patternRows) +
    wkSection('時態', '國中必學的 6 種固定列出；超出範圍的作答另外列在下方。', tenseRows + extraRows) +
    (caseRows ? wkSection('代名詞格位', '五種格位固定列出，沒作答過的標為無資料。', caseRows) : '') +
    (posRows ? wkSection('詞性', '依正確率由低到高排序。', posRows) : '') +
    (typeRows ? wkSection('題型', '哪一種題目最常答錯。', typeRows) : '');
}

/** 單字面向：各種題型、最弱的字、各字表（資料來自 word_attempts） */
function wkWordSections(w){
  const x = w.words || {};
  if (!x.total) return '';
  const modeRows = [...(x.byMode || [])].sort((a, b) => a.correct / a.total - b.correct / b.total)
    .map(r => wkRow(WMODE_NAME[r.mode] || r.mode, '', r.correct, r.total)).join('');
  const weakRows = (x.weakest || []).map(r => wkRow(r.term, '', r.correct, r.total)).join('');
  const setRows = (x.bySet || []).map(r => wkRow(r.name, '', r.correct, r.total)).join('');
  return wkSection('單字題型', '單字測驗與測驗卷的單字題，哪一種題型最弱。', modeRows) +
    (weakRows ? wkSection('最弱的單字', '至少作答 2 次的字，依正確率由低到高，最多列 10 個。', weakRows) : '') +
    (setRows ? wkSection('各單字表', '每份字表累計的正確率。', setRows) : '');
}

/** 測驗卷成績：最近幾份的分數、各題型累計得分率（卷子歷史只保留近期，所以是近期成績） */
function wkExamSections(w){
  const p = w.papers;
  if (!p || (!p.trend.length && !p.bySection.length)) return '';
  const pts = typeof fmtPts === 'function' ? fmtPts : n => String(Math.round(n * 10) / 10);
  const trend = p.trend.length ? `<div class="wk-sec"><h4>最近的測驗卷</h4><p class="cap">由舊到新，最多 10 份（訂正卷不算）。</p>
    <div class="wk-rows">${p.trend.map(t => {
      const d = new Date(t.at).toLocaleDateString('zh-TW', { month: 'numeric', day: 'numeric' });
      const cls = t.score >= 80 ? 'good' : t.score >= 60 ? 'mid' : 'bad';
      return `<div class="wk-row ${cls}"><div class="name">${esc(d)}<small>${esc(t.difficulty)}・${t.n} 題</small></div>
        <div class="wk-track"><div class="wk-fill" style="width:${Math.max(0, Math.min(100, t.score))}%"></div></div>
        <div class="wk-val"><b>${pts(t.score)}</b><span class="frac">/ 100 分</span></div></div>`;
    }).join('')}</div></div>` : '';
  const sec = p.bySection.length
    ? wkSection('各題型得分率', '近期測驗卷各題型累計得到的分數占滿分的比例。',
        [...p.bySection].sort((a, b) => a.score / a.total - b.score / b.total)
          .map(s => wkRow(s.name, '', Math.round(s.score * 10) / 10, Math.round(s.total * 10) / 10)).join(''))
    : '';
  return trend + sec;
}

async function loadWeakness(ctx = WK_FRONT){
  const head = document.getElementById(ctx.head);
  const charts = document.getElementById(ctx.charts);
  charts.innerHTML = '<p class="msg">載入中…</p>';
  try {
    const w = await fetch(`/api/weakness?user=${encodeURIComponent(USER)}&source=${ctx.source}${ctx.as ? '&as=' + ctx.as : ''}`).then(r => r.json());
    const o = w.overall || { total: 0, correct: 0 };
    const S = w.sources || {};
    const tabs = `<div class="subrow"><div class="subtabs" id="${ctx.tabsId}" role="group" aria-label="切換弱點的來源">${WK_SOURCES.map(([k, zh]) => {
      const n = k === 'all' ? (S.practice?.total || 0) + (S.quiz?.total || 0) + (S.exam?.total || 0) : S[k]?.total || 0;
      return `<button data-src="${k}" aria-pressed="${k === ctx.source}">${zh}${n ? `<small> ${n}</small>` : ''}</button>`;
    }).join('')}</div></div>`;

    if (!o.total && !(w.papers && (w.papers.trend.length || w.papers.bySection.length))){
      head.innerHTML = tabs;
      charts.innerHTML = `<div class="wk-empty">${ctx.source === 'all' ? '還沒有作答紀錄。<br>' + (ctx.as ? '學生做過單字測驗、句子練習或測驗卷之後，這裡就會統計。' : '先到「單字」做單字測驗、或到「句子」做句子練習，這裡就會統計你的正確率，並在之後出題時優先挑你最弱的部分。')
        : `「${WK_SOURCES.find(x => x[0] === ctx.source)[1]}」還沒有作答紀錄。`}</div>`;
      return;
    }

    const pct = o.total ? Math.round(o.correct / o.total * 100) : null;
    const wordWeak = Boolean(w.words?.weakest?.length);
    head.innerHTML = tabs + `<div class="wk-hero">
      <div><div class="n">${pct == null ? '—' : pct + '%'}</div><div class="lbl">${ctx.source === 'all' ? '整體' : WK_SOURCES.find(x => x[0] === ctx.source)[1]}正確率<br>${o.correct} / ${o.total} 題</div></div>
      <div class="sep"></div>
      <div><div class="lbl" style="margin:0">句子練習出題時會依句型、時態等數字加權，<br>
        最弱的維度出現機率最高（全錯約 2.5 倍、全對約 0.25 倍）。單字則靠間隔複習，沒背熟的字優先出現。</div></div>
      <span class="cta">${ctx.cta && (ctx.source !== 'quiz' && ctx.source !== 'exam' || w.byPattern?.length) ? '<button class="primary" id="weakPractice">針對弱點練習句子</button>' : ''}
        ${ctx.cta && wordWeak ? '<button id="weakWords">複習單字</button>' : ''}</span></div>`;

    // 總覽：全部時列出三個來源各自的正確率，一眼看出哪一塊最弱
    const overview = ctx.source === 'all' ? wkSection('各來源', '單字測驗、句子練習、測驗卷各自累計的正確率。',
      [['quiz', '單字測驗'], ['practice', '句子練習'], ['exam', '測驗卷']]
        .map(([k, zh]) => wkRow(zh, '', S[k]?.correct ?? 0, S[k]?.total ?? 0)).join('')) : '';

    charts.innerHTML = overview
      + (ctx.source === 'quiz' ? '' : ctx.source === 'exam' ? wkExamSections(w) : '')
      + (ctx.source === 'quiz' ? wkWordSections(w) : '')
      + (ctx.source === 'all' || ctx.source === 'practice' || ctx.source === 'exam' ? wkSentenceSections(w) : '')
      + (ctx.source === 'all' ? wkWordSections(w) + wkExamSections(w) : '')
      || '<div class="wk-empty">這個來源還沒有可以統計的內容。</div>';

    document.getElementById('weakPractice')?.addEventListener('click', () => {
      jumpTo('sentence', { sub: 'practice', auto: false });
      startQuiz();
    });
    document.getElementById('weakWords')?.addEventListener('click', () => {
      jumpTo('words');
      setTimeout(() => document.querySelector('#view-words .subtabs button[data-pane="quiz"]')?.click(), 250);
    });
  } catch (e){
    charts.innerHTML = `<p class="msg">載入失敗：${esc(e.message)}</p>`;
  }
}
// 來源切換：前台（自己的）與後台「學生紀錄」各一組
for (const ctx of [WK_FRONT, WK_STUDENT]){
  el(ctx.head).addEventListener('click', e => {
    const b = e.target.closest('#' + ctx.tabsId + ' button[data-src]');
    if (!b || b.dataset.src === ctx.source) return;
    ctx.source = b.dataset.src;
    loadWeakness(ctx);
  });
}
