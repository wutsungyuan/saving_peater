# 瀏覽器測試

對著真正跑起來的頁面做驗證：點按鈕、量版面、抓截圖，
而不是對 HTML 字串做字串比對。

## 為什麼要自己接 CDP

Chrome 擴充套件連不到 localhost，所以這裡直接啟動 Chrome 的
`--remote-debugging-port`，用 Node 內建的 WebSocket 接上去下指令。
沒有 Playwright 之類的相依套件。

兩個踩過的坑寫在這裡，免得之後重踩：

- 開新分頁要用 **PUT** 打 `/json/new`，GET 會被拒絕。
- `/json/list` 回來的東西不是只有分頁，要挑 `type === 'page'`。

## 跑法

先把伺服器跑起來（預設 8787），然後：

```bash
node --no-warnings test/browser/samples.mjs
```

Chrome 路徑寫死在每支檔案最上面的 `CHROME`，不是 macOS 要自己改。

截圖輸出到 `test/browser/out/`（已 gitignore）。

## 每支在測什麼

| 檔案 | 測什麼 |
| --- | --- |
| `batch.mjs` | 批次分析例句：SSE 串流、逐批寫快取 |
| `wforms.mjs` | 動詞三態題：去重、per-blank 的多個可接受答案 |
| `reorder2.mjs` | 答錯的題目排前面、訂正不列入統計 |
| `samples.mjs` | 點標籤載入範例、再點一次換下一句 |
| `cycle.mjs` | 句子循環：走完一輪回到第一句 |
| `toggle.mjs` | 分頁切換、子分頁、各區塊的顯示狀態 |
| `combo.mjs` | 字表多選：合併去重、新增時的下拉選單 |
| `panes.mjs` | 左右抽屜：浮動把手、滑動手勢、遮罩關閉 |
| `mobile-audit.mjs` | 手機版全分頁掃描：橫向溢出、點擊目標大小 |
| `shot.mjs` | 指定寬度抓各分頁截圖，給人眼看 |

## 注意

- 這些測試會連到**你本機的資料庫**，所以字表數、句數會隨資料變動。
  斷言都寫成動態的（用 `until()` 輪詢、數量從頁面上讀），不要寫死數字。
- 跑完如果有殘留的 Chrome，`pkill -f "remote-debugging-port=93"` 清掉；
  累積十幾個會讓後面的測試變很慢。
