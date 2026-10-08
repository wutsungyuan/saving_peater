import { spawn } from 'node:child_process';
const CHROME='/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const PORT=9339, W=Number(process.argv[2]||1280), H=900;
const chrome=spawn(CHROME,['--headless','--disable-gpu','--no-sandbox','--hide-scrollbars',
  `--remote-debugging-port=${PORT}`,`--window-size=${W},${H}`,'about:blank'],{stdio:'ignore'});
const wait=ms=>new Promise(r=>setTimeout(r,ms));
let ws,id=0; const pend=new Map(); const errs=[];
const send=(m,p={})=>new Promise((res,rej)=>{const i=++id;pend.set(i,{res,rej});ws.send(JSON.stringify({id:i,method:m,params:p}));});
const evl=async e=>(await send('Runtime.evaluate',{expression:e,returnByValue:true,awaitPromise:true})).result.value;
try{
  for(let i=0;i<40;i++){try{await fetch(`http://127.0.0.1:${PORT}/json/version`);break;}catch{await wait(250);}}
  let t;try{t=await (await fetch(`http://127.0.0.1:${PORT}/json/new?http://127.0.0.1:8787/`,{method:'PUT'})).json();}catch{}
  if(!t?.webSocketDebuggerUrl)t=(await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json()).find(x=>x.type==='page');
  ws=new WebSocket(t.webSocketDebuggerUrl); await new Promise(r=>ws.onopen=r);
  ws.onmessage=e=>{const m=JSON.parse(e.data);
    if(m.method==='Runtime.exceptionThrown')errs.push(m.params.exceptionDetails.exception?.description||m.params.exceptionDetails.text);
    if(m.id&&pend.has(m.id)){const p=pend.get(m.id);pend.delete(m.id);m.error?p.rej(new Error(m.error.message)):p.res(m.result);}};
  await send('Runtime.enable'); await send('Page.enable');
  await send('Emulation.setDeviceMetricsOverride',{width:W,height:H,deviceScaleFactor:2,mobile:W<=560});
  await send('Page.navigate',{url:'http://127.0.0.1:8787/'}); await wait(2600);
  await evl(`document.querySelector('.tabs button[data-view="words"]').click()`); await wait(1800);

  const pass=[]; const chk=(n,c)=>{pass.push(c);console.log(`  ${c?'✓':'✗'} ${n}`);};
  const st=async()=>await evl(`({
    list: !document.getElementById('pane-list').hidden,
    quiz: !document.getElementById('pane-quiz').hidden,
    pressed: [...document.querySelectorAll('.subtabs button')].filter(b=>b.getAttribute('aria-pressed')==='true').map(b=>b.textContent)[0],
    words: document.querySelectorAll('#wsWords .wcard, #wsWords .wlist > *').length,
  })`);

  let r = await st();
  chk(`預設顯示「單字清單」（目前：${r.pressed}）`, r.list && !r.quiz && r.pressed === '單字清單');
  chk(`清單直接看得到單字（${r.words} 張卡）`, r.words > 0);
  chk('批次分析鍵在子頁列上', await evl(`document.getElementById('wsAnalyze').closest('.subrow') !== null`));

  await evl(`[...document.querySelectorAll('.subtabs button')].find(b=>b.textContent==='單字測驗').click()`);
  await wait(400);
  r = await st();
  chk('切到「單字測驗」', !r.list && r.quiz && r.pressed === '單字測驗');
  chk('測驗設定在這一頁', await evl(`document.getElementById('wsStart').closest('#pane-quiz') !== null`));

  await evl(`[...document.querySelectorAll('.subtabs button')].find(b=>b.textContent==='單字清單').click()`);
  await wait(400);
  chk('切回清單', (await st()).list);

  // 從清單頁按出題（先切到測驗頁才按得到），確認出題後停在測驗頁
  await evl(`[...document.querySelectorAll('.subtabs button')].find(b=>b.textContent==='單字測驗').click()`);
  await wait(300);
  await evl(`document.getElementById('wsStart').click()`); await wait(2600);
  r = await st();
  const qn = await evl(`document.querySelectorAll('#wsOut .wq, #wsOut > *').length`);
  chk(`出題後停在測驗頁（${qn} 題）`, r.quiz && !r.list && qn > 0);
  chk('交卷鍵出現', await evl(`!document.getElementById('wsActions').hidden`));

  // 出題後切回清單，題目還在
  await evl(`[...document.querySelectorAll('.subtabs button')].find(b=>b.textContent==='單字清單').click()`);
  await wait(300);
  chk('切回清單時題目保留（沒被清掉）', await evl(`document.querySelectorAll('#wsOut > *').length`) > 0);
  await evl(`[...document.querySelectorAll('.subtabs button')].find(b=>b.textContent==='單字測驗').click()`);
  await wait(300);
  chk('切回測驗仍看得到題目', await evl(`!document.getElementById('pane-quiz').hidden && document.querySelectorAll('#wsOut > *').length > 0`));

  chk('沒有 JS 錯誤', errs.length===0);
  for(const e of errs.slice(0,3)) console.log('      '+String(e).split('\n')[0]);
  console.log(`\n  ${pass.filter(Boolean).length}/${pass.length} 通過`);
} finally { chrome.kill(); }
