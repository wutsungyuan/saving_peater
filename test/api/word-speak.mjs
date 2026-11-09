// 口說：出題、批改、獨立記錄（不影響熟練度與會拼／認得的統計）、會唸統計、刪字表連動。假 CLI，不花額度。
// 跑法：node --no-warnings test/api/word-speak.mjs
import { rmSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { start, chk, section, finish } from './_harness.mjs';
import { makeFixture } from './_fixture.mjs';

const fx = makeFixture('peater-spk-');
const U = 'kid';

// 連動：合併帳號、刪單字、刪字表時，口說紀錄要跟著走（用另一份資料庫，直接呼叫資料層）
{
  const g = makeFixture('peater-spk2-');
  const [w1, w2] = g.cache.wordsOf([g.setId], 'x');
  for (const t of ['a', 'b']) g.cache.recordSpeakAttempt({ userToken: t, wordId: w1.id, correct: true, heard: 'x', expected: 'x' });
  g.cache.recordSpeakAttempt({ userToken: 'a', wordId: w2.id, correct: false, heard: 'y', expected: 'x' });
  const n = () => Number(g.cache.db.prepare('SELECT COUNT(*) n FROM speak_attempts').get().n);
  g.cache.mergeUsers('a', ['b']);
  chk('合併帳號：b 的口說紀錄改成 a', g.cache.db.prepare("SELECT COUNT(*) n FROM speak_attempts WHERE user_token = 'a'").get().n === 3);
  g.cache.removeWords(g.setId, [w2.id]);
  chk('刪單字：該字的口說紀錄跟著刪', n() === 2);
  g.cache.deleteWordset(g.setId);
  chk('刪字表：口說紀錄跟著刪', n() === 0);
  g.cache.db.close?.(); try { rmSync(g.dir, { recursive: true, force: true }); } catch {}
}
fx.cache.db.close?.();

try {
  const S = await start('spk', {}, { dbFile: fx.dbFile });
  const j = S.j;
  const quiz = async (modes, count = 3) => (await j('/api/wordquiz', { method: 'POST', body: { setIds: [fx.setId], userToken: U, count, modes } })).json;

  section('出題');
  const q = await quiz(['speak']);
  chk('只選口說：每題都是口說題，帶單字本身、不帶答案欄位', q.questions.length === 3 && q.questions.every(x => x.mode === 'speak' && x.inputMode === 'speak' && x.question && x.speak && !x.answer), JSON.stringify(q.questions[0]));
  const d0 = await quiz(undefined, 10);
  chk('沒指定題型時不會出口說', d0.questions.every(x => x.mode !== 'speak'));

  section('批改與記錄');
  const [a, b, c] = q.questions;
  const r = (await j('/api/wordattempts', { method: 'POST', body: { quizId: q.quizId, userToken: U,
    answers: { [a.id]: ['wrong', a.question], [b.id]: ['zzzzz'], [c.id]: [] } } })).json;
  const by = Object.fromEntries(r.results.map(x => [x.id, x]));
  chk('第一題多次嘗試其中一次唸對：對', by[a.id].correct && !by[a.id].skipped);
  chk('第二題唸錯：錯，不是跳過', !by[b.id].correct && !by[b.id].skipped && by[b.id].given.join() === 'zzzzz');
  chk('第三題沒唸：跳過', by[c.id].skipped);
  chk('跳過的不算在總題數：1／2', r.correct === 1 && r.total === 2, `${r.correct}/${r.total}`);

  const db = new DatabaseSync(S.dbFile);
  const sp = db.prepare('SELECT * FROM speak_attempts ORDER BY id').all();
  chk('口說記兩筆（跳過的不記）', sp.length === 2 && sp[0].correct === 1 && sp[1].correct === 0 && sp[0].user_token === U, JSON.stringify(sp));
  chk('辨識到的候選都記下來', sp[0].heard === `wrong | ${a.question}` && sp[0].expected === a.question, JSON.stringify(sp[0]));
  chk('不進 word_attempts、不動熟練度', db.prepare('SELECT COUNT(*) n FROM word_attempts').get().n === 0 && db.prepare('SELECT COUNT(*) n FROM word_progress').get().n === 0);

  section('統計');
  const w = (await j(`/api/weakness?user=${U}`)).json;
  chk('會拼／認得不受影響（沒有單字作答）', w.words.total === 0 && w.overall.total === 0, JSON.stringify(w.overall));
  const bs = w.words.bySet.find(x => x.set_id === fx.setId);
  chk('各字表有會唸：累積 1/2、近 100 次 1/2', bs && bs.speak_total === 2 && bs.speak_correct === 1 && bs.speak_recent_total === 2 && bs.speak_recent_correct === 1 && bs.spell_total === 0, JSON.stringify(bs));
  chk('另一個學生看不到', ((await j('/api/weakness?user=other')).json.words.bySet.find(x => x.set_id === fx.setId)?.speak_total ?? 0) === 0);

  section('訂正不記錄');
  const f = (await j('/api/wordquiz', { method: 'POST', body: { userToken: U, redoFrom: q.quizId, redoIds: [b.id] } })).json;
  const fr = (await j('/api/wordattempts', { method: 'POST', body: { quizId: f.quizId, userToken: U, answers: { [f.questions[0].id]: [f.questions[0].question] } } })).json;
  chk('訂正：批改為對', fr.isFix && fr.results[0].correct, JSON.stringify(fr));
  chk('訂正：不新增口說紀錄', db.prepare('SELECT COUNT(*) n FROM speak_attempts').get().n === 2);
  db.close();
  await finish();
} catch (e) { await finish(e); } finally { try { rmSync(fx.dir, { recursive: true, force: true }); } catch {} }
