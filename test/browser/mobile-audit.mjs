// 手機版全面稽核：量每個元素是否超出、重疊、點擊目標太小
import { spawn } from 'node:child_process';
import { mkdirSync } from 'node:fs';
// 截圖放專案裡的 test/browser/out（已 gitignore）
const OUT = new URL('./out/', import.meta.url).pathname;
mkdirSync(OUT, { recursive: true });

import { writeFileSync } from 'node:fs';
const CHROME='/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const PORT=9370, W=390, H=844;
const DIR=OUT;
const chrome=spawn(CHROME,['--headless','--disable-gpu','--no-sandbox','--hide-scrollbars',
  `--remote-debugging-port=${PORT}`,`--window-size=${W},${H}`,'about:blank'],{stdio:'ignore'});
const wait=ms=>new Promise(r=>setTimeout(r,ms));
let ws,id=0; const pend=new Map();
const send=(m,p={})=>new Promise((res,rej)=>{const i=++id;pend.set(i,{res,rej});ws.send(JSON.stringify({id:i,method:m,params:p}));});
const evl=async e=>(await send('Runtime.evaluate',{expression:e,returnByValue:true,awaitPromise:true})).result.value;
try{
  for(let i=0;i<40;i++){try{await fetch(`http://127.0.0.1:${PORT}/json/version`);break;}catch{await wait(250);}}
  let t;try{t=await (await fetch(`http://127.0.0.1:${PORT}/json/new?http://127.0.0.1:8787/`,{method:'PUT'})).json();}catch{}
  if(!t?.webSocketDebuggerUrl)t=(await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json()).find(x=>x.type==='page');
  ws=new WebSocket(t.webSocketDebuggerUrl); await new Promise(r=>ws.onopen=r);
  ws.onmessage=e=>{const m=JSON.parse(e.data);if(m.id&&pend.has(m.id)){const p=pend.get(m.id);pend.delete(m.id);m.error?p.rej(new Error(m.error.message)):p.res(m.result);}};
  await send('Page.enable'); await send('Runtime.enable');
  await send('Emulation.setDeviceMetricsOverride',{width:W,height:H,deviceScaleFactor:2,mobile:true});
  await send('Page.navigate',{url:'http://127.0.0.1:8787/'}); await wait(3000);

  for (const view of ['words','analyze','practice','weak','history']){
    await evl(`document.querySelector('.tabs button[data-view="${view}"]').click()`); await wait(1200);
    const r = await evl(`(() => {
      const de = document.documentElement, W = de.clientWidth;
      const out = { over: [], small: [], indent: [] };
      for (const n of document.querySelectorAll('#view-${view} *')){
        if (!n.offsetParent) continue;
        const b = n.getBoundingClientRect();
        if (b.width === 0 || b.height === 0) continue;
        const tag = n.tagName.toLowerCase() + (n.id ? '#'+n.id : '') +
          (typeof n.className === 'string' && n.className ? '.'+n.className.trim().split(/\\s+/)[0] : '');
        if (b.right > W + 1 || b.left < -1) out.over.push({ tag, l: Math.round(b.left), r: Math.round(b.right) });
        // 可點擊元素的高度
        if ((n.tagName === 'BUTTON' || n.tagName === 'SELECT' ||
             (n.tagName === 'INPUT' && n.type !== 'hidden')) && b.height < 36)
          out.small.push({ tag, h: Math.round(b.height), txt: (n.textContent||'').trim().slice(0,12) });
        // 左邊留白過大（孤立縮排）
        if (n.tagName === 'BUTTON' && b.left > 90 && b.width < 160)
          out.indent.push({ tag, l: Math.round(b.left), txt: (n.textContent||'').trim().slice(0,12) });
      }
      return { ...out, scrollW: de.scrollWidth, clientW: W };
    })()`);
    const bad = r.over.length || r.small.length || r.indent.length || r.scrollW > r.clientW + 1;
    console.log(`\n  ${bad ? '✗' : '✓'} ${view}  (scrollW=${r.scrollW}/${r.clientW})`);
    for (const o of r.over.slice(0,4))   console.log(`      超出邊界 ${o.tag}  [${o.l},${o.r}]`);
    for (const o of r.small.slice(0,5))  console.log(`      點擊目標偏小 ${o.tag} 高${o.h}px「${o.txt}」`);
    for (const o of r.indent.slice(0,4)) console.log(`      孤立縮排 ${o.tag} left=${o.l}「${o.txt}」`);
    const s = await send('Page.captureScreenshot',{format:'png',captureBeyondViewport:true});
    writeFileSync(`${DIR}/m-${view}.png`, Buffer.from(s.data,'base64'));
  }
} finally { chrome.kill(); }
