// 測驗卷的模型出題流程（假 CLI，不花額度）：報價 → 確認 → 呼叫 → 驗證入庫 → 重用題庫 → 延伸題 → 省錢模式 → 失敗。
// 跑法：node --no-warnings test/api/papers-model.mjs
import { rmSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { start, chk, section, finish } from './_harness.mjs';
import { makeFixture, readPaper } from './_fixture.mjs';

const fx = makeFixture('peater-pm-');
const q = (sql, ...a) => { const d = new DatabaseSync(fx.dbFile, { readOnly: true }); const r = d.prepare(sql).all(...a); d.close(); return r; };
const SC = { setIds: [fx.setId], articleIds: [fx.artId] };
const bank = type => q('SELECT COUNT(*) n FROM questions WHERE type = ?', type)[0].n;

try {
  // ============ 主流程 ============
  const S = await start('pm-main', {}, { dbFile: fx.dbFile });
  const j = S.j;

  section('預覽與報價（不呼叫模型）');
  let r = await j('/api/paper-preview', { method: 'POST', body: { ...SC, n: 40 } });
  const v1 = r.json;
  chk('閱讀測驗現在可以出（能請模型出題）、核心三塊都在', r.status === 200 && v1.availability.find(a => a.id === 'read').ok && ['mc', 'read', 'cloze'].every(id => v1.plan.rows.some(x => x.id === id)), JSON.stringify(v1.plan?.rows?.map(x => x.id)));
  chk('報價：要呼叫模型、列出工作、有花費區間與預估秒數', v1.quote.calls >= 1 && v1.quote.tasks.some(t => t.kind === 'read') && v1.quote.estimate.low > 0 && v1.quote.estimate.high > v1.quote.estimate.low && v1.quote.estimate.seconds > 0, JSON.stringify(v1.quote));
  chk('報價上限包含冷快取暖機成本（≥ 0.2）', v1.quote.estimate.high >= 0.2);
  chk('預覽沒有呼叫模型', S.calls().length === 0);

  section('出卷要先確認');
  r = await j('/api/papers', { method: 'POST', body: { ...SC, n: 40, seed: v1.seed } });
  chk('沒確認 → 409 confirm-required，附報價，沒有呼叫模型', r.status === 409 && r.json.error === 'confirm-required' && r.json.quote.calls === v1.quote.calls && S.calls().length === 0, r.text.slice(0, 160));
  r = await j('/api/papers', { method: 'POST', body: { ...SC, n: 40, seed: v1.seed, confirm: true } });
  chk('確認後出卷成功、題數與預覽一致、滿分 100', r.status === 200 && r.json.paper.n === 40 && r.json.total === 100, r.text.slice(0, 200));
  const paper1 = r.json.paper, id1 = r.json.id;
  chk('模型呼叫次數與報價的工作數一致', S.calls().filter(c => c.kind === 'exam').length === v1.quote.calls, JSON.stringify(S.calls().map(c => c.task)));
  chk('每次呼叫都帶花費上限，且用的是出題模型（預設 sonnet）', S.calls().every(c => Number(c.cap) >= v1.quote.estimate.high && c.model === 'sonnet'), JSON.stringify(S.calls().map(c => [c.cap, c.model])));
  chk('回報模型花費與入庫題數', r.json.model.calls === v1.quote.calls && r.json.model.added > 0 && r.json.model.costUsd > 0, JSON.stringify(r.json.model));

  section('閱讀測驗與克漏字');
  const read = paper1.sections.find(s => s.id === 'read');
  chk('有閱讀測驗區：文章與題目都在', !!read && read.passages.length >= 1 && read.questions.length === read.n && read.passages.every(p => p.text.length > 50), JSON.stringify(read && [read.n, read.passages.length]));
  chk('閱讀題 4 個選項、沒有答案洩漏、綁定到某篇文章', read.questions.every(x => x.choices.length === 4 && !('answer' in x) && !('explain' in x) && read.passages.some(p => p.id === x.passageId)));
  const stored = readPaper(fx.dbFile, id1).data;
  chk('每題的答案是 4 個選項之一', stored.questions.filter(x => x.type === 'read').every(x => x.choices.some(c => c.value === x.answer[0])));
  chk('克漏字帶了模型寫的語意干擾項', stored.questions.some(x => x.skill === 'cloze-semantic'), JSON.stringify([...new Set(stored.questions.filter(x => x.type === 'cloze').map(x => x.skill))]));
  chk('題庫有閱讀題與克漏字干擾項', bank('read') >= 8 && bank('cloze-dist') >= 5, `read ${bank('read')} cloze ${bank('cloze-dist')}`);
  chk('模型題入庫後標記用過次數', q('SELECT SUM(used) u FROM questions WHERE type = ?', 'read')[0].u >= read.n);

  section('重用題庫（第二份不再花錢）');
  const calls0 = S.calls().length;
  r = await j('/api/paper-preview', { method: 'POST', body: { ...SC, n: 40 } });
  chk('報價：題庫夠了 → 不需要呼叫模型', r.json.quote.calls === 0 && r.json.quote.estimate.high === 0, JSON.stringify(r.json.quote));
  r = await j('/api/papers', { method: 'POST', body: { ...SC, n: 40 } });
  chk('不用確認就能出卷，而且沒有再呼叫模型', r.status === 200 && r.json.model === null && S.calls().length === calls0, r.text.slice(0, 160));
  chk('第二份的閱讀題優先用沒用過的（題目不完全相同）', (() => { const a = new Set(stored.questions.filter(x => x.type === 'read').map(x => x.prompt)); const b = readPaper(fx.dbFile, r.json.id).data.questions.filter(x => x.type === 'read').map(x => x.prompt); return b.length > 0 && b.some(p => !a.has(p)); })());

  section('費用紀錄與報價校正');
  const h = (await j('/api/history')).json;
  chk('出題的呼叫記進用量歷史（kind=paper-gen），費用被計入', h.items.some(i => i.kind === 'paper-gen') && h.usage.all.cost_usd > 0);
  chk('累積幾次紀錄後，報價單價改用歷史', (await j('/api/paper-preview', { method: 'POST', body: { ...SC, n: 40, difficulty: 'hard' } })).json.quote.estimate.unit === 'history');

  section('延伸題（中等、困難）：先免費，不夠才請模型');
  r = await j('/api/paper-preview', { method: 'POST', body: { ...SC, n: 40, difficulty: 'hard' } });
  const vh = r.json;
  chk('困難：預覽的報價有延伸題的工作', vh.quote.tasks.some(t => t.kind === 'ext') && vh.plan.ext.target === 24, JSON.stringify([vh.quote.tasks.map(t => t.kind), vh.plan.ext]));
  r = await j('/api/papers', { method: 'POST', body: { ...SC, n: 40, difficulty: 'hard', seed: vh.seed } });
  chk('困難沒確認 → 409', r.status === 409 && r.json.error === 'confirm-required');
  const callsBefore = S.calls().length;
  r = await j('/api/papers', { method: 'POST', body: { ...SC, n: 40, difficulty: 'hard', seed: vh.seed, confirm: true } });
  const hard = r.json.paper, hs = readPaper(fx.dbFile, r.json.id).data;
  chk('困難卷：延伸題來自模型（ext-model）與免費延伸（ext-free）', r.status === 200 && hs.questions.some(x => x.src === 'ext-model') && hs.questions.some(x => x.src === 'ext-free'), JSON.stringify(hs.questions.reduce((a, x) => (a[x.src] = (a[x.src] || 0) + 1, a), {})));
  chk('只多了一次延伸題的呼叫（全部合成一次）', S.calls().length - callsBefore === 1 && S.calls().at(-1).task === 'ext', JSON.stringify(S.calls().slice(callsBefore).map(c => c.task)));
  chk('延伸題總數接近目標（不超過），總題數與分數正確', hard.sections.reduce((a, s) => a + s.ext, 0) <= 24 && hard.sections.reduce((a, s) => a + s.ext, 0) >= 12 && hard.n === 40 && r.json.total === 100, JSON.stringify([hard.n, r.json.total, hard.sections.map(s => [s.id, s.n, s.ext]), JSON.stringify(hs.plan)]));
  chk('模型延伸題都有依據（anchors 在範圍內的單字）', hs.questions.filter(x => x.src === 'ext-model').every(x => x.meta.anchors?.length && fx.cache && true), '');
  const anchorsOk = hs.questions.filter(x => x.src === 'ext-model').every(x => x.meta.anchors.every(a => ['apple', 'teach', 'lend', 'cloudy', 'family', 'piano', 'homework', 'school', 'breakfast', 'weather'].includes(a.word)));
  chk('依據的單字確實是你的字表裡的字', anchorsOk);
  chk('延伸題沒有答案洩漏', hard.sections.flatMap(s => s.questions).filter(x => x.src !== 'scope').every(x => !('answer' in x) && !('explain' in x) && !('orders' in x)));
  chk('題庫有延伸題', bank('ext-mc') + bank('ext-reorder') + bank('ext-fix') + bank('ext-trans') + bank('read-ext') >= 5);
  const c2 = S.calls().length;
  r = await j('/api/papers', { method: 'POST', body: { ...SC, n: 40, difficulty: 'hard', confirm: true } });
  chk('第二份困難卷：題庫有延伸題可用，呼叫次數更少或不用', r.status === 200 && S.calls().length - c2 <= 1, `新增 ${S.calls().length - c2} 次`);

  section('交卷：模型題也計入統計與題庫的答錯次數');
  const wrongBefore = q('SELECT SUM(wrong) w FROM questions')[0].w ?? 0;
  const pid = hard.id;
  r = await j('/api/paper-submit', { method: 'POST', body: { id: pid, answers: {}, userToken: 'tm' } });
  chk('空白交卷：批改完成', r.status === 200 && r.json.paper.result.wrong > 0);
  chk('答錯的題庫題記一次答錯', (q('SELECT SUM(wrong) w FROM questions')[0].w ?? 0) > wrongBefore);

  // ============ 省錢模式 ============
  section('省錢模式（不呼叫模型）');
  const S2 = await start('pm-saver', {}, { dbFile: fx.dbFile });
  r = await S2.j('/api/paper-preview', { method: 'POST', body: { ...SC, n: 40, saver: true, difficulty: 'hard' } });
  chk('報價是 0、不需要呼叫模型', r.json.quote.calls === 0 && r.json.quote.estimate.high === 0, JSON.stringify(r.json.quote));
  chk('題庫有閱讀題，所以省錢模式也能出閱讀測驗', r.json.availability.find(a => a.id === 'read').ok);
  r = await S2.j('/api/papers', { method: 'POST', body: { ...SC, n: 40, saver: true, difficulty: 'hard' } });
  chk('直接出卷（不用確認），零次模型呼叫', r.status === 200 && r.json.model === null && S2.calls().length === 0, r.text.slice(0, 120));
  chk('省錢模式的延伸題只用免費延伸與題庫現成的', readPaper(fx.dbFile, r.json.id).data.questions.every(x => x.src !== 'ext-model' || x.meta.bankId));

  // ============ 驗證與只補缺的 ============
  section('模型寫壞了：驗證擋下、只補缺的');
  const fx2 = makeFixture('peater-pm2-');
  const S3 = await start('pm-bad', { FAKE_EXAM_BAD_FIRST: '1' }, { dbFile: fx2.dbFile });
  const SC2 = { setIds: [fx2.setId], articleIds: [fx2.artId] };
  r = await S3.j('/api/papers', { method: 'POST', body: { ...SC2, n: 30, confirm: true } });
  const readCalls = S3.calls().filter(c => c.task === 'read').length;
  chk('第一次回了不合格的題（選項不是 4 個、答案索引錯）→ 被擋下並回報', r.status === 200 && r.json.model.dropped >= 2, JSON.stringify(r.json.model));
  chk('只補缺的：閱讀任務呼叫了 2 次，不是整批重來', readCalls === 2, `read 呼叫 ${readCalls} 次`);
  const q3 = type => new DatabaseSync(fx2.dbFile, { readOnly: true }).prepare('SELECT COUNT(*) n FROM questions WHERE type = ?').get(type).n;
  chk('補完後題庫有 10 題合格的閱讀題', q3('read') === 10, `read ${q3('read')}`);
  const r4 = await S3.j('/api/papers', { method: 'POST', body: { ...SC2, n: 40, difficulty: 'hard', confirm: true } });
  chk('延伸題第一次有不合格的（依據字不在範圍內）→ 被擋、補缺的', r4.status === 200 && r4.json.model.dropped >= 1, JSON.stringify(r4.json.model));
  try { rmSync(fx2.dir, { recursive: true, force: true }); } catch {}

  // ============ 額度用盡 ============
  section('額度用盡：卷子照出，只是沒有模型題');
  const fx3 = makeFixture('peater-pm3-');
  const S4 = await start('pm-limit', { FAKE_FAIL_AFTER: '0' }, { dbFile: fx3.dbFile });
  r = await S4.j('/api/papers', { method: 'POST', body: { setIds: [fx3.setId], articleIds: [fx3.artId], n: 30, confirm: true } });
  chk('回報 rate-limit，已出的卷子照樣能用', r.status === 200 && r.json.model.error?.kind === 'rate-limit' && r.json.paper.n === 30 && r.json.total === 100, r.text.slice(0, 200));
  chk('沒有閱讀題，所以沒有閱讀測驗區（不亂湊）', r.json.paper.sections.every(s => s.id !== 'read'));
  chk('額度用盡後不再硬試（只呼叫一次就停）', S4.calls().filter(c => c.kind === 'exam').length === 1, JSON.stringify(S4.calls().map(c => c.task)));
  try { rmSync(fx3.dir, { recursive: true, force: true }); } catch {}

  // ============ 出題模型可以設定 ============
  section('出題模型用環境變數設定');
  const fx4 = makeFixture('peater-pm4-');
  const S5 = await start('pm-model', { EXAM_MODEL: 'opus' }, { dbFile: fx4.dbFile });
  await S5.j('/api/papers', { method: 'POST', body: { setIds: [fx4.setId], articleIds: [fx4.artId], n: 30, confirm: true } });
  chk('EXAM_MODEL=opus → 呼叫用 opus', S5.calls().length > 0 && S5.calls().every(c => c.model === 'opus'), JSON.stringify(S5.calls().map(c => c.model)));
  try { rmSync(fx4.dir, { recursive: true, force: true }); } catch {}
  await finish();
} catch (e) { await finish(e); } finally { try { rmSync(fx.dir, { recursive: true, force: true }); } catch {} }
