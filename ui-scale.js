(function () {
  /* Menü boyutu: ekran çözünürlüğüne göre otomatik ya da elle (ayar: ui_scale).
     Pencereler CSS `scale` ile büyütülür (sol-üst köşe sabit); konumlar bozulmaz. */
  const KC = (window.KickControl = window.KickControl || {});
  const WIN = {
    '#kc-menu': 'pos_control', '#kc-dash': 'pos_dash', '#kc-daily': 'pos_daily_hud', '#kc-drops-hud': 'pos_drops_hud',
    '#kc-camp-picker': 'pos_camp_picker', '#kc-switch-log': 'pos_switch_log',
    '#kc-lx-card': 'pos_level_xp_hud', '#kc-lx-mini': 'pos_level_xp_hud',
    '#kc-stall-debug': 'pos_stall_debug', '#kc-keys-overlay': 'pos_keys_overlay'
  };
  const IDS = Object.keys(WIN);
  const PANELS = IDS.filter((s) => s !== '#kc-menu' && s !== '#kc-lx-mini');

  /** Ekran genişliğine göre otomatik katsayı: 1920 → 1×, 2560 → 1.25×, 3840 → 2× (0.25 adımlarla) */
  const autoScale = () => {
    const w = Math.max(screen.width || 0, screen.height || 0) || 1920;
    return Math.max(1, Math.min(2.5, Math.round((w / 1920) * 4) / 4));
  };
  KC.uiScale = () => {
    const raw = KC.settings && KC.settings.ui_scale;
    if (raw == null || raw === 'auto') return autoScale();
    const n = Number(raw);
    return Number.isFinite(n) && n >= 0.75 && n <= 3 ? n : 1;
  };

  let styleEl = null;
  function apply() {
    const z = KC.uiScale();
    if (!styleEl) {
      styleEl = document.createElement('style');
      styleEl.id = 'kc-uiscale-style';
      document.documentElement.appendChild(styleEl);
    }
    styleEl.textContent =
      ':root{--kc-ui-scale:' + z + '}' +
      IDS.join(',') + '{scale:var(--kc-ui-scale);transform-origin:0 0}' +
      PANELS.join(',') + '{max-height:calc((100vh - 16px) / var(--kc-ui-scale))!important;max-width:calc((100vw - 8px) / var(--kc-ui-scale))!important}';
    try { KC.syncMenuSize && KC.syncMenuSize(); } catch (_) {}
    // Büyüyen pencereler ekran dışında kalmasın
    setTimeout(() => {
      for (const sel of IDS) {
        const el = document.querySelector(sel);
        if (el && KC.applyPos) { try { KC.applyPos(el, WIN[sel]); } catch (_) {} }
      }
    }, 50);
  }
  KC.applyUiScale = apply;
  apply(); // ayarlar yüklenmeden önce otomatik değerle başla
  KC.settingsReady.then(() => {
    apply();
    KC.on('setting:ui_scale', apply);
    addEventListener('resize', apply);
  });
})();
