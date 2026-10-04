(function () {
  const KC = (window.KickControl = window.KickControl || {});
  const STR = {
    en: {
      panel_title: 'Drops & Level',
      drops: 'Drops',
      level: 'Level',
      drops_enable: 'Enable Drops Farm',
      drops_auto_claim: 'Auto claim rewards',
      drops_hud: 'Show progress HUD',
      level_bot: 'Level Bot',
      anti_stuck: 'Anti-stuck protection',
      bg_watch: 'Keep tab active',
      status: 'Status',
      select_campaigns: 'Select campaigns',
      no_campaigns: 'No active campaigns',
      loading: 'Loading…',
      closed: 'Off',
      drops_off: 'Off',
      farming: 'Farming',
      switching: 'Switching channel…',
      all_done: 'All selected drops claimed',
      claim: 'Claim',
      refresh: 'Refresh',
      drops_refreshed: 'Refreshed',
      drops_refresh_fail: 'Refresh failed — try again',
      drops_hud_empty: 'No selected active drops',
      drops_empty: 'No active campaigns',
      drops_prog_wait: 'Loading progress…',
      terms_title: 'Disclaimer',
      terms_body:
        'This is an unofficial third-party extension. Not affiliated with Kick. Use at your own risk. Auto channel switching or farming may violate Kick ToS — you are solely responsible.',
      terms_accept: 'I understand — continue',
      terms_decline: 'Decline',
      settings: 'Settings',
      search_placeholder: 'Search campaigns…',
      status_watching: 'Watching: {slug}',
      status_watching_drops: 'Watching: {slug} · drops',
      status_off: 'Off',
      status_started: 'Started…',
      status_searching: 'Finding live…',
      status_not_found: 'No live channel',
      status_switching: 'Switching: {slug}',
      status_cooldown: 'Cooldown…',
      status_offline: 'Issue {n}/{need} · {slug}',

      drops_watching: 'Watching',
      drops_searching: 'Searching stream…',
      drops_switching: 'Switching',
      drops_waiting: 'Waiting for stream…',
      drops_none: 'No drop stream',
      drops_bad: 'Not suitable',
      drops_cooldown: 'Cooldown…',
      drops_pick: 'Select a campaign',
      drops_all_done: 'All claimed — stopped',
      drops_cat_changed: 'Category changed',
      drops_yield_level: 'Level bot continues',
      drops_fetch_fail: 'Could not load campaigns',
      drops_claimed: 'Claimed',
      drops_ready: 'Ready to claim',
      drops_claim_idle: 'Waiting to claim…',
      drops_need_login: 'Login required to claim',

    },
    tr: {
      panel_title: 'Drops & Level',
      drops: 'Drops',
      level: 'Level',
      drops_enable: 'Drops Farm Aç',
      drops_auto_claim: 'Ödülleri otomatik al',
      drops_hud: 'İlerleme HUD göster',
      level_bot: 'Level Botu',
      anti_stuck: 'Takılma koruması',
      bg_watch: 'Sekmeyi aktif tut',
      status: 'Durum',
      select_campaigns: 'Kampanya seç',
      no_campaigns: 'Aktif kampanya yok',
      loading: 'Yükleniyor…',
      closed: 'Kapalı',
      drops_off: 'Kapalı',
      farming: 'Farm yapılıyor',
      switching: 'Kanal değiştiriliyor…',
      all_done: 'Seçili drop’lar alındı',
      claim: 'Al',
      refresh: 'Yenile',
      drops_refreshed: 'Yenilendi',
      drops_refresh_fail: 'Yenilenemedi — tekrar dene',
      drops_hud_empty: 'Seçili aktif drop yok',
      drops_empty: 'Aktif kampanya yok',
      drops_prog_wait: 'İlerleme yükleniyor…',
      terms_title: 'Sorumluluk Reddi',
      terms_body:
        'Bu resmi olmayan üçüncü taraf bir eklentidir. Kick ile bağlantılı değildir. Kullanım risk size aittir. Otomatik kanal geçişi veya farm Kick şartlarına aykırı olabilir — sorumluluk tamamen size aittir.',
      terms_accept: 'Anladım — devam',
      terms_decline: 'Reddet',
      settings: 'Ayarlar',
      search_placeholder: 'Kampanya ara…',
      status_watching: 'İzleniyor: {slug}',
      status_watching_drops: 'İzleniyor: {slug} · drops',
      status_off: 'Kapalı',
      status_started: 'Başladı…',
      status_searching: 'Canlı aranıyor…',
      status_not_found: 'Canlı kanal yok',
      status_switching: 'Geçiliyor: {slug}',
      status_cooldown: 'Bekleniyor…',
      status_offline: 'Sorun {n}/{need} · {slug}',

      drops_watching: 'İzleniyor',
      drops_searching: 'Yayın aranıyor…',
      drops_switching: 'Geçiliyor',
      drops_waiting: 'Yayın bekleniyor…',
      drops_none: 'Uygun yayın yok',
      drops_bad: 'Uygun değil',
      drops_cooldown: 'Bekleniyor…',
      drops_pick: 'Kampanya seç',
      drops_all_done: 'Hepsi alındı — durdu',
      drops_cat_changed: 'Kategori değişti',
      drops_yield_level: 'Level bot devam',
      drops_fetch_fail: 'Kampanyalar yüklenemedi',
      drops_claimed: 'Alındı',
      drops_ready: 'Alınabilir',
      drops_claim_idle: 'Claim bekleniyor…',
      drops_need_login: 'Claim için giriş gerekli',

    }
  };

  function detectLang() {
    try {
      const raw = (navigator.language || 'en').toLowerCase();
      if (raw.startsWith('tr')) return 'tr';
    } catch (_) {}
    return 'en';
  }

  const lang = detectLang();
  const pack = STR[lang] || STR.en;

  KC.t = function (key, vars) {
    let s = pack[key] ?? STR.en[key] ?? key;
    if (vars) {
      for (const [k, v] of Object.entries(vars)) {
        s = s.replace(new RegExp('\\{' + k + '\\}', 'g'), String(v));
      }
    }
    return s;
  };
  KC.lang = lang;
  KC.iconURL = function (name) {
    try {
      return chrome.runtime.getURL('icons/' + name);
    } catch (_) {
      return '';
    }
  };
})();
