// 模型出題：閱讀測驗、克漏字的語意干擾項、延伸題。
//
// 省 token 的做法（見計畫頁）：
//   1. 能用程式出的就不問模型；模型題先看題庫有沒有現成的（用過次數少的優先）。
//   2. 缺的題彙整成最少次數的呼叫：每篇文章一次（閱讀題 + 語意干擾項），延伸題全部合成一次。
//   3. 呼叫前先報價（planModelWork 不呼叫模型），你確認才執行；每次呼叫帶 --max-budget-usd 硬上限。
//   4. 模型寫的內容先過程式檢查（validate.mjs），不合格的丟掉，只補缺的那幾題，一次重試。
//   5. 通過檢查的存進題庫（questions 表），之後的卷子直接用。

import { spawnClaude, claudeNotFound } from '../claude-bin.mjs';
import { parseModelJson, classifyError } from '../analyzer.mjs';
import { EXAM_MODEL, EXAM_PROMPT, COLD_START_USD } from '../config.mjs';
import { validateRead, validateCloze, validateExt, validateReply, bankId, tokensOf } from './validate.mjs';

export const PASSAGE_WORDS = 300;               // 閱讀測驗的文章長度上限（字）
export const READ_PER_ARTICLE = 10;             // 每篇文章一次出幾題閱讀題入庫
const lc = s => String(s ?? '').toLowerCase();
const DEFAULTS = { perQuestion: 0.008, perCall: 0.02, msPerQuestion: 1500, msPerCall: 10000 };

// ---------- 題庫的鍵 ----------
export const scopeKey = pool => `s${[...pool.setIds].sort((a, b) => a - b).join('-')}a${pool.articles.map(a => a.id).sort((a, b) => a - b).join('-')}`;

/** 一篇文章裡拿來出閱讀題的段落：從頭取到約 300 字為止，每句編號（模型的依據句編號就是這個編號） */
export function passageOf(article){
  const out = []; let words = 0;
  for (const p of article.paragraphs) for (const s of p.sentences){
    const w = tokensOf(s.original).length;
    if (out.length && words + w > PASSAGE_WORDS) return out;
    // 對話：每次發言的第一句前面標說話者（Jamie: …），模型才分得出誰說的；shown 是給模型與畫面看的文字
    const first = article.dialogue && p.sentences[0] === s;
    out.push({ n: out.length + 1, para: p.para, hash: s.hash, text: s.original, data: s.data, speaker: article.dialogue ? p.speaker : null,
      shown: first ? `${p.speaker}: ${s.original}` : s.original }); words += w;
  }
  return out;
}

/** 克漏字要請模型寫干擾項的空：每句最多 1 個實詞（名詞、動詞、形容詞、副詞），優先選範圍內的單字 */
export function clozeTargets(passage, words){
  const scope = new Set(words.map(w => lc(w.term)));
  const out = [];
  for (const s of passage){
    const cands = (s.data?.words ?? []).filter(w => ['n', 'v', 'adj', 'adv'].includes(w.pos) && Number.isInteger(w.start) && w.start > 0 && w.text.length >= 4 && !/^[A-Z]/.test(w.text));
    cands.sort((a, b) => Number(scope.has(lc(b.text))) - Number(scope.has(lc(a.text))));
    if (cands[0]) out.push({ n: s.n, hash: s.hash, word: cands[0].text });
    if (out.length >= 12) break;
  }
  return out;
}

// ---------- 情境應答（對話課文）----------
export const REPLY_PER_ARTICLE = 8, REPLY_WORDS = 25;

/** 對話裡「一個人問、下一個人回答」的配對：前一次發言以問句結尾、換人說話、回答不太短也不太長。
 *  程式只負責找配對（正確答案就是課文裡真正的回答，不花錢）；3 個干擾回應才請模型寫。 */
export function replyPairs(article){
  if (!article.dialogue) return [];
  const turns = article.paragraphs.map(p => ({ speaker: p.speaker, text: p.sentences.map(s => s.original).join(' '), first: p.sentences[0]?.original ?? '', last: p.sentences.at(-1)?.original ?? '' }));
  const out = [];
  for (let i = 0; i + 1 < turns.length; i++){
    const a = turns[i], b = turns[i + 1];
    if (!/[?？]["”']?$/.test(a.last.trim()) || a.speaker === b.speaker) continue;
    if (/[?？]["”']?$/.test(b.first.trim())) continue;                 // 回答的第一句就是問題（轉換話題）：「正確回應」不唯一，不出；先答再反問（No. … What about you?）可以
    const bw = tokensOf(b.text).length;
    if (bw < 3 || bw > REPLY_WORDS) continue;
    out.push({ n: out.length + 1, key: String(i), qSpeaker: a.speaker, q: a.text, aSpeaker: b.speaker, a: b.text,
      before: turns.slice(Math.max(0, i - 2), i).map(t => `${t.speaker}: ${t.text}`) });
  }
  return out;
}

/** 這個題型的供給量：能請模型出時算「配對數」（每篇最多 8、全部最多 20）；不能時只算題庫現成的 */
export function replySupply(cache, pool, { modelOk }){
  let n = 0;
  for (const a of pool.articles.filter(x => x.dialogue))
    n += modelOk ? Math.min(REPLY_PER_ARTICLE, replyPairs(a).length) : bankCount(cache, 'reply', a.id, 'scope');
  return Math.min(20, n);
}

// ---------- 題庫現況 ----------
const bankCount = (cache, type, ref, src) => cache.questionsOf({ type, ref: ref != null ? String(ref) : undefined, src }).length;

/** 閱讀測驗的供給量。可以請模型出時：每篇文章最多 6 題（一篇文章最多出一組）；不能呼叫模型時：只算題庫現成的。 */
export function readSupply(cache, pool, { modelOk }){
  let scope = 0;
  for (const a of pool.articles) scope += modelOk ? Math.max(READ_PER_ARTICLE, bankCount(cache, 'read', a.id, 'scope')) : bankCount(cache, 'read', a.id, 'scope');
  const ext = bankCount(cache, 'read-ext', scopeKey(pool));
  return Math.min(30, Math.min(scope, pool.articles.length * 8) + (modelOk ? 0 : ext * 4));
}

/** 不呼叫模型時，延伸題的模型部分最多能用題庫裡的幾題 */
export function extBankCaps(cache, pool){
  const key = scopeKey(pool);
  return { mc: bankCount(cache, 'ext-mc', key), reorder: bankCount(cache, 'ext-reorder', key), fix: bankCount(cache, 'ext-fix', key),
           trans: bankCount(cache, 'ext-trans', key), read: bankCount(cache, 'read-ext', key) * 5 };
}

// ---------- 規劃與報價（不呼叫模型）----------
const EXT_TOKENS = { mc: 150, reorder: 110, fix: 110, trans: 80, read: 1300 };    // 每題大約的輸出 token，用來估時間與花費下限
export function estimateOf(cache, tasks){
  const unit = cache.paperGenUnit?.() ?? { ...DEFAULTS, source: 'default' };
  const questions = tasks.reduce((a, t) => a + t.questions, 0);
  if (!tasks.length) return { low: 0, high: 0, seconds: 0, unit: unit.source };
  const base = tasks.length * unit.perCall + questions * unit.perQuestion;
  const r3 = n => Math.round(n * 1000) / 1000;
  return { low: r3(base * 0.8), high: r3(base * 1.3 + COLD_START_USD), seconds: Math.round((tasks.length * unit.msPerCall + questions * unit.msPerQuestion) / 1000), unit: unit.source };
}

/**
 * 這份卷子還缺哪些模型題？回傳 { tasks, quote }。tasks 是要呼叫模型的工作清單。
 * plan：composePaper 的結果。saver：省錢模式（不呼叫模型）。
 */
export function planModelWork(cache, pool, plan, { saver = false, seed = 1 } = {}){
  const tasks = [], key = scopeKey(pool), row = id => plan.rows.find(r => r.id === id);
  if (saver) return { tasks, quote: { calls: 0, questions: 0, tasks, estimate: estimateOf(cache, tasks) } };

  // 1) 閱讀測驗（範圍內）：題庫不夠才對「題庫最少的文章」各出一次
  const read = row('read');
  if (read){
    const needScope = read.n - read.ext;
    let have = 0; const per = pool.articles.map(a => ({ a, have: bankCount(cache, 'read', a.id, 'scope') }));
    for (const p of per) have += Math.min(p.have, 8);
    const sorted = [...per].sort((x, y) => x.have - y.have || passageOf(y.a).length - passageOf(x.a).length);
    for (const p of sorted){
      if (have >= needScope) break;
      if (passageOf(p.a).length < 4) continue;                    // 太短的文章出不了閱讀題
      tasks.push({ kind: 'read', articleId: p.a.id, questions: READ_PER_ARTICLE });
      have += Math.max(0, 8 - Math.min(p.have, 8));               // 一篇文章最多用 8 題；出完之後這篇補到 8
    }
  }
  // 1b) 情境應答的干擾回應：對話課文每篇一次，題庫裡沒有的配對才請模型出
  const reply = row('reply');
  if (reply){
    let have = pool.articles.reduce((a, art) => a + bankCount(cache, 'reply', art.id, 'scope'), 0);
    for (const a of pool.articles.filter(x => x.dialogue)){
      if (have >= reply.n) break;
      const known = new Set(cache.questionsOf({ type: 'reply', ref: String(a.id), src: 'scope', limit: 100 }).map(r => r.payload.key));
      const missing = replyPairs(a).filter(p => !known.has(p.key)).slice(0, REPLY_PER_ARTICLE);
      if (!missing.length) continue;
      tasks.push({ kind: 'reply', articleId: a.id, questions: missing.length });
      have += missing.length;
    }
  }
  // 2) 克漏字的語意干擾項：每篇文章最多 2 篇，題庫沒有才出
  if (row('cloze')){
    for (const a of pool.articles.slice(0, 2)){
      if (bankCount(cache, 'cloze-dist', a.id, 'scope') >= 6) continue;
      const t = clozeTargets(passageOf(a), pool.words);
      if (t.length >= 5) tasks.push({ kind: 'cloze', articleId: a.id, questions: t.length });
    }
  }
  // 3) 延伸題的模型部分：全部合成一次呼叫
  const want = {};
  for (const id of ['mc', 'reorder', 'fix', 'trans']){
    const r = row(id); if (!r) continue;
    const need = (r.ext - r.extFree) - bankCount(cache, 'ext-' + id, key);
    if (need > 0) want[id] = need;
  }
  const rr = row('read');
  if (rr && rr.ext){ const passages = Math.ceil(rr.ext / 5) - bankCount(cache, 'read-ext', key); if (passages > 0) want.read = passages; }
  if (Object.keys(want).length){
    const questions = Object.entries(want).reduce((a, [k, n]) => a + (k === 'read' ? n * 5 : n), 0);
    tasks.push({ kind: 'ext', want, questions, seed });
  }
  return { tasks, quote: { calls: tasks.length, questions: tasks.reduce((a, t) => a + t.questions, 0), tasks, estimate: estimateOf(cache, tasks) } };
}

// ---------- 呼叫模型 ----------
export function callExam(userObj, { timeoutMs = 240_000, maxBudgetUsd, promptFile = EXAM_PROMPT } = {}){
  return new Promise((resolve, reject) => {
    const args = ['-p', JSON.stringify(userObj), '--system-prompt-file', promptFile, '--allowedTools', '',
      '--exclude-dynamic-system-prompt-sections', '--model', EXAM_MODEL, '--output-format', 'json'];
    if (maxBudgetUsd) args.push('--max-budget-usd', String(maxBudgetUsd));
    const child = spawnClaude(args);
    let out = '', err = '';
    const timer = setTimeout(() => { child.kill('SIGKILL'); reject(Object.assign(new Error('timeout'), { kind: 'timeout' })); }, timeoutMs);
    child.stdout.on('data', d => { out += d; });
    child.stderr.on('data', d => { err += d; });
    child.on('error', e => { clearTimeout(timer); const m = claudeNotFound(e); reject(m ? Object.assign(new Error(m), { kind: 'auth' }) : e); });
    child.on('close', code => {
      clearTimeout(timer);
      if (code !== 0) return reject(Object.assign(new Error(`claude exited ${code}: ${err.slice(0, 300)}`), { kind: classifyError(err) }));
      let env; try { env = JSON.parse(out); } catch { return reject(new Error('CLI 回傳非 JSON')); }
      if (env.is_error) return reject(Object.assign(new Error(String(env.result).slice(0, 300)), { kind: classifyError(env.result) }));
      let data; try { data = parseModelJson(env.result); } catch (e) { return reject(Object.assign(new Error('出題結果無法解析：' + e.message), { kind: 'parse' })); }
      const u = env.usage ?? {};
      resolve({ data, usage: { inputTokens: (u.input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0), outputTokens: u.output_tokens ?? 0,
        cacheReadTokens: u.cache_read_input_tokens ?? 0, costUsd: env.total_cost_usd ?? 0 } });
    });
  });
}

const passageJson = passage => passage.map(s => ({ n: s.n, text: s.shown ?? s.text }));
/** 短文全文：對話每次發言一行，一般文章用空格接起來 */
export function passageFull(passage){
  if (!passage[0]?.speaker) return passage.map(s => s.text).join(' ');
  const lines = [];                                                 // 同一次發言的句子接在同一行
  for (const s of passage){
    const last = lines.at(-1);
    if (last && last.para === s.para) last.text += ' ' + s.text; else lines.push({ para: s.para, text: s.shown });
  }
  return lines.map(l => l.text).join('\n');
}

/** 每個工作的呼叫內容。retryWant：上一輪驗證後還缺的數量（只補缺的）。 */
function requestOf(task, pool, retry, cache){
  if (task.kind === 'read'){
    const art = pool.articles.find(a => a.id === task.articleId);
    return { task: 'read', passage: passageJson(passageOf(art)), count: retry ?? task.questions, words: pool.words.slice(0, 30).map(w => w.term), known: [...pool.known].slice(0, 200) };
  }
  if (task.kind === 'reply'){
    const art = pool.articles.find(a => a.id === task.articleId);
    const known = new Set(cache.questionsOf({ type: 'reply', ref: String(art.id), src: 'scope', limit: 100 }).map(r => r.payload.key));
    const items = replyPairs(art).filter(p => !known.has(p.key)).slice(0, REPLY_PER_ARTICLE);
    return { task: 'reply', items: (Array.isArray(retry) ? items.filter(p => retry.includes(p.n)) : items).map(p => ({ n: p.n, before: p.before, speakerA: p.qSpeaker, said: p.q, speakerB: p.aSpeaker, reply: p.a })),
      words: pool.words.slice(0, 30).map(w => w.term), known: [...pool.known].slice(0, 200) };
  }
  if (task.kind === 'cloze'){
    const art = pool.articles.find(a => a.id === task.articleId), passage = passageOf(art);
    return { task: 'cloze', passage: passageJson(passage), targets: clozeTargets(passage, pool.words).map(t => ({ n: t.n, word: t.word })) };
  }
  // ext：從範圍內的單字挑一批當依據（每次不同），附上已知字集讓模型盡量只用這些字
  const withEx = pool.words.filter(w => w.senses?.[0]?.zh);
  const anchors = withEx.slice(0, 18).map(w => ({ word: w.term, zh: w.senses[0].zh, pos: w.senses[0].pos, example: w.senses[0].example ?? '' }));
  return { task: 'ext', retry: retry != null, anchors, want: retry ?? task.want, known: [...pool.known].slice(0, 400), maxNew: 1 };
}

/** 驗證後存進題庫，回傳 { added, short }（short：還缺的數量，給重試用） */
function ingest(cache, task, data, pool){
  const key = scopeKey(pool);
  if (task.kind === 'read'){
    const art = pool.articles.find(a => a.id === task.articleId), passage = passageOf(art);
    const v = validateRead(data, { nSentences: passage.length, passageText: passageFull(passage) });
    const rows = v.items.map(p => ({ id: bankId('read', { a: art.id, ...p }), type: 'read', src: 'scope', ref: String(art.id), payload: p, anchors: null }));
    cache.putQuestions(rows);
    return { added: rows.length, dropped: v.dropped, short: Math.max(0, task.questions - rows.length) };
  }
  if (task.kind === 'reply'){
    const art = pool.articles.find(a => a.id === task.articleId);
    const have = new Set(cache.questionsOf({ type: 'reply', ref: String(art.id), src: 'scope', limit: 100 }).map(r => r.payload.key));
    const pairs = replyPairs(art).filter(p => !have.has(p.key)).slice(0, REPLY_PER_ARTICLE);
    const v = validateReply(data, pairs, { known: pool.known });
    const rows = [...v.items].map(([n, ds]) => {
      const p = pairs.find(x => x.n === n);
      const payload = { key: p.key, qSpeaker: p.qSpeaker, q: p.q, aSpeaker: p.aSpeaker, a: p.a, distractors: ds };
      return { id: bankId('reply', { a: art.id, key: p.key, ans: p.a }), type: 'reply', src: 'scope', ref: String(art.id), payload, anchors: null };
    });
    cache.putQuestions(rows);
    return { added: rows.length, dropped: v.dropped, short: pairs.filter(p => !v.items.has(p.n)).map(p => p.n) };
  }
  if (task.kind === 'cloze'){
    const art = pool.articles.find(a => a.id === task.articleId), passage = passageOf(art), targets = clozeTargets(passage, pool.words);
    const v = validateCloze(data, targets);
    const rows = v.items.map(i => { const t = targets.find(x => x.n === i.n); return { id: bankId('cloze-dist', { hash: t.hash, ...i }), type: 'cloze-dist', src: 'scope', ref: String(art.id), payload: { hash: t.hash, word: i.word, distractors: i.distractors } }; });
    cache.putQuestions(rows);
    return { added: rows.length, dropped: v.dropped, short: 0 };
  }
  const anchors = pool.words.map(w => w.term);
  const v = validateExt(data, { anchors, known: pool.known, maxNew: 1 });
  const rows = []; const short = {};
  for (const type of ['mc', 'reorder', 'fix', 'trans']) for (const p of v.items[type]) rows.push({ id: bankId('ext-' + type, p), type: 'ext-' + type, src: 'ext-model', ref: key, payload: p, anchors: p.anchors.map(w => ({ word: w, rel: 'model' })) });
  for (const p of v.items.read) rows.push({ id: bankId('read-ext', p), type: 'read-ext', src: 'ext-model', ref: key, payload: p, anchors: p.anchors.map(w => ({ word: w, rel: 'model' })) });
  cache.putQuestions(rows);
  for (const [type, n] of Object.entries(task.want)) {
    const got = type === 'read' ? v.items.read.length : v.items[type].length;
    if (got < n) short[type] = n - got;
  }
  return { added: rows.length, dropped: v.dropped, short: Object.keys(short).length ? short : 0 };
}

/**
 * 執行模型工作（按順序）。每次呼叫帶花費上限、記進 requests（kind='paper-gen'，之後報價用）。
 * 額度用盡或認證失效就停下，已完成的已存進題庫。
 * 回傳 { calls, added, dropped, costUsd, error }
 */
export async function runModelWork(cache, pool, tasks, { capUsd } = {}){
  const sum = { calls: 0, added: 0, dropped: 0, costUsd: 0, error: null };
  for (const task of tasks){
    let retry = null;
    for (let round = 0; round < 2; round++){
      const t0 = Date.now();
      let res;
      try { res = await callExam(requestOf(task, pool, retry, cache), { maxBudgetUsd: capUsd }); }
      catch (e){
        sum.error = { kind: e.kind || 'other', message: String(e.message).slice(0, 300) };
        if (e.kind === 'rate-limit' || e.kind === 'auth') return sum;
        if (e.kind === 'parse' && round === 0) continue;                // 模型偶爾格式跑掉：同一份工作再問一次
        break;
      }
      const r = ingest(cache, task, res.data, pool);
      sum.calls++; sum.added += r.added; sum.dropped += r.dropped.length; sum.costUsd += res.usage.costUsd;
      cache.log({ kind: 'paper-gen', chars: 0, sentences: r.added, cached: 0, analyzed: r.added, ms: Date.now() - t0, text: `題庫 ${task.kind}（${r.added} 題入庫，${r.dropped.length} 題被擋）`, ...res.usage });
      if (!r.short || (Array.isArray(r.short) && !r.short.length) || round === 1) break;
      retry = r.short;                                         // 只補缺的
    }
  }
  return sum;
}

// ---------- 題庫的題 → 卷子上的題 ----------
const shuffleWith = (a, rng) => { const r = [...a]; for (let i = r.length - 1; i > 0; i--){ const j = Math.floor(rng() * (i + 1)); [r[i], r[j]] = [r[j], r[i]]; } return r; };
const stat = qtype => ({ kind: 'paper', qtype });
const choiceQ = (p, base) => ({ inputMode: 'choice', choices: p.choices.map(c => ({ value: c, label: c })), answer: [p.choices[p.answer]], explain: p.explain, ...base });

/** 延伸題（mc、reorder、fix、trans）：從題庫取 count 題，轉成卷子上的題目格式 */
export function extQuestions(cache, pool, type, count, rng){
  if (count <= 0) return [];
  const rows = cache.questionsOf({ type: 'ext-' + type, ref: scopeKey(pool), limit: Math.max(count * 3, 12) });
  const picked = shuffleWith(rows.slice(0, Math.max(count * 2, count)), rng).slice(0, count);
  return picked.map(r => {
    const p = r.payload, meta = { key: `b${r.id}`, bankId: r.id, anchors: r.anchors, stat: stat('paper-ext-' + type) };
    if (type === 'mc') return choiceQ(p, { type: 'mc', skill: 'ext-' + p.kind, src: 'ext-model', prompt: '選出適合的答案', question: p.q, meta });
    if (type === 'reorder'){
      let sh = shuffleWith(p.chunks, rng), tries = 0; while (sh.join('|') === p.chunks.join('|') && tries++ < 10) sh = shuffleWith(p.chunks, rng);
      return { type: 'reorder', skill: 'reorder', inputMode: 'order', src: 'ext-model', prompt: '把下面的詞組排成正確的句子', question: p.zh || null,
        chunks: sh, answer: [p.sentence], orders: [p.chunks], explain: p.sentence, meta };
    }
    if (type === 'fix') return { type: 'fix', skill: 'error-fix', inputMode: 'text', blanks: 1, src: 'ext-model', prompt: '這句話有一個文法錯誤，請改成正確的句子',
      question: p.wrong, answer: [p.right], explain: `正確：${p.right}\n${p.why ?? ''}`.trim(), meta };
    return { type: 'trans', skill: 'trans', inputMode: 'open', src: 'ext-model', prompt: '把下面的句子翻成英文', question: p.zh, answer: [p.en],
      keywords: tokensOf(p.en).filter(w => w.length > 3), explain: `參考答案：${p.en}`, meta: { ...meta, stat: null } };
  });
}

/** 閱讀測驗這一區：範圍內的題（每篇文章一組）加上延伸的短文。回傳 { questions, passages, ext, extFree } */
export function readSection(cache, pool, n, ext, rng){
  const questions = [], passages = [];
  const addPassage = (title, text, items, srcLabel, qMeta) => {
    const idx = passages.push({ title, text }) - 1;
    for (const it of items) questions.push(choiceQ(it.p, { type: 'read', skill: 'read-' + (it.p.skill ?? 'detail'), src: srcLabel, passageIdx: idx, prompt: it.p.q,
      meta: { key: `b${it.id}`, bankId: it.id, stat: stat('paper-read'), ...qMeta } }));
    return items.length;
  };
  // 範圍內：依文章，題庫裡用過次數少的優先
  let need = n - ext;
  const arts = shuffleWith(pool.articles, rng);
  for (const a of arts){
    if (need <= 0) break;
    const passage = passageOf(a);
    const rows = cache.questionsOf({ type: 'read', ref: String(a.id), src: 'scope', limit: 30 }).filter(r => r.payload.evidence.every(e => e <= passage.length));
    const want = Math.min(need, 8), cut = rows[Math.min(want, rows.length) - 1]?.used ?? 0;   // 用過次數少的優先；同樣次數的才隨機
    const take = [...rows.filter(r => r.used < cut), ...shuffleWith(rows.filter(r => r.used === cut), rng)].slice(0, want);
    if (take.length < Math.min(3, need)) continue;
    // 同一篇的題按依據句的順序排
    take.sort((x, y) => Math.min(...x.payload.evidence) - Math.min(...y.payload.evidence));
    need -= addPassage(a.name, passageFull(passage), take.map(r => ({ id: r.id, p: r.payload })), 'scope');
  }
  // 延伸：模型寫的新短文，每篇最多 5 題
  let extGot = 0, extNeed = Math.min(ext, n - questions.length);
  for (const r of cache.questionsOf({ type: 'read-ext', ref: scopeKey(pool), limit: 20 })){
    if (extNeed <= 0) break;
    const qs = r.payload.questions.slice(0, Math.min(5, extNeed));
    addPassage(r.payload.title, r.payload.sentences.join(' '), qs.map(p => ({ id: r.id, p })), 'ext-model', { anchors: r.anchors });
    extNeed -= qs.length; extGot += qs.length;
  }
  return { questions, passages, ext: extGot, extFree: 0 };
}

/** 情境應答這一區：從題庫取（用過次數少的優先），正確答案和 3 個干擾回應洗牌 */
export function replySection(cache, pool, n, rng){
  const rows = [];
  for (const a of shuffleWith(pool.articles.filter(x => x.dialogue), rng))
    rows.push(...cache.questionsOf({ type: 'reply', ref: String(a.id), src: 'scope', limit: 30 }));
  rows.sort((x, y) => x.used - y.used);
  const cut = rows[Math.min(n, rows.length) - 1]?.used ?? 0;
  const pick = [...rows.filter(r => r.used < cut), ...shuffleWith(rows.filter(r => r.used === cut), rng)].slice(0, n);
  const questions = shuffleWith(pick, rng).map(r => {
    const p = r.payload;
    return { type: 'reply', skill: 'reply', inputMode: 'choice', src: 'scope', prompt: `${p.aSpeaker} 會怎麼回應？選出最適當的回應`,
      question: `${p.qSpeaker}: ${p.q}`, choices: shuffleWith([p.a, ...p.distractors], rng).map(v => ({ value: v, label: v })), answer: [p.a],
      explain: `${p.aSpeaker} 真正的回答是：${p.a}`, meta: { key: `b${r.id}`, bankId: r.id, stat: { kind: 'paper', qtype: 'paper-reply' } } };
  });
  return { questions, passages: [], ext: 0, extFree: 0 };
}

/** 克漏字用的語意干擾項（從題庫取，給 buildCloze 的 semantic 參數） */
export function clozeSemantic(cache, pool){
  return pool.articles.flatMap(a => cache.questionsOf({ type: 'cloze-dist', ref: String(a.id), src: 'scope', limit: 30 }).map(r => r.payload));
}
