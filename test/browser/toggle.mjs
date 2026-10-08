import { spawn } from 'node:child_process';
import { mkdirSync } from 'node:fs';
// 截圖放專案裡的 test/browser/out（已 gitignore）
const OUT = new URL('./out/', import.meta.url).pathname;
mkdirSync(OUT, { recursive: true });

import { writeFileSync } from 'node:fs';
const CHROME='/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const PORT=9351, DIR=OUT;
const chrome=spawn(CHROME,['--headless','--disable-gpu','--no-sandbox','--hide-scrollbars',
  `--remote-debugging-port=${PORT}`,'--window-size=1000,560','about:blank'],{stdio:'ignore'});
const wait=ms=>new Promise(r=>setTimeout(r,ms));
let ws,id=0; const pend=new Map(); const errs=[];
const send=(m,p={})=>new Promise((res,rej)=>{const i=++id;pend.set(i,{res,rej});ws.send(JSON.stringify({id:i,method:m,params:p}));});
const evl=async e=>(await send('Runtime.evaluate',{expression:e,returnByValue:true,awaitPromise:true})).result.value;
const pass=[]; const chk=(n,c)=>{pass.push(c);console.log(`  ${c?'✓':'✗'} ${n}`);};
const st=async()=>await evl(`({sel:wsSel.slice(),
  pressed:[...document.querySelectorAll('.wchip[aria-pressed=true]')].length,
  words:document.querySelectorAll('#wsWords .wlist > *').length,
  del:document.getElementById('wsDel').textContent,
  info:document.getElementById('wsSelInfo').textContent})`);
try{
  for(let i=0;i<40;i++){try{await fetch(`http://127.0.0.1:${PORT}/json/version`);break;}catch{await wait(250);}}
  let t;try{t=await (await fetch(`http://127.0.0.1:${PORT}/json/new?http://127.0.0.1:8787/`,{method:'PUT'})).json();}catch{}
  if(!t?.webSocketDebuggerUrl)t=(await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json()).find(x=>x.type==='page');
  ws=new WebSocket(t.webSocketDebuggerUrl); await new Promise(r=>ws.onopen=r);
  ws.onmessage=e=>{const m=JSON.parse(e.data);
    if(m.method==='Runtime.exceptionThrown')errs.push(m.params.exceptionDetails.exception?.description||m.params.exceptionDetails.text);
    if(m.id&&pend.has(m.id)){const p=pend.get(m.id);pend.delete(m.id);m.error?p.rej(new Error(m.error.message)):p.res(m.result);}};
  await send('Runtime.enable'); await send('Page.enable');
  await send('Page.navigate',{url:'http://127.0.0.1:8787/'}); await wait(2600);
  await evl(`document.querySelector('.tabs button[data-view="words"]').click()`); await wait(1700);

  chk('已經沒有「多選」按鈕', await evl(`!document.getElementById('wsMultiBtn')`));
  let r = await st();
  chk(`預設選一份（${r.words} 個字）`, r.sel.length === 1);
  console.log(`    提示：「${r.info}」`);

  const ids = await evl(`[...document.querySelectorAll('.wchip')].map(b=>+b.dataset.id)`);
  await evl(`document.querySelector('.wchip[data-id="${ids[1]}"]').click()`); await wait(1400);
  r = await st();
  chk(`直接點另一份就加選（${r.sel.length} 份、${r.words} 個字）`, r.sel.length === 2 && r.pressed === 2);
  chk(`刪除鍵變「${r.del}」`, r.del === '刪除選取的 2 份');

  // 字表數會隨使用者增刪而變，依實際份數決定測到幾份
  if (ids.length >= 3){
    await evl(`document.querySelector('.wchip[data-id="${ids[2]}"]').click()`); await wait(1400);
    r = await st();
    chk(`再加一份（${r.sel.length} 份、${r.words} 個字）`, r.sel.length === 3);
    console.log(`    提示：「${r.info}」`);
  } else {
    console.log(`    （只有 ${ids.length} 份字表，跳過「加到三份」）`);
  }

  await evl(`document.querySelector('.wchip[data-id="${ids[1]}"]').click()`); await wait(1400);
  r = await st();
  chk(`點已選的就取消（剩 ${r.sel.length} 份）`, r.sel.length === ids.length - 1 || r.sel.length === 1);

  await evl(`document.querySelector('.wchip[data-id="${ids[0]}"]').click()`); await wait(1200);
  await evl(`document.querySelector('.wchip[data-id="${ids[2]}"]').click()`); await wait(1200);
  r = await st();
  chk(`最後一份不可取消（還有 ${r.sel.length} 份）`, r.sel.length === 1);

  await evl(`document.getElementById('wsPanel').scrollIntoView({block:'start'})`); await wait(200);
  await evl(`scrollBy(0,-200)`); await wait(300);
  const s1=await send('Page.captureScreenshot',{format:'png'});
  writeFileSync(`${DIR}/toggle.png`, Buffer.from(s1.data,'base64'));

  chk('沒有 JS 錯誤', errs.length===0);
  for(const e of errs.slice(0,3)) console.log('      '+String(e).split('\n')[0]);
  console.log(`\n  ${pass.filter(Boolean).length}/${pass.length} 通過`);
} finally { chrome.kill(); }
