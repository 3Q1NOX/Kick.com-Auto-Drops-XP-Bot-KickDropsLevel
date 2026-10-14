(function () {
  const KC = (window.KickControl = window.KickControl || {});
  const ID = 'kc-keys-overlay';
  const POS = 'pos_keys_overlay';
  const PRETTY = {
    ArrowUp: '↑', ArrowDown: '↓', ArrowLeft: '←', ArrowRight: '→', Escape: 'Esc', Delete: 'Del',
    Backspace: '⌫', PageUp: 'PgUp', PageDown: 'PgDn'
  };
  const ICO_X = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" fill="none"/></svg>';
  const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const caps = (combo) => {
    const parts = combo.endsWith('++') ? combo.slice(0, -2).split('+').concat('+') : combo.split('+');
    return parts.map((p) => '<kbd>' + esc(PRETTY[p] || p) + '</kbd>').join('<i class="kc-k-plus">+</i>');
  };
  const get = () => document.getElementById(ID);
  const hits = {}; // kısayol -> yanıp sönme bitiş zamanı (liste yeniden çizilse de kaybolmasın)

  /* Açık olan özelliğin satırı farklı renkte görünsün.
     kısayol anahtarı → ayar anahtarı (true = açık). Eylem kısayolları (sonraki/düzelt) durumsuzdur. */
  const STATE = {
    drops_enabled: 'drops_enabled', level_bot: 'level_bot', level_xp_hud: 'level_xp_hud',
    anti_stuck: 'anti_stuck', stall_guard: 'stall_guard', kick_adblock: 'kick_adblock',
    click_to_pause: 'click_to_pause', fps_boost: 'fps_boost', dash: 'dash_open', keys_overlay: 'keys_overlay_open'
  };
  const ON_BY_DEFAULT = ['anti_stuck', 'stall_guard', 'kick_adblock'];
  const isOn = (k) => {
    if (k === 'menu') return KC.settings.ui_collapsed === false;
    const sk = STATE[k];
    if (!sk) return false;
    const v = KC.settings[sk];
    return ON_BY_DEFAULT.indexOf(sk) !== -1 ? v !== false : v === true;
  };
  const WATCH = Object.keys(STATE).map((k) => STATE[k]).concat('ui_collapsed');

  function render() {
    const el = get();
    if (!el) return;
    const b = KC.settings.keybinds || {};
    const rows = (KC.BINDS || []).filter((x) => b[x[0]]);
    el.querySelector('.kc-k-title').textContent = 'Kısayollar' + (rows.length ? ' (' + rows.length + ')' : '');
    el.querySelector('.kc-k-body').innerHTML = rows.length
      ? rows.map((x) => '<div class="kc-k-row' + (isOn(x[0]) ? ' on' : '') + (hits[x[0]] > Date.now() ? ' hit' : '') + '" data-k="' + x[0] + '"><span class="kc-k-label">' + esc(x[1]) +
          '</span><span class="kc-k-keys">' + caps(b[x[0]]) + '</span></div>').join('')
      : '<div class="kc-k-empty">Henüz kısayol atanmadı<small>Menü › Ayarlar › Kısayollar</small></div>';
  }

  function open() {
    if (get()) return;
    const el = document.createElement('div');
    el.id = ID;
    el.innerHTML =
      '<div id="kc-keys-head"><span class="kc-k-title">Kısayollar</span>' +
      '<button type="button" class="kc-k-btn" data-k-close title="Kapat">' + ICO_X + '</button></div>' +
      '<div class="kc-k-sub"></div><div class="kc-k-body"></div>';
    document.documentElement.appendChild(el);
    if (KC.applyPos) KC.applyPos(el, POS, { x: 16, y: 120 });
    if (KC.makeDraggable) KC.makeDraggable(el, el.querySelector('#kc-keys-head'), POS);
    el.addEventListener('click', (e) => {
      if (!e.target.closest('[data-k-close]')) return;
      e.preventDefault(); e.stopPropagation();
      KC.saveSetting('keys_overlay_open', false);
    });
    render();
  }

  KC.toggleKeysOverlay = () => KC.saveSetting('keys_overlay_open', !KC.settings.keys_overlay_open);

  // Hangi kısayol tuşuna basılırsa o satır yanıp sönsün.
  // window'da dinlenir: ana menü olayı durdursa (stopPropagation) bile bu çalışır.
  const FLASH_MS = 450;
  window.addEventListener('keydown', (e) => {
    if (e.repeat || !KC.matchBind) return;
    const el = get();
    if (!el) return;
    const t = e.target, tag = t && t.tagName;
    if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || (t && t.isContentEditable)) return;
    const b = KC.settings.keybinds || {};
    for (const k of Object.keys(b)) {
      if (!b[k] || !KC.matchBind(b[k], e)) continue;
      hits[k] = Date.now() + FLASH_MS;
      const row = el.querySelector('[data-k="' + k + '"]');
      if (!row) continue;
      row.classList.remove('hit'); void row.offsetWidth; // animasyonu baştan başlat
      row.classList.add('hit');
      setTimeout(() => { const r = get() && get().querySelector('[data-k="' + k + '"]'); if (r) r.classList.remove('hit'); }, FLASH_MS);
    }
  }, true);

  KC.settingsReady.then(() => {
    if (KC.settings.keys_overlay_open) open();
    KC.on('setting:keys_overlay_open', (v) => (v ? open() : get()?.remove()));
    KC.on('setting:keybinds', render);
    let rq = 0;
    KC.on('settings:changed', (e) => {
      if (!e || WATCH.indexOf(e.key) === -1 || rq) return;
      rq = requestAnimationFrame(() => { rq = 0; render(); });
    });
    KC.on('setting:pos_keys_overlay', () => {
      const el = get();
      if (el && KC.applyPos) KC.applyPos(el, POS);
    });
  });
})();
