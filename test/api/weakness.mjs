// 弱點統計：單字測驗、句子練習、測驗卷三個來源的綜合與分開看。假 CLI，不花額度。
// 跑法：node --no-warnings test/api/weakness.mjs
import { rmSync } from 'node:fs';
import { start, chk, section, finish } from './_harness.mjs';
import { makeFixture, readPaper, perfectAnswers } from './_fixture.mjs';

const fx = makeFixture('peater-wk-');
const U = 'stu';
const words = fx.cache.wordsOf([fx.setId], U);
const [w1, w2] = words;
// 句子練習 4 題（對 2）、單字測驗 6 題（w1 錯 2 次 對 1 次、w2 對 3 次）
for (const ok of [true, true, false, false]) fx.cache.recordAttempt({ userToken: U, qtype: 'pattern', patternId: 3, correct: ok });
for (const ok of [false, false, true]) fx.cache.recordWordAttempt({ userToken: U, wordId: w1.id, mode: 'zh2en', correct: ok });
for (const ok of [true, true, true]) fx.cache.recordWordAttempt({ userToken: U, wordId: w2.id, mode: 'en2zh', correct: ok });
// 訂正不計
fx.cache.recordWordAttempt({ userToken: U, wordId: w1.id, mode: 'zh2en', correct: true, isFix: true });
fx.cache.db.close?.();

try {
  const S = await start('wk', {}, { dbFile: fx.dbFile });
  const j = S.j, get = src => j(`/api/weakness?user=${U}${src ? '&source=' + src : ''}`).then(r => r.json);

  section('來源與總覽');
  let w = await get();
  chk('全部：整體 = 句子 4 題 + 單字 6 題', w.overall.total === 10 && w.overall.correct === 6, JSON.stringify(w.overall));
  chk('三個來源各自的數字（不受篩選影響）', w.sources.practice.total === 4 && w.sources.quiz.total === 6 && w.sources.exam.total === 0, JSON.stringify(w.sources));
  chk('訂正的作答不算', w.words.total === 6);

  section('分開看');
  w = await get('practice');
  chk('句子練習：只有句子面向，單字面向是空的', w.overall.total === 4 && w.byPattern[0].total === 4 && w.words.total === 0 && w.words.byMode.length === 0, JSON.stringify(w.overall));
  chk('句子練習：不帶測驗卷成績', w.papers === null);
  w = await get('quiz');
  chk('單字測驗：只有單字面向', w.overall.total === 6 && w.byPattern.length === 0 && w.words.byMode.length === 2, JSON.stringify(w.words.byMode));
  chk('依模式的正確率（中考英 1/3、英考中 3/3）', (m => m.zh2en.correct === 1 && m.zh2en.total === 3 && m.en2zh.correct === 3)(Object.fromEntries(w.words.byMode.map(x => [x.mode, x]))));
  chk('最弱的字：w1 排第一（1/3），w2 滿分排後面', w.words.weakest[0].term === w1.term.toLowerCase() && w.words.weakest[0].total === 3 && w.words.weakest[0].correct === 1, JSON.stringify(w.words.weakest));
  chk('依字表統計', w.words.bySet.length === 1 && w.words.bySet[0].total === 6, JSON.stringify(w.words.bySet));
  chk('亂寫的來源 → 當成全部', (await get('zzz')).source === 'all');

  section('測驗卷');
  let r = await j('/api/papers', { method: 'POST', body: { setIds: [fx.setId], articleIds: [fx.artId], n: 25, difficulty: 'easy', saver: true, userToken: U } });
  const pid = r.json.id, full = readPaper(fx.dbFile, pid);
  r = await j('/api/paper-submit', { method: 'POST', body: { id: pid, answers: perfectAnswers(full.data), userToken: U } });
  chk('交卷成功', r.status === 200 && r.json.ok !== false, r.text?.slice(0, 120));
  w = await get('exam');
  chk('測驗卷：作答記為 exam 來源', w.sources.exam.total > 0 && w.overall.total === w.sources.exam.total, JSON.stringify(w.sources));
  chk('測驗卷：有近期成績與各題型得分率', w.papers.trend.length === 1 && w.papers.trend[0].score > 0 && w.papers.bySection.length >= 3, JSON.stringify(w.papers));
  chk('測驗卷的作答不混進句子練習／單字測驗', (await get('practice')).overall.total === 4 && (await get('quiz')).overall.total === 6);
  w = await get();
  chk('全部：三個來源加起來', w.overall.total === 10 + w.sources.exam.total, JSON.stringify(w.overall));
  await finish();
} catch (e) { await finish(e); } finally { try { rmSync(fx.dir, { recursive: true, force: true }); } catch {} }
