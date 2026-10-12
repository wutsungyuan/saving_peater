// 考卷對話題「?B:」黏在一起：分析、照片辨識、文章表都要把它拆成一句一句，不能出現「模型把這一句拆成了多句」。
// 這是使用者實際遇到的三句（考卷第 9、10、11 題）。假 CLI，不花額度。
// 跑法：node --no-warnings test/api/inline-speaker.mjs
import { start, chk, section, finish, evs } from './_harness.mjs';

const GLUED = [
  'Do you have time to play soccer with me?B: Sorry, I am not free now. I need to finish my piano lesson first.',
  'Hello, may I speak to Ms. Lin?B: Hold on, please. I will go get her.',
  "What are you looking for?B: My keys. I can't find them anywhere.",
].join('\n');
const EXPECT = [
  'Do you have time to play soccer with me?', 'Sorry, I am not free now.', 'I need to finish my piano lesson first.',
  'Hello, may I speak to Ms. Lin?', 'Hold on, please.', 'I will go get her.',
  'What are you looking for?', 'My keys.', "I can't find them anywhere.",
];

try {
  const S = await start('inline-speaker', { FAKE_OCR_TEXT: GLUED });

  section('直接貼上黏在一起的對話');
  let r = await S.j('/api/analyze', { method: 'POST', body: { text: GLUED, dryRun: true } });
  chk('報價：9 句（不是 3 個壞掉的單位）', r.json.total === 9, JSON.stringify(r.json).slice(0, 150));
  const a = await S.sse('/api/analyze', { text: GLUED });
  const sents = evs(a, 'sentence'), done = evs(a, 'done')[0];
  chk('9 句都分析成功、沒有失敗', sents.length === 9 && sents.every(s => s.sentence) && done.failed === 0, JSON.stringify({ n: sents.length, done }).slice(0, 200));
  // 分批並行，先完成的先送；事件帶 index，依 index 排回原順序再比
  const inOrder = [...sents].sort((x, y) => x.index - y.index).map(s => s.sentence.original);
  chk('每一句都是乾淨的一句：沒有 B: 殘留、依原順序和預期一樣', JSON.stringify(inOrder) === JSON.stringify(EXPECT), JSON.stringify(inOrder));

  section('照片辨識：模型把「?B:」黏著抄下來，伺服器拆成兩行再交給輸入框');
  const png = 'data:image/png;base64,' + Buffer.concat([Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]), Buffer.alloc(200)]).toString('base64');
  r = await S.j('/api/analyze-ocr', { method: 'POST', body: { image: png } });
  chk('辨識結果：每一行一句話、沒有 B:', r.status === 200 && !/B:/.test(r.json.text) && r.json.text.split('\n').length === 6 && r.json.text.split('\n')[0] === 'Do you have time to play soccer with me?', r.text.slice(0, 300));

  section('存成文章表：斷句和分析一致');
  r = await S.j('/api/articles', { method: 'POST', body: { name: '對話題', text: GLUED } });
  chk('文章表存成功：9 句全收、沒有「還沒分析」的（斷句和分析時一致，才對得上快取）', r.status === 200 && r.json.total === 9 && r.json.added === 9 && !r.json.error, r.text.slice(0, 200));
  await finish();
} catch (e) { await finish(e); }
