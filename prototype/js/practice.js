// 句子練習：出題、作答、交卷。
// 經典腳本（不是 ES module）：和其他 js/*.js 共用全域，由 index.html 依固定順序載入，順序不能換。

// ===== 練習 =====
// 預設勾選的題型排在前面（時態填空、代名詞格位、代名詞填空），其餘排後面、預設不勾
const DEFAULT_QTYPES = ['tense', 'pronoun-case', 'pronoun-fill'];
const QTYPES = [
  ['tense','時態填空'], ['pronoun-case','代名詞格位'], ['pronoun-fill','代名詞填空'],
  ['pattern','句型判斷'], ['pos','詞性判斷'], ['error-fix','改錯'],
];
const USER = (() => {
  try {
    let u = localStorage.getItem('analyzer-user');
    if (!u){ u = 'u' + Math.random().toString(36).slice(2, 10); localStorage.setItem('analyzer-user', u); }
    return u;
  } catch { return 'local'; }
})();

const qtypesEl = document.getElementById('qtypes');
const quizOut = document.getElementById('quizOut');
const quizHint = document.getElementById('quizHint');
const quizSummary = document.getElementById('quizSummary');
const quizActions = document.getElementById('quizActions');
const quizSubmit = document.getElementById('quizSubmit');
const quizAgain = document.getElementById('quizAgain');
let currentQuiz = null;

qtypesEl.innerHTML = QTYPES.map(([v, l]) =>
  `<button class="tchip" data-t="${v}" aria-pressed="${DEFAULT_QTYPES.includes(v)}">${l}</button>`).join('');
qtypesEl.addEventListener('click', e => {
  const b = e.target.closest('.tchip'); if (!b) return;
  const on = b.getAttribute('aria-pressed') !== 'true';
  // 至少留一個題型
  if (!on && qtypesEl.querySelectorAll('[aria-pressed="true"]').length <= 1) return;
  b.setAttribute('aria-pressed', String(on));
});
const selectedTypes = () =>
  [...qtypesEl.querySelectorAll('[aria-pressed="true"]')].map(b => b.dataset.t);

document.getElementById('toWeak').addEventListener('click', () => {
  document.querySelector('.tabs button[data-view="weak"]').click();
});

/** 把 display 裡要強調的部分包成 <mark> */
function qDisplay(q){
  const text = q.display ?? q.sentence ?? '';
  if (q.highlight && Number.isInteger(q.highlight.start)){
    const { start, end } = q.highlight;
    return esc(text.slice(0, start)) + '<mark>' + esc(text.slice(start, end)) + '</mark>' + esc(text.slice(end));
  }
  if (q.highlightText && text.includes(q.highlightText)){
    const i = text.indexOf(q.highlightText);
    return esc(text.slice(0, i)) + '<mark>' + esc(q.highlightText) + '</mark>'
      + esc(text.slice(i + q.highlightText.length));
  }
  return esc(text);
}

function renderQuestion(q, n){
  const typeLabel = Object.fromEntries(QTYPES)[q.type] || q.type;
  const body = q.inputMode === 'choice'
    ? `<div class="q-opts">${q.choices.map((c, i) => `
        <label class="q-opt"><input type="radio" name="${q.id}" value="${esc(c.value)}"> ${esc(c.label)}</label>`).join('')}</div>`
    : `<div class="q-blanks">${Array.from({ length: q.blanks || 1 }, (_, i) =>
        `<input type="text" data-q="${q.id}" data-i="${i}" autocomplete="off" spellcheck="false"
           placeholder="${q.blanks > 1 ? `第 ${i + 1} 格` : '填入答案'}">`).join('')}</div>`;

  return `<article class="q" id="card-${q.id}">
    <div class="q-head"><span class="q-no">${n}</span><span class="q-type">${esc(typeLabel)}</span>
      <span class="q-prompt">${esc(q.prompt)}</span></div>
    ${q.context ? `<div class="q-ctx" title="這題是對話的一部分">
      <span class="who">${esc(q.context.speaker || '對方')}</span>${esc(q.context.text)}</div>` : ''}
    <div class="q-sent">${qDisplay(q)}</div>
    ${q.hint ? `<div class="q-hint">（${esc(q.hint)}）</div>` : ''}
    ${q.zh ? `<div class="q-zh">${esc(q.zh)}</div>` : ''}
    ${q.type === 'error-fix' ? '<div class="hint">只要填改正後的那一小段就好，例如 tastes good</div>' : ''}
    ${body}
  </article>`;
}

async function startQuiz(opts = {}){
  quizSummary.hidden = true; quizActions.hidden = true; quizAgain.hidden = true;
  el('quizFix').hidden = true;
  clearQuizMsg('quizActions');
  quizSubmit.disabled = false;
  quizOut.innerHTML = '<p class="msg">出題中…</p>';
  try {
    const res = await fetch('/api/exercises', {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...(TOKEN ? { 'x-auth-token': TOKEN } : {}) },
      body: JSON.stringify({ count: Number(document.getElementById('qcount').value),
        types: selectedTypes(), userToken: USER,
        redoFrom: opts.redoFrom, redoIds: opts.redoIds }),
    });
    const d = await res.json();
    if (!res.ok){
      quizOut.innerHTML = `<p class="msg">${esc(d.message || d.error || '出題失敗')}</p>`;
      return;
    }
    if (!d.questions.length){
      quizOut.innerHTML = '<p class="msg">目前的句子出不了這些題型。先到「分析」多貼幾句，或改選其他題型。</p>';
      return;
    }
    currentQuiz = d;
    quizOut.innerHTML = d.questions.map((q, i) => renderQuestion(q, i + 1)).join('');
    hardenAnswers(quizOut);
    quizHint.textContent = `共 ${d.questions.length} 題，題庫 ${d.pool} 句。`;
    quizActions.hidden = false;
    scrollToFirstQuestion(quizOut);
  } catch (e){
    quizOut.innerHTML = `<p class="msg">連線失敗：${esc(e.message)}</p>`;
  }
}

async function submitQuiz(){
  if (!currentQuiz) return;
  quizSubmit.disabled = true;
  const answers = {};
  for (const q of currentQuiz.questions){
    answers[q.id] = q.inputMode === 'choice'
      ? [quizOut.querySelector(`input[name="${q.id}"]:checked`)?.value ?? '']
      : [...quizOut.querySelectorAll(`input[data-q="${q.id}"]`)].map(el => el.value);
  }
  try {
    const res = await fetch('/api/attempts', {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...(TOKEN ? { 'x-auth-token': TOKEN } : {}) },
      body: JSON.stringify({ quizId: currentQuiz.quizId, userToken: USER, answers }),
    });
    const d = await res.json();
    if (!res.ok){
      quizMsg('quizActions', d.message || d.error);
      quizSubmit.disabled = false;
      return;
    }

    const byId = new Map(currentQuiz.questions.map(q => [q.id, q]));
    const wrongTypes = {};
    for (const r of d.results){
      const card = document.getElementById(`card-${r.id}`);
      if (!card) continue;
      card.classList.add('graded', r.correct ? 'ok' : 'ng');
      for (const el of card.querySelectorAll('input')) el.disabled = true;
      if (!r.correct){
        const t = byId.get(r.id)?.type;
        wrongTypes[t] = (wrongTypes[t] || 0) + 1;
      }
      card.insertAdjacentHTML('beforeend', `<div class="q-result">
        <span class="q-verdict">${r.correct ? '✓ 答對了' : '✗ 答錯了'}</span>${
        r.correct ? '' : `正解：<span class="q-ans">${esc(r.expected.join('　'))}</span>\n`}${esc(r.explain)}</div>`);
    }

    const pct = Math.round(d.correct / d.total * 100);
    const labels = Object.fromEntries(QTYPES);
    quizSummary.innerHTML = `<div class="sum-score"><b>${d.correct}</b> / ${d.total} 答對（${pct}%）</div>` +
      (Object.keys(wrongTypes).length
        ? `<div class="sum-break">需要加強：${Object.entries(wrongTypes)
            .map(([t, n]) => `${labels[t] || t} 錯 ${n} 題`).join('、')}</div>`
        : `<div class="sum-break">全對。換一份再練，或到「分析」貼新文章擴充題庫。</div>`)
      + (d.isFix
        ? `<div class="sum-break">這是訂正，<b>不列入弱點統計</b> —— 答案剛才已經看過了。</div>`
        : `<div class="sum-break">作答已記錄，可到「弱點」看各句型與時態的正確率。</div>`);
    quizSummary.hidden = false;
    wrongFirst(quizOut, d.results, r => `card-${r.id}`);   // 卡片的 id 是 card-xxx
    quizWrong = { quizId: currentQuiz.quizId, ids: d.results.filter(r => !r.correct).map(r => r.id) };
    el('quizFix').hidden = !quizWrong.ids.length;
    el('quizFix').textContent = `訂正錯題（${quizWrong.ids.length} 題）`;
    el('quizFix').title = '把答錯的原題再做一次。不列入弱點統計。';
    quizSummary.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    quizAgain.hidden = false;
  } catch (e){
    quizSubmit.disabled = false;
    quizMsg('quizActions', '交卷失敗：' + e.message);
  }
}

document.getElementById('quizStart').addEventListener('click', startQuiz);
quizSubmit.addEventListener('click', submitQuiz);
quizAgain.addEventListener('click', startQuiz);
