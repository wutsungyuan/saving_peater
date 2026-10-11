// 測驗卷的程式出題器：從素材池直接算出題目，不呼叫模型，答案與分析結果一致。
// 每個題型有一個 candidates 函式（列出所有做得出來的題）；出卷時從裡面抽樣。
// 題目格式沿用既有的練習題（inputMode: choice | text），新增 order（排序）與 open（開放題）。

import { generate as generateGrammar } from '../exercises.mjs';
import { WORD_BUILDERS, findForm, synonymsOf } from '../wordset.mjs';

// ---------- 小工具（亂數由呼叫端提供，測試才能固定）----------
const mk = rng => ({
  rand: n => Math.floor(rng() * n),
  pick: a => a[Math.floor(rng() * a.length)],
  shuffle: a => { const r = [...a]; for (let i = r.length - 1; i > 0; i--){ const j = Math.floor(rng() * (i + 1)); [r[i], r[j]] = [r[j], r[i]]; } return r; },
});
const lc = s => String(s ?? '').toLowerCase();
const mainOf = d => d.clauses?.find(c => c.role === 'main') ?? d.clauses?.[0];
const hasZh = w => (w.senses ?? []).some(s => s.zh);
const sensesZh = w => (w.senses ?? []).filter(s => s.zh);

/** 編輯距離（拼法相近的干擾字用） */
function lev(a, b){
  const m = a.length, n = b.length; if (!m || !n) return Math.max(m, n);
  let prev = Array.from({ length: n + 1 }, (_, j) => j);
  for (let i = 1; i <= m; i++){
    const cur = [i];
    for (let j = 1; j <= n; j++) cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    prev = cur;
  }
  return prev[n];
}

/** 從候選裡抽 n 題：先挑「不同來源」的（key 不同），不夠才允許重複。 */
export function sample(cands, n, rng, key = q => q.meta?.key){
  const { shuffle } = mk(rng);
  const out = [], used = new Set(), rest = [];
  if (n <= 0) return out;
  for (const q of shuffle(cands)){
    const k = key(q);
    if (k != null && used.has(k)) { rest.push(q); continue; }
    if (k != null) used.add(k);
    out.push(q);
    if (out.length >= n) return out;
  }
  for (const q of rest){ if (out.length >= n) break; out.push(q); }
  return out;
}

/** 送給學生的版本：拿掉答案與解析 */
export function publicQuestion(q){
  const { answer, accept, alsoAccept, orders, explain, keywords, sample: _s, checkTerm, meta, ...rest } = q;
  return rest;
}

// ---------- 單題選擇：單字 ----------
function zh2enChoice(w, all, rng){
  const { pick, shuffle } = mk(rng);
  const sense = pick(sensesZh(w)); if (!sense) return null;
  const answer = w.term;
  // 中文意思相同的字（end / finish 都是「結束」）不能當干擾選項，不然兩個都對
  const alike = new Set(synonymsOf(w, sense, all).map(x => lc(x.term)));
  const others = all.filter(x => x !== w && !/\s/.test(x.term) && lc(x.term) !== lc(answer) && !alike.has(lc(x.term)));
  const confusable = (w.confusable ?? []).map(c => c.word).filter(t => t && !/\s/.test(t) && lc(t) !== lc(answer) && !alike.has(lc(t)));
  const similar = others.filter(x => lev(lc(x.term), lc(answer)) <= 3).map(x => x.term);
  const samePos = others.filter(x => (x.senses ?? []).some(s => s.pos === sense.pos)).map(x => x.term);
  const d = [];
  for (const t of [...confusable, ...shuffle(similar), ...shuffle(samePos), ...shuffle(others.map(x => x.term))])
    if (!d.some(x => lc(x) === lc(t)) && lc(t) !== lc(answer)) d.push(t);
  if (d.length < 3) return null;
  return {
    type: 'mc', skill: 'word-zh2en', inputMode: 'choice', src: 'scope',
    prompt: '選出這個中文意思的英文單字', question: sense.zh, hint: sense.pos,
    choices: shuffle([answer, ...d.slice(0, 3)]).map(t => ({ value: t, label: t })),
    answer: [answer],
    explain: `${answer}（${w.syllables ?? answer}）${sense.pos} ${sense.zh}` + (w.spellTip ? `\n拼字：${w.spellTip}` : ''),
    meta: { key: `w${w.id}`, stat: { kind: 'word', wordId: w.id, wordIds: w.mergedIds ?? [w.id], senseIdx: (w.senses ?? []).indexOf(sense), mode: 'zh2en' } },
  };
}

function candMcWord(pool, rng){
  const out = [];
  for (const w of pool.words.filter(hasZh)){
    const b = WORD_BUILDERS.en2zh(w, pool.words);
    if (b) out.push({ ...b, type: 'mc', skill: 'word-en2zh', src: 'scope',
      meta: { key: `w${w.id}`, stat: { kind: 'word', wordId: w.id, wordIds: w.mergedIds ?? [w.id], senseIdx: b.meta?.senseIdx ?? 0, mode: 'en2zh' } } });
    const z = zh2enChoice(w, pool.words, rng);
    if (z) out.push(z);
  }
  return out;
}

// ---------- 單題選擇：文法 ----------
/** 動詞形式選擇題：把主要子句的動詞挖空，選項是它的各種形式。
 *  只出有「時間線索」的句子（yesterday、every day、now…），這樣其他形式一定是錯的，不會兩個答案都對。 */
function candMcVerb(pool, rng){
  const { shuffle } = mk(rng);
  const out = [];
  for (const r of pool.records){
    const d = r.data, main = mainOf(d), v = main?.verb, f = v?.forms, form = v?.form;
    if (!main || !f || !form || /[\s/]/.test(form) || (d.clauses?.length ?? 0) !== 1) continue;
    const ev = (main.tense?.evidence ?? []).filter(e => lc(e) !== lc(form));
    if (!ev.length || !main.tense?.label) continue;                                  // 沒有時間線索：不出這類題
    const w = (d.words ?? []).find(x => lc(x.text) === lc(form) && Number.isInteger(x.start));
    if (!w || w.start === 0) continue;
    const forms = [...new Set([f.base, f.past, f.pastParticiple, f.ing, f.third].filter(x => x && !/[\s/]/.test(x)))];
    if (forms.length < 4 || !forms.some(x => lc(x) === lc(form))) continue;
    const opts = shuffle([form, ...shuffle(forms.filter(x => lc(x) !== lc(form))).slice(0, 3)]);
    out.push({
      type: 'mc', skill: 'verb-form', inputMode: 'choice', src: 'scope', prompt: '選出適合的動詞形式',
      question: replaceAt(d.original, w.start, w.end, '______'), hint: `（${f.base}）`,
      choices: opts.map(o => ({ value: o, label: o })), answer: [form],
      explain: `${d.original}\n這句是${main.tense.label}（${main.tense.formula ?? ''}），線索：${ev.join('、')}。`,
      meta: { key: `s${r.hash}`, stat: { kind: 'sentence', qtype: 'verb-forms', hash: r.hash, tenseTime: main.tense.time, tenseAspect: main.tense.aspect } },
    });
  }
  return out;
}

function candMcGrammar(pool, rng){
  if (!pool.records.length) return [];
  // 沿用句子練習的出題引擎，但單題選擇只要「選擇題」（時態填空是文字輸入，不收）
  const fromEngine = generateGrammar(pool.records, { count: Math.min(240, pool.records.length * 4), types: ['pattern', 'pos', 'pronoun-case'], acc: null })
    .filter(q => q.inputMode === 'choice')
    .map(q => ({ ...q, type: 'mc', skill: q.type, src: 'scope',
      meta: { ...q.meta, key: `s${q.meta?.hash}`,
        stat: { kind: 'sentence', qtype: q.type, hash: q.meta?.hash, patternId: q.meta?.patternId, tenseTime: q.meta?.tenseTime,
                tenseAspect: q.meta?.tenseAspect, pos: q.meta?.pos, pronCase: q.meta?.case } } }));
  return [...fromEngine, ...candMcVerb(pool, rng)];
}

// ---------- 單字填空（例句挖空）----------
function candFill(pool){
  const out = [];
  for (const w of pool.words){
    const b = WORD_BUILDERS.cloze(w);
    if (b) out.push({ ...b, type: 'fill', skill: 'word-cloze', src: 'scope',
      meta: { key: `w${w.id}`, stat: { kind: 'word', wordId: w.id, wordIds: w.mergedIds ?? [w.id], senseIdx: b.meta?.senseIdx ?? 0, mode: 'cloze' } } });
  }
  return out;
}

// ---------- 配合題（單字配中文）----------
function candMatch(pool){
  return pool.words.filter(hasZh).map(w => {
    const s = sensesZh(w)[0];
    return { type: 'match', skill: 'word-match', inputMode: 'choice', src: 'scope', prompt: '配合題：選出正確的中文意思', question: w.term, hint: s.pos,
      choices: null, answer: [s.zh], explain: `${w.term} ${s.pos} ${s.zh}`,
      meta: { key: `w${w.id}`, zh: s.zh, stat: { kind: 'word', wordId: w.id, wordIds: w.mergedIds ?? [w.id], senseIdx: 0, mode: 'en2zh' } } };
  });
}
/** 配合題的選項：所有答案 + 2 個多餘的中文（取自沒被選到的字），全部題目共用同一份選項 */
function finishMatch(qs, pool, rng){
  const { shuffle } = mk(rng);
  const zhs = [...new Set(qs.map(q => q.answer[0]))];
  const extra = shuffle(pool.words.filter(hasZh).flatMap(w => sensesZh(w).map(s => s.zh))).filter(z => !zhs.includes(z));
  const options = shuffle([...zhs, ...[...new Set(extra)].slice(0, 2)]).map(z => ({ value: z, label: z }));
  return qs.map(q => ({ ...q, choices: options }));
}

// ---------- 句子重組 ----------
/** 把單句拆成「成分」積木：主詞、動詞、受詞、各種修飾語。回傳 { chunks, orders } 或 null */
export function chunksOf(data){
  if (!data || (data.clauses?.length ?? 0) !== 1) return null;                // 只用單句，複句太難排
  const original = data.original, main = mainOf(data);
  if (!main || main.alignment?.ok === false) return null;
  const words = original.split(/\s+/).filter(Boolean);
  if (words.length < 4 || words.length > 14) return null;
  const cons = (main.constituents ?? []).filter(c => Number.isInteger(c.start) && Number.isInteger(c.end) && c.end > c.start)
    .sort((a, b) => a.start - b.start);
  if (cons.length < 3) return null;
  const chunks = []; let pos = 0;
  const letters = s => /[A-Za-z]/.test(s);
  for (const c of cons){
    if (c.start < pos) return null;                                           // 重疊的成分，放棄
    const gap = original.slice(pos, c.start).trim();
    if (letters(gap)) chunks.push({ text: gap, role: 'gap' });
    chunks.push({ text: original.slice(c.start, c.end).trim(), role: c.role });
    pos = c.end;
  }
  const tail = original.slice(pos).trim();
  if (letters(tail)) chunks.push({ text: tail, role: 'gap' });
  if (chunks.length < 3 || chunks.length > 8) return null;
  const texts = chunks.map(c => c.text);
  // 句尾標點跟著最後一塊
  const end = original.trim().match(/[.!?]+$/)?.[0];
  if (end && !texts.at(-1).endsWith(end)) texts[texts.length - 1] += end;
  const orders = [texts];
  // 時間修飾語放句首或句尾都對（口訣：時間可以移到句首強調）
  // （含逗號的不動：Yesterday, Tom… 搬到句尾會變成 …yesterday,）
  const ti = chunks.findIndex(c => c.role === 'M-time');
  if ((ti === 0 || ti === chunks.length - 1) && !/[,;]/.test(texts[ti])){
    const t = texts[ti].replace(/[.!?]+$/, ''), rest = texts.filter((_, i) => i !== ti), strip = s => s.replace(/[.!?]+$/, '');
    if (ti === 0) orders.push([...rest.slice(0, -1), strip(rest.at(-1)), t + (end ?? '')]);         // 時間在句首 → 也可以放句尾
    else orders.push([t, ...rest.slice(0, -1), strip(rest.at(-1)) + (end ?? '')]);                  // 時間在句尾 → 也可以放句首
  }
  return { chunks: texts, orders };
}

function candReorder(pool, rng){
  const { shuffle } = mk(rng);
  const out = [];
  for (const r of pool.records){
    const c = chunksOf(r.data); if (!c) continue;
    let sh = shuffle(c.chunks), tries = 0;
    while (c.orders.some(o => o.join('|') === sh.join('|')) && tries++ < 10) sh = shuffle(c.chunks);
    if (c.orders.some(o => o.join('|') === sh.join('|'))) continue;
    out.push({ type: 'reorder', skill: 'reorder', inputMode: 'order', src: 'scope', prompt: '把下面的詞組排成正確的句子', question: r.data.translation ?? null,
      chunks: sh, answer: [r.data.original], orders: c.orders, explain: `${r.data.original}${r.data.translation ? '\n' + r.data.translation : ''}`,
      meta: { key: `s${r.hash}`, stat: { kind: 'paper', qtype: 'paper-reorder', hash: r.hash } } });
  }
  return out;
}

// ---------- 改錯 ----------
const replaceAt = (s, start, end, t) => s.slice(0, start) + t + s.slice(end);
/** 保證會錯的改法：① 第三人稱單數的動詞還原成原形；② 有明確過去時間線索時，過去式改成原形。 */
export function breakSentence(data){
  const main = mainOf(data), v = main?.verb, f = v?.forms, form = v?.form;
  if (!main || !f || !form || /[\s/]/.test(form) || (data.clauses?.length ?? 0) !== 1) return null;
  const w = (data.words ?? []).find(x => lc(x.text) === lc(form) && Number.isInteger(x.start));
  if (!w || w.start === 0) return null;
  const base = f.base;
  if (!base || lc(base) === lc(form) || /[\s/]/.test(base)) return null;
  const t = main.tense;
  const third = t?.time === 'present' && t?.aspect === 'simple' && lc(form) === lc(f.third);
  const timeEvidence = (t?.evidence ?? []).some(e => lc(e) !== lc(form) && !/\s/.test(e) && /^(yesterday|ago|last|then)$/i.test(e) || /\b(last|ago|yesterday)\b/i.test(e));
  const past = t?.time === 'past' && t?.aspect === 'simple' && lc(form) === lc(f.past) && timeEvidence;
  if (!third && !past) return null;
  const wrong = replaceAt(data.original, w.start, w.end, base);
  return { wrong, why: third ? `主詞是第三人稱單數，現在簡單式的動詞要加 s（${form}），不能用原形 ${base}。`
                             : `句子有明確的過去時間，動詞要用過去式 ${form}，不能用原形 ${base}。` };
}

function candFix(pool){
  const out = [];
  for (const r of pool.records){
    const d = r.data; let item = null;
    const err = (d.notes ?? []).find(n => n.type === 'error' && n.correction && n.span && d.original.includes(n.span));
    if (err){
      const fixed = d.original.replace(err.span, err.correction);
      if (lc(fixed) !== lc(d.original)) item = { wrong: d.original, right: fixed, why: err.message };      // 真實的學生錯誤
    }
    if (!item){ const b = breakSentence(d); if (b) item = { wrong: b.wrong, right: d.original, why: b.why }; }
    if (!item) continue;
    out.push({ type: 'fix', skill: 'error-fix', inputMode: 'text', blanks: 1, src: 'scope', prompt: '這句話有一個文法錯誤，請改成正確的句子', question: item.wrong,
      answer: [item.right], explain: `正確：${item.right}\n${item.why ?? ''}`.trim(),
      meta: { key: `s${r.hash}`, stat: { kind: 'paper', qtype: 'paper-fix', hash: r.hash } } });
  }
  return out;
}

// ---------- 造句、翻譯（開放題：程式出題，批改預設程式檢查加自評）----------
function candMake(pool){
  return pool.words.filter(hasZh).map(w => {
    const s = sensesZh(w)[0];
    return { type: 'make', skill: 'make', inputMode: 'open', src: 'scope', prompt: `用「${w.term}」造一個句子`, hint: `${s.pos}　${s.zh}`,
      checkTerm: w.term, answer: [], sample: s.example ?? null, explain: s.example ? `參考：${s.example}${s.exampleZh ? '\n' + s.exampleZh : ''}` : '',
      meta: { key: `w${w.id}`, stat: null } };
  });
}

const CONTENT = new Set(['n', 'v', 'adj', 'adv']);
function candTrans(pool){
  return pool.records.filter(r => r.data.translation && !r.data.issue && (r.data.original.split(/\s+/).length >= 3)).map(r => ({
    type: 'trans', skill: 'trans', inputMode: 'open', src: 'scope', prompt: '把下面的句子翻成英文', question: r.data.translation,
    answer: [r.data.original], keywords: (r.data.words ?? []).filter(w => CONTENT.has(w.pos)).map(w => lc(w.text)),
    explain: `參考答案：${r.data.original}`, meta: { key: `s${r.hash}`, stat: null } }));
}

// ---------- 免費延伸（字族、易混淆字；只限單字類題型）----------
function candExtFree(type, pool, rng){
  const { shuffle } = mk(rng);
  const ext = pool.extWords; if (!ext.length) return [];
  const scopeZh = [...new Set(pool.words.filter(hasZh).flatMap(w => sensesZh(w).map(s => s.zh)))];
  const base = e => ({ src: 'ext-free', meta: { key: `e${lc(e.term)}`, anchors: [{ word: e.from, rel: e.rel }], stat: null } });
  if (type === 'mc') return ext.map(e => {
    // 干擾項不能和答案太像：中文有共同的兩個字以上（親切地／親切；善意）就會有兩個都說得通
    const alike = z => { for (let i = 0; i + 2 <= e.zh.length; i++) if (z.includes(e.zh.slice(i, i + 2))) return true; return false; };
    const wrong = shuffle([...scopeZh, ...ext.map(x => x.zh)]).filter(z => z !== e.zh && !alike(z));
    const d = [...new Set(wrong)].slice(0, 3); if (d.length < 3) return null;
    const b = base(e);
    return { type: 'mc', skill: 'word-ext', inputMode: 'choice', prompt: `「${e.term}」是什麼意思？`, question: e.term, hint: e.pos,
      choices: shuffle([e.zh, ...d]).map(z => ({ value: z, label: z })), answer: [e.zh],
      explain: `${e.term}${e.pos ? ' ' + e.pos : ''} ${e.zh}\n（和你的單字 ${e.from} 有關）`, ...b };
  }).filter(Boolean);
  if (type === 'match') return ext.map(e => ({ type: 'match', skill: 'word-match', inputMode: 'choice', prompt: '配合題：選出正確的中文意思', question: e.term, hint: e.pos,
    choices: null, answer: [e.zh], explain: `${e.term} ${e.zh}（和你的單字 ${e.from} 有關）`, ...base(e), meta: { ...base(e).meta, zh: e.zh } }));
  if (type === 'make') return ext.map(e => ({ type: 'make', skill: 'make', inputMode: 'open', prompt: `用「${e.term}」造一個句子`, hint: `${e.pos ?? ''}　${e.zh}`.trim(),
    checkTerm: e.term, answer: [], sample: null, explain: `${e.term} ${e.zh}（和你的單字 ${e.from} 有關）`, ...base(e) }));
  return [];
}

// ---------- 文章型：文意選填、克漏字（文法型）----------
const PREPS = ['in', 'on', 'at', 'for', 'to', 'with', 'of', 'by', 'from', 'about', 'after', 'before', 'under', 'into'];
const CONJS = ['and', 'but', 'or', 'so', 'because', 'when', 'if', 'although', 'while'];
const PRON = { he: ['he', 'him', 'his', 'himself'], him: ['he', 'him', 'his', 'himself'], his: ['he', 'him', 'his', 'himself'],
  she: ['she', 'her', 'hers', 'herself'], her: ['she', 'her', 'hers', 'herself'], hers: ['she', 'her', 'hers', 'herself'],
  i: ['I', 'me', 'my', 'mine'], me: ['I', 'me', 'my', 'mine'], my: ['I', 'me', 'my', 'mine'],
  we: ['we', 'us', 'our', 'ours'], us: ['we', 'us', 'our', 'ours'], our: ['we', 'us', 'our', 'ours'],
  they: ['they', 'them', 'their', 'theirs'], them: ['they', 'them', 'their', 'theirs'], their: ['they', 'them', 'their', 'theirs'],
  you: ['you', 'your', 'yours', 'yourself'], your: ['you', 'your', 'yours', 'yourself'] };

/** 一個句子裡「語法決定答案」的挖空位置：介系詞、連接詞、動詞形式、代名詞格。 */
export function grammarTargets(data, rng){
  const { shuffle } = mk(rng);
  const out = [];
  const taken = [];
  const free = (s, e) => !taken.some(([a, b]) => s < b && e > a);
  const add = (w, options, why, kind) => {
    if (!Number.isInteger(w.start) || w.start === 0 || !free(w.start, w.end)) return;
    const opts = [...new Set(options.filter(o => lc(o) !== lc(w.text)))].slice(0, 3);
    if (opts.length < 3) return;
    taken.push([w.start, w.end]);
    out.push({ start: w.start, end: w.end, text: w.text, options: shuffle([w.text, ...opts]), why, kind });
  };
  const main = mainOf(data), f = main?.verb?.forms, form = main?.verb?.form;
  for (const w of data.words ?? []){
    const t = lc(w.text);
    if (w.pos === 'prep' && PREPS.includes(t)) add(w, shuffle(PREPS.filter(p => p !== t)), `這裡要用介系詞 ${w.text}。`, 'prep');
    else if (w.pos === 'conj' && CONJS.includes(t)) add(w, shuffle(CONJS.filter(p => p !== t)), `這裡要用連接詞 ${w.text}。`, 'conj');
    else if (w.pos === 'pron' && PRON[t]) add(w, PRON[t], `依空格前後的位置，這裡要用 ${w.text}（${w.case === 'subject' ? '主格' : w.case === 'object' ? '受格' : '所有格'}）。`, 'pron');
    else if (f && form && !/[\s/]/.test(form) && t === lc(form) && (w.pos === 'v')){
      const forms = [...new Set([f.base, f.past, f.pastParticiple, f.ing, f.third].filter(x => x && !/[\s/]/.test(x)))];
      add(w, forms, `動詞的形式要配合句子：${form}。`, 'verb');
    }
  }
  return out;
}

const textOfParas = paras => paras.map(p => p.map(s => s.text).join(' ')).join('\n\n');
/** 組出短文：對話課文每次發言一行，前面標說話者（Jamie: …）；一般文章段落之間空一行 */
const passageText = (art, paras) => art.dialogue
  ? paras.map(p => `${art.paragraphs.find(x => x.para === p.para)?.speaker ?? ''}: ${p.items.join(' ')}`).join('\n')
  : paras.map(p => p.items.join(' ')).join('\n\n');

/** 克漏字（文法型）：回傳 { passage, questions }。semantic：模型寫的語意型干擾項（Phase 3），可選。 */
export function buildCloze(pool, n, rng, semantic = []){
  const { shuffle } = mk(rng);
  for (const art of shuffle(pool.articles)){
    const sents = art.paragraphs.flatMap(p => p.sentences.map(s => ({ para: p.para, ...s })));
    // 從頭累積句子，直到挖得出 n 個空格
    let picked = [], blanksPer = [];
    for (const s of sents){
      const tg = grammarTargets(s.data, rng);
      const sem = semantic.filter(x => x.hash === s.hash);
      picked.push(s); blanksPer.push({ s, tg: shuffle(tg).slice(0, 2), sem });
      if (blanksPer.reduce((a, b) => a + b.tg.length + b.sem.length, 0) >= n) break;
    }
    const total = blanksPer.reduce((a, b) => a + b.tg.length + b.sem.length, 0);
    if (total < Math.min(n, 5)) continue;
    let k = 0; const questions = []; const paras = [];
    for (const { s, tg, sem } of blanksPer){
      let text = s.original; const edits = [];
      for (const t of tg) edits.push({ start: t.start, end: t.end, t });
      for (const x of sem){
        const i = text.indexOf(x.word, 1);
        if (i > 0 && !edits.some(e => i < e.end && i + x.word.length > e.start))
          edits.push({ start: i, end: i + x.word.length, t: { text: x.word, options: shuffle([x.word, ...x.distractors.slice(0, 3)]), why: `依上下文，這裡要用 ${x.word}。`, kind: 'semantic' } });
      }
      // 空格數不能超過題數：挖出來的空格和題目必須一一對應，否則文章上會有沒題目的空格
      const numbered = edits.sort((a, b) => a.start - b.start).slice(0, Math.max(0, n - k));
      numbered.forEach(e => { e.no = ++k; });
      for (const e of [...numbered].sort((a, b) => b.start - a.start)) text = replaceAt(text, e.start, e.end, `(${e.no})`);   // 從後面往前換，座標才不會亂
      for (const e of numbered) questions.push({ type: 'cloze', skill: `cloze-${e.t.kind}`, inputMode: 'choice', src: 'scope', blankNo: e.no,
        prompt: `第 ${e.no} 格`, choices: e.t.options.map(o => ({ value: o, label: o })), answer: [e.t.text], explain: e.t.why,
        meta: { stat: { kind: 'paper', qtype: 'paper-cloze', hash: s.hash } } });
      const last = paras.at(-1);
      if (last && last.para === s.para) last.items.push({ text }); else paras.push({ para: s.para, items: [{ text }] });
      if (k >= n) break;
    }
    if (questions.length < Math.min(n, 5)) continue;
    const passage = { title: art.name, text: passageText(art, paras.map(p => ({ para: p.para, items: p.items.map(i => i.text) }))) };
    return { passage, questions: questions.slice(0, n), articleId: art.id };
  }
  return null;
}

/** 文意選填：從文章挖出字表裡的字，字庫是答案加 2 個多餘的字。 */
export function buildWordBank(pool, n, rng){
  const { shuffle } = mk(rng);
  if (!pool.words.length) return null;
  for (const art of shuffle(pool.articles)){
    const sents = art.paragraphs.flatMap(p => p.sentences.map(s => ({ para: p.para, ...s })));
    const used = new Set(), blanks = [];
    sents.forEach((s, si) => {
      for (const w of shuffle(pool.words)){
        if (blanks.length >= n) return;
        if (used.has(lc(w.term)) || /\s|\./.test(w.term)) continue;
        const f = findForm(s.original, w.term);
        if (!f || f.start === 0) continue;
        if (blanks.some(b => b.si === si && f.start < b.end && f.end > b.start)) continue;
        used.add(lc(w.term)); blanks.push({ si, start: f.start, end: f.end, text: f.text, term: w.term });
      }
    });
    if (blanks.length < Math.min(n, 4)) continue;
    const answers = blanks.map(b => b.text);
    if (new Set(answers.map(lc)).size !== answers.length) continue;
    const extra = shuffle(pool.words.filter(w => !used.has(lc(w.term)) && !/\s|\./.test(w.term)).map(w => w.term)).slice(0, 2);
    const bank = shuffle([...answers, ...extra]).map(t => ({ value: t, label: t }));
    const first = Math.min(...blanks.map(b => b.si)), last = Math.max(...blanks.map(b => b.si));
    const sorted = [...blanks].sort((a, b) => a.si - b.si || a.start - b.start); sorted.forEach((b, i) => { b.no = i + 1; });
    const paras = [];
    for (let si = first; si <= last; si++){
      let text = sents[si].original;
      for (const b of blanks.filter(x => x.si === si).sort((a, b) => b.start - a.start)) text = replaceAt(text, b.start, b.end, `(${b.no})`);
      const lastP = paras.at(-1);
      if (lastP && lastP.para === sents[si].para) lastP.items.push(text); else paras.push({ para: sents[si].para, items: [text] });
    }
    const questions = sorted.map(b => ({ type: 'wbank', skill: 'word-bank', inputMode: 'choice', src: 'scope', blankNo: b.no, prompt: `第 ${b.no} 格`,
      choices: bank, answer: [b.text], explain: `這裡要填 ${b.text}（${b.term}）。`,
      meta: { stat: { kind: 'paper', qtype: 'paper-wbank' } } }));
    return { passage: { title: art.name, text: passageText(art, paras), bank: bank.map(x => x.value) }, questions: questions.slice(0, n), articleId: art.id };
  }
  return null;
}

// ---------- 對外介面 ----------
const CANDS = {
  fill: candFill, match: candMatch, reorder: candReorder, fix: candFix, make: candMake, trans: candTrans,
};

/** 這個題型在範圍內最多出得了幾題（供配題限制用）。read 要看模型題庫，由呼叫端另外給。 */
export function supplyOf(pool, rng, { clozeSemantic = [] } = {}){
  const supply = {};
  const mcW = candMcWord(pool, rng).length, mcG = candMcGrammar(pool, rng).length;
  supply.mc = Math.min(60, mcW + mcG) || 0;
  for (const [type, fn] of Object.entries(CANDS)) supply[type] = Math.min(40, fn(pool, rng).length);
  supply.wbank = buildWordBank(pool, 8, rng)?.questions.length ?? 0;
  supply.cloze = buildCloze(pool, 10, rng, clozeSemantic)?.questions.length ?? 0;
  return supply;
}

/**
 * 出某個題型。回傳 { questions, passages }。
 * ext：這個題型有幾題是延伸題；extFree：其中免費的幾題；modelItems：模型延伸題（呼叫端先備好，已是題目格式）
 */
export function generateType(type, n, pool, rng, { ext = 0, extFree = 0, modelItems = [], clozeSemantic = [] } = {}){
  const { shuffle } = mk(rng);
  if (type === 'wbank'){ const r = buildWordBank(pool, n, rng); return r ? { questions: r.questions, passages: [r.passage], ext: 0, extFree: 0 } : { questions: [], passages: [], ext: 0, extFree: 0 }; }
  if (type === 'cloze'){ const r = buildCloze(pool, n, rng, clozeSemantic); return r ? { questions: r.questions, passages: [r.passage], ext: 0, extFree: 0 } : { questions: [], passages: [], ext: 0, extFree: 0 }; }

  // 延伸題先定下來：免費延伸 + 呼叫端備好的模型延伸。湊不到的部分改用範圍內的題目補，題數不能少。
  const free = extFree ? sample(candExtFree(type, pool, rng), extFree, rng) : [];
  const model = modelItems.slice(0, Math.max(0, ext - free.length));
  const scopeN = Math.max(0, n - free.length - model.length);
  let scope = [];
  if (type === 'mc'){
    // 單字與文法各一半；只有一種素材就全出那一種
    const w = candMcWord(pool, rng), g = candMcGrammar(pool, rng);
    const nw = !g.length ? scopeN : !w.length ? 0 : Math.round(scopeN / 2);
    scope = [...sample(w, Math.min(nw, w.length), rng), ...sample(g, scopeN - Math.min(nw, w.length), rng)];
    if (scope.length < scopeN){ const have = new Set(scope); scope.push(...sample([...w, ...g].filter(q => !have.has(q)), scopeN - scope.length, rng)); }
  } else scope = sample(CANDS[type](pool, rng), scopeN, rng);
  if (type === 'match') scope = finishMatch(scope, pool, rng);

  let questions = shuffle([...scope, ...free, ...model]);
  if (type === 'match' && free.length) questions = finishMatch(questions.map(q => ({ ...q, choices: null })), pool, rng);
  // 回報實際延伸了幾題（可能比要求的少：免費延伸字不夠、模型題還沒有）
  return { questions, passages: [], ext: free.length + model.length, extFree: free.length };
}
