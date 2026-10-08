// 文法分析器 — 路線 A：透過 Claude Code headless 呼叫，使用 Max 訂閱認證。
// 之後若要改走 API key，只需替換 callModel()，其餘邏輯與 schema 完全不動。

import { spawn } from 'node:child_process';
import { CLAUDE_BIN, claudeNotFound } from './claude-bin.mjs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SYSTEM_PROMPT_PATH = join(__dirname, '..', 'prompts', 'analyzer-system.md');

export const MODEL = process.env.ANALYZER_MODEL || 'opus';

/** 呼叫模型，回傳 { text, usage, costUsd, durationMs } */
function callModel(userPrompt, { model = MODEL, timeoutMs = 120_000 } = {}) {
  return new Promise((resolve, reject) => {
    const args = [
      '-p', userPrompt,
      '--system-prompt-file', SYSTEM_PROMPT_PATH,
      '--allowedTools', '',
      '--exclude-dynamic-system-prompt-sections',
      '--model', model,
      '--output-format', 'json',
    ];
    const child = spawn(CLAUDE_BIN, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '', err = '';
    const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error('timeout')); }, timeoutMs);

    child.stdout.on('data', d => { out += d; });
    child.stderr.on('data', d => { err += d; });
    child.on('error', e => { clearTimeout(timer);
      const msg = claudeNotFound(e); reject(msg ? Object.assign(new Error(msg), { kind: 'auth' }) : e); });
    child.on('close', code => {
      clearTimeout(timer);
      if (code !== 0){
        const e = new Error(`claude exited ${code}: ${err.slice(0, 500)}`);
        e.kind = classifyError(err);
        return reject(e);
      }
      let env;
      try { env = JSON.parse(out); }
      catch { return reject(new Error(`CLI 回傳非 JSON: ${out.slice(0, 300)}`)); }
      if (env.is_error){
        const e = new Error(`模型回報錯誤: ${env.result}`);
        e.kind = classifyError(env.result);
        return reject(e);
      }
      resolve({
        text: env.result,
        usage: env.usage,
        costUsd: env.total_cost_usd,
        durationMs: env.duration_ms,
      });
    });
  });
}

/** 把 CLI 的錯誤訊息分類，讓上層能給使用者看得懂的提示 */
export function classifyError(message){
  const m = String(message || '').toLowerCase();
  if (/rate.?limit|usage limit|quota|too many requests|\b429\b|limit reached|resets? at/.test(m))
    return 'rate-limit';
  if (/unauthor|not logged in|authentication|invalid api key|credential|\b401\b|\b403\b/.test(m))
    return 'auth';
  if (/timeout|timed out|etimedout/.test(m)) return 'timeout';
  return 'other';
}

/** 容錯解析：去掉可能的 markdown fence、抓第一個 JSON 物件 */
export function parseModelJson(text) {
  let s = text.trim();
  s = s.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim();
  try { return JSON.parse(s); } catch { /* 繼續嘗試 */ }
  const start = s.indexOf('{');
  const end = s.lastIndexOf('}');
  if (start !== -1 && end > start) return JSON.parse(s.slice(start, end + 1));
  throw new Error(`無法解析為 JSON: ${s.slice(0, 300)}`);
}

/**
 * 成分對齊：把模型回傳的成分片段，依序在原句中找出字元區間。
 * 模型不負責算座標（容易錯），由這裡用字串搜尋對齊。
 * 回傳 { aligned: [...含 start/end], ok: boolean, failures: [...] }
 * ok=false 時前端應降級為純標籤列表顯示，不標色。
 */
function alignConstituents(original, constituents) {
  let cursor = 0;
  const aligned = [];
  const failures = [];
  for (const c of constituents) {
    const idx = original.indexOf(c.text, cursor);
    if (idx === -1) {
      // 退一步：允許從句首重找（模型可能順序顛倒）
      const loose = original.indexOf(c.text);
      failures.push({ text: c.text, role: c.role, reason: loose === -1 ? 'not-found' : 'out-of-order' });
      aligned.push({ ...c, start: null, end: null });
      continue;
    }
    aligned.push({ ...c, start: idx, end: idx + c.text.length });
    cursor = idx + c.text.length;
  }
  return { aligned, ok: failures.length === 0, failures };
}

/**
 * 詞性對齊：把模型回傳的單字依序在原句中找出字元區間。
 * 與 alignConstituents 同策略 —— 模型只回文字，座標由程式算。
 */
function alignWords(original, words) {
  let cursor = 0;
  const aligned = [];
  const failures = [];
  for (const w of words) {
    const idx = original.indexOf(w.text, cursor);
    if (idx === -1) {
      failures.push({ text: w.text, pos: w.pos, reason: 'not-found' });
      aligned.push({ ...w, start: null, end: null });
      continue;
    }
    aligned.push({ ...w, start: idx, end: idx + w.text.length });
    cursor = idx + w.text.length;
  }
  return { aligned, ok: failures.length === 0, failures };
}

// 代名詞是封閉詞表，多數形式只有一種格位，程式就能確定 —— 不該交給模型碰運氣。
// 只有 her / his / its / it / you 這幾個真有歧義，才看模型或用「後面有沒有名詞」判斷。
const PRON_CASE = {
  i:'subject', he:'subject', she:'subject', we:'subject', they:'subject',
  me:'object', him:'object', us:'object', them:'object',
  my:'possessive', your:'possessive', our:'possessive', their:'possessive',
  mine:'possessive-pron', yours:'possessive-pron', hers:'possessive-pron',
  ours:'possessive-pron', theirs:'possessive-pron',
};
const AMBIGUOUS = new Set(['her', 'his', 'its', 'it', 'you']);
const NOUNISH = new Set(['n', 'adj', 'num']);   // 所有格後面會接的詞性

/**
 * 補齊並校正代名詞格位。
 * 明確的形式一律以程式為準（即使模型填了別的），歧義的才採用模型答案，
 * 模型沒填時用「後面有沒有名詞」的規則補。
 */
export function fixPronounCase(words){
  for (let i = 0; i < words.length; i++){
    const w = words[i];
    if (w.pos !== 'pron') { delete w.case; continue; }
    const lower = String(w.text || '').toLowerCase();

    if (/self$|selves$/.test(lower)) { w.case = 'reflexive'; continue; }

    const fixed = PRON_CASE[lower];
    if (fixed) { w.case = fixed; continue; }          // 明確形式：程式說了算

    if (AMBIGUOUS.has(lower)){
      if (w.case) continue;                            // 模型有判就採用
      // 模型沒填時的後備規則。每個字可能的格位不同，不能一概而論：
      //   her  受格或所有格        his  所有格或所有格代名詞（沒有受格，受格是 him）
      //   its  只有所有格          you / it  只有主格或受格（所有格是 your / its）
      const next = words[i + 1];
      const followedByNoun = next && NOUNISH.has(next.pos);
      const prev = words[i - 1];
      const afterVerbOrPrep = prev && (prev.pos === 'v' || prev.pos === 'prep');
      w.case =
        lower === 'its' ? 'possessive'
      : lower === 'her' ? (followedByNoun ? 'possessive' : 'object')
      : lower === 'his' ? (followedByNoun ? 'possessive' : 'possessive-pron')
      : /* you / it */    (afterVerbOrPrep ? 'object' : 'subject');
      continue;
    }
    if (!w.case) w.case = 'other';                     // this / that / something…
  }
  return words;
}

/** 主入口：分析一段英文，回傳 { data, meta } */
export async function analyze(text, opts = {}) {
  const res = await callModel(text, opts);
  const data = parseModelJson(res.text);

  // 對齊每個句子的詞性，以及每個子句的成分
  for (const s of data.sentences ?? []) {
    const w = alignWords(s.original ?? text, s.words ?? []);
    s.words = fixPronounCase(w.aligned);
    s.wordAlignment = { ok: w.ok, failures: w.failures };
    for (const cl of s.clauses ?? []) {
      const { aligned, ok, failures } = alignConstituents(s.original ?? text, cl.constituents ?? []);
      cl.constituents = aligned;
      cl.alignment = { ok, failures };
    }
  }
  return { data, meta: { usage: res.usage, costUsd: res.costUsd, durationMs: res.durationMs, model: opts.model || MODEL } };
}

// ---------------------------------------------------------------------------
// 批次分析：多句併成一次呼叫
//
// 每次呼叫都要重讀約 34K tokens 的系統提示，逐句送就是付 N 次。實測六句：
// 逐句 6 次 $0.164／72s，整批 1 次 $0.099／37s —— 省 40% 費用、49% 時間，
// 句型、時態、詞性對齊、原句與逐句分析完全一致。
//
// 風險是模型可能漏句或把兩句併成一句，所以回來後用 original 逐一對回去，
// 對不上的那幾句再單獨送一次，寧可多花也不能給錯的結果。
// ---------------------------------------------------------------------------

/** 分析多個句子。回傳與輸入等長的陣列，分析失敗的位置是 null。 */
export async function analyzeMany(sentences, { groupSize = 8, onDone, onGroup, ...opts } = {}){
  const out = new Array(sentences.length).fill(null);
  const usage = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, costUsd: 0 };
  const addUsage = m => {
    const u = m.usage ?? {};
    usage.inputTokens     += (u.input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0);
    usage.outputTokens    += u.output_tokens ?? 0;
    usage.cacheReadTokens += u.cache_read_input_tokens ?? 0;
    usage.costUsd         += m.costUsd ?? 0;
  };

  for (let g = 0; g < sentences.length; g += groupSize){
    const idx = [];
    for (let i = g; i < Math.min(g + groupSize, sentences.length); i++) idx.push(i);
    const texts = idx.map(i => sentences[i]);

    let got = [];
    try {
      const { data, meta } = await analyze(texts.join(' '), opts);
      addUsage(meta);
      got = data.sentences ?? [];
    } catch { /* 整批失敗就全部退回單句 */ }

    // 用 original 對回去：模型可能漏句、併句或調換順序
    const byText = new Map();
    for (const s of got) if (s?.original) byText.set(s.original.trim(), s);

    const missed = [];
    for (const i of idx){
      const hit = byText.get(sentences[i].trim());
      if (hit){ out[i] = hit; onDone?.(i, hit); }
      else missed.push(i);
    }

    // 對不上的單獨重送一次
    for (const i of missed){
      try {
        const { data, meta } = await analyze(sentences[i], opts);
        addUsage(meta);
        const s = data.sentences?.[0];
        if (s){ out[i] = s; onDone?.(i, s); }
      } catch { /* 這句就是分析不出來，留 null */ }
    }
    // 每一批跑完就回報，呼叫端可以立刻存檔並更新進度 ——
    // 全部跑完才一次交付的話，中途斷線就白做了。
    onGroup?.({ done: Math.min(g + groupSize, sentences.length), total: sentences.length, usage });
  }
  return { results: out, usage, missed: out.filter(x => !x).length };
}

// ---------------------------------------------------------------------------
// 拍照辨識：把課本、講義或考卷上的英文句子抄下來
//
// 和單字表的辨識分開 —— 那邊要的是「一行一個單字＋中文」的表格，
// 這邊要的是完整的句子與段落，略過的東西也不一樣（中文翻譯、題號、手寫筆記）。
// ---------------------------------------------------------------------------

const PROSE_PROMPT = join(__dirname, '..', 'prompts', 'analyze-ocr.md');

/** 從圖片抄出英文句子。回傳 { text, usage } */
export function extractProse(imagePath, { model = MODEL, timeoutMs = 180_000 } = {}){
  return new Promise((resolve, reject) => {
    const args = [
      '-p', `Read the image at ${imagePath} and transcribe the English sentences.`,
      '--system-prompt-file', PROSE_PROMPT,
      '--allowedTools', 'Read',
      '--exclude-dynamic-system-prompt-sections',
      '--model', model,
      '--output-format', 'json',
    ];
    const child = spawn(CLAUDE_BIN, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '', err = '';
    const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error('timeout')); }, timeoutMs);
    child.stdout.on('data', d => { out += d; });
    child.stderr.on('data', d => { err += d; });
    child.on('error', e => { clearTimeout(timer);
      const msg = claudeNotFound(e); reject(msg ? Object.assign(new Error(msg), { kind: 'auth' }) : e); });
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
      const u = env.usage ?? {};
      resolve({ text: String(data.text ?? '').trim(), filled: Number(data.filled) || 0, usage: {
        inputTokens: (u.input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0),
        outputTokens: u.output_tokens ?? 0,
        cacheReadTokens: u.cache_read_input_tokens ?? 0,
        costUsd: env.total_cost_usd ?? 0,
      } });
    });
  });
}
