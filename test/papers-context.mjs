// 對話課文的句子單獨出成翻譯題時，題目要附上「對方說的話」，代名詞（it、they）才有指涉對象。
// 一般文章的句子沒有前後文，不加。跑法：node --no-warnings test/papers-context.mjs
import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';
import { makeFixture, addDialogue } from './api/_fixture.mjs';
import { buildPool } from '../src/papers/pool.mjs';
import { generateType, publicQuestion } from '../src/papers/gen.mjs';
import { seededRng } from '../src/papers/plan.mjs';

let fail = 0;
const chk = (name, ok, detail = '') => { console.log(`${ok ? '  ✓' : '  ✗'} ${name}${ok ? '' : '  ' + detail}`); if (!ok) fail++; };
const fx = makeFixture('peater-ctx-');
try {
  const dlgId = addDialogue(fx.cache);
  const trans = ids => generateType('trans', 50, buildPool(fx.cache, { articleIds: ids }), seededRng(3)).questions;

  const dq = trans([dlgId]);
  const reply = dq.find(q => /^Yes, I got it last week\.$/.test(q.answer[0]));
  chk('對話的回答句有出翻譯題', !!reply, dq.map(q => q.answer[0]).join(' | '));
  chk('附上對方（Jamie）上一次說的話', reply?.context?.speaker === 'Jamie' && /postcard from Australia/.test(reply.context.text), JSON.stringify(reply?.context));
  chk('送給學生的版本也帶 context，但沒有答案', (() => { const p = publicQuestion(reply); return p.context && !p.answer; })());
  const first = dq.find(q => q.answer[0] === 'How was the weather there?');
  chk('第一句沒有上一句，不附 context', first && !first.context, JSON.stringify(first?.context));

  const gq = trans([fx.artId]);
  chk('一般文章的翻譯題不附 context', gq.length > 0 && gq.every(q => !q.context));
  console.log(fail ? `\n有失敗 (${fail})` : '\n全部通過');
} finally {
  try { fx.cache.close?.(); } catch {}
  try { rmSync(fx.dir, { recursive: true, force: true }); } catch {}
}
process.exit(fail ? 1 : 0);
