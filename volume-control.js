(function () {
  const KC = (window.KickControl = window.KickControl || {});
  let timer = null;
  let patched = new WeakSet();

  function pct() {
    let n = parseInt(KC.settings?.stream_volume, 10);
    if (!(n >= 0 && n <= 100)) n = 100;
    return n;
  }

  /** Master volume 0–1. Always active (100 = full). */
  function masterVol() {
    return pct() / 100;
  }

  KC.getDesiredVolume = function () {
    return masterVol();
  };

  function getVideos() {
    const list = [];
    const seen = new Set();
    const add = (el) => {
      if (!el || seen.has(el)) return;
      seen.add(el);
      list.push(el);
    };
    try {
      add(document.getElementById('video-player'));
    } catch (_) {}
    try {
      document
        .querySelectorAll(
          'video#video-player, video[src], video, [data-testid="video-player"] video, div[class*="player"] video, div[class*="Player"] video'
        )
        .forEach(add);
    } catch (_) {}
    return list;
  }

  /** Lock HTMLMediaElement.volume so Kick UI / scripts can't override easily */
  function patchElement(el) {
    if (!el || patched.has(el)) return;
    try {
      const desc =
        Object.getOwnPropertyDescriptor(HTMLMediaElement.prototype, 'volume') ||
        Object.getOwnPropertyDescriptor(el, 'volume');
      if (!desc || !desc.set) return;

      let internal = typeof el.volume === 'number' ? el.volume : 1;
      Object.defineProperty(el, 'volume', {
        configurable: true,
        enumerable: true,
        get() {
          return internal;
        },
        set(v) {
          const want = masterVol();
          // Always enforce master; ignore external sets that diverge a lot
          internal = want;
          try {
            desc.set.call(this, want);
          } catch (_) {
            internal = want;
          }
        }
      });
      patched.add(el);
      // apply once
      try {
        desc.set.call(el, masterVol());
        internal = masterVol();
      } catch (_) {}
    } catch (_) {}
  }

  function applyOne(el) {
    if (!el) return;
    const want = masterVol();
    try {
      patchElement(el);
    } catch (_) {}
    try {
      if (want <= 0.001) {
        el.muted = true;
        try {
          el.volume = 0;
        } catch (_) {}
      } else {
        // Master açıkken mute kapalı; ses seviyesi slider
        if (el.muted) el.muted = false;
        try {
          el.volume = want;
        } catch (_) {}
      }
    } catch (_) {}
  }

  function apply() {
    getVideos().forEach(applyOne);
  }

  function start() {
    if (timer) clearInterval(timer);
    apply();
    timer = setInterval(apply, 1500);
  }

  KC.settingsReady.then(start);
  KC.on('setting:stream_volume', () => {
    apply();
  });
  // volume_force no longer required — master always on
  KC.on('setting:volume_force', () => apply());

  KC.applyVolume = apply;

  // New video nodes (SPA / channel switch)
  try {
    const mo = new MutationObserver(() => {
      apply();
    });
    mo.observe(document.documentElement, { childList: true, subtree: true });
  } catch (_) {}
})();
