import { spawn } from 'node:child_process';
const CHROME='/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const PORT=9356;
const chrome=spawn(CHROME,['--headless','--disable-gpu','--no-sandbox','--hide-scrollbars',
  `--remote-debugging-port=${PORT}`,'--window-size=1000,900','about:blank'],{stdio:'ignore'});
const wait=ms=>new Promise(r=>setTimeout(r,ms));
let ws,id=0; const pend=new Map(); const errs=[];
const send=(m,p={})=>new Promise((res,rej)=>{const i=++id;pend.set(i,{res,rej});ws.send(JSON.stringify({id:i,method:m,params:p}));});
const evl=async e=>(await send('Runtime.evaluate',{expression:e,returnByValue:true,awaitPromise:true})).result.value;
const pass=[]; const chk=(n,c)=>{pass.push(c);console.log(`  ${c?'✓':'✗'} ${n}`);};
// 「換下一句」那一列已移除，提示文字跟著不見；現在只看輸入框的句子
const cur=async()=>await evl(`({s:document.getElementById('inp').value, hint:''})`);
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

  // 連點同一個標籤 5 次
  const seen = [];
  for (let i = 0; i < 5; i++){
    await evl(`document.querySelector('.chip[data-key="p1"]').click()`); await wait(750);
    const c = await cur(); seen.push(c.s);
    console.log(`    第 ${i+1} 次點「句型一」→ ${c.s.slice(0,44)}`);
  }
  chk('連點同一標籤會換句子', new Set(seen).size >= 4);

  // 點別的標籤＝回到該標籤的內建範例。提示文字那一列已移除，
  // 所以改成直接比對：點 p2、繞一圈再點回 p2，要拿到同一句。
  await evl(`document.querySelector('.chip[data-key="p2"]').click()`); await wait(700);
  let c = await cur();
  const p2first = c.s;
  await evl(`document.querySelector('.chip[data-key="p2"]').click()`); await wait(700);
  const p2second = (await cur()).s;
  await evl(`document.querySelector('.chip[data-key="p1"]').click()`); await wait(600);
  await evl(`document.querySelector('.chip[data-key="p2"]').click()`); await wait(700);
  chk(`點別的標籤回到內建範例（${p2first.slice(0,28)}）`,
      Boolean(p2first) && p2second !== p2first && (await cur()).s === p2first);

  // 走完一輪會回到內建範例。類別的句數會隨資料變動，所以動態挑一個來測。
  const counts = await evl(`sampleCounts`);
  const kind = Object.entries(counts).find(([, n]) => n > 0 && n <= 3)?.[0]
            ?? Object.entries(counts).sort((a, b) => a[1] - b[1])[0][0];
  const n = counts[kind];
  const loop = [];
  for (let i = 0; i <= n + 1; i++){
    await evl(`document.querySelector('.chip[data-key="${kind}"]').click()`); await wait(750);
    loop.push((await cur()).s.slice(0, 26));
  }
  console.log(`    ${kind}（${n} 句）循環：${loop.join(' → ')}`);
  chk(`走完 ${n} 句會回到內建範例`, loop[0] === loop[n + 1]);

  chk('沒有 JS 錯誤', errs.length===0);
  for(const e of errs.slice(0,3)) console.log('      '+String(e).split('\n')[0]);
  console.log(`\n  ${pass.filter(Boolean).length}/${pass.length} 通過`);
} finally { chrome.kill(); }
