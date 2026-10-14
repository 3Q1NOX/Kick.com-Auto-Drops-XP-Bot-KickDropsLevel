/* Günlük ödül KARESİ — Kick'in "Günlük Ödülünü Al" düğmesinin etrafına kare ilerleme çerçevesi + altına kısa bilgi (v1.3.92)
 * Level XP yuvarlağının kare karşılığı. Veri: daily-reward.js → KC.getDailyRewardDetail()
 * Ayar: daily_ring (menü → Drops Farm → "Günlük ödül karesi") · tıklama Kick düğmesine geçer (çerçeve tıklamayı yakalamaz) */
(function () {
  const KC = (window.KickControl = window.KickControl || {});
  const ID = 'kc-daily-ring';
  const STYLE = 'kc-daily-ring-style';
  const on = () => !(KC.settings && KC.settings.daily_ring === false);

  function injectStyle() {
    if (document.getElementById(STYLE)) return;
    const s = document.createElement('style');
    s.id = STYLE;
    s.textContent = `
#${ID} { position: absolute; inset: -1px; pointer-events: none; z-index: 5; display: block; }
#${ID} svg { width: 100%; height: 100%; display: block; overflow: visible; }
#${ID} .kc-dq-bg { fill: none; stroke: rgba(255,255,255,0.12); stroke-width: 2.5; }
#${ID} .kc-dq-fg { fill: none; stroke: #e5b200; stroke-width: 2.5; stroke-linecap: round; stroke-dasharray: 100; stroke-dashoffset: 100; transition: stroke-dashoffset .35s ease, stroke .25s ease; }
#${ID}.ok .kc-dq-fg { stroke: var(--im-accent, #53df91); }
#${ID}.bad .kc-dq-fg { stroke: #ff6969; }
#${ID}.ready .kc-dq-fg { stroke: #ffe600; filter: drop-shadow(0 0 5px #ffe600); animation: kc-dq-blink .6s ease-in-out infinite; }
@keyframes kc-dq-blink { 0%,100% { opacity: 1; } 50% { opacity: .35; } }
#${ID} .kc-dq-box { position: absolute; left: 50%; top: calc(100% + 2px); transform: translateX(-50%); display: flex; flex-direction: column; align-items: center; gap: 0; padding: 0; background: none; border: 0; font: 700 8px/1.2 "Segoe UI", Inter, system-ui, sans-serif; color: #f1f1f1; text-shadow: 0 0 2px #000, 0 1px 2px #000, 0 0 4px #000; white-space: nowrap; text-align: center; }
#${ID} .kc-dq-l1 { font-size: 9px; color: var(--kc-hud-text, #e5b200); }
#${ID} .kc-dq-l2, #${ID} .kc-dq-l3 { font-weight: 600; }
#${ID} .kc-dq-l2 b, #${ID} .kc-dq-l3 b { font-weight: 700; color: var(--kc-hud-text, #fff); }
#${ID} .kc-dq-l2 i, #${ID} .kc-dq-l3 i { font-style: normal; color: var(--kc-hud-text, #b5b5b5); }
#${ID}.ok .kc-dq-l1 { color: var(--kc-hud-text, var(--im-accent, #53df91)); }
#${ID}.bad .kc-dq-l1 { color: #ff6969; }
#${ID}.ready .kc-dq-l1 { color: #ffe600; }
`;
    document.documentElement.appendChild(s);
  }

  /* Kick'in "Günlük Ödülünü Al" düğmesi (aria-label dile göre değişebilir) */
  function findBtn() {
    try {
      const list = document.querySelectorAll('button[aria-label]');
      for (const b of list) if (/g[uü]nl[uü]k\s*[oö]d[uü]l|daily\s*reward/i.test(b.getAttribute('aria-label') || '')) return b;
    } catch (_) {}
    return null;
  }

  function ensure() {
    let el = document.getElementById(ID);
    const btn = findBtn();
    if (!btn) { if (el) el.remove(); return null; }
    if (el && el.parentElement === btn) return el;
    if (el) el.remove();
    injectStyle();
    try { if (getComputedStyle(btn).position === 'static') btn.style.position = 'relative'; } catch (_) {}
    el = document.createElement('div');
    el.id = ID;
    el.innerHTML = '<svg viewBox="0 0 36 36" preserveAspectRatio="none" aria-hidden="true">' +
      '<rect class="kc-dq-bg" x="1.25" y="1.25" width="33.5" height="33.5" rx="6" pathLength="100"/>' +
      '<rect class="kc-dq-fg" x="1.25" y="1.25" width="33.5" height="33.5" rx="6" pathLength="100"/></svg>' +
      '<div class="kc-dq-box"><div class="kc-dq-l1">…</div><div class="kc-dq-l2"></div><div class="kc-dq-l3"></div></div>';
    btn.appendChild(el);
    return el;
  }

  const pad = (n) => String(n).padStart(2, '0');
  const hhmm = (t) => { const d = new Date(t); return pad(d.getHours()) + ':' + pad(d.getMinutes()); };
  const dur = (ms) => {
    const sec = Math.max(0, Math.round(ms / 1000)), h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60);
    return h ? h + ' sa ' + m + ' dk' : m ? m + ' dk' : sec + ' sn';
  };

  /* TEST: gerçek veriyi etkilemeden ilerleme animasyonunu gösterir (12 sn ilerleme → hazır → alındı) */
  let sim = null, simT = 0;
  const SIM_PROG = 12, SIM_CLAIM = 2.5, SIM_DONE = 6;
  function simDetail() {
    const now = Date.now(), el = (now - sim.t0) / 1000;
    const base = { enabled: true, threshold: 30, endsAt: now + 11 * 3600000 + 58 * 60000, nextAt: now + 5 * 3600000 + 59 * 60000, test: true };
    if (el < SIM_PROG) return Object.assign(base, { phase: 'progress', progress: Math.min(29, Math.floor((el / SIM_PROG) * 30)) });
    if (el < SIM_PROG + SIM_CLAIM) return Object.assign(base, { phase: 'claiming', progress: 30 });
    if (el < SIM_PROG + SIM_CLAIM + SIM_DONE) return Object.assign(base, { phase: 'claimed', progress: 30, claimedUntil: now + 11 * 3600000 + 58 * 60000, reward: 'Test ödülü' });
    return null;
  }
  KC.dailyRingTest = function () {
    if (!findBtn()) return false; // Kick'in günlük ödül düğmesi sayfada yok
    sim = { t0: Date.now() };
    clearInterval(simT);
    simT = setInterval(() => { try { update(); } catch (_) {} }, 250);
    update();
    return true;
  };

  function update() {
    const el = ensure();
    if (!el) return;
    if (!on()) { el.style.display = 'none'; return; }
    el.style.display = 'block';
    let D = null;
    if (sim) { D = simDetail(); if (!D) { sim = null; clearInterval(simT); simT = 0; } }
    if (!D) D = (KC.getDailyRewardDetail && KC.getDailyRewardDetail()) || null;
    const fg = el.querySelector('.kc-dq-fg');
    const l1 = el.querySelector('.kc-dq-l1'), l2 = el.querySelector('.kc-dq-l2'), l3 = el.querySelector('.kc-dq-l3');
    let cls = '', pct = 0, a1 = '…', a2 = '', a3 = '', tip = 'Günlük ödül';
    if (!D || !D.enabled) { a1 = 'Kapalı'; tip = 'Günlük ödül otomatik alma kapalı'; }
    else {
      const now = Date.now();
      const claimed = D.phase === 'claimed' || (D.claimedUntil && now < D.claimedUntil);
      const reset = D.claimedUntil && now < D.claimedUntil ? D.claimedUntil : D.endsAt;
      if (reset && reset > now) a2 = '<b>' + hhmm(reset) + ' · ' + dur(reset - now) + '</b>';
      if (claimed) {
        cls = 'ok'; pct = 100; a1 = ''; // v1.3.105: "✓ Alındı" yazısı kaldırıldı (yeşil çerçeve + süre yeterli)
        tip = 'Günlük ödül alındı' + (D.reward ? ' · ' + D.reward + (D.rarity ? ' (' + D.rarity + ')' : '') : '');
      } else if (D.phase === 'claiming') {
        cls = 'ready'; pct = 100; a1 = 'Alınıyor…'; tip = 'Günlük ödül alınıyor…';
      } else if (D.phase === 'error' || D.phase === 'nologin') {
        cls = 'bad'; a1 = D.phase === 'nologin' ? 'Giriş yok' : 'Hata'; tip = D.phase === 'nologin' ? 'Giriş yapılmamış' : 'Hata: ' + (D.err || '');
      } else if (D.threshold > 0 && D.progress != null) {
        pct = Math.max(0, Math.min(100, Math.round((D.progress / D.threshold) * 100)));
        if (pct >= 100) { cls = 'ready'; a1 = 'Hazır — alınıyor'; tip = 'Günlük ödül hazır'; }
        else { const rem = Math.max(0, D.threshold - D.progress); a1 = pct + '% · ' + D.progress + '/' + D.threshold + ' dk'; tip = 'Günlük ödül ' + D.progress + '/' + D.threshold + ' dk · kalan ~' + rem + ' dk'; }
      }
    }
    el.className = cls;
    fg.style.strokeDashoffset = String(100 - pct);
    if (D && D.test) a1 = 'TEST · ' + a1;
    if (l1.textContent !== a1) l1.textContent = a1;
    if (l2.innerHTML !== a2) l2.innerHTML = a2;
    if (l3.innerHTML !== a3) l3.innerHTML = a3;
    l1.style.display = a1 ? '' : 'none'; l2.style.display = a2 ? '' : 'none'; l3.style.display = a3 ? '' : 'none';
    el.title = tip;
  }

  let t = 0;
  const loop = () => { try { update(); } catch (_) {} };
  (KC.settingsReady || Promise.resolve()).then(() => {
    loop();
    t = setInterval(loop, 1500);
    try { KC.on('setting:daily_ring', loop); } catch (_) {}
    // Kick sayfası düğmeyi yeniden çizerse hemen tekrar tak
    let q = 0;
    new MutationObserver(() => { if (q) return; q = setTimeout(() => { q = 0; if (!document.getElementById(ID)) loop(); }, 300); })
      .observe(document.body || document.documentElement, { childList: true, subtree: true });
  });
})();
