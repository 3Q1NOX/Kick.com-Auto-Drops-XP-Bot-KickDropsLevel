(function () {
  'use strict';
  /* Hata günlüğü — eklentinin uyarı/hatalarını kalıcı olarak saklar (chrome.storage.local › kc_errlog).
     - KCwarn(...)            console.warn yerine kullanılır: günlüğe yazar (+ konsola)
     - KC.elog(lvl, src, msg) günlüğe satır ekler (lvl: info | warn | error)
     - Pencere: Menü › Pencereler › Hata günlüğü  (kopyala / indir / temizle) */
  const KC = (window.KickControl = window.KickControl || {});
  const KEY = 'kc_errlog';
  const MAX = 300;
  const VER = (() => { try { return chrome.runtime.getManifest().version; } catch (_) { return ''; } })();
  const EXT = (() => { try { return chrome.runtime.id || ''; } catch (_) { return ''; } })();

  let mem = [];            // bu sekmede yazılanlar, henüz depolamaya akmamış olanlar
  let flushT = 0;
  let view = [];           // pencerede gösterilen (depolama + bellek)
  const lastByMsg = new Map();

  const slugNow = () => {
    try { const p = location.pathname.split('/').filter(Boolean); return p.length === 1 ? p[0] : (p[0] || '/'); } catch (_) { return ''; }
  };
  const str = (a) => {
    if (a == null) return String(a);
    if (a instanceof Error) return (a.name || 'Error') + ': ' + (a.message || '') ;
    if (typeof a === 'object') { try { return JSON.stringify(a).slice(0, 400); } catch (_) { return String(a); } }
    return String(a);
  };

  const dirty = new Set(); // sayaç/zaman güncellenen, depolamada güncellenmesi gereken kayıtlar
  const eid = (e) => e.id || e.t;
  /* Aynı sorunun tekrarları tek satır: sayılar (süre, saat, satır no, sn...) ve kanal adı anahtara girmez */
  const norm = (lvl, src, m) => lvl + '|' + src + '|' + String(m).replace(/\d+(?:[.,]\d+)?/g, '#').replace(/\s+/g, ' ').trim();

  function persist() {
    flushT = 0;
    if (!mem.length && !dirty.size) return;
    const add = mem; mem = [];
    const upd = Array.from(dirty); dirty.clear();
    try {
      chrome.storage.local.get(KEY, (d) => {
        try {
          const cur = Array.isArray(d && d[KEY]) ? d[KEY] : [];
          upd.forEach((e) => {
            const i = cur.findIndex((x) => eid(x) === eid(e));
            if (i !== -1) cur[i] = e;
            else if (add.indexOf(e) === -1) add.push(e);
          });
          const all = cur.concat(add.filter((e) => !cur.some((x) => eid(x) === eid(e)))).sort((a, b) => a.t - b.t).slice(-MAX);
          chrome.storage.local.set({ [KEY]: all });
        } catch (_) {}
      });
    } catch (_) {}
  }

  function elog(lvl, src, msg, extra) {
    try {
      const m = String(msg == null ? '' : msg).slice(0, 400);
      const key = norm(lvl, src, m);
      const now = Date.now();
      const prev = lastByMsg.get(key);
      // daha önce yazılmışsa (süre sınırı yok, sayfa yenilense de) yeni satır açma: sadece sayacı artır
      if (prev && view.indexOf(prev) !== -1) {
        prev.n = (prev.n || 1) + 1; prev.t = now;
        dirty.add(prev); scheduleRender(); schedule(); return;
      }
      const e = { id: now, t: now, lvl, src: String(src || ''), msg: m, ch: slugNow(), v: VER, n: 1 };
      if (extra) e.x = String(extra).slice(0, 600);
      lastByMsg.set(key, e);
      if (lastByMsg.size > 400) lastByMsg.delete(lastByMsg.keys().next().value);
      mem.push(e);
      view.push(e);
      if (view.length > MAX) view.shift();
      scheduleRender(); schedule();
    } catch (_) {}
  }
  function schedule() { if (!flushT) flushT = setTimeout(persist, 2500); }

  /* console.warn yerine: "[KC] ..." uyarılarını günlüğe yaz, konsola da düşür */
  window.KCwarn = function () {
    const a = Array.prototype.slice.call(arguments);
    try { console.warn.apply(console, a); } catch (_) {}
    try {
      let src = 'KC', first = a[0];
      if (typeof first === 'string') {
        const m = first.match(/^\[([^\]]+)\]\s*(.*)$/);
        if (m) { src = m[1]; a[0] = m[2]; }
      }
      elog('warn', src, a.map(str).join(' '));
    } catch (_) {}
  };
  KC.elog = elog;
  KC.errlog = {
    list: () => view.slice(),
    clear: () => { view = []; mem = []; dirty.clear(); lastByMsg.clear(); try { chrome.storage.local.set({ [KEY]: [] }); } catch (_) {} renderWin(); },
    text: () => view.slice().sort((a, b) => a.t - b.t).map(fmtLine).join('\n')
  };

  const pad = (n) => (n < 10 ? '0' : '') + n;
  const fmtT = (t) => { const d = new Date(t); return pad(d.getDate()) + '.' + pad(d.getMonth() + 1) + ' ' + pad(d.getHours()) + ':' + pad(d.getMinutes()) + ':' + pad(d.getSeconds()); };
  const fmtLine = (e) => fmtT(e.t) + ' [' + e.lvl.toUpperCase() + '] ' + e.src + (e.ch ? ' @' + e.ch : '') + ' — ' + e.msg + (e.n > 1 ? ' (x' + e.n + ')' : '') + (e.x ? '\n    ' + e.x : '') + (e.v ? '  v' + e.v : '');

  /* Yakalanmamış hatalar (sadece eklentiye ait olanlar) */
  const mine = (s) => { s = String(s || ''); return (EXT && s.indexOf(EXT) !== -1) || s.indexOf('chrome-extension://') !== -1; };
  window.addEventListener('error', (e) => {
    try {
      if (!mine(e.filename) && !mine(e.error && e.error.stack)) return;
      elog('error', 'js', (e.message || 'error') + ' (' + String(e.filename || '').split('/').slice(-2).join('/') + ':' + e.lineno + ')', e.error && e.error.stack);
    } catch (_) {}
  });
  window.addEventListener('unhandledrejection', (e) => {
    try {
      const r = e.reason;
      if (!mine(r && r.stack)) return;
      elog('error', 'promise', str(r), r && r.stack);
    } catch (_) {}
  });

  /* ───── Pencere ───── */
  const ID = 'kc-errlog';
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  let filter = 'all', rq = 0;
  const get = () => document.getElementById(ID);
  function scheduleRender() { if (!get() || rq) return; rq = setTimeout(() => { rq = 0; renderWin(); }, 400); }
  function renderWin() {
    const el = get(); if (!el) return;
    const rows = view.slice().sort((a, b) => b.t - a.t).filter((e) => filter === 'all' || e.lvl === filter);
    el.querySelector('.kc-el-count').textContent = rows.length + ' kayıt';
    el.querySelectorAll('[data-elf]').forEach((b) => b.classList.toggle('on', b.dataset.elf === filter));
    el.querySelector('.kc-el-list').innerHTML = rows.length ? rows.map((e) =>
      '<div class="kc-el-row ' + esc(e.lvl) + '"><div class="kc-el-h"><span>' + esc(fmtT(e.t)) + '</span><b>' + esc(e.src) + '</b>' + (e.ch ? '<i>@' + esc(e.ch) + '</i>' : '') + (e.n > 1 ? '<em>x' + e.n + '</em>' : '') + '</div>' +
      '<div class="kc-el-m">' + esc(e.msg) + '</div>' + (e.x ? '<div class="kc-el-x">' + esc(e.x) + '</div>' : '') + '</div>').join('')
      : '<div class="kc-el-empty">Kayıt yok</div>';
  }
  function loadStored(cb) {
    try {
      chrome.storage.local.get(KEY, (d) => {
        const cur = Array.isArray(d && d[KEY]) ? d[KEY] : [];
        const have = new Map(view.map((e) => [eid(e), e]));
        const merged = [];
        cur.forEach((e) => { if (!have.has(eid(e))) merged.push(e); });
        view = merged.concat(view).sort((a, b) => a.t - b.t).slice(-MAX);
        // depolanmış kayıtları tekilleştirme tablosuna ekle (yenilemeden sonra aynı hata tekrar yazılmasın)
        view.forEach((e) => { const k = norm(e.lvl, e.src, e.msg); const p = lastByMsg.get(k); if (!p || p.t < e.t) lastByMsg.set(k, e); });
        cb && cb();
      });
    } catch (_) { cb && cb(); }
  }
  function openWin() {
    if (get()) return;
    const el = document.createElement('div');
    el.id = ID;
    el.innerHTML =
      '<div class="kc-el-title"><span>Hata günlüğü <small class="kc-el-count"></small></span><span class="kc-el-x2" data-elclose title="Kapat">×</span></div>' +
      '<div class="kc-el-bar"><button type="button" data-elf="all" class="on">Hepsi</button><button type="button" data-elf="error">Hata</button><button type="button" data-elf="warn">Uyarı</button><button type="button" data-elf="info">Bilgi</button>' +
      '<span class="kc-el-sp"></span><button type="button" data-elcopy>Kopyala</button><button type="button" data-eldl>İndir</button><button type="button" data-elclear>Temizle</button></div>' +
      '<div class="kc-el-list"></div>';
    document.documentElement.appendChild(el);
    if (KC.applyPos) KC.applyPos(el, 'pos_errlog', { x: 60, y: 80 });
    if (KC.makeDraggable) KC.makeDraggable(el, el.querySelector('.kc-el-title'), 'pos_errlog');
    el.addEventListener('click', (e) => {
      const t = e.target;
      if (t.closest('[data-elclose]')) return KC.saveSetting('errlog_open', false);
      const f = t.closest('[data-elf]'); if (f) { filter = f.dataset.elf; return renderWin(); }
      if (t.closest('[data-elclear]')) return KC.errlog.clear();
      if (t.closest('[data-elcopy]')) {
        const txt = KC.errlog.text();
        const done = () => { const b = t.closest('button'); const o = b.textContent; b.textContent = 'Kopyalandı'; setTimeout(() => (b.textContent = o), 1200); };
        try { navigator.clipboard.writeText(txt).then(done, () => fallbackCopy(txt, done)); } catch (_) { fallbackCopy(txt, done); }
        return;
      }
      if (t.closest('[data-eldl]')) {
        const blob = new Blob([KC.errlog.text() || '(boş)'], { type: 'text/plain' });
        const a = document.createElement('a');
        a.href = URL.createObjectURL(blob); a.download = 'kick-drops-level-log-' + Date.now() + '.txt';
        document.documentElement.appendChild(a); a.click(); a.remove();
        setTimeout(() => URL.revokeObjectURL(a.href), 3000);
      }
    });
    loadStored(renderWin);
    renderWin();
  }
  function fallbackCopy(txt, done) {
    try { const ta = document.createElement('textarea'); ta.value = txt; ta.style.cssText = 'position:fixed;left:-9999px'; document.documentElement.appendChild(ta); ta.select(); document.execCommand('copy'); ta.remove(); done && done(); } catch (_) {}
  }
  KC.toggleErrLog = () => KC.saveSetting('errlog_open', !KC.settings.errlog_open);

  loadStored();
  KC.settingsReady && KC.settingsReady.then(() => {
    if (KC.settings.errlog_open) openWin();
    KC.on('setting:errlog_open', (v) => (v ? openWin() : get()?.remove()));
    KC.on('setting:pos_errlog', () => { const el = get(); if (el && KC.applyPos) KC.applyPos(el, 'pos_errlog'); });
  });
  addEventListener('pagehide', persist);
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden') persist(); });
})();
