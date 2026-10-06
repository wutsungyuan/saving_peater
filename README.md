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

## 練習模式

介面上方切到「練習」，從**你分析過的句子**反向生成題目。五種題型：

| 題型 | 形式 | 範例 |
| --- | --- | --- |
| 句型判斷 | 五選一 | `Last week our teacher gave us a difficult test.` → 句型四 |
| 時態填空 | 填空（給原形） | `The news ______ his parents proud.`（make）→ made |
| 詞性判斷 | 四選一 | 「confident」在這句是什麼詞性？→ adj |
| 動詞三態 | 兩格填空 | `give → ______ → ______` → gave, given |
| 改錯 | 填空 | `The soup tastes well.` → tastes good |

**出題不呼叫模型。** 分析結果裡已有句型、成分、時態關鍵字、詞性、三態與錯誤修正，
由程式反向生成，所以零成本、1 毫秒完成，而且題目與解答必然和分析一致。

解答沿用講義的解說語言（等號測試、關鍵字 → 時態、三態表）。
答案不隨題目下發，交卷時才由後端批改並記錄，批改時大小寫、空白、句尾標點都不計較。

## 架構

```
prompts/analyzer-system.md   知識庫 A–H：句型判別流程、時態矩陣、詞性、三態、易錯清單、範圍判定、異常處理
src/analyzer.mjs             呼叫模型 + 成分/詞性座標對齊（模型只回文字，座標由程式算）
src/segment.mjs              英文斷句（處理 Mr. / U.S. / 3.14 / 引號）
src/cache.mjs                逐句 SQLite 快取（key = 正規化後 SHA-256）
src/exercises.mjs            出題引擎（純程式，不呼叫模型）
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
| `POST /api/exercises` | `{"count":10,"types":[...]}` → 題目（不含答案） |
| `POST /api/attempts` | `{"quizId","userToken","answers"}` → 批改結果並記錄 |
| `GET /api/weakness?user=` | 弱點統計：依題型／句型／時態／詞性的正確率 |
| `GET /api/history` | 用量累計與分析紀錄；帶 `?id=` 取回該筆原文 |
| `GET /api/stats` | 快取統計與句型／時態分佈 |

SSE 事件：`meta`（總句數）→ `sentence`（單句結果，附 `cached`）→ `progress` → `done`。
快取命中的句子會在毫秒內先推出，其餘才送去分析。

環境變數：`PORT`(8787)、`HOST`(127.0.0.1)、`AUTH_TOKEN`(無)、`MAX_CHARS`(4000)、
`MAX_SENTENCES`(25)、`CONCURRENCY`(6)、`ANALYZER_MODEL`(opus)、`HISTORY_DAYS`(30)。

### 額度與對外開放

分析由本機 `claude` CLI 執行，**額度計入執行這台機器上登入的 Claude 帳號**。
程式碼不含任何憑證，別人 clone 後要自己 `claude login`，花的是他們自己的額度。

因此伺服器預設**只監聽 127.0.0.1**。要讓區網其他裝置連線：

```bash
HOST=0.0.0.0 AUTH_TOKEN=你自訂的字串 npm start
```

分享網址時帶上 `?token=你自訂的字串`，前端會記住。
未設 `AUTH_TOKEN` 就對外開放時，啟動訊息會警告 —— 任何連得到的人都能無限消耗你的額度。

## 用量與歷史

每次分析完成後，畫面上會顯示這次用掉的 token 與參考費用：

```
句數 3   耗時 13.6s   輸入 90,806 tokens   輸出 3,090 tokens   參考費用 $0.306
```

參考費用是依 Claude API 牌價換算的估算值。實際分析走本機 Claude 訂閱，
**不會另外收費，但會消耗訂閱額度** —— 這個數字是用來掌握用量規模的。
全部命中快取時不會呼叫模型，也就不產生任何用量。

「歷史」分頁有今天／本月／全部的累計用量，以及過去的分析紀錄。
點任一筆會載回原文重新顯示 —— 因為全部命中快取，所以是 0 秒且免費。

歷史**原文**保留 `HISTORY_DAYS`（預設 30）天後自動清除，啟動時與每 6 小時各清一次。
分析快取本身不受影響，那是可以重複利用的資產。

### 訂閱額度

Claude CLI **沒有提供查詢剩餘訂閱額度的介面** —— 沒有 `usage` 子指令，
`--output-format json` 的回傳欄位裡也沒有 rate limit / quota，`claude auth status`
只給方案類型不給用量。資料本身存在（Claude app 的 Settings → Usage 就在顯示），
只是 CLI 沒開這個口。

所以本工具**只顯示自己的用量**（token 與 API 牌價換算的參考費用），
不假裝知道你還剩多少額度。真實額度請看 **Claude app → Settings → Usage**，
那裡是 5 小時 session 與每週兩種視窗的實際百分比。

額度真的用盡時，CLI 會回報 rate limit，伺服器會**立即中止**其餘句子的分析
（這類錯誤重試沒有意義），畫面顯示「訂閱額度似乎已用盡」，已完成的句子仍保留在快取。
認證失效也會比照處理並提示重新 `claude` 登入。

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
