(function () {
  const KC = (window.KickControl = window.KickControl || {});

  let botTimer = null;
  let switchCooldownUntil = 0;
  let liveCache = [];
  let liveCacheAt = 0;
  let consecutiveBad = 0;
  let lastVideoTime = 0;
  let lastVideoProgressAt = 0;
  let statusText = 'Kapalı';
  const BAD_NEED = 3; // ~3 ticks before switch
  const TICK_MS = 6000;
  const STUCK_MS = 18000; // no progress this long → stuck

  // ── Keep tab "active" so Kick still awards watch level XP ──
  (function keepAwake() {
    try {
      const desc = Object.getOwnPropertyDescriptor(Document.prototype, 'hidden') ||
        Object.getOwnPropertyDescriptor(document, 'hidden');
      if (!desc || desc.configurable) {
        Object.defineProperty(document, 'hidden', { configurable: true, get: () => false });
      }
      const desc2 = Object.getOwnPropertyDescriptor(Document.prototype, 'visibilityState') ||
        Object.getOwnPropertyDescriptor(document, 'visibilityState');
      if (!desc2 || desc2.configurable) {
        Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'visible' });
      }
    } catch (_) {}
    try {
      document.addEventListener('visibilitychange', (e) => {
        e.stopImmediatePropagation();
      }, true);
    } catch (_) {}
    // Periodic activity so the player / Kick analytics don't idle-out
    setInterval(() => {
      if (
        !KC.settings?.level_bot &&
        !KC.settings?.anti_stuck &&
        !KC.settings?.bg_watch &&
        !KC.settings?.drops_enabled
      )
        return;
      try {
        window.dispatchEvent(
          new MouseEvent('mousemove', {
            bubbles: true,
            clientX: 2 + (Date.now() % 7),
            clientY: 2 + (Date.now() % 5)
          })
        );
      } catch (_) {}
      try {
        const v =
          document.getElementById('video-player') ||
          document.querySelector('video#video-player, video[src], video');
        if (v && v.paused && !v.ended) v.play().catch(() => {});
        if (v && v.muted) v.muted = false;
        if (v && (!v.volume || v.volume < 0.02)) v.volume = 0.05;
      } catch (_) {}
    }, 15000);
  })();

  function setStatus(msg) {
    try {
      if (typeof msg === 'string' && KC.t && /^[a-z0-9_]+$/i.test(msg)) {
        const tr = KC.t(msg);
        if (tr) msg = tr;
      }
    } catch (_) {}
    statusText = msg;
    try {
      KC.emit('bot:status', msg);
    } catch (_) {}
    try {
      const el = document.getElementById('kc-lhud-status');
      if (el) el.textContent = msg || '';
    } catch (_) {}
  }

  function currentSlug() {
    try {
      const p = location.pathname.split('/').filter(Boolean);
      if (
        p.length === 1 &&
        !/^(categories|category|video|videos|browse|search|following|dashboard|settings|login|signup|community|clips)$/i.test(
          p[0]
        )
      ) {
        return p[0].toLowerCase();
      }
    } catch (_) {}
    return '';
  }

  function getVideo() {
    return (
      document.getElementById('video-player') ||
      document.querySelector('video#video-player, video[src], video')
    );
  }

  /** Media is actually advancing */
  function isVideoHealthy() {
    const v = getVideo();
    if (!v) return false;
    const now = Date.now();
    const t = Number(v.currentTime) || 0;
    if (t > lastVideoTime + 0.15) {
      lastVideoTime = t;
      lastVideoProgressAt = now;
      return true;
    }
    if (lastVideoProgressAt && now - lastVideoProgressAt < 10000) {
      return !v.ended && (v.readyState >= 2 || !v.paused);
    }
    if (!v.paused && !v.ended && v.readyState >= 2) {
      lastVideoProgressAt = now;
      return true;
    }
    return false;
  }

  function isVideoStuck() {
    const v = getVideo();
    if (!v) return true;
    if (v.ended) return true;
    const now = Date.now();
    // Never seen progress
    if (!lastVideoProgressAt) {
      // give first load some time
      return now - (v.dataset?.kcSeenAt ? Number(v.dataset.kcSeenAt) : now) > STUCK_MS;
    }
    return now - lastVideoProgressAt > STUCK_MS;
  }

  function pageSaysOffline() {
    try {
      // Tight selectors first (cheap)
      const tight = document.querySelectorAll(
        '[class*="offline" i], [data-testid*="offline" i], [class*="Offline" i]'
      );
      for (const el of tight) {
        const t = (el.textContent || '').replace(/\s+/g, ' ').trim().toLowerCase();
        if (!t || t.length > 100) continue;
        if (/\b(offline|çevrim\s*dışı|cevrim\s*disi)\b/.test(t)) return true;
      }
      // Title / h1
      const h = document.querySelector('h1, h2');
      if (h) {
        const t = (h.textContent || '').toLowerCase();
        if (/\b(offline|çevrim\s*dışı)\b/.test(t)) return true;
      }
      // Small body sample only
      const bodySlice = (document.body?.innerText || '').slice(0, 2500).toLowerCase();
      if (/\bçevrim\s*dışı\b/.test(bodySlice) || /\bis offline\b/.test(bodySlice)) return true;
    } catch (_) {}
    return false;
  }

  /**
   * live = healthy progressive video
   * bad  = offline UI / no video / stuck
   */
  function getWatchState() {
    const slug = currentSlug();
    if (!slug) return { ok: false, reason: 'kanal-degil', slug: '' };

    const v = getVideo();
    if (v && !v.dataset.kcSeenAt) v.dataset.kcSeenAt = String(Date.now());

    if (pageSaysOffline()) return { ok: false, reason: 'offline-ui', slug };

    if (isVideoHealthy()) return { ok: true, reason: 'video-ok', slug };

    if (!v) return { ok: false, reason: 'video-yok', slug };

    if (isVideoStuck()) return { ok: false, reason: 'video-takili', slug };

    if (v.paused || v.readyState < 2) return { ok: false, reason: 'video-durdu', slug };

    // brief buffer grace
    return { ok: true, reason: 'buffer', slug };
  }

  async function fetchLives() {
    if (Date.now() - liveCacheAt < 25000 && liveCache.length >= 3) return liveCache;
    const slugs = new Set();

    const urls = [
      'https://kick.com/stream/livestreams/en?limit=40',
      'https://kick.com/stream/livestreams/tr?limit=25',
      'https://kick.com/stream/livestreams/en?page=2&limit=20'
    ];

    for (const url of urls) {
      try {
        const res = await fetch(url, {
          credentials: 'include',
          headers: { Accept: 'application/json' },
          cache: 'no-store'
        });
        if (!res.ok) continue;
        const json = await res.json();
        const arr = Array.isArray(json?.data) ? json.data : Array.isArray(json) ? json : [];
        for (const item of arr) {
          if (item?.is_live === false) continue;
          // channel.slug is the URL path (NOT the long session slug)
          const s =
            item?.channel?.slug ||
            item?.channel?.user?.username ||
            item?.user?.username ||
            item?.slug;
          if (!s || typeof s !== 'string') continue;
          const slug = String(s).toLowerCase().trim();
          // skip session-id style slugs (long with dashes + hex)
          if (slug.length > 30 && /[0-9a-f]{8}-/.test(slug)) continue;
          if (slug.length < 2 || slug.length > 28) continue;
          if (
            /^(categories|category|video|videos|browse|search|dashboard|settings|login|signup|following|community|clips)$/.test(
              slug
            )
          )
            continue;
          slugs.add(slug);
        }
        if (slugs.size >= 8) break;
      } catch (e) {
        console.warn('[KC] live fetch fail', url, e);
      }
    }

    // Sidebar / following DOM fallback
    try {
      document.querySelectorAll('a[href^="/"]').forEach((a) => {
        const href = a.getAttribute('href') || '';
        const parts = href.split('/').filter(Boolean);
        if (parts.length !== 1) return;
        const s = parts[0].toLowerCase();
        if (
          /^(categories|category|video|videos|browse|search|dashboard|settings|login|signup|following|community|clips)$/.test(
            s
          )
        )
          return;
        const row = a.closest('div, li') || a.parentElement || a;
        const txt = (row.textContent || '').toLowerCase();
        if (txt.includes('offline') || txt.includes('çevrim')) return;
        if (/\blive\b|\d/.test(txt) || a.querySelector('img, [class*="live" i]')) {
          if (s.length >= 2 && s.length <= 28) slugs.add(s);
        }
      });
    } catch (_) {}

    liveCache = [...slugs];
    liveCacheAt = Date.now();
    console.log('[KC] live cache', liveCache.length, liveCache.slice(0, 8));
    return liveCache;
  }

  /** Optional: confirm channel is still live before navigating */
  async function isSlugLive(slug) {
    try {
      const res = await fetch(
        'https://kick.com/api/v2/channels/' + encodeURIComponent(slug) + '/livestream',
        { credentials: 'include', headers: { Accept: 'application/json' }, cache: 'no-store' }
      );
      if (!res.ok) return null;
      const j = await res.json();
      const data = j?.data ?? j;
      if (!data) return false;
      if (data.is_live === false) return false;
      // presence of id / session means live
      return !!(data.id || data.session_title || data.playback_url);
    } catch (_) {
      return null;
    }
  }

  async function goNextLive(reason) {
    if (Date.now() < switchCooldownUntil) {
      setStatus('Bekleniyor…');
      return;
    }
    const cur = currentSlug();
    setStatus('Canlı aranıyor…');
    const lives = await fetchLives();
    let pool = lives.filter((s) => s !== cur);
    if (!pool.length) pool = lives.slice();
    if (!pool.length) {
      setStatus('Canlı kanal yok');
      console.warn('[KC] Level bot: no live channels', reason);
      return;
    }

    // Shuffle top candidates, prefer verified-live
    pool = pool.slice(0, 30);
    for (let i = pool.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [pool[i], pool[j]] = [pool[j], pool[i]];
    }

    let pick = pool[0];
    for (let i = 0; i < Math.min(5, pool.length); i++) {
      const ok = await isSlugLive(pool[i]);
      if (ok === true) {
        pick = pool[i];
        break;
      }
      if (ok === false) continue;
      // null = unknown API — accept first
      pick = pool[i];
      break;
    }

    switchCooldownUntil = Date.now() + 16000;
    consecutiveBad = 0;
    lastVideoTime = 0;
    lastVideoProgressAt = 0;
    setStatus('Geçiliyor: ' + pick);
    KC.logSwitch(currentSlug() || '', pick, reason || 'level-bot');
    console.log('[KC] Level bot switch', { from: cur, to: pick, reason });
    location.href = 'https://kick.com/' + encodeURIComponent(pick);
  }

  function tickAntiStuck() {
    // Also keep stream healthy while farming drops
    if (
      !KC.settings?.anti_stuck &&
      !KC.settings?.level_bot &&
      !KC.settings?.drops_enabled
    )
      return;
    const v = getVideo();
    if (!v) return;
    try {
      // Soft nudge only — don't blast volume every tick
      if (v.paused && !v.ended) {
        const p = v.play();
        if (p && typeof p.catch === 'function') p.catch(() => {});
      }
      if (v.muted && KC.settings.anti_stuck) {
        // Kick sometimes mutes background tabs — unmute gently
        v.muted = false;
        if (v.volume === 0) v.volume = 0.05;
      }
    } catch (_) {}
  }

  function tickBot() {
    // ONLY Level Bot switches channels. Level Koruması (anti_stuck) never navigates.
    if (!KC.settings?.level_bot) {
      if (KC.settings?.anti_stuck) {
        setStatus('İzleniyor: ' + (currentSlug() || '?'));
      } else {
        setStatus('Kapalı');
      }
      return;
    }

    // Drop izle öncelikli: drop hedefi varken veya drop yayını izlenirken kanal değiştirme
    try {
      if (KC.settings?.drops_enabled && typeof KC.dropsShouldControl === 'function' && KC.dropsShouldControl()) {
        consecutiveBad = 0;
        setStatus('İzleniyor: ' + (currentSlug() || '?') + ' · drops');
        return;
      }
    } catch (_) {}

    const state = getWatchState();
    if (state.ok) {
      consecutiveBad = 0;
      setStatus('İzleniyor: ' + (state.slug || '?'));
      return;
    }

    consecutiveBad++;
    setStatus(
      'Sorun ' + consecutiveBad + '/' + BAD_NEED + ' · ' + (state.slug || '?')
    );
    console.log('[KC] bad tick', consecutiveBad, state);

    if (consecutiveBad >= BAD_NEED) {
      // Son kontrol: arada drop yayını açılmış olabilir
      try {
        if (KC.settings?.drops_enabled && typeof KC.dropsShouldControl === 'function' && KC.dropsShouldControl()) {
          consecutiveBad = 0;
          return;
        }
      } catch (_) {}
      goNextLive(state.reason);
    }
  }

  function start() {
    if (botTimer) clearInterval(botTimer);
    consecutiveBad = 0;
    lastVideoTime = 0;
    lastVideoProgressAt = 0;
    botTimer = setInterval(() => {
      tickAntiStuck();
      tickBot();
    }, TICK_MS);
    setTimeout(tickAntiStuck, 800);
    setTimeout(tickBot, 2000);
    if (KC.settings?.level_bot || KC.settings?.anti_stuck) {
      setStatus('Başladı…');
    }
    console.log('[KC] Level bot started', {
      level_bot: !!KC.settings?.level_bot,
      anti_stuck: !!KC.settings?.anti_stuck
    });
  }

  function stop() {
    if (botTimer) clearInterval(botTimer);
    botTimer = null;
    consecutiveBad = 0;
    if (!KC.settings?.level_bot && !KC.settings?.anti_stuck) {
      setStatus('Kapalı');
    }
  }

  KC.startLevelBot = start;
  KC.stopLevelBot = stop;
  KC.getBotStatus = () => statusText;
  KC.forceSwitchChannel = () => goNextLive('manual');



  // ── Level verisi (birleşik HUD için) ──
  let sessionStartedAt = Date.now();
  let watchSeconds = 0;
  let lastTickAt = Date.now();

  function fmtDur(sec) {
    sec = Math.max(0, Math.floor(sec));
    const h = Math.floor(sec / 3600);
    const m = Math.floor((sec % 3600) / 60);
    const s = sec % 60;
    if (h > 0) return h + 's ' + m + 'dk';
    if (m > 0) return m + 'dk ' + s + 'sn';
    return s + 'sn';
  }

  KC.getLevelHudSnapshot = function () {
    const slug = currentSlug() || '—';
    const v = getVideo();
    let health = 'Bekleniyor';
    let healthClass = 'wait';
    try {
      if (v) {
        if (isVideoHealthy()) {
          health = 'Sağlıklı izleme';
          healthClass = 'ok';
        } else if (v.paused) {
          health = 'Duraklatıldı';
          healthClass = 'bad';
        } else {
          health = 'Takılma riski';
          healthClass = 'warn';
        }
      } else {
        health = 'Video yok';
        healthClass = 'bad';
      }
    } catch (_) {}

    const now = Date.now();
    if (healthClass === 'ok') {
      watchSeconds += (now - lastTickAt) / 1000;
    }
    lastTickAt = now;

    return {
      status: statusText || 'Kapalı',
      slug: slug,
      health: health,
      healthClass: healthClass,
      session: fmtDur((Date.now() - sessionStartedAt) / 1000),
      watch: fmtDur(watchSeconds),
      levelBot: !!KC.settings?.level_bot,
      antiStuck: !!KC.settings?.anti_stuck,
      bgWatch: !!KC.settings?.bg_watch
    };
  };

  function removeSeparateLevelHud() {
    try {
      const old = document.getElementById('kc-level-hud');
      if (old) old.remove();
    } catch (_) {}
  }

  function refreshCombinedHud() {
    removeSeparateLevelHud();
    try {
      if (typeof KC.renderDropsHud === 'function') KC.renderDropsHud();
      else if (typeof renderDropsHud === 'function') renderDropsHud();
    } catch (_) {}
  }

  setInterval(() => {
    try {
      refreshCombinedHud();
    } catch (_) {}
  }, 2000);

  KC.on('bot:status', () => {
    try {
      refreshCombinedHud();
    } catch (_) {}
  });

  KC.settingsReady.then(() => {
    removeSeparateLevelHud();
    if (KC.settings.level_bot || KC.settings.anti_stuck) start();
  });

  KC.on('setting:level_bot', (on) => {
    try { refreshCombinedHud(); } catch (_) {}
    if (on) start();
    else if (!KC.settings.anti_stuck) stop();
    else start();
  });
  KC.on('setting:anti_stuck', (on) => {
    try { refreshCombinedHud(); } catch (_) {}
    if (on || KC.settings.level_bot) start();
    else stop();
  });
})();
