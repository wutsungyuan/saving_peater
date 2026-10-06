// P0 評測：跑黃金測試集，量化句型 / 時態 / 錯誤偵測 / 成分對齊的準確率。
// 用法: node eval/run-eval.mjs [--limit N] [--model opus|sonnet] [--concurrency 5] [--filter PREFIX]

import { readFileSync, writeFileSync } from 'node:fs';
import { analyze } from '../src/analyzer.mjs';

const argv = process.argv.slice(2);
const arg = (name, def) => { const i = argv.indexOf(`--${name}`); return i === -1 ? def : argv[i + 1]; };
const LIMIT = Number(arg('limit', 0));
const MODEL = arg('model', process.env.ANALYZER_MODEL || 'opus');
const CONCURRENCY = Number(arg('concurrency', 5));
const FILTER = arg('filter', '');

const golden = JSON.parse(readFileSync(new URL('./golden.json', import.meta.url), 'utf8'));
let cases = golden.cases;
if (FILTER) cases = cases.filter(c => c.id.startsWith(FILTER));
if (LIMIT) cases = cases.slice(0, LIMIT);

/** 取主句（role=main，沒有就取第一個子句） */
const mainClause = (sent) => sent?.clauses?.find(c => c.role === 'main') ?? sent?.clauses?.[0];

async function runCase(c) {
  const t0 = Date.now();
  try {
    const { data, meta } = await analyze(c.text, { model: MODEL });
    // 多句輸入（如 "Be quiet! The baby is sleeping now."）取最後一句為待驗證主句
    const sent = data.sentences?.[data.sentences.length - 1];
    const cl = mainClause(sent);
    const gotPattern = cl?.pattern?.id ?? null;
    const gotTime = cl?.tense?.time ?? null;
    const gotAspect = cl?.tense?.aspect ?? null;
    const gotCodes = (sent?.notes ?? []).filter(n => n.type === 'error').map(n => n.errorCode);
    const alignOk = (sent?.clauses ?? []).every(x => x.alignment?.ok);
    const alignFailures = (sent?.clauses ?? []).flatMap(x => x.alignment?.failures ?? []);
    const originalIntact = sent?.original?.includes(c.text.replace(/^(Be quiet!|Look!)\s*/, '')) ?? false;

    return {
      id: c.id, src: c.src, text: c.text, ok: true,
      pattern:   { want: c.pattern,   got: gotPattern, pass: gotPattern === c.pattern },
      tense:     (() => {
        const got = `${gotTime}-${gotAspect}`;
        const accept = c.acceptTense ?? [`${c.time}-${c.aspect}`];   // 歧義句可列多個可接受答案
        return { want: accept.join(' 或 '), got, pass: accept.includes(got) };
      })(),
      errorCode: { want: c.errorCode, got: gotCodes, pass: c.errorCode ? gotCodes.includes(c.errorCode) : gotCodes.length === 0 },
      inScope:   { want: c.inScope,   got: sent?.inScope ?? null, pass: (sent?.inScope ?? null) === c.inScope },
      alignment: { pass: alignOk, failures: alignFailures },
      translation: sent?.translation ?? null,
      hasTranslation: Boolean(sent?.translation?.trim()),
      originalIntact,
      why: c.why,
      meta: { costUsd: meta.costUsd, durationMs: Date.now() - t0, outputTokens: meta.usage?.output_tokens },
      raw: sent,
    };
  } catch (e) {
    return { id: c.id, src: c.src, text: c.text, ok: false, error: String(e.message).slice(0, 300), why: c.why };
  }
}

// 併發池
async function pool(items, size, fn) {
  const out = new Array(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(size, items.length) }, async () => {
    while (true) {
      const i = next++;
      if (i >= items.length) return;
      out[i] = await fn(items[i], i);
      process.stderr.write(`  [${out.filter(Boolean).length}/${items.length}] ${items[i].id}\n`);
    }
  }));
  return out;
}

console.error(`跑 ${cases.length} 個案例，model=${MODEL}，concurrency=${CONCURRENCY}\n`);
const t0 = Date.now();
const results = await pool(cases, CONCURRENCY, runCase);
const wall = Date.now() - t0;

// ---- 計分 ----
const done = results.filter(r => r.ok);
const failed = results.filter(r => !r.ok);
const rate = (n) => `${n}/${done.length} (${done.length ? (n / done.length * 100).toFixed(1) : 0}%)`;
const count = (f) => done.filter(f).length;

const metrics = {
  案例總數: results.length,
  成功呼叫: done.length,
  呼叫失敗: failed.length,
  句型正確: rate(count(r => r.pattern.pass)),
  時態正確: rate(count(r => r.tense.pass)),
  錯誤偵測: rate(count(r => r.errorCode.pass)),
  範圍標記: rate(count(r => r.inScope.pass)),
  成分對齊: rate(count(r => r.alignment.pass)),
  有翻譯: rate(count(r => r.hasTranslation)),
  原文未被改: rate(count(r => r.originalIntact)),
  句型與時態全對: rate(count(r => r.pattern.pass && r.tense.pass)),
  總耗時秒: (wall / 1000).toFixed(1),
  平均每句秒: done.length ? (done.reduce((a, r) => a + r.meta.durationMs, 0) / done.length / 1000).toFixed(1) : 0,
  列價總成本USD: done.reduce((a, r) => a + (r.meta.costUsd || 0), 0).toFixed(4),
};

console.log('\n===== 評測結果 =====');
for (const [k, v] of Object.entries(metrics)) console.log(`${k.padEnd(16, '　')} ${v}`);

const miss = done.filter(r => !r.pattern.pass || !r.tense.pass || !r.errorCode.pass || !r.inScope.pass || !r.alignment.pass);
if (miss.length) {
  console.log(`\n===== 未通過 ${miss.length} 項 =====`);
  for (const r of miss) {
    const bad = [];
    if (!r.pattern.pass)   bad.push(`句型 want=${r.pattern.want} got=${r.pattern.got}`);
    if (!r.tense.pass)     bad.push(`時態 want=${r.tense.want} got=${r.tense.got}`);
    if (!r.errorCode.pass) bad.push(`錯誤 want=${r.errorCode.want ?? '無'} got=[${r.errorCode.got.join(',')}]`);
    if (!r.inScope.pass)   bad.push(`範圍 want=${r.inScope.want} got=${r.inScope.got}`);
    if (!r.alignment.pass) bad.push(`對齊失敗 ${JSON.stringify(r.alignment.failures)}`);
    console.log(`\n${r.id} [${r.src}] "${r.text}"`);
    console.log(`  期望依據: ${r.why}`);
    for (const b of bad) console.log(`  ✗ ${b}`);
  }
}
if (failed.length) {
  console.log(`\n===== 呼叫失敗 =====`);
  for (const r of failed) console.log(`${r.id} "${r.text}" → ${r.error}`);
}

const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const outPath = new URL(`./results/${stamp}-${MODEL}.json`, import.meta.url);
writeFileSync(outPath, JSON.stringify({ model: MODEL, metrics, results }, null, 2));
console.log(`\n詳細結果: eval/results/${stamp}-${MODEL}.json`);
