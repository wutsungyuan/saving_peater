// 口說的麥克風流程（前端 prototype/js/words.js 的 startMic）：用假的語音辨識物件與假時鐘驗證。
// 重點是 iPhone 上的行為：共用同一個辨識物件、結束後隔 0.5 秒才開下一次、完全沒聲音時換新的重開一次、
// 聽到聲音後安靜自動收尾、取消／示範時不誤記。跑法：node --no-warnings test/word-mic.mjs
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
const src = readFileSync(new URL('../prototype/js/words.js', import.meta.url), 'utf8');
const a = src.indexOf('// ===== 口說：按麥克風');
const b = src.indexOf("el('view-words').addEventListener('click', e => {\n  const b = e.target.closest('[data-mic]')");
if (a < 0 || b < 0) throw new Error('找不到區塊');
const block = src.slice(a, b);

let fail = 0;
const chk = (n, ok, d = '') => { console.log(`${ok ? '  ✓' : '  ✗'} ${n}${ok ? '' : '  ' + d}`); if (!ok) fail++; };

function scenario(name, run) {
  // 假時鐘
  let now = 0, timers = [], nextId = 1;
  const setTimeout_ = (fn, ms) => { const id = nextId++; timers.push({ id, at: now + ms, fn }); return id; };
  const clearTimeout_ = id => { timers = timers.filter(t => t.id !== id); };
  const advance = ms => { const end = now + ms; for (;;) { const t = timers.filter(x => x.at <= end).sort((p, q) => p.at - q.at)[0]; if (!t) break; now = t.at; timers = timers.filter(x => x !== t); t.fn(); } now = end; };
  const mk = () => { const cls = new Set(); return { classList: { add: (...c) => c.forEach(x => cls.add(x)), remove: (...c) => c.forEach(x => cls.delete(x)), has: x => cls.has(x), contains: x => cls.has(x) }, textContent: '', innerHTML: '', dataset: {}, disabled: false }; };
  const lbl = mk(); const box = mk(); const btn = { ...mk(), dataset: { mic: 'w1' }, querySelector: () => lbl };
  let recs = [];
  class Rec { constructor() { recs.push(this); this.stopped = false; this.aborted = false; }
    start() { this.started = true; } stop() { this.stopped = true; } abort() { this.aborted = true; setTimeout_(() => this.onend?.(), 0); } }
  const ctx = { document: { querySelector: s => s.startsWith('[data-heard') ? box : null }, esc: s => String(s), Spk: { stop() {} }, SpeechRec: Rec, SPEAK_TRIES: 3,
    wsHeard: {}, setTimeout: setTimeout_, clearTimeout: clearTimeout_, console, Date: { now: () => 1e9 + now } };
  vm.createContext(ctx);
  vm.runInContext(block + '\nthis.startMic = startMic; this.cancelMic = cancelMic; this.getRec = () => wsRec;', ctx);
  console.log(name);
  run({ ctx, btn, box, lbl, advance, rec: () => recs.at(-1), recs: () => recs });
}

scenario('邊唸邊顯示，有聲音後安靜 1.6 秒自動收尾', ({ ctx, btn, box, lbl, advance, rec }) => {
  ctx.startMic(btn); const r = rec();
  chk('開始：按鈕進入聽的狀態，但還沒有聲波', btn.classList.has('on') && !btn.classList.has('hear') && lbl.textContent === '等待麥克風…');
  r.onaudiostart(); chk('麥克風開了的提示', lbl.textContent === '麥克風開了，請開始唸');
  advance(1000); r.onspeechstart();
  chk('聽到聲音：聲波動起來', btn.classList.has('hear') && lbl.textContent === '聽到了，唸完會自動停');
  r.onresult({ resultIndex: 0, results: [Object.assign([{ transcript: 'Jo' }], { isFinal: false })] });
  chk('即時顯示聽到的字', /聽到：<b>Jo<\/b>/.test(box.innerHTML), box.innerHTML);
  advance(500); chk('沒有新聲音一下子，聲波停下來（但還在聽）', !btn.classList.has('hear') && btn.classList.has('on'));
  r.onresult({ resultIndex: 0, results: [Object.assign([{ transcript: 'Job' }], { isFinal: false })] });
  advance(1500); chk('安靜不到 1.6 秒：還沒收尾', !r.stopped);
  advance(200); chk('安靜超過 1.6 秒：自動 stop', r.stopped);
  r.onresult({ resultIndex: 0, results: [Object.assign([{ transcript: 'Job' }, { transcript: 'Chop' }], { isFinal: true })] });
  r.onend();
  chk('最終結果記下來（含候選）、次數 1', ctx.wsHeard.w1.tries === 1 && ctx.wsHeard.w1.said.join() === 'Job,Chop', JSON.stringify(ctx.wsHeard));
  chk('結束後按鈕回到可再按：再唸一次', !btn.classList.has('on') && lbl.textContent === '再唸一次' && ctx.getRec() === null);
});

scenario('stop 之後沒有最終結果：用最後聽到的當結果', ({ ctx, btn, box, advance, rec }) => {
  ctx.startMic(btn); const r = rec(); r.onspeechstart();
  r.onresult({ resultIndex: 0, results: [Object.assign([{ transcript: 'lesson' }], { isFinal: false })] });
  advance(2000); r.onend();
  chk('沿用最後的暫時結果、算一次', ctx.wsHeard.w1.tries === 1 && ctx.wsHeard.w1.said.join() === 'lesson', JSON.stringify(ctx.wsHeard));
});

scenario('開了麥克風 3.5 秒完全沒聲音：換全新的辨識物件自動重開一次（只一次）', ({ ctx, btn, box, lbl, advance, rec, recs }) => {
  ctx.startMic(btn); const r1 = rec();
  advance(3400); chk('3.5 秒前還在等、沒換物件', recs().length === 1 && !r1.aborted);
  advance(200); chk('3.5 秒：舊的丟掉（abort）、按鈕仍在聽的狀態', r1.aborted && btn.classList.has('on') && ctx.getRec() !== null);
  advance(400); chk('隔 0.5 秒後用全新的物件重開', recs().length === 2 && recs()[1].started === true && recs()[1] !== r1, String(recs().length));
  const r2 = rec();
  advance(3600); chk('重開後再沒聲音：不會無限重開', recs().length === 2 && !r2.aborted);
  advance(3600); chk('重開後 7 秒仍沒聲音：中止並提示', r2.aborted);
  advance(10);
  chk('提示沒聽到聲音、不算次數、按鈕回復', box.textContent === '沒有聽到聲音，靠近一點再按一次。' && !(ctx.wsHeard.w1.tries) && !btn.classList.has('on') && lbl.textContent === '按一下，開始唸', `${box.textContent}|${ctx.wsHeard.w1.tries}|${lbl.textContent}`);
});

scenario('第二次按「再唸一次」：重用同一個辨識物件、隔 0.5 秒才開（iPhone 第二次收不到聲音的問題）', ({ ctx, btn, box, advance, rec, recs }) => {
  ctx.startMic(btn); const r = rec(); r.onspeechstart();
  r.onresult({ resultIndex: 0, results: [Object.assign([{ transcript: 'Clan' }], { isFinal: true })] }); r.onend();
  chk('第一次結束', ctx.wsHeard.w1.tries === 1 && r.started);
  r.started = false;
  advance(100); ctx.startMic(btn);                 // 結束後 0.1 秒就按
  chk('馬上按：還沒開始（要等滿 0.5 秒）', recs().length === 1 && !r.started && btn.classList.has('on'));
  advance(300); chk('0.4 秒：還在等', !r.started);
  advance(150); chk('超過 0.5 秒：用同一個物件開始', r.started && recs().length === 1, String(recs().length));
  r.onspeechstart(); chk('第二次可以聽到聲音', btn.classList.has('hear'));
});

scenario('等待期間又按一次＝取消，不會偷偷開始', ({ ctx, btn, box, advance, rec, recs }) => {
  ctx.startMic(btn); const r = rec(); r.onspeechstart();
  r.onresult({ resultIndex: 0, results: [Object.assign([{ transcript: 'a' }], { isFinal: true })] }); r.onend(); r.started = false;
  ctx.startMic(btn);                                // 等待中
  ctx.startMic(btn);                                // 再按＝取消
  advance(2000);
  chk('取消了：沒有開始、按鈕回復、顯示已取消', !r.started && !btn.classList.has('on') && box.textContent === '已取消。', box.textContent);
  chk('取消沒有留下旗標，下一次正常', !box.dataset.msg);
});

scenario('上一次一直沒結束（卡住）：等 1.5 秒後丟掉換新的', ({ ctx, btn, advance, rec, recs }) => {
  ctx.startMic(btn); const r = rec(); r.onspeechstart();   // 在聽
  r.started = false;
  ctx.startMic(btn); ctx.startMic(btn);                    // 取消後馬上再按；舊的 abort 後 onend 要過一下才來
  chk('再按時舊的還沒結束：新的一次排隊等待、按鈕保持在聽的狀態', !r.started && btn.classList.has('on'));
  advance(5); chk('舊的 onend 來了：不會把新那次的按鈕重置掉', btn.classList.has('on'));
  advance(700);
  chk('新的一次用同一個物件開始', r.started && recs().length === 1 && btn.classList.has('on'), `started=${r.started} recs=${recs().length}`);
});

scenario('唸到一半停頓很久，最長 15 秒也會收尾', ({ ctx, btn, advance, rec }) => {
  ctx.startMic(btn); const r = rec();
  for (let t = 0; t < 14; t++) { advance(1000); r.onspeechstart(); }  // 一直有聲音
  chk('14 秒內持續有聲音：不會被安靜計時收掉？（每次聲音重新計時）', !r.stopped);
  advance(1000); chk('到 15 秒：強制 stop', r.stopped);
});

scenario('再按一次＝取消', ({ ctx, btn, box, advance, rec }) => {
  ctx.startMic(btn); const r = rec(); r.onspeechstart();
  ctx.startMic(btn);
  chk('取消：abort、顯示已取消', r.aborted && box.textContent === '已取消。');
  advance(10); chk('取消後 onend 不會把「已取消」蓋掉，也不算次數', box.textContent === '已取消。' && !ctx.wsHeard.w1.tries, box.textContent);
});

scenario('沒有權限：顯示說明，不被 onend 蓋掉', ({ ctx, btn, box, rec }) => {
  ctx.startMic(btn); const r = rec(); r.onerror({ error: 'not-allowed' }); r.onend();
  chk('權限提示', /沒有麥克風權限/.test(box.textContent), box.textContent);
});

scenario('三次用完不能再按', ({ ctx, btn, rec, recs }) => {
  ctx.startMic(btn);
  for (let i = 0; i < 3; i++) { ctx.wsHeard.w1.tries = 3; }
  const before = recs().length; ctx.startMic(btn);
  chk('超過次數不再啟動辨識', recs().length === before);
});

scenario('聽示範時麥克風還開著：取消收音，不算嘗試，不被蓋掉訊息', ({ ctx, btn, box, advance, rec }) => {
  ctx.startMic(btn); const r = rec(); r.onspeechstart();
  r.onresult({ resultIndex: 0, results: [Object.assign([{ transcript: 'Jo' }], { isFinal: false })] });
  const was = ctx.cancelMic('剛才的錄音取消了');
  chk('回傳被取消的那組、abort 了', was?.btn === btn && r.aborted);
  advance(10);
  chk('訊息保留、沒有把暫時結果記成一次作答', box.textContent === '剛才的錄音取消了' && !ctx.wsHeard.w1.tries && ctx.wsHeard.w1.said.length === 0, box.textContent + JSON.stringify(ctx.wsHeard));
  chk('按鈕回復、可以再按', !btn.classList.has('on') && ctx.getRec() === null);
  chk('沒在聽時取消＝什麼都不做', ctx.cancelMic() === null);
});

console.log(fail ? `\n${fail} 項失敗` : '\n全部通過');
process.exit(fail ? 1 : 0);
