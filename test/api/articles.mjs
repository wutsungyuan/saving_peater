// 文章表 API 測試：分析 → 存成文章表 → 附加、去重、單字覆蓋、改名、刪除。用假的 Claude CLI，不花額度。
// 跑法：node --no-warnings test/api/articles.mjs
import { start, chk, section, finish, evs, fresh } from './_harness.mjs';

const TOKEN = 'sekret';
try {
  const S = await start('articles', { AUTH_TOKEN: TOKEN });
  const j = S.j;

  section('驗證');
  for (const [m, p, b] of [['GET', '/api/articles'], ['POST', '/api/articles', { name: 'x', text: 'Hi.' }], ['DELETE', '/api/articles?ids=1'],
                           ['GET', '/api/article?id=1'], ['POST', '/api/article-rename', { id: 1, name: 'y' }]]) {
    const r = await j(p, { method: m, body: b, token: '' });
    chk(`${m} ${p.split('?')[0]} 沒帶 token → 401`, r.status === 401, `status ${r.status}`);
  }

  section('分析 → 存成文章表');
  const text = 'My day.\n\nI get up at seven. I eat breakfast.\n\nThen I go to school. School is fun.';
  let r = await j('/api/articles', { method: 'POST', body: { name: '課文A', text } });
  chk('還沒分析就存 → 409，列出沒分析的句子', r.status === 409 && r.json.error === 'not-analyzed' && r.json.missing.length === 5, r.text);
  const a = await S.sse('/api/analyze', { text, article: true });
  chk('文章模式分析（5 句，含空白行分段）', evs(a, 'meta')[0].total === 5 && evs(a, 'done')[0].analyzed === 5 && evs(a, 'done')[0].failed === 0, JSON.stringify(a.events.map(e => e.event)));
  r = await j('/api/articles', { method: 'POST', body: { name: '課文A', text } });
  chk('存成文章表：5 句、新建立', r.status === 200 && r.json.added === 5 && r.json.appended === false && r.json.id > 0, r.text);
  const id = r.json.id;
  r = await j('/api/articles');
  chk('列表：句數 5、段落 3', r.json.articles.length === 1 && r.json.articles[0].sentences === 5 && r.json.articles[0].paragraphs === 3, r.text);

  section('檢視');
  r = await j(`/api/article?id=${id}`);
  const v = r.json;
  chk('依段落分組、順序正確', v.paragraphs.length === 3 && v.paragraphs[1].sentences.map(s => s.original).join(' ') === 'I get up at seven. I eat breakfast.', JSON.stringify(v.paragraphs.map(p => p.sentences.length)));
  chk('每句帶分析結果與翻譯', v.paragraphs.flatMap(p => p.sentences).every(s => s.sentence?.clauses?.length && s.translation), r.text.slice(0, 200));
  r = await j('/api/article?id=999999');
  chk('找不到的文章表 → 404', r.status === 404);

  section('附加與去重');
  const more = 'Tonight I read a book. School is fun.';
  r = await j('/api/articles', { method: 'POST', body: { name: '課文A', text: more } });
  chk('附加（同名）還沒分析 → 409，只列新的那句', r.status === 409 && r.json.missing.length === 1, r.text);
  await S.sse('/api/analyze', { text: more, article: true });
  r = await j('/api/articles', { method: 'POST', body: { name: '課文a', text: more } });
  chk('同名（不分大小寫）接在後面，重複的句子略過', r.status === 200 && r.json.appended === true && r.json.id === id && r.json.added === 1 && r.json.skipped === 1, r.text);
  r = await j(`/api/article?id=${id}`);
  chk('附加的句子是新的一段，接在最後', r.json.sentences === 6 && r.json.paragraphs.at(-1).sentences[0].original === 'Tonight I read a book.', JSON.stringify(r.json.paragraphs.map(p => p.sentences.length)));
  r = await j('/api/articles', { method: 'POST', body: { appendTo: 999999, name: 'x', text: more } });
  chk('附加到不存在的文章表 → 4xx/5xx 不當掉', r.status >= 400, `status ${r.status}`);
  r = await j('/api/articles', { method: 'POST', body: { text: more } });
  chk('沒有名稱也不是附加 → 400', r.status === 400 && r.json.error === 'no-name', r.text);
  r = await j('/api/articles', { method: 'POST', body: { name: 'x', text: '   ' } });
  chk('空白內容 → 400', r.status === 400 && r.json.error === 'empty', r.text);

  section('單字覆蓋標示');
  const ws = await j('/api/wordsets', { method: 'POST', body: { name: '字表', text: 'breakfast, 早餐\nschool, 學校\nzebra, 斑馬' } });
  r = await j(`/api/article?id=${id}&sets=${ws.json.id}`);
  chk('標出含單字的句子', r.json.paragraphs[1].sentences[1].words.includes('breakfast') && r.json.paragraphs[2].sentences[0].words.includes('school'), JSON.stringify(r.json.paragraphs.map(p => p.sentences.map(s => s.words))));
  chk('覆蓋統計：3 個字裡出現 2 個', r.json.coverage.words === 3 && r.json.coverage.hit === 2, JSON.stringify(r.json.coverage));

  section('對話');
  const dlg = 'A: How are you?\nB: I am fine.';
  const d1 = await S.sse('/api/analyze', { text: dlg, article: true });
  r = await j('/api/articles', { method: 'POST', body: { name: '對話', text: dlg } });
  chk('對話拆掉說話者標記後存成文章表（2 句）', evs(d1, 'done')[0].analyzed === 2 && r.status === 200 && r.json.added === 2, r.text);

  // 一個人說了好幾句：每句各自分析、各自存快取，不能只剩第一句（以前會變成文章表是空的）
  const dlg2 = 'Jamie: Great. And here is a picture of me.\nZac: Wow! You have a snowboard?';
  const q2 = await j('/api/analyze', { method: 'POST', body: { text: dlg2, article: true, dryRun: true } });
  chk('報價：2 個人說的話拆成 4 句', q2.json.total === 4, q2.text);
  const d2 = await S.sse('/api/analyze', { text: dlg2, article: true });
  chk('4 句都分析完成、沒有失敗', evs(d2, 'done')[0].analyzed === 4 && !evs(d2, 'done')[0].failed, JSON.stringify(evs(d2, 'done')[0]));
  r = await j('/api/articles', { method: 'POST', body: { name: '多句對話', text: dlg2 } });
  chk('存成文章表：4 句、不再是空的', r.status === 200 && r.json.added === 4, r.text);
  const meta2 = evs(d2, 'meta')[0];
  chk('分析事件告訴前端每句是誰說的、第幾次發言', JSON.stringify(meta2.dialogue.map(x => [x.speaker, x.turn])) === JSON.stringify([['Jamie', 0], ['Jamie', 0], ['Zac', 1], ['Zac', 1]]), JSON.stringify(meta2.dialogue));
  const av = (await j('/api/article?id=' + r.json.id)).json;
  chk('文章表：一個人說的話放在同一段、標出是誰說的', av.paragraphs.length === 2 && av.paragraphs[0].sentences.length === 2 && av.paragraphs[0].speaker === 'Jamie' && av.paragraphs[1].speaker === 'Zac', JSON.stringify(av.paragraphs.map(p => [p.speaker, p.sentences.length])));

  section('改名與刪除');
  r = await j('/api/article-rename', { method: 'POST', body: { id, name: '第一課' } });
  chk('改名', r.status === 200 && (await j('/api/articles')).json.articles.some(x => x.name === '第一課'));
  r = await j('/api/article-rename', { method: 'POST', body: { id, name: '  ' } });
  chk('改成空白名稱 → 400', r.status === 400);
  r = await j('/api/article-rename', { method: 'POST', body: { id: 999999, name: 'x' } });
  chk('改不存在的 → 404', r.status === 404);
  r = await j(`/api/articles?ids=${id}`, { method: 'DELETE' });
  chk('刪除 → 刪掉 1 份', r.status === 200 && r.json.deleted === 1, r.text);
  chk('刪除後看不到、也取不到', (await j('/api/articles')).json.articles.every(x => x.id !== id) && (await j(`/api/article?id=${id}`)).status === 404);
  chk('刪文章表不會刪掉句子的分析（還在快取）', (await j('/api/analyze', { method: 'POST', body: { text: 'I get up at seven.', dryRun: true } })).json.cached === 1);
  await finish();
} catch (e) { await finish(e); }
