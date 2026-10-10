(function () {
  const KC = (window.KickControl = window.KickControl || {});

  const TICK_MS = 2000;
  const STAGE1_MS = 4000; // takılma → boşluk atla / canlı kenara git
  const STAGE2_MS = 9000; // pause → play
  const STAGE3_MS = 20000; // son çare: güçlü soft onarım (sayfa yenileme YOK)
  const RELOAD_MIN_GAP_MS = 90 * 1000;
  const RELOAD_MAX = 2; // 10 dk içinde (sadece elle / çok agresif)
  const RELOAD_WINDOW_MS = 10 * 60 * 1000;
  const RELOAD_KEY = 'kc_stall_reloads';
  // Farm modunda uzun yükleme takılmasında kontrollü soft reload (max 2 / 10dk)
  const AUTO_RELOAD = true;

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
      document.querySelector(
        'video#video-player, video[data-testid="video-player"], video.vjs-tech, video[src], video'
      )
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

  function clickPlayOverlay() {
    try {
      const sels = [
        'button[aria-label*="Play" i]',
        'button[aria-label*="Oynat" i]',
        'button[data-testid*="play" i]',
        '[class*="play-button" i]',
        '[class*="PlayButton" i]',
        'button.vjs-big-play-button',
        '.vjs-big-play-button'
      ];
      for (const s of sels) {
        const el = document.querySelector(s);
        if (!el) continue;
        const st = window.getComputedStyle(el);
        if (st.display === 'none' || st.visibility === 'hidden') continue;
        el.click();
        return true;
      }
    } catch (_) {}
    return false;
  }

  function dismissChatRules() {
    try {
      // Kick sohbet kuralları / chat rules modal — yayını engelliyor
      const texts = [
        "Kabul ediyorum",
        "I accept",
        "Accept",
        "Agree",
        "Kabul Et",
        "Anladım"
      ];
      const buttons = document.querySelectorAll("button, [role=\"button\"]");
      for (const b of buttons) {
        const t = (b.textContent || "").trim();
        if (!t) continue;
        if (texts.some((x) => t === x || t.toLowerCase() === x.toLowerCase())) {
          // Sadece sohbet kuralları bağlamında tıkla
          const root = b.closest("[class*=\"modal\"], [class*=\"dialog\"], [class*=\"overlay\"], [role=\"dialog\"], div");
          const body = (root && root.textContent) || "";
          if (
            /sohbet\s*kurall|chat\s*rules|community\s*guidelines|be\s*respectful|respetuoso|toxique|friendlys|No Toxiquear/i.test(
              body
            )
          ) {
            b.click();
            return true;
          }
        }
      }
      // Alternatif: yeşil büyük buton + kurallar metni
      const green = document.querySelector(
        "button[style*=\"background\"], button.bg-green, [class*=\"green\"] button"
      );
    } catch (_) {}
    return false;
  }

  function hardReplay(v) {
    try {
      try { v.playbackRate = 1; } catch (_) {}
      // NEVER call v.load() — breaks Amazon IVS / MediaSource streams
      // Don't force unmute — Edge pauses video without user gesture
      try {
        if (navigator.userActivation && navigator.userActivation.hasBeenActive) {
          if (v.muted) v.muted = false;
          if (!v.volume || v.volume < 0.02) v.volume = 0.05;
        }
      } catch (_) {}
      nudge(v);
      playSafe(v);
      clickPlayOverlay();
      try { window.dispatchEvent(new Event('resize')); } catch (_) {}
    } catch (_) {}
  }

  function recover(v, stalledMs) {
    const loadingStuck =
      (v.readyState < 2 && !v.ended) ||
      (spinnerOnVideo(v) && stalledMs > 6000);

    // Stage 4: still loading after soft recover → limited page reload (farm only)
    // Disabled by default noise: only reload if truly no buffer for a long time
    if (
      AUTO_RELOAD &&
      farming() &&
      stageDone >= 3 &&
      stalledMs >= STAGE3_MS + 25000 &&
      loadingStuck &&
      reloadAllowed()
    ) {
      lastStageName = '4:reload';
      toast('Yayın yüklenmiyor — sayfa yenileniyor…');
      // one-shot log (not every tick)
      if (!recover._reloading) {
        recover._reloading = true;
        console.warn('[KC] stall-guard: soft reload after loading stall');
      }
      setTimeout(() => {
        try { location.reload(); } catch (_) {}
      }, 500);
      return;
    }

    if (stalledMs >= STAGE3_MS && stageDone < 3) {
      stageDone = 3;
      lastStageName = '3:hard';
      toast('Yayın takıldı — oynatıcı sert yenileniyor…');
      console.log('[KC] stall-guard: stage3 hardReplay');
      try { v.pause(); } catch (_) {}
      setTimeout(() => hardReplay(v), 350);
      setTimeout(() => hardReplay(v), 1500);
      return;
    }
    if (stalledMs >= STAGE2_MS && stageDone < 2) {
      stageDone = 2;
      lastStageName = '2:pause-play';
      toast('Yayın takıldı — oynatıcı yeniden başlatılıyor…');
      try { v.pause(); } catch (_) {}
      setTimeout(() => {
        hardReplay(v);
      }, 300);
      return;
    }
    if (stalledMs >= STAGE1_MS && stageDone < 1) {
      stageDone = 1;
      const how = nudge(v);
      lastStageName = '1:' + how;
      if (v.paused || farming()) playSafe(v);
      if (loadingStuck) clickPlayOverlay();
      toast('Yayın takıldı — düzeltiliyor (' + how + ')');
      console.log('[KC] stall-guard: stage1', how);
    }
  }


  // ── Yayın durumu (sade) ──
  let dbgEl = null;
  let lastStageName = '-';

  function stageLabel(name) {
    const n = String(name || '');
    if (n.indexOf('gap-jump') !== -1 || n.indexOf('live-edge') !== -1 || n.indexOf('nudge') !== -1)
      return 'boşluk atlandı';
    if (n.indexOf('pause-play') !== -1 || n.indexOf('2:') === 0) return 'yeniden başlatıldı';
    if (n.indexOf('reload') !== -1 || n.indexOf('3:') === 0) return 'sayfa yenilendi';
    if (n.indexOf('fix:') === 0) return 'elle düzeltildi';
    if (n === '-' || !n) return '—';
    return 'düzeltildi';
  }

  function nextActionHint(stalledMs) {
    if (stalledMs < STAGE1_MS) return 'İzleniyor';
    if (stageDone < 1 && stalledMs >= STAGE1_MS) return 'Boşluk atlanacak';
    if (stageDone < 2 && stalledMs >= STAGE2_MS) return 'Oynatıcı yenilenecek';
    if (stageDone < 3 && stalledMs >= STAGE3_MS) return 'Sayfa yenilenebilir';
    if (stageDone >= 3) return 'Limit · elle düzelt';
    if (stageDone >= 2) return 'Yeniden başlatıldı';
    if (stageDone >= 1) return 'Boşluk atlandı';
    return '—';
  }

  function channelLabel() {
    try {
      const p = (location.pathname || '').split('/').filter(Boolean);
      if (p.length === 1) return p[0];
    } catch (_) {}
    return '';
  }

  function updateDebug(v, stalledMs) {
    if (!KC.settings?.stall_debug) {
      if (dbgEl) {
        dbgEl.remove();
        dbgEl = null;
      }
      return;
    }
    if (!dbgEl) {
      dbgEl = document.createElement('div');
      dbgEl.id = 'kc-stall-debug';
      document.documentElement.appendChild(dbgEl);
    }
    if (!v) {
      dbgEl.innerHTML =
        '<div class="kc-sd-title">Yayın durumu</div>' +
        '<div class="kc-sd-row"><span class="kc-sd-dot bad"></span><b>Video yok</b></div>' +
        '<div class="kc-sd-meta">Player yüklenemedi veya sayfa kanal değil</div>';
      return;
    }

    const stalled = stalledMs >= 2500;
    const loading = spinnerOnVideo(v) || (!v.paused && v.readyState < 3);
    let statusClass = 'ok';
    let statusText = 'Akıyor';
    if (v.ended) {
      statusClass = 'bad';
      statusText = 'Yayın bitti';
    } else if (v.error) {
      statusClass = 'bad';
      statusText = 'Oynatma hatası';
    } else if (v.paused && !farming()) {
      statusClass = 'warn';
      statusText = 'Duraklatıldı';
    } else if (stalled) {
      statusClass = 'bad';
      statusText = 'Takılı (' + Math.min(999, Math.round(stalledMs / 1000)) + ' sn)';
    } else if (loading) {
      statusClass = 'warn';
      statusText = 'Yükleniyor…';
    } else if (v.paused && farming()) {
      statusClass = 'warn';
      statusText = 'Durakladı · düzeltiliyor';
    }

    let bufferTxt = '—';
    let bufferSec = '';
    try {
      if (v.buffered.length) {
        const ahead = Math.max(0, v.buffered.end(v.buffered.length - 1) - v.currentTime);
        bufferSec = ahead.toFixed(1) + ' sn';
        if (ahead < 1) bufferTxt = 'Az';
        else if (ahead < 3) bufferTxt = 'Orta';
        else bufferTxt = 'İyi';
      } else {
        bufferTxt = 'Yok';
        bufferSec = '0 sn';
      }
    } catch (_) {}

    const fixTxt = stageLabel(lastStageName);
    const actionTxt = nextActionHint(stalledMs);
    const ch = channelLabel();
    let resTxt = '—';
    try {
      if (v.videoWidth && v.videoHeight) resTxt = v.videoWidth + '×' + v.videoHeight;
    } catch (_) {}

    let playTxt = v.paused ? 'Duraklatılmış' : 'Oynuyor';
    if (v.ended) playTxt = 'Bitti';
    if (v.muted) playTxt += ' · sessiz';

    const rows = [];
    rows.push(
      '<div class="kc-sd-line"><span>Tampon</span><b>' +
        bufferTxt +
        (bufferSec ? ' (' + bufferSec + ')' : '') +
        '</b></div>'
    );
    rows.push('<div class="kc-sd-line"><span>Oynatma</span><b>' + playTxt + '</b></div>');
    if (resTxt !== '—')
      rows.push('<div class="kc-sd-line"><span>Çözünürlük</span><b>' + resTxt + '</b></div>');
    if (ch) rows.push('<div class="kc-sd-line"><span>Kanal</span><b>' + ch + '</b></div>');
    rows.push('<div class="kc-sd-line"><span>Sıradaki</span><b>' + actionTxt + '</b></div>');
    if (fixTxt !== '—')
      rows.push('<div class="kc-sd-line"><span>Son işlem</span><b>' + fixTxt + '</b></div>');
    if (v.error)
      rows.push(
        '<div class="kc-sd-line"><span>Hata</span><b>Oynatılamıyor</b></div>'
      );

    dbgEl.innerHTML =
      '<div class="kc-sd-title">Yayın durumu</div>' +
      '<div class="kc-sd-row"><span class="kc-sd-dot ' +
      statusClass +
      '"></span><b>' +
      statusText +
      '</b></div>' +
      '<div class="kc-sd-details">' +
      rows.join('') +
      '</div>';
  }

  let lastAutoFixAt = 0;
  /** "Düzelt" düğmesinin yaptığı işlem — otomatik de bunu kullanır */
  function applyFix(silent) {
    const v = getVideo();
    if (!v || v.ended) return;
    lastAutoFixAt = Date.now();
    try { v.playbackRate = 1; } catch (_) {}
    hardReplay(v);
    const how = 'hard';
    lastStageName = 'fix:' + how;
    if (!silent) toast('Yayın düzeltiliyor…');
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
    dismissChatRules();
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

    // Canlı yayında buffer öndeyse ve oynuyorsa takılma sayma
    let bufferOk = false;
    try {
      if (v.buffered && v.buffered.length) {
        const ahead = v.buffered.end(v.buffered.length - 1) - t;
        bufferOk = ahead > 1.5 && !v.paused && v.readyState >= 2;
      }
    } catch (_) {}

    if (
      bufferOk ||
      (!notReady && !spinning && (lastTime < 0 || Math.abs(t - lastTime) > 0.05))
    ) {
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
    // Takılınca "Düzelt" — daha seyrek
    if (stalledMs >= STAGE1_MS && now - lastAutoFixAt > 8000) {
      applyFix(true); // silent when auto
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


  // Lightweight progress tracker for HUD even when stall_guard is off
  let snapLastT = -1;
  let snapLastProgressAt = Date.now();

  KC.getStreamStatusSnapshot = function () {
    const v = getVideo();
    const now = Date.now();
    if (v) {
      try {
        const t = Number(v.currentTime) || 0;
        if (snapLastT < 0 || Math.abs(t - snapLastT) > 0.05) {
          snapLastT = t;
          snapLastProgressAt = now;
        }
      } catch (_) {}
    }
    const stalledMs = Math.max(0, now - Math.max(lastProgressAt, snapLastProgressAt));
    if (!v) {
      return {
        status: 'Video yok',
        statusClass: 'bad',
        buffer: '—',
        bufferSec: '',
        play: '—',
        res: '—',
        channel: '',
        next: '—',
        last: stageLabel(lastStageName)
      };
    }
    const stalled = stalledMs >= 2500;
    const loading = spinnerOnVideo(v) || (!v.paused && v.readyState < 3);
    let statusClass = 'ok';
    let statusText = 'Akıyor';
    if (v.ended) {
      statusClass = 'bad';
      statusText = 'Yayın bitti';
    } else if (v.error) {
      statusClass = 'bad';
      statusText = 'Oynatma hatası';
    } else if (v.paused && !farming()) {
      statusClass = 'warn';
      statusText = 'Duraklatıldı';
    } else if (stalled) {
      statusClass = 'bad';
      statusText = 'Takılı (' + Math.min(999, Math.round(stalledMs / 1000)) + ' sn)';
    } else if (loading) {
      statusClass = 'warn';
      statusText = 'Yükleniyor…';
    } else if (v.paused && farming()) {
      statusClass = 'warn';
      statusText = 'Durakladı · düzeltiliyor';
    }

    let bufferTxt = '—';
    let bufferSec = '';
    try {
      if (v.buffered.length) {
        const ahead = Math.max(
          0,
          v.buffered.end(v.buffered.length - 1) - v.currentTime
        );
        bufferSec = ahead.toFixed(1) + ' sn';
        if (ahead < 1) bufferTxt = 'Az';
        else if (ahead < 3) bufferTxt = 'Orta';
        else bufferTxt = 'İyi';
      } else {
        bufferTxt = 'Yok';
        bufferSec = '0 sn';
      }
    } catch (_) {}

    let playTxt = v.paused ? 'Duraklatılmış' : 'Oynuyor';
    if (v.ended) playTxt = 'Bitti';
    if (v.muted) playTxt += ' · sessiz';

    let resTxt = '—';
    try {
      if (v.videoWidth && v.videoHeight) resTxt = v.videoWidth + '×' + v.videoHeight;
    } catch (_) {}

    let ch = '';
    try {
      const p = (location.pathname || '').split('/').filter(Boolean);
      if (p.length === 1) ch = p[0];
    } catch (_) {}

    return {
      status: statusText,
      statusClass: statusClass,
      buffer: bufferTxt,
      bufferSec: bufferSec,
      play: playTxt,
      res: resTxt,
      channel: ch,
      next: nextActionHint(stalledMs),
      last: stageLabel(lastStageName)
    };
  };

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
