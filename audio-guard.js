(function () {
  /* Ses koruması: eklenti videoyu yeniden başlatırken kullanıcının ses tercihini (sessiz / seviye) korur.
     Eskiden oynat çağrısı reddedilince (AbortError vb.) video "sessiz" başlatılıyordu. */
  const KC = (window.KickControl = window.KickControl || {});
  let pref = null;       // kullanıcının son bilinen tercihi { muted, volume }
  let busyUntil = 0;     // eklenti kendi işlemini yaparken volumechange'i tercih sayma
  let mutedByUs = false; // otomatik oynatma engeli yüzünden sessize aldıysak true

  const hasGesture = () => {
    try { return !!(navigator.userActivation && navigator.userActivation.hasBeenActive); } catch (_) { return false; }
  };
  const getVideo = () => document.getElementById('video-player') || document.querySelector('video');

  /* "Yayın sessize alınmasın": açıkken video sessize alınırsa (Kick, tarayıcı, başka betik ya da elle) sesi geri açar */
  const noMute = () => !!(KC.settings && KC.settings.no_mute === true);
  let lastVol = 0;
  let lastEnforce = 0;
  function enforceUnmute(v) {
    if (!noMute() || !v) return;
    try {
      // Kullanıcı hiç etkileşmediyse sesi açmak tarayıcıda videoyu durdurur → ilk tıklama/tuşta açılır
      if (!hasGesture()) return;
      const now = Date.now();
      if (now - lastEnforce < 250) return;
      let changed = false;
      if (v.muted) { v.muted = false; changed = true; }
      if (Number(v.volume) < 0.01) { v.volume = lastVol > 0.01 ? lastVol : 0.5; changed = true; }
      if (changed) { lastEnforce = now; busyUntil = now + 400; mutedByUs = false; }
    } catch (_) {}
  }

  document.addEventListener('volumechange', (e) => {
    const v = e.target;
    if (!(v instanceof HTMLVideoElement)) return;
    if (Number(v.volume) > 0.01) lastVol = Number(v.volume);
    if (Date.now() < busyUntil) return;
    mutedByUs = false;
    pref = { muted: !!v.muted, volume: Number(v.volume) };
    if (noMute()) {
      pref.muted = false;
      if (pref.volume < 0.01) pref.volume = lastVol > 0.01 ? lastVol : 0.5;
      setTimeout(() => enforceUnmute(v), 0);
    }
  }, true);

  function restore(v) {
    if (!pref || !v) return;
    try {
      if (!pref.muted && v.muted && hasGesture()) v.muted = false;
      if (!pref.muted && pref.volume > 0.01 && v.volume < 0.01) v.volume = pref.volume;
    } catch (_) {}
  }
  const restoreLater = (v) => [0, 300, 1200].forEach((d) => setTimeout(() => restore(v), d));

  /** Videoyu oynat — ses tercihini koru. */
  KC.resumeVideo = function (v) {
    if (!v || v.ended) return Promise.resolve(false);
    if (!v.paused) return Promise.resolve(true);
    if (!pref) pref = { muted: !!v.muted, volume: Number(v.volume) };
    busyUntil = Date.now() + 2500;
    let p;
    try { p = v.play(); } catch (_) { p = null; }
    return Promise.resolve(p).then(
      () => { restoreLater(v); return true; },
      (err) => {
        if (err && err.name === 'NotAllowedError') {
          // Tarayıcı sesli otomatik oynatmayı engelledi → sessiz oynat, ilk tıklamada sesi geri aç
          mutedByUs = true;
          try { v.muted = true; return v.play().then(() => true, () => false); } catch (_) { return false; }
        }
        // AbortError (başka bir pause/load araya girdi) vb.: sessize ALMA, tercihi geri yükle
        restoreLater(v);
        return false;
      }
    );
  };
  KC.safePlayVideo = KC.resumeVideo;

  const onGesture = (e) => {
    if (e.isTrusted && noMute()) setTimeout(() => enforceUnmute(getVideo()), 60);
    if (!e.isTrusted || !mutedByUs) return;
    mutedByUs = false;
    const v = getVideo();
    busyUntil = Date.now() + 1000;
    try { if (v && pref && !pref.muted) v.muted = false; } catch (_) {}
  };
  window.addEventListener('pointerdown', onGesture, true);
  window.addEventListener('keydown', onGesture, true);

  // Gözcü: ayar açıkken video 2 sn'de bir kontrol edilir (Kick sesi sessize aldıysa geri açılır)
  setInterval(() => { if (noMute()) enforceUnmute(getVideo()); }, 2000);
  if (KC.on) KC.on('setting:no_mute', (on) => { if (on) enforceUnmute(getVideo()); });
})();
