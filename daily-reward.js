/* Kick Günlük Ödül (Daily Reward) otomatik alma — API tabanlı (v1.3.88)
 * Düğmeye tıklamaz. Kick'in kendi web API'sini kullanır:
 *   GET  https://web.kick.com/api/v1/gamification/challenges           → recurrence:"daily" olanın durumu
 *        status: "in_progress" | "claimable" | "claimed"
 *   POST https://web.kick.com/api/v1/gamification/challenges/{id}/claim
 * Yöntem: greasyfork "Kick Auto-Claim: Daily Rewards & Drops" (MIT) betiğinden esinlenildi, kod bu eklentiye göre yeniden yazıldı.
 * Ayar: daily_reward_auto · Kayıtlar: Hata günlüğü (kaynak: daily) · Durum: Dashboard "Günlük ödül" satırı
 */
(function () {
  const KC = (window.KickControl = window.KickControl || {});
  const API = 'https://web.kick.com/api/v1/gamification/challenges';
  const KEY = 'kcDailyReward';
  const TIMEOUT_MS = 20000; // zayıf internet için uzun
  const IDLE_MS = 15 * 60000;
  const NEAR_MS = 30000;
  const ERR_MS = 15 * 60000;
  const MAX_SLEEP_MS = 6 * 3600000;

  let timer = null;
  let running = false;
  let nextAt = 0;
  const st = { phase: 'init', remainingMin: null, reward: null, rarity: null, claimedUntil: 0, err: '',
    threshold: null, progress: null, endsAt: 0, lastCheckAt: 0, lastClaimAt: 0 };
  const events = []; // HUD için son olaylar (en yeni önce)
  function ev(msg, lvl) { events.unshift({ t: Date.now(), lvl: lvl || 'info', msg: String(msg) }); if (events.length > 12) events.length = 12; }

  const enabled = () => !(KC.settings && KC.settings.daily_reward_auto === false);
  const log = (lvl, msg) => { ev(msg, lvl); try { KC.elog && KC.elog(lvl, 'daily', msg); } catch (_) {} };

  function token() {
    try {
      const m = document.cookie.match(/(?:^|;\s*)session_token=([^;]+)/);
      return m ? decodeURIComponent(m[1]) : null;
    } catch (_) { return null; }
  }
  function loadState() {
    try {
      const s = JSON.parse(localStorage.getItem(KEY) || 'null');
      if (s && typeof s.claimedUntil === 'number') { st.claimedUntil = s.claimedUntil; st.reward = s.reward || null; st.rarity = s.rarity || null; st.lastClaimAt = s.lastClaimAt || 0; }
    } catch (_) {}
  }
  function saveState() {
    try { localStorage.setItem(KEY, JSON.stringify({ claimedUntil: st.claimedUntil, reward: st.reward, rarity: st.rarity, lastClaimAt: st.lastClaimAt })); } catch (_) {}
  }
  const claimedNow = () => st.claimedUntil && Date.now() < st.claimedUntil;

  async function api(method, url, tok) {
    const headers = { Accept: 'application/json', 'x-app-platform': 'web', Authorization: 'Bearer ' + tok };
    if (method === 'POST') headers['Content-Type'] = 'application/json';
    const doFetch = KC.netFetch ? KC.netFetch : (u, o) => fetch(u, o);
    const r = await doFetch(url, { method, headers, credentials: 'include', body: method === 'POST' ? null : undefined }, TIMEOUT_MS);
    let json = null;
    try { json = await r.json(); } catch (_) {}
    return { ok: r.ok, status: r.status, json };
  }

  async function getDaily(tok) {
    const r = await api('GET', API, tok);
    if (!r.ok) throw new Error('HTTP ' + r.status);
    const j = r.json;
    const list = Array.isArray(j) ? j : j && (j.data || j.challenges);
    if (!Array.isArray(list)) throw new Error('beklenmeyen yanıt biçimi');
    return list.find((c) => c && c.recurrence === 'daily') || null;
  }
  const resetMs = (ch) => {
    const t = ch && ch.window && ch.window.ends_at ? Date.parse(ch.window.ends_at) : NaN;
    if (Number.isFinite(t)) return t + 60000;
    const d = new Date();
    return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + 1, 0, 2, 0, 0); // yedek: 00:02 UTC
  };
  const winnerName = (w) => {
    try {
      if (!w) return null;
      const n = w.name || w.title || w.emote_name || w.label;
      if (typeof n === 'string' && n.trim()) return n.trim();
      const m = String(w.card_url || '').match(/\/cards\/([^/?#]+?)_[A-Za-z]+_card_/);
      return m ? decodeURIComponent(m[1]).replace(/_/g, ' ') : null;
    } catch (_) { return null; }
  };
  function markClaimed(ch) {
    st.phase = 'claimed';
    st.claimedUntil = resetMs(ch);
    const w = ch && ch.winner;
    if (w) { st.reward = winnerName(w) || st.reward; st.rarity = w.rarity || st.rarity; }
    st.remainingMin = null;
    saveState();
  }

  function schedule(ms) {
    const d = Math.max(1000, Math.min(Number.isFinite(ms) ? ms : IDLE_MS, MAX_SLEEP_MS));
    if (timer) clearTimeout(timer);
    nextAt = Date.now() + d;
    timer = setTimeout(() => { timer = null; void cycle(); }, d);
  }

  async function run() {
    if (running) return;
    running = true;
    try {
      if (!enabled()) { st.phase = 'off'; return schedule(60000); }
      const tok = token();
      if (!tok) { st.phase = 'nologin'; return schedule(IDLE_MS); }
      if (claimedNow()) { st.phase = 'claimed'; return schedule(st.claimedUntil - Date.now()); }

      const ch = await getDaily(tok);
      st.lastCheckAt = Date.now();
      if (ch) {
        const cc = ch.condition || {};
        st.threshold = Number.isFinite(Number(cc.threshold)) ? Number(cc.threshold) : null;
        st.progress = Number.isFinite(Number(cc.progress)) ? Number(cc.progress) : null;
        const ea = ch.window && ch.window.ends_at ? Date.parse(ch.window.ends_at) : NaN;
        st.endsAt = Number.isFinite(ea) ? ea : 0;
      }
      if (!ch) { st.phase = 'none'; log('info', 'API\'de günlük ödül bulunamadı — 15 dk sonra tekrar'); return schedule(IDLE_MS); }

      if (ch.status === 'claimed') {
        markClaimed(ch);
        log('info', 'Günlük ödül bugün zaten alınmış · sıfırlanma: ' + new Date(st.claimedUntil).toLocaleString());
        return schedule(st.claimedUntil - Date.now());
      }
      if (ch.status === 'claimable') {
        const ends = Date.parse(ch.window && ch.window.ends_at);
        if (!ch.id || (Number.isFinite(ends) && ends <= Date.now())) return schedule(NEAR_MS);
        st.phase = 'claiming';
        log('info', 'Günlük ödül hazır — API ile alınıyor');
        const cr = await api('POST', API + '/' + encodeURIComponent(ch.id) + '/claim', tok);
        if (!cr.ok) {
          // başka sekme/cihaz önce almış olabilir: durumu yeniden oku
          const again = await getDaily(tok);
          if (again && again.id === ch.id && again.status === 'claimed') {
            markClaimed(again);
            log('info', 'Günlük ödül başka yerden alınmış (sıfırlanma: ' + new Date(st.claimedUntil).toLocaleString() + ')');
            return schedule(st.claimedUntil - Date.now());
          }
          throw new Error('claim HTTP ' + cr.status);
        }
        markClaimed(ch);
        st.lastClaimAt = Date.now();
        saveState();
        try { // ne çıktığı alındıktan SONRA challenge.winner içinde
          const after = await getDaily(tok);
          if (after && after.id === ch.id && after.status === 'claimed') markClaimed(after);
        } catch (_) {}
        log('info', 'Günlük ödül ALINDI' + (st.reward ? ' · çıkan: ' + st.reward + (st.rarity ? ' (' + st.rarity + ')' : '') : '') +
          ' · sıfırlanma: ' + new Date(st.claimedUntil).toLocaleString());
        return schedule(st.claimedUntil - Date.now());
      }
      if (ch.status === 'in_progress') {
        const c = ch.condition || {};
        const rem = Math.max(0, (Number(c.threshold) || 0) - (Number(c.progress) || 0));
        st.phase = 'progress';
        st.remainingMin = rem;
        ev('Kontrol: ' + (Number(c.progress) || 0) + '/' + (Number(c.threshold) || 0) + ' dk · kalan ~' + rem + ' dk');
        return schedule(Math.min(IDLE_MS, Math.max(NEAR_MS, rem * 60000)));
      }
      throw new Error('bilinmeyen durum: ' + ch.status);
    } catch (e) {
      st.phase = 'error';
      st.err = (e && e.message) || String(e);
      log('warn', 'Günlük ödül kontrolü başarısız: ' + st.err + ' — 15 dk sonra tekrar');
      return schedule(ERR_MS);
    } finally {
      running = false;
    }
  }

  async function cycle() {
    // birden çok sekme aynı anda istek atmasın
    try {
      if (navigator.locks && typeof navigator.locks.request === 'function') {
        return await navigator.locks.request('kcDailyReward', { ifAvailable: true }, (lock) => (lock ? run() : schedule(NEAR_MS)));
      }
    } catch (_) {}
    return run();
  }

  KC.getDailyRewardStatus = function () {
    if (!enabled()) return null;
    switch (st.phase) {
      case 'claimed': return 'Alındı' + (st.reward ? ' · ' + st.reward : '');
      case 'claiming': return 'Alınıyor…';
      case 'progress': return st.remainingMin ? 'Kalan ~' + st.remainingMin + ' dk' : 'Hazır olmak üzere';
      case 'error': return 'Hata — tekrar denenecek';
      case 'nologin': return 'Giriş yapılmamış';
      case 'none': return 'Bulunamadı';
      default: return 'Kontrol ediliyor…';
    }
  };
  KC.dailyRewardCheck = () => { ev('Elle kontrol istendi'); schedule(500); };
  KC.getDailyRewardDetail = () => ({ ...st, enabled: enabled(), nextAt, events: events.slice() });
  KC.dailyRewardInfo = () => ({ ...st, nextCheck: nextAt ? new Date(nextAt).toISOString() : null, claimedUntilISO: st.claimedUntil ? new Date(st.claimedUntil).toISOString() : null });

  const wake = () => { if (document.visibilityState !== 'hidden' && !running && enabled()) schedule(2000); };
  document.addEventListener('visibilitychange', wake);
  window.addEventListener('online', wake);

  const start = () => {
    loadState();
    if (claimedNow()) { st.phase = 'claimed'; schedule(st.claimedUntil - Date.now()); }
    else schedule(5000 + Math.floor(Math.random() * 4000));
  };
  try { (KC.settingsReady || Promise.resolve()).then(start); } catch (_) { start(); }
})();
