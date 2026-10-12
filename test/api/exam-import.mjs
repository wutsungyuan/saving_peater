// 考卷重現：老師上傳考卷照片 → 草稿 → 核對、改題 → 發佈 → 學生作答計分。假 CLI，不花額度。
// 跑法：node --no-warnings test/api/exam-import.mjs
import { start, J, chk, section, finish } from './_harness.mjs';

const T = { user: 'teacher1', pass: 'teacher pass 123' }, K = { user: 'kid1', pass: 'kid pass 456' };
const cookieFrom = r => (r.headers.get('set-cookie') || '').split(';')[0];
const withCookie = c => ({ headers: { cookie: c } });
const png = 'data:image/png;base64,' + Buffer.concat([Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]), Buffer.alloc(200)]).toString('base64');
const today = (() => { const d = new Date(), p = n => String(n).padStart(2, '0'); return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`; })();

try {
  const S = await start('examimp', { AUTH_USER: T.user, AUTH_PASS: T.pass, STUDENT_USER: K.user, STUDENT_PASS: K.pass });
  const B = S.base;
  const tk = cookieFrom(await J(B, '/api/login', { method: 'POST', body: T })), sk = cookieFrom(await J(B, '/api/login', { method: 'POST', body: K }));
  const t = (p, o = {}) => J(B, p, { ...withCookie(tk), ...o }), s = (p, o = {}) => J(B, p, { ...withCookie(sk), ...o });
  const imp = (body, who = t) => who('/api/exam-import', { method: 'POST', body });
  const edit = (body, who = t) => who('/api/paper-edit', { method: 'POST', body });

  section('只有老師能匯入；壞的輸入');
  chk('學生 → 403', (await imp({ images: [png] }, s)).status === 403);
  chk('沒登入 → 401', (await J(B, '/api/exam-import', { method: 'POST', body: { images: [png] } })).status === 401);
  chk('沒有照片 → 400', (await imp({ images: [] })).status === 400);
  chk('不是圖片 → 400', (await imp({ images: ['data:text/plain;base64,aGVsbG8='] })).status === 400);
  chk('壞輸入沒有呼叫模型', S.calls().length === 0);

  section('匯入：沒填名稱 → 日期＋考卷重現');
  let r = await imp({ images: [png] });
  const id = r.json.id;
  chk('成功：4 題裡收進 3 題、略過 1 題（沒有空格）', r.status === 200 && r.json.n === 3 && r.json.skipped.length === 1 && r.json.skipped[0].no === 99, r.text.slice(0, 200));
  chk('預設名稱：' + today + ' 考卷重現', r.json.title === `${today} 考卷重現`, r.json.title);
  chk('只呼叫一次模型', S.calls().filter(c => c.kind === 'exam-import').length === 1);
  chk('回傳完整句子給「帶到分析頁」：去掉 A: B: 與中文註解，含雙空格填好的第 18 題',
    r.json.sentences.includes('Oh no, I forgot my gloves. Can you lend me one? My hands are so cold.') && r.json.sentences.includes('I won the lottery yesterday!\nReally? Or are you pulling my leg?') && r.json.sentences.includes('In winter,'), r.json.sentences);
  r = await imp({ images: [png] });
  chk('同一天再匯入一份 → 名稱加（2）', r.json.title === `${today} 考卷重現（2）`, r.json.title);
  r = await imp({ images: [png], title: '  期中考 第二回  ' });
  chk('自己取名：用自己的（前後空白去掉）', r.json.title === '期中考 第二回', r.json.title);
  chk('填空白名稱視同沒填', (await imp({ images: [png], title: '   ' })).json.title === `${today} 考卷重現（3）`);

  section('草稿：學生看不到，老師看得到答案');
  chk('學生的歷史看不到', !(await s('/api/papers')).json.papers.some(p => p.id === id));
  chk('學生直接取 → 410', (await s('/api/paper?id=' + id)).status === 410);
  const hist = (await t('/api/papers')).json.papers.find(p => p.id === id);
  chk('老師的歷史：草稿、標題、「考卷重現」標籤、3 題', hist.status === 'draft' && hist.title === `${today} 考卷重現` && hist.difficultyName === '考卷重現' && hist.n === 3, JSON.stringify(hist));
  r = await t('/api/paper?id=' + id + '&admin=1');
  const qs = r.json.sections.flatMap(x => x.questions);
  chk('老師版：題型 exam、含答案、原卷題號', r.status === 200 && qs.length === 3 && qs.every(q => q.type === 'exam' && q.answer.length === 1) && qs.map(q => q.meta.examNo).join() === '1,18,5', r.text.slice(0, 150));
  const q18 = qs[1];
  chk('第 18 題：題幹照原樣（兩個空格）、四個成對選項、答案 gloves; lend', q18.question === 'Oh no, I forgot my ______. Can you ______ me one? My hands are so cold.' && q18.choices.map(c => c.label).join('|') === 'jacket; borrow|gloves; lend|camera; send|violin; teach' && q18.answer[0] === 'gloves; lend', JSON.stringify(q18).slice(0, 200));
  chk('分數：3 題合計 100', Math.abs(qs.reduce((a, q) => a + q.pts, 0) - 100) < 1e-9 && r.json.title === `${today} 考卷重現`, String(qs.map(q => q.pts)));

  section('老師核對：改題、改答案');
  r = await edit({ id, action: 'edit-q', questionId: 'q1', question: 'In ______, the weather is usually very cold.', options: ['spring', 'summer', 'autumn', 'winter', 'rainy season'], answerIndex: 3 });
  const e1 = r.json.paper.sections[0].questions[0];
  chk('改題幹與選項（增加到 5 個）、答案維持 winter', r.status === 200 && e1.question.includes('very cold') && e1.choices.length === 5 && e1.answer[0] === 'winter' && e1.explain === '完整句子：In winter, the weather is usually very cold.', r.text.slice(0, 200));
  r = await edit({ id, action: 'edit-q', questionId: 'q3', question: 'Or are you ______?', options: ['making up my mind', 'signing up', 'missing out', 'pulling my leg'], answerIndex: 2 });
  chk('改答案：選 C → 解說跟著換成新的完整句子', r.status === 200 && r.json.paper.sections[0].questions[2].answer[0] === 'missing out' && r.json.paper.sections[0].questions[2].explain === '完整句子：Or are you missing out?', r.text.slice(0, 150));
  chk('題幹沒有空格 → 409', (await edit({ id, action: 'edit-q', questionId: 'q1', question: 'No blank.', options: ['a', 'b'], answerIndex: 0 })).status === 409);
  chk('只有一個選項 → 409', (await edit({ id, action: 'edit-q', questionId: 'q1', question: 'A ______ b.', options: ['a'], answerIndex: 0 })).status === 409);
  chk('學生不能改 → 403', (await edit({ id, action: 'edit-q', questionId: 'q1', question: 'A ______ b.', options: ['a', 'b'], answerIndex: 0 }, s)).status === 403);
  r = await edit({ id, action: 'remove', questionId: 'q2' });
  chk('題數不多於 5 題時不能再刪（考卷重現最少 5 題）', r.status === 409 && /至少要留 5 題/.test(r.json.message), r.text);
  r = await edit({ id, action: 'rename', title: '第三次段考' });
  chk('改名', r.status === 200 && r.json.paper.title === '第三次段考');

  section('發佈後：學生看得到題目、看不到答案');
  chk('發佈', (await edit({ id, action: 'publish' })).status === 200);
  chk('已發佈：不能編輯題目 → 409', (await edit({ id, action: 'edit-q', questionId: 'q1', question: 'A ______ b.', options: ['a', 'b'], answerIndex: 0 })).status === 409);
  const lst = (await s('/api/papers')).json.papers.find(p => p.id === id);
  chk('學生的歷史看得到、有名稱', lst && lst.title === '第三次段考' && lst.difficultyName === '考卷重現', JSON.stringify(lst));
  r = await s('/api/paper?id=' + id);
  const sq = r.json.sections[0].questions;
  chk('學生版：沒有答案與解說、選項照原樣', r.status === 200 && sq.length === 3 && sq.every(q => !('answer' in q) && !('explain' in q) && !('meta' in q)) && sq[1].choices.length === 4, r.text.slice(0, 200));
  chk('學生版題幹保留 ______', sq[1].question.includes('______ me one'));

  section('作答計分');
  await s('/api/paper-save', { method: 'POST', body: { id, answers: { q1: ['winter'] } } });
  r = await s('/api/paper-submit', { method: 'POST', body: { id, answers: { q1: ['winter'], q2: ['jacket; borrow'], q3: ['missing out'] } } });
  const res = r.json.paper.result;
  chk('交卷：答對 2、答錯 1；分數 = 兩題的分數', r.status === 200 && res.right === 2 && res.wrong === 1 && Math.abs(res.score - (qs[0].pts + qs[2].pts)) < 1e-9, JSON.stringify({ right: res.right, wrong: res.wrong, score: res.score }));
  const wrong = res.items.find(i => i.id === 'q2');
  chk('答錯的題：顯示正確答案與完整句子解說', wrong.correct === false && wrong.expected[0] === 'gloves; lend' && wrong.explain.includes('gloves'), JSON.stringify(wrong).slice(0, 200));
  r = await s('/api/paper-redo', { method: 'POST', body: { id } });
  chk('訂正：只出答錯的那一題', r.status === 200 && r.json.paper.n === 1, r.text.slice(0, 100));
  const w = (await s('/api/weakness?source=exam')).json;
  chk('弱點：以「考卷重現」題型記下作答', JSON.stringify(w).includes('paper-exam'), JSON.stringify(w).slice(0, 200));

  section('照片裡沒有題目');
  const S2 = await start('examimp2', { AUTH_USER: T.user, AUTH_PASS: T.pass, FAKE_EXAM_JSON: JSON.stringify({ questions: [] }) });
  const t2k = cookieFrom(await J(S2.base, '/api/login', { method: 'POST', body: T }));
  r = await J(S2.base, '/api/exam-import', { method: 'POST', body: { images: [png] }, ...withCookie(t2k) });
  chk('沒找到選擇題 → 422，說明原因，不會留下空的草稿', r.status === 422 && r.json.error === 'no-questions' && /沒有找到/.test(r.json.message), r.text);
  chk('沒有留下草稿', (await J(S2.base, '/api/papers', withCookie(t2k))).json.papers.length === 0);
  await finish();
} catch (e) { await finish(e); }
