(function () {
  'use strict';
  /* Ağ yardımcısı — KC.netFetch(url, opts, ms)
     1) Önce sayfa içinden normal fetch (kick.com çerezleriyle)
     2) "Failed to fetch" (CORS / ağ / güvenlik duvarı) olursa isteği arka plan servisine yaptırır
        (arka plan CORS'a takılmaz; Origin/Referer kick.com olarak ayarlanır)
     Hatalar Hata günlüğüne yazılır. */
  const KC = (window.KickControl = window.KickControl || {});
  const stats = { direct: 0, proxy: 0, fail: 0 };
  let proxyOffUntil = 0; // 429/engel alınca arka plan yedeği bir süre kapalı (trafik ikiye katlanmasın)
  KC.netStats = stats;

  const bgFetch = (url, opts) => new Promise((resolve, reject) => {
    try {
      const init = { method: (opts && opts.method) || 'GET', headers: (opts && opts.headers) || {} };
      if (opts && opts.body != null) init.body = opts.body;
      chrome.runtime.sendMessage({ type: 'kc:fetch', url, init }, (r) => {
        const err = chrome.runtime.lastError;
        if (err) return reject(new Error('bg: ' + err.message));
        if (!r) return reject(new Error('bg: boş yanıt'));
        if (r.error) return reject(new Error('bg: ' + r.error));
        let status = Number(r.status) || 0;
        if (status < 200 || status > 599) return reject(new Error('bg: durum ' + status));
        try { resolve(new Response([204, 205, 304].indexOf(status) !== -1 ? null : r.body, { status, statusText: r.statusText || '' })); }
        catch (e) { reject(e); }
      });
    } catch (e) { reject(e); }
  });

  const short = (u) => { try { const x = new URL(u); return x.host + x.pathname; } catch (_) { return String(u).slice(0, 80); } };

  KC.netFetch = async function (url, opts, ms) {
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), ms || 8000);
    let directErr = null;
    try {
      const res = await fetch(url, Object.assign({}, opts, { signal: ctl.signal }));
      stats.direct++;
      if (res.status === 403 || res.status === 0) KC.elog && KC.elog('warn', 'net', 'HTTP ' + res.status + ' ' + short(url));
      return res;
    } catch (e) {
      directErr = e;
    } finally {
      clearTimeout(t);
    }
    const timeout = directErr && directErr.name === 'AbortError';
    if (Date.now() < proxyOffUntil) { stats.fail++; throw directErr; }
    try {
      const res = await bgFetch(url, opts);
      stats.proxy++;
      if (res.status === 429 || res.status === 403) proxyOffUntil = Date.now() + 120000;
      KC.elog && KC.elog('info', 'net', 'doğrudan istek ' + (timeout ? 'zaman aşımı' : 'başarısız') + ', arka plan ile alındı: ' + short(url) + ' → ' + res.status);
      return res;
    } catch (e2) {
      stats.fail++;
      KC.elog && KC.elog('warn', 'net', (timeout ? 'zaman aşımı' : 'Failed to fetch') + ' ' + short(url) + ' · yedek: ' + (e2 && e2.message));
      throw directErr || e2;
    }
  };
})();
