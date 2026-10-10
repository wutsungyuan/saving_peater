// 配題與計分引擎測試：題數、滿分 100、核心三塊、開放題上限、供給量限制、延伸題分配、種子可重現。
// 跑法：node --no-warnings test/papers-plan.mjs
import assert from 'node:assert/strict';
import { composePaper, extSplit, seededRng, TYPES, TYPE_BY_ID, DIFFICULTY } from '../src/papers/plan.mjs';

let n = 0; const results = [];
const t = (name, fn) => { try { fn(); results.push(true); console.log(`  ✓ ${name}`); } catch (e) { results.push(false); console.log(`  ✗ ${name}\n      ${e.message.split('\n')[0]}`); } };
const sumOf = (rows, k) => rows.reduce((s, r) => s + r[k], 0);

console.log('自動配題');
const COMBOS = [
  ['單字+句子+文章', { words: true, sent: true, art: true }],
  ['單字+句子', { words: true, sent: true, art: false }],
  ['文章+句子', { words: false, sent: true, art: true }],
];
for (const [label, have] of COMBOS) {
  t(`${label}：N=25～50 各抽 30 次，題數正確、剛好 100 分、核心三塊不缺`, () => {
    for (let N = 25; N <= 50; N++) for (let i = 0; i < 30; i++) {
      const r = composePaper({ have, N, seed: N * 1000 + i });
      assert.ok(!r.error, `${N}: ${r.message}`);
      assert.equal(sumOf(r.rows, 'n'), N, `題數 ${N}`);
      assert.equal(r.total, 100, `滿分 ${N}/${i}`);
      assert.ok(r.rows.some(x => x.id === 'mc'), '缺 mc');
      if (have.art) assert.ok(r.rows.some(x => x.id === 'read') && r.rows.some(x => x.id === 'cloze'), '缺 read／cloze');
      assert.ok(r.rows.filter(x => TYPE_BY_ID[x.id].open).length <= 1, '開放題超過 1 種');
      for (const x of r.rows) assert.ok(x.n >= 1 && x.pts > 0);
    }
  });
}
t('權重高的題型每題分數不會比權重低的少', () => {
  for (let i = 0; i < 200; i++) {
    const r = composePaper({ have: COMBOS[0][1], N: 50, seed: i });
    for (const a of r.rows) for (const b of r.rows) if (!a.extra && !b.extra && TYPE_BY_ID[a.id].w > TYPE_BY_ID[b.id].w) assert.ok(a.pts >= b.pts, `${a.id}(${a.pts}) < ${b.id}(${b.pts})`);
  }
});
t('25～34 題抽 3～4 種、35～50 題抽 4～5 種', () => {
  for (let i = 0; i < 100; i++) {
    const a = composePaper({ have: COMBOS[0][1], N: 28, seed: i }), b = composePaper({ have: COMBOS[0][1], N: 45, seed: i });
    assert.ok(a.rows.length >= 3 && a.rows.length <= 4, `28 題 ${a.rows.length} 種`);
    assert.ok(b.rows.length >= 4 && b.rows.length <= 5, `45 題 ${b.rows.length} 種`);
  }
});
t('不允許開放題時不會出現翻譯與造句', () => {
  for (let i = 0; i < 100; i++) assert.ok(composePaper({ have: COMBOS[0][1], N: 40, allowOpen: false, seed: i }).rows.every(x => !TYPE_BY_ID[x.id].open));
});
t('同一個種子 → 完全相同的配題；不同種子 → 會變', () => {
  const a = composePaper({ have: COMBOS[0][1], N: 40, difficulty: 'mid', seed: 7 }), b = composePaper({ have: COMBOS[0][1], N: 40, difficulty: 'mid', seed: 7 });
  assert.deepEqual(a, b);
  const kinds = new Set(Array.from({ length: 30 }, (_, i) => composePaper({ have: COMBOS[0][1], N: 40, seed: i }).rows.map(r => r.id + r.n).join()));
  assert.ok(kinds.size > 5, `只有 ${kinds.size} 種不同`);
});

console.log('素材供給量');
t('供給量不足的題型自動拿掉', () => {
  const r = composePaper({ have: COMBOS[0][1], N: 40, supply: { mc: 40, read: 2, cloze: 40, wbank: 40, reorder: 40, fix: 2, fill: 40, match: 40, trans: 40, make: 40 }, seed: 1 });
  assert.ok(!r.error && !r.rows.some(x => x.id === 'read' || x.id === 'fix'), r.rows.map(x => x.id).join());
});
t('每個題型的題數不超過供給量', () => {
  for (let i = 0; i < 100; i++) {
    const supply = { mc: 40, read: 6, cloze: 10, wbank: 6, reorder: 6, fix: 5, fill: 7, match: 6, trans: 4, make: 4 };
    const r = composePaper({ have: COMBOS[0][1], N: 50, supply, seed: i });
    assert.ok(!r.error, r.message);
    for (const x of r.rows) assert.ok(x.n <= supply[x.id], `${x.id} ${x.n} > ${supply[x.id]}`);
    assert.equal(sumOf(r.rows, 'n'), 50); assert.equal(r.total, 100);
  }
});
t('素材太少湊不到題數 → 明確的錯誤，不是亂湊', () => {
  const r = composePaper({ have: { words: true, sent: false, art: false }, N: 50, supply: { mc: 6, fill: 3, match: 4, make: 3 }, seed: 1 });
  assert.equal(r.error, 'not-enough'); assert.match(r.message, /湊不到 50 題/);
});
t('沒選任何範圍 → 錯誤；題數超出 25～50 → 錯誤', () => {
  assert.equal(composePaper({ have: { words: false, sent: false, art: false }, N: 40 }).error, 'no-scope');
  assert.equal(composePaper({ have: COMBOS[0][1], N: 24 }).error, 'bad-n');
  assert.equal(composePaper({ have: COMBOS[0][1], N: 51 }).error, 'bad-n');
});

console.log('自選題型');
t('只選三個題型：照你選的出，剛好 100 分', () => {
  for (let N = 25; N <= 50; N += 5) {
    const r = composePaper({ have: COMBOS[0][1], N, mode: 'custom', types: ['mc', 'read', 'reorder'], seed: N });
    assert.ok(!r.error, r.message); assert.deepEqual(r.rows.map(x => x.id).sort(), ['mc', 'read', 'reorder']);
    assert.equal(sumOf(r.rows, 'n'), N); assert.equal(r.total, 100);
  }
});
t('勾了素材做不出的題型：略過並回報（沒有文章表就不能出閱讀）', () => {
  const r = composePaper({ have: COMBOS[1][1], N: 40, mode: 'custom', types: ['mc', 'read', 'reorder', 'fill'], seed: 3 });
  assert.ok(!r.error && !r.rows.some(x => x.id === 'read') && r.skipped.includes('read'), JSON.stringify(r.skipped));
});
t('什麼都沒勾 → 錯誤；只選一種也湊得出來（放寬範圍）', () => {
  assert.equal(composePaper({ have: COMBOS[0][1], N: 40, mode: 'custom', types: [] }).error, 'no-types');
  const r = composePaper({ have: COMBOS[0][1], N: 50, mode: 'custom', types: ['mc'], seed: 1 });
  assert.ok(!r.error && r.rows.length === 1 && r.rows[0].n === 50 && r.total === 100 && r.relax >= 1);
});

console.log('難度與延伸題');
t('簡單：沒有延伸；中等約 30%；困難約 60%（以題數計，剛好達標）', () => {
  for (const [d, ratio] of Object.entries(DIFFICULTY)) for (let N = 25; N <= 50; N += 5) for (let i = 0; i < 20; i++) {
    const r = composePaper({ have: COMBOS[0][1], N, difficulty: d, seed: i });
    assert.equal(sumOf(r.rows, 'ext'), r.ext.actual);
    assert.ok(r.ext.actual <= r.ext.target && r.ext.target === Math.round(N * ratio));
    if (!ratio) assert.equal(r.ext.actual, 0);
    else assert.ok(r.ext.target - r.ext.actual <= 3, `${d} ${N}: 目標 ${r.ext.target} 實際 ${r.ext.actual}`);
    for (const x of r.rows) assert.ok(x.ext <= x.n && x.extFree <= x.ext);
  }
});
t('不能延伸的題型（克漏字、文意選填、單字填空）不會被分到延伸題', () => {
  for (let i = 0; i < 100; i++) {
    const r = composePaper({ have: COMBOS[0][1], N: 50, difficulty: 'hard', seed: i });
    for (const x of r.rows) if (!TYPE_BY_ID[x.id].ext) assert.equal(x.ext, 0, x.id);
  }
});
t('省錢優先：免費延伸先用掉；偏好模型時不用免費', () => {
  let freeUsed = 0;
  for (let i = 0; i < 100; i++) {
    const r = composePaper({ have: COMBOS[0][1], N: 50, difficulty: 'mid', seed: i });
    freeUsed += r.ext.free;
    const p = composePaper({ have: COMBOS[0][1], N: 50, difficulty: 'mid', preferModel: true, seed: i });
    assert.equal(p.ext.free, 0);
  }
  assert.ok(freeUsed > 100 * 5, `免費延伸太少：${freeUsed}`);
});
t('免費延伸字不夠時，超出的部分改用模型', () => {
  const r = composePaper({ have: COMBOS[0][1], N: 50, difficulty: 'mid', freeSupply: 3, seed: 5 });
  assert.ok(r.ext.free <= 3, `free=${r.ext.free}`);
});

console.log('分數');
t('每題分數是 0.5 的倍數', () => {
  for (let i = 0; i < 100; i++) for (const x of composePaper({ have: COMBOS[0][1], N: 25 + (i % 26), seed: i }).rows) assert.equal((x.pts * 2) % 1, 0);
});
t('亂數種子：相同種子相同序列', () => {
  const a = seededRng(42), b = seededRng(42);
  for (let i = 0; i < 10; i++) assert.equal(a(), b());
});

const fail = results.filter(x => !x).length;
console.log(fail ? `\n有失敗 (${fail}/${results.length})` : `\n全部通過 (${results.length})`);
process.exit(fail ? 1 : 0);
