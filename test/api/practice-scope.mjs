// 句子練習的範圍：用文章表當單位，只從選到的文章表出題。假 CLI，不花額度。
// 跑法：node --no-warnings test/api/practice-scope.mjs
import { start, chk, section, finish } from './_harness.mjs';

try {
  const S = await start('practice-scope', { ANALYZE_GROUP: '1' });
  const j = S.j;
  const save = async (name, text) => {
    await S.sse('/api/analyze', { text, article: true });
    return (await j('/api/articles', { method: 'POST', body: { name, text } })).json.id;
  };
  const A = 'I get up at seven. I eat breakfast. Then I go to school.', B = 'Tom plays soccer. She reads a book. We watch TV.';
  const idA = await save('課文A', A), idB = await save('課文B', B);
  const hashesOf = async id => new Set((await j(`/api/article?id=${id}`)).json.paragraphs.flatMap(p => p.sentences.map(s => s.hash)));
  const hA = await hashesOf(idA), hB = await hashesOf(idB);
  const ask = body => j('/api/exercises', { method: 'POST', body: { count: 10, types: ['tense'], userToken: 't-scope', ...body } });

  section('範圍：只從選到的文章表出題');
  let r = await ask({ articleIds: [idA] });
  chk('選課文A：出題成功，回傳範圍名稱', r.status === 200 && r.json.questions.length > 0 && JSON.stringify(r.json.scope) === '["課文A"]', r.text.slice(0, 200));
  chk('題目全部來自課文A的句子', r.json.questions.every(q => hA.has(q.meta.hash)), JSON.stringify(r.json.questions.map(q => q.meta.hash)));
  chk('題庫只有課文A的句數（不超過 3）', r.json.pool > 0 && r.json.pool <= 3, `pool ${r.json.pool}`);
  r = await ask({ articleIds: [idB] });
  chk('選課文B：題目全部來自課文B', r.status === 200 && r.json.questions.length > 0 && r.json.questions.every(q => hB.has(q.meta.hash)), r.text.slice(0, 200));
  r = await ask({ articleIds: [idA, idB] });
  chk('複選A＋B：題目來自兩份的句子', r.status === 200 && r.json.questions.every(q => hA.has(q.meta.hash) || hB.has(q.meta.hash)) && r.json.scope.length === 2);

  section('沒選範圍 = 整個句子庫（和以前一樣）');
  r = await ask({});
  chk('不帶 articleIds：照常出題、沒有範圍名稱', r.status === 200 && r.json.questions.length > 0 && r.json.scope.length === 0);
  r = await ask({ articleIds: [] });
  chk('空陣列也是全部', r.status === 200 && r.json.scope.length === 0 && r.json.pool > 3);

  section('範圍裡沒有句子');
  r = await ask({ articleIds: [999999] });
  chk('文章表不存在 → 409，說明範圍裡沒有句子', r.status === 409 && r.json.error === 'no-sentences-in-scope', r.text);
  r = await ask({ articleIds: ['abc', null] });
  chk('亂填的 id 被忽略，當成沒選範圍', r.status === 200 && r.json.scope.length === 0);
  await finish();
} catch (e) { await finish(e); }
