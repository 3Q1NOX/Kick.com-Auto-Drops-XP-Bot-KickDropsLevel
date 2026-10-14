(function () {
  const KC = (window.KickControl = window.KickControl || {});
  const DEFAULTS = {
    level_bot: false,
    anti_stuck: true,
    bg_watch: true,
    no_mute: true, // yayın sessize alınmasın (sessize alınırsa sesi geri aç)
    drops_enabled: false,
    drops_selected: [],
    drops_auto_claim: true,
    drops_hud: false,
    drops_hud_collapsed: false,
    level_hud: true,
    level_hud_collapsed: false,
    pos_level_hud: null,
    pos_drops_hud: { x: 687, y: 364 },
    pos_control: { x: 441, y: 120.328125 },
    pos_btn: { x: 1559, y: 12 },
    ui_collapsed: false,
    win_collapsed: false, // ImGui-style: title bar kalır, body gizlenir
    panel_opacity: 95,
    idle_opacity: 100,
    col_accent: '#4296f9', // menü rengi: vurgu (düğme/başlık/seçim)
    col_bg: '#0f0f0f', // menü rengi: zemin
    col_text: '#ffffff', // menü rengi: yazı
    col_hud: '', // ödül karesi / level yazıları: '' = otomatik (durum rengi)
    ui_scale: 'auto', // menü boyutu: auto | 1 | 1.25 | 1.5 ...
    hud_compact: true,
    video_filter: 'off', // off | dim | dark | gray | hide
    stall_guard: true,
    stall_lag_sec: 30, // canlıdan bu kadar sn geride kalınca (oto onar açıksa) canlıya atla
    stall_auto: false, // gecikmede kendiliğinden onarma
    stall_t1: 10, // takılma kaç sn sürerse 1. müdahale (boşluk atla / oynat)
    stall_t2: 25, // 2. müdahale (yeniden oynat)
    stall_t3: 45, // 3. müdahale (güçlü onarım)
    stall_cool: 45, // otomatik canlıya-geç arası en az bekleme (sn)
    stall_margin: 6, // canlıya atlarken bırakılan tampon payı (sn)
    stall_qpause: 30, // kalite menüsü seçilince otomatik onarım duraklaması (sn, 0 = kapalı)
    stall_bg_idle: true, // sekme arka plandayken (ve dönünce kısa süre) otomatik onarım / canlıya-geç yapma
    stall_fg_grace: 10, // sekmeye dönünce otomatik onarım öncesi bekleme (sn)
    stall_reload: false,
    daily_reward_auto: true, // Kick Günlük Ödül (Daily Reward) hazır olunca otomatik al // uzun yükleme takılmasında sayfa yenile (sadece farm açıkken)
    quality_160: false, // 160p sınırı açık/kapalı
    fps_boost: false, // FPS Boost: animasyon/blur/gölge kapat, önizleme videolarını durdur
    fps_hide_chat: false, // FPS Boost açıkken sohbeti de gizle
    chat_hide_gifs: false, // sohbet: animasyonlu GIF/emote gizle
    chat_hide_badges: false, // sohbet: badge (mod/sub/vip…) gizle
    stall_debug: false,
    min_viewers: 10, // level bot: min izleyici (0=hepsi)
    switch_log: [],
    switch_log_max: 10,
    switch_log_open: false,
    switch_log_collapsed: false,
    pos_switch_log: { x: 1099, y: 75 },
    terms_accepted: false,
    level_xp_hud: true,       // detay Level XP paneli
    level_xp_ring: true,      // profil avatarındaki ilerleme halkası (panelden bağımsız)
    level_xp_hud_mini: false, // panel küçültülmüş mü
    pos_level_xp_hud: { x: 873, y: 176 },
    pos_camp_picker: { x: 1286, y: 82 },
    pos_stall_debug: { x: 0, y: 793.625 },
    coord_picker: false,
    dash_open: true,
    dash_tab: 'all',
    dash_hide: [], // Dashboard'da gizlenen bölümler (status, level, drops, daily, bg, err, keys, btns)
    dash_keys_open: false, // Dashboard içindeki Kısayollar bölümü açık mı
    pos_dash: { x: 0, y: 629 },
    daily_ring: true, // Kick "Günlük Ödülünü Al" düğmesinde kare ilerleme çerçevesi
    daily_hud_open: false, // Günlük ödül detay HUD
    pos_daily_hud: { x: 16, y: 360 },
    pos_features: { x: 120, y: 90 },
    keys_overlay_open: true,
    keys_overlay_collapsed: false,
    keys_overlay_pin: false,
    pos_keys_overlay: { x: 799, y: 809.625 },
    camp_picker_open: false,
    camp_picker_collapsed: false,
    menu_tab: 'set',
    menu_open: { 'Config (ayar dosyası)': true, 'Drops Farm': true, Durum: true, Ekstra: true, Görünüm: true, Kampanyalar: false, 'Koordinat seçici': true, Koruma: true, Kısayollar: false, 'Level Bot': true, Saydamlık: true, 'Tüm pencereler (hepsi birden)': true, Yayın: true, 'Yayın kontrolü': true },
    lx_closed: [],
    kick_adblock: false,
    click_to_pause: true,
    keybinds: {
      anti_stuck: '',
      camp: '',
      click_to_pause: '',
      dash: '',
      drops_enabled: 'Home',
      fix_lag: '',
      fix_stream: 'F10',
      fps_boost: '',
      keys_overlay: '',
      kick_adblock: '',
      level_bot: 'F4',
      level_xp_hud: 'F6',
      menu: 'Insert',
      next_stream: 'F2',
      stall_guard: ''
    }
  };
  KC.DEFAULTS = DEFAULTS;
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
      // get(null): DEFAULTS'ta olmayan anahtarlar da (op_* saydamlık vb.) yüklensin
      chrome.storage.local.get(null, (all) => {
        const data = { ...DEFAULTS, _migrated_local: false, ...(all || {}) };
        const done = (vals) => {
          KC.settings = { ...DEFAULTS, ...vals };
          delete KC.settings._migrated_local;
          // v1.3.85 tek seferlik: zayıf internete uygun koruma ayarları + "Tetiklenme ayarları" açık gelsin
          try {
            if ((parseInt(KC.settings.cfg_ver, 10) || 0) < 85) {
              const prevOpen = KC.settings.menu_open && typeof KC.settings.menu_open === 'object' ? KC.settings.menu_open : {};
              const o = {
                stall_t1: 10, stall_t2: 25, stall_t3: 45, stall_cool: 45, stall_margin: 6, stall_qpause: 30,
                stall_bg_idle: true, stall_fg_grace: 10, stall_reload: false, stall_auto: false,
                cfg_ver: 85, menu_open: { ...prevOpen, 'Tetiklenme ayarları': true }
              };
              Object.assign(KC.settings, o);
              try { chrome.storage.local.set(o); } catch (_) {}
            }
          } catch (_) {}
          resolve(KC.settings);
        };
        if (data._migrated_local) return done(data);
        try {
          chrome.storage.sync.get(DEFAULTS, (old) => {
            const merged = { ...DEFAULTS, ...(old || {}), ...(all || {}) };
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

  // Toplu yazma: F5 öncesi kayıp olmasın diye pagehide'da flush
  const _dirty = Object.create(null);
  let _flushT = 0;
  function flushSettings() {
    _flushT = 0;
    const keys = Object.keys(_dirty);
    if (!keys.length) return;
    const batch = {};
    for (const k of keys) {
      batch[k] = _dirty[k];
      delete _dirty[k];
    }
    try {
      chrome.storage.local.set(batch, () => {
        try {
          if (chrome.runtime.lastError && typeof KC.elog === 'function') {
            KC.elog('warn', 'settings', 'storage yazılamadı: ' + chrome.runtime.lastError.message);
          }
        } catch (_) {}
      });
    } catch (e) {
      try {
        if (typeof KC.elog === 'function') KC.elog('warn', 'settings', 'storage set hata: ' + (e && e.message));
      } catch (_) {}
    }
  }
  KC.flushSettings = flushSettings;

  KC.saveSetting = (key, value) => {
    KC.settings[key] = value;
    _dirty[key] = value;
    // Anında da yaz (tek anahtar) — kayıp riskini azalt
    try { chrome.storage.local.set({ [key]: value }); } catch (_) {}
    if (!_flushT) _flushT = setTimeout(flushSettings, 80);
    KC.emit('setting:' + key, value);
    KC.emit('settings:changed', { key, value });
  };

  try {
    window.addEventListener('pagehide', () => { try { flushSettings(); } catch (_) {} });
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'hidden') {
        try { flushSettings(); } catch (_) {}
      }
    });
  } catch (_) {}

  try {
    chrome.runtime.onMessage.addListener((msg) => {
      if (msg?.type !== 'kc:settings' || !msg.changes) return;
      for (const [key, { newValue }] of Object.entries(msg.changes)) {
        if (newValue === undefined) continue;
        if (KC.opPending && key.indexOf('op_') === 0 && KC.opPending(key)) continue;
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
        if (KC.opPending && key.indexOf('op_') === 0 && KC.opPending(key)) continue;
        KC.settings[key] = newValue;
        KC.emit('setting:' + key, newValue);
        KC.emit('settings:changed', { key, value: newValue });
      }
      KC.emit('settings:sync', changes);
    });
  } catch (_) {}
})();
