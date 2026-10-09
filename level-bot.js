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
  const STUCK_MS = 22000; // no progress this long → stuck

  // ── Keep tab "active" so Kick still awards watch level XP ──
  (function keepAwake() {
    function farmingActive() {
      return !!(
        KC.settings?.level_bot ||
        KC.settings?.anti_stuck ||
        KC.settings?.bg_watch ||
        KC.settings?.drops_enabled
      );
    }

    // Strong visibility / focus overrides (Page Visibility + hasFocus)
    function forceVisible() {
      try {
        const targets = [
          [Document.prototype, 'hidden', false],
          [Document.prototype, 'visibilityState', 'visible'],
          [document, 'hidden', false],
          [document, 'visibilityState', 'visible']
        ];
        for (const [obj, prop, val] of targets) {
          try {
            const d = Object.getOwnPropertyDescriptor(obj, prop);
            if (!d || d.configurable) {
              Object.defineProperty(obj, prop, {
                configurable: true,
                enumerable: true,
                get: () => val
              });
            }
          } catch (_) {}
        }
      } catch (_) {}
      try {
        if (typeof document.hasFocus === 'function') {
          document.hasFocus = function () { return true; };
        }
      } catch (_) {}
      try {
        Object.defineProperty(document, 'webkitHidden', {
          configurable: true,
          get: () => false
        });
        Object.defineProperty(document, 'webkitVisibilityState', {
          configurable: true,
          get: () => 'visible'
        });
      } catch (_) {}
    }

    forceVisible();
    // Re-apply after Kick scripts may redefine properties
    setTimeout(forceVisible, 2000);
    setTimeout(forceVisible, 8000);

    try {
      document.addEventListener(
        'visibilitychange',
        (e) => {
          try {
            e.stopImmediatePropagation();
            e.stopPropagation();
            e.preventDefault();
          } catch (_) {}
          forceVisible();
        },
        true
      );
    } catch (_) {}

    try {
      window.addEventListener(
        'blur',
        (e) => {
          if (!farmingActive()) return;
          try {
            e.stopImmediatePropagation();
          } catch (_) {}
          try {
            window.dispatchEvent(new FocusEvent('focus'));
          } catch (_) {}
        },
        true
      );
    } catch (_) {}

    // Edge/Chrome: unmute without user gesture pauses the video
    let _userGestured = false;
    function markUserGesture() {
      _userGestured = true;
    }
    try {
      const mark = (e) => {
        if (e && e.isTrusted) markUserGesture();
      };
      window.addEventListener('pointerdown', mark, true);
      window.addEventListener('keydown', mark, true);
      window.addEventListener('touchstart', mark, true);
    } catch (_) {}

    function canUnmute() {
      try {
        if (_userGestured) return true;
        if (navigator.userActivation && navigator.userActivation.hasBeenActive) return true;
      } catch (_) {}
      return false;
    }

    function safePlay(v) {
      if (!v || v.ended) return;
      try {
        // Prefer muted play if no gesture — autoplay policy safe
        if (!canUnmute() && !v.muted) {
          // don't force mute if user already unmuted; just try play
        } else if (!canUnmute()) {
          try { v.muted = true; } catch (_) {}
        } else {
          // User has interacted — gentle volume ok
          try {
            if (v.muted) v.muted = false;
            if (!v.volume || v.volume < 0.02) v.volume = 0.05;
          } catch (_) {}
        }
        if (v.paused) {
          const p = v.play();
          if (p && typeof p.catch === 'function') {
            p.catch(() => {
              // last resort: muted play
              try {
                v.muted = true;
                const p2 = v.play();
                if (p2 && p2.catch) p2.catch(() => {});
              } catch (_) {}
            });
          }
        }
      } catch (_) {}
    }

    function nudgePlayer() {
      try {
        const v =
          document.getElementById('video-player') ||
          document.querySelector('video#video-player, video[src], video');
        if (!v) return;
        safePlay(v);
      } catch (_) {}
    }
    try { KC.safePlayVideo = safePlay; } catch (_) {}

    // Human-like presence: move/scroll/hover — NEVER real .click() on UI
    let _mx = 120 + Math.random() * 200;
    let _my = 100 + Math.random() * 150;
    let _scrollTick = 0;

    function fireMouse(type, x, y, target) {
      try {
        const opts = {
          bubbles: true,
          cancelable: true,
          view: window,
          clientX: Math.round(x),
          clientY: Math.round(y),
          screenX: Math.round(x),
          screenY: Math.round(y),
          buttons: 0,
          button: 0
        };
        const ev = new MouseEvent(type, opts);
        (target || document).dispatchEvent(ev);
        window.dispatchEvent(new MouseEvent(type, opts));
      } catch (_) {}
      try {
        const pev = new PointerEvent(
          type === 'mousemove' ? 'pointermove' : type === 'mouseover' ? 'pointerover' : 'pointermove',
          {
            bubbles: true,
            cancelable: true,
            view: window,
            clientX: Math.round(x),
            clientY: Math.round(y),
            pointerId: 1,
            pointerType: 'mouse',
            isPrimary: true
          }
        );
        (target || document).dispatchEvent(pev);
      } catch (_) {}
    }

    function safeVideoTarget() {
      try {
        return (
          document.getElementById('video-player') ||
          document.querySelector('video#video-player, video[src], video') ||
          document.body
        );
      } catch (_) {
        return document.body;
      }
    }

    let _lastUserAt = 0;
    try {
      const onUser = (e) => {
        if (e && e.isTrusted) _lastUserAt = Date.now();
      };
      ['pointerdown', 'pointermove', 'keydown', 'wheel', 'touchstart'].forEach((ev) => {
        window.addEventListener(ev, onUser, { capture: true, passive: true });
      });
    } catch (_) {}

    function botsFarming() {
      // Heavy sim only when actual farm bots are on — not mere anti_stuck alone
      return !!(KC.settings?.level_bot || KC.settings?.drops_enabled);
    }

    function userIsActive() {
      // User watched / moved in last 45s → don't interfere
      return Date.now() - _lastUserAt < 45000;
    }

    function synthActivity() {
      if (!farmingActive()) return;
      // Never fight the user while they are watching
      if (userIsActive()) return;
      // Full presence sim only with level/drops bots
      if (!botsFarming() && !KC.settings?.bg_watch) return;
      // When only bg_watch (no bots): skip mouse/scroll — nudgePlayer is enough
      if (!botsFarming()) {
        nudgePlayer();
        return;
      }

      // Smooth random walk over video area (not near edges / buttons)
      const w = Math.max(320, window.innerWidth || 800);
      const h = Math.max(240, window.innerHeight || 600);
      const tx = 80 + Math.random() * Math.min(w * 0.55, 700);
      const ty = 60 + Math.random() * Math.min(h * 0.45, 420);
      // interpolate a few steps so it looks like movement, not teleport
      const steps = 2 + Math.floor(Math.random() * 3);
      for (let i = 1; i <= steps; i++) {
        const t = i / steps;
        const x = _mx + (tx - _mx) * t;
        const y = _my + (ty - _my) * t;
        fireMouse('mousemove', x, y, safeVideoTarget());
      }
      _mx = tx;
      _my = ty;

      // Occasional hover over video only (no click)
      if (Math.random() < 0.35) {
        const v = safeVideoTarget();
        fireMouse('mouseover', _mx, _my, v);
        fireMouse('mouseenter', _mx, _my, v);
      }

      // Tiny harmless scroll pulse on window (reversible) — not on inputs
      _scrollTick++;
      if (_scrollTick % 4 === 0) {
        try {
          const dy = Math.random() < 0.5 ? 1 : -1;
          window.scrollBy({ top: dy, left: 0, behavior: 'instant' });
          // undo so page doesn't drift
          setTimeout(() => {
            try {
              window.scrollBy({ top: -dy, left: 0, behavior: 'instant' });
            } catch (_) {}
          }, 50);
        } catch (_) {}
      }

      // Focus only when idle and not typing
      try {
        if (!userIsActive()) {
          const ae = document.activeElement;
          const tag = ae && ae.tagName ? ae.tagName.toLowerCase() : '';
          if (tag !== 'input' && tag !== 'textarea' && !(ae && ae.isContentEditable)) {
            try {
              document.body && document.body.focus && document.body.focus({ preventScroll: true });
            } catch (_) {}
          }
        }
      } catch (_) {}

      // Harmless key pulse (Shift) — does not type or send chat
      if (Math.random() < 0.2) {
        try {
          const kopts = { bubbles: true, cancelable: true, key: 'Shift', code: 'ShiftLeft', keyCode: 16 };
          document.dispatchEvent(new KeyboardEvent('keydown', kopts));
          document.dispatchEvent(new KeyboardEvent('keyup', kopts));
        } catch (_) {}
      }

      nudgePlayer();
    }

    // Variable cadence ~6–10s so pattern is less robotic
    function scheduleActivity() {
      if (!farmingActive()) {
        setTimeout(scheduleActivity, 10000);
        return;
      }
      synthActivity();
      const next = 6000 + Math.floor(Math.random() * 4000);
      setTimeout(scheduleActivity, next);
    }
    scheduleActivity();

    // Extra player health check
    setInterval(() => {
      if (!farmingActive()) return;
      nudgePlayer();
    }, 12000);
    // Re-assert visibility overrides periodically (SPA re-renders can wipe them)
    setInterval(forceVisible, 30000);

    // Initial kick
    setTimeout(synthActivity, 1500);
    setTimeout(nudgePlayer, 2500);
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
    if (t > lastVideoTime + 0.1) {
      lastVideoTime = t;
      lastVideoProgressAt = now;
      return true;
    }
    // Grace: recent progress OR playing with buffer
    if (lastVideoProgressAt && now - lastVideoProgressAt < 15000) {
      return !v.ended && (v.readyState >= 2 || !v.paused);
    }
    if (!v.paused && !v.ended && v.readyState >= 2) {
      lastVideoProgressAt = now;
      return true;
    }
    // Live edge often freezes currentTime briefly while buffered advances
    try {
      if (!v.paused && !v.ended && v.buffered && v.buffered.length) {
        const end = v.buffered.end(v.buffered.length - 1);
        if (end - t > 0.5) {
          lastVideoProgressAt = now;
          return true;
        }
      }
    } catch (_) {}
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
    // Cache: array of { slug, viewers }
    if (Date.now() - liveCacheAt < 25000 && liveCache.length >= 3) return liveCache;
    const bySlug = new Map(); // slug -> max viewers

    function addSlug(slug, viewers) {
      if (!slug || typeof slug !== 'string') return;
      slug = String(slug).toLowerCase().trim();
      if (slug.length > 30 && /[0-9a-f]{8}-/.test(slug)) return;
      if (slug.length < 2 || slug.length > 28) return;
      if (
        /^(categories|category|video|videos|browse|search|dashboard|settings|login|signup|following|community|clips)$/.test(
          slug
        )
      )
        return;
      const v = Math.max(0, Number(viewers) || 0);
      const prev = bySlug.get(slug);
      if (prev == null || v > prev) bySlug.set(slug, v);
    }

    const urls = [
      // sort=viewers → 422 (Kick 2026); sort=desc or no sort works
      'https://kick.com/stream/livestreams/en?limit=40&sort=desc',
      'https://kick.com/stream/livestreams/tr?limit=30&sort=desc',
      'https://kick.com/stream/livestreams/en?limit=40',
      'https://kick.com/stream/livestreams/tr?limit=30',
      'https://kick.com/stream/livestreams/en?page=2&limit=25',
      'https://kick.com/stream/livestreams/es?limit=20&sort=desc',
      'https://web.kick.com/api/v1/livestreams?limit=30&sort=viewer_count_desc'
    ];

    for (const url of urls) {
      try {
        const res = await fetch(url, {
          credentials: 'include',
          headers: { Accept: 'application/json', 'x-app-platform': 'web' },
          cache: 'no-store'
        });
        if (!res.ok) continue;
        const json = await res.json();
        // stream API: { data: [...] } | web.kick: { data: { livestreams: [...] } }
        let arr = [];
        if (Array.isArray(json?.data?.livestreams)) arr = json.data.livestreams;
        else if (Array.isArray(json?.data)) arr = json.data;
        else if (Array.isArray(json?.livestreams)) arr = json.livestreams;
        else if (Array.isArray(json)) arr = json;
        for (const item of arr) {
          if (item?.is_live === false) continue;
          const s =
            item?.channel?.slug ||
            item?.channel?.user?.username ||
            item?.user?.username ||
            item?.slug ||
            item?.broadcaster_user?.username;
          const viewers =
            item?.viewer_count ??
            item?.viewers ??
            item?.channel?.viewer_count ??
            0;
          addSlug(s, viewers);
        }
        if (bySlug.size >= 15) break;
      } catch (e) {
        console.warn('[KC] live fetch fail', url, e);
      }
    }

    // Sidebar / following DOM fallback (viewers unknown → 0)
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
          // try parse viewer count from row text
          let vc = 0;
          const m = (row.textContent || '').match(/(\d[\d.,]*)\s*(k|b)?/i);
          if (m) {
            let n = parseFloat(m[1].replace(',', '.'));
            if (/k/i.test(m[2] || '')) n *= 1000;
            if (/b/i.test(m[2] || '')) n *= 1000000;
            if (!isNaN(n)) vc = Math.floor(n);
          }
          addSlug(s, vc);
        }
      });
    } catch (_) {}

    liveCache = [...bySlug.entries()]
      .map(([slug, viewers]) => ({ slug, viewers }))
      .sort((a, b) => b.viewers - a.viewers);
    liveCacheAt = Date.now();
    console.log(
      '[KC] live cache',
      liveCache.length,
      liveCache.slice(0, 8).map((x) => x.slug + ':' + x.viewers)
    );
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
    const lives = await fetchLives(); // [{slug, viewers}, ...] sorted desc
    const minV = Math.max(0, parseInt(KC.settings?.min_viewers, 10) || 0);

    let pool = lives.filter((x) => x.slug !== cur);
    if (!pool.length) pool = lives.slice();

    // Prefer channels at/above min viewers
    let filtered = minV > 0 ? pool.filter((x) => x.viewers >= minV) : pool.slice();
    if (!filtered.length && minV > 0) {
      // fallback: take top half by viewers anyway
      filtered = pool.slice(0, Math.max(3, Math.ceil(pool.length / 2)));
      console.warn('[KC] Level bot: no channel >= min_viewers', minV, '— using top by viewers');
    }
    if (!filtered.length) {
      setStatus('Canlı kanal yok');
      console.warn('[KC] Level bot: no live channels', reason);
      return;
    }

    // Already sorted by viewers desc from fetchLives — bias pick toward top
    // Weighted random: higher viewers more likely
    const top = filtered.slice(0, 20);
    const weights = top.map((x, i) => {
      // rank weight + log viewers
      const rankW = top.length - i;
      const viewW = Math.log10(Math.max(1, x.viewers) + 1) * 3;
      return rankW + viewW;
    });
    const sum = weights.reduce((a, b) => a + b, 0) || 1;
    let r = Math.random() * sum;
    let pickObj = top[0];
    for (let i = 0; i < top.length; i++) {
      r -= weights[i];
      if (r <= 0) {
        pickObj = top[i];
        break;
      }
    }

    // Verify a few candidates are still live (prefer higher in list)
    let pick = pickObj.slug;
    const candidates = [pickObj, ...top.filter((x) => x.slug !== pickObj.slug)].slice(0, 6);
    for (const c of candidates) {
      const ok = await isSlugLive(c.slug);
      if (ok === true) {
        pick = c.slug;
        pickObj = c;
        break;
      }
      if (ok === false) continue;
      // null = unknown — accept
      pick = c.slug;
      pickObj = c;
      break;
    }

    switchCooldownUntil = Date.now() + 16000;
    consecutiveBad = 0;
    lastVideoTime = 0;
    lastVideoProgressAt = 0;
    const vLabel = pickObj && pickObj.viewers != null ? ' · ' + pickObj.viewers + ' izl.' : '';
    setStatus('Geçiliyor: ' + pick + vLabel);
    KC.logSwitch(currentSlug() || '', pick, reason || 'level-bot');
    console.log('[KC] Level bot switch', {
      from: cur,
      to: pick,
      viewers: pickObj?.viewers,
      min_viewers: minV,
      reason
    });
    location.href = 'https://kick.com/' + encodeURIComponent(pick);
  }

  function tickAntiStuck() {
    // Also keep stream healthy while farming drops / level
    if (
      !KC.settings?.anti_stuck &&
      !KC.settings?.level_bot &&
      !KC.settings?.drops_enabled &&
      !KC.settings?.bg_watch
    )
      return;
    const v = getVideo();
    if (!v) return;
    try {
      if (typeof KC.safePlayVideo === 'function') KC.safePlayVideo(v);
      else {
        try {
          if (v.paused && !v.ended) {
            const p = v.play();
            if (p && p.catch) p.catch(() => {});
          }
        } catch (_) {}
      }
      // Brief live-edge nudge if severely behind
      try {
        if (v.buffered && v.buffered.length) {
          const end = v.buffered.end(v.buffered.length - 1);
          const lag = end - (Number(v.currentTime) || 0);
          if (lag > 8 && lag < 90) {
            v.currentTime = Math.max(0, end - 0.8);
          }
        }
      } catch (_) {}
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
  KC._goNextLive = (reason) => {
    switchCooldownUntil = 0;
    consecutiveBad = 0;
    return goNextLive(reason || 'manual');
  };
  KC.forceSwitchChannel = () => {
    // Drops açıksa drop yayınına git; yoksa level listesi
    try {
      if (typeof KC.forceNextStream === 'function') {
        return KC.forceNextStream('manual');
      }
    } catch (_) {}
    switchCooldownUntil = 0;
    consecutiveBad = 0;
    return goNextLive('manual');
  };



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

    // Anlık faaliyet özeti (HUD "Şu an")
    let nowDoing = 'Beklemede';
    try {
      const st = String(statusText || '');
      const dropsOn = !!KC.settings?.drops_enabled;
      const levelOn = !!KC.settings?.level_bot;
      const antiOn = !!KC.settings?.anti_stuck;
      const S = KC.getStreamStatusSnapshot && KC.getStreamStatusSnapshot();
      const streamBad =
        S &&
        (S.statusClass === 'bad' ||
          S.statusClass === 'warn' ||
          (S.status && /takıl|yüklen|durak|hata/i.test(String(S.status))));

      if (/geçiliyor|aranıyor|bekleniyor|canlı/i.test(st)) {
        nowDoing = st;
      } else if (streamBad && (antiOn || levelOn || dropsOn)) {
        nowDoing =
          'Yayın onarılıyor' +
          (S && S.status ? ' · ' + S.status : '') +
          (S && S.next && S.next !== 'İzleniyor' && S.next !== '—'
            ? ' → ' + S.next
            : '');
      } else if (dropsOn && KC.getDropsNowDoing) {
        const d = KC.getDropsNowDoing();
        if (d) nowDoing = d;
        else if (levelOn) nowDoing = 'Level XP farm · ' + slug;
        else nowDoing = 'Drops farm · ' + slug;
      } else if (levelOn) {
        nowDoing = 'Level XP biriktiriliyor · ' + slug;
      } else if (antiOn) {
        nowDoing = 'Anti-stuck koruma · ' + slug;
      } else if (KC.settings?.bg_watch) {
        nowDoing = 'Sekme aktif tutuluyor · ' + slug;
      } else if (st && st !== 'Kapalı') {
        nowDoing = st;
      } else {
        nowDoing = 'Kapalı';
      }
      try {
        KC.nowDoing = nowDoing;
      } catch (_) {}
    } catch (_) {
      nowDoing = statusText || '—';
    }

    return {
      status: statusText || 'Kapalı',
      nowDoing: nowDoing,
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
