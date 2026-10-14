(function () {
  'use strict';
  const KC = (window.KickControl = window.KickControl || {});

  const API = 'https://web.kick.com/api/v1/gamification/user/level';
  const REFRESH_MS = 10000;
  const HISTORY_KEY = 'kc_level_hud_history';
  const RATE_KEY = 'kc_level_rate_v1';
  const RATE_KEEP_MS = 45 * 60 * 1000; // sayfa yenilense / kanal değişse de hız bu süre içinde korunur
  const POS_KEY = 'pos_level_xp_hud';

  const state = {
    level: null,
    progressXP: 0,
    totalXP: 0,
    xpToNext: 0,
    lastUpdate: 0,
    loading: false,
    error: '',
    minimized: false,
    history: [],
    logs: [],
    rateAnchorXP: null,
    rateAnchorAt: null,
    rateSamples: [],
    xpPerHour: 0,
    sessionStartXP: null,
    sessionStartAt: null,
    sessionGained: 0,
    lastFlashXP: null,
    timer: null,
    started: false
  };

  /** Detay panel açık mı */
  function panelOn() {
    return KC.settings?.level_xp_hud !== false;
  }
  /** Profil halkası açık mı (panelden bağımsız) */
  function ringOn() {
    return KC.settings?.level_xp_ring !== false;
  }
  /** XP API / timer — ikisinden biri açıksa */
  function enabled() {
    return panelOn() || ringOn();
  }

  function $(id) {
    return document.getElementById(id);
  }

  function parseJSON(value, fallback) {
    try {
      return value ? JSON.parse(value) : fallback;
    } catch {
      return fallback;
    }
  }

  function clock(time) {
    return time
      ? new Date(time).toLocaleTimeString('tr-TR', {
          hour: '2-digit',
          minute: '2-digit',
          second: '2-digit'
        })
      : '--:--:--';
  }

  function num(value) {
    return Math.max(0, Number(value) || 0).toLocaleString('tr-TR');
  }

  function duration(seconds) {
    if (!Number.isFinite(seconds) || seconds < 0) return 'Hesaplanıyor';
    const minutes = Math.ceil(seconds / 60);
    const hours = Math.floor(minutes / 60);
    const remaining = minutes % 60;
    if (!hours) return remaining + ' dk';
    return remaining ? hours + ' sa ' + remaining + ' dk' : hours + ' sa';
  }

  function log(message, type) {
    type = type || 'info';
    state.logs.unshift({ time: Date.now(), message: String(message), type: type });
    state.logs = state.logs.slice(0, 60);
    // v1.3.87: konsola/hata günlüğüne ikinci kez yazma — update() hatası zaten ağ bilgisiyle KC.elog'a gidiyor
    renderLogs();
  }

  function sessionToken() {
    try {
      const m = document.cookie.match(/(?:^|;\s*)session_token=([^;]+)/);
      return m ? decodeURIComponent(m[1]) : null;
    } catch (_) {
      return null;
    }
  }

  function loadHistory() {
    try {
      state.history = parseJSON(localStorage.getItem(HISTORY_KEY), []).slice(0, 30);
    } catch (_) {
      state.history = [];
    }
  }

  function addHistory() {
    state.history.unshift({
      time: Date.now(),
      level: state.level,
      totalXP: state.totalXP,
      progressXP: state.progressXP
    });
    state.history = state.history.slice(0, 30);
    try {
      localStorage.setItem(HISTORY_KEY, JSON.stringify(state.history));
    } catch (_) {}
  }

  /** Hız / oturum bilgisini sakla: kanal değişince sayfa yenileniyor, "Ölçülüyor" baştan başlamasın */
  function saveRate() {
    try {
      localStorage.setItem(RATE_KEY, JSON.stringify({
        at: Date.now(),
        samples: state.rateSamples,
        xpPerHour: state.xpPerHour,
        sessionStartXP: state.sessionStartXP,
        sessionStartAt: state.sessionStartAt
      }));
    } catch (_) {}
  }
  function loadRate() {
    try {
      const r = parseJSON(localStorage.getItem(RATE_KEY), null);
      if (!r || !r.at || Date.now() - r.at > RATE_KEEP_MS) return;
      state.rateSamples = Array.isArray(r.samples) ? r.samples.slice(-6) : [];
      state.xpPerHour = Number(r.xpPerHour) > 0 ? Number(r.xpPerHour) : 0;
      state.sessionStartXP = typeof r.sessionStartXP === 'number' ? r.sessionStartXP : null;
      state.sessionStartAt = typeof r.sessionStartAt === 'number' ? r.sessionStartAt : null;
    } catch (_) {}
  }
  loadRate();

  function updateRate(totalXP) {
    const now = Date.now();
    if (state.sessionStartXP === null || totalXP < state.sessionStartXP) {
      state.sessionStartXP = totalXP;
      state.sessionStartAt = now;
      state.sessionGained = 0;
    } else {
      state.sessionGained = Math.max(0, totalXP - state.sessionStartXP);
    }
    if (state.rateAnchorXP === null) {
      state.rateAnchorXP = totalXP;
      state.rateAnchorAt = now;
      saveRate();
      return;
    }
    const elapsed = now - state.rateAnchorAt;
    const gained = totalXP - state.rateAnchorXP;
    if (gained < 0) {
      state.rateAnchorXP = totalXP;
      state.rateAnchorAt = now;
      state.rateSamples = [];
      state.xpPerHour = 0;
      saveRate();
      return;
    }
    if (elapsed >= 15000 && gained > 0) {
      state.rateSamples.push(gained / (elapsed / 3600000));
      state.rateSamples = state.rateSamples.slice(-6);
      state.xpPerHour =
        state.rateSamples.reduce((a, b) => a + b, 0) / state.rateSamples.length;
      state.rateAnchorXP = totalXP;
      state.rateAnchorAt = now;
    } else if (state.xpPerHour <= 0 && state.sessionGained > 0 && state.sessionStartAt && now - state.sessionStartAt >= 60000) {
      // İlk ölçüm gelene kadar oturum ortalamasıyla anında tahmin ver
      state.xpPerHour = state.sessionGained / ((now - state.sessionStartAt) / 3600000);
    }
    saveRate();
  }

  function estimateTime() {
    if (state.xpPerHour <= 0 || state.xpToNext <= 0) return 'Hız ölçülüyor';
    return duration((state.xpToNext / state.xpPerHour) * 3600);
  }

  function injectStyle() { /* stil: content/panels.css */ }

  function createUI() {
    if ($('kc-lx-card')) return;
    injectStyle();

    const card = document.createElement('div');
    card.id = 'kc-lx-card';
    card.innerHTML =
      '<div id="kc-lx-head">' +
      '<button type="button" class="kc-lx-btn" id="kc-lx-minimize" title="Detay paneli kapat (halka kalır)"><i class="kc-fold"></i></button>' +
      '<div id="kc-lx-title"><span id="kc-lx-dot"></span>Level XP</div>' +
      '<div class="kc-lx-actions">' +
      '<button type="button" class="kc-lx-btn" id="kc-lx-refresh" title="Yenile">↻</button>' +
      '<button type="button" class="kc-lx-btn" id="kc-lx-hide" title="Detay paneli kapat (halka kalır)">×</button>' +
      '</div></div>' +
      '<div id="kc-lx-body">' +
      '<div class="kc-lx-level-row">' +
      '<span class="kc-lx-muted">Mevcut seviye</span><span class="kc-lx-level" id="kc-lx-level">--</span>' +
      '</div>' +
      '<div class="kc-lx-track"><div id="kc-lx-bar"></div><span class="kc-lx-percent" id="kc-lx-percent">0%</span></div>' +
      '<div class="kc-lx-xp-labels">' +
      '<span id="kc-lx-progress">0 XP</span>' +
      '<span id="kc-lx-next">Sonraki: -- XP</span>' +
      '</div>' +
      '<div class="kc-lx-stats">' +
      '<div class="kc-lx-stat"><div class="kc-lx-stat-label">Toplam XP</div><div class="kc-lx-stat-value" id="kc-lx-total">--</div></div>' +
      '<div class="kc-lx-stat"><div class="kc-lx-stat-label">Kalan</div><div class="kc-lx-stat-value" id="kc-lx-remain">--</div></div>' +
      '<div class="kc-lx-stat"><div class="kc-lx-stat-label">Saatlik</div><div class="kc-lx-stat-value" id="kc-lx-rate">Ölçülüyor</div></div>' +
      '<div class="kc-lx-stat"><div class="kc-lx-stat-label">Tahmini</div><div class="kc-lx-stat-value" id="kc-lx-eta">Hesaplanıyor</div></div>' +
      '<div class="kc-lx-stat"><div class="kc-lx-stat-label">Oturum</div><div class="kc-lx-stat-value" id="kc-lx-session">+0 XP</div></div>' +
      '<div class="kc-lx-stat"><div class="kc-lx-stat-label">Durum</div><div class="kc-lx-stat-value" id="kc-lx-status-val">Bekliyor</div></div>' +
      '</div>' +
      '<div id="kc-lx-status">API bekleniyor…</div>' +
      '<div id="kc-lx-error"></div>' +
      '<div class="kc-lx-section">' +
      '<div class="kc-lx-section-title">XP geçmişi</div>' +
      '<div id="kc-lx-history">Henüz kayıt yok.</div>' +
      '</div>' +
      '<div class="kc-lx-section">' +
      '<div class="kc-lx-section-title">İşlem kayıtları</div>' +
      '<div id="kc-lx-logs">Başlatılıyor…</div>' +
      '</div>' +
      '<div id="kc-lx-footer">' +
      '<span class="kc-lx-muted" id="kc-lx-updated">Son: bekleniyor</span>' +
      '<span class="kc-lx-btns" style="display:flex;gap:4px">' +
      '<button type="button" class="kc-lx-copy" id="kc-lx-test" title="Yanıp sönmeyi test et">Test</button>' +
      '<button type="button" class="kc-lx-copy" id="kc-lx-copy">Kaydı kopyala</button>' +
      '</span>' +
      '</div></div>';

    const mini = document.createElement('div');
    mini.id = 'kc-lx-mini';
    mini.innerHTML =
      '<div id="kc-lx-mini-row">' +
      '<div id="kc-lx-mini-left">' +
      '<i class="kc-fold" style="transform:none"></i>' +
      '<span id="kc-lx-dot-mini"></span>' +
      '<span id="kc-lx-mini-level">Level --</span>' +
      '<span id="kc-lx-mini-progress">0%</span>' +
      '</div>' +
      '<span id="kc-lx-mini-time">↻ Bekleniyor</span>' +
      '</div>';

    document.documentElement.append(card, mini);

    if (typeof KC.applyPos === 'function') {
      KC.applyPos(card, POS_KEY, { x: Math.max(8, window.innerWidth - 320), y: 100 });
      KC.applyPos(mini, POS_KEY, { x: Math.max(8, window.innerWidth - 320), y: 100 });
    } else {
      const saved = KC.settings && KC.settings[POS_KEY];
      let left = Math.max(8, window.innerWidth - 320);
      let top = 100;
      if (saved && typeof saved.x === 'number') {
        left = saved.x;
        top = saved.y;
      }
      card.style.left = left + 'px';
      card.style.top = top + 'px';
      mini.style.left = Math.min(left, Math.max(0, window.innerWidth - 270)) + 'px';
      mini.style.top = top + 'px';
    }

    if (typeof KC.makeDraggable === 'function') {
      KC.makeDraggable(card, $('kc-lx-head'), POS_KEY);
      KC.makeDraggable(mini, mini, POS_KEY);
    }

    $('kc-lx-refresh').addEventListener('click', (e) => {
      e.stopPropagation();
      update(true);
    });
    $('kc-lx-minimize').addEventListener('click', (e) => {
      e.stopPropagation();
      closeDetailPanel();
    });
    try {
      const hb = $('kc-lx-hide');
      if (hb) hb.title = 'Detay paneli kapat (profil halkası kalır)';
    } catch (_) {}
    $('kc-lx-hide').addEventListener('click', (e) => {
      e.stopPropagation();
      closeDetailPanel();
    });
    $('kc-lx-mini').addEventListener('click', () => {
      openDetailPanel();
    });
    const lxSecs = () => Array.from(card.querySelectorAll('.kc-lx-section'));
    const lxName = (s) => (s.querySelector('.kc-lx-section-title')?.textContent || '').trim();
    try {
      const closed = Array.isArray(KC.settings.lx_closed) ? KC.settings.lx_closed : [];
      lxSecs().forEach((s) => s.classList.toggle('closed', closed.includes(lxName(s))));
    } catch (_) {}
    card.addEventListener('click', (e) => {
      const h = e.target.closest('.kc-lx-section-title');
      if (!h) return;
      h.parentNode.classList.toggle('closed');
      KC.saveSetting('lx_closed', lxSecs().filter((s) => s.classList.contains('closed')).map(lxName));
    });
    $('kc-lx-test').addEventListener('click', (e) => {
      e.stopPropagation();
      // Tek tık: normal ilerleme ~3.5s; Shift+tık: level-up ~8s
      try { flashRing({ long: !!e.shiftKey }); } catch (_) {}
      try { flashPanel(25); } catch (_) {}
    });
    $('kc-lx-copy').addEventListener('click', async (e) => {
      e.stopPropagation();
      const output =
        state.logs
          .map(
            (item) =>
              '[' +
              clock(item.time) +
              '] [' +
              item.type.toUpperCase() +
              '] ' +
              item.message
          )
          .join('\n') || 'Kayıt yok.';
      try {
        await navigator.clipboard.writeText(output);
        log('Kayıtlar panoya kopyalandı.', 'success');
      } catch (_) {
        window.prompt('Kopyala (Ctrl+C):', output);
      }
    });

    state.minimized = !!KC.settings?.level_xp_hud_mini;
    renderVisibility();
    render();
  }

  function getProgressPercent() {
    const denominator = state.progressXP + state.xpToNext;
    if (denominator <= 0) return 0;
    return Math.max(0, Math.min(100, (state.progressXP / denominator) * 100));
  }

  function findProfileAnchor() {
    // Kick header / sidebar profil avatarı (DOM sık değişiyor)
    const candidates = [
      'button[id^="radix-"] img.rounded-full',
      'header img.rounded-full',
      'nav img.rounded-full',
      '[data-testid*="profile" i] img',
      '[data-testid*="avatar" i] img',
      'img[src*="profile_image"]',
      'img[src*="profile_pic"]',
      'img[src*="conversion"]',
      'img[alt*="profile" i]',
      'img[alt*="avatar" i]',
      'aside img.rounded-full',
      'a[href*="/settings"] img.rounded-full',
      'button img.rounded-full',
      'img.rounded-full'
    ];
    let best = null;
    let bestScore = -1;
    for (const sel of candidates) {
      try {
        const imgs = document.querySelectorAll(sel);
        for (const img of imgs) {
          if (img.closest('#kc-menu, #kc-dash, #kc-lx-card, [id^="kc-"]')) continue;
          const r = img.getBoundingClientRect();
          if (r.width < 14 || r.height < 14) continue;
          if (r.bottom < 0 || r.top > window.innerHeight) continue;
          // Üst bar tercih (skor); alt taraftaki avatarlar da kabul
          let score = 0;
          if (r.top < 100) score += 50;
          if (r.top < 160) score += 20;
          if (r.width >= 24 && r.width <= 56) score += 15;
          const src = img.getAttribute('src') || '';
          const alt = img.getAttribute('alt') || '';
          if (/profile_image|profile_pic|conversion|avatar/i.test(src + ' ' + alt)) score += 30;
          if (img.classList.contains('rounded-full')) score += 10;
          if (score > bestScore) {
            const btn = img.closest('button, a, [role="button"]') || img.parentElement;
            if (btn) {
              bestScore = score;
              best = { img, btn };
            }
          }
        }
      } catch (_) {}
    }
    return best;
  }

  function ensureProfileRing() {
    let ring = $('kc-lx-profile-ring');
    if (ring && document.contains(ring)) return ring;
    if (ring && !document.contains(ring)) {
      try { ring.remove(); } catch (_) {}
    }
    injectRingStyle();
    const anchor = findProfileAnchor();
    if (!anchor) return null;
    const { btn } = anchor;
    try {
      const st = window.getComputedStyle(btn);
      if (st.position === 'static') btn.style.position = 'relative';
    } catch (_) {}
    ring = document.createElement('div');
    ring.id = 'kc-lx-profile-ring';
    ring.className = 'kc-lx-profile-ring';
    ring.title = 'Level XP — F9 ile detay panel';
    ring.innerHTML =
      '<svg viewBox="0 0 36 36" class="kc-lx-ring-svg" aria-hidden="true">' +
      '<circle class="kc-lx-ring-bg" cx="18" cy="18" r="16" fill="none" />' +
      '<circle class="kc-lx-ring-fg" cx="18" cy="18" r="16" fill="none" />' +
      '</svg>' +
      '<span class="kc-lx-ring-pct" id="kc-lx-ring-pct">0%</span>';
    // v1.3.86: halka tıklamayı yakalamaz — tıklama Kick'in profil düğmesine geçer (detay panel: F9 / menü)
    btn.appendChild(ring);
    return ring;
  }

  function injectRingStyle() {
    if ($('kc-lx-ring-style')) return;
    const s = document.createElement('style');
    s.id = 'kc-lx-ring-style';
    s.textContent = `
.kc-lx-profile-ring {
  position: absolute;
  inset: -4px;
  pointer-events: none; /* v1.3.86: tıklama profil düğmesine geçsin */
  z-index: 5;
  border-radius: 50%;
}
.kc-lx-ring-svg {
  width: 100%;
  height: 100%;
  transform: rotate(-90deg);
  display: block;
}
.kc-lx-ring-bg {
  fill: none;
  stroke: rgba(255,255,255,0.12);
  stroke-width: 2.5;
}
.kc-lx-ring-fg {
  fill: none;
  stroke: #53df91;
  stroke-width: 2.5;
  stroke-linecap: round;
  stroke-dasharray: 100.53;
  stroke-dashoffset: 100.53;
  transition: stroke-dashoffset 0.35s ease, stroke 0.25s ease;
}
.kc-lx-ring-fg.kc-lx-flash {
  stroke: #ffe600 !important;
  filter: drop-shadow(0 0 6px #ffe600) drop-shadow(0 0 12px #ff2bd6);
  animation: kc-lx-blink 0.45s ease-in-out 8;
}
.kc-lx-ring-fg.kc-lx-flash-long {
  stroke: #ffe600 !important;
  filter: drop-shadow(0 0 8px #ffe600) drop-shadow(0 0 18px #ff2bd6);
  animation: kc-lx-blink 0.5s ease-in-out 16;
}
@keyframes kc-lx-blink {
  0%, 100% { opacity: 1; stroke: #ffe600; }
  50% { opacity: 0.4; stroke: #ff2bd6; }
}
.kc-lx-ring-pct {
  position: absolute;
  left: 50%;
  bottom: -11px;
  transform: translateX(-50%);
  font: 700 7.5px/1 "Segoe UI", Inter, system-ui, sans-serif;
  color: #fff;
  text-shadow: 0 1px 2px rgba(0,0,0,0.9);
  white-space: nowrap;
  pointer-events: none;
  letter-spacing: 0.02em;
}
.kc-lx-ring-pct.kc-lx-flash-pct {
  color: #ffe600 !important;
  animation: kc-lx-pct-blink 0.45s ease-in-out 8;
}
.kc-lx-ring-pct.kc-lx-flash-pct-long {
  color: #ffe600 !important;
  animation: kc-lx-pct-blink 0.5s ease-in-out 16;
}
@keyframes kc-lx-pct-blink {
  0%, 100% { color: #ffe600; opacity: 1; }
  50% { color: #ff2bd6; opacity: 0.65; }
}
.kc-lx-profile-ring.kc-lx-ring-hidden { display: none !important; }
`;
    document.documentElement.appendChild(s);
  }

  // Yanıp sönme renkleri: halkanın yeşilinden net ayrışsın (parlak sarı ↔ pembe)
  const BLUE = '#ffe600';
  const PURPLE = '#ff2bd6';

  function anim(el, frames, opts) {
    try {
      if (el && el.animate) return el.animate(frames, opts);
    } catch (_) {}
    return null;
  }

  /**
   * Profil halkası yanıp sönme.
   * @param {{ long?: boolean }} opts  long=true → level atlayınca ~8 sn; değilse ilerleme ~3.5 sn
   */
  function flashRing(opts) {
    const long = !!(opts && opts.long);
    // Halka yoksa kur (ring ayarı açıksa)
    try {
      if (ringOn() && (!$('kc-lx-profile-ring') || !document.contains($('kc-lx-profile-ring')))) {
        ensureProfileRing();
        updateProfileRing();
      }
    } catch (_) {}
    const ring = $('kc-lx-profile-ring');
    if (!ring) return;
    ring.classList.remove('kc-lx-ring-hidden');
    ring.style.setProperty('display', 'block', 'important');
    ring.style.setProperty('visibility', 'visible', 'important');
    ring.style.setProperty('opacity', '1', 'important');

    const fg = ring.querySelector('.kc-lx-ring-fg');
    const pctEl = $('kc-lx-ring-pct') || ring.querySelector('.kc-lx-ring-pct');
    // long: 16 × 500ms ≈ 8 sn; normal: 8 × 450ms ≈ 3.6 sn
    const iters = long ? 16 : 8;
    const dur = long ? 500 : 450;
    const o = { duration: dur, iterations: iters, easing: 'ease-in-out' };
    const cssMs = iters * dur + 200;

    if (fg) {
      fg.classList.remove('kc-lx-flash', 'kc-lx-flash-long');
      void fg.offsetWidth;
      fg.classList.add(long ? 'kc-lx-flash-long' : 'kc-lx-flash');
      setTimeout(() => {
        try { fg.classList.remove('kc-lx-flash', 'kc-lx-flash-long'); } catch (_) {}
      }, cssMs);
    }
    if (pctEl) {
      pctEl.classList.remove('kc-lx-flash-pct', 'kc-lx-flash-pct-long');
      void pctEl.offsetWidth;
      pctEl.classList.add(long ? 'kc-lx-flash-pct-long' : 'kc-lx-flash-pct');
      setTimeout(() => {
        try { pctEl.classList.remove('kc-lx-flash-pct', 'kc-lx-flash-pct-long'); } catch (_) {}
      }, cssMs);
    }

    if (fg) {
      try { fg.getAnimations && fg.getAnimations().forEach((a) => a.cancel()); } catch (_) {}
      anim(fg, [
        { stroke: BLUE, strokeWidth: long ? 4 : 3.5, opacity: 1, filter: 'drop-shadow(0 0 0 transparent)' },
        { stroke: PURPLE, strokeWidth: long ? 6.5 : 5.5, opacity: 1, filter: 'drop-shadow(0 0 8px #ff2bd6)' },
        { stroke: BLUE, strokeWidth: long ? 4 : 3.5, opacity: 1, filter: 'drop-shadow(0 0 0 transparent)' }
      ], o);
    }
    try { ring.getAnimations && ring.getAnimations().forEach((a) => a.cancel()); } catch (_) {}
    anim(ring, [
      { filter: 'drop-shadow(0 0 0 rgba(255,230,0,0))', transform: 'scale(1)' },
      { filter: 'drop-shadow(0 0 8px #ffe600) drop-shadow(0 0 18px #ff2bd6)', transform: long ? 'scale(1.4)' : 'scale(1.28)' },
      { filter: 'drop-shadow(0 0 0 rgba(255,230,0,0))', transform: 'scale(1)' }
    ], o);
    if (pctEl) {
      try { pctEl.getAnimations && pctEl.getAnimations().forEach((a) => a.cancel()); } catch (_) {}
      anim(pctEl, [
        { color: BLUE, opacity: 1, transform: 'translateX(-50%) scale(1)' },
        { color: PURPLE, opacity: 1, transform: 'translateX(-50%) scale(1.45)' },
        { color: BLUE, opacity: 1, transform: 'translateX(-50%) scale(1)' }
      ], o);
    }
  }

  /** Level XP paneli: aynı yanıp sönme (çerçeve + çubuk + nokta + oturum kazancı) */
  function flashPanel(delta) {
    const o = { duration: 400, iterations: 6, easing: 'ease-in-out' };
    const card = $('kc-lx-card');
    if (card && !card.classList.contains('kc-lx-hidden')) {
      anim(card, [
        { boxShadow: '0 0 0 0 rgba(255,230,0,0)' },
        { boxShadow: '0 0 0 2px ' + BLUE + ', 0 0 22px 4px rgba(255,230,0,0.9)' },
        { boxShadow: '0 0 0 0 rgba(255,230,0,0)' }
      ], o);
    }
    anim($('kc-lx-bar'), [
      { background: BLUE, opacity: 1 },
      { background: PURPLE, opacity: 0.35 },
      { background: BLUE, opacity: 1 }
    ], o);
    anim($('kc-lx-dot'), [
      { background: BLUE, opacity: 1 },
      { background: PURPLE, opacity: 0.3 },
      { background: BLUE, opacity: 1 }
    ], o);
    ['kc-lx-session', 'kc-lx-progress', 'kc-lx-total', 'kc-lx-percent'].forEach((id) => {
      anim($(id), [
        { color: BLUE, opacity: 1 },
        { color: PURPLE, opacity: 0.4 },
        { color: BLUE, opacity: 1 }
      ], o);
    });
    // küçük "+N XP" etiketi
    if (card && delta > 0) {
      try {
        const tag = document.createElement('div');
        tag.textContent = '+' + num(delta) + ' XP';
        tag.style.cssText =
          'position:absolute;right:10px;top:4px;z-index:3;pointer-events:none;font:700 12px/1 Consolas,monospace;color:' + BLUE + ';';
        card.appendChild(tag);
        const a = anim(tag, [
          { opacity: 1, transform: 'translateY(0)' },
          { opacity: 0, transform: 'translateY(-14px)' }
        ], { duration: 1800, easing: 'ease-out' });
        setTimeout(() => { try { tag.remove(); } catch (_) {} }, 1900);
      } catch (_) {}
    }
  }

  /** Profil halkası — level_xp_ring ayarına bağlı (panelden bağımsız) */
  function updateProfileRing() {
    if (!ringOn()) {
      const ring = $('kc-lx-profile-ring');
      if (ring) {
        ring.classList.add('kc-lx-ring-hidden');
        ring.style.setProperty('display', 'none', 'important');
      }
      return;
    }
    let ring = $('kc-lx-profile-ring');
    if (!ring || !document.contains(ring)) {
      try { if (ring) ring.remove(); } catch (_) {}
      ring = ensureProfileRing();
    }
    if (!ring) return;
    ring.classList.remove('kc-lx-ring-hidden');
    ring.style.setProperty('display', 'block', 'important');
    ring.style.setProperty('visibility', 'visible', 'important');
    ring.style.setProperty('opacity', '1', 'important');
    ring.style.setProperty('pointer-events', 'none', 'important');
    const pct = getProgressPercent();
    const circ = 2 * Math.PI * 16; // r=16
    const fg = ring.querySelector('.kc-lx-ring-fg');
    if (fg) {
      fg.style.strokeDasharray = String(circ);
      fg.style.strokeDashoffset = String(circ * (1 - pct / 100));
      if (!fg.classList.contains('kc-lx-flash')) {
        fg.style.stroke = state.error ? '#ff6969' : '#53df91';
      }
    }
    const pctEl = $('kc-lx-ring-pct') || ring.querySelector('.kc-lx-ring-pct');
    if (pctEl) {
      pctEl.textContent = pct.toFixed(1) + '%';
      if (!pctEl.classList.contains('kc-lx-flash-pct')) {
        pctEl.style.color = state.error ? '#ff6969' : 'var(--kc-hud-text, #53df91)';
      }
    }
    const lv = state.level != null ? state.level : '—';
    ring.title = 'Level ' + lv + ' · ' + pct.toFixed(1) + '% — tıkla / F9 detay panel';
  }

  /** Detay panel AÇ — halkaya dokunulmaz (ikisi birlikte kalır) */
  function applyDetailVisible() {
    if (!$('kc-lx-card')) {
      try { createUI(); } catch (_) {}
    }
    const card = $('kc-lx-card');
    if (!card) return;
    card.classList.remove('kc-lx-hidden', 'kc-lx-folded');
    card.style.setProperty('display', 'flex', 'important');
    card.style.setProperty('visibility', 'visible', 'important');
    card.style.setProperty('opacity', '1', 'important');
    card.style.setProperty('pointer-events', 'auto', 'important');
    card.style.setProperty('z-index', '2147483000', 'important');
    // Kayıtlı konumu uygula (F5 sonrası kaybolmasın)
    try {
      if (typeof KC.applyPos === 'function') KC.applyPos(card, POS_KEY);
      else {
        const r = card.getBoundingClientRect();
        const w = window.innerWidth, h = window.innerHeight;
        let left = parseFloat(card.style.left);
        let top = parseFloat(card.style.top);
        if (!isFinite(left)) left = r.left || 20;
        if (!isFinite(top)) top = r.top || 80;
        if (left > w - 40 || left < -200) left = Math.max(8, w - 340);
        if (top > h - 40 || top < -100) top = 80;
        card.style.left = left + 'px';
        card.style.top = top + 'px';
      }
    } catch (_) {}
    const mini = $('kc-lx-mini');
    if (mini) mini.classList.add('kc-lx-hidden');
    // Halkayı GİZLEME — bağımsız
    try { updateProfileRing(); } catch (_) {}
    try { render(); } catch (_) {}
  }

  /** Detay panel KAPAT — halka durur */
  function applyDetailHidden() {
    state.minimized = true;
    const card = $('kc-lx-card');
    if (card) {
      card.classList.add('kc-lx-hidden');
      card.style.setProperty('display', 'none', 'important');
      card.style.removeProperty('visibility');
      card.style.removeProperty('opacity');
      card.style.removeProperty('pointer-events');
      card.style.removeProperty('z-index');
    }
    const mini = $('kc-lx-mini');
    if (mini) mini.classList.add('kc-lx-hidden');
    try { updateProfileRing(); } catch (_) {}
  }

  function renderVisibility() {
    // Panel
    if (!panelOn()) {
      const card = $('kc-lx-card');
      if (card) {
        card.classList.add('kc-lx-hidden');
        card.style.setProperty('display', 'none', 'important');
      }
      const mini = $('kc-lx-mini');
      if (mini) mini.classList.add('kc-lx-hidden');
    } else {
      if (!$('kc-lx-card')) {
        try { createUI(); } catch (_) {}
      }
      if (state.minimized) applyDetailHidden();
      else applyDetailVisible();
    }
    // Halka (ayrı ayar)
    try { updateProfileRing(); } catch (_) {}
  }

  /** F9 / halka: detaylı Level XP panelini aç (panel kapalıysa da açar) */
  function openDetailPanel() {
    if (KC.settings) {
      KC.settings.level_xp_hud = true;
      KC.settings.level_xp_hud_mini = false;
    }
    state.minimized = false;
    try { KC.saveSetting('level_xp_hud', true); } catch (_) {}
    try { KC.saveSetting('level_xp_hud_mini', false); } catch (_) {}
    if (!state.started) {
      start();
    }
    applyDetailVisible();
    if (!state.timer) {
      try { update(true); } catch (_) {}
      state.timer = setInterval(() => { try { update(false); } catch (_) {} }, REFRESH_MS);
    } else {
      try { update(true); } catch (_) {}
    }
    try { updateProfileRing(); } catch (_) {}
    try {
      if (typeof KC.elog === 'function') {
        KC.elog('info', 'level-hud', 'Detay panel açıldı · panel=true · ring=' + ringOn());
      }
    } catch (_) {}
  }

  /** Detay paneli kapat / küçült → profil halkası (özellik açık kalır) */
  function closeDetailPanel() {
    state.minimized = true;
    if (KC.settings) KC.settings.level_xp_hud_mini = true;
    try { KC.saveSetting('level_xp_hud_mini', true); } catch (_) {}
    applyDetailHidden();
    try {
      if (typeof KC.elog === 'function') {
        const ring = $('kc-lx-profile-ring');
        KC.elog('info', 'level-hud', 'Küçültüldü → halka=' + !!(ring && !ring.classList.contains('kc-lx-ring-hidden')));
      }
    } catch (_) {}
  }

  function renderLogs() {
    const target = $('kc-lx-logs');
    if (!target) return;
    target.innerHTML =
      state.logs
        .slice(0, 20)
        .map((item) => {
          const cls =
            item.type === 'error'
              ? 'kc-lx-log-error'
              : item.type === 'success'
                ? 'kc-lx-log-ok'
                : '';
          return (
            '<div class="' +
            cls +
            '">[' +
            clock(item.time) +
            '] ' +
            String(item.message)
              .replace(/&/g, '&amp;')
              .replace(/</g, '&lt;')
              .replace(/>/g, '&gt;') +
            '</div>'
          );
        })
        .join('') || 'Henüz kayıt yok.';
  }

  function renderHistory() {
    const target = $('kc-lx-history');
    if (!target) return;
    target.textContent = state.history.length
      ? state.history
          .slice(0, 10)
          .map(
            (item) =>
              clock(item.time) +
              '  Lv.' +
              item.level +
              '  •  ' +
              num(item.totalXP) +
              ' XP'
          )
          .join('\n')
      : 'Henüz kayıt yok.';
  }

  function render() {
    if (!$('kc-lx-card')) return;

    const hasData = state.level !== null;
    const denominator = state.progressXP + state.xpToNext;
    const percent =
      denominator > 0
        ? Math.max(0, Math.min(100, (state.progressXP / denominator) * 100))
        : 0;

    $('kc-lx-level').textContent = hasData ? 'Level ' + state.level : '--';
    $('kc-lx-percent').textContent = percent.toFixed(1) + '%';
    $('kc-lx-bar').style.width = percent + '%';
    $('kc-lx-progress').textContent = num(state.progressXP) + ' XP';
    $('kc-lx-next').textContent = 'Sonraki: ' + num(state.xpToNext) + ' XP';
    $('kc-lx-total').textContent = hasData ? num(state.totalXP) : '--';
    $('kc-lx-remain').textContent = hasData ? num(state.xpToNext) + ' XP' : '--';
    $('kc-lx-rate').textContent =
      state.xpPerHour > 0
        ? num(Math.round(state.xpPerHour)) + ' XP/sa'
        : 'Ölçülüyor';
    $('kc-lx-eta').textContent = estimateTime();
    $('kc-lx-session').textContent =
      '+' + num(state.sessionGained) + ' XP';
    $('kc-lx-updated').textContent = state.lastUpdate
      ? 'Son: ' + clock(state.lastUpdate)
      : 'Son: bekleniyor';

    const statusVal = $('kc-lx-status-val');
    if (statusVal) {
      statusVal.textContent = state.loading
        ? 'Güncelleniyor'
        : state.error
          ? 'Hata'
          : hasData
            ? 'Aktif'
            : 'Bekliyor';
      statusVal.style.color = state.error
        ? '#ff8a95'
        : hasData
          ? '#53df91'
          : '#8b95a8';
    }

    $('kc-lx-mini-level').textContent = hasData
      ? 'Level ' + state.level
      : 'Level --';
    $('kc-lx-mini-progress').textContent = percent.toFixed(1) + '%';
    $('kc-lx-mini-time').textContent = state.lastUpdate
      ? '↻ ' + clock(state.lastUpdate)
      : '↻ Bekleniyor';

    $('kc-lx-status').textContent = state.loading
      ? 'Veriler güncelleniyor…'
      : state.error
        ? 'Bağlantı hatası'
        : hasData
          ? 'Bağlantı aktif'
          : 'API bekleniyor…';

    const dotColor = state.error
      ? '#ff6969'
      : state.loading
        ? '#f0c45b'
        : '#53df91';
    const dot = $('kc-lx-dot');
    if (dot) dot.style.background = dotColor;
    const dotMini = $('kc-lx-dot-mini');
    if (dotMini) dotMini.style.background = dotColor;

    const errEl = $('kc-lx-error');
    if (errEl) {
      errEl.style.display = state.error ? 'block' : 'none';
      errEl.textContent = state.error || '';
    }
    renderHistory();
    renderLogs();
    try { updateProfileRing(); } catch (_) {}
  }

  async function update(manual) {
    if (state.loading) return;
    if (!enabled()) return;
    // v1.3.87: art arda hata olunca (zayıf internet) 10 sn'de bir değil 20 / 40 / 60 sn aralıkla dene
    if (!manual && Date.now() < (state.nextTryAt || 0)) return;

    const tok = sessionToken();
    if (!tok) {
      state.error =
        'Oturum bulunamadı. Kick’e giriş yapıp sayfayı yenile.';
      if (manual) log(state.error, 'error');
      render();
      return;
    }

    state.loading = true;
    state.error = '';
    render();

    try {
      const response = await (KC.netFetch ? KC.netFetch : (u, o) => fetch(u, o))(API, {
        method: 'GET',
        headers: {
          Authorization: 'Bearer ' + tok,
          Accept: 'application/json',
          'x-app-platform': 'web',
          'X-Client-Token':
            'e1393935a959b4020a4491574f6490129f678acdaa92760471263db43487f823'
        },
        credentials: 'include'
      });

      if (!response.ok) {
        throw new Error('HTTP ' + response.status + ' ' + response.statusText);
      }

      const json = await response.json();
      const data = json && json.data ? json.data : json;

      if (!data || data.level === undefined) {
        throw new Error('API yanıtında level yok.');
      }

      const level = Number(data.level);
      const progressXP = Number(
        data.progress_xp ?? data.progressXP ?? data.current_xp ?? 0
      );
      const totalXP = Number(
        data.total_xp ?? data.totalXP ?? data.xp ?? 0
      );
      const xpToNext = Number(
        data.xp_to_next_level ?? data.xpToNextLevel ?? data.xp_to_next ?? 0
      );

      if (![level, progressXP, totalXP, xpToNext].every(Number.isFinite)) {
        throw new Error('XP değerleri geçersiz.');
      }

      const previousTotal = state.totalXP;
      const previousProgress = state.progressXP;
      const previousPct = getProgressPercent();
      const previousLevel = state.level;
      const hadData = state.level !== null;

      state.level = level;
      state.progressXP = Math.max(0, progressXP);
      state.totalXP = Math.max(0, totalXP);
      state.xpToNext = Math.max(0, xpToNext);
      state.lastUpdate = Date.now();
      state.error = '';
      state.failStreak = 0;
      state.nextTryAt = 0;

      updateRate(state.totalXP);
      if (!hadData || previousTotal !== state.totalXP) addHistory();

      const gained = hadData ? Math.max(0, state.totalXP - previousTotal) : 0;
      const progUp = hadData && state.progressXP > previousProgress;
      const pctNow = getProgressPercent();
      const pctUp = hadData && pctNow > previousPct + 0.05;
      const leveledUp = hadData && previousLevel != null && level > previousLevel;
      const shouldFlash = hadData && (gained > 0 || progUp || pctUp || leveledUp);

      log(
        'Güncellendi: Level ' + level + ', toplam ' + num(totalXP) + ' XP.' +
          (leveledUp ? ' ★ LEVEL UP!' : ''),
        'success'
      );

      try {
        KC.getLevelXpSnapshot = function () {
          return {
            level: state.level,
            progressXP: state.progressXP,
            totalXP: state.totalXP,
            xpToNext: state.xpToNext,
            xpPerHour: state.xpPerHour,
            sessionGained: state.sessionGained,
            lastUpdate: state.lastUpdate
          };
        };
      } catch (_) {}

      state.loading = false;
      render();
      if (shouldFlash) {
        state.lastFlashXP = state.totalXP;
        requestAnimationFrame(() => {
          try { flashRing({ long: leveledUp }); } catch (_) {}
          try { flashPanel(gained || Math.max(1, state.progressXP - previousProgress)); } catch (_) {}
        });
      } else {
        state.lastFlashXP = state.totalXP;
      }
      return;
    } catch (error) {
      state.error = error && error.message ? error.message : String(error);
      log('Güncelleme hatası: ' + state.error, 'error');
      state.failStreak = (state.failStreak || 0) + 1;
      state.nextTryAt = Date.now() + Math.min(60000, 10000 * Math.pow(2, state.failStreak - 1));
      try {
        if (typeof KC.elog === 'function' && (state.failStreak === 1 || state.failStreak % 5 === 0)) {
          let net = '';
          try {
            const c = navigator.connection || navigator.mozConnection || navigator.webkitConnection;
            if (c) {
              net =
                'netType=' +
                (c.effectiveType || '?') +
                ' rtt=' +
                (c.rtt != null ? c.rtt + 'ms' : '?') +
                ' downlink=' +
                (c.downlink != null ? c.downlink + 'Mb/s' : '?');
            }
            net += ' onLine=' + navigator.onLine;
          } catch (_) {}
          KC.elog(
            'warn',
            'level-hud',
            'XP güncelleme düştü (player düşmez, sadece HUD/API): ' + state.error,
            net || 'net=?'
          );
        }
      } catch (_) {}
    } finally {
      state.loading = false;
      // başarı yolunda render zaten çağrıldı; hata yolunda burada çiz
      if (state.error) render();
    }
  }

  function destroyPanel() {
    try {
      const card = $('kc-lx-card');
      if (card) card.remove();
      const mini = $('kc-lx-mini');
      if (mini) mini.remove();
    } catch (_) {}
  }

  function destroyRing() {
    try {
      const ring = $('kc-lx-profile-ring');
      if (ring) ring.remove();
    } catch (_) {}
  }

  function destroyHud() {
    stopTimer();
    destroyPanel();
    destroyRing();
    state.started = false;
  }

  function start() {
    if (!enabled()) {
      destroyHud();
      try {
        if (typeof KC.elog === 'function') {
          KC.elog('info', 'level-hud', 'Level XP kapalı (panel+ring) — çalışmıyor');
        }
      } catch (_) {}
      return;
    }
    state.started = true;
    loadHistory();
    if (panelOn()) {
      createUI();
      state.minimized = !!KC.settings?.level_xp_hud_mini;
    }
    renderVisibility();
    log('HUD başlatıldı. Yenileme: 10 sn.', 'info');
    try {
      if (typeof KC.elog === 'function') {
        KC.elog('info', 'level-hud', 'HUD start · panel=' + panelOn() + ' · ring=' + ringOn() + ' · mini=' + !!state.minimized);
      }
    } catch (_) {}

    update(true);
    if (!state.timer) state.timer = setInterval(() => update(false), REFRESH_MS);
    [1500, 4000, 8000].forEach((ms) => {
      setTimeout(() => {
        try {
          if (!enabled()) return;
          if (panelOn() && !$('kc-lx-card')) createUI();
          renderVisibility();
        } catch (_) {}
      }, ms);
    });
  }

  function stopTimer() {
    if (state.timer) {
      clearInterval(state.timer);
      state.timer = null;
    }
  }

  function onTogglePanel(on) {
    if (on) {
      state.minimized = false;
      if (KC.settings) KC.settings.level_xp_hud_mini = false;
      try { KC.saveSetting('level_xp_hud_mini', false); } catch (_) {}
      if (!state.started) start();
      else {
        createUI();
        applyDetailVisible();
        if (!state.timer) {
          update(true);
          state.timer = setInterval(() => update(false), REFRESH_MS);
        }
      }
    } else {
      destroyPanel();
      // Sadece panel kapandı; halka ringOn ise kalır
      if (!ringOn()) {
        stopTimer();
        state.started = false;
      }
      try {
        if (typeof KC.elog === 'function') KC.elog('info', 'level-hud', 'Detay panel kapatıldı · ring=' + ringOn());
      } catch (_) {}
    }
    try { updateProfileRing(); } catch (_) {}
  }

  function onToggleRing(on) {
    if (on) {
      if (!state.started) start();
      else {
        if (!state.timer) {
          update(true);
          state.timer = setInterval(() => update(false), REFRESH_MS);
        }
      }
      try { ensureProfileRing(); updateProfileRing(); } catch (_) {}
    } else {
      destroyRing();
      if (!panelOn()) {
        stopTimer();
        state.started = false;
      }
      try {
        if (typeof KC.elog === 'function') KC.elog('info', 'level-hud', 'Profil halkası kapatıldı · panel=' + panelOn());
      } catch (_) {}
    }
  }

  // Dashboard için ayrıntılı Level XP verisi
  KC.getLevelXpDetail = () => {
    const den = state.progressXP + state.xpToNext;
    return {
      hasData: state.level !== null, level: state.level, progressXP: state.progressXP, totalXP: state.totalXP,
      xpToNext: state.xpToNext, xpPerHour: state.xpPerHour, sessionGained: state.sessionGained,
      lastUpdate: state.lastUpdate, error: state.error, loading: state.loading,
      percent: den > 0 ? Math.max(0, Math.min(100, (state.progressXP / den) * 100)) : 0,
      eta: estimateTime(), history: state.history.slice(0, 12), logs: state.logs.slice(0, 12)
    };
  };
  KC.refreshLevelXp = () => update(true);

  KC.settingsReady.then(() => {
    start();
    KC.on('setting:level_xp_hud', (v) => onTogglePanel(v !== false));
    KC.on('setting:level_xp_ring', (v) => onToggleRing(v !== false));
    KC.on('setting:level_xp_hud_mini', (v) => {
      state.minimized = !!v;
      if (panelOn()) renderVisibility();
    });
  });

  document.addEventListener(
    'keydown',
    (e) => {
      if (e.key !== 'F9' && e.code !== 'F9') return;
      if (
        e.target &&
        (e.target.tagName === 'INPUT' ||
          e.target.tagName === 'TEXTAREA' ||
          e.target.isContentEditable)
      )
        return;
      e.preventDefault();
      e.stopPropagation();
      // Kapalı / sadece halka → detaylı panel; detay açık → halkaya küçült
      const card = $('kc-lx-card');
      const detailOpen = card && !card.classList.contains('kc-lx-hidden') && !state.minimized;
      if (detailOpen) closeDetailPanel();
      else openDetailPanel();
    },
    true
  );

  // Profil halkası — sadece level_xp_ring açıkken
  setInterval(() => {
    try {
      if (!ringOn()) return;
      if (!$('kc-lx-profile-ring') || !document.contains($('kc-lx-profile-ring'))) {
        ensureProfileRing();
      }
      updateProfileRing();
    } catch (_) {}
  }, 3000);
})();
