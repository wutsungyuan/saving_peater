# 搬到 Windows

這份是把專案從 macOS 搬到 Windows 主機的步驟。每一條都在 macOS 這端實測過。

---

## 先搞清楚什麼要搬

| 東西 | 在哪 | 怎麼搬 |
| --- | --- | --- |
| 程式碼、知識庫、種子快取 | git | `git clone` 就有 |
| **你的資料**（字表、作答紀錄、分析快取、歷史） | `data/cache.db` | **要自己複製** |
| Claude 登入狀態 | Claude CLI 自己管 | 在新機器重新登入 |

`data/` 被 gitignore，所以 clone 不會帶資料。**不複製也能用** —— 首次啟動會自動載入
版控裡的 `fixtures/seed-cache.jsonl`（51 句），只是你兒子的字表與練習紀錄會從頭開始。

---

## Windows 端的準備

### 1. Node.js 22.14 以上

```powershell
node -v
```

**一定要 22.14 以上。** 這個專案用 Node 內建的 `node:sqlite`，22.5 才有、22.14 起才免旗標。
裝 20.x 會在啟動時就失敗。沒有的話到 https://nodejs.org 裝 LTS。

### 2. Claude Code CLI 並登入

```powershell
npm install -g @anthropic-ai/claude-code
claude          # 跟著指示用你的 Max 訂閱登入，登入後可以直接關掉
```

分析、建字表、照片辨識都是透過這個 CLI 跑的，**額度算在這台機器登入的帳號上**。

### 3. 確認 CLI 叫得到

```powershell
claude --version
```

叫不到的話，PATH 裡少了 npm 的全域目錄（通常是 `%APPDATA%\npm`）。
也可以不改 PATH，啟動時指定完整路徑：

```powershell
$env:CLAUDE_BIN = "C:\Users\你的帳號\AppData\Roaming\npm\claude.cmd"
```

---

## 搬過去

### 1. 在 macOS 這端先整理資料庫

```bash
npm run cache:info      # 這會做 WAL checkpoint
```

**這步不能省。** SQLite 平常把最新的寫入放在 `cache.db-wal` 裡，直接複製 `cache.db`
會少掉最近的資料。checkpoint 之後所有內容都併回 `cache.db`，單一檔案就自足了
（實測：checkpoint 後 `-wal` 是 0 bytes）。

### 2. 取得程式碼

```powershell
git clone git@github.com:wutsungyuan/saving_peater.git
cd saving_peater
```

### 3. 複製資料庫

把 macOS 的 `data/cache.db` 複製到 Windows 的 `saving_peater\data\cache.db`
（`data` 資料夾不存在就自己建）。隨身碟、雲端硬碟、`scp` 都行 —— **用二進位方式複製**，
不要經過任何會轉換文字的工具。

SQLite 的檔案格式跨平台通用，不需要轉檔。

### 4. 啟動

```powershell
npm start
```

然後開 http://127.0.0.1:8787

---

## 確認搬成功

```powershell
npm run cache:info
```

對照 macOS 那端的數字：句子數、字表數應該一樣。

接著在網頁上確認三件事：

1. **單字分頁**看得到你的字表與單字
2. **分析分頁**貼一句英文按「分析」—— 這會真的呼叫模型，確認 CLI 串得起來
3. **歷史分頁**看得到過去的用量紀錄

---

## 已經為 Windows 處理過的事

搬之前就修掉的兩個會直接失敗的地方，列在這裡是為了之後有人好奇為什麼要這樣寫：

- **CLI 的執行檔名**：Windows 上 npm 裝的是 `claude.cmd`（批次檔），
  而 `child_process.spawn` 不透過 shell 執行不了 `.cmd`，直接寫 `'claude'` 會 ENOENT。
  `src/claude-bin.mjs` 依平台選檔名。
  改用 `shell: true` 也能繞過，但送進去的參數含使用者貼上的文字，
  經過 shell 等於開了一個命令注入的洞，所以不用那個做法。
- **行尾**：`.gitattributes` 把所有文字檔固定成 LF。
  `fixtures/seed-cache.jsonl` 是一行一筆 JSON，行尾被 git 自動換成 CRLF 的話，
  git diff 會整檔變動，匯入時也可能在字串尾端多出 `\r`。

---

## 讓其他裝置連進來（手機、Tailscale）

**預設只綁 `127.0.0.1`**，所以只有這台電腦自己連得到。
別台機器連過去會完全沒反應 —— 不是錯誤畫面，是連線根本沒被接受。

PowerShell 要先設環境變數再啟動，而且 `set` 和 `$env:` 的寫法跟 bash 不一樣：

```powershell
$env:HOST = "0.0.0.0"
$env:AUTH_TOKEN = "自己取一個字串"
npm start
```

然後在別的裝置開：

```
http://<這台電腦的 IP>:8787/?token=自己取的那個字串
```

Tailscale 就填 Tailscale 給的那個 100.x.x.x；同一個 Wi-Fi 就填區網 IP。
**網址一定要帶 `?token=`**，不然除了首頁什麼都叫不動。

啟動後看一下訊息，應該要印：

```
對外開放 (0.0.0.0)，已啟用 AUTH_TOKEN。分享網址時要帶 ?token=<你的字串>
```

印的是「只接受本機連線」就代表 `$env:HOST` 沒吃到 —— 多半是開了新的 PowerShell 視窗
（環境變數只在設定它的那個視窗有效），或是用 `set HOST=...`（那是 cmd 的語法）。

**設了 `HOST=0.0.0.0` 就一定要設 `AUTH_TOKEN`**。
沒設的話，同網段或同 tailnet 的任何裝置都能用你的 Claude 額度，啟動時也會印警告。

### 連不上時依序查

1. **伺服器有對外開放嗎** —— 看上面那行啟動訊息。
2. **Windows 防火牆** —— 第一次對外監聽時會跳出詢問，錯過或按了取消就會被擋，
   而且之後不會再問。手動開一條規則：

   ```powershell
   # 系統管理員身分執行 PowerShell
   New-NetFirewallRule -DisplayName "saving_peater 8787" -Direction Inbound `
     -LocalPort 8787 -Protocol TCP -Action Allow -Profile Private
   ```

   走 Tailscale 的話，Tailscale 介面通常被歸在「公用網路」，
   那就把 `-Profile Private` 改成 `-Profile Any`。
3. **埠有在聽嗎** —— `netstat -ano | findstr :8787`，
   要看到 `0.0.0.0:8787`；看到 `127.0.0.1:8787` 就是第 1 點沒做到。

### 只想開給 Tailscale、不想對區網開放

`HOST` 可以直接填某一個位址，只綁那張網卡：

```powershell
$env:HOST = "100.69.116.17"     # Tailscale 給你的位址
$env:AUTH_TOKEN = "自己取一個字串"
npm start
```

這樣同 Wi-Fi 的其他人連不到。代價是**本機也不能再用 127.0.0.1**，
要改用同一個 100.x 位址開。

---

## 可能會遇到的狀況

**啟動時 `SqliteError` 或 `node:sqlite` 找不到**
Node 版本太舊。`node -v` 確認是 22.14 以上。

**分析時說「找不到 Claude CLI」**
CLI 沒裝、沒在 PATH、或名稱不同。先試 `claude --version`，
再用 `$env:CLAUDE_BIN` 指定完整路徑。

**分析時說「Claude 認證失效」**
在終端機跑一次 `claude` 重新登入。

**字表是空的，但資料庫檔案有複製**
確認複製的是 checkpoint 之後的 `cache.db`，而且放在 `saving_peater\data\` 底下。
`npm run cache:info` 會印出它實際讀的路徑。

**朗讀沒聲音或聲音很奇怪**
朗讀用的是瀏覽器的語音合成，語音清單依系統而定。
程式偏好系統內建的語音（`localService`），Windows 上通常是 Microsoft Zira／David。
在「分析」分頁的朗讀下拉選單可以換。
