import { spawn } from 'node:child_process';
import { mkdirSync } from 'node:fs';
// 截圖放專案裡的 test/browser/out（已 gitignore）
const OUT = new URL('./out/', import.meta.url).pathname;
mkdirSync(OUT, { recursive: true });

import { writeFileSync } from 'node:fs';
const CHROME='/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const PORT=9355, DIR=OUT;
const chrome=spawn(CHROME,['--headless','--disable-gpu','--no-sandbox','--hide-scrollbars',
  `--remote-debugging-port=${PORT}`,'--window-size=1000,900','about:blank'],{stdio:'ignore'});
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
  await send('Page.navigate',{url:'http://127.0.0.1:8787/'}); await wait(3000);

  // 「換下一句」那一列已經移除 —— 現在再點一次同一個標籤就是換下一句。
  const line = async () => await evl(`document.getElementById('inp').value`);

  await evl(`document.querySelector('.chip[data-key="p4"]').click()`); await wait(700);
  const first = await line();
  chk('點句型四載入範例', Boolean(first));
  console.log(`    現在顯示：${first.slice(0,44)}`);

  const seen = [first];
  for (let i = 0; i < 3; i++){
    await evl(`document.querySelector('.chip[data-key="p4"]').click()`); await wait(800);
    const v = await line(); seen.push(v);
    console.log(`    再點第 ${i+1} 次 → ${v.slice(0,44)}`);
  }
  chk('再點同一標籤會換句子', new Set(seen).size > 1);
  chk('句子都不是空的', seen.every(Boolean));

  // 換去別的標籤再回來，應該回到那一類的第一句
  await evl(`document.querySelector('.chip[data-key="p1"]').click()`); await wait(600);
  await evl(`document.querySelector('.chip[data-key="p4"]').click()`); await wait(700);
  chk('換個標籤再點回來＝回到第一句', (await line()) === first);

  await evl(`document.querySelector('.chip[data-key="splitVerb"]').click()`); await wait(700);
  const only = await line();
  await evl(`document.querySelector('.chip[data-key="splitVerb"]').click()`); await wait(700);
  await evl(`document.querySelector('.chip[data-key="splitVerb"]').click()`); await wait(700);
  chk('只有 1 句的類別重複點不會壞',
      (await evl(`document.querySelectorAll('#out .sent').length`)) === 1 && Boolean(only));

  await evl(`document.querySelector('.chip[data-key="p1"]').click()`); await wait(600);
  await evl(`document.querySelector('.chip[data-key="p1"]').click()`); await wait(700);
  await evl(`document.querySelector('#out .sent').scrollIntoView({block:'start'})`); await wait(300);
  await evl(`scrollBy(0,-260)`); await wait(300);
  const s1=await send('Page.captureScreenshot',{format:'png'});
  writeFileSync(`${DIR}/samples.png`, Buffer.from(s1.data,'base64'));

  chk('沒有 JS 錯誤', errs.length===0);
  for(const e of errs.slice(0,3)) console.log('      '+String(e).split('\n')[0]);
  console.log(`\n  ${pass.filter(Boolean).length}/${pass.length} 通過`);
} finally { chrome.kill(); }
