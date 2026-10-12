// 英文斷句：處理縮寫、小數、縮略語、引號，避免在 Mr. / U.S. / 3.14 處誤切。
// 回傳 [{ text, start, end }]，座標是相對於原始輸入，方便之後做整段層級的功能。

const ABBR = new Set([
  'mr','mrs','ms','dr','prof','rev','hon','st','jr','sr','capt','gen','sgt','lt',
  'vs','etc','eg','ie','cf','al','approx','dept','est','fig','no','vol','ed','esp',
  'inc','ltd','co','corp','univ','assn','mt','ft','ave','blvd','rd',
  'jan','feb','mar','apr','jun','jul','aug','sep','sept','oct','nov','dec',
  'mon','tue','tues','wed','thu','thur','thurs','fri','sat','sun',
]);

// 這幾個縮寫同時也是常見的英文單字或應答（No. / Sat. = sat / Sun. = sun / Mon. / Wed. / Fri.），
// 只有後面接數字（No. 5、Sat. 3 pm）才當縮寫；後面接大寫字開頭的句子就是句尾。
// 例：Yuki: No. I can't make up my mind. —— 以前 No. 被當縮寫，兩句黏成一句，後面那句就丟了。
const AMBIGUOUS = new Set(['no', 'sat', 'sun', 'mon', 'wed', 'fri']);

const isUpper = c => c >= 'A' && c <= 'Z';
const isDigit = c => c >= '0' && c <= '9';
const isAlpha = c => /[A-Za-z]/.test(c);
const CLOSERS = new Set(['"', "'", '”', '’', ')', ']', '}', '」', '』']);

/** 判斷 text[i] 這個句號是否為真正的句尾 */
function isBoundary(text, i){
  const after = text.slice(i + 1).replace(/^\s+/, '');
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
  if (AMBIGUOUS.has(word.toLowerCase())) return !isDigit(after[0] ?? '');
  if (ABBR.has(word.toLowerCase())) return false;

  return true;
}

/** 對話的說話者標記（A: / B: / Man: / Woman: / Tom:）。
 *  考卷的對話題會帶這個，分析時要拆掉，但要記下誰說的、跟誰對話。 */
const SPEAKER = /^\s*([A-Z][A-Za-z]{0,9})\s*[:：]\s*/;
/** 課本上這些也是「字+冒號」但不是說話者，不能當成對話。 */
const NOT_SPEAKER = new Set(['note','tip','example','answer','answers','hint','key','warning',
  'ps','ex','question','note1','attention','remember','caution','important','see','also']);

/** 考卷的對話題常常把兩個人的話印在同一行，而且標點後面直接接標記：「...with me?B: Sorry, I am not free now.」
 *  這樣沒有空白，斷句切不開，標記也會被當成句子的一部分，模型就會回「拆成了多句」。
 *  這裡把「標點 + A:/B:」換成換行並拿掉標記；那一行開頭的 A: 也一起拿掉（兩句各自成行、不帶標記）。
 *  只認標點後面緊接的 A/B，「Plan B: …」「Vitamin C: …」這種不會被動到。每一行的行首標記（A: … 換行 B: …）由 splitDialogue 處理，不在這裡動。 */
const INLINE_SPEAKER = /([.!?]["”')]*)[ \t]*[AB][ \t]*[:：][ \t]*(?=\S)/;
export function splitInlineSpeakers(input){
  return String(input ?? '').split('\n').map(line => {
    if (!INLINE_SPEAKER.test(line)) return line;
    return line.replace(new RegExp(INLINE_SPEAKER.source, 'g'), '$1\n').replace(/^[ \t]*[AB][ \t]*[:：][ \t]*/, '');
  }).join('\n');
}

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

/** 對話拆成「一句一個單位」：一個人說的話裡有好幾句（Wow! You have a snowboard?）要各自分析，
 *  不然模型只回第一句、原句和送出去的對不上，後面的句子就丟了。
 *  回傳 [{ text, speaker, turn }]；turn 是第幾個人說的（同一個人說的句子 turn 相同）。 */
export function dialogueUnits(turns){
  const out = [];
  turns.forEach((t, turn) => {
    const parts = splitSentences(t.text).map(s => s.text.trim()).filter(Boolean);
    for (const text of parts.length ? parts : [t.text]) out.push({ text, speaker: t.speaker, turn });
  });
  return out;
}

/** 換行也是句子邊界。標題、條列、OCR 抄出來的每一行常常沒有句點，
 *  不在換行處斷的話會和下一句黏成一段，快取的鍵就會對不上分析結果。 */
export function splitSentences(input){
  const text = String(input ?? '');
  if (/\n/.test(text)){
    const out = [];
    let base = 0;
    for (const line of text.split('\n')){
      for (const seg of splitSentences(line))
        out.push({ ...seg, start: seg.start + base, end: seg.end + base });
      base += line.length + 1;
    }
    return out;
  }
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
