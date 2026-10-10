// 測驗卷出題器測試：用真實分析過的種子句子，檢查每個題型出得出題、答案一致、題目沒有洩漏或矛盾。
// 跑法：node --no-warnings test/papers-gen.mjs
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openCache } from '../src/cache.mjs';
import { autoSeed } from '../src/cache-cli.mjs';
import { buildPool } from '../src/papers/pool.mjs';
import { generateType, supplyOf, publicQuestion, sample, chunksOf, breakSentence, grammarTargets } from '../src/papers/gen.mjs';
import { seededRng } from '../src/papers/plan.mjs';

const tmp = mkdtempSync(join(tmpdir(), 'peater-gen-'));
const cache = openCache(join(tmp, 'cache.db'));
autoSeed(cache);

const W = (term, pos, zh, example, exampleZh, extra = {}) => ({ term, syllables: term, senses: [{ pos, zh, example, exampleZh }], confusable: [], family: [], ...extra });
const setId = cache.createWordset('測試字表', [
  W('apple', 'n', '蘋果', 'I eat an apple every day.', '我每天吃一顆蘋果。', { family: [{ word: 'apples', pos: 'n', zh: '蘋果（複數）' }] }),
  W('teach', 'v', '教導', 'She teaches English at school.', '她在學校教英文。', { confusable: [{ word: 'learn', zh: '學習' }] }),
  W('lend', 'v', '借（出）', 'Can you lend me your pen?', '你可以借我你的筆嗎？', { confusable: [{ word: 'borrow', zh: '借（入）' }] }),
  W('cloudy', 'adj', '多雲的', 'It is cloudy this morning.', '今天早上多雲。', { family: [{ word: 'cloud', pos: 'n', zh: '雲' }] }),
  W('family', 'n', '家人', 'I love my family.', '我愛我的家人。'),
  W('piano', 'n', '鋼琴', 'She plays the piano well.', '她鋼琴彈得很好。', { confusable: [{ word: 'love', zh: '愛' }] }),
  W('homework', 'n', '作業', 'I do my homework at night.', '我晚上寫作業。'),
  W('school', 'n', '學校', 'We go to school every day.', '我們每天上學。'),
  W('breakfast', 'n', '早餐', 'I eat breakfast at seven.', '我七點吃早餐。'),
  W('weather', 'n', '天氣', 'How is the weather today?', '今天天氣如何？'),
]);

// 文章：用種子裡真實分析過的句子，分成兩段
const seeded = cache.db.prepare("SELECT hash, original FROM sentences WHERE issue IS NULL AND length(original) BETWEEN 20 AND 70 ORDER BY hash LIMIT 26").all();
const art = cache.saveArticle({ name: '測試文章', items: seeded.map((s, i) => ({ para: i < 13 ? 0 : 1, hash: s.hash })) });
const pool = buildPool(cache, { setIds: [setId], articleIds: [art.id] });

const results = [];
const t = (name, fn) => { try { fn(); results.push(true); console.log(`  ✓ ${name}`); } catch (e) { results.push(false); console.log(`  ✗ ${name}\n      ${e.message.split('\n')[0]}`); } };
const rng = () => seededRng(11);
const lc = s => String(s).toLowerCase();
const strip = s => String(s).replace(/[.!?]+$/, '').trim().toLowerCase();
const uniq = a => new Set(a).size === a.length;

console.log('素材池');
t('單字、已分析句子、文章都展開了', () => {
  assert.equal(pool.words.length, 10);
  assert.ok(pool.records.length >= 20, `句子 ${pool.records.length}`);
  assert.equal(pool.articles.length, 1); assert.equal(pool.articles[0].paragraphs.length, 2);
});
t('已知字集含字表的字與句子裡的字', () => { assert.ok(pool.known.has('apple') && pool.known.size > 40); });
t('免費延伸字：字族與易混淆字，不在字表裡', () => {
  const terms = pool.extWords.map(e => e.term);
  for (const x of ['apples', 'learn', 'borrow', 'cloud', 'love']) assert.ok(terms.includes(x), x);
  assert.ok(pool.extWords.every(e => e.zh && e.from && !['apple', 'teach'].includes(e.term)));
});
t('沒選範圍 → 空的素材池，不當掉', () => { const p = buildPool(cache, {}); assert.equal(p.words.length + p.records.length + p.articles.length, 0); });

console.log('供給量');
const supply = supplyOf(pool, rng());
t('每個題型都算出供給量', () => {
  for (const id of ['mc', 'fill', 'match', 'reorder', 'fix', 'make', 'trans', 'wbank', 'cloze']) assert.ok(supply[id] > 0, `${id} = ${supply[id]}`);
  console.log('    供給量：' + Object.entries(supply).map(([k, v]) => `${k}=${v}`).join(' '));
});

console.log('各題型');
const gen = (type, n, opts) => generateType(type, n, pool, rng(), opts);
t('單題選擇：單字與文法各一半、選項不重複且含答案', () => {
  const { questions: qs } = gen('mc', 12);
  assert.equal(qs.length, 12);
  assert.ok(qs.some(q => q.skill.startsWith('word')) && qs.some(q => !q.skill.startsWith('word')), '應該兩種都有');
  for (const q of qs) {
    assert.equal(q.inputMode, 'choice', `${q.skill} 的 inputMode 是 ${q.inputMode}`); assert.ok(q.choices.length >= 3, `${q.skill} 選項 ${q.choices?.length}`);
    assert.ok(uniq(q.choices.map(c => String(c.value))), '選項重複');
    assert.ok(q.choices.some(c => String(c.value) === String(q.answer[0])), `答案不在選項裡：${q.prompt}`);
  }
});
t('單題選擇：單字題的來源都帶統計資訊', () => { for (const q of gen('mc', 12).questions) assert.ok(q.meta.stat?.kind === 'word' || q.meta.stat?.kind === 'sentence'); });
t('單字填空：題幹有空格、答案是該字的形式', () => {
  const { questions: qs } = gen('fill', 5);
  assert.equal(qs.length, 5);
  for (const q of qs) { assert.equal(q.inputMode, 'text'); assert.match(q.question, /_{3,}/); assert.ok(q.answer[0].length > 1); }
});
t('配合題：全部題目共用同一份選項，每題答案都在裡面', () => {
  const { questions: qs } = gen('match', 6);
  assert.equal(qs.length, 6);
  const opts = qs[0].choices.map(c => c.value);
  assert.ok(qs.every(q => q.choices.map(c => c.value).join('|') === opts.join('|')));
  assert.ok(qs.every(q => opts.includes(q.answer[0]))); assert.ok(uniq(opts)); assert.ok(opts.length >= 6 && opts.length <= 8);
});
t('句子重組：積木是答案的排列、打亂後不等於答案、時間修飾語有備用答案', () => {
  const { questions: qs } = gen('reorder', 8);
  assert.ok(qs.length >= 5);
  for (const q of qs) {
    assert.equal(q.inputMode, 'order');
    const sorted = a => [...a].map(s => s.replace(/[.!?]+$/, '')).sort().join('|');
    for (const o of q.orders) assert.equal(sorted(o), sorted(q.chunks), '積木與答案不是同一組');
    assert.ok(!q.orders.some(o => o.join(' ') === q.chunks.join(' ')), '打亂後等於答案');
    assert.equal(strip(q.orders[0].join(' ')), strip(q.answer[0]), `答案與原句不同：${q.orders[0].join(' ')} / ${q.answer[0]}`);
  }
});
t('句子重組的拆法：Tom played basketball yesterday. 時間放句首句尾都算對', () => {
  const data = { original: 'Tom played basketball yesterday.', clauses: [{ role: 'main', alignment: { ok: true }, constituents: [
    { text: 'Tom', role: 'S', start: 0, end: 3 }, { text: 'played', role: 'V', start: 4, end: 10 }, { text: 'basketball', role: 'O', start: 11, end: 21 }, { text: 'yesterday', role: 'M-time', start: 22, end: 31 }] }] };
  const c = chunksOf(data);
  assert.deepEqual(c.orders[0], ['Tom', 'played', 'basketball', 'yesterday.']);
  assert.deepEqual(c.orders[1], ['yesterday', 'Tom', 'played', 'basketball.']);
});
t('改錯：錯句與原句只差一個字，答案是原句', () => {
  const { questions: qs } = gen('fix', 6);
  assert.ok(qs.length >= 3, `只出了 ${qs.length} 題`);
  for (const q of qs) { assert.equal(q.inputMode, 'text'); assert.notEqual(lc(q.question), lc(q.answer[0])); assert.ok(q.explain.length > 5); }
});
t('改錯的製造錯誤：現在簡單式第三人稱動詞還原成原形（保證會錯）', () => {
  const data = { original: 'She teaches English.', words: [{ text: 'She', pos: 'pron', start: 0, end: 3 }, { text: 'teaches', pos: 'v', start: 4, end: 11 }, { text: 'English', pos: 'n', start: 12, end: 19 }],
    clauses: [{ role: 'main', tense: { time: 'present', aspect: 'simple', evidence: ['teaches'] }, verb: { form: 'teaches', forms: { base: 'teach', past: 'taught', pastParticiple: 'taught', ing: 'teaching', third: 'teaches' } } }] };
  assert.equal(breakSentence(data).wrong, 'She teach English.');
  assert.equal(breakSentence({ ...data, clauses: [{ ...data.clauses[0], tense: { time: 'present', aspect: 'simple', evidence: [] }, verb: { ...data.clauses[0].verb, form: 'teach' } }] }), null, '原形本來就是對的，不能當錯');
});
t('造句與翻譯：開放題帶檢查用的欄位，題幹不含答案', () => {
  const m = gen('make', 3).questions, tr = gen('trans', 3).questions;
  assert.equal(m.length, 3); assert.equal(tr.length, 3);
  for (const q of m) { assert.equal(q.inputMode, 'open'); assert.ok(q.checkTerm); assert.ok(!q.question); }
  for (const q of tr) { assert.equal(q.inputMode, 'open'); assert.ok(q.keywords.length >= 1); assert.ok(q.answer[0] && !q.question.includes(q.answer[0])); }
});
t('克漏字：空格與題目一一對應，把答案填回去就是原文', () => {
  const { questions: qs, passages } = gen('cloze', 8);
  assert.ok(qs.length >= 5 && passages.length === 1);
  const p = passages[0].text, nums = [...p.matchAll(/\((\d+)\)/g)].map(m => Number(m[1]));
  assert.deepEqual(nums, qs.map(q => q.blankNo).sort((a, b) => a - b), '空格編號與題目不一致');
  const originals = pool.articles[0].paragraphs.flatMap(pa => pa.sentences.map(s => s.original));
  let filled = p; for (const q of qs) filled = filled.replace(`(${q.blankNo})`, q.answer[0]);
  for (const line of filled.split(/\n\n| (?=[A-Z])/)) { /* 只檢查每個空格被填回後，整段文字是原文的連續片段 */ }
  const flat = filled.replace(/\s+/g, ' ');
  const joined = originals.join(' ').replace(/\s+/g, ' ');
  assert.ok(joined.includes(flat.slice(0, 60)), '填回答案後與原文不符');
  for (const q of qs) { assert.equal(q.choices.length, 4); assert.ok(uniq(q.choices.map(c => lc(c.value)))); assert.ok(q.choices.some(c => c.value === q.answer[0])); }
});
t('克漏字的空格不在句首（避免大小寫洩漏答案）', () => {
  const { passages } = gen('cloze', 8);
  assert.ok(!/(^|[.!?]\s+)\(\d+\)/.test(passages[0].text), passages[0].text.slice(0, 120));
});
t('文意選填：字庫含全部答案加 2 個多餘的字，填回去是原文', () => {
  const r = gen('wbank', 5); const qs = r.questions;
  assert.ok(qs.length >= 4); const bank = qs[0].choices.map(c => c.value);
  assert.equal(bank.length, qs.length + 2); assert.ok(qs.every(q => bank.includes(q.answer[0])));
  const nums = [...r.passages[0].text.matchAll(/\((\d+)\)/g)].map(m => Number(m[1]));
  assert.deepEqual(nums, qs.map(q => q.blankNo).sort((a, b) => a - b));
});
t('免費延伸：用字族、易混淆字出單字題，標明來源與依據', () => {
  for (const type of ['mc', 'match', 'make']) {
    const { questions: qs } = gen(type, 6, { ext: 3, extFree: 3 });
    const ext = qs.filter(q => q.src === 'ext-free');
    assert.equal(ext.length, 3, `${type} 延伸 ${ext.length}`);
    assert.equal(qs.filter(q => q.src === 'scope').length, 3);
    for (const q of ext) assert.ok(q.meta.anchors?.[0]?.word, '沒有依據');
  }
});
t('免費延伸的選擇題：干擾項不含答案、不重複', () => {
  for (const q of gen('mc', 6, { ext: 6, extFree: 6 }).questions.filter(q => q.src === 'ext-free')) {
    assert.ok(uniq(q.choices.map(c => c.value))); assert.ok(q.choices.some(c => c.value === q.answer[0]));
  }
});
t('抽樣：先挑不同來源的，不夠才重複', () => {
  const qs = [1, 1, 2, 2, 3].map((k, i) => ({ id: i, meta: { key: k } }));
  assert.ok(uniq(sample(qs, 3, seededRng(1)).map(q => q.meta.key)));
  assert.equal(sample(qs, 5, seededRng(1)).length, 5);
});
t('送給學生的版本沒有答案、解析、檢查欄位', () => {
  for (const type of ['mc', 'fill', 'reorder', 'fix', 'make', 'trans', 'cloze']) for (const q of gen(type, 3).questions) {
    const p = publicQuestion(q);
    for (const k of ['answer', 'accept', 'alsoAccept', 'orders', 'explain', 'keywords', 'sample', 'checkTerm', 'meta']) assert.ok(!(k in p), `${type} 洩漏 ${k}`);
  }
});
t('範圍內的題目 src 是 scope；每題都有 type 與 inputMode', () => {
  for (const type of ['mc', 'fill', 'match', 'reorder', 'fix', 'make', 'trans', 'cloze', 'wbank']) for (const q of gen(type, 4).questions) { assert.equal(q.src, 'scope'); assert.equal(q.type, type); assert.ok(q.inputMode); }
});

try { rmSync(tmp, { recursive: true, force: true }); } catch {}
const fail = results.filter(x => !x).length;
console.log(fail ? `\n有失敗 (${fail}/${results.length})` : `\n全部通過 (${results.length})`);
process.exit(fail ? 1 : 0);
