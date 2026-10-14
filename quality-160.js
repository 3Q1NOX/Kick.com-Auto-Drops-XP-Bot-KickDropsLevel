(function () {
  // Kalite SABİT 160p. Asıl iş page-hook.js içinde (m3u8 yeniden yazımı) yapılır ve
  // sayfa yüklenir yüklenmez aktiftir. Bu dosya yalnızca hook'a hatırlatma yapar ve
  // video hâlâ yüksek çözünürlükte açıldıysa menüden 160p'yi seçmeyi dener.
  const KC = (window.KickControl = window.KickControl || {});
  const CAP = 160;
  let lastMenuTry = 0;
  let highSince = 0;
  let menuTries = 0; // v1.3.44: ayar menüsünü sayfa başına en fazla 2 kez aç (yayını bölmesin)

  const enabled = () => KC.settings?.quality_160 !== false;

  function ping() {
    const h = enabled() ? CAP : null;
    try { localStorage.setItem('kc_q160_off', h ? '0' : '1'); } catch (_) {}
    try { window.postMessage({ source: 'kickcontrol-quality', maxHeight: h, pref: h ? String(h) : 'auto' }, '*'); } catch (_) {}
    try {
      const bc = new BroadcastChannel('kc-smart1080');
      bc.postMessage({ enabled: !!h, maxHeight: h });
      try { bc.close(); } catch (_) {}
    } catch (_) {}
  }

  function getVideo() {
    return document.getElementById('video-player') || document.querySelector('video');
  }

  // Sadece AÇIK bir kalite menüsünün içindeki öğelere dokunur (sayfadaki rastgele düğmelere değil)
  function pickFromOpenMenu() {
    const menus = document.querySelectorAll('[role="menu"], [role="listbox"]');
    for (const menu of menus) {
      const items = menu.querySelectorAll('[role="menuitem"], [role="menuitemradio"], [role="option"], button, div');
      for (const el of items) {
        if (el.children.length > 2) continue;
        const txt = (el.textContent || '').trim();
        if (/^160\s*p?(\b|$)/i.test(txt)) {
          el.click();
          return true;
        }
      }
    }
    return false;
  }

  function fallbackPick() {
    if (!enabled()) { highSince = 0; return; }
    const v = getVideo();
    if (!v || v.paused || !v.videoHeight) { highSince = 0; return; }
    if (v.videoHeight <= CAP + 40) { highSince = 0; return; } // zaten düşük
    const now = Date.now();
    if (!highSince) highSince = now;
    if (now - highSince < 15000) return;       // hook'a önce şans ver
    if (now - lastMenuTry < 90000) return;     // menüyü sık sık açma
    if (menuTries >= 2) return;
    menuTries++;
    lastMenuTry = now;
    const cog =
      document.querySelector('.z-controls button[aria-haspopup="menu"]') ||
      document.querySelector('button[aria-label="Settings"]') ||
      document.querySelector('button[aria-label="settings"]');
    if (!cog) return;
    try { cog.click(); } catch (_) { return; }
    setTimeout(() => {
      let ok = pickFromOpenMenu();
      if (!ok) {
        // alt menü olabilir: "Kalite / Quality" satırına gir, sonra 160p ara
        const menus = document.querySelectorAll('[role="menu"], [role="listbox"]');
        outer: for (const menu of menus) {
          for (const el of menu.querySelectorAll('[role="menuitem"], button, div')) {
            if (el.children.length > 3) continue;
            if (/^(quality|kalite)\b/i.test((el.textContent || '').trim())) {
              try { el.click(); } catch (_) {}
              break outer;
            }
          }
        }
        setTimeout(() => { ok = pickFromOpenMenu(); if (!ok) closeMenu(cog); }, 350);
      }
    }, 350);
  }

  function closeMenu(cog) {
    try {
      if (document.querySelector('[role="menu"], [role="listbox"]')) {
        document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
      }
    } catch (_) {}
  }

  KC.settingsReady.then(() => {
    ping();
    setTimeout(ping, 1000);
    setTimeout(ping, 4000);
    setInterval(() => { ping(); fallbackPick(); }, 8000);
    KC.on('setting:quality_160', () => { highSince = 0; ping(); setTimeout(ping, 300); });
  });
  KC.QUALITY_CAP = CAP;
})();
