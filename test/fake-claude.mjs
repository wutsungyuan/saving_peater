// 假的 Claude CLI，只給測試用：讓伺服器的「會呼叫模型」的路由能完整跑過，不花任何額度。
// 用法（測試裡設環境變數）：
//   CLAUDE_BIN=<node 路徑>  CLAUDE_ARGS_PREFIX='["test/fake-claude.mjs"]'
// 它收到的參數和真的 CLI 一樣（-p <提示> --system-prompt-file <檔> ...），依系統提示檔名判斷是哪一種呼叫。
//
// 可以用環境變數注入情況：
//   FAKE_LOG=<檔>             每次被呼叫就附加一行 JSON（種類、句數），測試用來數呼叫次數
//   FAKE_DELAY_MS=<ms>        每次呼叫先等一下（測併發與串流）
//   FAKE_FAIL_AFTER=<n>       第 n 次呼叫之後都回「額度用盡」（要靠 FAKE_COUNTER 檔記次數）
//   FAKE_FAIL_MATCH=<字串>    提示裡含這段文字就回一般錯誤（單句失敗）
//   FAKE_COUNTER=<檔>         呼叫次數計數用
import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { basename } from 'node:path';

const argv = process.argv.slice(2);
const val = flag => { const i = argv.indexOf(flag); return i >= 0 ? argv[i + 1] : undefined; };
const prompt = val('-p') ?? '';
const sys = basename(val('--system-prompt-file') ?? '');
const env = process.env;

const kind = sys === 'analyzer-system.md' ? 'analyze'
  : sys === 'analyze-ocr.md' ? 'prose-ocr'
  : sys === 'wordset-system.md' ? 'enrich'
  : sys === 'wordset-ocr.md' ? 'wordset-ocr' : 'unknown';

const sentencesOf = text => text.split(/(?<=[.!?])\s+/).map(s => s.trim()).filter(Boolean);
const finish = (result, extra = {}) => {
  const n = extra.n ?? 1;
  process.stdout.write(JSON.stringify({
    type: 'result', is_error: false, result: typeof result === 'string' ? result : JSON.stringify(result),
    total_cost_usd: 0.01 * n, duration_ms: 5,
    usage: { input_tokens: 100 * n, output_tokens: 300 * n, cache_read_input_tokens: 1000, cache_creation_input_tokens: 0 },
  }));
  process.exit(0);
};
const fail = (message, code = 0) => {
  if (code) { process.stderr.write(message); process.exit(code); }
  process.stdout.write(JSON.stringify({ type: 'result', is_error: true, result: message, total_cost_usd: 0, usage: {} }));
  process.exit(0);
};

const analysis = (original, index) => {
  const tokens = original.match(/[A-Za-z']+/g) ?? [];
  const body = original.replace(/[.!?]+$/, '');
  const first = tokens[0] ?? body;
  const rest = body.slice(body.indexOf(first) + first.length).trim();
  const constituents = [{ text: first, role: 'S' }, ...(rest ? [{ text: rest, role: 'V' }] : [])];
  return {
    index, original, translation: '（測試翻譯）',
    words: tokens.map(t => ({ text: t, pos: 'n' })),
    clauses: [{
      text: body, role: 'main', connector: null,
      pattern: { id: 1, label: 'S + V', name: '句型一' }, constituents,
      tense: { time: 'present', aspect: 'simple', label: '現在簡單式', formula: 'S + V', evidence: [], inScope: true },
      verb: { lemma: (tokens[1] ?? 'be').toLowerCase(), form: tokens[1] ?? 'is', irregular: false,
              forms: { base: 'be', past: 'was', pastParticiple: 'been', ing: 'being', third: 'is' } },
    }],
    wordOrder: { 主: first, 動: rest || null, 賓: null, 方: null, 地: null, 時: null },
    notes: [], inScope: true, issue: null,
  };
};

// ---- 計次與注入 ----
const count = (() => {
  if (!env.FAKE_COUNTER) return 0;
  const n = (existsSync(env.FAKE_COUNTER) ? Number(readFileSync(env.FAKE_COUNTER, 'utf8')) || 0 : 0) + 1;
  writeFileSync(env.FAKE_COUNTER, String(n));
  return n;
})();
const sentences = kind === 'analyze' ? sentencesOf(prompt) : [];
if (env.FAKE_LOG) appendFileSync(env.FAKE_LOG, JSON.stringify({ kind, sentences: sentences.length, n: count }) + '\n');

await new Promise(r => setTimeout(r, Number(env.FAKE_DELAY_MS || 0)));

if (env.FAKE_FAIL_AFTER && count > Number(env.FAKE_FAIL_AFTER)) fail('Claude usage limit reached. Your limit will reset at 5pm.');
if (env.FAKE_FAIL_MATCH && prompt.includes(env.FAKE_FAIL_MATCH)) fail('boom: 模型當掉了', 1);

if (kind === 'analyze') finish({ sentences: sentences.map(analysis) }, { n: sentences.length });

if (kind === 'prose-ocr') finish({ text: env.FAKE_OCR_TEXT ?? 'I like cats.\nShe runs fast.', filled: 0 });

if (kind === 'wordset-ocr') finish({ words: [{ term: 'apple', zh: '蘋果' }, { term: 'banana', zh: '香蕉' }, { term: 'cherry', zh: null }] });

if (kind === 'enrich') {
  const items = prompt.split('\n').map(l => l.trim()).filter(Boolean).map(l => { const [term, ...zh] = l.split(/[,，]/); return { term: term.trim(), zh: zh.join(',').trim() }; });
  finish({ words: items.map(it => ({
    term: it.term, syllables: it.term, spellTip: null,
    senses: [{ pos: 'n', zh: it.zh || '測試', example: `I use the word ${it.term} every day.`, exampleZh: '我每天用這個字。' }],
    confusable: [], family: [],
  })) }, { n: items.length });
}

fail('fake-claude 不認得這種呼叫：' + sys, 2);
