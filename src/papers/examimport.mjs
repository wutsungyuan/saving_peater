// 考卷重現：老師從後台上傳學校考卷的照片，把選擇題原樣存成一份測驗卷草稿。
// 模型只負責「抄」：題幹、選項、它判斷的答案（extractExam）；這裡負責整理、檢查、組成卷子與完整句子。
// 答案是模型猜的，所以一定先是草稿，老師在後台核對、修改後才發佈給學生。

import { randomBytes } from 'node:crypto';

export const BLANK = '______';
const MAX_QUESTIONS = 60;
const MAX_OPTIONS = 6;

const newId = () => 'p' + randomBytes(5).toString('hex');
const clean = s => String(s ?? '').replace(/\s+/g, ' ').trim();
const blanksOf = stem => (stem.match(/_{2,}/g) ?? []).length;

/** 選項前面不小心帶了 (A) 或 A. 就拿掉 */
const stripLabel = o => clean(o).replace(/^\(?[A-Ha-h]\)\s*/, '').replace(/^[A-Ha-h][.)]\s+/, '');

/** 一題兩個空格的選項（free; poor）拆成每個空格要填的字；X 代表不填 */
export function optionParts(option, blanks){
  if (blanks <= 1) return [clean(option)];
  return clean(option).split(/\s*[;；/]\s*/).map(x => x.trim());
}

/** 把選中的選項填進題幹，回傳完整句子；選項成組的數量和空格對不上就回 null */
export function fillStem(stem, option){
  const b = blanksOf(stem), parts = optionParts(option, b);
  if (!b || parts.length !== b) return null;
  let i = 0;
  let out = stem.replace(/_{2,}/g, () => { const p = parts[i++]; return /^x$/i.test(p) ? '' : p; });
  out = out.replace(/\s+([,.!?;:])/g, '$1').replace(/\s{2,}/g, ' ').trim();
  return out.replace(/^(["“'(]?)([a-z])/, (_, q, c) => q + c.toUpperCase());
}

/** 完整句子 → 給分析用的文字：去掉印刷的中文註解（lottery(中樂透)）與對話的 A: B: 標記，每個人說的話一行 */
export function analysisText(filled){
  const text = String(filled ?? '')
    .replace(/[(（][^()（）]*[一-鿿][^()（）]*[)）]/g, '')
    .replace(/\s{2,}/g, ' ').trim();
  const lines = text.split(/(?:^|\s)(?:A|B|C|M|W)\s*:\s*/).map(x => x.trim()).filter(Boolean);
  return lines.join('\n');
}

/** 一題：{ no, stem, options, answer } → { q } 或 { skip: 原因 }。q.meta.check 有東西的是「請核對」（結構怪怪的，不是答案對錯） */
export function examQuestion(r){
  const no = Number.isFinite(Number(r?.no)) ? Number(r.no) : null;
  const stem = clean(r?.stem).replace(/_{2,}|＿{2,}|…{3,}/g, BLANK);
  const options = (Array.isArray(r?.options) ? r.options : []).map(stripLabel).filter(Boolean);
  if (!stem || !blanksOf(stem)) return { no, skip: '題幹裡沒有空格' };
  if (options.length < 2) return { no, skip: '找不到選項' };
  if (options.length > MAX_OPTIONS) return { no, skip: '選項太多，可能是兩題黏在一起' };

  const check = [];
  let ans = Number(r?.answer);
  if (!Number.isInteger(ans) || ans < 0 || ans >= options.length){ check.push('模型沒有給出答案，請自己選'); ans = 0; }
  const b = blanksOf(stem);
  const filled = fillStem(stem, options[ans]);
  if (filled == null) check.push(`有 ${b} 個空格，選項卻不是 ${b} 組`);
  if (new Set(options.map(o => o.toLowerCase())).size !== options.length) check.push('有兩個選項一樣');
  return { no, q: {
    type: 'exam', skill: 'exam-choice', inputMode: 'choice', src: 'scope',
    prompt: b > 1 ? `每個選項對應 ${b} 個空格，選出兩個空格都適合的一組` : '選出適合的答案',
    question: stem, choices: options.map(o => ({ value: o, label: o })), answer: [options[ans]],
    explain: filled ? `完整句子：${filled}` : '',
    meta: { key: `x${no ?? ''}`, stat: { kind: 'paper', qtype: 'paper-exam' }, examNo: no, filled, check },
  } };
}

/** 把模型抄出的題目整理成卷子上的題。回傳 { questions, skipped:[{ no, reason }] } */
export function buildExamQuestions(raw){
  const questions = [], skipped = [];
  for (const r of Array.isArray(raw) ? raw : []){
    const x = examQuestion(r);
    if (x.skip) skipped.push({ no: x.no, reason: x.skip });
    else if (questions.length >= MAX_QUESTIONS) skipped.push({ no: x.no, reason: `一份最多 ${MAX_QUESTIONS} 題` });
    else questions.push(x.q);
  }
  return { questions, skipped };
}

/** 每題分數：總分 100，不能整除的尾差由前面幾題各加 0.5 分（和一般卷子同一套規則） */
export function examPoints(n){
  const base = Math.floor(200 / n) / 2, k = Math.round((100 - base * n) * 2);
  return Array.from({ length: n }, (_, i) => base + (i < k ? 0.5 : 0));
}

const pad = n => String(n).padStart(2, '0');
const dateOf = d => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
export const EXAM_LABEL = '考卷重現';

/** 沒填名稱時：日期＋「考卷重現」；同一天已經有同名的就加（2）（3）… */
export function defaultExamTitle(existingTitles, now = new Date()){
  const base = `${dateOf(now)} ${EXAM_LABEL}`, taken = new Set(existingTitles.filter(Boolean));
  if (!taken.has(base)) return base;
  for (let i = 2; ; i++) if (!taken.has(`${base}（${i}）`)) return `${base}（${i}）`;
}

/** 組成一份測驗卷草稿存進資料庫。回傳卷子 id */
export function saveExamDraft(cache, questions, { title, ttlDays = 30 } = {}){
  const pts = examPoints(questions.length);
  const qs = questions.map((q, i) => ({ ...q, id: `q${i + 1}`, section: 'exam', pts: pts[i] }));
  const section = { id: 'exam', name: '考卷選擇題', n: qs.length, pts: pts[0], passages: [], questionIds: qs.map(q => q.id), ext: 0, extFree: 0 };
  const name = clean(title).slice(0, 60) || defaultExamTitle(cache.papers(200).map(r => r.settings.title));
  const id = newId();
  cache.putPaper({ id, n: qs.length, status: 'draft', ttlDays: ttlDays * 3,
    settings: { title: name, source: 'exam-import', label: EXAM_LABEL, kind: 'normal', n: qs.length, setIds: [], articleIds: [], mode: 'custom' },
    data: { sections: [section], questions: qs, answers: {}, self: {}, plan: null } });
  return { id, title: name };
}
