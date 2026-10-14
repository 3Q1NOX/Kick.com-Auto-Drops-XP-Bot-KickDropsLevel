(function () {
  const KC = (window.KickControl = window.KickControl || {});

  // ── Minimal, strict TOML parser for the ImThemes format ──
  // Handles: [[themes]] array-of-tables, [themes.style], [themes.style.colors],
  // key = "string", key = number, key = [a, b], key = true/false.
  function parseToml(text) {
    const out = { themes: [] };
    let ctx = out;          // current section object
    let curTheme = null;
    const lines = String(text || '').split(/\r?\n/);
    for (let ln of lines) {
      ln = ln.trim();
      if (!ln || ln.startsWith('#')) continue;
      // section headers
      let m;
      if ((m = ln.match(/^\[\[(\S+)\]\]$/))) {
        // array-of-tables
        const path = m[1].split('.');
        if (path.length === 1 && path[0] === 'themes') {
          curTheme = {};
          out.themes.push(curTheme);
          ctx = curTheme;
        } else {
          throw new Error('Bilinmeyen tablo: ' + ln);
        }
        continue;
      }
      if ((m = ln.match(/^\[(\S+)\]$/))) {
        const path = m[1].split('.');
        // resolve relative to root (out) — [themes.style], [themes.style.colors]
        if (path[0] === 'themes' && curTheme) {
          if (path.length === 2) {
            curTheme[path[1]] = curTheme[path[1]] || {};
            ctx = curTheme[path[1]];
          } else if (path.length === 3) {
            curTheme[path[1]] = curTheme[path[1]] || {};
            curTheme[path[1]][path[2]] = curTheme[path[1]][path[2]] || {};
            ctx = curTheme[path[1]][path[2]];
          } else throw new Error('Bilinmeyen bölüm: ' + ln);
        } else if (path.length === 1) {
          // [section]
          out[path[0]] = out[path[0]] || {};
          ctx = out[path[0]];
        } else throw new Error('Bilinmeyen bölüm: ' + ln);
        continue;
      }
      // key = value
      m = ln.match(/^([A-Za-z0-9_]+)\s*=\s*(.+)$/);
      if (!m) throw new Error('Satır çözümlenemedi: ' + ln);
      const key = m[1];
      const raw = m[2].trim();
      // strip inline comments (only if not inside quotes)
      let val;
      if (raw.startsWith('"')) {
        const endq = raw.indexOf('"', 1);
        if (endq === -1) throw new Error('Eksik tırnak: ' + ln);
        val = raw.slice(1, endq);
      } else if (raw.startsWith("'")) {
        const endq = raw.indexOf("'", 1);
        if (endq === -1) throw new Error('Eksik tırnak: ' + ln);
        val = raw.slice(1, endq);
      } else {
        // remove trailing comment
        let clean = raw;
        const hi = clean.indexOf('#');
        if (hi !== -1) clean = clean.slice(0, hi).trim();
        if (clean === 'true' || clean === 'false') val = clean === 'true';
        else if (clean.startsWith('[')) {
          // array (numbers or strings)
          if (!clean.endsWith(']')) throw new Error('Eksik dizi: ' + ln);
          const inner = clean.slice(1, -1).trim();
          if (!inner) { val = []; }
          else {
            val = inner.split(',').map((x) => {
              const s = x.trim();
              if (s.startsWith('"') && s.endsWith('"')) return s.slice(1, -1);
              if (s.startsWith("'") && s.endsWith("'")) return s.slice(1, -1);
              const n = parseFloat(s);
              if (!isFinite(n)) throw new Error('Geçersiz dizi: ' + ln);
              return n;
            });
          }
        } else {
          const n = parseFloat(clean);
          if (!isFinite(n)) throw new Error('Geçersiz sayı: ' + clean);
          val = n;
        }
      }
      ctx[key] = val;
    }
    return out;
  }

  // ── Color validators ──
  function parseRgba(s) {
    if (typeof s !== 'string') return null;
    const m = s.match(/^rgba?\(\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)\s*(?:,\s*([\d.]+)\s*)?\)$/i);
    if (!m) return null;
    let r = parseFloat(m[1]), g = parseFloat(m[2]), b = parseFloat(m[3]);
    let a = m[4] !== undefined ? parseFloat(m[4]) : 1;
    if ([r,g,b,a].some(x => !isFinite(x))) return null;
    // ImThemes values are already 0-255; if all channels <= 1 and alpha <= 1,
    // assume normalized 0-1 and scale to 0-255 (ImStyle-style JSON).
    if (r <= 1 && g <= 1 && b <= 1 && a <= 1 && (r > 0 || g > 0 || b > 0)) {
      r = Math.round(r*255); g = Math.round(g*255); b = Math.round(b*255);
    }
    if (r < 0 || r > 255 || g < 0 || g > 255 || b < 0 || b > 255) return null;
    if (a < 0 || a > 1) return null;
    return { r: Math.round(r), g: Math.round(g), b: Math.round(b), a };
  }
  function rgbaToCss(c) {
    return 'rgba(' + c.r + ', ' + c.g + ', ' + c.b + ', ' + (+c.a.toFixed(3)) + ')';
  }

  // ── StyleVars mapping: ImGui vector [x, y] → CSS padding "y x" ──
  function vecToPadding(v, fallback) {
    if (!Array.isArray(v) || v.length < 2) return fallback;
    return Math.round(v[1]) + 'px ' + Math.round(v[0]) + 'px';
  }
  function num(v, fallback) {
    return (typeof v === 'number' && isFinite(v)) ? v : fallback;
  }

  // ── Build CSS custom props from a validated theme object ──
  // theme: { name, style: { ...vars, colors: { ...StyleColors } } }
  function themeToCssVars(theme) {
    const st = (theme && theme.style) || {};
    const cols = st.colors || {};
    const vars = {};
    const setIf = (key, col) => {
      const c = parseRgba(col);
      if (c) vars[key] = rgbaToCss(c);
    };
    // colors
    setIf('--im-text', cols.Text);
    setIf('--im-text-dis', cols.TextDisabled);
    setIf('--im-window-bg', cols.WindowBg);
    setIf('--im-child-bg', cols.ChildBg);
    setIf('--im-popup-bg', cols.PopupBg);
    setIf('--im-border', cols.Border);
    setIf('--im-border-shadow', cols.BorderShadow);
    setIf('--im-frame-bg', cols.FrameBg);
    setIf('--im-frame-hov', cols.FrameBgHovered);
    setIf('--im-frame-act', cols.FrameBgActive);
    setIf('--im-title-bg', cols.TitleBg);
    setIf('--im-title-act', cols.TitleBgActive);
    setIf('--im-title-coll', cols.TitleBgCollapsed);
    setIf('--im-menubar-bg', cols.MenuBarBg);
    setIf('--im-scroll-bg', cols.ScrollbarBg);
    setIf('--im-scroll-grab', cols.ScrollbarGrab);
    setIf('--im-scroll-grab-hov', cols.ScrollbarGrabHovered);
    setIf('--im-scroll-grab-act', cols.ScrollbarGrabActive);
    setIf('--im-check', cols.CheckMark);
    setIf('--im-slider-grab', cols.SliderGrab);
    setIf('--im-slider-grab-act', cols.SliderGrabActive);
    setIf('--im-btn', cols.Button);
    setIf('--im-btn-hov', cols.ButtonHovered);
    setIf('--im-btn-act', cols.ButtonActive);
    setIf('--im-header', cols.Header);
    setIf('--im-header-hov', cols.HeaderHovered);
    setIf('--im-header-act', cols.HeaderActive);
    setIf('--im-sep', cols.Separator);
    setIf('--im-sep-hov', cols.SeparatorHovered);
    setIf('--im-sep-act', cols.SeparatorActive);
    setIf('--im-tab', cols.Tab);
    setIf('--im-tab-hov', cols.TabHovered);
    setIf('--im-tab-act', cols.TabActive);
    setIf('--im-tab-unf', cols.TabUnfocused);
    setIf('--im-tab-unf-act', cols.TabUnfocusedActive);
    setIf('--im-text-sel-bg', cols.TextSelectedBg);
    setIf('--im-nav-hl', cols.NavHighlight);
    setIf('--im-modal-dim', cols.ModalWindowDimBg);
    setIf('--im-table-header', cols.TableHeaderBg);
    setIf('--im-table-border-st', cols.TableBorderStrong);
    setIf('--im-table-border-lt', cols.TableBorderLight);

    // style vars
    vars['--im-radius'] = num(st.windowRounding, 0) + 'px';
    vars['--im-frame-radius'] = num(st.frameRounding, 0) + 'px';
    vars['--im-tab-radius'] = num(st.tabRounding, 0) + 'px';
    vars['--im-child-radius'] = num(st.childRounding, 0) + 'px';
    vars['--im-popup-radius'] = num(st.popupRounding, 0) + 'px';
    if (Array.isArray(st.windowPadding)) vars['--im-window-padding'] = vecToPadding(st.windowPadding);
    if (Array.isArray(st.framePadding)) vars['--im-frame-padding'] = vecToPadding(st.framePadding);
    if (Array.isArray(st.itemSpacing)) {
      vars['--im-item-spacing-x'] = num(st.itemSpacing[0], 8) + 'px';
      vars['--im-item-spacing-y'] = num(st.itemSpacing[1], 4) + 'px';
    }
    // aliases
    if (vars['--im-check']) vars['--im-accent'] = vars['--im-check'];
    if (vars['--im-frame-hov']) vars['--im-border-hov'] = vars['--im-frame-hov'];
    if (vars['--im-scroll-grab']) vars['--im-grab'] = vars['--im-scroll-grab'];
    if (vars['--im-btn-hov']) vars['--im-accent-hv'] = vars['--im-btn-hov'];
    if (vars['--im-btn-act']) vars['--im-accent-ac'] = vars['--im-btn-act'];
    return vars;
  }

  // ── Validate a theme object from parsed TOML/JSON ──
  function validateTheme(t) {
    if (!t || typeof t !== 'object') throw new Error('Geçersiz tema verisi');
    const st = t.style || t;
    const cols = st.colors || st.StyleColors || {};
    if (!cols.WindowBg) throw new Error('WindowBg rengi bulunamadı');
    const parsed = parseRgba(cols.WindowBg);
    if (!parsed) throw new Error('WindowBg rengi okunamadı: ' + cols.WindowBg);
    return { name: t.name || t.Name || 'Özel tema', style: st };
  }

  // ── Extract themes from either format ──
  function extractThemes(parsed) {
    const out = [];
    if (parsed && Array.isArray(parsed.themes)) {
      for (const t of parsed.themes) {
        try { out.push(validateTheme(t)); } catch (_) {}
      }
    }
    if (out.length === 0 && parsed && typeof parsed === 'object') {
      // try single theme
      try { out.push(validateTheme(parsed)); } catch (e) { throw e; }
    }
    return out;
  }

  // ── Apply theme: inject <style> with CSS vars ──
  function applyUserTheme(theme) {
    let style = document.getElementById('kc-user-theme');
    if (!style) {
      style = document.createElement('style');
      style.id = 'kc-user-theme';
      document.head.appendChild(style);
    }
    const vars = themeToCssVars(theme);
    const lines = [];
    for (const [k, v] of Object.entries(vars)) lines.push('  ' + k + ': ' + v + ';');
    style.textContent = ':root, html, body, [data-kc-theme], #kc-dl-float, #kc-dl-float[data-theme], [data-theme] {\n' + lines.join('\n') + '\n}';
  }

  function clearUserTheme() {
    const style = document.getElementById('kc-user-theme');
    if (style) style.remove();
  }

  // ── Exported API ──
  KC.parseToml = parseToml;
  KC.themeToCssVars = themeToCssVars;
  KC.validateTheme = validateTheme;
  KC.extractThemes = extractThemes;
  KC.applyUserTheme = applyUserTheme;
  KC.clearUserTheme = clearUserTheme;
})();
