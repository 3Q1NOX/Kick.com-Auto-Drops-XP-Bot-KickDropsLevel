(function () {
  'use strict';
  const KC = (window.KickControl = window.KickControl || {});

  // ── Kick Adblock ──
  const AD_SELECTORS = [
    '[data-testid^="ad-" i]',
    '[data-testid$="-ad" i]',
    '[data-testid*="advert" i]',
    '[class*="ad-banner" i]',
    '[class*="adBanner" i]',
    '[class*="advertisement" i]',
    '[class*="Sponsored" i]',
    '[id*="google_ads" i]',
    'iframe[src*="doubleclick"]',
    'iframe[src*="googlesyndication"]',
    'iframe[src*="adservice"]',
    'iframe[src*="adnxs"]',
    '[class*="promo-banner" i]',
    '[class*="PromoBanner" i]',
    '[data-ad]',
    '[aria-label*="Advertisement" i]',
    '[aria-label*="Reklam" i]'
  ];

  let adObs = null;
  let adStyle = null;

  function adblockOn() {
    return !!KC.settings?.kick_adblock;
  }

  function injectAdStyle() {
    if (adStyle) return;
    adStyle = document.createElement('style');
    adStyle.id = 'kc-adblock-style';
    adStyle.textContent = `
/* Kick adblock */
iframe[src*="doubleclick"],
iframe[src*="googlesyndication"],
iframe[src*="adservice"],
iframe[src*="adnxs"],
iframe[src*="amazon-adsystem"],
[data-testid*="ad-banner" i],
[class*="ad-banner" i],
[class*="AdBanner" i],
[class*="advertisement" i],
[aria-label="Advertisement"],
[aria-label="Reklam"] {
  display: none !important;
  visibility: hidden !important;
  width: 0 !important;
  height: 0 !important;
  pointer-events: none !important;
}
body.kc-adblock-on [data-testid*="sidebar-ad" i],
body.kc-adblock-on [class*="SidebarAd" i] {
  display: none !important;
}
`;
    document.documentElement.appendChild(adStyle);
  }

  function scrubAds(root) {
    if (!adblockOn()) return;
    const scope = root || document;
    for (const sel of AD_SELECTORS) {
      try {
        scope.querySelectorAll(sel).forEach((el) => {
          // Don't hide our own UI
          if (el.closest('#kc-dl-float, #kc-menu, #kc-menu-btn-new, #kc-drops-hud, #kc-lx-card, #kc-stall-debug')) return;
          // v1.3.82: video oynatıcıyı / içinde video olan kapsayıcıyı ve sohbeti ASLA gizleme
          if (el.tagName === 'VIDEO' || el.querySelector('video') || el.closest('#video-holder, #video-player, #chatroom, #channel-chatroom, [data-testid="chatroom"]')) return;
          el.style.setProperty('display', 'none', 'important');
        });
      } catch (_) {}
    }
  }

  function startAdblock() {
    injectAdStyle();
    document.body.classList.add('kc-adblock-on');
    scrubAds();
    if (adObs) return;
    // v1.3.82: her sohbet mesajında 16 sorgu çalıştırmak ana iş parçacığını yoruyordu → sohbeti atla,
    // eklenen düğümleri biriktirip 1 sn'de bir toplu tara
    const pending = new Set();
    let flushTimer = null;
    const flush = () => {
      flushTimer = null;
      if (!adblockOn()) { pending.clear(); return; }
      const nodes = Array.from(pending);
      const many = nodes.length > 150;
      pending.clear();
      if (many) { scrubAds(); return; }
      for (const n of nodes) { if (n.isConnected) scrubAds(n); }
    };
    adObs = new MutationObserver((muts) => {
      if (!adblockOn()) return;
      for (const m of muts) {
        for (const n of m.addedNodes) {
          if (n.nodeType !== 1) continue;
          if (n.closest && n.closest('#chatroom, #channel-chatroom, [data-testid="chatroom"]')) continue;
          pending.add(n);
        }
      }
      if (pending.size && !flushTimer) flushTimer = setTimeout(flush, 1000);
    });
    adObs.observe(document.documentElement, { childList: true, subtree: true });
  }

  function stopAdblock() {
    document.body.classList.remove('kc-adblock-on');
    if (adObs) {
      adObs.disconnect();
      adObs = null;
    }
  }

  // ── Click to Pause ──
  function clickPauseOn() {
    return !!KC.settings?.click_to_pause;
  }

  // Greasy Fork "Kick.com Ad Blocker, Viewer Count & Click to Pause" (v4.20) mantığı:
  // sadece doğrudan #video-player öğesine tıklanırsa ve oynuyorsa duraklat.
  // Hiç play()/ses/propagation müdahalesi yok (kontrol çubuğu, ses kaydırıcısı vb. etkilenmez).
  function onVideoClick(e) {
    if (!clickPauseOn()) return;
    const video = document.getElementById('video-player');
    if (!video || e.target !== video) return;
    if (!video.paused) { KC._ownPauseAt = Date.now(); KC._ownPauseWho = 'Click to Pause'; video.pause(); }
  }

  let clickBound = false;
  function startClickPause() {
    if (clickBound) return;
    document.addEventListener('click', onVideoClick, true);
    clickBound = true;
  }
  function stopClickPause() {
    if (!clickBound) return;
    document.removeEventListener('click', onVideoClick, true);
    clickBound = false;
  }

  function sync() {
    if (adblockOn()) startAdblock();
    else stopAdblock();
    if (clickPauseOn()) startClickPause();
    else stopClickPause();
  }

  KC.settingsReady.then(() => {
    sync();
    KC.on('setting:kick_adblock', sync);
    KC.on('setting:click_to_pause', sync);
  });
})();
