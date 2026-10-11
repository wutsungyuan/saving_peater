// 測驗卷的配題與計分。純函式、不碰資料庫、亂數可用種子重現（預覽和正式出卷才會是同一份）。
//
// 規則（見計畫頁）：
//  - 題數 25～50，滿分 100。每個題型有題數範圍，依 N/50 縮放並保底；範圍還要受「素材供給量」限制。
//  - 自動配題：核心三塊（單題選擇、閱讀測驗、克漏字）一定出現，再隨機補；25～34 題抽 3～4 種、35～50 題抽 4～5 種。
//    自選題型：你勾哪些就出哪些，湊不滿題數時放寬範圍。
//  - 每題分數 = 100 × 該題型權重 ÷ Σ(題數×權重)，進位到 0.5；在範圍內挑「剛好加總 100 分」的配題。
//  - 難度 = 延伸題的比例（以題數計）：簡單 0、中等 30%、困難 60%。延伸題先分給能免費延伸的題型。

/** 可重現的亂數（mulberry32）。種子相同，抽出來的配題與題目就相同。 */
export function seededRng(seed){
  let a = (Number(seed) >>> 0) || 1;
  return () => { a = (a + 0x6D2B79F5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}

export const DIFFICULTY = { easy: 0, mid: 0.3, hard: 0.6 };
export const DIFFICULTY_NAME = { easy: '簡單', mid: '中等', hard: '困難' };

/**
 * need：ws = 單字或句子任一、words 單字表、sent 已分析句子、art 文章表、dlg 有對話課文的文章表
 * model：這個題型的「範圍內」題目本身就要模型出（閱讀、克漏字的語意干擾項）
 * ext：可以延伸（中等、困難）。free：能免費延伸的比例（mc 的單字題約一半；match、make 全部）
 */
export const TYPES = [
  { id: 'mc',      name: '單題選擇', min: 14, max: 20, maxNoArt: 30, floor: 6, w: 1.0,  core: true, need: 'ws',    ext: true,  free: 0.5 },
  { id: 'read',    name: '閱讀測驗', min: 10, max: 15, floor: 5, w: 1.5,  core: true, need: 'art',   ext: true,  model: true, unit: 5 },
  { id: 'cloze',   name: '克漏字',   min: 8,  max: 10, floor: 5, w: 1.25, core: true, need: 'art',   ext: false, whole: true },
  { id: 'wbank',   name: '文意選填', min: 5,  max: 8,  floor: 4, w: 1.0,                need: 'art',   ext: false, whole: true },
  { id: 'reply',   name: '情境應答', min: 4,  max: 8,  floor: 3, w: 1.5,                need: 'dlg',   ext: false, model: true },
  { id: 'reorder', name: '句子重組', min: 5,  max: 10, floor: 3, w: 1.5,                need: 'sent',  ext: true },
  { id: 'fix',     name: '改錯',     min: 4,  max: 8,  floor: 3, w: 1.5,                need: 'sent',  ext: true },
  { id: 'fill',    name: '單字填空', min: 5,  max: 8,  floor: 3, w: 1.5,                need: 'words', ext: false },
  { id: 'match',   name: '配合題',   min: 5,  max: 8,  floor: 4, w: 0.5,                need: 'words', ext: true,  free: 1 },
  { id: 'trans',   name: '翻譯',     min: 3,  max: 5,  floor: 3, w: 2.5,                need: 'sent',  ext: true,  open: true },
  { id: 'make',    name: '造句',     min: 3,  max: 5,  floor: 3, w: 2.5,                need: 'words', ext: true,  open: true, free: 1 },
];
export const TYPE_BY_ID = Object.fromEntries(TYPES.map(t => [t.id, t]));

const sum = (a, k) => a.reduce((s, x) => s + x[k], 0);
const shuffle = (a, rng) => { const r = [...a]; for (let i = r.length - 1; i > 0; i--){ const j = Math.floor(rng() * (i + 1)); [r[i], r[j]] = [r[j], r[i]]; } return r; };

/** have：{ words, sent, art }（布林）。supply：{ 題型id: 這個範圍最多出得了幾題 }，沒給就不設限。 */
export function usable(t, have, supply){
  const ok = t.need === 'ws' ? (have.words || have.sent) : have[t.need];
  if (!ok) return false;
  if (supply && supply[t.id] != null && supply[t.id] < t.floor) return false;
  return true;
}

/** 題數範圍：依 N/50 縮放並保底；relax 1、2 只用在自選題型湊不滿時（放寬下限、加大上限）。再受供給量限制。 */
export function range(t, N, have, supply, relax = 0){
  const f = N / 50, mx = (!have.art && t.maxNoArt) ? t.maxNoArt : t.max;
  let lo = Math.max(t.floor, Math.round(t.min * f)), hi = Math.max(lo, Math.round(mx * f));
  if (relax >= 1){ lo = Math.min(lo, t.floor); hi = Math.ceil(hi * 1.4); }
  if (relax >= 2){ lo = Math.min(lo, 2); hi = Math.ceil(hi * 2); }
  const cap = supply?.[t.id];
  if (cap != null){ hi = Math.min(hi, cap); lo = Math.min(lo, hi); }
  return { min: lo, max: hi };
}

const feasible = (pick, N, have, supply, relax) => {
  const r = pick.map(t => range(t, N, have, supply, relax));
  return sum(r, 'min') <= N && sum(r, 'max') >= N;
};

function alloc(pick, N, have, supply, relax, rng){
  const r = pick.map(t => range(t, N, have, supply, relax));
  const cnt = r.map(x => x.min); let rem = N - sum(r, 'min');
  while (rem > 0){
    const room = []; r.forEach((x, i) => { if (cnt[i] < x.max) room.push(i); });
    cnt[room[Math.floor(rng() * room.length)]]++; rem--;
  }
  return pick.map((t, i) => ({ t, n: cnt[i] }));
}

/** 每題分數 = 100 × 權重 ÷ Σ(題數×權重)，進位到 0.5。回傳整份卷子加總。 */
function points(rows){
  const S = rows.reduce((a, r) => a + r.n * r.t.w, 0);
  rows.forEach(r => { r.pts = Math.max(0.5, Math.round(2 * 100 * r.t.w / S) / 2); r.extra = 0; r.sub = r.n * r.pts; });
  return sum(rows, 'sub');
}

/** 抽樣找「剛好加總 100 分」的配題，每題分數因此能保持依權重分配。 */
function search(pick, N, have, supply, relax, tries, rng){
  if (!feasible(pick, N, have, supply, relax)) return null;
  const hits = [];
  for (let i = 0; i < tries; i++){ const rows = alloc(pick, N, have, supply, relax, rng); if (points(rows) === 100) hits.push(rows); }
  return hits.length ? hits[Math.floor(rng() * hits.length)] : null;
}

/** 抽樣找不到時的備案：照權重進位後，由權重最高的題型裡幾題各加減 0.5 分補到剛好 100。 */
function patch(rows){
  let diff = Math.round((100 - points(rows)) * 2), guard = 0;
  const ord = [...rows].sort((a, b) => b.t.w - a.t.w);
  while (diff !== 0 && guard++ < 500){
    for (const o of ord){
      if (diff === 0) break;
      if (diff > 0 && o.extra < o.n){ o.extra++; diff--; }
      else if (diff < 0 && o.extra > -o.n && o.pts > 0.5){ o.extra--; diff++; }
    }
  }
  rows.forEach(r => { r.sub = r.n * r.pts + r.extra * 0.5; });
  return rows;
}

/** 已經出好的卷子刪掉幾題之後，依各題型的題數重新分配分數，總分維持剛好 100。counts：[{ id, n }]（和區塊同順序）。
 *  回傳 [{ id, pts, extra }]（extra：前幾題各加或減 0.5 分），分不出剛好 100 分時回 null。 */
export function rescore(counts){
  const rows = counts.map(c => ({ t: TYPE_BY_ID[c.id], n: c.n }));
  if (!rows.length || rows.some(r => !r.t || !(r.n >= 1))) return null;
  patch(rows);
  const total = rows.reduce((a, r) => a + r.sub, 0);
  return total === 100 ? rows.map(r => ({ id: r.t.id, pts: r.pts, extra: r.extra })) : null;
}

function autoPick(have, supply, allowOpen, N, rng){
  const core = TYPES.filter(t => t.core && usable(t, have, supply));
  const opts = TYPES.filter(t => !t.core && usable(t, have, supply) && (allowOpen || !t.open));
  if (!core.length && !opts.length) return null;
  const ks = N < 35 ? [3, 4] : [4, 5];
  const order = rng() < 0.5 ? ks : [ks[1], ks[0]];
  for (const k of order){
    const need = k - core.length;
    if (need < 0 || need > opts.length) continue;
    for (let tries = 0; tries < 60; tries++){
      const pick = [...core, ...shuffle(opts, rng).slice(0, need)];
      if (pick.filter(t => t.open).length > 1) continue;
      const rows = search(pick, N, have, supply, 0, 250, rng);
      if (rows) return { rows, relax: 0 };
    }
  }
  for (const k of order){
    const need = k - core.length;
    if (need < 0 || need > opts.length) continue;
    for (let tries = 0; tries < 60; tries++){
      const pick = [...core, ...shuffle(opts, rng).slice(0, need)];
      if (pick.filter(t => t.open).length > 1) continue;
      if (feasible(pick, N, have, supply, 0)) return { rows: patch(alloc(pick, N, have, supply, 0, rng)), relax: 0 };
    }
  }
  // 素材很少時（例如只有 5 個單字）：把能出的題型全部放進來，必要時放寬範圍
  const all = [...core, ...opts].filter(t => !t.open || allowOpen);
  return customPick(all, N, have, supply, rng);
}

function customPick(pick, N, have, supply, rng){
  if (!pick.length) return { error: 'no-types', message: '請至少選一個題型。' };
  for (let relax = 0; relax <= 2; relax++){
    if (!feasible(pick, N, have, supply, relax)) continue;
    const rows = search(pick, N, have, supply, relax, 2500, rng) ?? patch(alloc(pick, N, have, supply, relax, rng));
    return { rows, relax };
  }
  return { error: 'not-enough', message: `這個範圍的素材湊不到 ${N} 題。請多選一些單字表或文章表，或減少題數。` };
}

/**
 * 延伸題的分配（難度中等、困難）。整篇延伸的題型（閱讀）以「一篇」為單位，其他逐題。
 * 預設省錢優先：先分給能免費延伸的題目（mc 的單字題約一半、配合題、造句），不夠才分給需要模型的題型。
 * preferModel：延伸題偏好模型（內容更多樣，花費較高），免費與模型不分先後。
 * freeSupply：免費延伸字的數量（字族、易混淆字）；用完就不能再免費。
 * modelCap：不能呼叫模型時（省錢模式），延伸題的模型部分最多能用題庫現成的幾題，例如 { mc: 3, read: 5 }；null = 不限。
 */
export function extSplit(rows, N, ratio, { freeSupply = Infinity, preferModel = false, modelCap = null } = {}, rng = Math.random){
  rows.forEach(r => { r.ext = 0; r.extFree = 0; });
  if (!ratio) return { target: 0, actual: 0, free: 0 };
  const T = Math.round(N * ratio), free = [], paid = [];
  let freeLeft = freeSupply;
  const paidLeft = id => modelCap == null ? Infinity : (modelCap[id] ?? 0);
  rows.forEach((r, i) => {
    const t = r.t;
    if (!t.ext) return;                                                  // 不能延伸的題型
    let room = paidLeft(t.id);                                           // 這個題型還能分到幾題「模型」延伸
    const pushPaid = (u) => { if (room >= u.z){ room -= u.z; paid.push(u); } };
    if (t.free){
      const cap = Math.min(Math.floor(r.n * t.free), Math.max(0, freeLeft));
      for (let k = 0; k < r.n; k++){ if (k < cap && !preferModel){ free.push({ i, z: 1, f: true }); } else pushPaid({ i, z: 1, f: false }); }
      freeLeft -= cap;
    } else if (t.unit){ let left = r.n; while (left > 0){ const z = Math.min(t.unit, left); pushPaid({ i, z, f: false }); left -= z; } }
    else for (let k = 0; k < r.n; k++) pushPaid({ i, z: 1, f: false });
  });
  let best = null;
  for (let tries = 0; tries < 300; tries++){
    let acc = 0; const chosen = [];
    for (const u of [...shuffle(free, rng), ...shuffle(paid, rng)]) if (acc + u.z <= T){ acc += u.z; chosen.push(u); }
    if (!best || acc > best.acc) best = { acc, chosen };
    if (acc === T) break;
  }
  let fr = 0;
  for (const u of best.chosen){ rows[u.i].ext += u.z; if (u.f){ rows[u.i].extFree += u.z; fr += u.z; } }
  return { target: T, actual: best.acc, free: fr };
}

/**
 * 配題。opts：
 *   have { words, sent, art }、supply、N、mode 'auto'|'custom'、types（custom 時勾選的題型 id）、allowOpen、
 *   difficulty 'easy'|'mid'|'hard'、freeSupply、preferModel、seed
 * 回傳 { rows:[{ id, name, n, pts, sub, extra, ext, extFree, model }], total, N, relax, ext, seed } 或 { error, message }
 */
export function composePaper(opts){
  const { have, supply = null, N, mode = 'auto', types = [], allowOpen = true, difficulty = 'easy',
          freeSupply = Infinity, preferModel = false, modelCap = null } = opts;
  const seed = opts.seed ?? Math.floor(Math.random() * 2 ** 31);
  const rng = seededRng(seed);
  if (!Number.isInteger(N) || N < 25 || N > 50) return { error: 'bad-n', message: '題數要在 25 到 50 之間。' };
  if (!(have.words || have.sent || have.art)) return { error: 'no-scope', message: '請至少選一份單字表或文章表。' };

  let res;
  if (mode === 'custom'){
    const pick = TYPES.filter(t => types.includes(t.id) && usable(t, have, supply));
    const skipped = types.filter(id => !pick.some(t => t.id === id));
    res = customPick(pick, N, have, supply, rng);
    if (res.rows) res.skipped = skipped;
  } else res = autoPick(have, supply, allowOpen, N, rng);
  if (!res || res.error) return res ?? { error: 'not-enough', message: `這個範圍的素材湊不到 ${N} 題。` };

  const rows = res.rows;
  const ratio = DIFFICULTY[difficulty] ?? 0;
  const ext = extSplit(rows, N, ratio, { freeSupply, preferModel, modelCap }, rng);
  const total = sum(rows.map(r => ({ v: r.sub })), 'v');
  return {
    seed, N, relax: res.relax, skipped: res.skipped ?? [], total, ext, difficulty,
    rows: rows.map(r => ({ id: r.t.id, name: r.t.name, n: r.n, pts: r.pts, sub: r.sub, extra: r.extra,
                           ext: r.ext, extFree: r.extFree, model: Boolean(r.t.model) })),
  };
}
