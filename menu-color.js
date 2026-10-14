(function () {
  /* Menü renkleri: vurgu (düğme / başlık / seçim), zemin ve yazı rengi.
     Ayarlar: col_accent, col_bg, col_text (hex). Varsayılan renkler seçiliyken hiçbir şey
     geçersiz kılınmaz — görünüm öncekiyle birebir aynı kalır.
     Tüm pencereler (menü, HUD'lar, kampanya paneli, dashboard…) --im-* değişkenlerini
     kullandığı için renkler hepsine birden uygulanır. */
  const KC = (window.KickControl = window.KickControl || {});

  const DEF = { accent: '#4296f9', bg: '#0f0f0f', text: '#ffffff', hud: '' }; // hud: '' = otomatik (durum rengi)
  const KEYS = { accent: 'col_accent', bg: 'col_bg', text: 'col_text', hud: 'col_hud' };
  const SETS = {
    accent: {
      label: 'Vurgu rengi (düğme, başlık, seçim)',
      list: [['#4296f9', 'Mavi (varsayılan)'], ['#53fc18', 'Kick yeşili'], ['#a970ff', 'Mor'], ['#ff4d5e', 'Kırmızı'],
        ['#ff9f2e', 'Turuncu'], ['#ffd23f', 'Sarı'], ['#ff6fb5', 'Pembe'], ['#2ed3c6', 'Turkuaz'], ['#aab2bf', 'Gri']]
    },
    bg: {
      label: 'Zemin rengi',
      list: [['#0f0f0f', 'Siyah (varsayılan)'], ['#000000', 'Saf siyah'], ['#1b1d21', 'Antrasit'], ['#0b1220', 'Lacivert'],
        ['#150f1f', 'Mor tonu'], ['#0d1a12', 'Yeşil tonu'], ['#1c0f12', 'Bordo']]
    },
    text: {
      label: 'Yazı rengi',
      list: [['#ffffff', 'Beyaz (varsayılan)'], ['#d6dae1', 'Gri'], ['#f3e9d2', 'Krem'], ['#bfe3ff', 'Buz mavisi']]
    },
    hud: {
      label: 'Level / Ödül yazıları (Alındı, süre, %) — menü renginden bağımsız',
      list: [['', 'Otomatik (durum rengi)'], ['#ffffff', 'Beyaz'], ['#53fc18', 'Kick yeşili'], ['#ffd23f', 'Sarı'], ['#4296f9', 'Mavi'],
        ['#a970ff', 'Mor'], ['#ff4d5e', 'Kırmızı'], ['#ff9f2e', 'Turuncu'], ['#ff6fb5', 'Pembe'], ['#2ed3c6', 'Turkuaz'], ['#aab2bf', 'Gri']]
    }
  };
  KC.COLOR_DEFAULTS = { col_accent: DEF.accent, col_bg: DEF.bg, col_text: DEF.text, col_hud: DEF.hud };

  const isHex = (v) => typeof v === 'string' && /^#[0-9a-f]{6}$/i.test(v);
  const okVal = (k, v) => isHex(v) || (k === 'hud' && v === ''); // hud: '' = otomatik
  const pre = {}; // kaydedilmemiş canlı önizleme (renk seçici sürüklenirken)
  const cur = (k) => {
    if (isHex(pre[k])) return pre[k].toLowerCase();
    const v = KC.settings && KC.settings[KEYS[k]];
    return isHex(v) ? v.toLowerCase() : DEF[k];
  };

  /* ── renk matematiği ── */
  const clamp = (x, a, b) => Math.max(a, Math.min(b, x));
  const hex2rgb = (h) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16));
  function rgb2hsl(r, g, b) {
    r /= 255; g /= 255; b /= 255;
    const mx = Math.max(r, g, b), mn = Math.min(r, g, b), d = mx - mn, l = (mx + mn) / 2;
    let h = 0, s = 0;
    if (d) {
      s = l > 0.5 ? d / (2 - mx - mn) : d / (mx + mn);
      if (mx === r) h = (g - b) / d + (g < b ? 6 : 0);
      else if (mx === g) h = (b - r) / d + 2;
      else h = (r - g) / d + 4;
      h *= 60;
    }
    return [h, s, l];
  }
  const hsl = (h, s, l, a) =>
    'hsl(' + Math.round(h) + ' ' + Math.round(clamp(s, 0, 1) * 100) + '% ' + Math.round(clamp(l, 0, 1) * 100) + '% / ' + (a == null ? 1 : a) + ')';

  function accentVars(hex) {
    const [h, s0, l0] = rgb2hsl.apply(null, hex2rgb(hex));
    const s = s0, L = clamp(l0, 0.5, 0.72), Lb = Math.min(L, 0.58); // Lb: düğme/başlık dolguları (beyaz yazı okunsun)
    const ds = clamp(s * 0.53, 0, 0.6); // koyu tonlar (başlık, sekme, kutu zemini)
    const A = (al) => hsl(h, s, L, al);
    const AB = (al) => hsl(h, s, Lb, al);
    const D = (l, al) => hsl(h, ds, l, al);
    return {
      '--im-accent': A(1), '--im-check': A(1), '--im-ok': A(1), '--im-nav-hl': A(1),
      '--im-slider-grab': hsl(h, s * 0.9, Math.max(0.4, L - 0.04), 1), '--im-slider-grab-act': A(1),
      '--im-btn': AB(0.4), '--im-btn-hov': AB(1), '--im-btn-act': hsl(h, Math.min(1, s * 1.05), Math.max(0.35, Lb - 0.07), 1),
      '--im-accent-hv': AB(1), '--im-accent-ac': hsl(h, Math.min(1, s * 1.05), Math.max(0.35, Lb - 0.07), 1),
      '--im-frame-bg': D(0.32, 0.54), '--im-frame': D(0.32, 0.54), '--im-frame-hov': A(0.4), '--im-border-hov': A(0.4), '--im-frame-act': A(0.67),
      '--im-title-act': D(0.32, 1),
      '--im-header': AB(0.31), '--im-header-hov': AB(0.8), '--im-header-act': AB(1),
      '--im-tab': D(0.38, 0.86), '--im-tab-hov': AB(0.8), '--im-tab-act': D(0.44, 1),
      '--im-tab-unf': D(0.11, 0.97), '--im-tab-unf-act': D(0.28, 1),
      '--im-sep-hov': hsl(h, s, Math.max(0.3, L - 0.18), 0.78), '--im-sep-act': hsl(h, s, Math.max(0.3, L - 0.18), 1),
      '--im-resize': A(0.2), '--im-resize-hov': A(0.67), '--im-resize-act': A(0.95),
      '--im-text-sel-bg': A(0.35)
    };
  }
  function bgVars(hex) {
    const [r, g, b] = hex2rgb(hex), [h, s, l] = rgb2hsl(r, g, b);
    const solid = 'rgb(' + r + ' ' + g + ' ' + b + ')', pop = 'rgb(' + r + ' ' + g + ' ' + b + ' / 0.94)';
    const bar = hsl(h, s, clamp(l + 0.08, 0, 0.5), 1), ttl = hsl(h, s, l * 0.7, 1);
    return {
      '--im-popup-bg': pop, '--im-window-bg': pop, '--im-bg': pop, '--im-bg-pop': pop,
      '--im-menubar-bg': bar, '--im-menubar': bar, '--im-title-bg': ttl, '--im-title': ttl,
      '--kc-win-bg': solid // opacity.js: pencere zemin rengi (saydamlık yüzdesi buna uygulanır)
    };
  }
  function textVars(hex) {
    const [r, g, b] = hex2rgb(hex);
    return { '--im-text': hex, '--im-text-dis': 'rgb(' + r + ' ' + g + ' ' + b + ' / 0.5)' };
  }

  let styleEl = null;
  function apply() {
    const v = {};
    if (cur('accent') !== DEF.accent) Object.assign(v, accentVars(cur('accent')));
    if (cur('bg') !== DEF.bg) Object.assign(v, bgVars(cur('bg')));
    if (cur('text') !== DEF.text) Object.assign(v, textVars(cur('text')));
    if (cur('hud') !== DEF.hud) v['--kc-hud-text'] = cur('hud'); // daily-ring, level-hud, dashboard, daily-hud, level kartı kullanır
    const keys = Object.keys(v);
    if (!keys.length) { if (styleEl) { styleEl.remove(); styleEl = null; } return; }
    if (!styleEl) {
      styleEl = document.createElement('style');
      styleEl.id = 'kc-color-style';
    }
    // !important: body[data-kc-theme] üzerindeki sabit değişkenlerin önüne geçsin
    styleEl.textContent = 'html:root, html:root body, body[data-kc-theme]{' + keys.map((k) => k + ':' + v[k] + ' !important').join(';') + '}';
    if (!styleEl.isConnected) document.documentElement.appendChild(styleEl);
  }
  KC.applyMenuColors = apply;

  KC.setMenuColor = (k, hex, save) => {
    if (!KEYS[k] || !okVal(k, hex)) return;
    hex = hex.toLowerCase();
    if (save) { delete pre[k]; KC.saveSetting(KEYS[k], hex); } else pre[k] = hex;
    apply();
  };
  KC.resetMenuColors = () => {
    Object.keys(KEYS).forEach((k) => { delete pre[k]; KC.saveSetting(KEYS[k], DEF[k]); });
    apply();
  };

  /* ── Menü arayüzü (menu.js bunları çağırır) ── */
  KC.colorPaneHTML = () =>
    '<div class="dim">Renge tıkla → hemen uygulanır. Sağdaki kutudan istediğin rengi seç.</div>' +
    Object.keys(SETS).map((k) =>
      '<div class="m-colrow" data-col="' + k + '"><div class="m-colhd">' + SETS[k].label + '</div><div class="m-sws">' +
      SETS[k].list.map((c) => '<button type="button" class="m-sw" data-v="' + c[0] + '" title="' + c[1] + '" style="background:' + (c[0] || 'linear-gradient(135deg,#53df91 50%,#e5b200 50%)') + '"></button>').join('') +
      '<input type="color" class="m-colpick" value="' + (cur(k) || '#ffffff') + '" title="Özel renk"></div></div>'
    ).join('') +
    '<div class="m-row"><button type="button" class="m-btn" id="m-col-reset">Renkleri sıfırla</button></div>';

  KC.colorPaneBind = (root) => {
    const rows = Array.from(root.querySelectorAll('.m-colrow'));
    const paint = () => rows.forEach((row) => {
      const k = row.dataset.col, c = cur(k);
      row.querySelectorAll('.m-sw').forEach((b) => b.classList.toggle('on', b.dataset.v === c));
      const p = row.querySelector('.m-colpick'), pv = c || '#ffffff'; if (p && p.value !== pv) p.value = pv;
    });
    rows.forEach((row) => {
      const k = row.dataset.col;
      row.addEventListener('click', (e) => {
        const b = e.target.closest('.m-sw'); if (!b) return;
        KC.setMenuColor(k, b.dataset.v, true); paint();
      });
      const p = row.querySelector('.m-colpick');
      p.addEventListener('input', () => { KC.setMenuColor(k, p.value, false); row.querySelectorAll('.m-sw').forEach((b) => b.classList.remove('on')); });
      p.addEventListener('change', () => { KC.setMenuColor(k, p.value, true); paint(); });
    });
    const rs = root.querySelector('#m-col-reset');
    if (rs) rs.onclick = () => { KC.resetMenuColors(); paint(); };
    Object.keys(KEYS).forEach((k) => KC.on('setting:' + KEYS[k], () => { delete pre[k]; apply(); paint(); }));
    paint();
  };

  KC.settingsReady.then(apply);
})();
