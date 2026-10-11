// 內部呼叫：不經過網路，直接把一個請求交給現有的路由處理，並收回它的回應。
// 申請單核准後的背景執行靠這個：和老師自己按下去走的是同一段程式（分析、辨識、建字表、AI 批改），
// 不另外維護一份「背景版」，行為才不會分岔。內部呼叫一律以老師身分執行（req.internal，見 http.mjs 的 roleOf）。

import { EventEmitter } from 'node:events';

let ROUTES = [];
export const setRoutes = r => { ROUTES = r; };

class FakeReq extends EventEmitter {
  constructor(method, path, body){
    super();
    this.method = method; this.url = path; this.internal = true;
    this.headers = { host: 'internal', 'content-type': 'application/json' };
    this.socket = { remoteAddress: 'internal' };
    this._buf = Buffer.from(body == null ? '' : JSON.stringify(body));
    this._sent = false;
  }
  // readBody 是先掛 'data'、'end' 的監聽器；掛上 'end' 之後才把本文送出去
  on(ev, fn){
    super.on(ev, fn);
    if (ev === 'end' && !this._sent){
      this._sent = true;
      setImmediate(() => { if (this._buf.length) this.emit('data', this._buf); this.emit('end'); });
    }
    return this;
  }
  destroy(){ this.emit('close'); }
}

class SinkRes extends EventEmitter {
  constructor(){
    super();
    this.statusCode = 200; this.headers = {}; this.chunks = []; this.size = 0;
    this.headersSent = false; this.writableEnded = false;
  }
  setHeader(k, v){ this.headers[String(k).toLowerCase()] = v; }
  writeHead(code, headers = {}){ this.statusCode = code; this.headersSent = true; for (const [k, v] of Object.entries(headers)) this.setHeader(k, v); return this; }
  write(chunk){
    if (this.size < 8e6){ const b = Buffer.from(String(chunk)); this.chunks.push(b); this.size += b.length; }   // 上限：避免無止境累積
    this.headersSent = true; return true;
  }
  end(chunk){ if (chunk != null) this.write(chunk); this.writableEnded = true; this.headersSent = true; this.emit('finish'); this.emit('close'); }
  get text(){ return Buffer.concat(this.chunks).toString('utf8'); }
}

/** 解析 SSE 文字成 [{ event, data }] */
export function parseSse(text){
  const out = [];
  for (const block of String(text).split('\n\n')){
    let event = 'message', data = '';
    for (const line of block.split('\n')){
      if (line.startsWith('event:')) event = line.slice(6).trim();
      else if (line.startsWith('data:')) data += line.slice(5).trim();
    }
    if (data){ try { out.push({ event, data: JSON.parse(data) }); } catch {} }
  }
  return out;
}

/** 以老師身分執行一個請求。回傳 { status, text, json, events }（json 是整段回應能解析時，events 是 SSE 時） */
export async function internalCall(method, path, body){
  const req = new FakeReq(method, path, body), res = new SinkRes();
  const url = new URL(path, 'http://internal');
  for (const route of ROUTES){
    if (!route.match(req, url)) continue;
    await route.handler(req, res, url);
    if (res.headersSent || res.writableEnded) break;
  }
  if (!res.headersSent) res.writeHead(404);
  const text = res.text;
  const isSse = String(res.headers['content-type'] || '').includes('event-stream');
  let json = null;
  if (!isSse){ try { json = JSON.parse(text); } catch {} }
  return { status: res.statusCode, text, json, events: isSse ? parseSse(text) : null };
}
