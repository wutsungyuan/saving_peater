// 出題引擎：從已分析的句子「反向」生成練習題。
// 不呼叫模型 —— 分析結果裡已有句型、成分、時態、關鍵字、詞性、三態、錯誤修正，
// 由程式產生可保證題目與解答跟分析完全一致，而且零成本、零延遲。
// 題型與版型比照講義「練習 + 解答表」。

const PATTERN_CHOICES = [
  { value: 1, label: '句型一　S + V' },
  { value: 2, label: '句型二　S + V + C' },
  { value: 3, label: '句型三　S + V + O' },
  { value: 4, label: '句型四　S + V + IO + DO' },
  { value: 5, label: '句型五　S + V + O + C' },
];

const POS_ZH = {
  n:'名詞', pron:'代名詞', v:'動詞', aux:'助動詞', adj:'形容詞', adv:'副詞',
  prep:'介系詞', conj:'連接詞', art:'冠詞', num:'數詞', to:'不定詞 to', interj:'感嘆詞',
};
// 容易混淆的詞性拿來當誘答選項，才有鑑別度
const POS_CONFUSE = {
  adj:['adv','n','v'], adv:['adj','prep','conj'], n:['pron','v','adj'],
  pron:['n','art','adj'], v:['aux','n','adj'], aux:['v','adv','prep'],
  prep:['conj','adv','art'], conj:['prep','adv','pron'], art:['pron','prep','num'],
  num:['art','adj','n'], to:['prep','adv','aux'], interj:['adv','conj','pron'],
};

const rand = n => Math.floor(Math.random() * n);
const shuffle = a => { const r = [...a]; for (let i = r.length - 1; i > 0; i--){ const j = rand(i + 1); [r[i], r[j]] = [r[j], r[i]]; } return r; };
const pick = a => a[rand(a.length)];
const mainOf = d => d.clauses?.find(c => c.role === 'main') ?? d.clauses?.[0];

/** 把原句的若干區間換成底線，回傳 { display, blanks } */
/** 句子本身就有空格（考卷填空題）時，不能再挖空出題 ——
 *  畫面上會出現兩個空格卻只收一個答案，根本看不出要填哪一個。 */
const hasBlank = t => /_{2,}/.test(String(t ?? ''));

function blankOut(original, spans){
  const ordered = [...spans].sort((a, b) => a.start - b.start);
  let out = '', pos = 0;
  for (const sp of ordered){
    out += original.slice(pos, sp.start) + '______';
    pos = sp.end;
  }
  out += original.slice(pos);
  return { display: out, blanks: ordered.map(sp => original.slice(sp.start, sp.end)) };
}

const constituentLine = (cl) => (cl.constituents ?? [])
  .map(c => `${c.text}（${c.role}）`).join('　');


const CASE_ZH = {
  subject:'主格', object:'受格', possessive:'所有格',
  'possessive-pron':'所有格代名詞', reflexive:'反身代名詞',
};
// 任一代名詞 → 它的人稱（填空題用主格當提示，就像課本那樣）
const PERSON = {
  i:'I', me:'I', my:'I', mine:'I', myself:'I',
  you:'you', your:'you', yours:'you', yourself:'you', yourselves:'you',
  he:'he', him:'he', his:'he', himself:'he',
  she:'she', her:'she', hers:'she', herself:'she',
  it:'it', its:'it', itself:'it',
  we:'we', us:'we', our:'we', ours:'we', ourselves:'we',
  they:'they', them:'they', their:'they', theirs:'they', themselves:'they',
};
const pronWords = (data) => (data.words ?? []).filter(w =>
  w.pos === 'pron' && CASE_ZH[w.case] && Number.isInteger(w.start) && PERSON[w.text.toLowerCase()]);

// ---------- 各題型 ----------

function qPattern({ hash, data }){
  const cl = mainOf(data);
  if (!cl?.pattern?.id) return null;
  const tip = (data.notes ?? []).find(n => n.type === 'tip')?.message;
  return {
    type: 'pattern',
    prompt: '判斷這句屬於第幾句型',
    sentence: data.original,
    display: data.original,
    inputMode: 'choice',
    choices: PATTERN_CHOICES.map(c => ({ value: String(c.value), label: c.label })),
    answer: [String(cl.pattern.id)],
    explain: `成分拆解：${constituentLine(cl)}\n→ ${cl.pattern.name}　${cl.pattern.label}` + (tip ? `\n${tip}` : ''),
    meta: { hash, patternId: cl.pattern.id },
  };
}

function qTense({ hash, data }){
  const cl = mainOf(data);
  const vs = (cl?.constituents ?? []).filter(c => c.role === 'V' && Number.isInteger(c.start));
  if (!vs.length || !cl?.verb?.lemma || !cl?.tense) return null;
  if (hasBlank(data.original)) return null;        // 已經有空格了，不能再挖
  const { display, blanks } = blankOut(data.original, vs);
  const ev = (cl.tense.evidence ?? []).filter(e => !blanks.some(b => b.includes(e)));
  // 三種會讓人猜不到答案的情況，各補一個線索：
  // 1. 空格吃掉助動詞或否定（I do not like → 答案是三個字，提示卻只有 like）
  // 2. 時態線索全在空格裡（He ___ bread. 看不出是現在還是過去）
  // 3. 兩者皆是
  const words = blanks.reduce((n, b) => n + b.trim().split(/\s+/).length, 0);
  const multi = words > blanks.length;              // 有空格不只一個字
  const noCue = ev.length === 0;                    // 句子裡看不到時態線索
  return {
    type: 'tense',
    prompt: noCue
      ? `用括號裡動詞的${cl.tense.label}填空`        // 沒線索就直接講時態，否則無從判斷
      : `用括號裡動詞的正確形式填空`,
    sentence: data.original,
    display,
    hint: cl.verb.lemma + (multi ? `，共 ${words} 個字` : ''),
    zh: data.translation ?? null,                   // 中文提示：否定、語氣都看得出來
    inputMode: 'text',
    blanks: blanks.length,
    answer: blanks,
    explain: (ev.length ? `關鍵字 ${ev.join('、')} → ` : '') +
      `${cl.tense.label}（${cl.tense.formula}）` +
      (cl.verb.irregular ? `\n${cl.verb.lemma} 是不規則動詞：${cl.verb.forms?.base} / ${cl.verb.forms?.past} / ${cl.verb.forms?.pastParticiple}` : ''),
    meta: { hash, tenseTime: cl.tense.time, tenseAspect: cl.tense.aspect },
  };
}

function qPos({ hash, data }){
  const words = (data.words ?? []).filter(w => POS_ZH[w.pos] && Number.isInteger(w.start));
  if (!words.length) return null;
  // 優先問形容詞／副詞 —— 這是講義裡最常錯的地方
  const hot = words.filter(w => w.pos === 'adj' || w.pos === 'adv');
  const w = hot.length && Math.random() < 0.6 ? pick(hot) : pick(words);
  const distractors = (POS_CONFUSE[w.pos] ?? Object.keys(POS_ZH)).filter(p => p !== w.pos).slice(0, 3);
  return {
    type: 'pos',
    prompt: `「${w.text}」在這句裡是什麼詞性？`,
    sentence: data.original,
    display: data.original,
    highlight: { start: w.start, end: w.end },
    inputMode: 'choice',
    choices: shuffle([w.pos, ...distractors]).map(p => ({ value: p, label: `${p}　${POS_ZH[p]}` })),
    answer: [w.pos],
    explain: `${w.text} 是${POS_ZH[w.pos]}（${w.pos}）。` +
      (w.pos === 'adj' ? '形容詞修飾名詞，或當補語說明主詞怎麼樣；連結動詞後面要接形容詞。'
       : w.pos === 'adv' ? '副詞修飾動詞、形容詞或另一個副詞，不能當連結動詞的補語。' : ''),
    meta: { hash, pos: w.pos },
  };
}

/** 有些三態有兩種寫法（got up / gotten up、was / were），
 *  拆成陣列讓兩種都算對 —— 整串當成一個答案比對的話，
 *  填了其中一種反而算錯。 */
const altsOf = v => String(v ?? '').split(/[/,]/).map(x => x.trim()).filter(Boolean);

function qVerbForms({ hash, data }){
  // be 的過去式是 was／were，取決於主詞，不適合當單一填空答案
  const cl = (data.clauses ?? []).find(c =>
    c.verb?.irregular && c.verb?.forms?.past && c.verb.forms.base !== 'be');
  if (!cl) return null;
  const f = cl.verb.forms;
  const pastAlts = altsOf(f.past), ppAlts = altsOf(f.pastParticiple);
  if (!pastAlts.length || !ppAlts.length) return null;

  const note = [
    pastAlts.length > 1 ? `過去式 ${pastAlts.join(' 和 ')} 都可以` : '',
    ppAlts.length > 1 ? `過去分詞 ${ppAlts.join(' 和 ')} 都可以` : '',
  ].filter(Boolean).join('；');

  return {
    type: 'verb-forms',
    prompt: `寫出 ${f.base} 的過去式與過去分詞`,
    sentence: data.original,
    display: `${f.base}　→　______　→　______`,
    inputMode: 'text',
    blanks: 2,
    answer: [pastAlts[0], ppAlts[0]],            // 顯示用：各取第一種
    accept: [pastAlts, ppAlts],                  // 批改用：每一格各自可接受的寫法
    explain: `${f.base} / ${pastAlts[0]} / ${ppAlts[0]}（不規則變化）\n` +
      (note ? `${note}\n` : '') +
      `現在分詞 ${f.ing}　第三人稱單數 ${f.third}\n例句：${data.original}`,
    meta: { hash },
  };
}

function qErrorFix({ hash, data }){
  if (hasBlank(data.original)) return null;        // 空格本身不是文法錯誤，別拿來當改錯題
  const n = (data.notes ?? []).find(x => x.type === 'error' && x.correction && x.span);
  if (!n) return null;
  return {
    type: 'error-fix',
    prompt: '這句有一個文法問題，把錯的地方改正確',
    sentence: data.original,
    display: data.original,
    highlightText: n.span,
    inputMode: 'text',
    blanks: 1,
    answer: [n.correction],
    alsoAccept: [data.original.replace(n.span, n.correction)],
    explain: `${n.message}\n${n.span} → ${n.correction}`,
    meta: { hash, errorCode: n.errorCode },
  };
}


function qPronounCase({ hash, data }){
  const ws = pronWords(data);
  if (!ws.length) return null;
  const w = pick(ws);
  return {
    type: 'pronoun-case',
    prompt: `「${w.text}」在這句裡是哪一種格位？`,
    sentence: data.original,
    display: data.original,
    highlight: { start: w.start, end: w.end },
    inputMode: 'choice',
    choices: Object.entries(CASE_ZH).map(([k, zh]) => ({ value: k, label: zh })),
    answer: [w.case],
    explain: `${w.text} 是${CASE_ZH[w.case]}。` + (
      w.case === 'possessive' ? '所有格後面一定接名詞。'
      : w.case === 'possessive-pron' ? '所有格代名詞後面不接名詞，自己當名詞用。'
      : w.case === 'object' ? '受格放在動詞或介系詞後面當受詞。'
      : w.case === 'subject' ? '主格當主詞，放在動詞前面。'
      : '反身代名詞表示「自己」。'),
    meta: { hash, case: w.case },
  };
}

function qPronounFill({ hash, data }){
  if (hasBlank(data.original)) return null;        // 已經有空格了，不能再挖
  // 只挑「提示的主格 ≠ 答案」的字，否則 (I) → I 等於直接給答案，沒有練習價值
  const ws = pronWords(data).filter(w =>
    PERSON[w.text.toLowerCase()].toLowerCase() !== w.text.toLowerCase());
  if (!ws.length) return null;
  const w = pick(ws);
  const { display, blanks } = blankOut(data.original, [w]);
  return {
    type: 'pronoun-fill',
    prompt: '填入括號裡代名詞的正確形式',
    sentence: data.original,
    display,
    hint: PERSON[w.text.toLowerCase()],
    inputMode: 'text',
    blanks: 1,
    answer: blanks,
    explain: `這裡要用${CASE_ZH[w.case]} ${w.text}。` + (
      w.case === 'possessive' ? `後面接名詞，所以用所有格而不是主格。`
      : w.case === 'possessive-pron' ? `後面沒有名詞，所以用所有格代名詞而不是所有格。`
      : w.case === 'object' ? `放在動詞或介系詞後面，要用受格。`
      : w.case === 'subject' ? `當主詞，要用主格。`
      : `表示「自己」，要用反身代名詞。`),
    meta: { hash, case: w.case },
  };
}

const BUILDERS = {
  'pattern': qPattern, 'tense': qTense, 'pos': qPos, 'error-fix': qErrorFix,
  'pronoun-case': qPronounCase, 'pronoun-fill': qPronounFill
};
// 動詞三態已移到「單字測驗」—— 那是單字層級的知識，
// 放在有間隔複習的地方才有用；這裡專注在句子層級的能力。
export const TYPES = Object.keys(BUILDERS);

/** 這題涉及的維度目前正確率多低 → 權重多高。沒資料視為中性 */
function weightOf(q, acc){
  if (!acc) return 1;
  let a = null;
  if (q.type === 'pattern' && q.meta.patternId != null) a = acc.patterns?.[q.meta.patternId];
  else if (q.type === 'tense' && q.meta.tenseTime) a = acc.tenses?.[`${q.meta.tenseTime}-${q.meta.tenseAspect}`];
  else if (q.type === 'pos' && q.meta.pos) a = acc.pos?.[q.meta.pos];
  else if (q.type.startsWith('pronoun-') && q.meta.case) a = acc.cases?.[q.meta.case];
  if (a == null) return 1;                    // 沒作答過：中性，仍有機會出現
  return 0.25 + (1 - a) * 2.25;               // 全錯 2.5 倍、全對 0.25 倍
}

/** 依權重隨機抽一題，並從候選池移除 */
function weightedTake(bucket, acc){
  if (!bucket.length) return null;
  const w = bucket.map(q => weightOf(q, acc));
  const sum = w.reduce((a, b) => a + b, 0);
  let r = Math.random() * sum;
  for (let i = 0; i < bucket.length; i++){
    r -= w[i];
    if (r <= 0) return bucket.splice(i, 1)[0];
  }
  return bucket.pop();
}

/** 從已分析的句子生成題目。records = [{ hash, data }]
 *  acc = 各維度正確率；給了就會優先出弱點題 */
/** 判斷兩題算不算「同一題」。動詞三態問的是動詞，其餘問的是句子。 */
function dedupeKey(q){
  return q.type === 'verb-forms' ? `v:${q.answer?.[0] ?? ''}:${q.prompt}` : `s:${q.meta?.hash}`;
}

export function generate(records, { count = 10, types = TYPES, acc = null } = {}){
  const wanted = types.filter(t => BUILDERS[t]);
  if (!wanted.length || !records.length) return [];

  // 每句 × 每題型，先把所有「做得出來」的候選題列出來，再抽樣
  const candidates = [];
  for (const rec of shuffle(records))
    for (const t of wanted){
      const q = BUILDERS[t](rec);
      if (!q) continue;
      // 對話題要把對方說的話一起帶上 —— 少了它，
      // 「make ... for」和「made ... some cards」的對照就看不出來了。
      if (rec.data?.context) q.context = rec.data.context;
      candidates.push(q);
    }
  if (!candidates.length) return [];

  // 盡量讓題型分佈平均，也避免同一句連續出現
  const byType = new Map(wanted.map(t => [t, []]));
  for (const q of shuffle(candidates)) byType.get(q.type)?.push(q);

  const out = [];
  const used = new Set();
  let guard = 0;
  while (out.length < count && guard++ < count * 12){
    for (const t of shuffle(wanted)){
      if (out.length >= count) break;
      const bucket = byType.get(t);
      if (!bucket?.length) continue;
      // 先排除重複的，再依弱點加權抽。
      // 動詞三態的「重複」是同一個動詞 —— 它問的是動詞本身，
      // 句子只是附帶的例句，不同句子裡的 make 問起來一模一樣。
      const fresh = bucket.filter(q => !used.has(dedupeKey(q)));
      const q = weightedTake(fresh.length ? fresh : bucket, acc);
      if (!q) continue;
      const at = bucket.indexOf(q);
      if (at !== -1) bucket.splice(at, 1);
      used.add(dedupeKey(q));
      out.push({ ...q, id: `q${out.length + 1}` });
    }
    if (wanted.every(t => !byType.get(t)?.length)) break;
    if (used.size >= records.length) used.clear();   // 句子用完就允許重複
  }
  return out.slice(0, count);
}

/** 批改：大小寫、前後空白、重複空白、句尾標點都不計較 */
const norm = s => String(s ?? '').trim().toLowerCase()
  .replace(/\s+/g, ' ').replace(/[.!?,;:]+$/, '');

export function grade(question, given){
  const got = Array.isArray(given) ? given : [given];
  // accept 在時，每一格只要符合該格的任一種寫法就算對
  const exact = question.accept
    ? question.accept.length === got.length &&
      question.accept.every((list, i) => list.some(a => norm(a) === norm(got[i])))
    : question.answer.length === got.length &&
      question.answer.every((a, i) => norm(a) === norm(got[i]));
  const alt = (question.alsoAccept ?? []).some(a => norm(a) === norm(got.join(' ')));
  return { correct: exact || alt, expected: question.answer, given: got };
}
