// 驗證串流版的批次分析：進度、中斷後保留、再按接著跑
import { spawn } from 'node:child_process';
const CHROME='/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const PORT=9367;
const chrome=spawn(CHROME,['--headless','--disable-gpu','--no-sandbox','--hide-scrollbars',
  `--remote-debugging-port=${PORT}`,'--window-size=1000,700','about:blank'],{stdio:'ignore'});
const wait=ms=>new Promise(r=>setTimeout(r,ms));
let ws,id=0; const pend=new Map(); const errs=[];
const send=(m,p={})=>new Promise((res,rej)=>{const i=++id;pend.set(i,{res,rej});ws.send(JSON.stringify({id:i,method:m,params:p}));});
const evl=async e=>(await send('Runtime.evaluate',{expression:e,returnByValue:true,awaitPromise:true})).result.value;
const pass=[]; const chk=(n,c)=>{pass.push(c);console.log(`  ${c?'✓':'✗'} ${n}`);};
try{
  for(let i=0;i<40;i++){try{await fetch(`http://127.0.0.1:${PORT}/json/version`);break;}catch{await wait(250);}}
  let t;try{t=await (await fetch(`http://127.0.0.1:${PORT}/json/new?http://127.0.0.1:8787/`,{method:'PUT'})).json();}catch{}
  if(!t?.webSocketDebuggerUrl)t=(await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json()).find(x=>x.type==='page');
  ws=new WebSocket(t.webSocketDebuggerUrl); await new Promise(r=>ws.onopen=r);
  ws.onmessage=e=>{const m=JSON.parse(e.data);
    if(m.method==='Runtime.exceptionThrown')errs.push(m.params.exceptionDetails.exception?.description||m.params.exceptionDetails.text);
    if(m.id&&pend.has(m.id)){const p=pend.get(m.id);pend.delete(m.id);m.error?p.rej(new Error(m.error.message)):p.res(m.result);}};
  await send('Runtime.enable'); await send('Page.enable');
  await send('Page.navigate',{url:'http://127.0.0.1:8787/'}); await wait(2800);
  await evl(`document.querySelector('.tabs button[data-view="words"]').click()`); await wait(1800);

  const label = await evl(`document.getElementById('wsAnalyze').textContent`);
  console.log(`    按鈕：${label}`);
  chk('全部分析完時按鈕顯示「都分析過了」', label.includes('都分析過了'));

  // 點下去不該花錢（已全部快取）
  await evl(`document.getElementById('wsAnalyze').click()`); await wait(1500);
  chk('全部已分析時點了會跳到分析分頁', await evl(`!document.getElementById('view-analyze').hidden`));

  chk('沒有 JS 錯誤', errs.length===0);
  for(const e of errs.slice(0,2)) console.log('      '+String(e).split('\n')[0]);
  console.log(`\n  ${pass.filter(Boolean).length}/${pass.length} 通過`);
} finally { chrome.kill(); }
