// 模型出題（第 3 階段）：閱讀測驗、克漏字的語意干擾項、延伸題。
// 這個檔案先放介面與題庫的讀取，paper.mjs 依這個介面運作；模型實際呼叫在後面補上。

/** 這個範圍的模型題在題庫裡有幾題可用（沒有模型時，閱讀測驗只能用題庫現成的）。 */
export function bankSupply(cache, pool){
  let read = 0;
  for (const a of pool.articles) read += cache.questionsOf({ type: 'read', ref: String(a.id), src: 'scope' }).length;
  return { read };
}

export const EMPTY_QUOTE = () => ({ calls: 0, questions: 0, tasks: [], estimate: { low: 0, high: 0, seconds: 0 } });
