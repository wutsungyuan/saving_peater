// 單字表：充實（呼叫一次模型）＋ 出題（純程式）。
// 和句子分析同樣的策略 —— 建表時花一次額度把資料備齊，之後循環測驗都是零成本。

import { spawn } from 'node:child_process';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseModelJson, classifyError, MODEL } from './analyzer.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SYSTEM_PROMPT = join(__dirname, '..', 'prompts', 'wordset-system.md');

/** 解析使用者貼上的字表。一行一個，可用逗號／tab／全形逗號分隔中文 */
export function parseWordList(text){
  const out = [];
  const seen = new Set();
  for (const raw of String(text ?? '').split(/\r?\n/)){
    const line = raw.trim();
    if (!line || /^[#／/]/.test(line)) continue;              // 空行與註解行
    const m = line.split(/\s*[,，\t|]\s*/);
    const term = (m[0] ?? '').trim();
    if (!term || !/[A-Za-z]/.test(term)) continue;            // 至少要有英文字母
    const key = term.toLowerCase();
    if (seen.has(key)) continue;                              // 去重
    seen.add(key);
    out.push({ term, zh: (m[1] ?? '').trim() || null });
  }
  return out;
}

/** 呼叫模型充實一批單字。回傳 { words, usage } */
export function enrich(items, { model = MODEL, timeoutMs = 180_000 } = {}){
  const payload = items.map(w => w.zh ? `${w.term}, ${w.zh}` : w.term).join('\n');
  return new Promise((resolve, reject) => {
    const args = [
      '-p', payload,
      '--system-prompt-file', SYSTEM_PROMPT,
      '--allowedTools', '',
      '--exclude-dynamic-system-prompt-sections',
      '--model', model,
      '--output-format', 'json',
    ];
    const child = spawn('claude', args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '', err = '';
    const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error('timeout')); }, timeoutMs);
    child.stdout.on('data', d => { out += d; });
    child.stderr.on('data', d => { err += d; });
    child.on('error', e => { clearTimeout(timer); reject(e); });
    child.on('close', code => {
      clearTimeout(timer);
      if (code !== 0){
        const e = new Error(`claude exited ${code}: ${err.slice(0, 400)}`);
        e.kind = classifyError(err);
        return reject(e);
      }
      let env;
      try { env = JSON.parse(out); } catch { return reject(new Error('CLI 回傳非 JSON')); }
      if (env.is_error){
        const e = new Error(String(env.result).slice(0, 300));
        e.kind = classifyError(env.result);
        return reject(e);
      }
      let data;
      try { data = parseModelJson(env.result); }
      catch (e){ return reject(new Error('模型回傳無法解析: ' + e.message)); }

      // 對齊回使用者原本給的拼寫與順序，模型漏掉的補一個最小可用的結果
      const byTerm = new Map((data.words ?? []).map(w => [String(w.term).toLowerCase(), w]));
      const words = items.map(it => {
        const got = byTerm.get(it.term.toLowerCase());
        if (!got) return { term: it.term, syllables: it.term, spellTip: null,
          senses: it.zh ? [{ pos: 'n', zh: it.zh, example: null, exampleZh: null }] : [],
          confusable: [], family: [], incomplete: true };
        return { ...got, term: it.term };          // 拼寫一律以使用者的為準
      });
      const u = env.usage ?? {};
      resolve({ words, usage: {
        inputTokens: (u.input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0),
        outputTokens: u.output_tokens ?? 0,
        cacheReadTokens: u.cache_read_input_tokens ?? 0,
        costUsd: env.total_cost_usd ?? 0,
      } });
    });
  });
}

// ---------------------------------------------------------------------------
// 出題：純程式，從充實好的資料生成，不呼叫模型
// ---------------------------------------------------------------------------

export const WORD_MODES = ['zh2en', 'en2zh', 'listen', 'cloze', 'sense'];
export const MODE_NAMES = {
  zh2en:'中考英', en2zh:'英考中', listen:'聽考', cloze:'例句填空', sense:'詞義辨析',
};

const rand = n => Math.floor(Math.random() * n);
const pick = a => a[rand(a.length)];
const shuffle = a => { const r=[...a]; for(let i=r.length-1;i>0;i--){const j=rand(i+1);[r[i],r[j]]=[r[j],r[i]];} return r; };
const norm = s => String(s ?? '').trim().toLowerCase().replace(/\s+/g,' ').replace(/[.!?,;:]+$/,'');

/** 在例句裡找出這個字實際出現的形式（可能是變化形：teach → teaches） */
export function findForm(example, term){
  if (!example) return null;
  const t = term.trim();
  // 片語：把 ... 當萬用，整串寬鬆比對
  if (/\s/.test(t) || t.includes('...')){
    const parts = t.split(/\.{2,}|\s+/).filter(Boolean).map(x => x.replace(/[^A-Za-z']/g,''));
    const re = new RegExp(parts.map(p => `\\b${p}\\b`).join('[\\s\\S]{0,25}?'), 'i');
    const m = re.exec(example);
    return m ? { text: m[0], start: m.index, end: m.index + m[0].length } : null;
  }
  // 單字：先精確，再用字根前綴抓變化形
  const exact = new RegExp(`\\b${t}\\b`, 'i').exec(example);
  if (exact) return { text: exact[0], start: exact.index, end: exact.index + exact[0].length };
  const stem = t.length > 4 ? t.slice(0, t.length - 1) : t;
  const loose = new RegExp(`\\b${stem}[a-z]{0,4}\\b`, 'i').exec(example);
  return loose ? { text: loose[0], start: loose.index, end: loose.index + loose[0].length } : null;
}

/** 挑要考的單字：到期的優先，再來是盒子低的、練得少的 */
function selectWords(words, count){
  const now = Date.now();
  const scored = words.map(w => ({
    w,
    due: w.total > 0 && w.dueAt <= now,
    weight: (w.total === 0 ? 2.0 : w.dueAt <= now ? 2.5 : 0.4) + (5 - Math.min(w.box, 5)) * 0.3,
  }));
  const out = [];
  const pool = [...scored];
  while (out.length < count && pool.length){
    const sum = pool.reduce((a, x) => a + x.weight, 0);
    let r = Math.random() * sum, i = 0;
    for (; i < pool.length; i++){ r -= pool[i].weight; if (r <= 0) break; }
    out.push(pool.splice(Math.min(i, pool.length - 1), 1)[0].w);
  }
  return out;
}

const senseLabel = (s) => `${s.pos}　${s.zh}`;

function qZh2En(w){
  const s = pick(w.senses);
  if (!s?.zh) return null;
  return {
    mode: 'zh2en', wordId: w.id, term: w.term,
    prompt: '寫出這個中文意思的英文單字',
    question: s.zh, hint: `${s.pos}　${w.syllables ? w.syllables.replace(/[a-z]/gi, '_') : ''}`.trim(),
    inputMode: 'text', blanks: 1,
    answer: [w.term],
    explain: `${w.term}（${w.syllables}）${s.pos} ${s.zh}` + (w.spellTip ? `\n拼字：${w.spellTip}` : ''),
    meta: { senseIdx: w.senses.indexOf(s) },
  };
}

function qEn2Zh(w, all){
  const s = pick(w.senses);
  if (!s?.zh) return null;
  const others = shuffle(all.filter(x => x.id !== w.id).flatMap(x => x.senses ?? []))
    .filter(o => o.zh && o.zh !== s.zh).slice(0, 3);
  if (others.length < 2) return null;
  return {
    mode: 'en2zh', wordId: w.id, term: w.term,
    prompt: `「${w.term}」是什麼意思？`,
    question: w.term, hint: s.pos,
    inputMode: 'choice',
    choices: shuffle([s, ...others]).map(o => ({ value: o.zh, label: senseLabel(o) })),
    answer: [s.zh],
    explain: `${w.term} 當 ${s.pos} 是「${s.zh}」。` + (s.example ? `\n${s.example}\n${s.exampleZh ?? ''}` : ''),
    meta: { senseIdx: w.senses.indexOf(s) },
  };
}

function qListen(w){
  const s = w.senses?.[0];
  return {
    mode: 'listen', wordId: w.id, term: w.term,
    prompt: '聽發音，把單字拼出來',
    speak: w.term,                       // 前端用 speech.js 唸這個
    question: null, hint: s?.zh ? `提示：${s.zh}` : null,
    inputMode: 'text', blanks: 1,
    answer: [w.term],
    explain: `${w.term}（${w.syllables}）` + (s?.zh ? ` ${s.pos} ${s.zh}` : '')
      + (w.spellTip ? `\n拼字：${w.spellTip}` : ''),
    meta: { senseIdx: 0 },
  };
}

function qCloze(w){
  const cands = (w.senses ?? []).map((s, i) => ({ s, i, f: findForm(s.example, w.term) }))
    .filter(x => x.f);
  if (!cands.length) return null;
  const { s, i, f } = pick(cands);
  const display = s.example.slice(0, f.start) + '______' + s.example.slice(f.end);
  const inflected = norm(f.text) !== norm(w.term);
  return {
    mode: 'cloze', wordId: w.id, term: w.term,
    prompt: '把單字填進句子裡',
    question: display, hint: s.zh ? `${s.pos}　${s.zh}` : null,
    inputMode: 'text', blanks: 1,
    answer: [f.text],
    alsoAccept: inflected ? [w.term] : [],
    explain: `${s.example}\n${s.exampleZh ?? ''}` +
      (inflected ? `\n這裡用的是變化形 ${f.text}（原形 ${w.term}）。` : ''),
    meta: { senseIdx: i },
  };
}

/** 詞義辨析：同一個字在不同句子裡是不同意思 —— 這是多詞性最常考的地方 */
function qSense(w){
  if (!w.senses || w.senses.length < 2) return null;
  const withEx = w.senses.map((s, i) => ({ s, i })).filter(x => x.s.example);
  if (!withEx.length) return null;
  const { s, i } = pick(withEx);
  return {
    mode: 'sense', wordId: w.id, term: w.term,
    prompt: `「${w.term}」在這句話裡是哪個意思？`,
    question: s.example, hint: null,
    inputMode: 'choice',
    choices: shuffle(w.senses).map(o => ({ value: `${o.pos}|${o.zh}`, label: senseLabel(o) })),
    answer: [`${s.pos}|${s.zh}`],
    explain: `${s.exampleZh ?? ''}\n這裡的 ${w.term} 是 ${s.pos}「${s.zh}」。\n` +
      `這個字還有：${w.senses.filter(o => o !== s).map(senseLabel).join('、')}`,
    meta: { senseIdx: i },
  };
}

const WORD_BUILDERS = { zh2en:qZh2En, en2zh:qEn2Zh, listen:qListen, cloze:qCloze, sense:qSense };

/** 從一份字表生成測驗。words 要帶進度欄位（box / dueAt / total）
 *  題型用輪流取的方式，確保五種平均分佈，不是每個字各自隨機挑 */
export function generateWordQuiz(words, { count = 10, modes = WORD_MODES } = {}){
  const want = modes.filter(m => WORD_BUILDERS[m]);
  if (!want.length || !words.length) return [];

  // 依 Leitner 排出要考的字（可能比題數多，讓每種題型都有字可用）
  const picked = selectWords(words, Math.max(count, Math.min(count * 2, words.length)));

  // 每種題型各自列出做得出來的題目
  const buckets = new Map(want.map(m => [m, []]));
  for (const w of picked)
    for (const m of want){
      const q = WORD_BUILDERS[m](w, words);
      if (q) buckets.get(m).push(q);
    }
  for (const m of want) buckets.set(m, shuffle(buckets.get(m)));

  const out = [];
  const usedWord = new Set();
  let guard = 0;
  while (out.length < count && guard++ < count * 12){
    for (const m of shuffle(want)){
      if (out.length >= count) break;
      const bucket = buckets.get(m);
      if (!bucket?.length) continue;
      // 同一輪盡量不重複考同一個字
      const i = bucket.findIndex(q => !usedWord.has(q.wordId));
      const q = bucket.splice(i === -1 ? 0 : i, 1)[0];
      if (!q) continue;
      usedWord.add(q.wordId);
      out.push({ ...q, id: `w${out.length + 1}` });
    }
    if (want.every(m => !buckets.get(m)?.length)) break;
    if (usedWord.size >= picked.length) usedWord.clear();
  }
  return out.slice(0, count);
}

export function gradeWord(q, given){
  const got = Array.isArray(given) ? given : [given];
  const ok = q.answer.length === got.length && q.answer.every((a, i) => norm(a) === norm(got[i]));
  const alt = (q.alsoAccept ?? []).some(a => norm(a) === norm(got.join(' ')));
  return { correct: ok || alt, expected: q.answer, given: got };
}

// ---------------------------------------------------------------------------
// 拍照辨識：讀課本單字表的照片，抄出單字與中文
// ---------------------------------------------------------------------------

const OCR_PROMPT = join(__dirname, '..', 'prompts', 'wordset-ocr.md');

/** 從圖片檔抄出單字表。回傳 { words, usage } */
export function extractFromImage(imagePath, { model = MODEL, timeoutMs = 180_000 } = {}){
  return new Promise((resolve, reject) => {
    const args = [
      '-p', `Read the image at ${imagePath} and extract the vocabulary list.`,
      '--system-prompt-file', OCR_PROMPT,
      '--allowedTools', 'Read',           // 要讀圖就得開 Read，其餘工具一律不給
      '--exclude-dynamic-system-prompt-sections',
      '--model', model,
      '--output-format', 'json',
    ];
    const child = spawn('claude', args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '', err = '';
    const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error('timeout')); }, timeoutMs);
    child.stdout.on('data', d => { out += d; });
    child.stderr.on('data', d => { err += d; });
    child.on('error', e => { clearTimeout(timer); reject(e); });
    child.on('close', code => {
      clearTimeout(timer);
      if (code !== 0){
        const e = new Error(`claude exited ${code}: ${err.slice(0, 400)}`);
        e.kind = classifyError(err);
        return reject(e);
      }
      let env;
      try { env = JSON.parse(out); } catch { return reject(new Error('CLI 回傳非 JSON')); }
      if (env.is_error){
        const e = new Error(String(env.result).slice(0, 300));
        e.kind = classifyError(env.result);
        return reject(e);
      }
      let data;
      try { data = parseModelJson(env.result); }
      catch (e){ return reject(new Error('辨識結果無法解析：' + e.message)); }

      const words = (data.words ?? [])
        .map(w => ({ term: String(w.term ?? '').trim(), zh: w.zh ? String(w.zh).trim() : null }))
        .filter(w => w.term && /[A-Za-z]/.test(w.term));
      const u = env.usage ?? {};
      resolve({ words, usage: {
        inputTokens: (u.input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0),
        outputTokens: u.output_tokens ?? 0,
        cacheReadTokens: u.cache_read_input_tokens ?? 0,
        costUsd: env.total_cost_usd ?? 0,
      } });
    });
  });
}

/** 把辨識結果轉回可編輯的文字，讓使用者核對後再建立字表 */
export function wordsToText(words){
  return words.map(w => w.zh ? `${w.term}, ${w.zh}` : w.term).join('\n');
}
