// 對話課文的出題：說話者標在文章裡（閱讀測驗）、新題型「情境應答」（選出最適當的回應）。假 CLI，不花額度。
// 跑法：node --no-warnings test/api/papers-dialogue.mjs
import { rmSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { start, chk, section, finish } from './_harness.mjs';
import { makeFixture, DIALOGUE, addDialogue } from './_fixture.mjs';

const fx = makeFixture('peater-pd-');
const dlgId = addDialogue(fx.cache);
fx.cache.db.close?.();
const q = (sql, ...a) => { const d = new DatabaseSync(fx.dbFile, { readOnly: true }); const r = d.prepare(sql).all(...a); d.close(); return r; };
const SC = { setIds: [fx.setId], articleIds: [dlgId], mode: 'custom', types: ['mc', 'read', 'reply'], n: 30 };
const REPLIES = DIALOGUE.filter((_, i) => i % 2 === 1).map(x => x[1]);

try {
  const S = await start('pd', {}, { dbFile: fx.dbFile });
  const j = S.j;

  section('有對話課文才能出情境應答');
  let r = await j('/api/paper-preview', { method: 'POST', body: SC });
  const pv = r.json, av = pv.availability?.find(a => a.id === 'reply');
  chk('情境應答可選、標示需要模型、供給 = 5 組問答', r.status === 200 && av?.ok && av.model && av.supply === 5, JSON.stringify(av));
  chk('配題含情境應答，報價有 reply 工作', pv.plan.rows.some(x => x.id === 'reply') && pv.quote.tasks.some(t => t.kind === 'reply'), JSON.stringify([pv.plan.rows.map(x => x.id), pv.quote.tasks]));
  r = await j('/api/paper-preview', { method: 'POST', body: { setIds: [fx.setId], articleIds: [fx.artId], mode: 'custom', types: ['mc', 'reply', 'read'], n: 30 } });
  const av2 = r.json.availability.find(a => a.id === 'reply');
  chk('只選一般文章（沒有對話）→ 情境應答灰掉並說明', av2.ok === false && /對話課文/.test(av2.reason), JSON.stringify(av2));

  section('出卷：先確認，再請模型寫干擾項');
  r = await j('/api/papers', { method: 'POST', body: { ...SC, seed: pv.seed } });
  chk('沒確認 → 409', r.status === 409 && r.json.error === 'confirm-required');
  r = await j('/api/papers', { method: 'POST', body: { ...SC, seed: pv.seed, confirm: true } });
  chk('確認後出卷成功、30 題、100 分', r.status === 200 && r.json.paper.n === 30 && r.json.total === 100, r.text.slice(0, 200));
  const paper = r.json.paper, id1 = r.json.id;
  const rs = paper.sections.find(s => s.id === 'reply');
  chk('有「情境應答」區，題數與配題相同', !!rs && rs.n === pv.plan.rows.find(x => x.id === 'reply').n && rs.questions.length === rs.n, JSON.stringify(rs && rs.n));
  const stored = JSON.parse(q('SELECT data FROM papers WHERE id = ?', id1)[0].data);
  const rq = stored.questions.filter(x => x.type === 'reply');
  chk('每題：上一個人說的話當題目、4 個選項、正確答案是課文裡真正的回答', rq.length >= 3 && rq.every(x => x.choices.length === 4 && REPLIES.includes(x.answer[0]) && x.choices.some(c => c.value === x.answer[0]) && /^Jamie: /.test(x.question)), JSON.stringify(rq[0]));
  chk('題目寫明是誰會怎麼回應', rq.every(x => /^Zac 會怎麼回應/.test(x.prompt)));
  chk('干擾項不重複、不等於答案、不帶說話者標記', rq.every(x => new Set(x.choices.map(c => c.value.toLowerCase())).size === 4 && x.choices.every(c => !/^[A-Z][a-z]+:/.test(c.value))));
  chk('送給學生的版本沒有答案與解析', rs.questions.every(x => !('answer' in x) && !('explain' in x)));
  chk('每題的問答配對正確（題目的下一句就是答案）', rq.every(x => { const i = DIALOGUE.findIndex(d => `${d[0]}: ${d[1]}` === x.question); return i >= 0 && DIALOGUE[i + 1][1] === x.answer[0]; }));
  chk('題庫存了情境應答（5 組）', q("SELECT COUNT(*) n FROM questions WHERE type = 'reply'")[0].n === 5);

  section('閱讀測驗的文章標出說話者');
  const rd = paper.sections.find(s => s.id === 'read');
  const pass = rd?.passages?.[0]?.text ?? '';
  chk('對話課文當閱讀文章：每次發言一行、前面有說話者', /Jamie: How was the weather there\?/.test(pass) && /\nZac: It was hot/.test(pass), JSON.stringify(pass.slice(0, 160)));

  section('重用題庫、答對答錯計入統計');
  const calls = S.calls().length;
  r = await j('/api/papers', { method: 'POST', body: { ...SC } });
  chk('第二份：題庫夠了，不用確認也不再呼叫模型', r.status === 200 && S.calls().length === calls, r.text.slice(0, 120));
  const given = {}; rq.forEach(x => { given[x.id] = [x.answer[0]]; });
  r = await j('/api/paper-submit', { method: 'POST', body: { id: id1, answers: given, userToken: 'td' } });
  const items = r.json.paper.result.items.filter(i => i.type === 'reply');
  chk('答對的情境應答計分', items.length === rq.length && items.every(i => i.correct === true && i.earned > 0), JSON.stringify(items[0]));

  section('省錢模式：題庫有才出');
  const S2 = await start('pd-saver', {}, { dbFile: fx.dbFile });
  r = await S2.j('/api/paper-preview', { method: 'POST', body: { ...SC, saver: true } });
  chk('省錢模式用題庫現成的（5 組），不呼叫模型', r.json.availability.find(a => a.id === 'reply').ok && r.json.quote.calls === 0 && S2.calls().length === 0, JSON.stringify(r.json.quote));

  section('模型寫壞了：驗證擋下、只補缺的');
  const fx2 = makeFixture('peater-pd2-'); const dlg2 = addDialogue(fx2.cache); fx2.cache.db.close?.();
  const S3 = await start('pd-bad', { FAKE_EXAM_BAD_FIRST: '1' }, { dbFile: fx2.dbFile });
  r = await S3.j('/api/papers', { method: 'POST', body: { setIds: [fx2.setId], articleIds: [dlg2], mode: 'custom', types: ['mc', 'reply', 'read'], n: 30, confirm: true } });
  const replyCalls = S3.calls().filter(c => c.task === 'reply').length;
  chk('第一次有一組干擾項不合格（沒大寫開頭）→ 被擋下並回報', r.status === 200 && r.json.model.dropped >= 1, JSON.stringify(r.json.model));
  chk('只補缺的：情境應答任務呼叫 2 次，不是整批重來', replyCalls === 2, `呼叫 ${replyCalls} 次`);
  chk('補完後題庫有 5 組', new DatabaseSync(fx2.dbFile, { readOnly: true }).prepare("SELECT COUNT(*) n FROM questions WHERE type = 'reply'").get().n === 5);
  try { rmSync(fx2.dir, { recursive: true, force: true }); } catch {}
  await finish();
} catch (e) { await finish(e); } finally { try { rmSync(fx.dir, { recursive: true, force: true }); } catch {} }
