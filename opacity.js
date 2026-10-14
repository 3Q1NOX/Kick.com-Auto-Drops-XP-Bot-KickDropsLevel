(function () {
  /* Pencere başına ayrıntılı saydamlık.
     Her pencere için 5 ayar (ayar anahtarı: op_<pencere>_<parça>):
       bg    Arka plan        (pencere gövdesinin zemin rengi, %)
       title Başlık çubuğu    (üstteki mavi şerit, %)
       bars  Alt çubuklar     (menü çubuğu / sekmeler / bölüm başlıkları, %)
       all   Tüm pencere      (içerik dahil her şey, %)
       blur  Arka plan bulanıklığı (px)
     Renkler tema değişkenlerinden (--im-*) gelir; yüzde sadece alfa kanalını ölçekler. */
  const KC = (window.KickControl = window.KickControl || {});

  const D = { bg: 88, title: 20, bars: 20, all: 100, blur: 0, border: 100, ttext: 100 };
  const PARTS = [
    ['bg', 'Arka plan', 0, 100, '%'],
    ['title', 'Başlık çubuğu', 0, 100, '%'],
    ['bars', 'Alt çubuklar', 0, 100, '%'],
    ['all', 'Tüm pencere', 20, 100, '%'],
    ['blur', 'Bulanıklık', 0, 12, 'px'],
    ['border', 'Dış çerçeve', 0, 100, '%'],
    ['ttext', 'Başlık şeridi', 0, 100, '%']  // üst başlık barının tamamı (metin değil)
  ];
  const HDR = ':is(.kc-section-label, .kc-inline-camps-head, .kc-combined-level-head)';

  // bars: [seçici, renk değişkeni]  (hover/aktif durumları bozulmasın diye :not(:hover) eklenir)
  const WINDOWS = [
    { id: 'menu', name: 'Ana menü', root: '#kc-menu', title: '#kc-menu .m-title',
      bars: [['#kc-menu .m-bar', '--im-menubar-bg', 1], ['#kc-menu .m-tab:not(.on)', '--im-tab'], ['#kc-menu .m-tab.on', '--im-tab-act'], ['#kc-menu .m-h', '--im-header']] },
    { id: 'dash', name: 'Dashboard', root: '#kc-dash', title: '#kc-dash .kc-d-title',
      bars: [['#kc-dash .kc-d-kh', '--im-header']] },
    { id: 'daily', name: 'Günlük ödül HUD', root: '#kc-daily', title: '#kc-daily .kc-dr-title', bars: [] },
    { id: 'drops', name: 'Drops HUD', root: '#kc-drops-hud', title: '#kc-drops-hud #kc-dhud-head',
      bars: [['#kc-drops-hud ' + HDR, '--im-header']] },
    { id: 'camp', name: 'Kampanya paneli', root: '#kc-camp-picker', title: '#kc-camp-picker #kc-camp-head',
      bars: [['#kc-camp-picker ' + HDR, '--im-header']] },
    { id: 'slog', name: 'Geçiş logu', root: '#kc-switch-log', title: '#kc-switch-log #kc-slog-head', bars: [] },
    { id: 'lx', name: 'Level XP kartı', root: '#kc-lx-card', title: '#kc-lx-card #kc-lx-head',
      bars: [['#kc-lx-card .kc-lx-section-title', '--im-header'], ['#kc-lx-card ' + HDR, '--im-header']] },
    { id: 'lxmini', name: 'Level XP mini şerit', root: '#kc-lx-mini', title: null, bars: [] },
    { id: 'stall', name: 'Yayın durum kutusu', root: '#kc-stall-debug', title: '#kc-stall-debug .kc-sd-title', bars: [] },
    { id: 'errlog', name: 'Hata günlüğü', root: '#kc-errlog', title: '#kc-errlog .kc-el-title', bars: [] },
    { id: 'keys', name: 'Kısayol listesi', root: '#kc-keys-overlay', title: '#kc-keys-overlay #kc-keys-head',
      bars: [['#kc-keys-overlay .kc-k-sub', '--im-menubar-bg', 1]] }
  ];

  KC.OP_WINDOWS = WINDOWS;
  KC.OP_PARTS = PARTS;
  KC.OP_DEFAULTS = D;
  KC.opKey = (id, part) => 'op_' + id + '_' + part;
  KC.opGet = (id, part) => {
    const raw = KC.settings && KC.settings[KC.opKey(id, part)];
    if (raw == null) return D[part];
    const n = Number(raw);
    return Number.isFinite(n) ? n : D[part];
  };

  const mix = (color, pct) => 'color-mix(in srgb, ' + color + ' ' + Math.max(0, Math.min(100, pct)) + '%, transparent)';
  const rule = (sels, decl) => (Array.isArray(sels) ? sels : [sels]).join(',') + '{' + decl + '}\n';

  function build() {
    let css = '';
    for (const w of WINDOWS) {
      const bg = KC.opGet(w.id, 'bg'), tt = KC.opGet(w.id, 'title'), br = KC.opGet(w.id, 'bars');
      const all = KC.opGet(w.id, 'all'), blur = KC.opGet(w.id, 'blur');
      let decl = 'background:' + mix('var(--kc-win-bg, rgb(16 16 16))', bg) + '!important;';
      if (blur > 0) decl += 'backdrop-filter:blur(' + blur + 'px)!important;-webkit-backdrop-filter:blur(' + blur + 'px)!important;';
      if (w.id === 'menu') {
        // Ana menüde "fare dışındayken" saydamlığı (--m-idle) ile çarpılır
        css += rule(w.root, decl + 'opacity:calc(var(--m-idle, 1) * ' + all / 100 + ')!important;');
        css += rule([w.root + ':hover', w.root + ':focus-within'], 'opacity:' + all / 100 + '!important;');
      } else {
        css += rule(w.root, decl + 'opacity:' + all / 100 + '!important;');
      }
      // Başlık: zemin ::before ile (yazı/× opacity'ten etkilenmez)
      //  - Başlık çubuğu (tt) → şerit rengi alfa
      //  - Başlık şeridi (tx) → şerit görünürlüğü; yazı her zaman net kalır
      const bd = KC.opGet(w.id, 'border'), tx = KC.opGet(w.id, 'ttext');
      if (w.title) {
        css += rule(w.title, 'position:relative!important;background:transparent!important;');
        css += rule(w.title + '>*', 'position:relative!important;z-index:1!important;');
        let strip = 'content:""!important;position:absolute!important;inset:0!important;z-index:0!important;' +
          'pointer-events:none!important;border-radius:inherit!important;' +
          'background:' + mix('var(--im-title-act, #294a7a)', tt) + '!important;';
        if (tx < 100) strip += 'opacity:' + (Math.max(0, Math.min(100, tx)) / 100) + '!important;';
        css += rule(w.title + '::before', strip);
      }
      if (bd < 100) css += rule(w.root, 'border-color:' + mix('var(--im-border, #6e6e8080)', bd) + '!important;' + (bd <= 0 ? 'box-shadow:none!important;' : ''));
      for (const [sel, v, fixed] of w.bars) {
        // fixed=1: hover rengi olmayan çubuklar — :not(:hover) olmadan sabit kalır (fareyle üzerine gelince renk değişmesin)
        css += rule(fixed ? sel : sel + ':not(:hover)', 'background:' + mix('var(' + v + ', #294a7a)', br) + '!important;');
      }
    }
    return css;
  }

  let styleEl = null, raf = 0;
  function apply() {
    raf = 0;
    if (!styleEl) {
      styleEl = document.createElement('style');
      styleEl.id = 'kc-opacity-style';
      document.documentElement.appendChild(styleEl);
    }
    styleEl.textContent = build();
  }
  const schedule = () => { if (!raf) raf = requestAnimationFrame(apply); };
  KC.applyOpacity = apply;

  /* Kaydırırken depolamaya her adımda yazmak kasıyordu: bellekte anında uygula,
     depolamaya 250ms sessizlikten sonra tek seferde yaz. */
  let pend = {}, wt = 0;
  const flush = () => {
    wt = 0; const out = pend; pend = {};
    try { chrome.storage.local.set(out); } catch (_) {}
  };
  KC.opSet = (key, v) => {
    KC.settings[key] = v; pend[key] = v;
    schedule();
    if (wt) clearTimeout(wt);
    wt = setTimeout(flush, 250);
  };
  // Kaydırıcı bırakılınca / sayfa kapanınca / sekme gizlenince bekleyen değerleri hemen yaz
  KC.opFlush = () => { if (wt) clearTimeout(wt); if (Object.keys(pend).length) flush(); else wt = 0; };
  KC.opPending = (key) => key in pend;
  addEventListener('pagehide', KC.opFlush);
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden') KC.opFlush(); });
  /** Bir parçayı tüm pencerelere birden yaz */
  KC.opSetAll = (part, v) => WINDOWS.forEach((w) => KC.opSet(KC.opKey(w.id, part), v));
  KC.opResetAll = () => WINDOWS.forEach((w) => PARTS.forEach((p) => KC.opSet(KC.opKey(w.id, p[0]), D[p[0]])));

  KC.settingsReady.then(() => {
    apply();
    KC.on('settings:changed', (e) => { if (e && typeof e.key === 'string' && e.key.indexOf('op_') === 0) schedule(); });
    KC.on('settings:sync', schedule);
    KC.on('setting:idle_opacity', schedule);
  });
})();
