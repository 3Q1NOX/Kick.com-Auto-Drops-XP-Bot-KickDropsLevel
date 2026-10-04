(function () {
  const KC = (window.KickControl = window.KickControl || {});
  let timer = null;

  function enabled() {
    return !!KC.settings?.quality_160;
  }

  function applyViaStorage() {
    if (!enabled()) return;
    try {
      sessionStorage.setItem('stream_quality', '160');
      sessionStorage.setItem('kick_quality', '160');
      localStorage.setItem('stream_quality', '160');
    } catch (_) {}
    try {
      window.dispatchEvent(
        new CustomEvent('kc:quality', { detail: { enabled: true, height: 160, pref: '160' } })
      );
    } catch (_) {}
  }

  function pickLowestFromMenu() {
    if (!enabled()) return;
    try {
      const items = Array.from(
        document.querySelectorAll('[role="menuitem"], [role="option"], button, div[class*="quality"]')
      );
      let best = null;
      let bestH = Infinity;
      for (const el of items) {
        const txt = (el.textContent || '').trim();
        const m = txt.match(/\b(160|180|240|360|480|720|1080)\s*p?\b/i);
        if (!m) continue;
        const h = parseInt(m[1], 10);
        if (h < bestH) {
          bestH = h;
          best = el;
        }
      }
      // Prefer exact 160 if present
      for (const el of items) {
        const txt = (el.textContent || '').trim();
        if (/\b160\s*p?\b/i.test(txt)) {
          best = el;
          bestH = 160;
          break;
        }
      }
      if (best && bestH <= 360) {
        best.click();
        return true;
      }
    } catch (_) {}
    return false;
  }

  function tryOpenSettingsAndPick() {
    if (!enabled()) return;
    applyViaStorage();
    // Only try UI path occasionally
    try {
      const video =
        document.getElementById('video-player') ||
        document.querySelector('video');
      if (!video) return;
      // Look for quality already set via player internals
      const cog =
        document.querySelector('.z-controls button[aria-haspopup="menu"]') ||
        document.querySelector('button[aria-label="Settings"]') ||
        document.querySelector('button[aria-label="settings"]');
      if (!cog) return;
      // Don't spam-click every tick — only if not recently applied
      if (tryOpenSettingsAndPick._busy) return;
      tryOpenSettingsAndPick._busy = true;
      setTimeout(() => {
        try {
          pickLowestFromMenu();
        } catch (_) {}
        tryOpenSettingsAndPick._busy = false;
      }, 400);
    } catch (_) {
      tryOpenSettingsAndPick._busy = false;
    }
  }

  function start() {
    if (timer) clearInterval(timer);
    applyViaStorage();
    timer = setInterval(() => {
      if (!enabled()) return;
      applyViaStorage();
      // soft attempt
      pickLowestFromMenu();
    }, 12000);
    setTimeout(tryOpenSettingsAndPick, 3000);
  }

  KC.settingsReady.then(() => {
    if (enabled()) start();
  });
  KC.on('setting:quality_160', (on) => {
    if (on) start();
    else if (timer) {
      clearInterval(timer);
      timer = null;
    }
  });
})();
