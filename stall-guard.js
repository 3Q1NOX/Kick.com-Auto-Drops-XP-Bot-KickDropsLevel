(function () {
  const KC = (window.KickControl = window.KickControl || {});

  const TICK_MS = 2000;
  const RELOAD_MIN_GAP_MS = 90 * 1000;
  const RELOAD_MAX = 2; // 10 dk içinde (sadece elle / çok agresif)
  const RELOAD_WINDOW_MS = 10 * 60 * 1000;
  const RELOAD_KEY = 'kc_stall_reloads';
  // Farm modunda uzun yükleme takılmasında kontrollü soft reload (max 2 / 10dk)
  // v1.3.80: tetiklenme eşikleri menüden ayarlanır (Koruma → Tetiklenme ayarları)
  const numSet = (k, d, lo, hi) => {
    const n = parseFloat(KC.settings && KC.settings[k]);
    return isFinite(n) && n >= lo ? Math.min(hi, n) : d;
  };
  const stage1Ms = () => numSet('stall_t1', 4, 2, 30) * 1000;   // takılma → boşluk atla / oynat
  const stage2Ms = () => Math.max(numSet('stall_t2', 12, 4, 60) * 1000, stage1Ms() + 1000);   // yeniden oynat (pause YOK)
  const stage3Ms = () => Math.max(numSet('stall_t3', 20, 6, 120) * 1000, stage2Ms() + 1000);  // son çare: güçlü soft onarım
  const coolMs = () => numSet('stall_cool', 15, 5, 120) * 1000;        // oto canlıya-geç arası bekleme
  const marginSec = () => numSet('stall_margin', 3, 1, 10);            // canlıya atlarken bırakılan tampon payı
  const qpauseMs = () => numSet('stall_qpause', 15, 0, 60) * 1000;     // kalite menüsü sonrası onarım duraklaması
  const autoReload = () => !(KC.settings && KC.settings.stall_reload === false); // uzun takılmada sayfa yenile (farm)

  let timer = null;
  let dbgTimer = null;
  const pageStartAt = Date.now();
  let lastTime = -1;
  let lastFrames = -1;
  let lastProgressAt = Date.now();
  let lastVideo = null;
  let stageDone = 0; // bu takılma için uygulanan en yüksek aşama
  let toastEl = null;
  let toastTimer = null;
  let resizeTimer = null;
  let lastAutoFixAt = 0;

  // v1.3.78: Kick'te kalite (veya başka bir oynatıcı menüsü) seçilince oynatıcı tamponu boşaltıp yeniden yükler.
  // Bu doğal duraksamada onarıcı / otomatik canlıya-geç araya girip seek-play yapınca donma uzuyordu →
  // menü tıklamasından sonra 15 sn boyunca otomatik müdahale yok.
  let qualityBusyUntil = 0;
  function qualityBusy() { return Date.now() < qualityBusyUntil; }
  KC.qualityBusy = qualityBusy; // fps-boost vb. diğer betikler de kalite geçişinde karışmasın

  // v1.3.85: video neden duraklatıldı? Kaynağı hata günlüğüne yaz
  let lastUserInputAt = 0, lastPauseMsgAt = 0, lastPauseMsg = null, lastPauseLogAt = 0;
  try {
    ['pointerdown', 'keydown', 'wheel'].forEach((t) =>
      addEventListener(t, (e) => { if (e.isTrusted) lastUserInputAt = Date.now(); }, true)
    );
    window.addEventListener('message', (e) => {
      try {
        if (e.source !== window) return;
        const d = e.data;
        if (!d || d.source !== 'kickcontrol-pause') return;
        lastPauseMsgAt = Date.now();
        lastPauseMsg = d;
      } catch (_) {}
    });
    document.addEventListener('pause', (e) => {
      const v = e.target;
      if (!(v instanceof HTMLVideoElement) || v.ended) return;
      setTimeout(() => {
        try {
          const now = Date.now();
          if (now - lastPauseLogAt < 3000) return;
          lastPauseLogAt = now;
          const userAgo = lastUserInputAt ? Math.round((now - lastUserInputAt) / 1000) : -1;
          let who;
          if (KC._ownPauseAt && now - KC._ownPauseAt < 1500) who = 'eklenti (' + (KC._ownPauseWho || '?') + ')';
          else if (userAgo >= 0 && userAgo < 2) who = 'kullanıcı (tıklama/tuş)';
          else if (lastPauseMsg && now - lastPauseMsgAt < 1500) who = 'sayfa/oynatıcı kodu: ' + lastPauseMsg.stack;
          else who = 'tarayıcı (JS çağrısı yok: sekme gizli / ses-oynatma politikası olabilir)';
          stallLog('warn', 'video duraklatıldı · kaynak=' + who + ' · sekme=' + (inBackground() ? 'arka plan' : 'ön plan') +
            ' · son kullanıcı etkileşimi=' + (userAgo < 0 ? 'yok' : userAgo + ' sn önce'), v, 0);
        } catch (_) {}
      }, 200);
    }, true);
  } catch (_) {}

  // v1.3.81: ARKA PLAN tespiti. Eklenti sekmeyi "görünür" gibi gösterdiği için (visibilityState sahte) gerçek durumu
  // requestAnimationFrame atışından anlarız: sekme gizli/küçültülmüş/başka pencerenin altındaysa rAF durur.
  // Arka planda zamanlayıcılar 1 sn'ye (5 dk sonra 1 dk'ya) yavaşlar → eski ölçümlerle "takıldı/geride" sanıp
  // seek / canlıya-geç yapmak yayını donduruyordu. Arka planda ve sekmeye dönünce kısa süre müdahale yok.
  let lastRafAt = performance.now();
  let bgGraceUntil = 0;
  let lastBgPlayAt = 0;
  const fgGraceMs = () => numSet('stall_fg_grace', 6, 0, 30) * 1000;
  function inBackground() { return performance.now() - lastRafAt > 1500; }
  function bgIdle() {
    if (KC.settings && KC.settings.stall_bg_idle === false) return false;
    return inBackground() || Date.now() < bgGraceUntil;
  }
  function rafBeat() {
    const now = performance.now();
    if (now - lastRafAt > 1500) {
      // arka plandan döndü: bayat ölçümleri sıfırla, kısa süre bekle
      bgGraceUntil = Date.now() + fgGraceMs();
      lastProgressAt = Date.now();
      stageDone = 0;
      try { autoLagTick._lt = -1; } catch (_) {}
    }
    lastRafAt = now;
    requestAnimationFrame(rafBeat);
  }
  try { requestAnimationFrame(rafBeat); } catch (_) {}
  try {
    document.addEventListener('click', (e) => {
      try {
        if (!e.isTrusted) return;
        const t = e.target;
        if (!(t instanceof Element) || t.closest('[id^="kc-"]')) return;
        const inMenu = t.closest('[role="menu"],[role="menuitem"],[role="menuitemradio"],[role="option"],[role="listbox"]');
        const txt = (t.textContent || '').trim();
        const looksQ = txt.length < 24 && /^(\d{3,4}p(\d+)?|auto|otomatik|kaynak|source)\b/i.test(txt);
        if (!inMenu && !looksQ) return;
        qualityBusyUntil = Date.now() + qpauseMs();
        lastProgressAt = Date.now();
        stageDone = 0;
      } catch (_) {}
    }, true);
  } catch (_) {}

  /** Gecikmede kendiliğinden onarma (boşluk atla / pause-play / sert yenile). Varsayılan KAPALI. */
  function autoOn() {
    return KC.settings?.stall_auto === true;
  }

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
  function nudge(v, allowLive) {
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
        if (allowLive && end - t > 15) {
          v.currentTime = Math.max(0, end - 3);
          return 'live-edge';
        }
      }
      return 'play';
    } catch (_) {
      return 'fail';
    }
  }

  function playSafe(v) {
    try {
      if (typeof KC.resumeVideo === 'function') { KC.resumeVideo(v); return; }
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

  // "Pencere içinde pencere (PiP)", tam ekran, ses, ayar vb. düğmeleri asla "oynat" sanma
  const NOT_PLAY_RE = /picture|pip\b|pencere|mini\s*-?\s*player|miniplayer|fullscreen|full\s*screen|tam\s*ekran|theat|sinema|setting|ayar|volume|ses\b|mute|sessiz|quality|kalite|chat|sohbet/i;
  const PLAY_LABEL_RE = /^\s*(play|oynat|resume|devam)\b/i;
  let lastOverlayClickAt = 0;

  function ctlText(el) {
    return [
      el.getAttribute('aria-label'), el.getAttribute('title'), el.getAttribute('data-testid'),
      typeof el.className === 'string' ? el.className : '', el.id
    ].filter(Boolean).join(' ');
  }

  function clickPlayOverlay() {
    try {
      const vid = getVideo();
      // Video zaten oynuyorsa hiçbir düğmeye basma
      if (vid && !vid.paused && !vid.ended) return false;
      if (document.pictureInPictureElement) return false;
      const sels = ['button.vjs-big-play-button', '.vjs-big-play-button', 'button[aria-label]', 'button[data-testid*="play" i]'];
      for (const s of sels) {
        for (const el of document.querySelectorAll(s)) {
          if (el.closest('#kc-menu, #kc-dash, [id^="kc-"]')) continue;
          const txt = ctlText(el);
          if (NOT_PLAY_RE.test(txt)) continue;
          const isBig = /vjs-big-play-button/.test(txt);
          if (!isBig && !PLAY_LABEL_RE.test(el.getAttribute('aria-label') || '') && !/play/i.test(el.getAttribute('data-testid') || '')) continue;
          const st = window.getComputedStyle(el);
          if (st.display === 'none' || st.visibility === 'hidden') continue;
          lastOverlayClickAt = Date.now();
          el.click();
          return true;
        }
      }
    } catch (_) {}
    return false;
  }

  // Ne olursa olsun: eklentinin kendi tıklaması PiP açtıysa hemen kapat
  try {
    document.addEventListener('enterpictureinpicture', () => {
      if (Date.now() - lastOverlayClickAt < 2500) {
        try { document.exitPictureInPicture().catch(() => {}); } catch (_) {}
      }
    }, true);
  } catch (_) {}

  function dismissChatRules() {
    try {
      const acceptRe = /^(Kabul ediyorum|I accept|Accept|Agree|Kabul Et|Anladım|I agree|Accept rules)$/i;
      const contextRe = /sohbet\s*kurall|chat\s*rules|community\s*guidelines|be\s*respectful|respetuoso|toxique|friendlys|No Toxiquear|Se respetuoso|Pasala bien/i;
      const buttons = document.querySelectorAll('button, [role="button"], a[class*="button"]');
      for (const b of buttons) {
        const label = (b.textContent || '').trim();
        if (!label || label.length > 40) continue;
        if (!acceptRe.test(label)) continue;
        const root =
          b.closest('[role="dialog"]') ||
          b.closest('[class*="modal" i]') ||
          b.closest('[class*="dialog" i]') ||
          b.closest('[class*="overlay" i]') ||
          b.parentElement;
        const body = (root && root.textContent) || '';
        if (contextRe.test(body) || contextRe.test(label)) {
          try {
            b.click();
            return true;
          } catch (_) {}
        }
      }
    } catch (_) {}
    return false;
  }

  function hardReplay(v) {
    try {
      try { v.playbackRate = 1; } catch (_) {}
      // NEVER call v.load() — breaks Amazon IVS / MediaSource streams
      // Ses ayarına dokunma: playSafe → KC.resumeVideo kullanıcının sessiz/ses tercihini korur
      nudge(v);
      playSafe(v);
      clickPlayOverlay();
      try { if (v.readyState < 3) window.dispatchEvent(new Event('resize')); } catch (_) {}
    } catch (_) {}
  }

  function hasPlayableBuffer(v) {
    try {
      if (v.readyState >= 3) return true;
      const b = v.buffered;
      if (b && b.length) {
        const lag = b.end(b.length - 1) - (Number(v.currentTime) || 0);
        if (isFinite(lag) && lag > 0.4) return true;
      }
    } catch (_) {}
    return false;
  }

  /** Tarayıcı ağ bilgisi (varsa) — internet mi diye bakmak için */
  function netSnap() {
    const parts = [];
    try {
      const c = navigator.connection || navigator.mozConnection || navigator.webkitConnection;
      if (c) {
        if (c.effectiveType) parts.push('netType=' + c.effectiveType);
        if (c.downlink != null) parts.push('downlink=' + c.downlink + 'Mb/s');
        if (c.rtt != null) parts.push('rtt=' + c.rtt + 'ms');
        if (c.saveData) parts.push('saveData=1');
      }
    } catch (_) {}
    try {
      if (navigator.onLine === false) parts.push('onLine=false');
      else parts.push('onLine=true');
    } catch (_) {}
    return parts.join(' · ');
  }

  /**
   * Takılma sebebi tahmini (log için):
   *  - network: networkState=LOADING / ONLINE yok / rtt yüksek / tampon 0
   *  - buffer: oynuyor ama gelecek veri yok
   *  - local: tampon var ama kare ilerlemiyor (decoder/GPU)
   *  - sekme: arka plan / gizlenmiş
   */
  function stallCause(v, lag, rs, ns) {
    try {
      if (document.hidden) return 'SEKME_ARKA_PLAN (document.hidden — tarayıcı throttling)';
      if (navigator.onLine === false) return 'INTERNET_YOK (onLine=false)';
      const c = navigator.connection || navigator.mozConnection || navigator.webkitConnection;
      if (c && c.rtt > 800) return 'AG_YAVAS (rtt=' + c.rtt + 'ms — internet yavaş)';
      if (c && c.downlink != null && c.downlink < 0.5) return 'AG_YAVAS (downlink=' + c.downlink + 'Mb/s — internet yavaş)';
      if (c && c.effectiveType && /2g|slow-2g/i.test(c.effectiveType)) return 'AG_YAVAS (netType=' + c.effectiveType + ')';
    } catch (_) {}
    // HTMLMediaElement.networkState: 0 EMPTY, 1 IDLE, 2 LOADING, 3 NO_SOURCE
    if (ns === 2) return 'AG_YUKLENIYOR (networkState=LOADING — veri bekleniyor, internet/CDN)';
    if (ns === 3) return 'KAYNAK_YOK (NO_SOURCE — yayın koptu?)';
    if (rs <= 1 && lag < 0.3) return 'TAMPON_BOS (muhtemel internet/CDN — buffer underrun)';
    if (rs <= 2 && lag < 0.5) return 'TAMPON_AZ (buffer az — internet veya sunucu yavaş)';
    if (lag >= 1 && rs >= 3) return 'YEREL_TAKILMA (tampon var ama kare yok — decoder/GPU/sekme, internet değil)';
    if (lag >= 0.5) return 'KARISIK (tampon var ama yavaş — hafif ağ veya decoder)';
    return 'BILINMIYOR (kısa hitch olabilir)';
  }

  /** Player hâlâ ayakta mı? (düşmedi = ended değil, src var, offline değil) */
  function playerAlive(v) {
    try {
      if (!v) return false;
      if (v.ended) return false;
      if (navigator.onLine === false) return false;
      const src = v.currentSrc || v.src || '';
      if (!src && (!v.buffered || !v.buffered.length)) return false;
      return true;
    } catch (_) {
      return true;
    }
  }

  /** Video anlık durumu — hata günlüğü için detay (+ internet) */
  function stallSnap(v, stalledMs) {
    let buf = 0, lag = 0, ranges = 0;
    try {
      const b = v && v.buffered;
      if (b && b.length) {
        ranges = b.length;
        buf = b.end(b.length - 1);
        lag = buf - (Number(v.currentTime) || 0);
      }
    } catch (_) {}
    const rs = v ? v.readyState : -1;
    const ns = v ? v.networkState : -1;
    const rsName = ['HAVE_NOTHING', 'HAVE_METADATA', 'HAVE_CURRENT_DATA', 'HAVE_FUTURE_DATA', 'HAVE_ENOUGH_DATA'][rs] || String(rs);
    const nsName = ['EMPTY', 'IDLE', 'LOADING', 'NO_SOURCE'][ns] || String(ns);
    let dropped = '-', totalF = '-';
    try {
      const q = v && v.getVideoPlaybackQuality && v.getVideoPlaybackQuality();
      if (q) {
        dropped = String(q.droppedVideoFrames || 0);
        totalF = String(q.totalVideoFrames || 0);
      }
    } catch (_) {}
    const cause = stallCause(v, lag, rs, ns);
    const net = netSnap();
    const alive = playerAlive(v);
    let hint = '';
    if (/AG_YAVAS|TAMPON_BOS|TAMPON_AZ|AG_YUKLENIYOR|INTERNET_YOK/i.test(cause)) {
      hint = 'IPUCU=internet_veya_CDN';
    } else if (/YEREL_TAKILMA|SEKME_ARKA_PLAN/i.test(cause)) {
      hint = 'IPUCU=internet_degil_yerel_veya_sekme';
    } else {
      hint = 'IPUCU=belirsiz';
    }
    return [
      'stalled=' + Math.round((stalledMs || 0) / 100) / 10 + 's',
      'cause=' + cause,
      hint,
      'playerDustu=' + (alive ? 'HAYIR' : 'EVET'),
      'paused=' + !!(v && v.paused),
      'ended=' + !!(v && v.ended),
      'hidden=' + !!document.hidden,
      't=' + (v ? (Number(v.currentTime) || 0).toFixed(2) : '-'),
      'bufEnd=' + (buf ? buf.toFixed(2) : '-'),
      'lag=' + (isFinite(lag) ? lag.toFixed(1) + 's' : '0'),
      'ranges=' + ranges,
      'readyState=' + rs + '(' + rsName + ')',
      'networkState=' + ns + '(' + nsName + ')',
      'droppedFrames=' + dropped + '/' + totalF,
      'playbackRate=' + (v ? v.playbackRate : '-'),
      'stage=' + stageDone,
      'auto=' + autoOn(),
      'farm=' + farming(),
      'spinner=' + (v ? !!spinnerOnVideo(v) : false),
      'apiLive=' + (recover._apiLive === undefined ? '?' : String(recover._apiLive)),
      net || 'net=?'
    ].join(' · ');
  }

  function stallLog(lvl, msg, v, stalledMs) {
    try {
      if (typeof KC.elog === 'function') {
        KC.elog(lvl || 'info', 'stall', msg, stallSnap(v, stalledMs));
      } else if (typeof KCwarn === 'function') {
        KCwarn('[stall] ' + msg, stallSnap(v, stalledMs));
      }
    } catch (_) {}
  }

  // Anlık + uzun donma: eşik başına 1 log / 10–15 sn
  const stallWatchLogAt = { s15: 0, s3: 0, s4: 0, s8: 0, s15b: 0, s25: 0 };
  let wasFrozen = false;
  let freezeStartedAt = 0;

  function maybeLogFreeze(v, stalledMs) {
    if (!v || v.ended) return;
    const now = Date.now();

    // Anlık takılma başlangıcı (≥1.5s)
    if (stalledMs >= 1500 && !wasFrozen) {
      wasFrozen = true;
      freezeStartedAt = now - stalledMs;
      if (now - (stallWatchLogAt.s15 || 0) > 8000) {
        stallWatchLogAt.s15 = now;
        stallLog(
          'info',
          'anlık takılma başladı (≥1.5s) · player düşmedi=' + (playerAlive(v) ? 'evet' : 'hayır'),
          v,
          stalledMs
        );
      }
    }

    const thresholds = [
      [3000, 's3', 'info', 'anlık donma ≥3s'],
      [4000, 's4', 'info', 'donma ≥4s'],
      [8000, 's8', 'warn', 'donma ≥8s'],
      [15000, 's15b', 'warn', 'donma ≥15s'],
      [25000, 's25', 'error', 'donma ≥25s']
    ];
    for (const [ms, key, lvl, label] of thresholds) {
      if (stalledMs < ms) continue;
      if (now - (stallWatchLogAt[key] || 0) < 12000) continue;
      stallWatchLogAt[key] = now;
      stallLog(
        lvl,
        label +
          ' · playerDustu=' +
          (playerAlive(v) ? 'HAYIR' : 'EVET') +
          ' · onarıcı=' +
          (enabled() ? 'açık' : 'kapalı') +
          ', auto=' +
          (autoOn() ? 'açık' : 'kapalı'),
        v,
        stalledMs
      );
    }
  }

  function maybeLogRecover(v) {
    if (!wasFrozen) return;
    const dur = freezeStartedAt ? Date.now() - freezeStartedAt : 0;
    wasFrozen = false;
    freezeStartedAt = 0;
    if (dur < 1200) return; // çok kısa hitch loglanmasın
    try {
      stallLog(
        'info',
        'takılma bitti · süre≈' +
          Math.round(dur / 100) / 10 +
          's · playerDustu=HAYIR (yayın devam)',
        v,
        0
      );
    } catch (_) {}
  }

  function recover(v, stalledMs) {
    if (qualityBusy() || bgIdle()) { lastProgressAt = Date.now(); stageDone = 0; return; }
    const loadingStuck =
      (v.readyState < 2 && !v.ended) ||
      (spinnerOnVideo(v) && stalledMs > 6000);

    // Sağlıklı yayın: oynuyor + tampon var → ASLA müdahale etme (kısa currentTime takılması / decoder hitch)
    if (!v.paused && hasPlayableBuffer(v) && !loadingStuck) {
      if (stageDone > 0 || stalledMs >= stage1Ms()) {
        stallLog('info', 'atlandı (sağlıklı: oynuyor+tampon)', v, stalledMs);
      }
      stageDone = 0;
      return;
    }

    // Stage 4: still loading after soft recover → limited page reload (farm only)
    // v1.3.69: izin (reloadAllowed) yalnızca reload GERÇEKTEN yapılacakken harcanır.
    // Karar 500 ms sonra yeniden doğrulanır: video kimliği, ayarlar, ilerleme örneği
    // (zamanlama ÖNCESİ alınan örnek ile karşılaştırılır) ve loading-stuck koşulları.
    if (
      autoReload() &&
      farming() &&
      stageDone >= 3 &&
      stalledMs >= stage3Ms() + 25000 &&
      loadingStuck &&
      !recover._reloading
    ) {
      lastStageName = '4:reload';
      toast('Yayın yüklenmiyor — sayfa yenileniyor…');
      recover._reloading = true;
      // Zamanlama ÖNCESİ ilerleme örneği al (callback'teki örnekle karşılaştırılacak)
      // Ölçüm hatası durumunda (preOk=false) callback iptal eder — bilinmeyen durumda reload yok.
      const preT = Number(v.currentTime) || 0;
      let preF = -1;
      let preOk = true;
      try {
        if (v.getVideoPlaybackQuality) {
          const q = v.getVideoPlaybackQuality();
          if (q) preF = q.totalVideoFrames;
        }
      } catch (_) { preOk = false; }
      stallLog('error', 'stage4 soft-reload planlandı (uzun yükleme takılması)', v, stalledMs);
      KCwarn('[KC] stall-guard: soft reload after loading stall');
      setTimeout(() => {
        try {
          const vv = getVideo();
          // 1) Video elemanı değişmedi mi?
          if (!vv || vv !== v) { recover._reloading = false; stallLog('info', 'stage4 reload iptal (video değişti)', vv, 0); return; }
          // 2) Ayarlar hâlâ açık mı?
          if (!enabled() || !autoOn() || !farming()) { recover._reloading = false; stallLog('info', 'stage4 reload iptal (ayar kapandı)', vv, 0); return; }
          // 3) Video bitti mi / kullanıcı duraklattı mı?
          if (vv.ended) { recover._reloading = false; return; }
          if (vv.paused && !farming()) { recover._reloading = false; return; }
          // 4) Zamanlama sırasında ilerleme oldu mu? (ÖNCESİ örnek ile karşılaştır)
          // Ölçüm hatası → İPTAL (bilinmeyen durumda sayfa yenileme riskli)
          let curT = Number(vv.currentTime) || 0;
          let curF = -1;
          let curOk = true;
          try {
            if (vv.getVideoPlaybackQuality) {
              const q2 = vv.getVideoPlaybackQuality();
              if (q2) curF = q2.totalVideoFrames;
            }
          } catch (_) { curOk = false; }
          if (!preOk || !curOk) {
            recover._reloading = false;
            stallLog('warn', 'stage4 reload iptal (ölçüm hatası)', vv, 0);
            return;
          }
          const tAdvanced = Math.abs(curT - preT) > 0.05;
          const fAdvanced = curF >= 0 && preF >= 0 && curF > preF;
          if (tAdvanced || fAdvanced) { recover._reloading = false; stallLog('info', 'stage4 reload iptal (toparlandı)', vv, 0); return; }
          // 5) Hâlâ loading-stuck ve hâlâ takılı mı?
          const stillLoadingStuck =
            (vv.readyState < 2 && !vv.ended) ||
            (spinnerOnVideo(vv) && Date.now() - lastProgressAt > 6000);
          const stillStalled = Date.now() - lastProgressAt >= stage3Ms() + 25000;
          if (!stillLoadingStuck || !stillStalled) { recover._reloading = false; stallLog('info', 'stage4 reload iptal (koşul bozuldu)', vv, 0); return; }
          // 6) Tüm koşullar geçerli — izni ŞİMDİ harca ve reload'u yap
          if (reloadAllowed()) {
            stallLog('error', 'stage4 reload ONAYLANDI (hâlâ yükleme takılması)', vv, Date.now() - lastProgressAt);
            location.reload();
          } else {
            recover._reloading = false;
            stallLog('warn', 'stage4 reload reddedildi (limit doldu)', vv, 0);
          }
        } catch (err) {
          // Doğrulama hatasında İPTAL ET — hata durumunda sayfayı yenileme
          recover._reloading = false;
          stallLog('warn', 'stage4 reload doğrulama hatası → iptal: ' + (err && err.message || err), null, 0);
        }
      }, 500);
      return;
    }

    if (stalledMs >= stage2Ms() && !v.paused && v.readyState >= 3 && !loadingStuck) return;

    // Sert onarım öncesi API ile canlı mı bak (sorun yokken donmasın)
    const needsHard = stalledMs >= stage2Ms() && stageDone < 3;
    if (needsHard && typeof KC.checkCurrentLive === 'function') {
      if (!recover._apiPending) {
        recover._apiPending = true;
        stallLog('info', 'API canlı kontrolü başlatıldı', v, stalledMs);
        Promise.resolve(KC.checkCurrentLive())
          .then((live) => {
            recover._apiPending = false;
            recover._apiLive = live;
            const vv = getVideo();
            stallLog('info', 'API sonucu: live=' + String(live), vv, Date.now() - lastProgressAt);
            // API canlı + hâlâ tampon/oynuyor → bu takılma sahte, bırak
            if (live === true) {
              if (vv && !vv.paused && hasPlayableBuffer(vv)) {
                stageDone = 0;
                lastProgressAt = Date.now();
                stallLog('info', 'API canlı + tampon → sahte takılma, iptal', vv, 0);
                return;
              }
            }
            // API offline/null veya gerçekten tampon yok → normal recover yoluna devam (bir sonraki tick)
          })
          .catch((err) => {
            recover._apiPending = false;
            stallLog('warn', 'API canlı kontrolü hata: ' + (err && err.message || err), v, stalledMs);
          });
      }
      // API sonucu gelene kadar agresif stage 2/3 uygulama (sadece stage1 nudge serbest)
      if (recover._apiLive === true && hasPlayableBuffer(v)) {
        stageDone = 0;
        return;
      }
      if (recover._apiPending && stalledMs < stage3Ms() + 5000) {
        // henüz API cevabı yok, soft nudge dışında bekle
        if (stageDone < 1 && stalledMs >= stage1Ms()) {
          stageDone = 1;
          const how = nudge(v);
          lastStageName = '1:' + how;
          if (v.paused || farming()) playSafe(v);
          stallLog('warn', 'stage1 nudge (API beklerken): ' + how, v, stalledMs);
        }
        return;
      }
    }

    if (stalledMs >= stage3Ms() && stageDone < 3) {
      stageDone = 3;
      lastStageName = '3:hard';
      toast('Yayın takıldı — oynatıcı yeniden başlatılıyor…');
      stallLog('error', 'stage3 hardReplay', v, stalledMs);
      // v1.3.44: pause() YOK — sağlıklı yayını durdurmasın
      hardReplay(v);
      // v1.3.70: 1.5 sn sonraki tekrar denemeden önce durum doğrula —
      // video toparladıysa veya eleman değiştiyse gereksiz müdahale etme.
      // İlerleme örneği zamanlama ÖNCESİ alınır, callback'te karşılaştırılır.
      // Ölçüm hatası (getVideoPlaybackQuality throw) İPTAL sayılır — müdahale etme.
      const preT3 = Number(v.currentTime) || 0;
      let preF3 = -1;
      let preOk3 = true;
      try {
        if (v.getVideoPlaybackQuality) {
          const q3 = v.getVideoPlaybackQuality();
          if (q3) preF3 = q3.totalVideoFrames;
        }
      } catch (_) { preOk3 = false; } // ölçüm hatası → sonra da ölçüm hatası olursa iptal et
      setTimeout(() => {
        try {
          const vv = getVideo();
          if (!vv || vv !== v || vv.ended) return; // video değişti/bitti — dokunma
          if (!enabled() || !autoOn()) return; // ayarlar kapandı — dokunma
          if (vv.paused && !farming()) return; // kullanıcı duraklattı — dokunma
          // İlerleme kontrolü: zaman VEYA kare ilerlediyse toparlandı — dokunma
          let curT3 = Number(vv.currentTime) || 0;
          let curF3 = -1;
          let curOk3 = true;
          try {
            if (vv.getVideoPlaybackQuality) {
              const q4 = vv.getVideoPlaybackQuality();
              if (q4) curF3 = q4.totalVideoFrames;
            }
          } catch (_) { curOk3 = false; }
          // Ölçüm hatası → İPTAL (bilinmeyen durumda müdahale etme)
          if (!preOk3 || !curOk3) return;
          const tMoved3 = Math.abs(curT3 - preT3) > 0.05;
          const fMoved3 = curF3 >= 0 && preF3 >= 0 && curF3 > preF3;
          if (tMoved3 || fMoved3) return; // toparladı — ekstra hardReplay gerekmez
          if (!vv.paused && hasPlayableBuffer(vv)) return; // akıyor — dokunma
          // hâlâ takılı — tekrar dene
          hardReplay(vv);
        } catch (_) { /* doğrulama hatası → dokunma */ }
      }, 1500);
      return;
    }
    if (stalledMs >= stage2Ms() && stageDone < 2) {
      stageDone = 2;
      lastStageName = '2:pause-play';
      toast('Yayın takıldı — oynatıcı yeniden başlatılıyor…');
      stallLog('warn', 'stage2 hardReplay', v, stalledMs);
      // v1.3.44: pause() YOK — Kick oynatıcısı bunu kullanıcı duraklatması sanıp geride kalıyordu
      hardReplay(v);
      return;
    }
    if (stalledMs >= stage1Ms() && stageDone < 1) {
      // v1.3.44: video oynuyor ve tamponu varsa (readyState>=3) Kick kendi toparlıyor → karışma
      if (!v.paused && v.readyState >= 3 && !loadingStuck) {
        stallLog('info', 'stage1 atlandı (readyState>=3 + oynuyor)', v, stalledMs);
        return;
      }
      stageDone = 1;
      const how = nudge(v);
      lastStageName = '1:' + how;
      if (v.paused || farming()) playSafe(v);
      if (loadingStuck) clickPlayOverlay();
      toast('Yayın takıldı — düzeltiliyor (' + how + ')');
      stallLog('warn', 'stage1: ' + how + (loadingStuck ? ' +overlay' : ''), v, stalledMs);
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
    if (!autoOn()) return stalledMs < 8000 ? 'İzleniyor' : 'Elle düzelt';
    if (stalledMs < stage1Ms()) return 'İzleniyor';
    if (stageDone < 1 && stalledMs >= stage1Ms()) return 'Boşluk atlanacak';
    if (stageDone < 2 && stalledMs >= stage2Ms()) return 'Oynatıcı yenilenecek';
    if (stageDone < 3 && stalledMs >= stage3Ms()) return 'Sayfa yenilenebilir';
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
      try {
        if (KC.makeDraggable) KC.makeDraggable(dbgEl, dbgEl, 'pos_stall_debug');
        else if (KC.applyPos) KC.applyPos(dbgEl, 'pos_stall_debug');
      } catch (_) {}
    }
    if (!v) {
      const searching = Date.now() - pageStartAt < 10000;
      dbgEl.innerHTML =
        '<div class="kc-sd-title">Yayın durumu</div>' +
        '<div class="kc-sd-row"><span class="kc-sd-dot ' + (searching ? 'warn' : 'bad') + '"></span><b>' +
        (searching ? 'Player aranıyor…' : 'Video yok') + '</b></div>' +
        (searching ? '' : '<div class="kc-sd-meta">Player yüklenemedi veya sayfa kanal değil</div>');
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
    if (v.paused || v.ended || v.muted) rows.push('<div class="kc-sd-line"><span>Oynatma</span><b>' + playTxt + '</b></div>'); // "Oynuyor" zaten "Akıyor" demek
    if (resTxt !== '—')
      rows.push('<div class="kc-sd-line"><span>Çözünürlük</span><b>' + resTxt + '</b></div>');
    const fi = KC.fpsInfo;
    if (fi && !v.paused)
      rows.push('<div class="kc-sd-line"><span>FPS</span><b>' + fi.fps + ' · atılan ' + fi.dropped + '</b></div>');
    if (ch) rows.push('<div class="kc-sd-line"><span>Kanal</span><b>' + ch + '</b></div>');
    if (!/^(izleniyor|—|-)$/i.test(String(actionTxt).trim())) rows.push('<div class="kc-sd-line"><span>Sıradaki</span><b>' + actionTxt + '</b></div>');
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

  /** "Düzelt" düğmesinin yaptığı işlem — otomatik de bunu kullanır */
  function applyFix(silent) {
    const v = getVideo();
    if (!v || v.ended) return;
    lastAutoFixAt = Date.now();
    try { v.playbackRate = 1; } catch (_) {}
    // Elle "Yayını düzelt": canlıdan geride kalındıysa canlı kenara atla (otomatik onarım eşiği 15 sn, elle 3 sn)
    let behind = 0;
    if (!silent) {
      try {
        const b = v.buffered;
        if (b && b.length) {
          const end = b.end(b.length - 1);
          const lag = end - (Number(v.currentTime) || 0);
          if (lag > 8) { v.currentTime = Math.max(0, end - marginSec()); behind = lag; }
        }
      } catch (_) {}
    }
    hardReplay(v);
    const how = behind ? 'live' : 'hard';
    lastStageName = 'fix:' + how;
    if (!silent) toast(behind ? 'Yayın ' + Math.round(behind) + ' sn geride kalmıştı — canlıya atlandı' : 'Yayın düzeltiliyor…');
    console.log('[KC] stall-guard: fix', how);
  }

  /** Sadece video gerçekten ilerlemiyorsa düzelt (sağlıklı yayına dokunma).
   *  v1.3.68: 1.5 sn bekledikten sonra video elemanının hâlâ aynı olup olmadığını da kontrol et —
   *  yayın yeniden bağlanırken player DOM'da yeniden oluşturulabilir; eski referans "takıldı" görünür
   *  ve sağlıklı yeni videoya gereksiz müdahale edilirdi. */
  function fixIfStalled() {
    if (qualityBusy() || bgIdle()) return;
    // v1.3.74: gecikmeli onarım — girişte ve callback'te enabled() && autoOn() doğrula
    if (!enabled() || !autoOn()) return;
    const v = getVideo();
    if (!v || v.ended) return;
    if (v.paused && !farming()) return;
    const t0 = Number(v.currentTime) || 0;
    let f0 = -1;
    let preOk = true;
    try { const q = v.getVideoPlaybackQuality && v.getVideoPlaybackQuality(); if (q) f0 = q.totalVideoFrames; } catch (_) { preOk = false; }
    setTimeout(() => {
      try {
        const now = getVideo();
        if (!now || now !== v) return; // video elemanı değişti — eski referans geçersiz
        if (now.ended) return;
        if (!enabled() || !autoOn()) return; // ayar kapandı — dokunma
        if (now.paused && !farming()) return; // kullanıcı duraklattı — dokunma
        // İlerleme kontrolü: zaman VEYA kare sayısı ilerlediyse akıyor demektir
        const t1 = Number(now.currentTime) || 0;
        let f1 = -1;
        let curOk = true;
        try { const q = now.getVideoPlaybackQuality && now.getVideoPlaybackQuality(); if (q) f1 = q.totalVideoFrames; } catch (_) { curOk = false; }
        // v1.3.74: ölçüm hatası → İPTAL (bilinmeyen durumda müdahale etme)
        if (!preOk || !curOk) { stallLog('info', 'resize-fix iptal (ölçüm hatası)', now, 0); return; }
        const tMoved = Math.abs(t1 - t0) > 0.2;
        const fMoved = f1 >= 0 && f0 >= 0 && f1 > f0;
        if ((tMoved || fMoved) && !now.paused) return; // akıyor
        if (Date.now() - lastAutoFixAt < 8000) return;
        stallLog('warn', 'düzeltme tetiklendi · kaynak=pencere boyutu değişti · neden=ilerleme yok (video ' + (now.paused ? 'duraklatılmış' : 'takılı') + ')', now, 0);
        applyFix(true);
      } catch (_) { /* doğrulama hatası → dokunma */ }
    }, 1500);
  }

  function fixNow(src) {
    // v1.3.84/85: sağlıklı yayına dokunma; her çağrının KAYNAĞINI ve NEDENİNİ hata günlüğüne yaz
    const who = typeof src === 'string' && src ? src : 'bilinmeyen kaynak';
    try {
      const v = getVideo();
      let why = 'sağlıklı görünüyor';
      if (!v) why = 'video yok';
      else if (v.paused) why = 'video duraklatılmış';
      else if (stalledFor(v) >= 2500) why = 'ilerleme yok (' + Math.round(stalledFor(v) / 1000) + ' sn)';
      else if (v.readyState < 3) why = 'veri bekliyor (readyState=' + v.readyState + ')';
      if (v && !v.ended && !v.paused && hasPlayableBuffer(v) && stalledFor(v) < 2500) {
        toast('Yayın akıyor — düzeltmeye gerek yok (canlıya geçmek için "Gecikmeyi düzelt")');
        stallLog('info', 'düzelt atlandı · kaynak=' + who + ' · yayın akıyor', v, 0);
        return;
      }
      stallLog('warn', 'düzeltme tetiklendi · kaynak=' + who + ' · neden=' + why, v, 0);
    } catch (_) {}
    stageDone = 0;
    applyFix(false);
  }
  KC.fixStreamNow = fixNow;

  // ── Gecikmeyi düzelt: canlı yayına yetiş ──────────────────────────────────
  // 1) Kick'in kendi "Canlı Yayına Geç" düğmesi varsa ona basar (gerçek canlı kenarı o bilir)
  // 2) Düğme yoksa / işe yaramadıysa videoyu seekable (canlı kenar) sonuna atlatır
  const LIVE_BTN_RE = /canl[ıiİI]\s*yay[ıiİI]na\s*ge[çcÇC]|(go|jump|skip|back|return)\s*to\s*live/i;
  let lastLagFixAt = 0;
  let lagTimer = null;

  /** Sadece kanal sayfasında (kick.com/kanal) canlı yayın var; /video, /clips vb. değil */
  function isLivePage() {
    try {
      const p = (location.pathname || '').split('/').filter(Boolean);
      if (p.length !== 1) return false;
      return !/^(categories|category|browse|following|dashboard|search|terms|privacy|support|settings|drops)$/i.test(p[0]);
    } catch (_) {
      return false;
    }
  }

  /** Tampon sonuna göre ileri tampon (sn). NOT: seekable.end güvenilmez (IVS ~1e9 sahte değer verir) → kullanılmaz */
  function liveLag(v) {
    try {
      const b = v.buffered;
      if (b && b.length) {
        const lag = b.end(b.length - 1) - (Number(v.currentTime) || 0);
        if (isFinite(lag) && lag > 0 && lag < 600) return lag;
      }
    } catch (_) {}
    return 0;
  }

  function visible(el) {
    try {
      if (!el.getClientRects().length) return false;
      const st = getComputedStyle(el);
      return st.display !== 'none' && st.visibility !== 'hidden';
    } catch (_) {
      return false;
    }
  }

  /** Oynatıcıdaki "Canlı Yayına Geç" düğmesini bul */
  function findLiveButton(anyState) {
    try {
      const hits = [];
      let root = document;
      if (!anyState) {
        // v1.3.44: otomatik kontrolde (1.5 sn'de bir) tüm sayfa yerine oynatıcı çevresini tara
        const vv = getVideo();
        let n = vv;
        for (let i = 0; n && i < 6; i++) n = n.parentElement;
        if (n && n !== document.body && n !== document.documentElement) root = n;
      }
      const nodes = root.querySelectorAll('button, [role="button"], a, span, div, p');
      for (const el of nodes) {
        if (el.closest('[id^="kc-"]')) continue;
        if (el.children.length > 3) continue;
        const txt = ((el.textContent || '').trim() + ' ' + (el.getAttribute('aria-label') || '') + ' ' + (el.getAttribute('title') || '')).trim();
        if (!txt || txt.length > 60 || !LIVE_BTN_RE.test(txt)) continue;
        if (!anyState && !visible(el)) continue; // elle kullanımda gizli (idle) düğme de olur
        hits.push(el);
      }
      // En içteki eşleşmeyi seç (içinde başka eşleşme olanı atla)
      const inner = hits.filter((h) => !hits.some((o) => o !== h && h.contains(o)));
      for (const el of inner) {
        const target = el.closest('button, [role="button"], a') || el;
        if (target.disabled || target.getAttribute('aria-disabled') === 'true') continue;
        return target;
      }
    } catch (_) {}
    return null;
  }

  /** Kick düğmesi tam "Canlı Yayına Geç" yazmıyorsa (ör. sadece "CANLI"/"LIVE" rozeti): oynatıcı çevresinde gevşek eşleşme */
  function findLiveButtonLoose() {
    try {
      const vv = getVideo();
      let root = vv;
      for (let i = 0; root && i < 8; i++) root = root.parentElement;
      if (!root || root === document.body || root === document.documentElement) root = document;
      const BAD = /chat|sohbet|viewer|izleyici|offline|çevrimdışı|cevrimdisi|follow|takip|subscri|abone|clip|klip/i;
      for (const el of root.querySelectorAll('button, [role="button"]')) {
        if (el.closest('[id^="kc-"]')) continue;
        if (el.disabled || el.getAttribute('aria-disabled') === 'true') continue;
        const txt = [el.textContent, el.getAttribute('aria-label'), el.getAttribute('title'), el.getAttribute('data-testid'),
          typeof el.className === 'string' ? el.className : ''].filter(Boolean).join(' ').trim();
        if (!txt || txt.length > 80 || BAD.test(txt)) continue;
        if (/(^|[^a-z])live([^a-z]|$)|canl[ıi]/i.test(txt)) return el;
      }
    } catch (_) {}
    return null;
  }

  /** Yalnızca metne göre: "Canlı Yayına Geç" yazan metin düğümünü bul (çocuk sayısı / uzunluk sınırı yok) */
  function findLiveButtonByText() {
    try {
      const w = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
      let n;
      while ((n = w.nextNode())) {
        const tx = n.nodeValue;
        if (!tx || tx.length > 40 || !LIVE_BTN_RE.test(tx)) continue;
        const el = n.parentElement;
        if (!el || el.closest('[id^="kc-"]')) continue;
        const t = el.closest('button, [role="button"], a') || el;
        if (t.disabled || t.getAttribute('aria-disabled') === 'true') continue;
        return t;
      }
    } catch (_) {}
    return null;
  }

  /** Kick oynatıcı kontrolleri boşta kalınca gizlenir/kaldırılır → fare hareketi taklit edip uyandır */
  function wakeControls(v) {
    try {
      const r = v.getBoundingClientRect();
      const o = { bubbles: true, cancelable: true, view: window, clientX: r.left + r.width / 2, clientY: r.top + r.height - 30 };
      for (const t of [v, v.parentElement, v.parentElement && v.parentElement.parentElement]) {
        if (!t) continue;
        for (const type of ['pointerover', 'mouseover', 'pointermove', 'mousemove']) {
          const Ev = type.indexOf('pointer') === 0 && typeof PointerEvent === 'function' ? PointerEvent : MouseEvent;
          t.dispatchEvent(new Ev(type, o));
        }
      }
    } catch (_) {}
  }
  let lastWakeAt = 0;

  /** Gerçek kullanıcı tıklaması gibi: pointer/mouse olay dizisi */
  function realClick(el) {
    try {
      const o = { bubbles: true, cancelable: true, view: window, button: 0 };
      for (const t of ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click']) {
        const Ev = t.indexOf('pointer') === 0 && typeof PointerEvent === 'function' ? PointerEvent : MouseEvent;
        el.dispatchEvent(new Ev(t, o));
      }
      return true;
    } catch (_) {
      try { el.click(); return true; } catch (__) { return false; }
    }
  }

  /** Canlı kenara yetiş: tampon ucuna atla, tampon büyüdükçe tekrar atla (en fazla 40 adım ≈ 60 sn), gecikme ≤4 sn olunca dur.
   *  Kick'in düğmesi gerçek canlı kenarı bilir; düğme yetmezse (5-10 sn atlayıp kalma) bu kovalama kalan farkı kapatır. */
  function chaseLive(v, silent, firstDelay) {
    let n = 0, lastEnd = -1, noGrow = 0;
    const step = () => {
      try {
        const vv = getVideo();
        if (!vv || vv !== v || vv.ended) return;
        if (inBackground()) return; // sekme arka plana geçti: zamanlayıcılar yavaş, seek zinciri anlamsız
        const b = vv.buffered;
        if (!b || !b.length) return;
        const end = b.end(b.length - 1);
        const t = Number(vv.currentTime) || 0;
        if (!isFinite(end) || end > 1e7) return;
        const lag = end - t;
        n++;
        if (lastEnd >= 0 && end - lastEnd < 1.0) noGrow++; else noGrow = 0;
        lastEnd = end;
        const mg = marginSec();
        if (lag <= mg + 1.5 || noGrow >= 2 || n > 40) {
          lastLagFixAt = Date.now();
          stallLog('info', 'canlıya kovalama bitti · adım=' + n + ' · ileriTampon=' + Math.max(0, lag).toFixed(1) + 's', vv, 0);
          if (!silent) toast(lag <= mg + 1.5 ? 'Canlıya yetişildi' : 'Canlı kenara en yakın nokta');
          return;
        }
        vv.currentTime = Math.max(0, end - mg);
        lastLagFixAt = Date.now();
        if (vv.paused && farming()) playSafe(vv);
      } catch (_) { return; }
      setTimeout(step, 1500);
    };
    setTimeout(step, firstDelay);
  }

  function seekToLiveEdge(v) {
    try {
      const b = v.buffered;
      if (b && b.length) {
        const end = b.end(b.length - 1);
        if (isFinite(end) && end < 1e7 && end - (Number(v.currentTime) || 0) > marginSec() + 0.5) {
          v.currentTime = Math.max(0, end - marginSec());
          return true;
        }
      }
    } catch (_) {}
    return false;
  }

  /** Gecikmeyi düzelt. silent=true → otomatik (bildirim yok). Döner: yapılan işlem adı ya da '' */
  function catchUpLive(silent) {
    const v = getVideo();
    if (!v || v.ended) {
      if (!silent) toast('Video bulunamadı');
      return '';
    }
    if (!isLivePage()) {
      if (!silent) toast('Bu sayfada canlı yayın yok');
      return '';
    }
    if (silent && (qualityBusy() || bgIdle())) return '';
    // v1.3.77: manuel yolda kısa tekrar engeli — loglarda 1-3 sn arayla tekrar tetiklenmişti;
    // her seek tamponu sıfırladığından art arda seek takılmayı uzatıyordu.
    if (!silent && Date.now() - lastLagFixAt < 4000) {
      toast('Canlıya geçiş zaten yapılıyor — birkaç saniye bekle');
      return '';
    }
    const before = liveLag(v);
    let btn = findLiveButton(!silent) || (!silent ? (findLiveButtonLoose() || findLiveButtonByText()) : null);
    // v1.3.79: elle basıldı ama düğme yok → kontroller gizli olabilir; uyandır, 0.4 sn sonra yeniden dene
    if (!silent && !btn && Date.now() - lastWakeAt > 3000) {
      lastWakeAt = Date.now();
      wakeControls(v);
      setTimeout(() => { try { catchUpLive(false); } catch (_) {} }, 400);
      return '';
    }
    if (!btn && before < 5) {
      if (!silent) toast('Zaten canlıdasın (gecikme ' + before.toFixed(1) + ' sn)');
      return '';
    }
    lastLagFixAt = Date.now();
    try { v.playbackRate = 1; } catch (_) {}

    let how = '';
    if (btn) {
      if (realClick(btn)) how = 'button';
    }
    if (!how) how = seekToLiveEdge(v) ? 'seek' : '';
    if (v.paused && farming()) playSafe(v);

    // v1.3.78: düğme basıldıysa Kick'e zıplaması için 1.2 sn tanı, sonra kalan farkı kovala;
    // düğme yoksa zaten attık → hemen kovalamaya devam et
    if (how) chaseLive(v, silent, how === 'button' ? 1200 : 1500);

    lastStageName = (silent ? 'lag:' : 'fix:') + how;
    if (!silent) toast(how ? 'Canlıya geçildi' : 'Canlı kenar bulunamadı');
    else if (how) toast('Gecikme eşiği aşıldı — canlıya geçildi');
    stallLog(
      how ? 'warn' : 'info',
      (silent ? 'oto ' : 'elle ') + 'canlıya-geç: ' + (how || 'yok') +
        ' · önce=' + before.toFixed(1) + 's · düğme=' + (btn ? 'var' : 'yok'),
      v,
      0
    );
    // v1.3.77: seek sonrası toparlanma takibi — 2 sn sonra durum logla
    // (seek'in ardından akışın geri gelip gelmediğini ayırt etmek için)
    if (how === 'seek' || how === 'button') {
      const preSeekT = Number(v.currentTime) || 0;
      let preSeekF = -1;
      try { const q = v.getVideoPlaybackQuality && v.getVideoPlaybackQuality(); if (q) preSeekF = q.totalVideoFrames; } catch (_) {}
      setTimeout(() => {
        try {
          const vv = getVideo();
          if (!vv || vv !== v) return;
          let f2 = -1;
          try { const q = vv.getVideoPlaybackQuality && vv.getVideoPlaybackQuality(); if (q) f2 = q.totalVideoFrames; } catch (_) {}
          const t2 = Number(vv.currentTime) || 0;
          const advanced = Math.abs(t2 - preSeekT) > 0.05 || (f2 >= 0 && preSeekF >= 0 && f2 > preSeekF);
          const rs = vv.readyState;
          const lag2 = liveLag(vv);
          stallLog(
            advanced ? 'info' : 'warn',
            'seek sonrası durum: ' + (advanced ? 'akıyor' : 'ilerlemiyor') +
              ' · readyState=' + rs + ' · ileriTampon=' + lag2.toFixed(1) + 's',
            vv,
            0
          );
        } catch (_) {}
      }, 2000);
    }
    return how;
  }
  KC.catchUpLive = catchUpLive;
  KC.hasLiveButton = function () { return !!findLiveButton(); };
  KC.getLiveLag = function () {
    const v = getVideo();
    return v ? liveLag(v) : 0;
  };

  /** "Gecikmede otomatik onar" (1.5 sn'de bir kontrol). Eşik = menüdeki "Gecikme" rakamı (sn):
   *  - Gecikme (ileri tampon) eşiği (en az 3 sn) iki kontrol üst üste aşarsa canlıya geçer
   *    (Kick "geride" işaretini gösteriyorsa eşiğin %80'i yeter; tampon ~30 sn'de tavan yaptığı için)
   *    (Kick'in "Canlı Yayına Geç" düğmesi varsa ona basar, yoksa tampon sonuna atlar).
   *  - Yedek: düğme gecikme rakamı küçük görünse bile uzun süre (en az 60 sn) ekrandaysa düğmeye basar.
   *  Canlıyken (düğme yok, gecikme küçük) hiçbir şey yapmaz. */
  let btnSince = 0;
  let bufHits = 0;
  function lagThreshold() {
    const n = parseFloat(KC.settings?.stall_lag_sec);
    return Math.max(1, Math.min(120, isFinite(n) && n > 0 ? n : 30));
  }
  function autoLagTick() {
    try {
      const v = getVideo();
      if (!enabled() || !autoOn() || !v || v.ended || v.paused || !isLivePage() || Date.now() - pageStartAt < 8000 || qualityBusy() || bgIdle()) { btnSince = 0; bufHits = 0; return; }
      // v1.3.68: yalnız buffer-ahead'e dayanan otomatik seek'i engelle (buffer-ahead "gecikme" değildi).
      // Düğme varsa (Kick'in kendi "Canlıya Geç" kontrolü = gerçek catch-up sinyali) akış korunur.
      // Salt-okunur ölçüm: observeProgress'in yan etkilerine dokunmaz.
      const hasBtnNow = !!findLiveButton();
      const vq = (function () { try { return v.getVideoPlaybackQuality && v.getVideoPlaybackQuality(); } catch (_) { return null; } })();
      const curT = Number(v.currentTime) || 0;
      const curF = vq ? vq.totalVideoFrames : -1;
      if (autoLagTick._lt == null || autoLagTick._lt < 0 || autoLagTick._v !== v) {
        autoLagTick._v = v; autoLagTick._lt = curT; autoLagTick._lf = curF;
        return; // ilk ölçüm — sonuç yok, bekle
      }
      const tAdvanced = Math.abs(curT - autoLagTick._lt) > 0.05;
      const fAdvanced = curF >= 0 && autoLagTick._lf >= 0 && curF > autoLagTick._lf;
      autoLagTick._lt = curT; autoLagTick._lf = curF;
      const advancing = tAdvanced || fAdvanced;
      if (advancing && !hasBtnNow) {
        // Akıyor + site catch-up kontrolü yok → buffer-ahead'i "gecikme" sanma, seek atma.
        // (Düğme varsa akış normaldir: site kendisi geride olduğunu söylüyor — devam et.)
        btnSince = 0; bufHits = 0; return;
      }
      const now = Date.now();
      const thr = lagThreshold();
      const cool = now - lastLagFixAt >= coolMs();
      const hasBtn = !!findLiveButton();
      btnSince = hasBtn ? (btnSince || now) : 0;
      const lag = liveLag(v);

      // Oynuyor + tampon sağlıklı + Kick "Canlıya geç" göstermiyorsa → karışma
      // (sadece buffered lag yüksek diye sık sık seek etmek yayını dondurabiliyordu)
      if (!hasBtn && hasPlayableBuffer(v) && lag < Math.max(thr, 12)) {
        bufHits = 0;
        return;
      }

      // Kick'in kendi "geride" düğmesi varken eşiğin %80'i; düğme yoksa tam eşik + en az 3 ardışık ölçüm
      const need = Math.max(hasBtn ? thr * 0.8 : thr, 3);
      if (lag > need) {
        bufHits++;
        const needHits = hasBtn ? 2 : 3;
        if (bufHits >= needHits && cool) {
          stallLog('warn', 'gecikme eşiği: lag=' + lag.toFixed(1) + 's thr=' + need.toFixed(1) +
            ' hits=' + bufHits + ' düğme=' + (hasBtn ? 'var' : 'yok'), v, 0);
          bufHits = 0;
          btnSince = 0;
          catchUpLive(true);
        }
        return;
      }
      bufHits = 0;
      // Yedek: düğme uzun süre ekrandaysa (en az 90 sn veya eşik*2.5) bas
      if (hasBtn && now - btnSince >= Math.max(90, thr * 2.5) * 1000 && cool) {
        stallLog('warn', 'gecikme yedek: Canlıya Geç düğmesi ' +
          Math.round((now - btnSince) / 1000) + 's ekranda', v, 0);
        btnSince = 0;
        catchUpLive(true);
      }
    } catch (_) {}
  }
  function startLagWatch() {
    if (lagTimer) return;
    lagTimer = setInterval(autoLagTick, 1500);
  }
  function stopLagWatch() {
    if (lagTimer) clearInterval(lagTimer);
    lagTimer = null;
    btnSince = 0;
    bufHits = 0;
  }
  KC.settingsReady.then(() => {
    // Sadece otomatik onar açıksa gecikme izle
    if (KC.settings?.stall_auto) startLagWatch();
  });
  KC.on('setting:stall_auto', (on) => {
    if (on) startLagWatch();
    else stopLagWatch();
  });


  /** Videonun üstünde dönen yükleniyor simgesi var mı? */
  function spinnerOnVideo(v) {
    try {
      const vr = v.getBoundingClientRect();
      if (vr.width < 40 || vr.height < 40) return false;
      const nodes = document.querySelectorAll(
        '[class*="spinner" i], [class*="loader" i], [aria-busy="true"]'
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

  /** Video gerçekten ilerliyor mu? (Onarıcı kapalı olsa da durum kutusu / dashboard doğru göstersin diye
   *  ayrı tutuldu; tick, durum kutusu ve anlık görüntü hepsi bunu çağırır.) true = ilerliyor. */
  function observeProgress(v) {
    const now = Date.now();
    if (v !== lastVideo) {
      lastVideo = v;
      lastTime = -1;
      lastFrames = -1;
      lastProgressAt = now;
      stageDone = 0;
    }
    if (v.ended) return false;
    const t = Number(v.currentTime) || 0;
    let frames = -1;
    try {
      const q = v.getVideoPlaybackQuality && v.getVideoPlaybackQuality();
      if (q) frames = q.totalVideoFrames;
    } catch (_) {}
    const advanced = lastTime < 0 || Math.abs(t - lastTime) > 0.05;
    const framesAdvanced = frames >= 0 && lastFrames >= 0 && frames > lastFrames;
    lastFrames = frames;
    if (!v.paused && (advanced || framesAdvanced)) {
      lastTime = t;
      lastProgressAt = now;
      return true;
    }
    return false;
  }

  function stalledFor(v) {
    try { if (v) observeProgress(v); } catch (_) {}
    return Date.now() - lastProgressAt;
  }

  function tick() {
    dismissChatRules();
    const v = getVideo();
    if (!dbgTimer && dbgEl) updateDebug(null, 0); // kutu kapalıysa temizle
    if (!v) return;
    const now = Date.now();

    // Onarıcı kapalı olsa bile ilerleme takibi + donma logu (internet mi diye bakmak için)
    const progressing = observeProgress(v);
    if (v.ended) return;

    if (progressing) {
      stageDone = 0;
      try { maybeLogRecover(v); } catch (_) {}
      return;
    }

    // Kullanıcı bilerek durdurduysa (farm kapalıyken) log/onarma yok
    if (v.paused && !farming()) {
      lastProgressAt = now;
      return;
    }

    const stalledMs = now - lastProgressAt;
    // Her zaman logla (onarıcı kapalı olsa bile) — sebep: internet mi / yerel mi
    try { maybeLogFreeze(v, stalledMs); } catch (_) {}

    if (!enabled()) return;
    // Arka planda tarayıcı videoyu kendisi durdurabilir → her tikte play() ile kavga etme (15 sn'de bir dene)
    if (v.paused && farming() && (!bgIdle() || Date.now() - lastBgPlayAt > 15000)) { lastBgPlayAt = Date.now(); playSafe(v); }

    // Otomatik onarım kapalıysa sadece izle + log; elle "Yayını düzelt" yine çalışır
    if (!autoOn()) return;

    recover(v, stalledMs);
  }

  // Pencere boyutu değişince kısa süre sonra hızlı kontrol
  let lastW = window.innerWidth, lastH = window.innerHeight;
  function onResize(e) {
    const w = window.innerWidth, h = window.innerHeight;
    const shrunk = w < lastW || h < lastH;
    lastW = w; lastH = h;
    if (!enabled()) return;
    if (e && e.isTrusted === false) return; // kendi gönderdiğimiz resize olayını yok say
    // v1.3.74: onarım SADECE otomatik onarım AÇIKSA çalışır — kapalıysa hiç dokunma
    if (!autoOn()) return;
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => {
      // Oynatıcı boyuta geç tepki verebilir → birkaç kez dene
      [0, 2000, 4500, 8000, 13000].forEach((d) => {
        setTimeout(() => enabled() && autoOn() && fixIfStalled(), d);
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

  function pageOfflineHint() {
    try {
      const norm = (s) =>
        String(s || '')
          .toLowerCase()
          .replace(/ı/g, 'i')
          .replace(/İ/g, 'i')
          .replace(/\s+/g, ' ');
      const text = norm((document.body && document.body.innerText) || '').slice(0, 3500);
      return /\b(cevrim\s*disi|offline)\b/.test(text);
    } catch (_) {
      return false;
    }
  }

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
    const stalledMs = Math.max(0, now - Math.max(lastProgressAt, snapLastProgressAt, v ? now - stalledFor(v) : 0));
    let ch = '';
    try {
      const p = (location.pathname || '').split('/').filter(Boolean);
      if (p.length === 1) ch = p[0];
    } catch (_) {}

    if (pageOfflineHint()) {
      return {
        status: 'Çevrimdışı',
        statusClass: 'bad',
        buffer: '—',
        bufferSec: '',
        play: 'Kapalı',
        res: '—',
        channel: ch,
        next: 'Sonraki kanal',
        last: stageLabel(lastStageName)
      };
    }

    if (!v) {
      return {
        status: 'Video yok',
        statusClass: 'bad',
        buffer: '—',
        bufferSec: '',
        play: '—',
        res: '—',
        channel: ch,
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

  // Durum kutusu: kendi hızlı zamanlayıcısı (500 ms) — açılınca anında çizilir
  function renderDebugNow() {
    try { const v = getVideo(); updateDebug(v, stalledFor(v)); } catch (_) {}
  }
  function startDebug() {
    if (dbgTimer) return;
    renderDebugNow();
    dbgTimer = setInterval(renderDebugNow, 500);
  }
  function stopDebug() {
    if (dbgTimer) clearInterval(dbgTimer);
    dbgTimer = null;
    if (dbgEl) { dbgEl.remove(); dbgEl = null; }
  }

  // online/offline → hata günlüğüne
  try {
    window.addEventListener('online', () => {
      try {
        if (typeof KC.elog === 'function') KC.elog('info', 'stall', 'internet GERI GELDI (online)', netSnap());
      } catch (_) {}
    });
    window.addEventListener('offline', () => {
      try {
        if (typeof KC.elog === 'function') KC.elog('error', 'stall', 'internet KOPTU (offline)', netSnap());
      } catch (_) {}
    });
  } catch (_) {}

  KC.settingsReady.then(() => {
    // Donma logu için tick her zaman çalışsın (enabled olmasa bile observe + maybeLogFreeze)
    start();
    if (KC.settings?.stall_debug) startDebug();
    else stopDebug();
  });
  KC.on('setting:stall_guard', () => {
    // Timer her zaman açık (donma logu); onarma autoOn/enabled ile sınırlı
    start();
  });
  KC.on('setting:stall_debug', (on) => {
    start();
    if (on) startDebug();
    else stopDebug();
  });
})();
