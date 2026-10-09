(function () {
  const KC = (window.KickControl = window.KickControl || {});

  /**
   * CSS-only filters — zero per-frame JS, no canvas.
   * hide: opacity 0 (stream still plays for drops)
   */
  const PRESETS = {
    off: { filter: '', hide: false },
    dim: { filter: 'brightness(0.45) contrast(0.9)', hide: false },
    dark: { filter: 'brightness(0.18) contrast(0.85)', hide: false },
    gray: { filter: 'grayscale(1) brightness(0.55)', hide: false },
    hide: { filter: 'none', hide: true },
    // colorful / fun
    vivid: {
      filter: 'saturate(1.55) contrast(1.12) brightness(1.05)',
      hide: false
    },
    vivid_plus: {
      filter: 'saturate(2.1) contrast(1.18) brightness(1.06) hue-rotate(4deg)',
      hide: false
    },
    warm: {
      filter: 'sepia(0.28) saturate(1.25) brightness(1.05) contrast(1.05)',
      hide: false
    },
    cool: {
      filter: 'saturate(1.15) brightness(1.02) hue-rotate(195deg) contrast(1.06)',
      hide: false
    },
    cinema: {
      filter: 'contrast(1.2) brightness(0.92) saturate(1.1)',
      hide: false
    },
    soft: {
      filter: 'brightness(1.08) contrast(0.92) saturate(0.95) blur(0.4px)',
      hide: false
    },
    neon: {
      filter: 'saturate(1.8) contrast(1.25) brightness(1.08) hue-rotate(320deg)',
      hide: false
    },
    retro: {
      filter: 'sepia(0.45) contrast(1.15) brightness(0.95) saturate(1.2)',
      hide: false
    },
    crisp: {
      filter: 'contrast(1.22) saturate(1.15) brightness(1.03)',
      hide: false
    }
  };

  const STYLE_ID = 'kc-video-filter-style';
  let timer = null;

  function mode() {
    const m = String(KC.settings?.video_filter || 'off').toLowerCase();
    return PRESETS[m] ? m : 'off';
  }

  function ensureStyle() {
    let el = document.getElementById(STYLE_ID);
    if (!el) {
      el = document.createElement('style');
      el.id = STYLE_ID;
      (document.head || document.documentElement).appendChild(el);
    }
    return el;
  }

  function apply() {
    const m = mode();
    const p = PRESETS[m];
    const style = ensureStyle();
    if (m === 'off' || !p) {
      style.textContent = '';
      return;
    }
    const sels = [
      'video#video-player',
      'video[src]',
      '#video-player',
      '[data-testid="video-player"] video',
      '.video-player video',
      'div[class*="player"] video',
      'div[class*="Player"] video'
    ].join(', ');
    let css = '';
    if (p.hide) {
      css =
        sels +
        '{opacity:0!important;visibility:hidden!important;}' +
        'div[class*="player"] canvas, div[class*="Player"] canvas{opacity:0!important;}';
    } else {
      css =
        sels +
        '{filter:' +
        p.filter +
        '!important;transition:filter .25s ease;}';
    }
    style.textContent = css;
  }

  function start() {
    if (timer) clearInterval(timer);
    apply();
    timer = setInterval(apply, 8000);
  }

  KC.settingsReady.then(start);
  KC.on('setting:video_filter', () => apply());
  KC.on('settings:sync', () => apply());
  KC.applyVideoFilter = apply;
})();
