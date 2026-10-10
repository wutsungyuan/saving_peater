// 手機的左右邊緣抽屜（句子成分、詞性與格位）。
// 經典腳本（不是 ES module）：和其他 js/*.js 共用全域，由 index.html 依固定順序載入，順序不能換。

// ===== 手機的邊緣抽屜：句子成分在左、詞性與格位在右 =====
// 圖例在手機上佔掉一整屏，收到邊緣去。從邊緣往內滑可以拉出來，
// 但純手勢沒有任何提示，第一次用的人不會知道，所以邊緣也放了把手。
(() => {
  const phone = () => matchMedia('(max-width:560px)').matches;
  const scrim = el('scrim');
  const D = {
    l: { box: el('drawer-c'), btn: el('edgeL'), src: 'rail-c', sign: -1 },
    r: { box: el('drawer-p'), btn: el('edgeR'), src: 'rail-p', sign:  1 },
  };
  // 抽屜內容沿用側欄，不另外維護一份
  for (const k of ['l','r']){
    D[k].box.innerHTML = '<button class="closer">關閉</button>' + el(D[k].src).innerHTML;
  }

  let open = null;                 // 'l' | 'r' | null
  const setOpen = (k) => {
    for (const x of ['l','r']){
      const on = x === k;
      D[x].box.classList.toggle('open', on);
      D[x].box.classList.remove('drag');
      D[x].box.style.transform = '';
      D[x].box.setAttribute('aria-hidden', String(!on));
      D[x].btn.setAttribute('aria-expanded', String(on));
    }
    scrim.classList.toggle('on', Boolean(k));
    open = k || null;
  };
  const close = () => setOpen(null);

  for (const k of ['l','r']){
    D[k].btn.addEventListener('click', () => setOpen(open === k ? null : k));
    D[k].box.querySelector('.closer').addEventListener('click', close);
  }
  scrim.addEventListener('click', close);
  addEventListener('keydown', e => { if (e.key === 'Escape' && open) close(); });
  // 轉成桌機寬度時要收掉，否則抽屜會留在畫面上
  matchMedia('(max-width:560px)').addEventListener('change', () => { if (!phone()) close(); });

  // ---- 手勢 ----
  const EDGE = 26;      // 從邊緣起算多少像素內才算要拉抽屜
  const TRIG = 42;      // 拉超過多少才算開
  let t = null;

  addEventListener('touchstart', e => {
    if (!phone() || e.touches.length !== 1) return;
    const x = e.touches[0].clientX, y = e.touches[0].clientY;
    if (open){
      // 已經開著：在抽屜上往回拉可以關
      const box = D[open].box;
      if (!box.contains(e.target)) return;
      t = { k: open, x0: x, y0: y, from: 'inside', axis: null };
    } else {
      const k = x <= EDGE ? 'l' : x >= innerWidth - EDGE ? 'r' : null;
      if (!k) return;
      t = { k, x0: x, y0: y, from: 'edge', axis: null };
    }
  }, { passive: true });

  addEventListener('touchmove', e => {
    if (!t || e.touches.length !== 1) return;
    const dx = e.touches[0].clientX - t.x0, dy = e.touches[0].clientY - t.y0;
    if (!t.axis){
      if (Math.abs(dx) < 8 && Math.abs(dy) < 8) return;
      t.axis = Math.abs(dx) > Math.abs(dy) ? 'x' : 'y';
      if (t.axis === 'y'){ t = null; return; }    // 是在捲動，放手
      D[t.k].box.classList.add('drag');
    }
    const w = D[t.k].box.offsetWidth, sign = D[t.k].sign;
    // 從邊緣拉出：0 → 全開；從裡面往回拉：全開 → 0
    const base = t.from === 'edge' ? sign * w : 0;
    let off = base + dx;
    off = sign < 0 ? Math.min(0, Math.max(-w, off)) : Math.max(0, Math.min(w, off));
    D[t.k].box.classList.add('open');
    D[t.k].box.style.transform = `translateX(${off}px)`;
    scrim.classList.add('on');
    scrim.style.opacity = String(1 - Math.abs(off) / w);
    if (e.cancelable) e.preventDefault();          // 拉抽屜時不要同時捲頁面
  }, { passive: false });

  addEventListener('touchend', () => {
    if (!t) return;
    const k = t.k, moved = t.axis === 'x';
    const box = D[k].box;
    scrim.style.opacity = '';
    if (!moved){ t = null; box.classList.remove('drag'); return; }
    const off = Math.abs(parseFloat(box.style.transform.replace(/[^-\d.]/g, '')) || 0);
    const w = box.offsetWidth;
    // 拉出時：露出超過 TRIG 就開；往回拉時：收起超過 TRIG 就關
    setOpen(t.from === 'edge' ? (w - off > TRIG ? k : null) : (off > TRIG ? null : k));
    t = null;
  }, { passive: true });
})();
