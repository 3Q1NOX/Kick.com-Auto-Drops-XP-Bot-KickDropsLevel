(function () {
  const KC = (window.KickControl = window.KickControl || {});
  const DEFAULTS = {
    level_bot: false,
    anti_stuck: true,
    bg_watch: true,
    drops_enabled: false,
    drops_selected: [],
    drops_auto_claim: true,
    drops_hud: true,
    drops_hud_collapsed: false,
    level_hud: true,
    level_hud_collapsed: false,
    pos_level_hud: null,
    pos_drops_hud: null,
    pos_control: null,
    ui_collapsed: true, // varsayılan: sadece logo
    panel_opacity: 95,
    idle_opacity: 60,
    hud_compact: false,
    quality_160: false, // legacy — migrated to stream_quality
    stream_quality: 'auto', // auto | 160 | 360 | 480 | 720 | 1080
    video_filter: 'off', // off | dim | dark | gray | hide
    stall_guard: true,
    stall_debug: false,
    min_viewers: 10, // level bot: min izleyici (0=hepsi)
    switch_log: [],
    switch_log_max: 10,
    switch_log_open: false,
    switch_log_collapsed: false,
    pos_switch_log: null,
    terms_accepted: false,
    level_xp_hud: true,
    level_xp_hud_mini: false,
    pos_level_xp_hud: null
  };
  KC.settings = { ...DEFAULTS };
  KC._handlers = {};

  KC.on = (ev, fn) => {
    (KC._handlers[ev] = KC._handlers[ev] || []).push(fn);
  };
  KC.emit = (ev, data) => {
    (KC._handlers[ev] || []).forEach((fn) => {
      try { fn(data); } catch (e) { console.warn('[KC]', e); }
    });
  };

  // Ayarlar tarayıcıya özel (storage.local) — Chrome ve Brave birbirini etkilemesin.
  // Eski sürümde storage.sync kullanılıyordu: ilk açılışta bir kez local'e kopyalanır.
  KC.settingsReady = new Promise((resolve) => {
    try {
      chrome.storage.local.get({ ...DEFAULTS, _migrated_local: false }, (data) => {
        const done = (vals) => {
          KC.settings = { ...DEFAULTS, ...vals };
          delete KC.settings._migrated_local;
          resolve(KC.settings);
        };
        if (data._migrated_local) return done(data);
        try {
          chrome.storage.sync.get(DEFAULTS, (old) => {
            const merged = { ...DEFAULTS, ...(old || {}) };
            try { chrome.storage.local.set({ ...merged, _migrated_local: true }); } catch (_) {}
            done(merged);
          });
        } catch (_) {
          done(data);
        }
      });
    } catch (e) {
      resolve(KC.settings);
    }
  });

  // ── Geçiş logu yardımcıları ──
  KC.SWITCH_LOG_LIMITS = [5, 10, 20, 30];
  KC.switchLogMax = () => {
    const n = parseInt(KC.settings?.switch_log_max, 10);
    return KC.SWITCH_LOG_LIMITS.includes(n) ? n : 10;
  };
  KC.classifyReason = (reason) => {
    const r = String(reason || '');
    if (r === 'offline' || r === 'offline-ui' || /^api-/.test(r))
      return { key: 'offline', label: 'Yayın kapandı', color: '#ff6b78' };
    if (r === 'category-changed' || r === 'wrong-category' || r === 'no-match' || r === 'wrong-stream')
      return { key: 'category', label: 'Kategori değişti', color: '#ffb020' };
    if (r === 'video-bad' || /^video-/.test(r) || r === 'buffer')
      return { key: 'video', label: 'Video bozuk', color: '#c77dff' };
    if (r === 'manual')
      return { key: 'manual', label: 'Manuel', color: '#5ab0ff' };
    if (r === 'enable' || /^boot-/.test(r))
      return { key: 'boot', label: 'Başlangıç', color: '#9aa3b2' };
    if (r === 'level-bot' || r === 'kanal-degil')
      return { key: 'level', label: 'Level bot', color: '#53fc18' };
    return { key: 'other', label: r || 'Bilinmiyor', color: '#9aa3b2' };
  };
  KC.logSwitch = (from, to, reason) => {
    try {
      const log = Array.isArray(KC.settings?.switch_log) ? KC.settings.switch_log.slice() : [];
      log.unshift({ at: Date.now(), from: from || '', to: to || '', reason: reason || '' });
      KC.saveSetting('switch_log', log.slice(0, KC.switchLogMax()));
    } catch (_) {}
  };

  KC.saveSetting = (key, value) => {
    KC.settings[key] = value;
    try { chrome.storage.local.set({ [key]: value }); } catch (_) {}
    KC.emit('setting:' + key, value);
    KC.emit('settings:changed', { key, value });
  };

  try {
    chrome.runtime.onMessage.addListener((msg) => {
      if (msg?.type !== 'kc:settings' || !msg.changes) return;
      for (const [key, { newValue }] of Object.entries(msg.changes)) {
        if (newValue === undefined) continue;
        KC.settings[key] = newValue;
        KC.emit('setting:' + key, newValue);
        KC.emit('settings:changed', { key, value: newValue });
      }
      KC.emit('settings:sync', msg.changes);
    });
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area !== 'local') return;
      for (const [key, { newValue }] of Object.entries(changes)) {
        if (newValue === undefined) continue;
        if (KC.settings[key] === newValue) continue;
        KC.settings[key] = newValue;
        KC.emit('setting:' + key, newValue);
        KC.emit('settings:changed', { key, value: newValue });
      }
      KC.emit('settings:sync', changes);
    });
  } catch (_) {}
})();
