(function () {
  const KC = (window.KickControl = window.KickControl || {});

  const TICK_MS = 1500;
  const STAGE1_MS = 3000; // takılma → boşluk atla / canlı kenara git
  const STAGE2_MS = 6000; // pause → play
  const STAGE3_MS = 16000; // son çare: sayfayı yenile
  const RELOAD_MIN_GAP_MS = 45 * 1000;
  const RELOAD_MAX = 3; // 10 dk içinde
  const RELOAD_WINDOW_MS = 10 * 60 * 1000;
  const RELOAD_KEY = 'kc_stall_reloads';

  let timer = null;
  let lastTime = -1;
  let lastProgressAt = Date.now();
  let lastVideo = null;
  let stageDone = 0; // bu takılma için uygulanan en yüksek aşama
  let toastEl = null;
  let toastTimer = null;
  let resizeTimer = null;

  function enabled() {
    return KC.settings?.stall_guard !== false;
  }

  function getVideo() {
    return (
      document.getElementById('video-player') ||
      document.querySelector('video#video-player, video[src], video')
    );
  }

  function farming() {
    return !!(KC.settings?.level_bot || KC.settings?.anti_stuck || KC.settings?.drops_enabled);
  }

  function toast(msg) {
    try {
      if (!toastEl) {
        toastEl = document.createElement('div');
        toastEl.id = 'kc-stall-toast';
        document.documentElement.appendChild(toastEl);
      }
      toastEl.textContent = msg;
      toastEl.classList.add('on');
      clearTimeout(toastTimer);
      toastTimer = setTimeout(() => toastEl && toastEl.classList.remove('on'), 4500);
    } catch (_) {}
  }

  /** Arabellekteki boşluğu atla ya da canlı kenara git */
  function nudge(v) {
    try {
      const t = v.currentTime;
      const b = v.buffered;
      for (let i = 0; i < b.length; i++) {
        const s = b.start(i);
        if (s > t && s - t < 30) {
          v.currentTime = s + 0.05;
          return 'gap-jump';
        }
      }
      if (b.length) {
        const end = b.end(b.length - 1);
        if (end - t > 2) {
          v.currentTime = Math.max(0, end - 0.5);
          return 'live-edge';
        }
      }
      v.currentTime = t + 0.02;
      return 'nudge';
    } catch (_) {
      return 'fail';
    }
  }

  function playSafe(v) {
    try {
      const p = v.play();
      if (p && typeof p.catch === 'function') p.catch(() => {});
    } catch (_) {}
  }

  function reloadAllowed() {
    try {
      const now = Date.now();
      const arr = JSON.parse(sessionStorage.getItem(RELOAD_KEY) || '[]').filter(
        (x) => now - x < RELOAD_WINDOW_MS
      );
      if (arr.length >= RELOAD_MAX) return false;
      if (arr.length && now - arr[arr.length - 1] < RELOAD_MIN_GAP_MS) return false;
      arr.push(now);
      sessionStorage.setItem(RELOAD_KEY, JSON.stringify(arr));
      return true;
    } catch (_) {
      return false;
    }
  }

  function recover(v, stalledMs) {
    if (stalledMs >= STAGE3_MS && stageDone < 3) {
      stageDone = 3;
      lastStageName = '3:reload';
      if (reloadAllowed()) {
        toast('Yayın takıldı — sayfa yenileniyor…');
        console.warn('[KC] stall-guard: reload');
        setTimeout(() => location.reload(), 600);
      } else {
        toast('Yayın hâlâ takılı (yenileme limiti doldu)');
      }
      return;
    }
    if (stalledMs >= STAGE2_MS && stageDone < 2) {
      stageDone = 2;
      lastStageName = '2:pause-play';
      toast('Yayın takıldı — oynatıcı yeniden başlatılıyor…');
      try { v.pause(); } catch (_) {}
      setTimeout(() => {
        nudge(v);
        playSafe(v);
      }, 300);
      try { window.dispatchEvent(new Event('resize')); } catch (_) {}
      return;
    }
    if (stalledMs >= STAGE1_MS && stageDone < 1) {
      stageDone = 1;
      const how = nudge(v);
      lastStageName = '1:' + how;
      if (v.paused && farming()) playSafe(v);
      toast('Yayın takıldı — düzeltiliyor (' + how + ')');
      console.log('[KC] stall-guard: stage1', how);
    }
  }


  // ── Tanı kutusu: donma anında video durumunu gösterir ──
  let dbgEl = null;
  let lastStageName = '-';
  function updateDebug(v, stalledMs) {
    if (!KC.settings?.stall_debug) {
      if (dbgEl) { dbgEl.remove(); dbgEl = null; }
      return;
    }
    if (!dbgEl) {
      dbgEl = document.createElement('div');
      dbgEl.id = 'kc-stall-debug';
      document.documentElement.appendChild(dbgEl);
    }
    if (!v) { dbgEl.textContent = 'video yok'; return; }
    let ahead = '-';
    let ranges = 0;
    try {
      ranges = v.buffered.length;
      if (ranges) ahead = (v.buffered.end(ranges - 1) - v.currentTime).toFixed(1) + 's';
    } catch (_) {}
    const err = v.error ? v.error.code + ':' + (v.error.message || '') : '-';
    dbgEl.textContent =
      'pencere ' + innerWidth + 'x' + innerHeight + '\n' +
      'video ' + v.videoWidth + 'x' + v.videoHeight + ' (kutu ' + v.clientWidth + 'x' + v.clientHeight + ')\n' +
      't=' + (Number(v.currentTime) || 0).toFixed(1) + ' paused=' + v.paused + ' ended=' + v.ended + '\n' +
      'ready=' + v.readyState + ' net=' + v.networkState + ' rate=' + v.playbackRate + '\n' +
      'buffer ileri=' + ahead + ' aralık=' + ranges + '\n' +
      'hata=' + err + ' spinner=' + spinnerOnVideo(v) + '\n' +
      'takılma=' + (stalledMs / 1000).toFixed(1) + 's aşama=' + stageDone + ' son=' + lastStageName;
  }

  let lastAutoFixAt = 0;
  /** "Düzelt" düğmesinin yaptığı işlem — otomatik de bunu kullanır */
  function applyFix(silent) {
    const v = getVideo();
    if (!v || v.ended) return;
    lastAutoFixAt = Date.now();
    const how = nudge(v);
    try { v.playbackRate = 1; } catch (_) {}
    if (!v.paused || farming()) playSafe(v);
    try { window.dispatchEvent(new Event('resize')); } catch (_) {}
    lastStageName = 'fix:' + how;
    if (!silent) toast('Yayın düzeltiliyor (' + how + ')');
    console.log('[KC] stall-guard: fix', how);
  }

  function fixNow() {
    stageDone = 0;
    applyFix(false);
  }
  KC.fixStreamNow = fixNow;


  /** Videonun üstünde dönen yükleniyor simgesi var mı? */
  function spinnerOnVideo(v) {
    try {
      const vr = v.getBoundingClientRect();
      if (vr.width < 40 || vr.height < 40) return false;
      const nodes = document.querySelectorAll(
        '[class*="spin" i], [class*="loader" i], [class*="loading" i], [class*="buffer" i], [aria-busy="true"], [role="progressbar"]'
      );
      for (const el of nodes) {
        if (el === v || el.contains(v)) continue;
        const r = el.getBoundingClientRect();
        if (r.width < 8 || r.height < 8 || r.width > vr.width * 0.6) continue;
        const cx = r.left + r.width / 2;
        const cy = r.top + r.height / 2;
        if (cx < vr.left || cx > vr.right || cy < vr.top || cy > vr.bottom) continue;
        const cs = getComputedStyle(el);
        if (cs.display === 'none' || cs.visibility === 'hidden' || Number(cs.opacity) === 0) continue;
        return true;
      }
    } catch (_) {}
    return false;
  }

  function tick() {
    const v = getVideo();
    if (KC.settings?.stall_debug) updateDebug(v, Date.now() - lastProgressAt);
    else if (dbgEl) updateDebug(null, 0);
    if (!enabled()) return;
    if (!v) return;
    const now = Date.now();

    if (v !== lastVideo) {
      lastVideo = v;
      lastTime = -1;
      lastProgressAt = now;
      stageDone = 0;
    }
    if (v.ended) return;

    const t = Number(v.currentTime) || 0;
    const notReady = !v.paused && v.readyState < 3;
    const spinning = spinnerOnVideo(v);
    if (!notReady && !spinning && (lastTime < 0 || Math.abs(t - lastTime) > 0.05)) {
      // ilerliyor
      lastTime = t;
      lastProgressAt = now;
      stageDone = 0;
      return;
    }

    // Kullanıcı bilerek durdurduysa (farm kapalıyken) karışma
    if (v.paused && !farming()) {
      lastProgressAt = now;
      return;
    }
    if (v.paused && farming()) playSafe(v);

    const stalledMs = now - lastProgressAt;
    // Takılınca "Düzelt" işlemini otomatik, tekrar tekrar uygula
    if (stalledMs >= STAGE1_MS && now - lastAutoFixAt > 4000) {
      applyFix(false);
      if (stageDone < 1) stageDone = 1;
    }
    recover(v, stalledMs);
  }

  // Pencere boyutu değişince kısa süre sonra hızlı kontrol
  function onResize(e) {
    if (!enabled()) return;
    if (e && e.isTrusted === false) return; // kendi gönderdiğimiz resize olayını yok say
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => {
      // Oynatıcı boyuta geç tepki verebilir → birkaç kez dene
      [0, 2000, 4500, 8000, 13000].forEach((d) => {
        setTimeout(() => enabled() && applyFix(true), d);
      });
    }, 600);
  }

  function start() {
    if (timer) return;
    lastProgressAt = Date.now();
    timer = setInterval(tick, TICK_MS);
    window.addEventListener('resize', onResize);
  }

  function stop() {
    if (timer) clearInterval(timer);
    timer = null;
    window.removeEventListener('resize', onResize);
  }

  KC.settingsReady.then(() => {
    if (enabled() || KC.settings?.stall_debug) start();
  });
  KC.on('setting:stall_guard', (on) => {
    if (on !== false) start();
    else if (!KC.settings?.stall_debug) stop();
  });
  KC.on('setting:stall_debug', (on) => {
    if (on) start();
    else {
      if (dbgEl) { dbgEl.remove(); dbgEl = null; }
      if (!enabled()) stop();
    }
  });
})();
