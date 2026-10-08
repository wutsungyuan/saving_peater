import { spawn } from 'node:child_process';
import { mkdirSync } from 'node:fs';
// 截圖放專案裡的 test/browser/out（已 gitignore）
const OUT = new URL('./out/', import.meta.url).pathname;
mkdirSync(OUT, { recursive: true });

import { writeFileSync } from 'node:fs';
const CHROME='/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const PORT=9349, DIR=OUT;
const chrome=spawn(CHROME,['--headless','--disable-gpu','--no-sandbox','--hide-scrollbars',
  `--remote-debugging-port=${PORT}`,'--window-size=1000,760','about:blank'],{stdio:'ignore'});
const wait=ms=>new Promise(r=>setTimeout(r,ms));
let ws,id=0; const pend=new Map(); const errs=[];
const send=(m,p={})=>new Promise((res,rej)=>{const i=++id;pend.set(i,{res,rej});ws.send(JSON.stringify({id:i,method:m,params:p}));});
const evl=async e=>(await send('Runtime.evaluate',{expression:e,returnByValue:true,awaitPromise:true})).result.value;
const type=async v=>{ await evl(`(()=>{const n=document.getElementById('wsName');n.value=${JSON.stringify(v)};n.dispatchEvent(new Event('input'));})()`); await wait(250); };
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
  await send('Page.navigate',{url:'http://127.0.0.1:8787/'}); await wait(2600);
  await evl(`document.querySelector('.tabs button[data-view="words"]').click()`); await wait(1600);
  await evl(`document.getElementById('wsNew').click()`); await wait(600);

  let r = await evl(`({chips:document.getElementById('wsList').hidden,
    bar:document.getElementById('wsBar').hidden,
    newBtn:document.getElementById('wsNew').textContent,
    opts:[...document.querySelectorAll('#wsSetNames option')].map(o=>o.value)})`);
  chk('字表卡隱藏', r.chips);
  chk('刪除那一列隱藏', r.bar);
  chk(`按鈕文字是「${r.newBtn}」`, r.newBtn.includes('回到單字表'));
  // 不要寫死份數 —— 使用者會自己增刪字表，寫死的話資料一變就假失敗
  const nSets = await evl(`wsAllSets.length`);
  chk(`下拉選單列出全部 ${nSets} 份既有字表`, r.opts.length === nSets && nSets > 0);
  console.log('    可選：' + r.opts.join('｜'));

  r = await evl(`({btn:document.getElementById('wsCreate').textContent,
    hint:document.getElementById('wsDestHint').textContent})`);
  chk('空白時＝建立新字表', r.btn === '建立新字表' && r.hint.includes('沒有輸入名稱'));

  await type('Unit 3');
  r = await evl(`({btn:document.getElementById('wsCreate').textContent, hint:document.getElementById('wsDestHint').textContent})`);
  chk(`打新名字 → 「${r.btn}」`, r.btn === '建立新字表' && r.hint.includes('Unit 3'));

  const exist = (await evl(`wsAllSets[0].name`));
  await type(exist);
  r = await evl(`({btn:document.getElementById('wsCreate').textContent, hint:document.getElementById('wsDestHint').textContent})`);
  chk(`選既有的「${exist.slice(0,16)}…」→ 「${r.btn}」`, r.btn === '加進這份字表' && r.hint.includes('會加進既有的'));
  chk('說明有提到不會重複', r.hint.includes('不會重複'));

  await type(exist.toUpperCase());
  chk('大小寫不同也認得出同一份', await evl(`destOf().setId`) > 0);

  await evl(`document.getElementById('wsForm').scrollIntoView({block:'start'})`); await wait(300);
  const s1=await send('Page.captureScreenshot',{format:'png'});
  writeFileSync(`${DIR}/combo.png`, Buffer.from(s1.data,'base64'));

  await evl(`document.getElementById('wsNew').click()`); await wait(500);
  r = await evl(`({chips:document.getElementById('wsList').hidden, newBtn:document.getElementById('wsNew').textContent})`);
  chk('回到單字表後字表卡回來', !r.chips && r.newBtn.includes('新增字表'));
  chk('沒有 JS 錯誤', errs.length===0);
  for(const e of errs.slice(0,3)) console.log('      '+String(e).split('\n')[0]);
  console.log(`\n  ${pass.filter(Boolean).length}/${pass.length} 通過`);
} finally { chrome.kill(); }
