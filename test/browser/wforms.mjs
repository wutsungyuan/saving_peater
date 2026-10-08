import { spawn } from 'node:child_process';
import { mkdirSync } from 'node:fs';
// 截圖放專案裡的 test/browser/out（已 gitignore）
const OUT = new URL('./out/', import.meta.url).pathname;
mkdirSync(OUT, { recursive: true });

import { writeFileSync } from 'node:fs';
const CHROME='/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const PORT=9366, DIR=OUT;
const chrome=spawn(CHROME,['--headless','--disable-gpu','--no-sandbox','--hide-scrollbars',
  `--remote-debugging-port=${PORT}`,'--window-size=1000,620','about:blank'],{stdio:'ignore'});
const wait=ms=>new Promise(r=>setTimeout(r,ms));
let ws,id=0; const pend=new Map(); const errs=[];
const send=(m,p={})=>new Promise((res,rej)=>{const i=++id;pend.set(i,{res,rej});ws.send(JSON.stringify({id:i,method:m,params:p}));});
const evl=async e=>(await send('Runtime.evaluate',{expression:e,returnByValue:true,awaitPromise:true})).result.value;
const pass=[]; const chk=(n,c)=>{pass.push(c);console.log(`  ${c?'✓':'✗'} ${n}`);};
const until=async(e,ms=30000)=>{const t0=Date.now();while(Date.now()-t0<ms){if(await evl(e))return true;await wait(300);}return false;};
try{
  for(let i=0;i<40;i++){try{await fetch(`http://127.0.0.1:${PORT}/json/version`);break;}catch{await wait(250);}}
  let t;try{t=await (await fetch(`http://127.0.0.1:${PORT}/json/new?http://127.0.0.1:8787/`,{method:'PUT'})).json();}catch{}
  if(!t?.webSocketDebuggerUrl)t=(await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json()).find(x=>x.type==='page');
  ws=new WebSocket(t.webSocketDebuggerUrl); await new Promise(r=>ws.onopen=r);
  ws.onmessage=e=>{const m=JSON.parse(e.data);
    if(m.method==='Runtime.exceptionThrown')errs.push(m.params.exceptionDetails.exception?.description||m.params.exceptionDetails.text);
    if(m.method==='Runtime.consoleAPICalled'&&m.params.type==='error')errs.push(m.params.args.map(a=>a.value??a.description).join(' '));
    if(m.id&&pend.has(m.id)){const p=pend.get(m.id);pend.delete(m.id);m.error?p.rej(new Error(m.error.message)):p.res(m.result);}};
  await send('Runtime.enable'); await send('Page.enable');
  await send('Page.navigate',{url:'http://127.0.0.1:8787/'}); await wait(2800);
  await evl(`document.querySelector('.tabs button[data-view="words"]').click()`); await wait(1600);
  await evl(`[...document.querySelectorAll('.subtabs button')].find(b=>b.textContent==='單字測驗').click()`); await wait(400);
  await evl(`(()=>{for(const c of document.querySelectorAll('#wsModes [data-m]')) c.setAttribute('aria-pressed', c.dataset.m==='forms'?'true':'false');})()`);
  await evl(`document.getElementById('wsStart').click()`);
  chk('出得了三態題', await until(`document.querySelectorAll('#wsOut .q').length > 0`));

  const r = await evl(`(()=>{const q=document.querySelector('#wsOut .q');
    return { inputs: q.querySelectorAll('.q-blanks input').length,
             ph: [...q.querySelectorAll('.q-blanks input')].map(x=>x.placeholder),
             prompt: q.querySelector('.q-prompt').textContent };})()`);
  console.log(`    ${r.prompt}`);
  chk(`每題有 2 個輸入框（${r.inputs} 個，提示 ${r.ph.join('／')}）`, r.inputs === 2);

  // 用正解作答
  const ans = await evl(`(async()=>{
    const probe = await fetch('/api/wordattempts', {method:'POST',headers:{'content-type':'application/json'},
      body: JSON.stringify({ quizId: wsQuiz.quizId, userToken: USER, answers: {} })}).then(r=>r.json());
    return Object.fromEntries(probe.results.map(r => [r.id, r.expected]));
  })()`);
  await evl(`(()=>{const a=${JSON.stringify(ans)};
    for (const [id, vals] of Object.entries(a)){
      const ins=[...document.querySelectorAll('input[data-q="'+id+'"]')];
      ins.forEach((x,i)=>{ x.value = vals[i] ?? ''; });
    }})()`);
  await evl(`document.getElementById('wsSubmit').click()`);
  await until(`document.querySelectorAll('#wsOut .q.graded').length > 0`);
  await wait(500);
  const res = await evl(`(()=>{const s=document.getElementById('wsSummary').innerText;
    return { sum: s.split('\\n')[0], ng: document.querySelectorAll('#wsOut .q.ng').length };})()`);
  console.log(`    ${res.sum}`);
  chk('用正解作答全部答對', res.ng === 0);

  await evl(`document.querySelector('#wsOut .q')?.scrollIntoView({block:'start'})`); await wait(300);
  const s1=await send('Page.captureScreenshot',{format:'png'});
  writeFileSync(`${DIR}/wforms2.png`, Buffer.from(s1.data,'base64'));
  chk('沒有 JS 錯誤', errs.length===0);
  for(const e of errs.slice(0,2)) console.log('      '+String(e).split('\n')[0]);
  console.log(`\n  ${pass.filter(Boolean).length}/${pass.length} 通過`);
} finally { chrome.kill(); }
