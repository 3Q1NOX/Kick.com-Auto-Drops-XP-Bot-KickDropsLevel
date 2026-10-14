/* Günlük Ödül HUD — Kick Daily Reward durumunu ayrıntılı gösterir (v1.3.89)
 * Veri kaynağı: daily-reward.js → KC.getDailyRewardDetail()
 * Aç/kapat: menü → Drops Farm → "Günlük ödül HUD" (ayar: daily_hud_open) · sürükle: başlık çubuğu
 */
(function () {
  const KC = (window.KickControl = window.KickControl || {});
  const ID = 'kc-daily';
  const POS = 'pos_daily_hud';

  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const pad = (n) => String(n).padStart(2, '0');
  const hhmm = (t) => { const d = new Date(t); return pad(d.getHours()) + ':' + pad(d.getMinutes()); };
  const hhmmss = (t) => { const d = new Date(t); return pad(d.getHours()) + ':' + pad(d.getMinutes()) + ':' + pad(d.getSeconds()); };
  function dur(ms) {
    ms = Math.max(0, Math.round(ms / 1000));
    const h = Math.floor(ms / 3600), m = Math.floor((ms % 3600) / 60), s = ms % 60;
    if (h) return h + ' sa ' + m + ' dk';
    if (m) return m + ' dk ' + pad(s) + ' sn';
    return s + ' sn';
  }
  function ago(t) { return t ? dur(Date.now() - t) + ' önce' : '—'; }
  const line = (k, v, c) =>
    '<div class="kc-dr-line"><span>' + esc(k) + '</span><b class="' + (c || '') + '" title="' + esc(v) + '">' + esc(v) + '</b></div>';

  function injectStyle() {
    if (document.getElementById('kc-daily-style')) return;
    const s = document.createElement('style');
    s.id = 'kc-daily-style';
    s.textContent = `
#kc-daily, #kc-daily * { box-sizing: border-box; }
#kc-daily {
  position: fixed; z-index: 2147482950; width: 260px; max-width: calc(100vw - 8px); max-height: calc(100vh - 16px); overflow: hidden;
  display: flex; flex-direction: column;
  background: color-mix(in srgb, rgb(16 16 16) 88%, transparent); color: var(--im-text, #fff);
  border: 1px solid var(--im-border, #6e6e8080); border-radius: var(--im-radius, 0);
  font: 13px/1.35 "ProggyClean", Consolas, "Lucida Console", "DejaVu Sans Mono", monospace; letter-spacing: 0; text-transform: none; user-select: none;
}
#kc-daily * { font-family: inherit; }
#kc-daily .kc-dr-title { display: flex; align-items: center; justify-content: space-between; padding: 3px 6px; cursor: move; flex: none; background: color-mix(in srgb, var(--im-title-act, #294a7a) 75%, transparent); }
#kc-daily .kc-dr-x { cursor: pointer; padding: 0 6px; }
#kc-daily .kc-dr-x:hover { background: var(--im-btn-hov, #4296fa); }
#kc-daily .kc-dr-body { overflow: auto; min-height: 0; scrollbar-width: thin; scrollbar-color: var(--im-scroll-grab, #4f4f4f) transparent; }
#kc-daily .kc-dr-head { display: flex; align-items: center; gap: 6px; padding: 4px 8px 2px; }
#kc-daily .kc-dr-dot { width: 8px; height: 8px; flex: none; background: var(--im-text-dis, #808080); }
#kc-daily .kc-dr-dot.ok { background: #3fb950; } #kc-daily .kc-dr-dot.warn { background: var(--im-warn, #e5b200); } #kc-daily .kc-dr-dot.bad { background: var(--im-bad, #ff6d59); }
#kc-daily .kc-dr-sec { padding: 4px 8px 1px; color: var(--im-text-dis, #808080); }
#kc-daily .kc-dr-det { padding: 2px 8px 6px; }
#kc-daily .kc-dr-line { display: flex; justify-content: space-between; gap: 10px; }
#kc-daily .kc-dr-line span { color: var(--im-text-dis, #808080); white-space: nowrap; }
#kc-daily .kc-dr-line b { font-weight: normal; text-align: right; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
#kc-daily .kc-dr-line b.ok { color: #3fb950; } #kc-daily .kc-dr-line b.warn { color: var(--im-warn, #e5b200); } #kc-daily .kc-dr-line b.bad { color: var(--im-bad, #ff6d59); }
#kc-daily .kc-dr-bar { position: relative; height: 15px; margin: 2px 8px 4px; background: var(--im-frame-bg, #294a7a8a); }
#kc-daily .kc-dr-fill { height: 100%; background: var(--im-plot-hist, #e5b200); }
#kc-daily .kc-dr-fill.done { background: #3fb950; }
#kc-daily .kc-dr-bar span { position: absolute; inset: 0; display: flex; align-items: center; justify-content: center; font-size: 12px; color: var(--kc-hud-text, #fff); text-shadow: 0 1px 2px #000; }
#kc-daily .kc-dr-ev { display: flex; gap: 6px; font-size: 12px; line-height: 1.3; }
#kc-daily .kc-dr-ev i { font-style: normal; color: var(--im-text-dis, #808080); flex: none; }
#kc-daily .kc-dr-ev em { font-style: normal; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
#kc-daily .kc-dr-ev.warn em { color: var(--im-warn, #e5b200); } #kc-daily .kc-dr-ev.error em { color: var(--im-bad, #ff6d59); }
#kc-daily .kc-dr-btns { display: flex; gap: 4px; padding: 0 8px 8px; }
#kc-daily .kc-dr-btns button { flex: 1; min-width: 0; background: var(--im-btn, #4296fa66); color: inherit; border: 0; padding: 2px 4px; font: inherit; font-size: 12px; cursor: pointer; border-radius: var(--im-radius, 0); }
#kc-daily .kc-dr-btns button:hover { background: var(--im-btn-hov, #4296fa); }
#kc-daily .kc-dr-btns button:active { background: var(--im-btn-act, #0f87fa); }
`;
    (document.head || document.documentElement).appendChild(s);
  }

  function html() {
    const D = (KC.getDailyRewardDetail && KC.getDailyRewardDetail()) || null;
    if (!D) return '<div class="kc-dr-head"><span class="kc-dr-dot"></span><b>Veri yok</b></div>';
    const now = Date.now();
    let dot = '', title = 'Kontrol ediliyor…', tcls = '';
    const claimed = D.claimedUntil && now < D.claimedUntil;
    switch (D.phase) {
      case 'claimed': dot = 'ok'; title = 'Bugünkü ödül alındı'; tcls = 'ok'; break;
      case 'claiming': dot = 'warn'; title = 'Ödül alınıyor…'; tcls = 'warn'; break;
      case 'progress': dot = 'warn'; title = 'İzleme süresi bekleniyor'; break;
      case 'error': dot = 'bad'; title = 'Hata — tekrar denenecek'; tcls = 'bad'; break;
      case 'nologin': dot = 'bad'; title = 'Giriş yapılmamış'; tcls = 'bad'; break;
      case 'none': dot = 'warn'; title = 'Günlük ödül bulunamadı'; break;
      case 'off': title = 'Otomatik alma kapalı'; break;
      default: break;
    }
    if (!D.enabled && D.phase !== 'off') { title = 'Otomatik alma kapalı'; dot = ''; tcls = ''; }

    const out = ['<div class="kc-dr-head"><span class="kc-dr-dot ' + dot + '"></span><b class="' + tcls + '">' + esc(title) + '</b></div>'];

    // İlerleme çubuğu
    let pct = null, barTxt = '';
    if (claimed || D.phase === 'claimed') { pct = 100; barTxt = 'Alındı'; }
    else if (D.threshold > 0 && D.progress != null) {
      pct = Math.max(0, Math.min(100, Math.round((D.progress / D.threshold) * 100)));
      barTxt = D.progress + ' / ' + D.threshold + ' dk · %' + pct;
    }
    if (pct != null) {
      out.push('<div class="kc-dr-bar"><div class="kc-dr-fill' + (pct >= 100 ? ' done' : '') + '" style="width:' + pct + '%"></div><span>' + esc(barTxt) + '</span></div>');
    }

    const rows = [];
    if (D.phase === 'progress' && D.remainingMin != null) rows.push(line('Kalan izleme', '~' + D.remainingMin + ' dk'));
    if (D.phase === 'claimable' || D.phase === 'claiming') rows.push(line('Durum', 'Hazır', 'warn'));
    if (D.nextAt && D.enabled) rows.push(line('Sonraki kontrol', D.nextAt > now ? dur(D.nextAt - now) + ' sonra' : 'şimdi'));
    const reset = D.claimedUntil && now < D.claimedUntil ? D.claimedUntil : D.endsAt;
    if (reset && reset > now) rows.push(line('Sıfırlanma', hhmm(reset) + ' · ' + dur(reset - now)));
    if (D.reward || D.lastClaimAt) {
      rows.push(line('Son alınan', (D.reward || 'ödül') + (D.rarity ? ' (' + D.rarity + ')' : '') + (D.lastClaimAt ? ' · ' + hhmm(D.lastClaimAt) : ''), 'ok'));
    }
    rows.push(line('Son kontrol', ago(D.lastCheckAt)));
    if (D.phase === 'error' && D.err) rows.push(line('Hata', D.err, 'bad'));
    rows.push(line('Otomatik', D.enabled ? 'Açık' : 'Kapalı', D.enabled ? 'ok' : 'warn'));
    out.push('<div class="kc-dr-det">' + rows.join('') + '</div>');

    const evs = (D.events || []).slice(0, 6);
    if (evs.length) {
      out.push('<div class="kc-dr-sec">Son olaylar</div><div class="kc-dr-det">' +
        evs.map((e) => '<div class="kc-dr-ev ' + esc(e.lvl) + '" title="' + esc(e.msg) + '"><i>' + hhmmss(e.t) + '</i><em>' + esc(e.msg) + '</em></div>').join('') + '</div>');
    }
    out.push('<div class="kc-dr-btns"><button type="button" data-dract="check">Şimdi kontrol et</button><button type="button" data-dract="test">İlerleme testi</button></div>');
    return out.join('');
  }

  let timer = 0, last = '';
  const get = () => document.getElementById(ID);
  function render() {
    const el = get(); if (!el) return;
    let h; try { h = html(); } catch (e) { h = '<div class="kc-dr-head"><b>Görüntülenemedi</b></div>'; }
    if (h === last) return;
    last = h; el.querySelector('.kc-dr-body').innerHTML = h;
  }

  function open() {
    if (get()) return;
    injectStyle();
    const el = document.createElement('div');
    el.id = ID;
    el.innerHTML = '<div class="kc-dr-title"><span>Günlük ödül</span><span class="kc-dr-x" data-drclose title="Kapat">×</span></div><div class="kc-dr-body"></div>';
    document.documentElement.appendChild(el);
    if (KC.applyPos) KC.applyPos(el, POS, { x: 16, y: 360 });
    if (KC.makeDraggable) KC.makeDraggable(el, el.querySelector('.kc-dr-title'), POS);
    el.addEventListener('click', (e) => {
      if (e.target.closest('[data-drclose]')) return KC.saveSetting('daily_hud_open', false);
      if (e.target.closest('[data-dract="test"]')) { try { KC.dailyRingTest && KC.dailyRingTest(); } catch (_) {} return; }
      if (e.target.closest('[data-dract="check"]')) { try { KC.dailyRewardCheck && KC.dailyRewardCheck(); } catch (_) {} setTimeout(render, 700); }
    });
    last = ''; render();
    timer = setInterval(render, 1000);
  }
  function close() { clearInterval(timer); timer = 0; const el = get(); if (el) el.remove(); }

  KC.toggleDailyHud = () => KC.saveSetting('daily_hud_open', !KC.settings.daily_hud_open);

  (KC.settingsReady || Promise.resolve()).then(() => {
    if (KC.settings.daily_hud_open) open();
    KC.on('setting:daily_hud_open', (v) => (v ? open() : close()));
    KC.on('setting:pos_daily_hud', () => { const el = get(); if (el && KC.applyPos) KC.applyPos(el, POS); });
  });
})();
