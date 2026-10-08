// 英文斷句：處理縮寫、小數、縮略語、引號，避免在 Mr. / U.S. / 3.14 處誤切。
// 回傳 [{ text, start, end }]，座標是相對於原始輸入，方便之後做整段層級的功能。

const ABBR = new Set([
  'mr','mrs','ms','dr','prof','rev','hon','st','jr','sr','capt','gen','sgt','lt',
  'vs','etc','eg','ie','cf','al','approx','dept','est','fig','no','vol','ed','esp',
  'inc','ltd','co','corp','univ','assn','mt','ft','ave','blvd','rd',
  'jan','feb','mar','apr','jun','jul','aug','sep','sept','oct','nov','dec',
  'mon','tue','tues','wed','thu','thur','thurs','fri','sat','sun',
]);

const isUpper = c => c >= 'A' && c <= 'Z';
const isDigit = c => c >= '0' && c <= '9';
const isAlpha = c => /[A-Za-z]/.test(c);
const CLOSERS = new Set(['"', "'", '”', '’', ')', ']', '}', '」', '』']);

/** 判斷 text[i] 這個句號是否為真正的句尾 */
function isBoundary(text, i){
  const ch = text[i];
  if (ch === '!' || ch === '?') return true;       // ! 與 ? 幾乎不會出現在縮寫裡

  // 小數或版本號：3.14
  if (isDigit(text[i - 1] ?? '') && isDigit(text[i + 1] ?? '')) return false;

  // 往回取句號前的詞
  let j = i - 1;
  while (j >= 0 && (isAlpha(text[j]) || text[j] === '.')) j--;
  const word = text.slice(j + 1, i);

  // 單一大寫字母的縮寫（J. K. Rowling）
  if (word.length === 1 && isUpper(word)) return false;
  // 內含句號的縮略語（U.S. / a.m. / e.g.）
  if (word.includes('.')) return false;
  // 已知縮寫
  if (ABBR.has(word.toLowerCase())) return false;

  return true;
}

/** 對話的說話者標記（A: / B: / Man: / Woman: / Tom:）。
 *  考卷的對話題會帶這個，分析時要拆掉，但要記下誰說的、跟誰對話。 */
const SPEAKER = /^\s*([A-Z][A-Za-z]{0,9})\s*[:：]\s*/;
/** 課本上這些也是「字+冒號」但不是說話者，不能當成對話。 */
const NOT_SPEAKER = new Set(['note','tip','example','answer','answers','hint','key','warning',
  'ps','ex','question','note1','attention','remember','caution','important','see','also']);

/** 把帶說話者標記的文字拆成 [{ speaker, text }]，沒有標記就回 null。 */
export function splitDialogue(input){
  const lines = String(input ?? '').split('\n').map(l => l.trim()).filter(Boolean);
  if (lines.length < 2) return null;
  const turns = lines.map(l => {
    const m = SPEAKER.exec(l);
    if (!m || NOT_SPEAKER.has(m[1].toLowerCase())) return null;
    return { speaker: m[1], text: l.slice(m[0].length).trim() };
  });
  // 必須每一行都有標記、而且至少兩個不同的說話者，才算對話
  if (turns.some(t => !t || !t.text)) return null;
  if (new Set(turns.map(t => t.speaker)).size < 2) return null;
  return turns;
}

export function splitSentences(input){
  const text = String(input ?? '');
  const out = [];
  let start = 0;

  for (let i = 0; i < text.length; i++){
    const ch = text[i];
    if (ch !== '.' && ch !== '!' && ch !== '?') continue;
    if (!isBoundary(text, i)) continue;

    // 吃掉連續的終止符號（?! 或 ...）
    let end = i;
    while (end + 1 < text.length && '.!?'.includes(text[end + 1])) end++;
    // 吃掉緊接的引號、括號
    while (end + 1 < text.length && CLOSERS.has(text[end + 1])) end++;

    // 往後看：必須是字串結尾，或空白後接新句子的開頭
    const rest = text.slice(end + 1);
    if (rest.length && !/^\s/.test(rest)) continue;          // 沒有空白分隔，不切
    const next = rest.replace(/^\s+/, '');
    if (next.length && !(isUpper(next[0]) || isDigit(next[0]) || /["'“‘(\[]/.test(next[0]))) continue;

    const seg = text.slice(start, end + 1).trim();
    if (seg) {
      const s = text.indexOf(seg, start);
      out.push({ text: seg, start: s, end: s + seg.length });
    }
    start = end + 1;
    i = end;
  }

  const tail = text.slice(start).trim();
  if (tail){
    const s = text.indexOf(tail, start);
    out.push({ text: tail, start: s, end: s + tail.length });
  }
  return out;
}

/** 正規化：給快取當 key 用。只影響比對，不影響顯示 */
export function normalize(s){
  return String(s ?? '')
    .replace(/[“”]/g, '"')
    .replace(/[‘’]/g, "'")
    .replace(/\s+/g, ' ')
    .trim();
}
