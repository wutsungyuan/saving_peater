// 測驗卷批改。回傳 { correct: true | false | null, given, expected, pending, suggest, checks }
//   correct === null → 程式判不出來（開放題），要自評（pending: true）
// 造句與翻譯預設不呼叫模型：程式先檢查能檢查的，其餘顯示參考答案由學生或家長自己標對錯。

import { gradeWord, findForm } from '../wordset.mjs';

const norm = s => String(s ?? '').trim().toLowerCase().replace(/\s+/g, ' ').replace(/[.!?,;:]+$/, '');
const asList = v => Array.isArray(v) ? v : (v == null || v === '' ? [] : [v]);
const stem = w => w.slice(0, Math.max(3, Math.min(5, w.length - 1)));
const tokens = s => String(s ?? '').toLowerCase().match(/[a-z]+(?:'[a-z]+)?/g) ?? [];

export function gradeQuestion(q, given){
  const got = asList(given);
  const base = { given: got, expected: q.answer ?? [], pending: false, suggest: null, checks: null };

  if (q.inputMode === 'choice'){
    return { ...base, correct: got.length === 1 && norm(got[0]) === norm(q.answer?.[0]) };
  }
  if (q.inputMode === 'text'){
    if (!got.length || got.every(x => !String(x).trim())) return { ...base, correct: false };
    return { ...base, correct: gradeWord(q, got.map(String)).correct };
  }
  if (q.inputMode === 'order'){
    // 積木依學生排的順序接起來；和任一個可接受的順序一樣就對（時間修飾語放句首或句尾都算對）
    const seq = a => norm(a.join(' ').replace(/\s*,\s*/g, ', ')).replace(/[.!?]+$/, '');
    return { ...base, correct: got.length > 0 && (q.orders ?? []).some(o => seq(o) === seq(got.map(String))) };
  }
  if (q.inputMode === 'open') return gradeOpen(q, String(got[0] ?? ''), base);
  return { ...base, correct: false };
}

function gradeOpen(q, text, base){
  const t = text.trim();
  if (!t) return { ...base, correct: false };

  if (q.type === 'make'){
    const used = Boolean(findForm(t, q.checkTerm));
    const checks = [
      { ok: used, label: `有用到「${q.checkTerm}」` },
      { ok: /^["“']?[A-Z]/.test(t), label: '開頭大寫' },
      { ok: /[.!?]["”']?$/.test(t), label: '結尾有標點' },
      { ok: tokens(t).length >= 3, label: '至少 3 個字' },
    ];
    // 沒用到指定的字：直接判錯，不必自評；其餘由自評決定（文法好不好程式看不出來）
    return used ? { ...base, correct: null, pending: true, suggest: checks.every(c => c.ok) ? 'likely' : 'check', checks }
                : { ...base, correct: false, checks };
  }

  if (q.type === 'trans'){
    const ans = q.answer?.[0] ?? '';
    // 第一層：和參考答案一樣（大小寫、標點不計）
    if (norm(t).replace(/\./g, '') === norm(ans).replace(/\./g, '')) return { ...base, correct: true, suggest: 'exact' };
    // 第二層：主要實詞覆蓋率夠高就標「大致正確」，仍由自評決定
    const mine = tokens(t).map(stem);
    const kw = (q.keywords ?? []).map(stem);
    const hit = kw.filter(k => mine.includes(k)).length;
    const cover = kw.length ? hit / kw.length : 0;
    return { ...base, correct: null, pending: true, suggest: cover >= 0.7 ? 'likely' : 'unknown',
      checks: [{ ok: cover >= 0.7, label: `主要的字出現了 ${hit} / ${kw.length}` }] };
  }
  return { ...base, correct: null, pending: true };
}

/** 單題得分：對得全分；程式判不出來的，看自評標記（true 才給分） */
export function earned(q, g, self){
  if (g.correct === true) return q.pts;
  if (g.pending && self?.[q.id] === true) return q.pts;
  return 0;
}
