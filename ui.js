(function () {
  const KC = (window.KickControl = window.KickControl || {});

  function t(k, v) {
    return KC.t ? KC.t(k, v) : k;
  }
  function icon(name) {
    return KC.iconURL ? KC.iconURL(name) : '';
  }

  KC.clampPos = function (x, y, w, h) {
    const maxX = Math.max(0, window.innerWidth - (w || 280));
    const maxY = Math.max(0, window.innerHeight - (h || 40));
    return {
      x: Math.max(0, Math.min(maxX, x)),
      y: Math.max(0, Math.min(maxY, y))
    };
  };

  KC.applyPos = function (el, storageKey, fallback) {
    if (!el) return;
    el.style.position = 'fixed';
    el.style.transform = 'none';
    const saved = KC.settings && KC.settings[storageKey];
    let x = null, y = null;
    if (saved && typeof saved.x === 'number' && typeof saved.y === 'number') {
      x = saved.x;
      y = saved.y;
    } else if (fallback) {
      x = fallback.x;
      y = fallback.y;
    }
    if (x == null || y == null) return;
    const c = KC.clampPos(x, y, el.offsetWidth || 280, el.offsetHeight || 48);
    el.style.left = c.x + 'px';
    el.style.top = c.y + 'px';
    el.style.right = 'auto';
    el.style.bottom = 'auto';
  };

  KC.makeDraggable = function (el, handle, storageKey) {
    if (!el || !handle) return;
    if (handle.getAttribute('data-kc-drag') === '1') {
      // again apply saved pos
      KC.applyPos(el, storageKey);
      return;
    }
    handle.setAttribute('data-kc-drag', '1');
    let active = false, sx = 0, sy = 0, ox = 0, oy = 0;
    const apply = (x, y) => {
      const c = KC.clampPos(x, y, el.offsetWidth || 280, el.offsetHeight || 48);
      el.style.left = c.x + 'px';
      el.style.top = c.y + 'px';
      el.style.right = 'auto';
      el.style.bottom = 'auto';
      el.style.transform = 'none';
      el.style.position = 'fixed';
    };
    KC.applyPos(el, storageKey);

    handle.addEventListener('mousedown', (e) => {
      if (e.target.closest('button, input, a, label, select')) return;
      active = true;
      sx = e.clientX;
      sy = e.clientY;
      const r = el.getBoundingClientRect();
      ox = r.left;
      oy = r.top;
      apply(ox, oy);
      e.preventDefault();
    });
    document.addEventListener('mousemove', (e) => {
      if (!active) return;
      apply(ox + e.clientX - sx, oy + e.clientY - sy);
    });
    document.addEventListener('mouseup', () => {
      if (!active) return;
      active = false;
      const r = el.getBoundingClientRect();
      const c = KC.clampPos(r.left, r.top, r.width, r.height);
      apply(c.x, c.y);
      KC.saveSetting(storageKey, { x: c.x, y: c.y });
    });
  };

  // ── Menü boyutu: Kick sol menüsünden (#sidebar-wrapper) okunur ──
  (function syncMenuSize() {
    const root = document.documentElement;
    let lastW = 250;
    function parseLen(v) {
      v = String(v || '').trim();
      if (!v) return 0;
      const n = parseFloat(v);
      if (!(n > 0)) return 0;
      if (/rem$/.test(v)) return n * (parseFloat(getComputedStyle(root).fontSize) || 16);
      if (/px$/.test(v) || /^[\d.]+$/.test(v)) return n;
      return 0;
    }
    function apply() {
      try {
        const sb = document.getElementById('sidebar-wrapper');
        let w = 0;
        let h = 0;
        if (sb) {
          const r = sb.getBoundingClientRect();
          if (r.width >= 150) w = r.width;
          if (r.height >= 200) h = r.height;
          if (!w) {
            w = parseLen(getComputedStyle(sb).getPropertyValue('--sidebar-expanded-width'));
          }
        }
        if (!w) w = parseLen(getComputedStyle(root).getPropertyValue('--sidebar-expanded-width'));
        if (w >= 150 && w <= 600) lastW = Math.round(w);
        if (!h) h = window.innerHeight - 64;
        root.style.setProperty('--kc-menu-w', lastW + 'px');
        root.style.setProperty('--kc-menu-maxh', Math.max(240, Math.round(h)) + 'px');
      } catch (_) {}
    }
    apply();
    window.addEventListener('resize', apply);
    setInterval(apply, 2000);
    KC.syncMenuSize = apply;
  })();

  function buildPanel() {
    if (document.getElementById('kc-dl-float')) return;

    const gearSrc = icon('gear-32.png') || icon('icon-gear.png');
    const dropSrc = icon('drop-32.png') || icon('icon-drop.png');

    const root = document.createElement('div');
    root.id = 'kc-dl-float';
    root.innerHTML =
      '<div class="kc-float-head" id="kc-float-head">' +
      '<button type="button" id="kc-float-logo" class="kc-float-logo" title="' + t('panel_title') + '">' +
      '<img class="kc-ico kc-ico-lg" src="' + gearSrc + '" alt="">' +
      '</button>' +
      '<span class="kc-float-title" style="display:none"></span>' +
      '<button type="button" id="kc-float-min" title="Küçült">▾</button>' +
      '</div>' +
      '<div class="kc-float-body" id="kc-float-body">' +
      '<div class="kc-float-toggles">' +
      '<label class="kc-row"><span>' + t('drops_enable') + '</span><input type="checkbox" data-key="drops_enabled"></label>' +
      '<label class="kc-row"><span>' + t('drops_auto_claim') + '</span><input type="checkbox" data-key="drops_auto_claim"></label>' +
      '<label class="kc-row"><span>' + t('drops_hud') + '</span><input type="checkbox" data-key="drops_hud"></label>' +
      '<label class="kc-row"><span>' + t('level_bot') + '</span><input type="checkbox" data-key="level_bot"></label>' +
      '<label class="kc-row"><span>' + t('anti_stuck') + '</span><input type="checkbox" data-key="anti_stuck"></label>' +
      '<label class="kc-row"><span>' + t('bg_watch') + '</span><input type="checkbox" data-key="bg_watch"></label>' +
      '<label class="kc-row"><span>Takılma onarıcı<span class="kc-row-hint">Yayın donarsa (pencere küçülünce) otomatik düzeltir</span></span><input type="checkbox" data-key="stall_guard"></label>' +
      '<label class="kc-row"><span>Tanı bilgisi göster<span class="kc-row-hint">Donma anında video durumunu ekranda gösterir</span></span><input type="checkbox" data-key="stall_debug"></label>' +
      '<div class="kc-row"><span>Yayını şimdi düzelt</span><button type="button" class="kc-btn-sm" id="kc-fix-now">Düzelt</button></div>' +
      '<label class="kc-row"><span>160p (düşük kalite)</span><input type="checkbox" data-key="quality_160"></label>' +
      '</div>' +
'<div class="kc-opacity-row">' +
      '<div class="kc-opacity-top"><span>Boştaki saydamlık<span class="kc-row-hint">Fare üstünde değilken menüler bu kadar görünür</span></span><b id="kc-idle-op-val">60%</b></div>' +
      '<input type="range" id="kc-idle-op" min="10" max="100" step="5" value="60">' +
      '</div>' +
'<div class="kc-campaigns-head">' +
      '<span>' + t('select_campaigns') + '</span>' +
      '<button type="button" id="kc-drops-refresh" class="kc-btn-sm">' + t('refresh') + '</button>' +
      '</div>' +
      '<div class="kc-search-wrap">' +
      '<input type="search" id="kc-drops-search" placeholder="' + t('search_placeholder') + '" autocomplete="off">' +
      '</div>' +
      '<div id="kc-drops-list" class="kc-drops-list">' +
      '<div class="kc-empty">' + t('loading') + '</div>' +
      '</div>' +
      '</div>';

    document.documentElement.appendChild(root);

    const head = document.getElementById('kc-float-head');
    if (KC.settings.pos_control && typeof KC.settings.pos_control.x === 'number') {
      KC.applyPos(root, 'pos_control');
    } else {
      // varsayılan sağ üst — kaydedilince left/top kullanılır
      root.style.top = '72px';
      root.style.right = '16px';
      root.style.left = 'auto';
      root.style.bottom = 'auto';
    }
    KC.makeDraggable(root, head, 'pos_control');

    // Ayarlar yüklenince / başka sekmeden gelince konumu koru
    KC.on('settings:sync', () => {
      try { KC.applyPos(root, 'pos_control'); } catch (_) {}
    });
    KC.on('setting:pos_control', () => {
      try { KC.applyPos(root, 'pos_control'); } catch (_) {}
    });

    const minBtn = document.getElementById('kc-float-min');
    const logoBtn = document.getElementById('kc-float-logo');
    const body = document.getElementById('kc-float-body');
    let collapsed = !!KC.settings.ui_collapsed;
    function applyCollapse() {
      body.style.display = collapsed ? 'none' : '';
      minBtn.textContent = collapsed ? '▸' : '▾';
      root.classList.toggle('is-collapsed', collapsed);
    }
    applyCollapse();
    function toggleCollapse(e) {
      if (e) e.stopPropagation();
      collapsed = !collapsed;
      KC.saveSetting('ui_collapsed', collapsed);
      applyCollapse();
    }
    minBtn.addEventListener('click', toggleCollapse);

    // Insert tuşu: menüyü aç / kapat (yazı yazarken çalışmaz)
    document.addEventListener(
      'keydown',
      (e) => {
        if (e.key !== 'Insert' || e.ctrlKey || e.altKey || e.shiftKey || e.metaKey) return;
        const el = e.target;
        const tag = el && el.tagName;
        if (
          tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' ||
          (el && el.isContentEditable)
        ) return;
        e.preventDefault();
        toggleCollapse();
      },
      true
    );
    // Başka sekmeden / ayardan gelen değişikliği yansıt
    KC.on('setting:ui_collapsed', (v) => {
      if (!!v === collapsed) return;
      collapsed = !!v;
      applyCollapse();
    });
    logoBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      // Logo her zaman aç/kapa (sürükleme head'de, logo butonunda değil)
      toggleCollapse(e);
    });

    root.querySelectorAll('input[data-key]').forEach((input) => {
      const key = input.getAttribute('data-key');
      if (key === 'drops_auto_claim' || key === 'drops_hud' || key === 'stall_guard') {
        input.checked = KC.settings[key] !== false;
      } else {
        input.checked = !!KC.settings[key];
      }
      input.addEventListener('change', () => {
        KC.saveSetting(key, input.checked);
      });
      KC.on('setting:' + key, (v) => {
        if (key === 'drops_auto_claim' || key === 'drops_hud' || key === 'stall_guard') {
          input.checked = v !== false;
        } else {
          input.checked = !!v;
        }
      });
    });


    // ── Boştaki saydamlık ayarı ──
    function applyIdleOpacity(v) {
      let n = parseInt(v, 10);
      if (!(n >= 10 && n <= 100)) n = 60;
      document.documentElement.style.setProperty('--kc-idle-op', String(n / 100));
      const val = document.getElementById('kc-idle-op-val');
      if (val) val.textContent = n + '%';
      const r = document.getElementById('kc-idle-op');
      if (r && String(r.value) !== String(n)) r.value = String(n);
    }
    applyIdleOpacity(KC.settings.idle_opacity);
    (function () {
      const r = document.getElementById('kc-idle-op');
      if (!r) return;
      const root = document.documentElement;
      r.addEventListener('input', () => {
        root.classList.add('kc-op-preview'); // HUD ve log paneli anlık önizleme
        applyIdleOpacity(r.value);
      });
      r.addEventListener('change', () => {
        KC.saveSetting('idle_opacity', parseInt(r.value, 10));
        root.classList.remove('kc-op-preview');
      });
      r.addEventListener('blur', () => root.classList.remove('kc-op-preview'));
    })();
    KC.on('setting:idle_opacity', applyIdleOpacity);

    document.getElementById('kc-fix-now')?.addEventListener('click', () => {
      if (KC.fixStreamNow) KC.fixStreamNow();
    });

    document.getElementById('kc-drops-refresh')?.addEventListener('click', () => {
      KC.emit('drops:refresh');
    });

    // Search filter (client-side on rendered list)
    const search = document.getElementById('kc-drops-search');
    if (search) {
      search.addEventListener('input', () => {
        const q = search.value.trim().toLowerCase();
        document.querySelectorAll('#kc-drops-list .kc-drops-item, #kc-drops-list .kc-camp-row').forEach((row) => {
          const text = (row.textContent || '').toLowerCase();
          row.style.display = !q || text.includes(q) ? '' : 'none';
        });
      });
    }

    KC.on('drops:status', (txt) => {
      const el = document.getElementById('kc-drops-status');
      if (!el) return;
      // Translate raw keys if status is a known i18n key
      let s = txt || t('closed');
      if (typeof s === 'string' && /^[a-z0-9_]+$/i.test(s) && KC.t) {
        s = KC.t(s) || s;
      }
      el.textContent = s;
    });
    KC.on('bot:status', (txt) => {
      const el = document.getElementById('kc-level-status');
      if (!el) return;
      let s = txt || t('closed');
      if (typeof s === 'string' && /^[a-z0-9_]+$/i.test(s) && KC.t) s = KC.t(s) || s;
      el.textContent = s;
    });

    try { KC.emit('drops:refresh'); } catch (_) {}
  }

  function ensureTerms() {
    if (KC.settings.terms_accepted) return;
    if (document.getElementById('kc-dl-terms')) return;
    const overlay = document.createElement('div');
    overlay.id = 'kc-dl-terms';
    overlay.innerHTML =
      '<div class="kc-terms-card"><h2>' +
      t('terms_title') +
      '</h2><p>' +
      t('terms_body') +
      '</p><div class="kc-terms-actions">' +
      '<button type="button" id="kc-terms-ok" class="kc-btn-primary">' +
      t('terms_accept') +
      '</button>' +
      '<button type="button" id="kc-terms-no" class="kc-btn-ghost">' +
      t('terms_decline') +
      '</button></div></div>';
    document.documentElement.appendChild(overlay);
    document.getElementById('kc-terms-ok').addEventListener('click', () => {
      KC.saveSetting('terms_accepted', true);
      overlay.remove();
    });
    document.getElementById('kc-terms-no').addEventListener('click', () => {
      overlay.remove();
    });
  }

  KC.settingsReady.then(() => {
    buildPanel();
    ensureTerms();
  });
})();
