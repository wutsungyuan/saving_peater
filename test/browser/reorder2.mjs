// 真的做一次測驗、故意答錯一半，看兩個分頁的重排是否生效
import { spawn } from 'node:child_process';
import { mkdirSync } from 'node:fs';
// 截圖放專案裡的 test/browser/out（已 gitignore）
const OUT = new URL('./out/', import.meta.url).pathname;
mkdirSync(OUT, { recursive: true });

import { writeFileSync } from 'node:fs';
const CHROME='/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const PORT=9362, DIR=OUT;
const chrome=spawn(CHROME,['--headless','--disable-gpu','--no-sandbox','--hide-scrollbars',
  `--remote-debugging-port=${PORT}`,'--window-size=1000,900','about:blank'],{stdio:'ignore'});
const wait=ms=>new Promise(r=>setTimeout(r,ms));
let ws,id=0; const pend=new Map(); const errs=[];
const send=(m,p={})=>new Promise((res,rej)=>{const i=++id;pend.set(i,{res,rej});ws.send(JSON.stringify({id:i,method:m,params:p}));});
const evl=async e=>(await send('Runtime.evaluate',{expression:e,returnByValue:true,awaitPromise:true})).result.value;
const pass=[]; const chk=(n,c)=>{pass.push(c);console.log(`  ${c?'✓':'✗'} ${n}`);};
/** 等條件成立，不要用固定秒數 —— 機器忙的時候出題會比預期久，
 *  固定等待會讓測試時好時壞，看起來像功能壞了。 */
const until = async (expr, ms=30000) => {
  const t0 = Date.now();
  while (Date.now() - t0 < ms){
    if (await evl(expr)) return true;
    await wait(300);
  }
  return false;
};
try{
  for(let i=0;i<40;i++){try{await fetch(`http://127.0.0.1:${PORT}/json/version`);break;}catch{await wait(250);}}
  let t;try{t=await (await fetch(`http://127.0.0.1:${PORT}/json/new?http://127.0.0.1:8787/`,{method:'PUT'})).json();}catch{}
  if(!t?.webSocketDebuggerUrl)t=(await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json()).find(x=>x.type==='page');
  ws=new WebSocket(t.webSocketDebuggerUrl); await new Promise(r=>ws.onopen=r);
  ws.onmessage=e=>{const m=JSON.parse(e.data);
    if(m.method==='Runtime.exceptionThrown')errs.push(m.params.exceptionDetails.exception?.description||m.params.exceptionDetails.text);
    if(m.method==='Runtime.consoleAPICalled'&&m.params.type==='error')
      errs.push(m.params.args.map(a=>a.value??a.description).join(' '));
    if(m.id&&pend.has(m.id)){const p=pend.get(m.id);pend.delete(m.id);m.error?p.rej(new Error(m.error.message)):p.res(m.result);}};
  await send('Runtime.enable'); await send('Page.enable');
  await send('Page.navigate',{url:'http://127.0.0.1:8787/'}); await wait(2800);

  // ---- 句型練習 ----
  await evl(`document.querySelector('.tabs button[data-view="practice"]').click()`); await wait(1000);
  await evl(`document.getElementById('quizStart').click()`);
  chk('句型練習出得了題', await until(`document.querySelectorAll('#quizOut .q').length > 0`));
  // 偶數題亂答（必錯），奇數題留空（也錯）→ 改成只填一半製造對錯交錯
  await evl(`(()=>{
    const cards=[...document.querySelectorAll('#quizOut .q')];
    cards.forEach((c,i)=>{
      if (i % 2) return;                       // 奇數位留空
      const radio=c.querySelector('input[type=radio]');
      if (radio){ radio.checked=true; return; }
      c.querySelectorAll('input[type=text]').forEach(x=>{ x.value='zzz'; });
    });
  })()`);
  await evl(`document.getElementById('quizSubmit').click()`);
  await until(`document.querySelectorAll('#quizOut .q.graded').length > 0`);
  await wait(400);
  let r = await evl(`(()=>{
    const cards=[...document.querySelectorAll('#quizOut > *')];
    const seq = cards.map(c => c.classList.contains('okdiv') ? '|' : (c.classList.contains('ng') ? 'X' : (c.classList.contains('ok') ? 'O' : '?')));
    return { seq: seq.join(''), hasDiv: seq.includes('|'),
      firstOk: seq.indexOf('O'), lastNg: seq.lastIndexOf('X') };
  })()`);
  console.log(`    句型練習排序：${r.seq}  （X=答錯 O=答對 |=分隔線）`);
  chk('句型練習：答錯的全部排在答對的前面', r.lastNg < r.firstOk);
  chk('句型練習：有分隔線', r.hasDiv);

  await evl(`document.querySelector('#quizOut .ng')?.scrollIntoView({block:'start'})`); await wait(300);
  const s1=await send('Page.captureScreenshot',{format:'png'});
  writeFileSync(`${DIR}/reorder-q.png`, Buffer.from(s1.data,'base64'));

  // ---- 單字測驗（確認沒有被改壞）----
  await evl(`document.querySelector('.tabs button[data-view="words"]').click()`); await wait(1600);
  await evl(`[...document.querySelectorAll('.subtabs button')].find(b=>b.textContent==='單字測驗').click()`); await wait(400);
  await evl(`document.getElementById('wsStart').click()`);
  chk('單字測驗出得了題', await until(`document.querySelectorAll('#wsOut .q').length > 0`));
  await evl(`(()=>{
    const cards=[...document.querySelectorAll('#wsOut .q')];
    cards.forEach((c,i)=>{
      if (i % 2) return;
      const radio=c.querySelector('input[type=radio]');
      if (radio){ radio.checked=true; return; }
      c.querySelectorAll('input[type=text]').forEach(x=>{ x.value='zzz'; });
    });
  })()`);
  await evl(`document.getElementById('wsSubmit').click()`);
  await until(`document.querySelectorAll('#wsOut .q.graded').length > 0`);
  await wait(400);
  r = await evl(`(()=>{
    const cards=[...document.querySelectorAll('#wsOut > *')];
    const seq = cards.map(c => c.classList.contains('okdiv') ? '|' : (c.classList.contains('ng') ? 'X' : (c.classList.contains('ok') ? 'O' : '?')));
    return { seq: seq.join(''), firstOk: seq.indexOf('O'), lastNg: seq.lastIndexOf('X') };
  })()`);
  console.log(`    單字測驗排序：${r.seq}`);
  // 全對或全錯本來就不重排（沒有東西要排到前面），那種情況只要確認沒出錯
  const allSame = r.firstOk < 0 || r.lastNg < 0;
  chk(allSame ? `單字測驗：${r.firstOk < 0 ? '全錯' : '全對'}，依設計不重排`
              : '單字測驗：答錯的仍排在前面', allSame || r.lastNg < r.firstOk);

  chk('沒有 JS 錯誤', errs.length===0);
  for(const e of errs.slice(0,3)) console.log('      '+String(e).split('\n')[0]);
  console.log(`\n  ${pass.filter(Boolean).length}/${pass.length} 通過`);
} finally { chrome.kill(); }
