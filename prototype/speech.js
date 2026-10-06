/* 發聲層 —— 可抽換模組
 *
 * 目前實作：瀏覽器內建的 Web Speech API（零依賴、零成本、不消耗任何 API 額度）。
 * 之後若要換成 Kokoro-82M 等本機神經網路 TTS，只要替換本檔並維持下列介面即可，
 * 呼叫端（逐字標示、按鈕狀態）完全不用動：
 *
 *   Speech.ready()                     → Promise，語音清單載入完成
 *   Speech.available()                 → 這個瀏覽器能不能發聲
 *   Speech.voices()                    → [{ id, name, lang, local, wordEvents }]
 *   Speech.settings / Speech.setSettings({ voiceId, rate })
 *   Speech.speak(text, { onWord, onStart, onEnd, onError })
 *   Speech.stop() / Speech.speaking()
 *
 * onWord({ start, end }) 的座標是相對於傳入的 text，與分析結果的 words[].start/end 同一套，
 * 所以可以直接拿來對應畫面上的單字。
 */
(function (global) {
  'use strict';

  const synth = global.speechSynthesis;
  const Utterance = global.SpeechSynthesisUtterance;
  const OK = Boolean(synth && Utterance);

  // 各平台偏好的語音，依序嘗試。不能寫死單一名稱 —— Samantha 在 Windows 不存在。
  const PREFERRED = [
    // macOS
    'Samantha', 'Alex', 'Daniel', 'Karen', 'Moira', 'Tessa', 'Catherine', 'Arthur', 'Martha',
    // Windows（Chrome / Edge 的本機 SAPI 語音）
    'Microsoft Zira', 'Microsoft David', 'Microsoft Mark', 'Microsoft Hazel',
    'Microsoft Aria', 'Microsoft Guy', 'Microsoft Jenny',
    // Linux
    'English (America)', 'english-us',
  ];

  // macOS 的趣味語音，音高或音色不適合當教材
  const NOVELTY = /^(Bad News|Bahh|Bells|Boing|Bubbles|Cellos|Good News|Jester|Organ|Superstar|Trinoids|Whisper|Wobble|Zarvox|Albert|Fred|Junior|Ralph|Kathy|Grandma|Grandpa|Flo|Eddy|Reed|Rocko|Sandy|Shelley|Nicky|Aaron)\b/;

  const LS_KEY = 'analyzer-speech';
  const DEFAULTS = { voiceId: '', rate: 0.85 };

  let settings = { ...DEFAULTS };
  try { Object.assign(settings, JSON.parse(localStorage.getItem(LS_KEY) || '{}')); } catch {}

  let readyPromise = null;
  let current = null;        // 目前這次朗讀的狀態

  const voiceId = (v) => `${v.name}|${v.lang}`;

  /** 雲端語音不會發逐字事件（實測 Google US English 完全沒有 boundary），
   *  所以逐字標示只在本機語音上可用。 */
  const hasWordEvents = (v) => Boolean(v && v.localService);

  function rawVoices(){
    try { return synth.getVoices() || []; } catch { return []; }
  }

  function englishVoices(){
    return rawVoices().filter(v => /^en/i.test(v.lang));
  }

  /** 挑預設語音：本機優先 → 偏好清單 → 排除趣味語音 → 任何英語語音 */
  function autoPick(){
    const en = englishVoices();
    if (!en.length) return null;
    const local = en.filter(v => v.localService);
    const pool = local.length ? local : en;
    for (const name of PREFERRED){
      const hit = pool.find(v => v.name === name || v.name.startsWith(name));
      if (hit) return hit;
    }
    const plain = pool.filter(v => !NOVELTY.test(v.name));
    return plain.find(v => /en[-_]US/i.test(v.lang)) || plain[0] || pool[0];
  }

  function resolveVoice(){
    const en = englishVoices();
    if (settings.voiceId){
      const hit = en.find(v => voiceId(v) === settings.voiceId);
      if (hit) return hit;
    }
    return autoPick();
  }

  const api = {
    available: () => OK && englishVoices().length > 0,

    /** 語音清單在 Chrome 是非同步載入的，要等 */
    ready(){
      if (!OK) return Promise.resolve(false);
      if (readyPromise) return readyPromise;
      readyPromise = new Promise(res => {
        if (rawVoices().length) return res(true);
        let done = false;
        const finish = () => { if (!done){ done = true; res(rawVoices().length > 0); } };
        synth.addEventListener('voiceschanged', finish, { once: true });
        setTimeout(finish, 2500);
      });
      return readyPromise;
    },

    voices(){
      return englishVoices()
        .filter(v => !NOVELTY.test(v.name))
        .map(v => ({ id: voiceId(v), name: v.name, lang: v.lang,
                     local: Boolean(v.localService), wordEvents: hasWordEvents(v) }))
        .sort((a, b) => Number(b.local) - Number(a.local) || a.name.localeCompare(b.name));
    },

    get settings(){ return { ...settings }; },

    setSettings(patch){
      settings = { ...settings, ...patch };
      try { localStorage.setItem(LS_KEY, JSON.stringify(settings)); } catch {}
      return { ...settings };
    },

    /** 目前生效的語音資訊（沒有指定時回自動挑選的那個） */
    activeVoice(){
      const v = resolveVoice();
      return v ? { id: voiceId(v), name: v.name, lang: v.lang,
                   local: Boolean(v.localService), wordEvents: hasWordEvents(v) } : null;
    },

    speaking: () => OK && (synth.speaking || synth.pending),

    stop(){
      if (!OK) return;
      const c = current;
      current = null;
      try { synth.cancel(); } catch {}
      if (c?.onEnd) c.onEnd({ cancelled: true });
    },

    /** text 說完為止。onWord 收到的是相對於 text 的字元區間 */
    speak(text, opts = {}){
      if (!OK){ opts.onError?.(new Error('此瀏覽器不支援語音合成')); return; }
      api.stop();

      const u = new Utterance(String(text));
      const v = resolveVoice();
      if (v){ u.voice = v; u.lang = v.lang; } else { u.lang = 'en-US'; }
      u.rate = Math.min(2, Math.max(0.5, Number(settings.rate) || DEFAULTS.rate));

      const state = { onEnd: opts.onEnd, utterance: u };
      current = state;

      u.onstart = () => { if (current === state) opts.onStart?.(); };
      u.onboundary = (e) => {
        if (current !== state || e.name !== 'word') return;
        const start = e.charIndex ?? 0;
        const end = start + (e.charLength || 0);
        opts.onWord?.({ start, end });
      };
      u.onend = () => { if (current === state){ current = null; opts.onEnd?.({ cancelled: false }); } };
      u.onerror = (e) => {
        if (current !== state) return;          // 自己 cancel 造成的 error 不回報
        current = null;
        if (e.error === 'interrupted' || e.error === 'canceled') return;
        opts.onError?.(new Error(e.error || 'speech error'));
      };

      try { synth.speak(u); }
      catch (err){ current = null; opts.onError?.(err); }
    },
  };

  // Chrome 已知問題：較長的語句約 15 秒後會被系統暫停。句子都很短，
  // 但保險起見在朗讀期間輕推一下。
  if (OK) setInterval(() => {
    if (current && synth.speaking && !synth.paused){ try { synth.resume(); } catch {} }
  }, 5000);

  global.Speech = api;
})(window);
