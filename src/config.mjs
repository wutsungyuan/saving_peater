import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

// 伺服器設定：全部來自環境變數，有預設值。
// 預設只聽 127.0.0.1；要讓區網其他裝置連，必須明確設 HOST=0.0.0.0（見下）。

export const ROOT = join(fileURLToPath(new URL('.', import.meta.url)), '..');
export const WEB = join(ROOT, 'prototype');
export const PORT = Number(process.env.PORT || 8787);
export const MAX_CHARS = Number(process.env.MAX_CHARS || 4000);
export const MAX_SENTENCES = Number(process.env.MAX_SENTENCES || 25);
// 文章（要存成文章表的長文）可以比一般貼上的更長：每句本來就是獨立呼叫、逐句寫進快取，
// 中途斷線再送一次會從快取接續，所以長不是問題；上限只是避免誤貼整本書。
export const MAX_ARTICLE_CHARS = Number(process.env.MAX_ARTICLE_CHARS || 20000);
export const MAX_ARTICLE_SENTENCES = Number(process.env.MAX_ARTICLE_SENTENCES || 120);
// 快取是冷的（閒置一陣子、或剛改過提示）時，第一次呼叫會多花約這麼多（這台實測：單句 $0.207 對平均 $0.033）
export const COLD_START_USD = 0.2;
export const CONCURRENCY = Number(process.env.CONCURRENCY || 6);
// 預設只聽 127.0.0.1。要讓區網其他裝置連，必須明確設 HOST=0.0.0.0，
// 因為每個請求都花執行這台機器的 Claude 訂閱額度。
export const HOST = process.env.HOST || '127.0.0.1';
export const AUTH_TOKEN = process.env.AUTH_TOKEN || '';
export const HISTORY_DAYS = Number(process.env.HISTORY_DAYS || 30);
// 測驗卷歷史（快取性質）：保留天數與份數，先到者為準；題庫（模型出的題）設上限
export const PAPER_DAYS = Number(process.env.PAPER_DAYS || 30);
export const PAPER_KEEP = Number(process.env.PAPER_KEEP || 20);
export const QUESTION_MAX = Number(process.env.QUESTION_MAX || 500);
// 測驗卷的模型出題（閱讀測驗、克漏字干擾項、延伸題）：預設用 Sonnet 級模型加上程式驗證，比分析用的 opus 便宜
export const EXAM_MODEL = process.env.EXAM_MODEL || 'sonnet';
export const EXAM_PROMPT = join(ROOT, 'prompts', 'exam-gen.md');
export const EXAM_GRADE_PROMPT = join(ROOT, 'prompts', 'exam-grade.md');
export const isLoopback = HOST === '127.0.0.1' || HOST === 'localhost' || HOST === '::1';

// DB_FILE 讓測試與開發分支可以用自己的資料庫，不碰正式資料
export const DB_FILE = process.env.DB_FILE || join(ROOT, 'data', 'cache.db');
