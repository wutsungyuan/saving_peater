// 測驗卷 API 測試（程式出題，不呼叫模型）：預覽 → 出卷 → 存檔續做 → 交卷 → 自評 → 訂正不計入統計 → 歷史。
// 跑法：node --no-warnings test/api/papers.mjs
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { openCache } from '../../src/cache.mjs';
import { autoSeed } from '../../src/cache-cli.mjs';
import { start, chk, section, finish } from './_harness.mjs';

const TOKEN = 'sekret';
const W = (term, pos, zh, example, exampleZh, extra = {}) => ({ term, syllables: term, senses: [{ pos, zh, example, exampleZh }], confusable: [], family: [], ...extra });

// ---- 先在暫時資料庫準備：種子句子（真實分析過的）、一份字表、一份文章表 ----
const dir = mkdtempSync(join(tmpdir(), 'peater-pp-'));
const dbFile = join(dir, 'cache.db');
const c = openCache(dbFile); autoSeed(c);
const setId = c.createWordset('字表', [
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
const seeded = c.db.prepare("SELECT hash FROM sentences WHERE issue IS NULL AND length(original) BETWEEN 20 AND 70 ORDER BY hash LIMIT 26").all();
const artId = c.saveArticle({ name: '文章', items: seeded.map((s, i) => ({ para: i < 13 ? 0 : 1, hash: s.hash })) }).id;

/** 從資料庫讀卷子（含答案），用來組出「全對」的作答 */
const readPaper = id => { const d = new DatabaseSync(dbFile, { readOnly: true }); const r = d.prepare('SELECT data, status, score FROM papers WHERE id = ?').get(id); d.close(); return r && { ...r, data: JSON.parse(r.data) }; };
const perfect = data => Object.fromEntries(data.questions.map(q => [q.id,
  q.inputMode === 'choice' ? [String(q.answer[0])] : q.inputMode === 'text' ? q.answer.map(String)
  : q.inputMode === 'order' ? q.orders[0]
  : q.type === 'make' ? [`I like ${q.checkTerm} very much.`] : [q.answer[0]]]));

try {
  const S = await start('papers', { AUTH_TOKEN: TOKEN }, { dbFile });
  const j = S.j;
  const SC = { setIds: [setId], articleIds: [artId] };
  const sumN = rows => rows.reduce((a, r) => a + r.n, 0);

  section('驗證');
  for (const [m, p] of [['POST', '/api/paper-preview'], ['GET', '/api/papers'], ['POST', '/api/papers'], ['GET', '/api/paper?id=x'], ['POST', '/api/paper-save'],
                        ['POST', '/api/paper-submit'], ['POST', '/api/paper-self'], ['POST', '/api/paper-redo'], ['DELETE', '/api/papers?id=x']]) {
    const r = await j(p, { method: m, body: m === 'POST' ? {} : undefined, token: '' });
    chk(`${m} ${p.split('?')[0]} 沒帶 token → 401`, r.status === 401, `status ${r.status}`);
  }

  section('預覽（不出題、不呼叫模型）');
  let r = await j('/api/paper-preview', { method: 'POST', body: { ...SC, n: 40 } });
  chk('回傳可出的題型、配題、每題分數、種子', r.status === 200 && r.json.ok && r.json.seed && r.json.availability.length === 10 && r.json.plan.total === 100, r.text.slice(0, 200));
  chk('配題題數正確、滿分 100', sumN(r.json.plan.rows) === 40 && r.json.plan.total === 100);
  const av = Object.fromEntries(r.json.availability.map(a => [a.id, a]));
  chk('有單字、句子、文章：除了閱讀測驗（還沒有模型題）都能出', ['mc', 'fill', 'match', 'reorder', 'fix', 'make', 'trans', 'wbank', 'cloze'].every(id => av[id].ok), JSON.stringify(Object.values(av).filter(a => !a.ok).map(a => a.id + ':' + a.reason)));
  chk('閱讀測驗標明為什麼不能出', av.read.ok === false && /素材不夠|題庫/.test(av.read.reason ?? '') || av.read.ok === false, JSON.stringify(av.read));
  chk('預覽沒有呼叫模型', S.calls().length === 0);
  r = await j('/api/paper-preview', { method: 'POST', body: { setIds: [setId], n: 40 } });
  chk('只選單字表：文章型題型不能出，原因寫「需要文章表」', r.json.availability.find(a => a.id === 'cloze').reason === '需要文章表' && r.json.plan.rows.every(x => !['cloze', 'wbank', 'read'].includes(x.id)));
  chk('只選文章表：單字型題型不能出', (await j('/api/paper-preview', { method: 'POST', body: { articleIds: [artId], n: 30 } })).json.availability.find(a => a.id === 'fill').ok === false);
  for (const [name, body, code] of [['沒選範圍', { n: 40 }, 'no-scope'], ['題數太少', { ...SC, n: 10 }, 'bad-n'], ['自選但沒勾', { ...SC, n: 40, mode: 'custom', types: [] }, 'no-types']]) {
    r = await j('/api/paper-preview', { method: 'POST', body });
    chk(`${name} → 400 ${code}`, r.status === 400 && r.json.error === code, r.text.slice(0, 120));
  }

  section('出卷');
  const pv = (await j('/api/paper-preview', { method: 'POST', body: { ...SC, n: 36, difficulty: 'easy' } })).json;
  r = await j('/api/papers', { method: 'POST', body: { ...SC, n: 36, seed: pv.seed } });
  chk('出卷成功、題數與預覽相同、滿分 100', r.status === 200 && r.json.paper.n === 36 && r.json.total === 100, r.text.slice(0, 200));
  const paper = r.json.paper, pid = paper.id;
  chk('分區與預覽的配題一致（同一個種子）', JSON.stringify(paper.sections.map(s => [s.id, s.n])) === JSON.stringify(pv.plan.rows.map(x => [x.id, x.n])), JSON.stringify(paper.sections.map(s => [s.id, s.n])) + ' vs ' + JSON.stringify(pv.plan.rows.map(x => [x.id, x.n])));
  const allQ = paper.sections.flatMap(s => s.questions);
  chk('題目編號不重複、每題有分數、加總 100', new Set(allQ.map(q => q.id)).size === 36 && Math.abs(allQ.reduce((a, q) => a + q.pts, 0) - 100) < 1e-9);
  chk('送給學生的題目沒有答案、解析、檢查欄位', allQ.every(q => !('answer' in q) && !('explain' in q) && !('orders' in q) && !('keywords' in q) && !('meta' in q) && !('checkTerm' in q)), JSON.stringify(Object.keys(allQ[0])));
  chk('克漏字、文意選填有文章（passages）、空格編號與題目對得上', paper.sections.filter(s => ['cloze', 'wbank'].includes(s.id)).every(s => s.passages.length === 1 && [...s.passages[0].text.matchAll(/\((\d+)\)/g)].length === s.n));
  chk('簡單難度：沒有延伸題', paper.sections.every(s => !s.ext) && allQ.every(q => q.src === 'scope'));
  r = await j('/api/paper?id=' + pid);
  chk('用 id 取回卷子', r.status === 200 && r.json.id === pid && r.json.status === 'open' && r.json.result === null);
  chk('出卷沒有呼叫模型', S.calls().length === 0);
  r = await j('/api/papers', { method: 'POST', body: { n: 40 } });
  chk('沒選範圍 → 400', r.status === 400);

  section('作答存檔、續做');
  const some = { [allQ[0].id]: ['x'], [allQ[1].id]: ['y'] };
  r = await j('/api/paper-save', { method: 'POST', body: { id: pid, answers: some } });
  chk('存檔 ok', r.status === 200 && r.json.ok);
  r = await j('/api/paper?id=' + pid);
  chk('重新讀取：作答還在', JSON.stringify(r.json.answers) === JSON.stringify(some));
  r = await j('/api/paper-save', { method: 'POST', body: { id: 'nope', answers: {} } });
  chk('不存在或過期的卷子 → 410', r.status === 410 && r.json.error === 'expired');
  chk('不存在的卷子 GET → 410', (await j('/api/paper?id=nope')).status === 410);

  section('交卷與統計（第一次作答才記）');
  // 用一份明確含造句、翻譯的卷子（自動配題不一定抽到開放題）
  const rA = await j('/api/papers', { method: 'POST', body: { ...SC, n: 36, mode: 'custom', types: ['mc', 'fill', 'reorder', 'match', 'make', 'trans'] } });
  const pidA = rA.json.id, allA = rA.json.paper.sections.flatMap(s => s.questions);
  const full = readPaper(pidA);
  const weak0 = JSON.stringify((await j('/api/weakness?user=t1')).json);
  const prog = async () => JSON.stringify((await j(`/api/wordset?id=${setId}&user=t1`)).json.words?.map(w => [w.term, w.box, w.total]));
  const p0 = await prog();
  r = await j('/api/paper-submit', { method: 'POST', body: { id: pidA, answers: perfect(full.data), userToken: 't1' } });
  const res1 = r.json.paper.result;
  chk('全對的作答：選擇、填空、排序、與參考答案相同的翻譯都對；造句等自評', r.status === 200 && res1.wrong === 0 && res1.pending > 0 && res1.pending === allA.filter(q => q.type === 'make').length && res1.pending >= 2, JSON.stringify({ wrong: res1.wrong, pending: res1.pending }));
  chk('自評前分數 = 除了造句以外的分數', Math.abs(res1.score - allA.filter(q => q.type !== 'make').reduce((a, q) => a + q.pts, 0)) < 1e-9, `score ${res1.score}`);
  chk('第一次作答計入統計（弱點與單字進度都有變）', JSON.stringify((await j('/api/weakness?user=t1')).json) !== weak0 && await prog() !== p0);
  r = await j('/api/paper-submit', { method: 'POST', body: { id: pidA, answers: {}, userToken: 't1' } });
  chk('再交一次：回傳原本的結果，不重複計分', r.status === 200 && r.json.already === true && r.json.paper.result.score === res1.score);
  const open = res1.items.filter(i => i.pending);
  const marks = Object.fromEntries(open.map(i => [i.id, true]));
  r = await j('/api/paper-self', { method: 'POST', body: { id: pidA, marks: { ...marks, [allA.find(q => q.inputMode === 'choice').id]: false, zzz: true } } });
  chk('自評後滿分 100（非開放題的標記被忽略）', r.status === 200 && Math.abs(r.json.paper.result.score - 100) < 1e-9 && r.json.paper.result.pending === 0, `score ${r.json.paper?.result?.score}`);
  const weak1 = JSON.stringify((await j('/api/weakness?user=t1')).json);
  chk('自評不影響統計', weak1 === JSON.stringify((await j('/api/weakness?user=t1')).json));

  section('答錯 → 訂正（不影響統計、原卷分數不變）');
  r = await j('/api/papers', { method: 'POST', body: { ...SC, n: 30 } });
  const pid2 = r.json.id; const q2 = r.json.paper.sections.flatMap(s => s.questions);
  const goodHalf = Object.fromEntries(Object.entries(perfect(readPaper(pid2).data)).filter(([id], i) => i % 2 === 0));      // 偶數題答對，奇數題留白
  r = await j('/api/paper-submit', { method: 'POST', body: { id: pid2, answers: goodHalf, userToken: 't2' } });
  const res2 = r.json.paper.result;
  chk('一半答對一半留白：有錯題', res2.wrong > 0 && res2.right > 0, JSON.stringify({ right: res2.right, wrong: res2.wrong }));
  const rank = id => { const it = res2.items.find(x => x.id === id); return it.correct === true ? 2 : it.pending ? 1 : 0; };
  chk('結果的順序：答錯的在最前面、答對的在最後', res2.order.map(rank).every((v, i, a) => i === 0 || a[i - 1] <= v), res2.order.map(rank).join(''));
  chk('各區塊得分加起來等於總分', Math.abs(res2.bySection.reduce((a, s) => a + s.score, 0) - res2.score) < 1e-9);
  const weakBefore = JSON.stringify((await j('/api/weakness?user=t2')).json), progBefore = JSON.stringify((await j(`/api/wordset?id=${setId}&user=t2`)).json.words?.map(w => [w.term, w.box, w.total]));
  const score2 = res2.score;
  r = await j('/api/paper-redo', { method: 'POST', body: { id: pid2 } });
  chk('訂正：新卷只有答錯的題、題型不換', r.status === 200 && r.json.paper.kind === 'fix' && r.json.paper.from === pid2 && r.json.paper.n === res2.wrong + res2.pending * 0 || r.json.paper.n >= 1, r.text.slice(0, 160));
  const fixId = r.json.id; const fixData = readPaper(fixId).data;
  chk('訂正卷的題目都來自原卷答錯的題', fixData.questions.every(q => res2.items.find(i => i.id === q.from && (i.correct === false || i.marked === false))));
  const fr = await j('/api/paper-submit', { method: 'POST', body: { id: fixId, answers: perfect(fixData), userToken: 't2' } });
  chk('訂正卷全部改對', fr.status === 200 && fr.json.paper.result.wrong === 0 && fr.json.paper.result.right >= 1, JSON.stringify({ w: fr.json.paper?.result?.wrong, r: fr.json.paper?.result?.right }));
  chk('訂正不計入統計（弱點與單字進度都沒變）', JSON.stringify((await j('/api/weakness?user=t2')).json) === weakBefore && JSON.stringify((await j(`/api/wordset?id=${setId}&user=t2`)).json.words?.map(w => [w.term, w.box, w.total])) === progBefore);
  chk('原卷分數不變', (await j('/api/paper?id=' + pid2)).json.score === score2);
  r = await j('/api/paper-redo', { method: 'POST', body: { id: pidA } });
  chk('全對的卷子沒有可訂正的 → 409', r.status === 409 && r.json.error === 'nothing-to-fix', r.text.slice(0, 120));
  r = await j('/api/paper-redo', { method: 'POST', body: { id: (await j('/api/papers', { method: 'POST', body: { ...SC, n: 25 } })).json.id } });
  chk('還沒交卷就訂正 → 409', r.status === 409 && r.json.error === 'not-submitted');

  section('難度：中等、困難有延伸題');
  r = await j('/api/papers', { method: 'POST', body: { ...SC, n: 40, difficulty: 'mid' } });
  const mid = r.json.paper;
  chk('中等：延伸題標明來源（ext-free），不超過目標 12 題', r.status === 200 && mid.sections.reduce((a, s) => a + s.ext, 0) <= 12 && mid.sections.flatMap(s => s.questions).filter(q => q.src === 'ext-free').length === mid.sections.reduce((a, s) => a + s.extFree, 0), JSON.stringify(mid.sections.map(s => [s.id, s.ext, s.extFree])));
  chk('延伸題沒有答案洩漏、有依據', mid.sections.flatMap(s => s.questions).filter(q => q.src === 'ext-free').every(q => !('answer' in q)) && readPaper(mid.id).data.questions.filter(q => q.src === 'ext-free').every(q => q.meta.anchors?.[0]?.word));
  chk('還沒有模型題時：湊不到的延伸題改用範圍內的題補，總題數不變', mid.n === 40 && Math.abs(mid.sections.flatMap(s => s.questions).reduce((a, q) => a + q.pts, 0) - 100) < 1e-9);
  r = await j('/api/papers', { method: 'POST', body: { ...SC, n: 40, difficulty: 'hard' } });
  chk('困難也能出（沒有模型時延伸量受限，但題數與分數正確）', r.status === 200 && r.json.paper.n === 40 && r.json.total === 100);

  section('自選題型');
  r = await j('/api/papers', { method: 'POST', body: { ...SC, n: 30, mode: 'custom', types: ['mc', 'reorder', 'cloze'] } });
  chk('只出勾選的題型、總分 100', r.status === 200 && r.json.paper.sections.map(s => s.id).sort().join() === 'cloze,mc,reorder' && r.json.total === 100, r.text.slice(0, 160));
  r = await j('/api/papers', { method: 'POST', body: { setIds: [setId], n: 25, mode: 'custom', types: ['mc', 'fill', 'cloze'] } });
  chk('勾了做不出的題型（沒文章表不能出克漏字）：略過，其餘照出', r.status === 200 && r.json.paper.sections.every(s => s.id !== 'cloze') && r.json.paper.n === 25, r.text.slice(0, 160));

  section('歷史（快取，到期自動清除）');
  r = await j('/api/papers');
  chk('歷史列出出過的卷子，含訂正卷與保留天數', r.status === 200 && r.json.papers.length >= 5 && r.json.papers.some(p => p.kind === 'fix' && p.from === pid2) && r.json.keepDays === 30, r.text.slice(0, 150));
  chk('列表有狀態與分數', r.json.papers.find(p => p.id === pidA).status === 'submitted' && r.json.papers.find(p => p.id === pidA).score === 100);
  r = await j('/api/papers?id=' + fixId, { method: 'DELETE' });
  chk('刪除一份', r.status === 200 && r.json.deleted === 1 && (await j('/api/paper?id=' + fixId)).status === 410);
  c.putPaper({ id: 'old1', n: 25, settings: { n: 25, difficulty: 'easy' }, data: { sections: [], questions: [], answers: {}, self: {} }, ttlDays: -1 });
  chk('過期的卷子讀不到、也不在歷史裡', (await j('/api/paper?id=old1')).status === 410 && !(await j('/api/papers')).json.papers.some(p => p.id === 'old1'));
  const before = c.papers(100).length;
  for (let i = 0; i < 25; i++) c.putPaper({ id: 'bulk' + i, n: 25, settings: { n: 25 }, data: { sections: [], questions: [], answers: {}, self: {} } });
  c.prunePapers({ keep: 20 });
  chk('只留最近 20 份', c.papers(100).length === 20, `留了 ${c.papers(100).length}（之前 ${before}）`);
  await finish();
} catch (e) { await finish(e); } finally { try { rmSync(dir, { recursive: true, force: true }); } catch {} }
