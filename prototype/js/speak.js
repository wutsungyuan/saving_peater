// 朗讀：逐字標示與朗讀鈕（發聲由 speech.js 提供）。
// 經典腳本（不是 ES module）：和其他 js/*.js 共用全域，由 index.html 依固定順序載入，順序不能換。

// ===== 朗讀（發聲由 speech.js 提供，可整支抽換） =====
const spkCtl = document.getElementById('spkCtl');
const spkVoice = document.getElementById('spkVoice');
const spkRate = document.getElementById('spkRate');
let sayingCard = null;

function clearSaying(){
  for (const el of out.querySelectorAll('.w.saying')) el.classList.remove('saying');
  for (const el of out.querySelectorAll('.sent.saying')) el.classList.remove('saying');
  for (const b of out.querySelectorAll('.say[aria-pressed="true"]')){
    b.setAttribute('aria-pressed', 'false');
    b.querySelector('.txt').textContent = '朗讀';
  }
  sayingCard = null;
}

/** 唸到哪個字就標哪個字：用字元區間和單字 span 的座標取交集 */
function markWord(card, start, end){
  for (const el of card.querySelectorAll('.w.saying')) el.classList.remove('saying');
  if (!(end > start)) return;
  for (const el of card.querySelectorAll('.w[data-s]')){
    const s = Number(el.dataset.s), e = Number(el.dataset.e);
    if (s < end && e > start) el.classList.add('saying');
  }
}

function toggleSay(card){
  const btn = card.querySelector('.say');
  const text = card.dataset.sent || '';
  if (sayingCard === card){ Spk.stop(); return; }   // 再點一次＝停止
  clearSaying();
  if (!text) return;

  sayingCard = card;
  card.classList.add('saying');
  btn.setAttribute('aria-pressed', 'true');
  btn.querySelector('.txt').textContent = '停止';

  Spk.speak(text, {
    onWord: ({ start, end }) => { if (sayingCard === card) markWord(card, start, end); },
    onEnd: () => clearSaying(),
    onError: (err) => {
      clearSaying();
      btn.title = `朗讀失敗：${err.message}`;
    },
  });
}

out.addEventListener('click', e => {
  const b = e.target.closest('.say');
  if (b) toggleSay(b.closest('.sent'));
});
// 切換分頁、重新分析、離開頁面時都要停下來
document.addEventListener('keydown', e => { if (e.key === 'Escape') Spk.stop(); });
window.addEventListener('pagehide', () => Spk.stop());

(async () => {
  if (!Spk.available()) return;              // 瀏覽器根本沒有語音合成才維持隱藏
  // 不等語音清單載入完成就先顯示按鈕：iPhone（尤其 App 內嵌瀏覽畫面）的清單常常很晚才有，
  // 等不到就整個放棄的話，按鈕永遠不會出現。speak() 沒有指定語音時會用系統預設的英語。
  document.body.classList.add('has-speech');
  spkCtl.hidden = false;

  const fillVoices = () => {
    const list = Spk.voices();
    const active = Spk.activeVoice();
    spkVoice.innerHTML = list.map(v =>
      `<option value="${esc(v.id)}"${v.id === active?.id ? ' selected' : ''}>${esc(v.name)}${
        v.wordEvents ? '' : '（無逐字標示）'}</option>`).join('');
    spkVoice.disabled = !list.length;
  };
  spkRate.value = String(Spk.settings.rate);
  spkVoice.addEventListener('change', () => { Spk.stop(); Spk.setSettings({ voiceId: spkVoice.value }); });
  spkRate.addEventListener('change', () => { Spk.stop(); Spk.setSettings({ rate: Number(spkRate.value) }); });

  fillVoices();
  await Spk.ready();
  fillVoices();
  // 清單晚到（iOS）時再補一次
  try { speechSynthesis.addEventListener('voiceschanged', fillVoices); } catch {}
})();
