(function () {
  /* Dashboard — "Yayın durumu" kutusuyla aynı sade görünüm: başlık, durum satırı, etiket/değer satırları. */
  const KC = (window.KickControl = window.KickControl || {});
  const ID = 'kc-dash';
  const POS = 'pos_dash';

  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const num = (v) => Math.max(0, Number(v) || 0).toLocaleString('tr-TR');
  const safe = (fn, d) => { try { const v = fn(); return v == null ? d : v; } catch (_) { return d; } };
  const cls = (c) => (c === 'ok' || c === 'warn' || c === 'bad' ? c : '');
  const line = (k, v, c) => '<div class="kc-d-line"><span>' + esc(k) + '</span><b class="' + cls(c) + '" title="' + esc(v) + '">' + esc(v) + '</b></div>';

  /* Drop ilerlemesi: seçili, tamamlanmamış kampanyalar — kampanya % + alınmamış her ödülün % */
  const bar = (pct, txt) => '<div class="kc-d-mini"><div class="kc-d-minifill" style="width:' + Math.max(0, Math.min(100, pct || 0)) + '%"></div></div>';
  function dropsHtml(D) {
    if (!D || !D.campaigns) return '';
    let list = D.campaigns.filter((c) => c.selected && !c.done);
    if (!list.length) return '';
    const out = ['<div class="kc-d-sec">Drop ilerlemesi</div>'];
    list.slice(0, 3).forEach((c) => {
      const op = c.overall == null ? null : c.overall;
      out.push('<div class="kc-d-camp"><div class="kc-d-crow"><span class="kc-d-cname" title="' + esc(c.name) + '">' + esc(c.name) + '</span><b>' + (op == null ? '—' : op + '%') + '</b></div>' + bar(op) + '</div>');
      const todo = (c.rewards || []).filter((r) => !r.claimed);
      const doneN = (c.rewards || []).length - todo.length;
      todo.slice(0, 4).forEach((r) => {
        const p = r.pct == null ? (r.need > 0 ? 0 : null) : r.pct;
        out.push('<div class="kc-d-rew"><div class="kc-d-crow"><span class="kc-d-rname" title="' + esc(r.name) + '">' + esc(r.name) + '</span><b>' + (p == null ? '—' : p + '%') + '</b></div>' + bar(p) + '</div>');
      });
      if (todo.length > 4) out.push('<div class="kc-d-more">+' + (todo.length - 4) + ' ödül daha</div>');
      if (doneN > 0) out.push('<div class="kc-d-more">' + doneN + '/' + (c.rewards || []).length + ' ödül alındı</div>');
    });
    if (list.length > 3) out.push('<div class="kc-d-more">+' + (list.length - 3) + ' kampanya daha</div>');
    return '<div class="kc-d-details kc-d-drops">' + out.join('') + '</div>';
  }


  /* v1.3.90: arka plan (sayfa açmadan) alma durumu — background.js 'kc_bg' anahtarına yazar */
  let BG = null;
  try {
    chrome.storage.local.get('kc_bg', (o) => { BG = (o && o.kc_bg) || null; });
    chrome.storage.onChanged.addListener((ch, area) => { if (area === 'local' && ch.kc_bg) BG = ch.kc_bg.newValue || null; });
  } catch (_) {}
  const pad2 = (n) => String(n).padStart(2, '0');
  const hm = (t) => { const d = new Date(t); return pad2(d.getHours()) + ':' + pad2(d.getMinutes()); };
  function durTxt(ms) {
    const s = Math.max(0, Math.round(ms / 1000)), h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60);
    return h ? h + ' sa ' + m + ' dk' : m ? m + ' dk' : s + ' sn';
  }
  function dailyHtml() {
    const D = safe(() => KC.getDailyRewardDetail && KC.getDailyRewardDetail(), null);
    if (!D || !D.enabled) return '';
    const now = Date.now();
    const claimed = D.phase === 'claimed' || (D.claimedUntil && now < D.claimedUntil);
    let pct = null, txt = '';
    if (claimed) { pct = 100; txt = 'Alındı'; }
    else if (D.threshold > 0 && D.progress != null) {
      pct = Math.max(0, Math.min(100, Math.round((D.progress / D.threshold) * 100)));
      txt = D.progress + ' / ' + D.threshold + ' dk · %' + pct;
    }
    const out = ['<div class="kc-d-sec">Günlük ödül</div>'];
    if (pct != null) out.push('<div class="kc-d-bar"><div class="kc-d-fill" style="width:' + pct + '%"></div><span>' + esc(txt) + '</span></div>');
    const st = D.phase === 'claiming' ? ['Alınıyor…', 'warn'] : D.phase === 'error' ? ['Hata — tekrar denenecek', 'bad'] :
      D.phase === 'nologin' ? ['Giriş yapılmamış', 'bad'] : D.phase === 'none' ? ['Bulunamadı', 'warn'] :
      claimed ? ['Bugünkü ödül alındı', 'ok'] : D.phase === 'progress' ? ['İzleme süresi bekleniyor', ''] : ['Kontrol ediliyor…', ''];
    out.push(line('Durum', st[0], st[1]));
    if (!claimed && D.phase === 'progress' && D.remainingMin != null) out.push(line('Kalan izleme', '~' + D.remainingMin + ' dk'));
    const reset = claimed ? D.claimedUntil : D.endsAt;
    if (reset && reset > now) out.push(line('Sıfırlanma', hm(reset) + ' · ' + durTxt(reset - now)));
    if (D.reward) out.push(line('Çıkan', D.reward + (D.rarity ? ' (' + D.rarity + ')' : ''), 'ok'));
    out.push('<div class="kc-d-btns"><button type="button" data-dact="dailytest" title="Kick düğmesindeki kare çerçevede % ilerlemesini örnek olarak oynatır">İlerleme testi</button></div>');
    return '<div class="kc-d-details kc-d-daily">' + out.join('') + '</div>';
  }
  function bgHtml() {
    if (!BG) return '';
    const out = [];
    const d = BG.drops || {}, dl = BG.daily || {};
    if (d.total) out.push(line('Drop (arka plan)', d.total + ' alındı' + (d.lastMsg ? ' · ' + d.lastMsg : ''), 'ok'));
    if (dl.lastClaimAt) out.push(line('Günlük (arka plan)', hm(dl.lastClaimAt) + (dl.reward ? ' · ' + dl.reward : ''), 'ok'));
    if (BG.err) out.push(line('Arka plan', BG.err, 'warn'));
    if (!out.length) return '';
    return '<div class="kc-d-details kc-d-bg"><div class="kc-d-sec">Sayfa açmadan alma</div>' + out.join('') + '</div>';
  }


  /* v1.3.93: Dashboard bölümlerini gizle/göster — başlıktaki ⚙ ile seçilir, ayar: dash_hide (gizlenen bölüm kimlikleri) */
  const SECS = [['status', 'Yayın / durum satırları'], ['level', 'Level XP'], ['drops', 'Drop ilerlemesi'], ['daily', 'Günlük ödül'], ['bg', 'Sayfa açmadan alma'], ['err', 'Hata günlüğü'], ['keys', 'Kısayollar'], ['btns', 'Düğmeler (Düzelt/Sonraki/Claim)']];
  let cfgOpen = false;
  const hiddenSecs = () => { const a = KC.settings && KC.settings.dash_hide; return Array.isArray(a) ? a : []; };
  const showSec = (k) => hiddenSecs().indexOf(k) === -1;
  function cfgHtml() {
    if (!cfgOpen) return '';
    return '<div class="kc-d-details kc-d-cfg"><div class="kc-d-sec">Dashboard\'da göster</div>' +
      SECS.map((x) => '<div class="kc-d-cfgrow' + (showSec(x[0]) ? ' on' : '') + '" data-dsec="' + x[0] + '"><i>' + (showSec(x[0]) ? '☑' : '☐') + '</i><span>' + esc(x[1]) + '</span></div>').join('') + '</div>';
  }

  /** Önemli hatalar: son 30 dk error + warn (stall donma ≥15s dahil) */
  function errSummary() {
    const list = safe(() => (KC.errlog && KC.errlog.list && KC.errlog.list()) || [], []);
    const since = Date.now() - 30 * 60 * 1000;
    const important = list.filter((e) => {
      if (!e || !e.t || e.t < since) return false;
      if (e.lvl === 'error') return true;
      if (e.lvl === 'warn') return true;
      // info ama kritik stall / internet
      const m = String(e.msg || '');
      if (/INTERNET_YOK|donma izleme ≥(15|25)|stage3|stage4|KOPTU/i.test(m)) return true;
      return false;
    });
    // en yeni önce
    important.sort((a, b) => b.t - a.t);
    return important;
  }

  function errHtml() {
    const errs = errSummary();
    if (!errs.length) {
      return (
        '<div class="kc-d-details kc-d-err">' +
        '<div class="kc-d-sec">Hata günlüğü</div>' +
        line('Durum', 'Sorun yok', 'ok') +
        '</div>'
      );
    }
    const nErr = errs.filter((e) => e.lvl === 'error').length;
    const nWarn = errs.length - nErr;
    const label =
      (nErr ? nErr + ' hata' : '') +
      (nErr && nWarn ? ' · ' : '') +
      (nWarn ? nWarn + ' uyarı' : '');
    const out = [
      '<div class="kc-d-details kc-d-err">',
      '<div class="kc-d-sec">Hata günlüğü</div>',
      '<div class="kc-d-line"><span>Durum</span><b class="bad kc-d-err-flag">Hata var · ' + esc(label) + '</b></div>'
    ];
    errs.slice(0, 4).forEach((e) => {
      const c = e.lvl === 'error' ? 'bad' : 'warn';
      const src = e.src ? e.src + ': ' : '';
      const msg = (src + (e.msg || '')).slice(0, 80);
      out.push(
        '<div class="kc-d-eline ' + c + '" title="' + esc(e.msg || '') + '">' +
        '<span class="kc-d-elvl">' + esc((e.lvl || '').toUpperCase()) + '</span>' +
        '<span class="kc-d-emsg">' + esc(msg) + (e.n > 1 ? ' ×' + e.n : '') + '</span></div>'
      );
    });
    if (errs.length > 4) out.push('<div class="kc-d-more">+' + (errs.length - 4) + ' daha</div>');
    out.push('<div class="kc-d-btns kc-d-err-btns"><button type="button" data-dact="errlog">Günlüğü aç</button></div>');
    out.push('</div>');
    return out.join('');
  }

  function html() {
    const L = safe(() => KC.getLevelXpDetail && KC.getLevelXpDetail(), null);
    const D = safe(() => KC.getDropsSnapshot && KC.getDropsSnapshot(), null);
    const S = safe(() => KC.getStreamStatusSnapshot && KC.getStreamStatusSnapshot(), null);
    const B = safe(() => KC.getLevelHudSnapshot && KC.getLevelHudSnapshot(), null);
    const slug = (S && S.channel) || (B && B.slug) || '';
    const errs = errSummary();
    let dot = cls((S && S.statusClass) || (B && B.healthClass)) || 'warn';
    // Önemli hata varsa başlık noktası kırmızı
    if (errs.some((e) => e.lvl === 'error')) dot = 'bad';
    else if (errs.length && dot === 'ok') dot = 'warn';
    const statusTxt = errs.some((e) => e.lvl === 'error')
      ? 'Hata var'
      : ((S && S.status) || (B && B.nowDoing) || '—');
    const head = '<div class="kc-d-row"><span class="kc-d-dot ' + dot + '"></span><b class="' + (errs.some((e) => e.lvl === 'error') ? 'bad' : '') + '">' + esc(statusTxt) + '</b></div>';

    // v1.3.103: Yayın durumu satırları (Kanal/Tampon/Çözünürlük/FPS/Oynatma) kutu açık olsa da Dashboard'da her zaman görünür
    const nz = (x) => String(x == null ? '' : x).toLowerCase().replace(/\s+/g, ' ').trim();
    const strip = (txt, t) => (t ? txt.split(t).join('') : txt);
    const rows = [];
    if (slug) rows.push(line('Kanal', slug));
    if (B && B.nowDoing) {
      // "Akıyor · kanal" zaten başlık + kanal satırında var → sadece yeni bilgi içeriyorsa göster
      const rest = strip(strip(nz(B.nowDoing), nz(slug)), nz(statusTxt)).replace(/[·→:\-\s]+/g, '');
      if (rest) rows.push(line('Etkinlik', B.nowDoing));
    }
    if (S) {
      rows.push(line('Tampon', (S.buffer || '—') + (S.bufferSec ? ' (' + S.bufferSec + ')' : '')));
      if (S.res && S.res !== '—') rows.push(line('Çözünürlük', S.res));
      const fi = KC.fpsInfo;
      if (fi && S.play && !/^Duraklat|^Bitti/.test(S.play)) rows.push(line('FPS', fi.fps + ' · atılan ' + fi.dropped));
      if (S.play && /^Duraklat|^Bitti|sessiz/.test(S.play)) rows.push(line('Oynatma', S.play, 'warn'));
    }
    rows.push(line('Drops', safe(() => KC.getDropsStatus(), '—')));
    if (D && D.enabled && !D.controlling && D.reason && D.reason !== 'no-slug') rows.push(line('Neden', D.reason, 'warn'));
    if (D) rows.push(line('Kampanya', D.selectedCount + ' seçili · ' + D.claimedThisSession + ' alındı'));
    let botTxt = String(safe(() => KC.getBotStatus(), '—'));
    if (slug) botTxt = botTxt.replace(new RegExp('\\s*[:·\\-]\\s*' + slug.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\s*$', 'i'), '');
    rows.push(line('Level bot', botTxt));
    if (B) {
      // oturum süresi ile izlenen süre neredeyse aynıysa tek değer yaz
      const same = typeof B.sessionSec === 'number' && typeof B.watchSec === 'number'
        ? Math.abs(B.sessionSec - B.watchSec) < 8
        : (B.session === B.watch);
      rows.push(line('Süre', same ? (B.watch || B.session || '—') : (B.session || '—') + ' · izlenen ' + (B.watch || '—')));
    }

    let level = '';
    if (L && L.hasData) {
      const pct = Math.max(0, Math.min(100, Math.round(L.percent * 10) / 10));
      level = '<div class="kc-d-bar"><div class="kc-d-fill" style="width:' + pct + '%"></div><span>Level ' + esc(L.level) + ' · ' + pct + '%</span></div>' +
        line('Saatlik', L.xpPerHour > 0 ? num(Math.round(L.xpPerHour)) + ' XP/sa' : 'Ölçülüyor') +
        line('Tahmini', L.eta || '—') + line('Oturum', '+' + num(L.sessionGained) + ' XP');
    } else {
      level = line('Level', L && L.error ? 'Alınamadı' : 'Bekleniyor…');
    }
    if (S) {
      const nx = String(S.next || '').trim();
      if (nx && !/^(izleniyor|—|-)$/i.test(nx) && nz(nx) !== nz(statusTxt)) rows.push(line('Sıradaki', nx));
      if (S.last && S.last !== '—') rows.push(line('Son işlem', S.last));
    }

    return head + cfgHtml() +
      (showSec('status') ? '<div class="kc-d-details">' + rows.join('') + '</div>' : '') +
      (showSec('level') ? '<div class="kc-d-details kc-d-lvl">' + level + '</div>' : '') +
      (showSec('drops') ? dropsHtml(D) : '') +
      (showSec('daily') ? dailyHtml() : '') +
      (showSec('bg') ? bgHtml() : '') +
      (showSec('err') ? errHtml() : '') +
      (showSec('btns') ? '<div class="kc-d-btns"><button type="button" data-dact="fix">Düzelt</button><button type="button" data-dact="next">Sonraki</button><button type="button" data-dact="claim">Claim</button></div>' : '');
  }

  let timer = 0, last = '';
  const get = () => document.getElementById(ID);
  function render() {
    const el = get(); if (!el) return;
    let h; try { h = html(); } catch (e) { h = '<div class="kc-d-row"><b>Görüntülenemedi</b></div>'; }
    if (h === last) return;
    last = h; el.querySelector('.kc-d-body').innerHTML = h;
    const kb = el.querySelector('.kc-d-keys'); if (kb) kb.style.display = showSec('keys') ? '' : 'none';
  }

  /* Kısayollar bölümü — Kısayol listesi (HUD) görünümü: sadece atanmış olanlar, açık olan yeşil, basılınca yanıp söner.
     "Düzenle" ile aynı yerden atama yapılır (tıkla → tuşa bas, çift tık → sil). */
  const PRETTY = { ArrowUp: '↑', ArrowDown: '↓', ArrowLeft: '←', ArrowRight: '→', Escape: 'Esc', Delete: 'Del', Backspace: '⌫', PageUp: 'PgUp', PageDown: 'PgDn' };
  const caps = (combo) => {
    const parts = combo.endsWith('++') ? combo.slice(0, -2).split('+').concat('+') : combo.split('+');
    return parts.map((p) => '<kbd>' + esc(PRETTY[p] || p) + '</kbd>').join('<i class="kc-k-plus">+</i>');
  };
  const STATE = {
    drops_enabled: 'drops_enabled', level_bot: 'level_bot', level_xp_hud: 'level_xp_hud',
    anti_stuck: 'anti_stuck', stall_guard: 'stall_guard', kick_adblock: 'kick_adblock',
    click_to_pause: 'click_to_pause', fps_boost: 'fps_boost', dash: 'dash_open', keys_overlay: 'keys_overlay_open'
  };
  const ON_BY_DEFAULT = ['anti_stuck', 'stall_guard', 'kick_adblock'];
  const isOn = (k) => {
    if (k === 'menu') return KC.settings.ui_collapsed === false;
    const sk = STATE[k]; if (!sk) return false;
    const v = KC.settings[sk];
    return ON_BY_DEFAULT.indexOf(sk) !== -1 ? v !== false : v === true;
  };
  const WATCH = Object.keys(STATE).map((k) => STATE[k]).concat('ui_collapsed');
  const hits = {};

  function renderKeys() {
    const el = get(); if (!el) return;
    const box = el.querySelector('.kc-d-keys'); if (!box) return;
    // Liste her zaman açık — aç/kapa yok; sadece atanmış kısayollar
    const edit = !!KC.settings.dash_keys_edit;
    box.classList.add('open');
    box.classList.toggle('edit', edit);
    const ed = box.querySelector('[data-dedit]'); if (ed) ed.textContent = edit ? 'Bitti' : 'Düzenle';
    const list = box.querySelector('.kc-d-kl');
    const binds = KC.settings.keybinds || {}, lis = KC.bindListening ? KC.bindListening() : null;
    const all = KC.BINDS || [];
    if (edit) {
      list.innerHTML = '<div class="kc-d-kn">Tıkla → tuşa bas · çift tık = sil</div>' + all.map((b) =>
        '<div class="kc-k-row' + (isOn(b[0]) ? ' on' : '') + '"><span class="kc-k-label">' + esc(b[1]) + '</span><button type="button" class="kc-d-key" data-bind="' + esc(b[0]) + '">' +
        esc(lis === b[0] ? '...' : (binds[b[0]] || '—')) + '</button></div>').join('');
      return;
    }
    const rows = all.filter((b) => binds[b[0]]);
    list.innerHTML = rows.length ? rows.map((b) =>
      '<div class="kc-k-row' + (isOn(b[0]) ? ' on' : '') + (hits[b[0]] > Date.now() ? ' hit' : '') + '" data-k="' + esc(b[0]) + '"><span class="kc-k-label">' + esc(b[1]) +
      '</span><span class="kc-k-keys">' + caps(binds[b[0]]) + '</span></div>').join('')
      : '<div class="kc-d-kn">Henüz kısayol atanmadı · Düzenle</div>';
  }

  window.addEventListener('keydown', (e) => {
    if (e.repeat || !KC.matchBind) return;
    const el = get(); if (!el || KC.settings.dash_keys_edit) return;
    const t = e.target, tag = t && t.tagName;
    if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || (t && t.isContentEditable)) return;
    const b = KC.settings.keybinds || {};
    for (const k of Object.keys(b)) {
      if (!b[k] || !KC.matchBind(b[k], e)) continue;
      hits[k] = Date.now() + 450;
      const row = el.querySelector('[data-k="' + k + '"]'); if (!row) continue;
      row.classList.remove('hit'); void row.offsetWidth; row.classList.add('hit');
      setTimeout(() => { const r = get() && get().querySelector('[data-k="' + k + '"]'); if (r) r.classList.remove('hit'); }, 450);
    }
  }, true);

  function doAct(a) {
    try {
      if (a === 'next') (KC.forceNextStream ? KC.forceNextStream('manual-dash') : KC.forceSwitchChannel && KC.forceSwitchChannel());
      else if (a === 'fix') (KC.fixStreamNow || (() => {}))('dashboard düğmesi');
      else if (a === 'claim') KC.claimNow && KC.claimNow();
      else if (a === 'dailytest') { if (KC.dailyRingTest && !KC.dailyRingTest()) KC.elog && KC.elog('info', 'daily', 'Test için Kick\'in Günlük Ödül düğmesi sayfada görünmeli'); }
      else if (a === 'errlog') {
        try {
          if (KC.toggleErrLog) KC.toggleErrLog();
          else KC.saveSetting('errlog_open', true);
        } catch (_) {}
      }
    } catch (e) { KCwarn('[KC]', e); }
    setTimeout(render, 150);
  }

  function open() {
    if (get()) return;
    const el = document.createElement('div');
    el.id = ID;
    el.innerHTML = '<div class="kc-d-title"><span>Dashboard</span><span class="kc-d-tr"><span class="kc-d-gear" data-dcfg title="Neler gösterilsin">⚙</span><span class="kc-d-x" data-dclose title="Kapat">×</span></span></div><div class="kc-d-body"></div><div class="kc-d-keys open"><div class="kc-d-kh"><span class="kc-d-kt">Kısayollar</span><span class="kc-d-ked" data-dedit title="Tuş atamalarını düzenle">Düzenle</span></div><div class="kc-d-kl"></div></div>';
    document.documentElement.appendChild(el);
    if (KC.applyPos) KC.applyPos(el, POS, { x: 16, y: 120 });
    if (KC.makeDraggable) KC.makeDraggable(el, el.querySelector('.kc-d-title'), POS);
    el.addEventListener('dblclick', (e) => {
      const kb = e.target.closest('.kc-d-key');
      if (kb && KC.bindClear) KC.bindClear(kb.dataset.bind);
    });
    el.addEventListener('click', (e) => {
      if (e.target.closest('[data-dclose]')) return KC.saveSetting('dash_open', false);
      if (e.target.closest('[data-dcfg]')) { cfgOpen = !cfgOpen; last = ''; return render(); }
      const sc = e.target.closest('[data-dsec]');
      if (sc) {
        const k = sc.dataset.dsec, cur = hiddenSecs().slice(), i = cur.indexOf(k);
        if (i === -1) cur.push(k); else cur.splice(i, 1);
        KC.saveSetting('dash_hide', cur);
        last = ''; return render();
      }
      if (e.target.closest('[data-dedit]')) {
        e.stopPropagation();
        return KC.saveSetting('dash_keys_edit', !KC.settings.dash_keys_edit);
      }
      const kb = e.target.closest('.kc-d-key');
      if (kb) { e.stopPropagation(); return KC.bindListen && KC.bindListen(kb.dataset.bind); }
      const b = e.target.closest('[data-dact]');
      if (b) doAct(b.dataset.dact);
    });
    last = ''; render(); renderKeys();
    timer = setInterval(render, 1000);
  }
  function close() { clearInterval(timer); timer = 0; get()?.remove(); }

  KC.toggleDash = () => KC.saveSetting('dash_open', !KC.settings.dash_open);

  /* v1.3.102: üst üste binen pencerelerde tıklanan pencere öne çıksın (menü/buton dashboard'un tıklamasını kapatmasın) */
  const WINS = '#kc-dash, #kc-menu, #kc-dl-float, #kc-errlog, #kc-stall-debug, #kc-drops-hud, #kc-lx-card, #kc-camp-picker, #kc-switch-log, #kc-keys-overlay, #kc-daily';
  let topZ = 2147483002;
  document.addEventListener('mousedown', (e) => {
    const t = e.target, w = t && t.closest && t.closest(WINS);
    if (!w) return;
    if (topZ < 2147483090) topZ++;
    w.style.setProperty('z-index', String(topZ), 'important');
  }, true);

  KC.settingsReady.then(() => {
    if (KC.settings.dash_open) open();
    KC.on('setting:dash_open', (v) => (v ? open() : close()));
    KC.on('setting:dash_hide', () => { last = ''; render(); });
    KC.on('setting:dash_keys_open', renderKeys);
    KC.on('setting:dash_keys_edit', renderKeys);
    let krq = 0;
    KC.on('settings:changed', (e) => { if (!e || WATCH.indexOf(e.key) === -1 || krq) return; krq = requestAnimationFrame(() => { krq = 0; renderKeys(); }); });
    KC.on('setting:keybinds', renderKeys);
    KC.on('binds:listen', renderKeys);
    KC.on('setting:pos_dash', () => { const el = get(); if (el && KC.applyPos) KC.applyPos(el, POS); });
  });
})();
