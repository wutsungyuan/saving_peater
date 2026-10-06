# P0 驗證報告

日期：2026-10-06　模型：`opus`（claude-opus-5-5）　路線：A（Claude Code headless + Max 訂閱）

## 結果：通過，可進 P1

| 指標 | 結果 |
| --- | --- |
| 案例數 | 60（講義 20 + 自建 40） |
| 句型判斷正確 | **60/60 (100%)** |
| 時態判斷正確 | **60/60 (100%)** |
| 易錯偵測正確 | **60/60 (100%)** |
| 國中範圍標記 | **60/60 (100%)** |
| 成分對齊成功 | **60/60 (100%)** |
| 翻譯產出 | 60/60 |
| 原文未被竄改 | 60/60 |
| 平均延遲 | 8.3 秒／句 |
| 列價成本（穩態） | $0.019／句（cache read 27K + output ~650 tokens） |

全部通過的刁鑽對照組：句型四/五等號測試（made me a cake / made me happy）、連結動詞 vs 及物動詞（tastes good / tasted the soup、got angry / got a present）、look at vs look tired、句型四改寫降為句型三（to/for）、there be、動名詞主詞、關係子句與被動的範圍標記。

## 過程中發現並修正

1. **Claude Code preamble 無法移除，但會進 prompt cache。** `--exclude-dynamic-system-prompt-sections` 後仍有 27K cached prefix；首呼叫付 cache write（$0.15），之後每次只付 cache read（$0.005）。延遲影響可忽略。
2. **`inScope` 定義不明確**（首輪唯一失分項 X-CX1）。已補「知識庫 E：國中範圍判定」，明列超範圍結構清單（關係子句、被動、分詞構句、完成進行式、過去完成式、假設語氣等），重跑後通過。
3. **成分座標交給程式算，不交給模型。** 模型只回傳原文片段，`alignConstituents()` 用字串依序搜尋算出 start/end，60/60 對齊成功，且可同時驗證模型沒竄改原文。

## 已知行為（非缺陷，前端需處理）

- **V 可能被拆成多段**：`I have never seen...` → `have«V» never«M-freq» seen«V»`。因為成分必須是原句的連續片段且按序排列，副詞插在助動詞中間時 V 只能分段。前端標色要支援同一 role 出現多次。
- **段落延遲偏高**：6 句段落單次呼叫耗時 31.4 秒、output 3852 tokens。P1 應改為程式先斷句，再平行分析（6 句平行約 9 秒）。

## 下一步（P1）

1. 程式層斷句（處理 Mr./U.S./引號等縮寫例外）
2. `/api/analyze`：斷句 → 平行呼叫 → 合併 → 對齊
3. SQLite 快取層（正規化後 SHA-256 當 key）
4. 串流回傳，讓前端逐句顯示而非等整段
