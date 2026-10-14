(function () {
  const KC = (window.KickControl = window.KickControl || {});
  const t = (k, v) => (KC.t ? KC.t(k, v) : k);
  const TRUE_DEFAULT = ['daily_ring', 'drops_auto_claim', 'drops_hud', 'stall_guard', 'level_xp_hud', 'level_xp_ring', 'kick_adblock', 'anti_stuck', 'bg_watch', 'quality_160'];
  const getBool = (k) => (TRUE_DEFAULT.includes(k) ? KC.settings[k] !== false : !!KC.settings[k]);
  const $ = (s, r) => (r || document).querySelector(s);
  const $$ = (s, r) => Array.from((r || document).querySelectorAll(s));

  /* ───────── Ortak yardımcılar (diğer modüller kullanıyor) ───────── */
  KC.clampPos = (x, y, w, h) => ({
    x: Math.max(0, Math.min(Math.max(0, innerWidth - (w || 280)), x)),
    y: Math.max(0, Math.min(Math.max(0, innerHeight - (h || 40)), y))
  });
  KC.applyPos = (el, key, fallback) => {
    if (!el) return;
    el.style.position = 'fixed';
    el.style.transform = 'none';
    const s = KC.settings && KC.settings[key];
    const p = s && typeof s.x === 'number' && typeof s.y === 'number' ? s : fallback;
    if (!p) return;
    const rc = el.getBoundingClientRect();
    const c = KC.clampPos(p.x, p.y, rc.width || el.offsetWidth || 280, rc.height || el.offsetHeight || 48);
    Object.assign(el.style, { left: c.x + 'px', top: c.y + 'px', right: 'auto', bottom: 'auto' });
  };

  /** Tüm bilinen panellerin konumunu ayarlardan yeniden uygula (F5 / SPA sonrası) */
  KC.reapplyAllPositions = () => {
    const map = {
      pos_control: () => document.getElementById('kc-menu'),
      pos_btn: () => document.getElementById('kc-fab') || document.querySelector('.kc-fab'),
      pos_drops_hud: () => document.getElementById('kc-drops-hud'),
      pos_level_xp_hud: () => document.getElementById('kc-lx-card'),
      pos_switch_log: () => document.getElementById('kc-switch-log'),
      pos_camp_picker: () => document.getElementById('kc-camp-picker'),
      pos_stall_debug: () => document.getElementById('kc-stall-debug'),
      pos_keys_overlay: () => document.getElementById('kc-keys-overlay'),
      pos_dash: () => document.getElementById('kc-dash'),
      pos_daily_hud: () => document.getElementById('kc-daily')
    };
    for (const [key, fn] of Object.entries(map)) {
      try {
        const el = fn();
        if (el) KC.applyPos(el, key);
      } catch (_) {}
    }
  };
  KC.makeDraggable = (el, handle, key) => {
    if (!el || !handle) return;
    if (handle.dataset.kcDrag === '1') return KC.applyPos(el, key);
    handle.dataset.kcDrag = '1';
    // Sürüklerken layout yok: sadece transform (GPU) + rAF; bırakınca left/top yazılır.
    let on = false, sx = 0, sy = 0, ox = 0, oy = 0, w = 0, h = 0, nx = 0, ny = 0, raf = 0;
    let zz = 1; // pencere `scale` ile büyütülmüşse transform da aynı oranda büyür
    const paint = () => { raf = 0; el.style.transform = 'translate3d(' + (nx - ox) / zz + 'px,' + (ny - oy) / zz + 'px,0)'; };
    const onMove = (e) => {
      if (!on) return;
      e.stopPropagation(); // Kick'in mousemove dinleyicileri sürüklerken çalışıp yavaşlatmasın
      nx = Math.max(0, Math.min(Math.max(0, innerWidth - w), ox + e.clientX - sx));
      ny = Math.max(0, Math.min(Math.max(0, innerHeight - h), oy + e.clientY - sy));
      if (!raf) raf = requestAnimationFrame(paint);
    };
    const onUp = () => {
      if (!on) return; on = false;
      removeEventListener('mousemove', onMove, true);
      removeEventListener('mouseup', onUp, true);
      removeEventListener('blur', onUp);
      if (raf) { cancelAnimationFrame(raf); raf = 0; }
      Object.assign(el.style, { left: nx + 'px', top: ny + 'px', right: 'auto', bottom: 'auto', transform: 'none', position: 'fixed', willChange: '' });
      KC.saveSetting(key, { x: nx, y: ny });
    };
    KC.applyPos(el, key);
    handle.addEventListener('mousedown', (e) => {
      if (e.button !== 0 || e.target.closest('button, input, a, label, select')) return;
      on = true; sx = e.clientX; sy = e.clientY;
      zz = parseFloat(getComputedStyle(el).scale) || 1;
      const r = el.getBoundingClientRect(); ox = nx = r.left; oy = ny = r.top; w = r.width; h = r.height;
      el.style.willChange = 'transform';
      addEventListener('mousemove', onMove, true);
      addEventListener('mouseup', onUp, true);
      addEventListener('blur', onUp);
      e.preventDefault();
    });
  };
  KC.applyMenuTheme = (root) => {
    // Tema seçimi kaldırıldı: tek sabit (koyu ImGui) görünüm
    if (root) root.setAttribute('data-theme', 'imgui');
    document.documentElement.setAttribute('data-kc-theme', 'imgui');
    if (document.body) document.body.setAttribute('data-kc-theme', 'imgui');
  };
  (function sidebarSync() {
    const root = document.documentElement;
    const apply = () => {
      // v1.3.68: 330 → 360px — kompakt drop satırları (isim + çubuk + süre) dar menüde sıgmıyordu
      root.style.setProperty('--kc-menu-w', '360px');
      root.style.setProperty('--kc-menu-maxh', Math.max(240, (innerHeight - 100) / (KC.uiScale ? KC.uiScale() : 1)) + 'px');
    };
    apply(); addEventListener('resize', apply);
    KC.syncMenuSize = apply;
  })();

  /* ───────── Küçük HTML üreticileri ───────── */
  const chk = (key, label) =>
    `<label class="m-chk"><input type="checkbox" data-key="${key}"><i></i><span>${label}</span></label>`;
  const combo = (key, label, opts) =>
    `<div class="m-row"><select class="m-in" data-key="${key}">${opts.map((o) => `<option value="${o[0]}">${o[1]}</option>`).join('')}</select><span>${label}</span></div>`;
  const sl = (key, label, min, max, def, unit) =>
    `<div class="m-row m-sl"><input type="range" data-key="${key}" min="${min}" max="${max}" step="${unit === 'px' ? 1 : 5}" value="${def}"><span>${label} <b data-val="${key}">${def}</b>${unit}</span></div>`;
  const btn = (id, label) => `<button type="button" class="m-btn" id="${id}">${label}</button>`;
  const head = (title, body, open) =>
    `<div class="m-ch${open === false ? '' : ' open'}"><div class="m-h"><i class="m-tri"></i>${title}</div><div class="m-c">${body}</div></div>`;

  const BINDS = [
    ['menu', 'Menüyü aç/kapat'], ['drops_enabled', 'Drop farm'], ['level_bot', 'Level Bot'],
    ['level_xp_hud', 'Level XP paneli'], ['anti_stuck', 'Anti-stuck'], ['stall_guard', 'Onarıcı'],
    ['kick_adblock', 'Kick Adblock'], ['click_to_pause', 'Click to Pause'], ['fps_boost', 'FPS Boost'], ['next_stream', 'Sonraki yayın'], ['fix_stream', 'Yayını düzelt'], ['fix_lag', 'Gecikmeyi düzelt'], ['keys_overlay', 'Kısayol listesi'], ['dash', 'Dashboard'], ['camp', 'Kampanya paneli']
  ];
  KC.BINDS = BINDS;
  const POS = [
    ['pos_btn', 'Menü butonu'], ['pos_control', 'Ana menü'], ['pos_drops_hud', 'Drops HUD'], ['pos_level_xp_hud', 'Level XP'],
    ['pos_switch_log', 'Geçiş logu'], ['pos_camp_picker', 'Kampanya paneli'], ['pos_stall_debug', 'Durum kutusu'], ['pos_keys_overlay', 'Kısayol listesi'], ['pos_dash', 'Dashboard'], ['pos_daily_hud', 'Günlük ödül HUD']
  ];

  function build() {
    if ($('#kc-menu')) return;
    const gear = KC.iconURL ? KC.iconURL('gear-32.png') : '';

    const farm =
      head('Durum',
        chk('dash_open', 'Dashboard (tüm bilgiler)') + '<div class="m-stat"><b>Drops</b><span id="m-st-drops">—</span></div><div class="m-stat"><b>Level</b><span id="m-st-level">—</span></div>') +
      head('Drops Farm',
        chk('drops_enabled', 'Drop farm (yayın izle)') + chk('drops_auto_claim', 'Kazanılan dropları otomatik al') + chk('daily_reward_auto', 'Günlük ödülü otomatik al') + chk('daily_ring', 'Günlük ödül karesi (Kick düğmesi)') + chk('daily_hud_open', 'Günlük ödül paneli') + chk('drops_hud', 'Drop ilerleme paneli') + chk('hud_compact', 'Kompakt paneller')) +
      head('Level Bot',
        chk('level_bot', 'Level bot (yayın izle)') + chk('level_xp_hud', 'Level XP paneli') + chk('level_xp_ring', 'Profil XP halkası') +
        combo('min_viewers', 'Min. izleyici', [[0, 'Hepsi'], [5, '5+'], [10, '10+'], [25, '25+'], [50, '50+'], [100, '100+'], [250, '250+'], [500, '500+']])) +
      head('Yayın',
        chk('quality_160', '160p kalite') +
        chk('fps_boost', 'FPS Boost (gereksizleri kapat)') +
        chk('fps_hide_chat', 'FPS Boost: sohbeti gizle') +
        chk('chat_hide_gifs', 'Sohbet: GIF / animasyonlu emote gizle') +
        chk('chat_hide_badges', 'Sohbet: badge gizle (mod/sub/vip…)') +
        combo('video_filter', 'Video filtresi', [['off', 'Kapalı'], ['vivid', 'Canlı'], ['dim', 'Loş'], ['dark', 'Koyu'], ['gray', 'Gri'], ['hide', 'Gizle']])) +
      head('Kampanyalar',
        '<div class="m-row">' + btn('m-refresh', 'Yenile') + btn('m-camp', 'Kampanya paneli') + btn('m-claim', 'Claim') + btn('m-log', 'Log') + '</div>' +
        '<div id="kc-drops-list" class="kc-drops-list"></div>');

    const guard =
      head('Koruma', chk('anti_stuck', 'Anti-stuck') + chk('bg_watch', 'Sekmeyi aktif tut') + chk('no_mute', 'Yayın sessize alınmasın') + chk('stall_guard', 'Onarıcı (pencere küçülünce)') + chk('stall_auto', 'Gecikmede otomatik onar') +
        '<div class="m-row"><input class="m-in" type="number" min="1" max="120" step="1" data-key="stall_lag_sec" style="width:70px"><span>Gecikme eşiği (sn)</span></div>' +
        '<div class="m-stat"><b>Gecikme</b><span id="m-lag-val">—</span></div>' +
        '<div class="m-row">' + btn('m-lag', 'Gecikmeyi düzelt (canlıya geç)') + '</div>' +
        chk('stall_debug', 'Durum kutusu')) +
      head('Tetiklenme ayarları',
        '<div class="m-row"><input class="m-in" type="number" min="2" max="30" step="1" data-key="stall_t1" style="width:70px"><span>1. müdahale: takılma süresi (sn)</span></div>' +
        '<div class="m-row"><input class="m-in" type="number" min="4" max="60" step="1" data-key="stall_t2" style="width:70px"><span>2. müdahale: takılma süresi (sn)</span></div>' +
        '<div class="m-row"><input class="m-in" type="number" min="6" max="120" step="1" data-key="stall_t3" style="width:70px"><span>3. müdahale: takılma süresi (sn)</span></div>' +
        '<div class="m-row"><input class="m-in" type="number" min="5" max="120" step="1" data-key="stall_cool" style="width:70px"><span>Oto canlıya geç arası bekleme (sn)</span></div>' +
        '<div class="m-row"><input class="m-in" type="number" min="1" max="10" step="1" data-key="stall_margin" style="width:70px"><span>Canlıya atlarken tampon payı (sn)</span></div>' +
        '<div class="m-row"><input class="m-in" type="number" min="0" max="60" step="1" data-key="stall_qpause" style="width:70px"><span>Kalite seçince duraklama (sn)</span></div>' +
        chk('stall_bg_idle', 'Arka plandayken onarma / canlıya geçme') +
        '<div class="m-row"><input class="m-in" type="number" min="0" max="30" step="1" data-key="stall_fg_grace" style="width:70px"><span>Sekmeye dönünce bekleme (sn)</span></div>' +
        chk('stall_reload', 'Uzun takılmada sayfayı yenile (farm)'), true) +
      head('Yayın kontrolü', '<div class="m-row">' + btn('m-fix', 'Yayını düzelt') + btn('m-next', 'Sonraki yayın') + '</div>');

    const extra =
      head('Araçlar', chk('kick_adblock', 'Kick Adblock') + chk('click_to_pause', 'Click to Pause')) +
      head('Koordinat seçici',
        combo('', 'Hedef', POS.map((p) => [p[0], p[1]]).concat([['clipboard', 'Sadece kopyala']])).replace('data-key=""', 'id="m-ct"') +
        combo('', 'Seçim tipi', [['point', 'Nokta (X Y)'], ['rect', 'Kare (x y w h)']]).replace('data-key=""', 'id="m-cm"') +
        '<div class="m-row">' + btn('m-cstart', 'Seçimi başlat') + btn('m-cstop', 'Durdur') + '</div>' +
        '<div class="m-row"><input class="m-in" id="m-cres" readonly placeholder="Henüz seçilmedi"><span>Son sonuç</span></div>' +
        '<div class="m-row"><input class="m-in m-xy" id="m-cx" type="number" placeholder="X"><input class="m-in m-xy" id="m-cy" type="number" placeholder="Y">' + btn('m-capply', 'Uygula') + '</div>', false);

    // Saydamlık: tüm kaydırıcılar doğrudan görünür (iç içe kapalı bölüm yok)
    const OPW = KC.OP_WINDOWS || [], OPP = KC.OP_PARTS || [], OPD = KC.OP_DEFAULTS || {};
    const opacityPane =
      '<div class="dim">0 = tamamen şeffaf · 100 = tam dolu</div>' +
      '<div class="m-row"><select class="m-in" id="m-op-win"><option value="all">Hepsi birden</option>' +
      OPW.map((w) => '<option value="' + w.id + '">' + w.name + '</option>').join('') +
      '</select><span>Pencere</span></div>' +
      OPP.map((p) =>
        '<div class="m-row m-sl" data-oprow="' + p[0] + '">' +
        '<input type="range" data-opall="' + p[0] + '" min="' + p[2] + '" max="' + p[3] + '" step="' + (p[4] === 'px' ? 1 : 5) + '" value="' + (OPD[p[0]] != null ? OPD[p[0]] : 100) + '">' +
        '<span>' + p[1] + ' <b data-opall-val="' + p[0] + '">' + (OPD[p[0]] != null ? OPD[p[0]] : 100) + '</b>' + p[4] + '</span></div>'
      ).join('') +
      '<div class="m-row">' + btn('m-op-reset', 'Hepsini varsayılana döndür') + '</div>';
    const opacitySection = head('Saydamlık', opacityPane);

    const settings =
      head('Menü renkleri', KC.colorPaneHTML ? KC.colorPaneHTML() : '') +
      opacitySection +
      head('Görünüm',
        combo('ui_scale', 'Menü boyutu', [['auto', 'Otomatik (ekrana göre)'], ['1', '100%'], ['1.25', '125%'], ['1.5', '150%'], ['1.75', '175%'], ['2', '200%'], ['2.5', '250%']]) +
        '<div class="m-row"><input type="range" data-key="idle_opacity" min="15" max="100" step="5"><span>Ana menü, fare dışındayken <b id="m-op">100</b>%</span></div>' +
        '<div class="m-row"><input class="m-in" id="m-lim" type="number" min="5" max="30" step="5" data-key="switch_log_max" style="width:70px"><span>Geçiş logu satırı</span></div>') +
      head('Hata günlüğü',
        '<div class="dim">Eklentinin uyarı/hataları (ağ hataları, drop seçimi nedenleri) kaydedilir. Sorun olunca Kopyala/İndir ile paylaşabilirsin.</div>' +
        '<div class="m-row">' + btn('m-errlog', 'Günlüğü aç') + btn('m-errlog-clear', 'Temizle') + '</div>', false) +
      head('Config (ayar dosyası)',
        '<div class="dim">Tüm ayarlar: konumlar, saydamlık, kısayollar, anahtarlar</div>' +
        '<div class="m-row">' + btn('m-cfg-exp', 'Dışa aktar') + btn('m-cfg-imp', 'İçe aktar') + btn('m-cfg-reset', 'Sıfırla') + '</div>' +
        '<input type="file" id="m-cfg-file" accept=".json,application/json" style="display:none"><div class="dim" id="m-cfg-msg"></div>', false) +
      head('Kısayollar',
        chk('keys_overlay_open', 'Kısayol listesi (ekranda göster)') +
        '<div class="dim">Tıkla → tuşa bas · çift tık = sil</div>' +
        BINDS.map((b) => `<div class="m-row" data-bind="${b[0]}"><button type="button" class="m-btn m-key">—</button><span>${b[1]}</span></div>`).join('') , false);

    const root = document.createElement('div');
    root.id = 'kc-menu';
    root.innerHTML =
      '<div class="m-title" id="m-title"><span class="m-tri m-arrow" id="m-fold"></span><span>Kick Drops &amp; Level</span><span class="m-x" id="m-close" title="Kapat">×</span></div>' +
      '<div class="m-bar" id="m-bar">' +
      '<div class="m-mi"><span>Yardım</span><div class="m-dd"><div data-a="terms">Sorumluluk reddi</div></div></div>' +
      '<div class="m-mi" data-a="features"><span>Özellikler</span></div>' +
      '</div>' +
      '<div class="m-body" id="m-body">' +
      '<div class="m-tabs" id="m-tabs"><div class="m-tab on" data-p="farm">Farm</div><div class="m-tab" data-p="guard">Koruma</div><div class="m-tab" data-p="extra">Ekstra</div><div class="m-tab" data-p="set">Ayarlar</div></div>' +
      `<div class="m-pane on" data-p="farm">${farm}</div><div class="m-pane" data-p="guard">${guard}</div><div class="m-pane" data-p="extra">${extra}</div><div class="m-pane" data-p="set">${settings}</div>` +
      '</div>';
    document.documentElement.appendChild(root);

    const fab = document.createElement('div');
    fab.id = 'kc-menu-btn-new';
    fab.innerHTML =
      '<img class="kcf-img" src="' + (KC.iconURL ? KC.iconURL('drop-48.png') : '') + '" alt="" draggable="false"><i class="kcf-dot"></i>';
    document.documentElement.appendChild(fab);
    // Kick'in üst çubuktaki ikon butonundan boyut / köşe / renk al (bulunamazsa CSS varsayılanı)
    const matchKickButtons = () => {
      try {
        const cands = Array.from(document.querySelectorAll('header button, nav button, [class*="header" i] button'))
          .filter((b) => !b.closest('#kc-menu, #kc-menu-btn-new') && b.offsetParent);
        for (const b of cands) {
          const r = b.getBoundingClientRect();
          if (r.top > 120 || r.width < 30 || r.width > 52 || Math.abs(r.width - r.height) > 2) continue;
          const cs = getComputedStyle(b), bg = cs.backgroundColor;
          if (!bg || bg === 'transparent' || /rgba\(0,\s*0,\s*0,\s*0\)/.test(bg)) continue;
          fab.style.setProperty('--kcf-size', Math.round(r.width) + 'px');
          fab.style.setProperty('--kcf-radius', cs.borderTopLeftRadius || '8px');
          fab.style.setProperty('--kcf-bg', bg);
          fab.style.setProperty('--kcf-fg', cs.color);
          return true;
        }
      } catch (_) {}
      return false;
    };
    if (!matchKickButtons()) [1000, 3000, 7000].some((ms, i, a) => (setTimeout(() => matchKickButtons(), ms), false));
    const paintFab = () => {
      const farm = !!KC.settings.drops_enabled, lvl = !!KC.settings.level_bot;
      fab.classList.toggle('on', farm || lvl);
      fab.title = 'Drops & Level — ' + (farm || lvl ? [farm ? 'Drops' : '', lvl ? 'Level' : ''].filter(Boolean).join(' + ') + ' çalışıyor' : 'kapalı') + ' (Insert)';
    };
    paintFab();
    KC.on('settings:changed', paintFab);

    KC.applyPos(root, 'pos_control', { x: Math.max(8, innerWidth - 350), y: 80 });
    KC.makeDraggable(root, $('#m-title', root), 'pos_control');
    KC.applyPos(fab, 'pos_btn', { x: Math.max(8, innerWidth - 56), y: 30 });
    KC.makeDraggable(fab, fab, 'pos_btn');
    KC.applyMenuTheme(root);
    wire(root, fab);
    // SPA / geç yüklenen paneller için konumu tekrar uygula
    [400, 1200, 3000].forEach((ms) => {
      setTimeout(() => {
        try { KC.reapplyAllPositions(); } catch (_) {}
      }, ms);
    });
  }

  function wire(root, fab) {
    /* Aç / kapat */
    const isOpen = () => KC.settings.ui_collapsed === false;
    const paintOpen = () => { root.style.display = isOpen() ? 'flex' : 'none'; fab.style.display = isOpen() ? 'none' : 'flex'; };
    const setOpen = (v) => { KC.saveSetting('ui_collapsed', !v); paintOpen(); if (v) KC.applyPos(root, 'pos_control'); };
    paintOpen();
    KC.on('setting:ui_collapsed', paintOpen);
    let d0 = null;
    fab.addEventListener('mousedown', (e) => { d0 = [e.clientX, e.clientY]; });
    fab.addEventListener('click', (e) => { if (d0 && Math.hypot(e.clientX - d0[0], e.clientY - d0[1]) > 4) return; setOpen(true); });
    $('#m-close', root).onclick = () => setOpen(false);
    $('#m-fold', root).onclick = () => { const c = !root.classList.contains('folded'); root.classList.toggle('folded', c); KC.saveSetting('win_collapsed', c); };
    root.classList.toggle('folded', !!KC.settings.win_collapsed);

    /* Sekmeler + açılır başlıklar + menü çubuğu */
    const showTab = (name) => {
      if (!$('.m-tab[data-p="' + name + '"]', root)) name = 'farm';
      $$('.m-tab', root).forEach((x) => x.classList.toggle('on', x.dataset.p === name));
      $$('.m-pane', root).forEach((p) => p.classList.toggle('on', p.dataset.p === name));
    };
    showTab(KC.settings.menu_tab && KC.settings.menu_tab !== 'op' ? KC.settings.menu_tab : 'farm');
    $('#m-tabs', root).addEventListener('click', (e) => {
      const tab = e.target.closest('.m-tab'); if (!tab) return;
      showTab(tab.dataset.p);
      KC.saveSetting('menu_tab', tab.dataset.p);
    });
    // Açılır başlıklar: başlık metnine göre kaydedilir, F5'ten sonra aynı durumda gelir
    const chKey = (ch) => { const h = $('.m-h', ch); return h ? h.textContent.trim() : ''; };
    const savedOpen = KC.settings.menu_open && typeof KC.settings.menu_open === 'object' ? KC.settings.menu_open : {};
    $$('.m-ch', root).forEach((ch) => { const k = chKey(ch); if (k in savedOpen) ch.classList.toggle('open', !!savedOpen[k]); });
    root.addEventListener('click', (e) => {
      const h = e.target.closest('.m-h'); if (!h) return;
      h.parentNode.classList.toggle('open');
      const map = {};
      $$('.m-ch', root).forEach((ch) => { map[chKey(ch)] = ch.classList.contains('open'); });
      KC.saveSetting('menu_open', map);
    });
    const bar = $('#m-bar', root);
    bar.addEventListener('click', (e) => {
      const it = e.target.closest('[data-a]');
      if (it) { act(it.dataset.a); $$('.m-mi', bar).forEach((m) => m.classList.remove('open')); return; }
      const mi = e.target.closest('.m-mi'); if (!mi) return;
      const was = mi.classList.contains('open');
      $$('.m-mi', bar).forEach((m) => m.classList.remove('open'));
      if (!was) mi.classList.add('open');
    });
    document.addEventListener('mousedown', (e) => { if (!e.target.closest('#m-bar')) $$('.m-mi', bar).forEach((m) => m.classList.remove('open')); });

    function act(a) {
      try {
        if (a === 'next') (KC.forceNextStream ? KC.forceNextStream('manual-panel') : KC.forceSwitchChannel && KC.forceSwitchChannel());
        else if (a === 'fix') (KC.fixStreamNow || KC.stallFixNow || (() => {}))('menü düğmesi / kısayol');
        else if (a === 'lag') (KC.catchUpLive || (() => {}))(false);
        else if (a === 'refresh') KC.refreshDrops && KC.refreshDrops();
        else if (a === 'camp') KC.openCampaignPicker && KC.openCampaignPicker();
        else if (a === 'log') KC.showSwitchLog && KC.showSwitchLog();
        else if (a === 'claim') KC.claimNow && KC.claimNow();
        else if (a === 'keys') KC.toggleKeysOverlay && KC.toggleKeysOverlay();
        else if (a === 'dash') KC.toggleDash && KC.toggleDash();
        else if (a === 'errlog') KC.toggleErrLog && KC.toggleErrLog();
        else if (a === 'features') KC.toggleFeatures && KC.toggleFeatures();
        else if (a === 'close') setOpen(false);
        else if (a === 'terms') { KC.saveSetting('terms_accepted', false); showTerms(); }
      } catch (e) { KCwarn('[KC]', e); }
    }
    const on = (id, a) => { const el = $('#' + id, root); if (el) el.onclick = () => act(a); };
    on('m-errlog', 'errlog'); { const c = $('#m-errlog-clear', root); if (c) c.onclick = () => KC.errlog && KC.errlog.clear(); }
    on('m-refresh', 'refresh'); on('m-camp', 'camp'); on('m-claim', 'claim'); on('m-log', 'log'); on('m-fix', 'fix'); on('m-lag', 'lag');
    /* Canlı gecikme göstergesi (menü açıkken saniyede bir): ileri tampon (sn) + Kick "geride" işareti */
    const lagEl = $('#m-lag-val', root);
    if (lagEl) setInterval(() => {
      try {
        if (root.style.display === 'none') return;
        const lag = KC.getLiveLag ? KC.getLiveLag() : 0;
        const behind = KC.hasLiveButton ? KC.hasLiveButton() : false;
        lagEl.textContent = lag.toFixed(1) + ' sn · ' + (behind ? 'geride' : 'canlı');
      } catch (_) {}
    }, 1000); on('m-next', 'next'); on('m-keys', 'keys');

    /* data-key bağlama: checkbox / select / range / number */
    $$('[data-key]', root).forEach((el) => {
      const key = el.dataset.key;
      const paint = () => {
        if (el.type === 'checkbox') el.checked = getBool(key);
        else if (KC.settings[key] != null) el.value = String(KC.settings[key]);
        const lab = el.type === 'range' && $('[data-val="' + key + '"]', root);
        if (lab) lab.textContent = el.value;
      };
      paint();
      el.addEventListener('change', () => {
        let v;
        if (el.type === 'checkbox') v = el.checked;
        else if (el.type === 'range' || el.type === 'number' || key === 'min_viewers') v = parseInt(el.value, 10);
        else v = el.value;
        KC.saveSetting(key, v);
        if (key === 'video_filter' && KC.applyVideoFilter) KC.applyVideoFilter();
      });
      if (el.type === 'range') el.addEventListener('input', () => {
        const lab = $('[data-val="' + key + '"]', root);
        if (lab) lab.textContent = el.value;
        if (key === 'idle_opacity') { $('#m-op', root).textContent = el.value; applyIdle(parseInt(el.value, 10)); }
        else if (key.indexOf('op_') === 0) KC.opSet(key, parseInt(el.value, 10)); // canlı önizleme (debounce'lu kayıt)
      });
      KC.on('setting:' + key, paint);
    });
    if (KC.colorPaneBind) KC.colorPaneBind(root);
    const opSel = $('#m-op-win', root);
    const opSync = () => {
      const id = opSel.value, w = (KC.OP_WINDOWS || []).find((x) => x.id === id);
      $$('[data-opall]', root).forEach((el) => {
        const part = el.dataset.opall;
        const row = $('[data-oprow="' + part + '"]', root);
        if (row) row.style.display = w && (((part === 'title' || part === 'ttext') && !w.title) || (part === 'bars' && !w.bars.length)) ? 'none' : '';
        const v = KC.opGet(w ? w.id : (KC.OP_WINDOWS[0] || {}).id, part);
        el.value = String(v);
        const lab = $('[data-opall-val="' + part + '"]', root); if (lab) lab.textContent = el.value;
      });
    };
    if (opSel) {
      opSel.addEventListener('change', opSync);
      $$('[data-opall]', root).forEach((el) => {
        el.addEventListener('input', () => {
          const part = el.dataset.opall, v = parseInt(el.value, 10);
          const lab = $('[data-opall-val="' + part + '"]', root); if (lab) lab.textContent = el.value;
          if (opSel.value === 'all') KC.opSetAll && KC.opSetAll(part, v);
          else KC.opSet && KC.opSet(KC.opKey(opSel.value, part), v);
        });
        el.addEventListener('change', () => { KC.opFlush && KC.opFlush(); });
      });
      opSync();
    }
    const opReset = $('#m-op-reset', root);
    if (opReset) opReset.onclick = () => { KC.opResetAll && KC.opResetAll(); opSync(); };
    /* Config: dışa / içe aktar / sıfırla */
    const cfgMsg = (t) => { const m = $('#m-cfg-msg', root); if (m) m.textContent = t; };
    const SKIP = ['switch_log', 'coord_picker', 'terms_accepted', '_migrated_local'];
    const known = (k) => SKIP.indexOf(k) === -1 && (k in (KC.DEFAULTS || {}) || k.indexOf('op_') === 0);
    const reloadSoon = () => setTimeout(() => location.reload(), 500);
    $('#m-cfg-exp', root).onclick = () => {
      const out = {};
      Object.keys(KC.settings).forEach((k) => { if (known(k)) out[k] = KC.settings[k]; });
      const blob = new Blob([JSON.stringify({ _kc_config: 1, version: (chrome.runtime.getManifest && chrome.runtime.getManifest().version) || '', settings: out }, null, 2)], { type: 'application/json' });
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = 'kick-drops-level-config-' + new Date().toISOString().slice(0, 10) + '.json';
      document.documentElement.appendChild(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(a.href), 4000);
      cfgMsg('Dışa aktarıldı (' + Object.keys(out).length + ' ayar)');
    };
    const file = $('#m-cfg-file', root);
    $('#m-cfg-imp', root).onclick = () => { file.value = ''; file.click(); };
    file.onchange = () => {
      const f = file.files && file.files[0]; if (!f) return;
      const r = new FileReader();
      r.onload = () => {
        try {
          const j = JSON.parse(String(r.result));
          const src = j && j._kc_config && j.settings && typeof j.settings === 'object' ? j.settings : null;
          if (!src) return cfgMsg('Geçersiz config dosyası');
          let n = 0;
          Object.keys(src).forEach((k) => { if (known(k)) { KC.saveSetting(k, src[k]); n++; } });
          cfgMsg(n + ' ayar yüklendi · sayfa yenileniyor…');
          reloadSoon();
        } catch (_) { cfgMsg('Dosya okunamadı'); }
      };
      r.readAsText(f);
    };
    $('#m-cfg-reset', root).onclick = () => {
      if (!confirm('Tüm ayarlar varsayılana dönsün mü?')) return;
      Object.keys(KC.DEFAULTS || {}).forEach((k) => { if (known(k)) KC.saveSetting(k, KC.DEFAULTS[k]); });
      KC.opResetAll && KC.opResetAll();
      cfgMsg('Sıfırlandı · sayfa yenileniyor…');
      reloadSoon();
    };
    KC.on('setting:hud_compact', () => { try { KC.renderDropsHud && KC.renderDropsHud(); } catch (_) {} });
    const applyIdle = (v) => root.style.setProperty('--m-idle', String(Math.max(15, Math.min(100, v || 100)) / 100));
    applyIdle(KC.settings.idle_opacity); $('#m-op', root).textContent = KC.settings.idle_opacity || 100;
    KC.on('setting:idle_opacity', applyIdle);

    /* Durum satırları */
    const st = (txt) => { let s = txt || t('closed'); if (typeof s === 'string' && /^[a-z0-9_]+$/i.test(s)) s = t(s) || s; return s; };
    KC.on('drops:status', (x) => { $('#m-st-drops', root).textContent = st(x); });
    KC.on('bot:status', (x) => { $('#m-st-level', root).textContent = st(x); });
    try { if (KC.getDropsStatus) $('#m-st-drops', root).textContent = st(KC.getDropsStatus()); } catch (_) {}
    try { KC.emit('drops:refresh'); } catch (_) {}

    /* Kısayollar */
    const binds = () => ({ ...(KC.settings.keybinds || {}) });
    const keyBtns = $$('[data-bind]', root);
    const paintBinds = () => keyBtns.forEach((r) => { $('.m-key', r).textContent = listening === r.dataset.bind ? '...' : (binds()[r.dataset.bind] || '—'); });
    let listening = null;
    // Dashboard'daki kısayol bölümü de aynı atama mantığını kullanır
    KC.bindListening = () => listening;
    KC.bindListen = (name) => { listening = name; paintBinds(); KC.emit('binds:listen', name); };
    KC.bindClear = (name) => { KC.saveSetting('keybinds', { ...binds(), [name]: '' }); listening = null; paintBinds(); KC.emit('binds:listen', null); };
    KC.on('binds:listen', paintBinds);
    paintBinds(); KC.on('setting:keybinds', paintBinds);
    keyBtns.forEach((r) => {
      const b = $('.m-key', r);
      b.onclick = (e) => { e.stopPropagation(); KC.bindListen(r.dataset.bind); };
      b.ondblclick = () => KC.bindClear(r.dataset.bind);
    });
    const combo = (e) => {
      let k = e.key === ' ' ? 'Space' : e.key; if (k.length === 1) k = k.toUpperCase();
      const p = []; if (e.ctrlKey) p.push('Ctrl'); if (e.altKey) p.push('Alt'); if (e.shiftKey) p.push('Shift'); if (e.metaKey) p.push('Meta');
      if (!['Control', 'Alt', 'Shift', 'Meta'].includes(e.key)) p.push(k);
      return p.join('+');
    };
    const match = (bind, e) => {
      if (!bind) return false;
      const parts = bind.split('+'), key = parts[parts.length - 1];
      if (!!e.ctrlKey !== parts.includes('Ctrl') || !!e.altKey !== parts.includes('Alt') || !!e.shiftKey !== parts.includes('Shift') || !!e.metaKey !== parts.includes('Meta')) return false;
      let p = e.key === ' ' ? 'Space' : e.key; if (p.length === 1) p = p.toUpperCase();
      if (p.toLowerCase() === key.toLowerCase() || e.code === key) return true;
      // Klavye düzeni / Caps / ölü tuş farkı: harf ve rakamlarda fiziksel tuşa da bak
      const K = key.length === 1 ? key.toUpperCase() : '';
      return !!K && /[A-Z0-9]/.test(K) && (e.code === 'Key' + K || e.code === 'Digit' + K);
    };
    KC.matchBind = match;
    // Yazı yazarken (sohbet, arama kutusu) sadece harf/rakam gibi yazıyı bozacak kısayollar durur;
    // F-tuşları, Insert, Ctrl/Alt kombinasyonları vb. her zaman çalışır.
    const isTyping = (el) => { const t = el && el.tagName; return t === 'INPUT' || t === 'TEXTAREA' || t === 'SELECT' || !!(el && el.isContentEditable); };
    const typesText = (bind) => { const parts = bind.split('+'); return !parts.includes('Ctrl') && !parts.includes('Alt') && !parts.includes('Meta') && parts[parts.length - 1].length === 1; };
    const hit = (bind, e, typing) => match(bind, e) && !(typing && typesText(bind));
    window.addEventListener('keydown', (e) => {
      if (listening) {
        e.preventDefault(); e.stopPropagation();
        if (e.key !== 'Escape' && !['Control', 'Alt', 'Shift', 'Meta'].includes(e.key)) KC.saveSetting('keybinds', { ...binds(), [listening]: combo(e) });
        listening = null; paintBinds(); KC.emit('binds:listen', null); return;
      }
      if (!e.isTrusted || e.isComposing) return; // level bot'un sahte tuş vuruşlarını sayma
      const typing = isTyping(e.target) || isTyping(document.activeElement);
      const b = binds();
      let fn = null;
      if (hit(b.menu, e, typing)) fn = () => setOpen(!isOpen());
      else if (hit(b.keys_overlay, e, typing)) fn = () => act('keys');
      else if (hit(b.dash, e, typing)) fn = () => act('dash');
      else if (hit(b.camp, e, typing)) fn = () => act('camp');
      else if (hit(b.next_stream, e, typing)) fn = () => act('next');
      else if (hit(b.fix_stream, e, typing)) fn = () => act('fix');
      else if (hit(b.fix_lag, e, typing)) fn = () => act('lag');
      else {
        for (const k of ['drops_enabled', 'level_bot', 'level_xp_hud', 'anti_stuck', 'stall_guard', 'kick_adblock', 'click_to_pause', 'fps_boost'])
          if (hit(b[k], e, typing)) { fn = () => KC.saveSetting(k, !getBool(k)); break; }
      }
      if (!fn) return;
      e.preventDefault(); e.stopPropagation(); // Kick'in kendi kısayolu da aynı anda tetiklenmesin
      if (!e.repeat) fn(); // tuşa basılı tutunca açıp kapatıp durmasın
    }, true);

    /* Koordinat seçici + konum */
    const EL = { pos_control: () => root, pos_btn: () => fab, pos_drops_hud: () => $('#kc-drops-hud'), pos_level_xp_hud: () => $('#kc-lx-card'), pos_switch_log: () => $('#kc-switch-log'), pos_camp_picker: () => $('#kc-camp-picker'), pos_stall_debug: () => $('#kc-stall-debug'), pos_keys_overlay: () => $('#kc-keys-overlay'), pos_dash: () => $('#kc-dash'), pos_daily_hud: () => $('#kc-daily') };
    const applyTo = (key, x, y) => {
      if (key === 'clipboard') return;
      KC.saveSetting(key, { x, y });
      const el = EL[key] && EL[key](); if (el) KC.applyPos(el, key);
    };
    const res = $('#m-cres', root);
    $('#m-cstart', root).onclick = () => {
      const target = $('#m-ct', root).value, mode = $('#m-cm', root).value;
      setOpen(false);
      if (mode === 'point' && KC.pickCoordFor) {
        KC.pickCoordFor((x, y) => { res.value = x + ' ' + y; applyTo(target, x, y); try { navigator.clipboard.writeText(x + ' ' + y); } catch (_) {} setOpen(true); });
      } else {
        KC._coordPickTarget = (x, y, w, h) => { res.value = [x, y, w || 0, h || 0].join(' '); applyTo(target, x, y); KC._coordPickTarget = null; setOpen(true); };
        KC.saveSetting('coord_picker', true);
      }
    };
    $('#m-cstop', root).onclick = () => { try { KC.stopCoordPicker && KC.stopCoordPicker(); } catch (_) {} KC._coordPickTarget = null; KC.saveSetting('coord_picker', false); };
    $('#m-capply', root).onclick = () => {
      const x = parseInt($('#m-cx', root).value, 10), y = parseInt($('#m-cy', root).value, 10);
      if (!isNaN(x) && !isNaN(y)) applyTo($('#m-ct', root).value, x, y);
    };
  }

  function showTerms() {
    if (KC.settings.terms_accepted || $('#kc-dl-terms')) return;
    const o = document.createElement('div');
    o.id = 'kc-dl-terms';
    o.innerHTML = `<div class="kc-terms-card"><h2>${t('terms_title')}</h2><p>${t('terms_body')}</p><div class="kc-terms-actions"><button type="button" id="kc-terms-ok" class="kc-btn-primary">${t('terms_accept')}</button><button type="button" id="kc-terms-no" class="kc-btn-ghost">${t('terms_decline')}</button></div></div>`;
    document.documentElement.appendChild(o);
    $('#kc-terms-ok').onclick = () => { KC.saveSetting('terms_accepted', true); o.remove(); };
    $('#kc-terms-no').onclick = () => o.remove();
  }

  KC.settingsReady.then(() => { build(); showTerms(); });
})();
