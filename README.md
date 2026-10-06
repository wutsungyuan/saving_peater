# 英文句型解剖

貼上一句話或一段英文文章，逐句分析**句型、詞性、時態、文法問題**，並給繁體中文翻譯。
文法規則取自 `國中英文文法_句型與時態.md`（五大基本句型 ＋ 16 種時態）。

## 快速開始

```bash
npm start          # http://127.0.0.1:8787
```

零依賴 —— 只用 Node 22 內建的 `node:http` 與 `node:sqlite`。
分析透過 Claude Code headless（`claude -p`）呼叫，使用你現有的 Claude 訂閱認證，不需要 API key。

## 它會分析什麼

| 層次 | 內容 |
| --- | --- |
| 句型 | 五大基本句型（S+V ／ S+V+C ／ S+V+O ／ S+V+IO+DO ／ S+V+O+C），逐成分標出 S/V/O/C/IO/DO 與修飾語 |
| 詞性 | 12 種（n, pron, v, aux, adj, adv, prep, conj, art, num, to, interj），形容詞與副詞特別標色 |
| 時態 | 4 時間 × 4 狀態共 16 格，標示是否屬於國中必學 6 種 |
| 動詞 | 三態（原形／過去式／過去分詞）＋ -ing ＋ 三單，不規則動詞標 `v°` |
| 文法 | 12 類常見錯誤偵測（連結動詞接副詞、第三人稱單數、完成式配過去時間、to/for、受格…） |
| 語序 | 「主、動、賓、方、地、時」六格拆解 |
| 翻譯 | 繁體中文（台灣用語） |

超出國中範圍的結構（關係子句、被動、分詞構句、假設語氣…）會標示 `超出國中範圍`，但仍分析主幹。
非英文、不完整片語、無意義字串會標 `issue` 並明說無法分析，不會硬掰。

## 架構

```
prompts/analyzer-system.md   知識庫 A–H：句型判別流程、時態矩陣、詞性、三態、易錯清單、範圍判定、異常處理
src/analyzer.mjs             呼叫模型 + 成分/詞性座標對齊（模型只回文字，座標由程式算）
src/segment.mjs              英文斷句（處理 Mr. / U.S. / 3.14 / 引號）
src/cache.mjs                逐句 SQLite 快取（key = 正規化後 SHA-256）
src/server.mjs               HTTP + SSE 串流 API
prototype/index.html         前端（單檔，無後端時自動降級為範例展示模式）
eval/                        60 案例黃金測試集 ＋ 評測腳本
fixtures/samples.json        12 組預先分析好的範例，給靜態展示用
```

## API

| 端點 | 說明 |
| --- | --- |
| `GET /api/health` | 回報模型與上限 |
| `POST /api/analyze` | `{"text":"..."}` → SSE 串流，每分析完一句推一句 |
| `GET /api/stats` | 快取統計與句型／時態分佈 |

SSE 事件：`meta`（總句數）→ `sentence`（單句結果，附 `cached`）→ `progress` → `done`。
快取命中的句子會在毫秒內先推出，其餘才送去分析。

環境變數：`PORT`(8787)、`MAX_CHARS`(4000)、`MAX_SENTENCES`(25)、`CONCURRENCY`(6)、`ANALYZER_MODEL`(opus)。

## 快取與搬遷

快取落在本機單一檔案 `data/cache.db`（SQLite），存的是**你貼過的每一句原文與完整分析**。
`data/` 已在 `.gitignore` 內，不會進版控。

要讓快取跟著走，用 JSONL 匯出而不是直接複製 `.db` —— JSONL 可以進版控、可 diff、可合併：

```bash
npm run cache:seed                      # 匯出到 fixtures/seed-cache.jsonl（這個檔進版控）
npm start                               # 新機器首次啟動會自動載入種子
```

其他指令：

```bash
npm run cache -- export out.jsonl --since 2026-01-01   # 增量匯出
npm run cache -- import out.jsonl                      # 匯入（預設保留本機既有，只合併命中次數）
npm run cache -- import out.jsonl --force              # 覆蓋同一句的既有結果
npm run cache -- prune 90                              # 刪除超過 90 天的紀錄
npm run cache:info                                     # 狀態；同時 checkpoint WAL
```

合併語意：同一句（hash 相同）預設**不覆蓋**本機版本，只把命中次數加總，所以兩台機器各自累積後互相匯入不會打架。

若真的要直接複製 `data/cache.db`，先跑 `npm run cache:info` 把 WAL 折回主檔，否則會漏掉最近的寫入。

## 測試

```bash
npm run eval       # 跑 60 案例黃金測試集
```

最近結果：句型 60/60、時態 60/60、易錯偵測 60/60、成分對齊 60/60。詳見 `eval/P0-REPORT.md`。

## 效能

| 情境 | 時間 |
| --- | --- |
| 單句（未快取） | 約 8–12 秒 |
| 7 句段落（未快取，併發 6） | 約 15–30 秒 |
| 已快取 | 0 ms |

快取以**單句**為單位，所以同一句出現在不同文章裡也會命中。
