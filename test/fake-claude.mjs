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
//   FAKE_EXAM_BAD_FIRST=1     出題任務的第一次呼叫回一半不合格的題（測驗證與「只補缺的」）
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
  : sys === 'wordset-ocr.md' ? 'wordset-ocr'
  : sys === 'exam-gen.md' ? 'exam' : 'unknown';

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
const examReq = kind === 'exam' ? (() => { try { return JSON.parse(prompt); } catch { return {}; } })() : null;
if (env.FAKE_LOG) appendFileSync(env.FAKE_LOG, JSON.stringify({ kind, sentences: sentences.length, n: count, task: examReq?.task, cap: val('--max-budget-usd'), model: val('--model') }) + '\n');

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

// ---- 測驗卷的出題任務（read / cloze / ext）：回傳結構合法、內容是機器湊的題目 ----
if (kind === 'exam') {
  const req = examReq, bad = env.FAKE_EXAM_BAD_FIRST === '1' && count === 1;
  const known = req.known ?? [], anchors = req.anchors ?? [];
  const fw = known.filter(w => /^[a-z]{3,}$/.test(w));
  const w = i => fw[i % Math.max(1, fw.length)] ?? 'school';
  const rot = (i, right, others) => { const c = [...others]; c.splice(i % 4, 0, right); return { choices: c, answer: i % 4 }; };
  const rq = (i, n) => {
    const skill = ['detail', 'inference', 'main', 'vocab'][i % 4];
    const first = (req.passage?.[0]?.text ?? '').match(/[A-Za-z]{4,}/)?.[0] ?? 'word';
    return { q: skill === 'vocab' ? `What does "${first}" mean in this passage?` : `Question ${i + 1} about the passage?`,
      ...rot(i, `Right ${i}`, [`Wrong a${i}`, `Wrong b${i}`, `Wrong c${i}`]), skill, evidence: [Math.min(n, (i % n) + 1)], explain: '文章裡有寫。' };
  };
  if (req.task === 'read') {
    const n = req.passage.length, cnt = req.count;
    const qs = Array.from({ length: cnt }, (_, i) => rq(i, n));
    if (bad) { qs[0].choices = qs[0].choices.slice(0, 3); qs[1].answer = 9; }
    finish({ questions: qs }, { n: cnt });
  }
  if (req.task === 'cloze') finish({ items: req.targets.map(t => ({ n: t.n, word: t.word, distractors: ['table', 'river', 'green'].filter(x => x !== t.word.toLowerCase()).slice(0, 3) })) }, { n: req.targets.length });
  if (req.task === 'ext') {
    const want = req.want ?? {}, out = {}; let total = 0;
    const A = i => anchors[i % Math.max(1, anchors.length)]?.word ?? 'school';
    const mk = (type, n, fn) => { out[type] = Array.from({ length: n }, (_, i) => fn(i)); total += n; };
    if (want.mc) mk('mc', want.mc, i => { const a = A(i); const r = rot(i, a, [w(i + 1), w(i + 2), w(i + 3)]); return { q: `${w(i)} ${w(i + 4)} ______ ${w(i + 5)}.`, ...r, skill: 'word-choice', explain: '看空格前後。', anchors: [a] }; });
    if (want.reorder) mk('reorder', want.reorder, i => { const a = A(i), ch = [w(i), a, w(i + 1)]; return { sentence: ch.join(' ') + '.', chunks: [ch[0], ch[1], ch[2] + '.'], zh: '（測試句）', anchors: [a] }; });
    if (want.fix) mk('fix', want.fix, i => { const a = A(i); return { wrong: `${w(i)} ${a} ${w(i + 1)} ${w(i + 2)}.`, right: `${w(i)} ${a} ${w(i + 1)}.`, why: '多了一個字。', anchors: [a] }; });
    if (want.trans) mk('trans', want.trans, i => { const a = A(i); return { zh: '我們在學校。', en: `${w(i)} ${a} ${w(i + 1)} ${w(i + 2)}.`, anchors: [a] }; });
    if (want.read) mk('read', want.read, i => { const a = A(i); const sents = Array.from({ length: 5 }, (_, k) => `${w(i + k)} ${a} ${w(i + k + 1)}.`); return { title: `Story ${i + 1}`, sentences: sents, anchors: [a], questions: Array.from({ length: 4 }, (_, k) => rq(k, 5)) }; });
    if (env.FAKE_EXAM_BAD_FIRST === '1' && !req.retry) for (const t of ['mc', 'reorder', 'fix', 'trans']) if (out[t]?.length) out[t][0] = { ...out[t][0], anchors: ['nonexistent-word'] };
    finish(out, { n: total });
  }
}

fail('fake-claude 不認得這種呼叫：' + sys, 2);
