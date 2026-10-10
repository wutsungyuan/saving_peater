// 瀏覽器測試共用的環境設定：Chrome 在哪、測哪個伺服器、截圖放哪。
//   CHROME=<路徑>   BASE=http://127.0.0.1:8788/   （開發版伺服器用 8788，8787 是正式服務）
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

export const CHROME = process.env.CHROME || [
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
].find(existsSync);
if (!CHROME) throw new Error('找不到 Chrome，請用環境變數 CHROME 指定');

export const BASE = process.env.BASE || 'http://127.0.0.1:8787/';
export const OUT = fileURLToPath(new URL('./out/', import.meta.url));
