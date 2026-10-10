import { spawn } from 'node:child_process';

// Claude CLI 的執行檔名稱。
//
// Windows 上 npm 安裝的是 claude.cmd（批次檔），而 child_process.spawn
// 不透過 shell 是執行不了 .cmd 的 —— 直接寫 'claude' 會得到 ENOENT。
// 用 shell:true 可以繞過，但送進去的參數含使用者貼上的文字，
// 經過 shell 等於開了一個命令注入的洞，所以改成指名正確的檔名。
//
// 裝法不同（scoop、手動放 PATH、WSL）時，用 CLAUDE_BIN 環境變數指定：
//   CLAUDE_BIN=C:\Users\you\AppData\Roaming\npm\claude.cmd npm start
export const CLAUDE_BIN =
  process.env.CLAUDE_BIN || (process.platform === 'win32' ? 'claude.cmd' : 'claude');

// 只給測試用的接縫：CLAUDE_ARGS_PREFIX 是 JSON 陣列，放在所有參數前面。
// 測試時設 CLAUDE_BIN=node 加上 CLAUDE_ARGS_PREFIX='["test/fake-claude.mjs"]'，
// 就能用假的 CLI 走完整條路由，不花任何額度。正式環境不設，行為不變。
export const CLAUDE_ARGS_PREFIX = process.env.CLAUDE_ARGS_PREFIX ? JSON.parse(process.env.CLAUDE_ARGS_PREFIX) : [];

/** 啟動 Claude CLI（四個呼叫點共用，才只有一個地方決定怎麼叫它） */
export function spawnClaude(args){
  return spawn(CLAUDE_BIN, [...CLAUDE_ARGS_PREFIX, ...args], { stdio: ['ignore', 'pipe', 'pipe'] });
}

/** 找不到 CLI 時給看得懂的訊息，而不是裸的 ENOENT */
export function claudeNotFound(err){
  if (err?.code !== 'ENOENT') return null;
  return `找不到 Claude CLI（${CLAUDE_BIN}）。請確認已安裝並在 PATH 裡；` +
    `若安裝路徑特殊，用環境變數 CLAUDE_BIN 指定完整路徑。`;
}
