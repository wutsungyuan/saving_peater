// 模型出的題入庫前的程式檢查。模型寫的內容不能直接給小朋友：
// 選項要剛好 4 個且不重複、答案索引正確、依據的句子存在、延伸題要用到範圍內的單字、新字不能太多。
// 不合格的丟掉，只重出缺的那幾題，不會整批重來。

import { createHash } from 'node:crypto';
import { findForm } from '../wordset.mjs';

const lc = s => String(s ?? '').toLowerCase();
export const tokensOf = text => lc(text).match(/[a-z]+(?:'[a-z]+)?/g) ?? [];
const str = (v, max = 400) => (typeof v === 'string' ? v.trim().slice(0, max) : '');
const strip = s => String(s ?? '').replace(/[.!?]+$/, '').trim();

/** 句子裡不在已知字集的字（人名、數字、太短的字不算） */
export function newWords(text, known){
  const out = [];
  const raw = String(text ?? '');
  for (const m of raw.matchAll(/[A-Za-z]+(?:'[A-Za-z]+)?/g)){
    const w = m[0], t = lc(w);
    if (t.length <= 2 || known.has(t)) continue;
    if (m.index > 0 && /[A-Z]/.test(w[0])) continue;                      // 句中的大寫字多半是人名、地名
    if (known.has(t.replace(/(es|s|ed|ing|ly)$/, ''))) continue;           // 變化形
    out.push(t);
  }
  return [...new Set(out)];
}

const hasAnchor = (text, anchors) => anchors.filter(a => findForm(text, a));

/** 4 選 1 的選擇題。回傳整理好的 { q, choices, answer, skill, evidence, explain } 或 { error } */
function choiceItem(raw, { nSentences = 0, needEvidence = false, passageText = '' } = {}){
  const q = str(raw?.q ?? raw?.question, 300);
  const choices = Array.isArray(raw?.choices) ? raw.choices.map(c => str(c, 120)) : [];
  if (!q) return { error: '沒有題目' };
  if (choices.length !== 4 || choices.some(c => !c)) return { error: '選項不是 4 個' };
  if (new Set(choices.map(lc)).size !== 4) return { error: '選項重複' };
  const answer = raw?.answer;
  if (!Number.isInteger(answer) || answer < 0 || answer > 3) return { error: '答案索引不對' };
  let evidence = [];
  if (needEvidence){
    evidence = (Array.isArray(raw?.evidence) ? raw.evidence : []).filter(n => Number.isInteger(n) && n >= 1 && n <= nSentences);
    if (!evidence.length) return { error: '沒有有效的依據句' };
  }
  const skill = ['detail', 'inference', 'main', 'vocab'].includes(raw?.skill) ? raw.skill : 'detail';
  if (skill === 'vocab' && passageText){
    const w = /"([^"]+)"/.exec(q)?.[1];
    if (!w || !lc(passageText).includes(lc(w))) return { error: '字義題問的字不在文章裡' };
  }
  return { q, choices, answer, skill, evidence, explain: str(raw?.explain, 80) };
}

/** 閱讀測驗題（針對一篇文章）。回傳 { items, dropped } */
export function validateRead(raw, { nSentences, passageText }){
  const items = [], dropped = [];
  for (const r of Array.isArray(raw?.questions) ? raw.questions : []){
    const v = choiceItem(r, { nSentences, needEvidence: true, passageText });
    v.error ? dropped.push({ type: 'read', reason: v.error }) : items.push(v);
  }
  return { items, dropped };
}

/** 克漏字的語意干擾項。targets：[{ n, word }]（我們挖的空），回傳每個 target 的 3 個干擾項 */
export function validateCloze(raw, targets){
  const items = [], dropped = [];
  for (const r of Array.isArray(raw?.items) ? raw.items : []){
    const t = targets.find(x => x.n === r?.n && lc(x.word) === lc(r?.word));
    const d = Array.isArray(r?.distractors) ? r.distractors.map(x => str(x, 40)).filter(Boolean) : [];
    if (!t) { dropped.push({ type: 'cloze', reason: '不是我們挖的空' }); continue; }
    const uniq = [...new Set(d.map(lc))].filter(x => x !== lc(t.word));
    if (uniq.length < 3 || d.some(x => /\s/.test(x) && !/\s/.test(t.word))) { dropped.push({ type: 'cloze', reason: '干擾項不足或不合格' }); continue; }
    items.push({ n: t.n, word: t.word, distractors: d.filter((x, i) => uniq.includes(lc(x)) && d.findIndex(y => lc(y) === lc(x)) === i).slice(0, 3) });
  }
  return { items, dropped };
}

/** 兩句話是不是只差一個字（替換、多一個字、少一個字） */
export function oneWordApart(a, b){
  const x = strip(a).split(/\s+/), y = strip(b).split(/\s+/);
  if (Math.abs(x.length - y.length) > 1 || lc(strip(a)) === lc(strip(b))) return false;
  let i = 0; while (i < x.length && i < y.length && lc(x[i]) === lc(y[i])) i++;
  let j = 0; while (j < x.length - i && j < y.length - i && lc(x.at(-1 - j)) === lc(y.at(-1 - j))) j++;
  return Math.max(x.length, y.length) - i - j <= 1;
}

/**
 * 延伸題。anchors：[單字]（範圍內的字），known：已知字集，maxNew：每題新字上限。
 * 回傳 { items: { mc, reorder, fix, trans, read }, dropped }
 */
export function validateExt(raw, { anchors, known, maxNew = 1 }){
  const out = { mc: [], reorder: [], fix: [], trans: [], read: [] }, dropped = [];
  const drop = (type, reason) => dropped.push({ type, reason });
  const anchorsOf = (item, text) => {
    const declared = (Array.isArray(item?.anchors) ? item.anchors : []).map(a => str(a, 40)).filter(a => anchors.some(x => lc(x) === lc(a)));
    return declared.filter(a => hasAnchor(text, [a]).length);                  // 宣告的依據字必須真的出現在題目文字裡
  };
  const tooNew = text => newWords(text, known).length > maxNew;

  for (const r of raw?.mc ?? []){
    const v = choiceItem(r); if (v.error) { drop('mc', v.error); continue; }
    if (!/_{3,}/.test(v.q) || (v.q.match(/_{3,}/g) || []).length !== 1) { drop('mc', '題幹要剛好有一個空格'); continue; }
    const text = v.q + ' ' + v.choices.join(' ');
    const an = anchorsOf(r, text); if (!an.length) { drop('mc', '沒有用到範圍內的單字'); continue; }
    if (tooNew(v.q)) { drop('mc', '新字太多'); continue; }
    out.mc.push({ ...v, anchors: an, kind: ['verb-form', 'preposition', 'conjunction', 'pronoun', 'word-choice'].includes(r.skill) ? r.skill : 'word-choice' });
  }
  for (const r of raw?.reorder ?? []){
    const sentence = str(r?.sentence, 200), chunks = Array.isArray(r?.chunks) ? r.chunks.map(c => str(c, 80)) : [];
    if (!sentence || chunks.length < 3 || chunks.length > 6 || chunks.some(c => !c)) { drop('reorder', '積木數不對'); continue; }
    if (lc(strip(chunks.join(' '))) !== lc(strip(sentence))) { drop('reorder', '積木接起來不是原句'); continue; }
    const an = anchorsOf(r, sentence); if (!an.length) { drop('reorder', '沒有用到範圍內的單字'); continue; }
    if (tooNew(sentence)) { drop('reorder', '新字太多'); continue; }
    out.reorder.push({ sentence, chunks, zh: str(r?.zh, 120), anchors: an });
  }
  for (const r of raw?.fix ?? []){
    const wrong = str(r?.wrong, 200), right = str(r?.right, 200);
    if (!wrong || !right || !oneWordApart(wrong, right)) { drop('fix', '錯句與原句不是只差一個字'); continue; }
    const an = anchorsOf(r, right); if (!an.length) { drop('fix', '沒有用到範圍內的單字'); continue; }
    if (tooNew(right)) { drop('fix', '新字太多'); continue; }
    out.fix.push({ wrong, right, why: str(r?.why, 100), anchors: an });
  }
  for (const r of raw?.trans ?? []){
    const zh = str(r?.zh, 120), en = str(r?.en, 200);
    if (!/[一-鿿]/.test(zh) || tokensOf(en).length < 3) { drop('trans', '中英文不對'); continue; }
    const an = anchorsOf(r, en); if (!an.length) { drop('trans', '沒有用到範圍內的單字'); continue; }
    if (tooNew(en)) { drop('trans', '新字太多'); continue; }
    out.trans.push({ zh, en, anchors: an });
  }
  for (const r of raw?.read ?? []){
    const sentences = Array.isArray(r?.sentences) ? r.sentences.map(s => str(s, 200)) : [];
    if (sentences.length < 4 || sentences.length > 8 || sentences.some(s => !s)) { drop('read', '短文句數不對'); continue; }
    const text = sentences.join(' ');
    const an = anchorsOf(r, text); if (!an.length) { drop('read', '沒有用到範圍內的單字'); continue; }
    const toks = tokensOf(text);
    if (newWords(text, known).length > Math.max(1, Math.floor(toks.length * 0.05))) { drop('read', '短文新字超過 5%'); continue; }
    const v = validateRead({ questions: r.questions }, { nSentences: sentences.length, passageText: text });
    dropped.push(...v.dropped);
    if (v.items.length < 3) { drop('read', '短文的題目不足 3 題'); continue; }
    out.read.push({ title: str(r?.title, 60) || 'Reading', sentences, anchors: an, questions: v.items.slice(0, 5) });
  }
  return { items: out, dropped };
}

/** 題庫用的穩定 id：同樣內容不會重複入庫 */
export const bankId = (type, payload) => createHash('sha1').update(type + JSON.stringify(payload)).digest('hex').slice(0, 16);

/**
 * 情境應答的干擾項。pairs：我們送出去的配對（含 a = 正確回應）。
 * raw = { items:[{ n, distractors:[3 句回應] }] }。回傳 { items: Map(n → [3 句]), dropped:[{n, reason}] }
 * 干擾項：文法正確、自然，但「在這個問題後面不合適」。程式只檢查形式：3 句、不重複、不等於答案、
 * 長度接近答案、新字不多；是不是真的不合適，靠提示詞規定（見 prompts/exam-gen.md）。
 */
export function validateReply(raw, pairs, { known = new Set() } = {}){
  const items = new Map(), dropped = [];
  for (const it of Array.isArray(raw?.items) ? raw.items : []){
    const n = it?.n, p = pairs.find(x => x.n === n);
    const drop = reason => dropped.push({ n, reason });
    if (!p) { drop('編號不存在'); continue; }
    if (items.has(n)) { drop('重複的編號'); continue; }
    const ds = (Array.isArray(it.distractors) ? it.distractors : []).map(d => str(d, 200));
    if (ds.length !== 3 || ds.some(d => !d)) { drop('干擾項不是 3 句'); continue; }
    const key = new Set([lc(strip(p.a))]);
    let bad = null;
    const aw = tokensOf(p.a).length;
    for (const d of ds){
      const k = lc(strip(d)), len = tokensOf(d).length;
      if (key.has(k)) { bad = '干擾項重複或和答案相同'; break; }
      key.add(k);
      if (len < 2 || len > Math.max(12, aw * 2 + 3)) { bad = '干擾項長度不合適'; break; }
      if (!/^[A-Z"'“‘]/.test(d)) { bad = '干擾項不是句子（沒有大寫開頭）'; break; }
      if (newWords(d, known).length > 2) { bad = '干擾項的新字太多'; break; }
      if (/^\s*[A-Z][a-z]*:/.test(d)) { bad = '干擾項不能帶說話者標記'; break; }
    }
    if (bad) { drop(bad); continue; }
    items.set(n, ds);
  }
  return { items, dropped };
}
