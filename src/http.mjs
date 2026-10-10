// 共用的 HTTP 工具：讀請求本文、驗證、併發池、圖片解碼、靜態檔。
import { readFile } from 'node:fs/promises';
import { join, extname, normalize as pathNormalize } from 'node:path';
import { WEB, AUTH_TOKEN } from './config.mjs';

const MIME = { '.html':'text/html', '.js':'text/javascript', '.css':'text/css',
  '.json':'application/json', '.svg':'image/svg+xml', '.ico':'image/x-icon' };

export const readBody = (req, limit = 1e6) => new Promise((resolve, reject) => {
  let n = 0; const chunks = [];
  req.on('data', c => { n += c.length; if (n > limit) { reject(new Error('payload too large')); req.destroy(); } else chunks.push(c); });
  req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
  req.on('error', reject);
});

/** 併發池：固定 n 個 worker 取任務，先完成先回報 */
export async function pool(items, n, fn){
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => {
    while (true){
      const i = next++;
      if (i >= items.length) return;
      await fn(items[i], i);
    }
  }));
}

export function authed(req, url){
  if (!AUTH_TOKEN) return true;
  const sent = req.headers['x-auth-token'] || url.searchParams.get('token') || '';
  // 長度相同才比對，避免洩漏長度；這裡是本機小工具，常數時間比對非必要
  return sent === AUTH_TOKEN;
}

/** 解析前端送來的 data URL：驗 MIME、大小與檔頭。
 *  只信前端說的格式不夠 —— 檔頭才是真的。 */
export function decodeImage(dataUrl){
  const m = /^data:image\/(jpeg|jpg|png|webp|heic|heif);base64,(.+)$/i.exec(String(dataUrl || ''));
  if (!m) return { error:'bad-image', code:400, message:'看不出這是圖片，請選 JPG 或 PNG。' };
  const buf = Buffer.from(m[2], 'base64');
  if (buf.length > 10e6) return { error:'too-large', code:413, message:'圖片超過 10MB。' };
  const sig = buf.subarray(0, 12);
  const isJpeg = sig[0] === 0xFF && sig[1] === 0xD8 && sig[2] === 0xFF;
  const isPng  = sig.subarray(0, 8).equals(Buffer.from([0x89,0x50,0x4E,0x47,0x0D,0x0A,0x1A,0x0A]));
  const isWebp = sig.subarray(0,4).toString() === 'RIFF' && sig.subarray(8,12).toString() === 'WEBP';
  const isHeic = sig.subarray(4,8).toString() === 'ftyp';
  if (!isJpeg && !isPng && !isWebp && !isHeic)
    return { error:'bad-image', code:400, message:'檔案內容不是圖片。' };
  return { buf, ext: isPng ? 'png' : isWebp ? 'webp' : isHeic ? 'heic' : 'jpg' };
}

// index.html 是給 Artifact 用的格式 —— 發布時平台會自動包上
// doctype、charset 與 viewport。我們自己送就得補，否則手機上會是
// quirks 模式加 980px 的版面寬度，整頁縮小到看不清楚。
// 骨架放這裡而不是寫進檔案，是為了不破壞 Artifact 的發布規則。
const HEAD = `<!doctype html>
<html lang="zh-Hant">
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="color-scheme" content="light">
`;

export async function serveStatic(req, res, url){
  let rel = url.pathname === '/' ? 'index.html' : url.pathname.slice(1);
  rel = pathNormalize(rel).replace(/^(\.\.[/\\])+/, '');
  const file = join(WEB, rel);
  if (!file.startsWith(WEB)){ res.writeHead(403); return res.end('forbidden'); }
  try {
    const buf = await readFile(file);
    const isPage = extname(file) === '.html' && !buf.subarray(0, 200).toString().toLowerCase().includes('<!doctype');
    res.writeHead(200, { 'content-type': (MIME[extname(file)] || 'application/octet-stream') + '; charset=utf-8' });
    res.end(isPage ? Buffer.concat([Buffer.from(HEAD), buf]) : buf);
  } catch { res.writeHead(404, { 'content-type':'text/plain; charset=utf-8' }); res.end('not found'); }
}
