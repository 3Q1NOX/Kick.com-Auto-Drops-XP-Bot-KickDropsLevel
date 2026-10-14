(function () {
  const KC = (window.KickControl = window.KickControl || {});

  // Kick 2026 frontend: web.kick.com/api/v1 is the only live drops API host.
  // kick.com/api/v1/drops/* and kick.com/api/v1/livestreams return 404.
  const CAMPAIGNS_EPS = [
    'https://web.kick.com/api/v1/drops/campaigns'
  ];
  const PROGRESS_EPS = [
    'https://web.kick.com/api/v1/drops/progress'
  ];
  const CLAIM_EPS = [
    'https://web.kick.com/api/v1/drops/claim'
  ];
  const LIVES_EP = 'https://web.kick.com/api/v1/livestreams';
  // Keep legacy names for any leftover references
  const CAMPAIGNS_EP = CAMPAIGNS_EPS[0];
  const PROGRESS_EP = PROGRESS_EPS[0];
  const CLAIM_EP = CLAIM_EPS[0];
  const TICK_MS = 4000;
  const SWITCH_COOLDOWN_MS = 25000;
  const CAMPAIGN_POLL_MS = 2 * 60 * 1000;
  const CLAIM_POLL_MS = 20 * 1000; // ilerleme + claim sık
  const BAD_NEED = 3;
  const VIDEO_BAD_NEED = 8; // video takılması: ~32 sn onarma denemesinden sonra başka yayına geç
  /** Max partner channels to probe live (DEDsafio etc. have 100+) */
  const MAX_FIXED_PROBE = 80;
  /** Concurrent live probes */
  const FIXED_PROBE_CONCURRENCY = 10;

  let botTimer = null;
  let campaignTimer = null;
  let claimTimer = null;
  let campaigns = []; // active + upcoming
  let campaignsAt = 0;
  let switchCooldownUntil = 0;
  let consecutiveBad = 0;
  let statusText = 'Kapalı';
  let lastVideoTime = 0;
  let lastVideoProgressAt = 0;
  let uiRoot = null;
  /** true when drops is enabled, has selected active campaigns, and at least one live target exists */
  let hasLiveTargets = false;
  /** true when current stream qualifies for a selected drop (drops owns the tab) */
  let controlling = false;
  let lastTargetProbeAt = 0;
  const TARGET_PROBE_MS = 45000;
  /** last known category id on current channel (detect mid-stream game switch) */
  let lastCatId = null;
  let lastCatSlug = '';
  let lastQualifyAt = 0;
  let lastQualifySlug = '';
  /** son uygunluk kontrolünün nedeni (HUD'da "neden aranıyor" göstermek için) */
  let lastQualReason = '';
  /** son başarılı hedef yayın listesi (ağ hatasında kullanılır) */
  let lastGoodLives = { at: 0, list: [] };
  let netFailFlag = false;
  const QUAL_CACHE_MS = 15 * 60 * 1000;
  const LIVES_CACHE_MS = 10 * 60 * 1000;
  let lastClaimAt = 0;
  let claimInFlight = false;
  let lastClaimMsg = '';
  let goNextBusy = false;
  let tickBusy = false;
  const claimedIds = new Set(); // reward ids claimed this session
  const claimWarned = new Set(); // 'ödülId:durum' — aynı claim hatası bir kez raporlanır
  const claimFailIds = new Map(); // rewardId -> { at, status } — avoid spam
  /** campaign ids where every reward is claimed — stop farming these */
  const completedCampaignIds = new Set();
  let progressByCampaign = {}; // id -> { progress_units, rewards[] }

  function t(k, vars) {
    try {
      if (KC.t) {
        const s = KC.t(k, vars);
        // v1.3.68: çeviri yoksa (t() anahtarı aynen döndürürse) null döndür —
        // böylece çağıran taraf `t(key) || 'Türkçe fallback'` gerçekten çalışsın.
        if (s !== k) return s;
        return null;
      }
    } catch (_) {}
    return null; // fallback metni çağıran tarafta
  }

  function setStatus(txt) {
    try {
      // Sadece tek kelimelik i18n key ise çevir (bileşik metni bozma)
      if (typeof txt === 'string' && KC.t && /^[a-z0-9_]+$/i.test(txt)) {
        const tr = KC.t(txt);
        if (tr) txt = tr;
      }
    } catch (_) {}
    statusText = txt;
    try {
      KC.emit('drops:status', txt);
    } catch (_) {}
    const el = document.getElementById('kc-drops-status');
    if (el) el.textContent = txt;
    const hs = document.getElementById('kc-dhud-status');
    if (hs) hs.textContent = txt;
  }

  function getDropsNowDoing() {
    if (!KC.settings?.drops_enabled) return '';
    const st = String(statusText || '');
    if (/geçiliyor|aranıyor|cooldown|bekleniyor/i.test(st)) return st;
    const sel = selectedCampaigns();
    if (!sel.length) return 'Drops: kampanya yok';
    const slug = currentSlug() || '';
    const name = (sel[0] && (sel[0].name || sel[0].id)) || 'kampanya';
    if (controlling) return 'Drop · ' + name + (slug ? ' · ' + slug : '');
    return 'Drops · ' + (sel.length > 1 ? sel.length + ' kampanya' : name) + (slug ? ' · ' + slug : '');
  }
  try {
    KC.getDropsNowDoing = getDropsNowDoing;
  } catch (_) {}

  function sessionToken() {
    try {
      const m = document.cookie.match(/(?:^|;\s*)session_token=([^;]+)/);
      return m ? decodeURIComponent(m[1]) : null;
    } catch (_) {
      return null;
    }
  }

  function headers(jsonBody) {
    // Do NOT set Origin/Referer — browser forbidden headers; extension sets them automatically
    const h = {
      Accept: 'application/json',
      'x-app-platform': 'web',
      'X-Client-Token':
        'e1393935a959b4020a4491574f6490129f678acdaa92760471263db43487f823'
    };
    const tok = sessionToken();
    if (tok) h.Authorization = 'Bearer ' + tok;
    if (jsonBody) h['Content-Type'] = 'application/json';
    return h;
  }

  function showClaimToast(title, body) {
    try {
      const host =
        document.fullscreenElement ||
        document.webkitFullscreenElement ||
        document.body;
      if (!host) return;
      const old = document.getElementById('kc-drops-claim-toast');
      if (old) old.remove();
      const el = document.createElement('div');
      el.id = 'kc-drops-claim-toast';
      el.className = 'kc-reward-toast';
      el.innerHTML =
        '<div class="kc-reward-toast-inner">' +
        '<span class="kc-reward-toast-ico">🎁</span>' +
        '<div class="kc-reward-toast-text"><b>' +
        escapeHtml(title) +
        '</b><span>' +
        escapeHtml(body) +
        '</span></div>' +
        '<button type="button" class="kc-reward-toast-x" aria-label="close">✕</button></div>';
      el.querySelector('.kc-reward-toast-x').onclick = (e) => {
        e.stopPropagation();
        el.remove();
      };
      host.appendChild(el);
      setTimeout(() => {
        try {
          el.remove();
        } catch (_) {}
      }, 12000);
    } catch (_) {}
  }

  /**
   * Poll progress and claim any earned rewards.
   * progress item: { id, name, progress_units, rewards:[{id,name,claimed,required_units}] }
   */
  async function pollAndClaim() {
    if (claimInFlight) return;
    if (!sessionToken()) {
      lastClaimMsg = t('drops_need_login') || 'Claim için giriş gerekli';
      return;
    }
    claimInFlight = true;
    try {
      let j;
      try {
        j = await fetchJsonRetry(PROGRESS_EPS, { headers: headers() }, null);
      } catch (e) {
        lastClaimMsg = t('drops_need_login') || 'Claim için giriş gerekli';
        return;
      }
      const list = Array.isArray(j?.data) ? j.data : Array.isArray(j) ? j : [];
      const auto = KC.settings?.drops_auto_claim !== false;
      let claimedNow = 0;
      let ready = 0;

      for (const c of list) {
        const cid = String(c.id);
        const progressUnits =
          Number(c.progress_units ?? c.progress ?? c.watched_units ?? 0) || 0;
        const rewards = c.rewards || [];
        progressByCampaign[cid] = {
          progress_units: progressUnits,
          rewards: rewards
        };

        let allClaimed = rewards.length > 0;
        for (const rw of rewards) {
          if (rw.claimed || claimedIds.has(String(rw.id))) {
            claimedIds.add(String(rw.id));
            continue;
          }
          allClaimed = false;
          const need = Number(rw.required_units ?? rw.required ?? 0) || 0;
          // Greasyfork-compatible: claimed must not be true; progress >= required
          const earned =
            rw.claimable === true ||
            rw.status === 'claimable' ||
            rw.status === 'Claimable' ||
            (need > 0 &&
              progressUnits >= need &&
              rw.claimed !== true &&
              rw.status !== 'claimed' &&
              rw.status !== 'Claimed' &&
              rw.status !== 'locked');
          if (!earned) continue;
          // Hesap bağlama gerekli → claim deneme, hata spam'i YOK; sadece izle
          if (needsAccountLink(c)) {
            const linkKey = 'link:' + String(c.id || '');
            if (!claimWarned.has(linkKey)) {
              claimWarned.add(linkKey);
              // tek seferlik sessiz not — status spam yok
              try {
                if (typeof KC.elog === 'function') {
                  KC.elog('info', 'drops', 'Hesap bağlama gerekli (izleniyor, claim yok): ' + (c.name || c.id));
                }
              } catch (_) {}
            }
            continue;
          }
          ready++;
          if (!auto) continue;

          const rid = String(rw.id || '');
          const campId = String(c.id || c.campaign_id || '');
          if (!rid || !campId) {
            KCwarn('[KC] drops claim skip — missing id', { rid, campId, c });
            continue;
          }
          // Skip rewards that recently failed with client/validation errors
          try {
            const prev = claimFailIds.get(rid);
            if (prev && Date.now() - prev.at < 5 * 60 * 1000) continue;
          } catch (_) {}

          try {
            let claimedOk = false;
            let lastStatus = 0;
            let lastBody = '';
            // Kick expects snake_case; ensure string ULIDs
            const bodies = [
              { reward_id: rid, campaign_id: campId },
              { rewardId: rid, campaignId: campId }
            ];
            outerClaim: for (const claimUrl of CLAIM_EPS) {
              for (const body of bodies) {
                let claimRes = null;
                try {
                  claimRes = await fetchTimeout(
                    claimUrl,
                    {
                      method: 'POST',
                      credentials: 'include',
                      headers: headers(true),
                      body: JSON.stringify(body)
                    },
                    8000
                  );
                } catch (fe) {
                  lastStatus = -1;
                  lastBody = String(fe && fe.message ? fe.message : fe);
                  claimRes = null;
                }
                if (!claimRes) continue;
                try {
                  lastStatus = claimRes.status;
                  try {
                    lastBody = (await claimRes.text() || '').slice(0, 200);
                  } catch (_) {}
                  if (claimRes.ok) {
                    claimedOk = true;
                    break outerClaim;
                  }
                  // Auth / validation — stop
                  if (
                    lastStatus === 400 ||
                    lastStatus === 401 ||
                    lastStatus === 403 ||
                    lastStatus === 409 ||
                    lastStatus === 422
                  ) {
                    break outerClaim;
                  }
                } catch (inner) {
                  lastBody = String(
                    inner && inner.message ? inner.message : inner
                  );
                }
              }
            }
            if (claimedOk) {
              claimedIds.add(rid);
              claimFailIds.delete(rid);
              claimedNow++;
              lastClaimAt = Date.now();
              const name = rw.name || 'Drop';
              const camp = c.name || '';
              lastClaimMsg =
                (t('drops_claimed') || 'Alınd') + ': ' + name;
              showClaimToast(
                t('drops_claimed_title') || 'Drop alındı!',
                name + (camp ? ' · ' + camp : '')
              );
              try {
                KC.emit('drops:claimed', { reward: rw, campaign: c });
              } catch (_) {}
            } else {
              // 400/bağlama: sessizce atla, tekrar deneme; status spam yok
              if (lastStatus === 400) {
                try {
                  claimFailIds.set(rid, { at: Date.now() + 86400000, status: 400 });
                } catch (_) {}
                const failKey = rid + ':400';
                if (!claimWarned.has(failKey)) {
                  claimWarned.add(failKey);
                  try {
                    if (typeof KC.elog === 'function') {
                      KC.elog('info', 'drops', 'Claim atlandı (hesap/ödül hazır değil) · izleniyor: ' + rid);
                    }
                  } catch (_) {}
                }
              } else if (lastStatus === 401 || lastStatus === 403) {
                try { claimFailIds.set(rid, { at: Date.now(), status: lastStatus }); } catch (_) {}
                const failKey = rid + ':' + lastStatus;
                if (!claimWarned.has(failKey)) {
                  claimWarned.add(failKey);
                  try {
                    if (typeof KC.elog === 'function') {
                      KC.elog('info', 'drops', 'Claim atlandı (giriş/yetki) · ' + rid);
                    }
                  } catch (_) {}
                }
              } else if (lastStatus === 404 || lastStatus === 409 || lastStatus === 422) {
                try { claimFailIds.set(rid, { at: Date.now(), status: lastStatus }); } catch (_) {}
                // zaten alındı / claimable değil — sessiz
              } else if (lastStatus === 429) {
                try { claimFailIds.set(rid, { at: Date.now(), status: 429 }); } catch (_) {}
              } else {
                try {
                  if (lastStatus !== 400) claimFailIds.set(rid, { at: Date.now(), status: lastStatus });
                } catch (_) {}
                const failKey = rid + ':' + lastStatus;
                if (!claimWarned.has(failKey)) {
                  claimWarned.add(failKey);
                  try {
                    if (typeof KC.elog === 'function') {
                      KC.elog('warn', 'drops', 'Claim başarısız ' + lastStatus + ' · ' + rid);
                    }
                  } catch (_) {}
                }
              }
            }
          } catch (e) {
            // Sessiz — gereksiz konsol spam yok
            try {
              const msg = e && e.message ? e.message : String(e);
              if (typeof KC.elog === 'function') KC.elog('info', 'drops', 'Claim istisna (yok sayıldı): ' + msg.slice(0, 120));
            } catch (_) {}
          }
        }

        // Re-check after claims
        if (
          rewards.length &&
          rewards.every((rw) => rw.claimed || claimedIds.has(String(rw.id)))
        ) {
          allClaimed = true;
        }
        if (allClaimed) {
          completedCampaignIds.add(cid);
        } else {
          completedCampaignIds.delete(cid);
        }
      }

      if (claimedNow > 0) {
        setStatus(
          (t('drops_claimed') || 'Alınd') +
            ' ×' +
            claimedNow +
            (lastClaimMsg ? ' · ' + lastClaimMsg : '')
        );
      } else if (ready > 0 && !auto) {
        lastClaimMsg =
          (t('drops_ready') || 'Alınabilir') + ': ' + ready;
        // Ready toast removed — only panel status is updated
      }

      // All selected campaigns fully claimed → stop drop farming
      if (KC.settings?.drops_enabled && allSelectedDone()) {
        controlling = false;
        hasLiveTargets = false;
        setStatus(t('drops_all_done') || 'Seçili drop’lar alındı · izleme durdu');
        lastClaimMsg = t('drops_all_done') || 'Seçili drop’lar alındı';
        try {
          KC.emit('drops:all-done');
        } catch (_) {}
      }

      // Update small claim status line in panel
      const el = document.getElementById('kc-drops-claim-status');
      if (el) {
        if (allSelectedDone() && selectedAllIncludingDone().length)
          el.textContent = t('drops_all_done') || 'Seçili drop’lar alındı';
        else if (lastClaimMsg) el.textContent = lastClaimMsg;
        else if (ready > 0)
          el.textContent = (t('drops_ready') || 'Alınabilir') + ': ' + ready;
        else el.textContent = t('drops_claim_idle') || 'Claim bekleniyor…';
      }
      try { renderCampaignList(); } catch (_) {}
      try { renderDropsHud(); } catch (_) {}
    } catch (e) {
      KCwarn('[KC] drops progress poll failed', e);
    } finally {
      claimInFlight = false;
    }
  }

  function currentSlug() {
    try {
      const p = location.pathname.split('/').filter(Boolean);
      if (
        p.length === 1 &&
        !/^(categories|category|video|videos|browse|search|following|dashboard|settings|login|signup|community|clips|drops)$/i.test(
          p[0]
        )
      ) {
        return p[0].toLowerCase();
      }
    } catch (_) {}
    return '';
  }

  function getVideo() {
    return (
      document.getElementById('video-player') ||
      document.querySelector('video#video-player, video[src], video')
    );
  }

  function parseIso(s) {
    try {
      return new Date(s);
    } catch (_) {
      return null;
    }
  }

  function isActiveCampaign(c) {
    if (!c) return false;
    // Kick now sends status: active | expired | upcoming — trust it first
    if (c.status === 'active') return true;
    if (c.status === 'expired' || c.status === 'ended' || c.status === 'completed')
      return false;
    if (c.status === 'upcoming') return false;
    const now = Date.now();
    const s = parseIso(c.starts_at);
    const e = parseIso(c.ends_at);
    if (s && e) return s.getTime() <= now && now <= e.getTime();
    return false;
  }

  /** Campaign requires external account link before claim is allowed */
  function needsAccountLink(c) {
    if (!c) return false;
    const url = c.connect_url || c.connectUrl || '';
    if (!url) return false;
    // explicit flags from progress/campaigns API
    if (c.user_app_connected === true || c.userAppConnected === true) return false;
    if (c.connected === true || c.is_connected === true) return false;
    return true;
  }

  function isUpcomingCampaign(c) {
    if (!c) return false;
    if (c.status === 'upcoming') return true;
    if (c.status === 'active' || c.status === 'expired') return false;
    const now = Date.now();
    const s = parseIso(c.starts_at);
    return s && s.getTime() > now;
  }

  /** fetch with hard timeout so a hung request can never freeze drops farm */
  async function fetchTimeout(url, opts, ms) {
    if (KC.netFetch) return KC.netFetch(url, opts, ms || 6000);
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), ms || 6000);
    try {
      return await fetch(url, Object.assign({}, opts, { signal: ctl.signal }));
    } finally {
      clearTimeout(t);
    }
  }

  async function fetchJsonRetry(urls, opts, label) {
    const list = Array.isArray(urls) ? urls : [urls];
    let lastErr = null;
    for (const url of list) {
      for (let attempt = 0; attempt < 2; attempt++) {
        try {
          const res = await fetchTimeout(
            url,
            {
              credentials: 'include',
              cache: 'no-store',
              ...opts,
              headers: {
                Accept: 'application/json',
                'x-app-platform': 'web',
                ...(opts && opts.headers ? opts.headers : {})
              }
            },
            8000
          );
          if (!res.ok) {
            lastErr = new Error('http ' + res.status + ' ' + url);
            // 404/403 on this host → try next URL
            if (res.status === 404 || res.status === 403 || res.status === 401) break;
            continue;
          }
          return await res.json();
        } catch (e) {
          lastErr = e;
          // brief backoff then retry same URL once
          await new Promise((r) => setTimeout(r, 300 + attempt * 400));
        }
      }
    }
    if (label) KCwarn('[KC]', label, lastErr);
    throw lastErr || new Error('fetch failed');
  }

  async function fetchCampaigns(force) {
    if (!force && campaigns.length && Date.now() - campaignsAt < CAMPAIGN_POLL_MS) {
      return campaigns;
    }
    try {
      const h = headers();
      const j = await fetchJsonRetry(
        CAMPAIGNS_EPS,
        { headers: h },
        'drops campaigns fetch failed'
      );
      const list = Array.isArray(j?.data) ? j.data : Array.isArray(j) ? j : [];
      campaigns = list.filter((c) => isActiveCampaign(c) || isUpcomingCampaign(c));
      campaignsAt = Date.now();
      try {
        reconcileSelection(campaigns);
      } catch (_) {}
      try {
        KC.emit('drops:campaigns', campaigns);
      } catch (_) {}
      renderCampaignList();
      try {
        renderDropsHud();
      } catch (_) {}
      return campaigns;
    } catch (e) {
      // Keep last good list; surface soft status once
      if (!campaigns.length) {
        setStatus(t('drops_fetch_fail') || 'Kampanyalar yüklenemedi · tekrar dene');
      }
      return campaigns;
    }
  }

  function selectedIds() {
    const arr = KC.settings?.drops_selected;
    return Array.isArray(arr) ? arr.map(String) : [];
  }

  function isCampaignFullyClaimed(c) {
    if (!c) return false;
    const id = String(c.id);
    if (completedCampaignIds.has(id)) return true;
    const prog = progressByCampaign[id];
    const rewards = (prog && prog.rewards) || c.rewards || [];
    if (!rewards.length) return false;
    // All rewards claimed (progress API or session set)
    return rewards.every(
      (rw) => rw.claimed === true || claimedIds.has(String(rw.id))
    );
  }

  function selectedCampaigns() {
    const ids = new Set(selectedIds());
    return campaigns.filter(
      (c) =>
        ids.has(String(c.id)) &&
        isActiveCampaign(c) &&
        !isCampaignFullyClaimed(c)
    );
  }

  function selectedAllIncludingDone() {
    const ids = new Set(selectedIds());
    return campaigns.filter((c) => ids.has(String(c.id)) && isActiveCampaign(c));
  }

  function allSelectedDone() {
    const all = selectedAllIncludingDone();
    if (!all.length) return false;
    return all.every((c) => isCampaignFullyClaimed(c));
  }

  /** Keep only ids that still exist; auto-pick today's Daily Drop when empty. */
  function reconcileSelection(list) {
    const all = Array.isArray(list) ? list : campaigns;
    const known = new Set(all.map((c) => String(c.id)));
    let ids = selectedIds().filter((id) => known.has(id));
    const prev = selectedIds();
    const changed = ids.length !== prev.length || ids.some((id, i) => id !== prev[i]);

    // Prefer name continuity: if user had a "Daily Drop" selected (or any selection wiped),
    // attach current active Daily Drop campaigns automatically.
    const hadDailyName = (() => {
      try {
        return prev.some((id) => {
          const c = all.find((x) => String(x.id) === id);
          return c && /daily\s*drop/i.test(c.name || '');
        });
      } catch (_) {
        return false;
      }
    })();

    if (!ids.length || hadDailyName) {
      const daily = all.filter(
        (c) => isActiveCampaign(c) && /daily\s*drop/i.test(c.name || '')
      );
      for (const d of daily) {
        const id = String(d.id);
        if (!ids.includes(id)) ids.push(id);
      }
    }

    // First-ever run / empty after prune: select active Daily Drops
    if (!ids.length) {
      const daily = all.filter(
        (c) => isActiveCampaign(c) && /daily\s*drop/i.test(c.name || '')
      );
      ids = daily.map((c) => String(c.id));
    }

    if (changed || ids.join() !== prev.join()) {
      KC.saveSetting('drops_selected', ids);
    }
    return ids;
  }

  /** Channel slugs listed on a single campaign (partner whitelist). */
  function campaignChannelSlugs(c) {
    const slugs = [];
    for (const ch of c?.channels || []) {
      let s = '';
      if (typeof ch === 'string') s = ch;
      else if (ch && typeof ch === 'object')
        s = ch.slug || ch.username || ch.user?.username || '';
      s = String(s).toLowerCase().trim();
      if (s && s !== 'undefined' && s !== 'null') slugs.push(s);
    }
    return slugs;
  }

  /** True when campaign restricts drops to listed partner channels only. */
  function isPartnerRestricted(c) {
    return campaignChannelSlugs(c).length > 0;
  }

  function campaignCategoryId(c) {
    const primary = c?.category?.id;
    if (primary != null && Number(primary) > 0) return Number(primary);
    for (const r of c?.rewards || []) {
      const rid = r.category_id;
      if (rid != null && Number(rid) > 0) return Number(rid);
    }
    return null;
  }

  function campaignCategorySlug(c) {
    const root = (c?.category?.slug || '').toString().toLowerCase().trim();
    if (root) return root;
    // Kick 2026: many campaigns omit root category — try reward-level slug if present
    for (const r of c?.rewards || []) {
      const s = (r.category_slug || r.category?.slug || '').toString().toLowerCase().trim();
      if (s) return s;
    }
    return null;
  }

  /**
   * Open (non-partner) campaigns → category ids to browse.
   * Partner-restricted campaigns are NOT included (only their channel list counts).
   */
  function targetCategories() {
    const cats = new Set();
    for (const c of selectedCampaigns()) {
      if (isPartnerRestricted(c)) continue; // don't farm random category streams
      const id = campaignCategoryId(c);
      if (id) cats.add(id);
      // All reward category ids (campaign may span multiple)
      for (const r of c.rewards || []) {
        const rid = r.category_id ?? r.category?.id;
        if (rid != null && Number(rid) > 0) cats.add(Number(rid));
      }
      if (c.category?.id != null && Number(c.category.id) > 0) {
        cats.add(Number(c.category.id));
      }
    }
    return [...cats];
  }

  function targetCategorySlugs() {
    const slugs = new Set();
    for (const c of selectedCampaigns()) {
      if (isPartnerRestricted(c)) continue;
      const s = campaignCategorySlug(c);
      if (s) slugs.add(s);
    }
    return [...slugs];
  }

  /** All partner channel slugs across selected partner-restricted campaigns. */
  function targetChannelSlugs() {
    const slugs = new Set();
    for (const c of selectedCampaigns()) {
      if (!isPartnerRestricted(c)) continue;
      for (const s of campaignChannelSlugs(c)) slugs.add(s);
    }
    return [...slugs];
  }

  function mapLiveItem(x, fallbackCatId) {
    if (!x) return null;
    // Kick 2026: stream/livestreams uses channel.slug; top-level slug is often session id
    const slug = (
      x.channel?.slug ||
      x.channel?.user?.username ||
      x.user?.username ||
      x.broadcaster_user?.username ||
      x.channel_slug ||
      (typeof x.channel === 'string' ? x.channel : '') ||
      // last resort — only if it looks like a channel slug (no uuid-like session)
      (x.slug && !/^[0-9a-f]{8}-/i.test(String(x.slug)) && String(x.slug).length < 40
        ? x.slug
        : '') ||
      ''
    )
      .toString()
      .toLowerCase()
      .trim();
    if (!slug) return null;
    const viewers =
      x.viewer_count ?? x.viewers ?? x.channel?.viewers ?? x.channel?.viewer_count ?? 0;
    const catId =
      x.category?.id ??
      x.categories?.[0]?.id ??
      x.categories?.[0]?.category_id ??
      fallbackCatId ??
      null;
    const catSlug = (
      x.category?.slug ||
      x.categories?.[0]?.slug ||
      ''
    )
      .toString()
      .toLowerCase()
      .trim();
    const title = x.title || x.session_title || '';
    return {
      slug,
      viewers: Number(viewers) || 0,
      categoryId: catId,
      categorySlug: catSlug || null,
      title
    };
  }

  async function fetchLivesForCategory(categoryId, limit, categorySlug) {
    const lim = limit || 25;
    const urls = [];
    // 1) web.kick by category_id — most reliable for Kick 2026
    if (categoryId) {
      urls.push(
        LIVES_EP +
          '?limit=' +
          lim +
          '&sort=viewer_count_desc&category_id=' +
          encodeURIComponent(categoryId)
      );
    }
    // 2) stream browse by slug
    if (categorySlug) {
      urls.push(
        'https://kick.com/stream/livestreams/en?limit=' +
          lim +
          '&sort=desc&subcategory=' +
          encodeURIComponent(categorySlug)
      );
      urls.push(
        'https://kick.com/stream/livestreams/en?limit=' +
          lim +
          '&sort=desc&category=' +
          encodeURIComponent(categorySlug)
      );
      urls.push(
        'https://kick.com/stream/livestreams/tr?limit=' +
          lim +
          '&sort=desc&subcategory=' +
          encodeURIComponent(categorySlug)
      );
    }
    // 3) stream browse by numeric id
    if (categoryId) {
      urls.push(
        'https://kick.com/stream/livestreams/en?limit=' +
          lim +
          '&sort=desc&category_id=' +
          encodeURIComponent(categoryId)
      );
      urls.push(
        'https://kick.com/stream/livestreams/en?limit=' +
          lim +
          '&sort=desc&subcategory=' +
          encodeURIComponent(categoryId)
      );
    }

    let best = [];
    for (const url of urls) {
      try {
        const res = await fetchTimeout(
          url,
          {
            credentials: 'include',
            headers: { Accept: 'application/json', 'x-app-platform': 'web' },
            cache: 'no-store'
          },
          6000
        );
        if (!res.ok) { netFailFlag = true; continue; }
        const j = await res.json();
        const data = j?.data;
        let list = [];
        if (Array.isArray(data?.livestreams)) list = data.livestreams;
        else if (Array.isArray(data)) list = data;
        else if (Array.isArray(j?.livestreams)) list = j.livestreams;
        else if (Array.isArray(j)) list = j;
        if (!list.length) continue;
        const mapped = list.map((x) => mapLiveItem(x, categoryId)).filter(Boolean);
        if (!mapped.length) continue;

        // Learn category slug from response for future lookups
        try {
          for (const m of mapped) {
            if (m.categorySlug && categoryId && !idToSlugCache[Number(categoryId)]) {
              idToSlugCache[Number(categoryId)] = m.categorySlug;
            }
          }
        } catch (_) {}

        if (categoryId) {
          const matched = mapped.filter(
            (m) =>
              m.categoryId == null ||
              Number(m.categoryId) === Number(categoryId)
          );
          if (matched.length) return matched;
          // web.kick filtered by category_id — trust it even if items omit category
          if (url.indexOf('web.kick.com') !== -1) return mapped;
          if (matched.length > best.length) best = matched;
          continue;
        }
        return mapped;
      } catch (e) {
        netFailFlag = true;
        KCwarn('[KC] drops lives fetch fail', url, e);
      }
    }
    return best;
  }

  // categoryId → slug cache (filled from live responses)
  const idToSlugCache = {};

  /**
   * Full live info for a channel slug, or null if offline.
   * @returns {Promise<{slug:string,viewers:number,categoryId:number|null,categorySlug:string,title:string}|null>}
   */
  async function getSlugLiveInfo(slug) {
    try {
      const res = await fetchTimeout(
        'https://kick.com/api/v2/channels/' + encodeURIComponent(slug) + '/livestream',
        {
          credentials: 'include',
          headers: { Accept: 'application/json' },
          cache: 'no-store'
        },
        5000
      );
      if (!res.ok) return null;
      const j = await res.json();
      const data = j?.data ?? j;
      if (!data || data === null) return null;
      if (data.is_live === false) return null;
      const live = !!(
        data.id ||
        data.session_title ||
        data.playback_url ||
        data.viewer_count != null ||
        data.viewers != null
      );
      if (!live) return null;
      let categoryId = null;
      if (data.category?.id != null) categoryId = Number(data.category.id);
      else if (data.categories?.[0]?.id != null) categoryId = Number(data.categories[0].id);
      const categorySlug = (
        data.category?.slug ||
        data.categories?.[0]?.slug ||
        ''
      )
        .toString()
        .toLowerCase();
      return {
        slug,
        viewers: Number(data.viewer_count ?? data.viewers ?? 0) || 0,
        categoryId,
        categorySlug,
        title: data.session_title || data.title || ''
      };
    } catch (_) {
      return null;
    }
  }

  async function isSlugLive(slug) {
    return !!(await getSlugLiveInfo(slug));
  }

  /** Shuffle array copy (Fisher–Yates) so we don't always probe the same offline partners first. */
  function shuffled(arr) {
    const a = (arr || []).slice();
    for (let i = a.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      const t = a[i];
      a[i] = a[j];
      a[j] = t;
    }
    return a;
  }

  /**
   * Required category ids for partner-restricted selected campaigns (slug → allowed cats).
   * Partner must be live AND in the campaign category (Minecraft partner streaming IRL = no drop).
   */
  function partnerAllowedCategories() {
    // slug -> Set of category ids (empty set = any category ok)
    const map = new Map();
    for (const c of selectedCampaigns()) {
      if (!isPartnerRestricted(c)) continue;
      const cat = campaignCategoryId(c);
      const catSlug = campaignCategorySlug(c);
      for (const s of campaignChannelSlugs(c)) {
        if (!map.has(s)) map.set(s, { ids: new Set(), slugs: new Set() });
        const ent = map.get(s);
        if (cat) ent.ids.add(Number(cat));
        if (catSlug) ent.slugs.add(catSlug);
      }
    }
    return map;
  }

  /**
   * Probe partner channels in parallel batches.
   * Only returns partners that are LIVE and in the correct drop category.
   */
  async function probeFixedChannelsLive(slugs) {
    const allowed = partnerAllowedCategories();
    const list = shuffled(slugs || []).slice(0, MAX_FIXED_PROBE);
    const live = [];
    let probed = 0;
    for (let i = 0; i < list.length; i += FIXED_PROBE_CONCURRENCY) {
      const batch = list.slice(i, i + FIXED_PROBE_CONCURRENCY);
      const results = await Promise.all(
        batch.map(async (slug) => {
          try {
            const info = await getSlugLiveInfo(slug);
            if (!info) return null;
            const rule = allowed.get(slug);
            // Must match campaign category when campaign defines one
            if (rule && (rule.ids.size || rule.slugs.size)) {
              const idOk = !rule.ids.size || (info.categoryId != null && rule.ids.has(Number(info.categoryId)));
              const slugOk =
                !rule.slugs.size ||
                (info.categorySlug && rule.slugs.has(info.categorySlug));
              if (!idOk && !slugOk) {
                // live but wrong game — skip (this was the atinycherry IRL bug)
                return null;
              }
            }
            return {
              slug: info.slug,
              viewers: info.viewers,
              categoryId: info.categoryId,
              title: info.title,
              partner: true
            };
          } catch (_) {}
          return null;
        })
      );
      probed += batch.length;
      for (const s of results) {
        if (s) live.push(s);
      }
      // Enough valid partners to rotate between
      if (live.length >= 10) break;
      // Keep searching if we only found wrong-category lives
      if (probed >= MAX_FIXED_PROBE) break;
    }
    return live;
  }

  async function collectTargetLivesRaw() {
    const out = [];
    const seen = new Set();
    const cats = targetCategories(); // only open (non-partner) campaigns
    const catSlugs = targetCategorySlugs();
    const fixed = targetChannelSlugs(); // only partner-restricted campaigns

    const idToSlug = { ...idToSlugCache };
    for (const c of selectedCampaigns()) {
      if (c.category?.id != null && c.category?.slug) {
        idToSlug[Number(c.category.id)] = String(c.category.slug).toLowerCase();
      }
      // rewards may carry category_id — slug filled later from live cache
      for (const r of c.rewards || []) {
        const rid = r.category_id ?? r.category?.id;
        const rslug = (r.category_slug || r.category?.slug || '').toString().toLowerCase().trim();
        if (rid != null && Number(rid) > 0 && rslug) {
          idToSlug[Number(rid)] = rslug;
        }
      }
    }

    // A) Partner-restricted campaigns
    // Fast path: category livestreams ∩ partner whitelist (avoids probing 100 offline/wrong-game partners)
    // Slow path: probe remaining partners that weren't in the category top list
    if (fixed.length) {
      const fixedSet = new Set(fixed);
      // Collect required categories for partner campaigns
      const partnerCats = new Set();
      const partnerCatSlugs = new Map(); // id -> slug
      for (const c of selectedCampaigns()) {
        if (!isPartnerRestricted(c)) continue;
        const id = campaignCategoryId(c);
        const s = campaignCategorySlug(c);
        if (id) {
          partnerCats.add(id);
          if (s) partnerCatSlugs.set(id, s);
        }
      }

      for (const cat of partnerCats) {
        try {
          const lives = await fetchLivesForCategory(
            cat,
            50,
            partnerCatSlugs.get(cat) || idToSlug[Number(cat)] || null
          );
          for (const L of lives) {
            if (!fixedSet.has(L.slug)) continue; // only partners
            if (seen.has(L.slug)) continue;
            seen.add(L.slug);
            out.push({ ...L, partner: true });
          }
        } catch (e) {
          KCwarn('[KC] drops partner∩cat', cat, e);
        }
      }

      // If still few targets, probe partners directly (with category check)
      if (out.length < 3) {
        try {
          const partners = await probeFixedChannelsLive(
            fixed.filter((s) => !seen.has(s))
          );
          for (const L of partners) {
            if (seen.has(L.slug)) continue;
            seen.add(L.slug);
            out.push(L);
          }
        } catch (e) {
          KCwarn('[KC] drops fixed probe', e);
        }
      }
    }

    // B) Open category campaigns (no channel whitelist) → any live stream in category
    for (const cat of cats) {
      try {
        const slugHint =
          idToSlug[Number(cat)] || idToSlugCache[Number(cat)] || null;
        const lives = await fetchLivesForCategory(cat, 40, slugHint);
        for (const L of lives) {
          if (seen.has(L.slug)) continue;
          seen.add(L.slug);
          out.push(L);
        }
        if (!lives.length) {
          KCwarn('[KC] drops: no lives for category', cat, slugHint);
        }
      } catch (e) {
        KCwarn('[KC] drops collect cat', cat, e);
      }
    }

    // Also try slug-only paths (when id failed or slug available)
    for (const cs of catSlugs) {
      try {
        const lives = await fetchLivesForCategory(null, 40, cs);
        for (const L of lives) {
          if (seen.has(L.slug)) continue;
          seen.add(L.slug);
          out.push(L);
        }
      } catch (_) {}
    }

    // C) Last resort: selected open campaigns with no category — cannot target randomly
    // Partner-only already handled in A. If still empty and we have cats, retry web.kick once more
    if (!out.length && cats.length) {
      for (const cat of cats) {
        try {
          const res = await fetchTimeout(
            LIVES_EP +
              '?limit=40&sort=viewer_count_desc&category_id=' +
              encodeURIComponent(cat),
            {
              credentials: 'include',
              headers: { Accept: 'application/json', 'x-app-platform': 'web' },
              cache: 'no-store'
            },
            6000
          );
          if (!res.ok) continue;
          const j = await res.json();
          const list = j?.data?.livestreams || j?.data || [];
          if (!Array.isArray(list)) continue;
          for (const x of list) {
            const L = mapLiveItem(x, cat);
            if (!L || seen.has(L.slug)) continue;
            seen.add(L.slug);
            out.push(L);
          }
        } catch (_) {}
      }
    }

    out.sort((a, b) => (b.viewers || 0) - (a.viewers || 0));
    if (!out.length) {
      const now = Date.now();
      if (!collectTargetLives._lastEmptyLog || now - collectTargetLives._lastEmptyLog > 60000) {
        collectTargetLives._lastEmptyLog = now;
        KCwarn('[KC] drops: collectTargetLives empty', {
          cats,
          catSlugs,
          fixedCount: fixed.length,
          selected: selectedCampaigns().map((c) => ({
            id: c.id,
            name: c.name,
            status: c.status,
            partner: isPartnerRestricted(c),
            cat: campaignCategoryId(c),
            catSlug: campaignCategorySlug(c),
            channels: campaignChannelSlugs(c).length
          }))
        });
      }
    } else {
      console.log(
        '[KC] drops targets',
        out.length,
        out.slice(0, 8).map((x) => x.slug + (x.partner ? '*' : ''))
      );
    }
    return out;
  }

  /** Ağ hatası yüzünden liste boş döndüyse son başarılı listeyi (10 dk) kullan */
  async function collectTargetLives() {
    netFailFlag = false;
    let out = await collectTargetLivesRaw();
    if (out.length) {
      lastGoodLives = { at: Date.now(), list: out.slice() };
    } else if (netFailFlag) {
      if (lastGoodLives.list.length && Date.now() - lastGoodLives.at < LIVES_CACHE_MS) {
        logQual('warn', 'yayın listesi alınamadı (ağ/WAF) → son başarılı liste kullanılıyor (' + lastGoodLives.list.length + ' yayın)');
        out = lastGoodLives.list.slice();
      } else {
        logQual('warn', 'yayın listesi alınamadı (ağ/WAF) ve eski liste yok');
      }
    }
    return out;
  }

  /**
   * Kanal API'si (kick.com/api/v2/channels/<slug>/livestream) alınamadığında:
   * yayın gerçekten uygunsa "uygun yayın aranıyor"a düşmeyelim.
   *  1) Bu kanal son 15 dk içinde uygun bulunduysa onu sürdür
   *  2) Kategorisiz partner kampanyasında kanal listedeyse uygundur
   *  3) Kanal son başarılı hedef listesinde varsa uygundur
   */
  function qualifyFallback(slug, sel, why) {
    try {
      const now = Date.now();
      let how = '';
      if (lastQualifySlug === slug && now - lastQualifyAt < QUAL_CACHE_MS) how = 'son-uygun';
      if (!how) {
        for (const c of sel) {
          const partners = campaignChannelSlugs(c);
          if (partners.length && partners.includes(slug) && campaignCategoryId(c) == null && !campaignCategorySlug(c)) { how = 'partner-listesi'; break; }
        }
      }
      if (!how && lastGoodLives.list.length && now - lastGoodLives.at < LIVES_CACHE_MS && lastGoodLives.list.some((x) => x.slug === slug)) how = 'hedef-listesi';
      // Doğrulanamıyor (ağ hatası / 429 / WAF engeli): kullanıcının seçtiği yayını bırakma, izlemeye devam et
      if (!how && why !== 'api-404') how = 'dogrulanamadi';
      if (!how) return null;
      lastQualifyAt = now; lastQualifySlug = slug;
      logQual('info', 'kanal API yok (' + why + ') → ' + how + ' ile izlemeye devam: ' + slug, true);
      return { ok: true, catId: null, reason: 'fallback-' + how, categoryChanged: false };
    } catch (_) { return null; }
  }

  const _qlogAt = {};
  function logQual(lvl, msg, once) {
    try {
      const now = Date.now();
      if (_qlogAt[msg] && (once || now - _qlogAt[msg] < 60000)) return;
      _qlogAt[msg] = now;
      KC.elog && KC.elog(lvl, 'drops', msg + ' · fps_boost=' + !!KC.settings?.fps_boost + ' chat_gizli=' + !!KC.settings?.fps_hide_chat);
    } catch (_) {}
  }

  /**
   * Does current channel count for at least one selected campaign?
   * Partner campaign  → slug must be on the campaign channel list (+ category if set).
   * Open campaign     → any live stream in the campaign category.
   * @returns {Promise<{ok:boolean, catId:number|null, reason:string, categoryChanged:boolean}>}
   */
  async function currentStreamQualifies() {
    const slug = currentSlug();
    if (!slug) {
      return { ok: false, catId: null, reason: 'no-slug', categoryChanged: false };
    }
    const sel = selectedCampaigns();
    if (!sel.length) {
      return { ok: false, catId: null, reason: 'no-targets', categoryChanged: false };
    }

    let catId = null;
    let catSlug = '';
    let offline = false;
    try {
      const res = await fetchTimeout(
        'https://kick.com/api/v2/channels/' + encodeURIComponent(slug) + '/livestream',
        { credentials: 'include', headers: { Accept: 'application/json' }, cache: 'no-store' },
        5000
      );
      if (!res.ok) {
        const fb = qualifyFallback(slug, sel, 'api-' + res.status);
        if (fb) return fb;
        return { ok: false, catId: null, reason: 'api-' + res.status, categoryChanged: false };
      }
      const j = await res.json();
      const data = j?.data ?? j;
      if (!data || data === null || data.is_live === false) {
        offline = true;
      } else {
        if (data.category?.id != null) catId = Number(data.category.id);
        else if (data.categories?.[0]?.id != null) catId = Number(data.categories[0].id);
        catSlug = (data.category?.slug || data.categories?.[0]?.slug || '')
          .toString()
          .toLowerCase();
      }
    } catch (e) {
      const fb = qualifyFallback(slug, sel, 'api-error');
      if (fb) return fb;
      return { ok: false, catId: null, reason: 'api-error', categoryChanged: false };
    }

    if (offline) {
      return { ok: false, catId: null, reason: 'offline', categoryChanged: false };
    }

    const categoryChanged =
      lastCatSlug === slug &&
      lastCatId != null &&
      catId != null &&
      Number(lastCatId) !== Number(catId);

    if (slug !== lastCatSlug) {
      lastCatSlug = slug;
      lastCatId = catId;
    } else if (catId != null) {
      lastCatId = catId;
    }

    // Evaluate each selected campaign independently
    let anyPartnerMiss = false;
    let anyCatMiss = false;
    for (const c of sel) {
      const partners = campaignChannelSlugs(c);
      const needCat = campaignCategoryId(c);
      const needSlug = campaignCategorySlug(c);

      if (partners.length) {
        // Partner-restricted: must be on the list
        if (!partners.includes(slug)) {
          anyPartnerMiss = true;
          continue;
        }
        // If campaign also has a category, require matching game (streamer switched game → invalid)
        if (needCat != null && catId != null && Number(catId) !== Number(needCat)) {
          anyCatMiss = true;
          continue;
        }
        if (needSlug && catSlug && catSlug !== needSlug && needCat == null) {
          anyCatMiss = true;
          continue;
        }
        lastQualifyAt = Date.now(); lastQualifySlug = slug;
        return { ok: true, catId, reason: 'listed-channel', categoryChanged };
      }

      // Open category campaign: any streamer in the right category
      if (needCat != null && catId != null && Number(catId) === Number(needCat)) {
        lastQualifyAt = Date.now(); lastQualifySlug = slug;
        return { ok: true, catId, reason: 'category-match', categoryChanged };
      }
      if (needSlug && catSlug && catSlug === needSlug) {
        lastQualifyAt = Date.now(); lastQualifySlug = slug;
        return { ok: true, catId, reason: 'category-slug-match', categoryChanged };
      }
      if (needCat != null || needSlug) anyCatMiss = true;
    }

    if (anyCatMiss || categoryChanged) {
      return {
        ok: false,
        catId,
        reason: categoryChanged ? 'category-changed' : 'wrong-category',
        categoryChanged
      };
    }
    if (anyPartnerMiss) {
      return { ok: false, catId, reason: 'not-partner', categoryChanged };
    }
    return { ok: false, catId, reason: 'no-match', categoryChanged };
  }

  function isVideoHealthy() {
    const v = getVideo();
    if (!v) return false;
    const now = Date.now();
    const t = Number(v.currentTime) || 0;
    if (t > lastVideoTime + 0.15) {
      lastVideoTime = t;
      lastVideoProgressAt = now;
      return true;
    }
    if (lastVideoProgressAt && now - lastVideoProgressAt < 12000) {
      return !v.ended && (v.readyState >= 2 || !v.paused);
    }
    if (!v.paused && !v.ended && v.readyState >= 2) {
      lastVideoProgressAt = now;
      return true;
    }
    return false;
  }

  async function probeTargets(force) {
    if (!force && Date.now() - lastTargetProbeAt < TARGET_PROBE_MS) {
      return hasLiveTargets;
    }
    lastTargetProbeAt = Date.now();
    const lives = await collectTargetLives();
    hasLiveTargets = lives.length > 0;
    return hasLiveTargets;
  }

  async function goNextDropStream(reason) {
    if (goNextBusy) return false;
    goNextBusy = true;
    try {
      return await goNextDropStreamInner(reason);
    } finally {
      goNextBusy = false;
    }
  }

  async function goNextDropStreamInner(reason) {
    const urgent = reason === 'category-changed' || reason === 'wrong-category';
    if (Date.now() < switchCooldownUntil && !urgent) {
      setStatus(t('drops_cooldown') || 'Bekleniyor (cooldown)…');
      return false;
    }
    if (urgent && Date.now() < switchCooldownUntil - SWITCH_COOLDOWN_MS + 8000) {
      // still respect a short 8s floor after a recent switch
      setStatus(t('drops_cooldown') || 'Bekleniyor (cooldown)…');
      return false;
    }
    const cur = currentSlug();
    setStatus(t('drops_searching') || 'Drop yayını aranıyor…');
    const lives = await collectTargetLives();
    hasLiveTargets = lives.length > 0;
    lastTargetProbeAt = Date.now();
    let pool = lives.filter((x) => x.slug !== cur);
    if (!pool.length) pool = lives.slice();
    if (!pool.length) {
      controlling = false;
      setStatus(
        (t('drops_none') || 'Uygun drop yayını yok') +
          (KC.settings?.level_bot
            ? ' · ' + (t('drops_yield_level') || 'Level bot devam')
            : '')
      );
      if (!goNextDropStream._lastNoTarget || Date.now() - goNextDropStream._lastNoTarget > 30000) {
        goNextDropStream._lastNoTarget = Date.now();
        KCwarn('[KC] drops: no target lives', reason);
      }
      return false;
    }
    // Prefer higher viewer, slight shuffle among top
    pool = pool.slice(0, 15);
    const pick = pool[Math.floor(Math.random() * Math.min(5, pool.length))];
    if (!pick?.slug) return false;
    switchCooldownUntil = Date.now() + SWITCH_COOLDOWN_MS;
    consecutiveBad = 0;
    controlling = true;
    setStatus((t('drops_switching') || 'Geçiliyor') + ': ' + pick.slug);
    console.log('[KC] drops switch →', pick.slug, reason);
    KC.logSwitch(cur || '', pick.slug, reason);
    try {
      location.href = 'https://kick.com/' + encodeURIComponent(pick.slug);
    } catch (_) {
      location.assign('/' + encodeURIComponent(pick.slug));
    }
    return true;
  }

  /**
   * Level bot calls this before switching channels.
   * true → drops owns navigation (do not switch away for level).
   */
  function shouldControl() {
    if (!KC.settings?.drops_enabled) return false;
    if (!selectedCampaigns().length) return false; // none left to farm (all claimed or none selected)
    if (controlling) return true;
    return hasLiveTargets;
  }

  /** Manuel "Sonraki" — drops açıksa drop yayınına, değilse level listesine */
  async function forceNextDropOrLevel(reason) {
    reason = reason || 'manual-next';
    // Prefer drops targets when farm is on and campaigns selected
    if (KC.settings?.drops_enabled && selectedCampaigns().length) {
      switchCooldownUntil = 0; // manuel: cooldown yok
      const ok = await goNextDropStream(reason);
      if (ok) return true;
      setStatus(
        (t('drops_none') || 'Uygun drop yayını yok') +
          (KC.settings?.level_bot ? ' · level listesine bakılıyor…' : '')
      );
      // fallback to level only if level bot on
      if (KC.settings?.level_bot && typeof KC.forceSwitchChannel === 'function') {
        // avoid recursion: forceSwitchChannel will be the smart one — call level path via KC._goNextLive
        if (typeof KC._goNextLive === 'function') {
          KC._goNextLive('manual-drop-fallback');
          return true;
        }
      }
      return false;
    }
    if (typeof KC._goNextLive === 'function') {
      KC._goNextLive('manual');
      return true;
    }
    if (typeof KC.forceSwitchChannel === 'function') {
      KC.forceSwitchChannel();
      return true;
    }
    return false;
  }
  try {
    KC.goNextDropStream = goNextDropStream;
    KC.forceNextStream = forceNextDropOrLevel;
  } catch (_) {}

  async function tick() {
    if (tickBusy) return;
    tickBusy = true;
    try {
      await tickInner();
    } finally {
      tickBusy = false;
    }
  }

  async function tickInner() {
    if (!KC.settings?.drops_enabled) {
      controlling = false;
      hasLiveTargets = false;
      setStatus(t('drops_off') || 'Kapalı');
      return;
    }
    // Everything selected already claimed → do not farm
    if (allSelectedDone() && selectedAllIncludingDone().length) {
      controlling = false;
      hasLiveTargets = false;
      setStatus(t('drops_all_done') || 'Seçili drop’lar alındı · izleme durdu');
      return;
    }
    const sel = selectedCampaigns();
    if (!sel.length) {
      controlling = false;
      hasLiveTargets = false;
      setStatus(t('drops_pick') || 'Kampanya seçin');
      return;
    }

    const q = await currentStreamQualifies();
    const ok = !!q.ok;
    lastQualReason = q.reason || '';
    if (!ok) logQual('info', 'bu yayın uygun değil: ' + (q.reason || '?') + ' @' + (currentSlug() || '-'));

    if (ok && isVideoHealthy()) {
      consecutiveBad = 0;
      controlling = true;
      hasLiveTargets = true;
      const names = sel.map((c) => c.name).slice(0, 2).join(', ');
      setStatus(
        (t('drops_watching') || 'İzleniyor') +
          ': ' +
          (currentSlug() || '?')
      );
      return;
    }

    // Qualifies but video stuck → another drop stream
    if (ok && !isVideoHealthy()) {
      consecutiveBad++;
      // Doğru yayındayız, sadece video takılı: "uygun yayın aranıyor" demeyelim, önce onarmayı dene
      controlling = true;
      hasLiveTargets = true;
      setStatus(
        'Yayın takıldı · onarılıyor ' + consecutiveBad + '/' + VIDEO_BAD_NEED +
          (currentSlug() ? ' · ' + currentSlug() : '')
      );
      if (consecutiveBad === 3 || consecutiveBad === 6) {
        logQual('info', 'video takıldı, düzeltme deneniyor (' + consecutiveBad + '/' + VIDEO_BAD_NEED + ') @' + (currentSlug() || '-'));
        try { KC.fixStreamNow && KC.fixStreamNow('Drops otomatik: video sağlıksız ' + consecutiveBad + '/' + VIDEO_BAD_NEED); } catch (_) {}
      }
      if (consecutiveBad >= VIDEO_BAD_NEED) {
        const switched = await goNextDropStream('video-bad');
        if (!switched) controlling = false;
      }
      return;
    }

    // Category changed mid-stream (streamer switched game) → switch ASAP
    if (q.categoryChanged || q.reason === 'category-changed' || q.reason === 'wrong-category') {
      controlling = false;
      setStatus(
        (t('drops_cat_changed') || 'Kategori değişti') +
          ' · ' +
          (currentSlug() || '?')
      );
      await probeTargets(true);
      if (hasLiveTargets) {
        // Immediate switch — don't wait BAD_NEED ticks
        consecutiveBad = BAD_NEED;
        const switched = await goNextDropStream(
          q.categoryChanged ? 'category-changed' : 'wrong-category'
        );
        if (!switched) {
          controlling = false;
          setStatus(
            (t('drops_none') || 'Uygun drop yayını yok') +
              (KC.settings?.level_bot
                ? ' · ' + (t('drops_yield_level') || 'Level bot devam')
                : '')
          );
        }
      } else {
        consecutiveBad = 0;
        setStatus(
          (t('drops_waiting') || 'Drop yayını bekleniyor') +
            (KC.settings?.level_bot
              ? ' · ' + (t('drops_yield_level') || 'Level bot devam')
              : '')
        );
      }
      return;
    }

    // Other non-qualifying (offline, etc.)
    controlling = false;
    await probeTargets(false);

    if (hasLiveTargets) {
      consecutiveBad++;
      setStatus(
        (t('drops_bad') || 'Uygun değil') +
          ` ${consecutiveBad}/${BAD_NEED}` +
          (currentSlug() ? ' · ' + currentSlug() : '')
      );
      if (consecutiveBad >= BAD_NEED) {
        const switched = await goNextDropStream(q.reason || 'wrong-stream');
        if (!switched) {
          controlling = false;
          setStatus(
            (t('drops_none') || 'Uygun drop yayını yok') +
              (KC.settings?.level_bot
                ? ' · ' + (t('drops_yield_level') || 'Level bot devam')
                : '')
          );
        }
      }
      return;
    }

    consecutiveBad = 0;
    controlling = false;
    setStatus(
      (t('drops_waiting') || 'Drop yayını bekleniyor') +
        (KC.settings?.level_bot
          ? ' · ' + (t('drops_yield_level') || 'Level bot devam')
          : '')
    );
  }

  function startClaimLoop() {
    if (claimTimer) clearInterval(claimTimer);
    // İlerleme HUD + claim: farm kapalı olsa bile sürekli güncelle (arka plan dahil)
    claimTimer = setInterval(() => {
      pollAndClaim().catch(() => {});
    }, CLAIM_POLL_MS);
    setTimeout(() => pollAndClaim().catch(() => {}), 1500);
    setTimeout(() => pollAndClaim().catch(() => {}), 5000);
  }

  function start() {
    if (botTimer) clearInterval(botTimer);
    if (campaignTimer) clearInterval(campaignTimer);
    consecutiveBad = 0;
    lastVideoTime = 0;
    lastVideoProgressAt = 0;
    fetchCampaigns(true).then(() => {
      botTimer = setInterval(() => {
        tick().catch(() => {});
      }, TICK_MS);
      campaignTimer = setInterval(() => {
        fetchCampaigns(true).catch(() => {});
      }, CAMPAIGN_POLL_MS);
      setTimeout(() => tick().catch(() => {}), 1500);
    });
    startClaimLoop();
    setStatus(t('drops_started') || 'Başladı…');
  }

  function stop() {
    if (botTimer) clearInterval(botTimer);
    botTimer = null;
    if (campaignTimer) clearInterval(campaignTimer);
    campaignTimer = null;
    // Keep claim loop if auto-claim still on
    if (KC.settings?.drops_auto_claim === false) {
      if (claimTimer) clearInterval(claimTimer);
      claimTimer = null;
    }
    consecutiveBad = 0;
    controlling = false;
    setStatus(t('drops_off') || 'Kapalı');
  }

  function toggleCampaign(id, on) {
    id = String(id);
    let arr = selectedIds().slice();
    const has = arr.includes(id);
    if (on && !has) arr.push(id);
    if (!on && has) arr = arr.filter((x) => x !== id);
    KC.saveSetting('drops_selected', arr);
    renderCampaignList();
    if (KC.settings.drops_enabled) {
      consecutiveBad = BAD_NEED; // force re-eval soon
      setTimeout(() => tick().catch(() => {}), 400);
    }
  }

  /**
   * Kick drops progress_units / required_units = DAKİKA (saniye değil).
   * Örnek: required_units=120 → 2 saat izleme.
   */
  function fmtUnits(u) {
    if (u == null || u === '') return '';
    const m = Math.max(0, Math.round(Number(u) || 0));
    if (m < 60) return m + ' dk';
    const h = Math.floor(m / 60);
    const rm = m % 60;
    if (rm === 0) return h + ' sa';
    return h + ' sa ' + rm + ' dk';
  }

  /** Kalan dakika → okunaklı metin */
  function fmtRemain(minsLeft) {
    if (minsLeft == null) return '—';
    const m = Math.ceil(Number(minsLeft) || 0);
    if (m <= 0) return 'Hazır';
    if (m < 60) return 'Kalan ' + m + ' dk';
    const h = Math.floor(m / 60);
    const rm = m % 60;
    if (rm === 0) return 'Kalan ' + h + ' sa';
    return 'Kalan ' + h + ' sa ' + rm + ' dk';
  }

  /** İzlenen / gereken · kalan */
  function fmtProgressLine(watched, need) {
    if (!(need > 0)) return '';
    const w = Math.max(0, Math.min(Number(watched) || 0, need));
    const left = Math.max(0, need - w);
    return fmtUnits(w) + ' / ' + fmtUnits(need) + (left > 0 ? ' · ' + fmtRemain(left) : ' · Hazır');
  }

  /** Merge campaign rewards with progress API (per-reward claimed + shared watch units). */
  function getMergedRewards(c) {
    const cid = String(c.id);
    const prog = progressByCampaign[cid];
    const units = prog != null ? Number(prog.progress_units) || 0 : null;
    const byId = {};
    (prog && prog.rewards ? prog.rewards : []).forEach((r) => {
      if (r && r.id != null) byId[String(r.id)] = r;
    });
    const base = (c.rewards && c.rewards.length ? c.rewards : prog && prog.rewards) || [];
    // Prefer union: campaign list + any progress-only rewards
    const seen = new Set();
    const list = [];
    for (const r of base) {
      const id = String(r.id);
      if (seen.has(id)) continue;
      seen.add(id);
      const p = byId[id];
      list.push({
        id: r.id,
        name: (p && p.name) || r.name || 'Ödül',
        required_units: Number(
          (p && (p.required_units ?? p.required)) ??
            r.required_units ??
            r.required ??
            0
        ) || 0,
        claimed:
          (p && p.claimed === true) ||
          r.claimed === true ||
          claimedIds.has(id)
      });
    }
    for (const r of Object.values(byId)) {
      const id = String(r.id);
      if (seen.has(id)) continue;
      seen.add(id);
      list.push({
        id: r.id,
        name: r.name || 'Ödül',
        required_units: Number(r.required_units ?? r.required ?? 0) || 0,
        claimed: r.claimed === true || claimedIds.has(id)
      });
    }
    list.sort(
      (a, b) => (a.required_units || 0) - (b.required_units || 0)
    );
    return { rewards: list, units, hasProg: prog != null };
  }

  function rewardPct(units, need, claimed) {
    if (claimed) return 100;
    if (need <= 0 || units == null) return null;
    return Math.max(0, Math.min(100, Math.round((units / need) * 100)));
  }

  /** Kampanya paneli ekrana sığsın — her render sonrası çağrılır (paylaşılan yol).
   *  v1.3.71: ana menünün (#kc-menu) üstüne binmesin — çakışıyorsa paneli sağa kaydır
   *  (panel %94 opak; menü yazısı altından sızıp okunamaz hale geliyordu). */
  function fitPickerToViewport() {
    try {
      const panel = document.getElementById('kc-camp-picker');
      if (!panel) return;
      const r = panel.getBoundingClientRect();
      const vw = window.innerWidth, vh = window.innerHeight;
      // dikey sığdırma
      if (r.bottom > vh - 8) {
        panel.style.top = Math.max(8, vh - 8 - r.height) + 'px';
      }
      // yatay sığdırma
      if (r.right > vw - 8) {
        panel.style.left = Math.max(8, vw - 8 - r.width) + 'px';
      }
      // ana menüyle çakışma: menü görünürse ve panel onun üstüne biniyorsa önce yana kaydırmayı dene.
      // NOT: #kc-menu position:fixed olduğundan offsetParent HER ZAMAN null —
      // görünür mü diye rect + computed style ile bak.
      // v1.3.72: dar ekranda yana/altına sığmıyorsa menüyü panel açıkken GİZLE (kapatınca geri gelir).
      const menu = document.getElementById('kc-menu');
      const menuVisible = (function () {
        try {
          if (!menu) return false;
          const st = getComputedStyle(menu);
          if (st.display === 'none' || st.visibility === 'hidden') return false;
          const r = menu.getBoundingClientRect();
          return r.width > 0 && r.height > 0;
        } catch (_) { return false; }
      })();
      if (menu && menuVisible) {
        const mr = menu.getBoundingClientRect();
        const pr = panel.getBoundingClientRect();
        const overlap = !(pr.left >= mr.right - 2 || pr.right <= mr.left + 2 ||
          pr.top >= mr.bottom - 2 || pr.bottom <= mr.top + 2);
        if (overlap) {
          const newLeft = mr.right + 12;
          if (newLeft + pr.width <= vw - 8) {
            // menünün sağına sığar
            panel.style.left = newLeft + 'px';
          } else {
            // menünün altına dene
            const belowTop = mr.bottom + 12;
            const fitsBelow = belowTop + pr.height <= vh - 8;
            if (fitsBelow) {
              panel.style.left = Math.max(8, Math.min(vw - 8 - pr.width, pr.left)) + 'px';
              panel.style.top = belowTop + 'px';
            } else {
              // Hiçbir yer sığmıyor (dar ekran): menüyü panel açıkken gizle.
              // Tema/opaklık/ayar DEĞİŞMEZ — sadece visibility kapanır, kapanınca geri açılır.
              try {
                if (!menu.hasAttribute('data-kc-hidden-by-picker')) {
                  menu.setAttribute('data-kc-hidden-by-picker', '1');
                  menu.style.visibility = 'hidden';
                }
              } catch (_) {}
              panel.style.left = Math.max(8, vw - 8 - pr.width) + 'px';
              panel.style.top = Math.max(8, vh - 8 - pr.height) + 'px';
            }
          }
        }
      }
    } catch (_) {}
  }

  function renderCampaignList() {
    const campHost = document.getElementById('kc-camp-list');
    const menuHost = document.getElementById('kc-drops-list');
    if (!campHost && !menuHost) {
      try {
        renderDropsHud();
      } catch (_) {}
      return;
    }
    // Ana menü: aktif + yakında (alınmayan). Kampanya paneli: aktif + yakında + alınmış
    if (menuHost) fillCampaignHost(menuHost, { includeDone: false, includeUpcoming: true });
    if (campHost) fillCampaignHost(campHost, { includeDone: true, includeUpcoming: true });
    try {
      renderDropsHud();
    } catch (_) {}
    // v1.3.70: panel açıksa ve içerik değiştiyse ekrana sığmasını yeniden ölç
    if (document.getElementById('kc-camp-picker')) {
      try { fitPickerToViewport(); } catch (_) {}
    }
  }

  function fillCampaignHost(host, opts) {
    const includeDone = !!(opts && opts.includeDone);
    const includeUpcoming = !!(opts && opts.includeUpcoming);
    const ids = new Set(selectedIds());
    let list = campaigns.slice().filter((c) => {
      const done = isCampaignFullyClaimed(c);
      if (done) return includeDone;
      if (isUpcomingCampaign(c) && !isActiveCampaign(c)) return includeUpcoming;
      return isActiveCampaign(c);
    });
    list.sort((a, b) => {
      const rank = (c) => {
        const done = isCampaignFullyClaimed(c);
        if (isActiveCampaign(c) && !done) return 0;
        if (isUpcomingCampaign(c)) return 1;
        if (done) return 2;
        return 3;
      };
      const d = rank(a) - rank(b);
      if (d) return d;
      // v1.3.68: yakında kampanyalar başlangıç zamanına göre (erken olan üstte),
      // diğerleri isme göre alfabetik
      const ra = isUpcomingCampaign(a), rb = isUpcomingCampaign(b);
      if (ra && rb) {
        const sa = parseIso(a.starts_at), sb = parseIso(b.starts_at);
        if (sa && sb) return sa.getTime() - sb.getTime();
      }
      return (a.name || '').localeCompare(b.name || '');
    });
    if (!list.length) {
      host.innerHTML =
        '<div class="kc-drops-empty">' +
        (t('drops_empty') || 'Aktif kampanya yok') +
        '</div>';
      return;
    }
    host.innerHTML = list
      .map((c) => {
        const active = isActiveCampaign(c);
        const upcoming = isUpcomingCampaign(c);
        const selected = ids.has(String(c.id));
        const done = isCampaignFullyClaimed(c);
        const cat = c.category?.name || '';
        const org = (c.organization && c.organization.name) || '';
        const merged = getMergedRewards(c);
        const rewards = merged.rewards;
        const units = merged.units;
        const hasProg = merged.hasProg;

        // Alınmış kampanya: küçük satır, detay yok
        if (done) {
          const thumb = campaignThumbUrl(c);
          return (
            '<label class="kc-drops-item kc-drops-done-item kc-drops-compact">' +
            '<span class="kc-drops-check">' +
            '<input type="checkbox" data-drop-id="' + c.id + '" disabled>' +
            '<span class="kc-drops-check-ui" aria-hidden="true"></span></span>' +
            (thumb
              ? '<img class="kc-drops-thumb kc-drops-thumb-sm" src="' + escapeHtml(thumb) +
                '" alt="" loading="lazy" decoding="async" referrerpolicy="no-referrer" onerror="this.style.display=\'none\'">'
              : '') +
            '<span class="kc-drops-meta">' +
            '<span class="kc-drops-top">' +
            '<span class="kc-drops-name">' + escapeHtml(c.name || 'Drop') + '</span>' +
            '<span class="kc-drops-badge kc-drops-done">ALINDI</span>' +
            '</span></span></label>'
          );
        }

        // Yakında: kompakt, checkbox kapalı, başlangıç zamanı gösterilir
        if (upcoming && !active) {
          const thumb = campaignThumbUrl(c);
          const s = parseIso(c.starts_at);
          const when = s ? s.toLocaleString('tr-TR', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }) : '';
          return (
            '<label class="kc-drops-item kc-drops-upcoming kc-drops-compact">' +
            '<span class="kc-drops-check">' +
            '<input type="checkbox" data-drop-id="' + c.id + '" disabled>' +
            '<span class="kc-drops-check-ui" aria-hidden="true"></span></span>' +
            (thumb
              ? '<img class="kc-drops-thumb kc-drops-thumb-sm" src="' + escapeHtml(thumb) +
                '" alt="" loading="lazy" decoding="async" referrerpolicy="no-referrer" onerror="this.style.display=\'none\'">'
              : '') +
            '<span class="kc-drops-meta">' +
            '<span class="kc-drops-top">' +
            '<span class="kc-drops-name">' + escapeHtml(c.name || 'Drop') + '</span>' +
            '<span class="kc-drops-badge">YAKINDA</span>' +
            '</span>' +
            (when
              ? '<span class="kc-drops-cat">Başlangıç: ' + escapeHtml(when) + '</span>'
              : '') +
            (cat || org
              ? '<span class="kc-drops-cat">' + [cat, org].filter(Boolean).map(escapeHtml).join(' · ') + '</span>'
              : '') +
            '</span></label>'
          );
        }

        // Kompakt görünüm: tek genel çubuk + kalan süre (ödül satırları ana menüde sıgmıyordu)
        const maxNeed = rewards.reduce((m, r) => Math.max(m, r.required_units || 0), 0);
        // Yuvı yuvarlanmamış oran — hazırlık kontrolü için (yuvarlama yalnızca göstermede)
        const rawRatio = !done && maxNeed > 0 && units != null ? units / maxNeed : null;
        // Tamamlanmamışsa YUVARLAMA YOK (aşağı yuvarla): %99.7 → %99 göster.
        // Tamamlandıysa (%100) 100 göster. Bu, "100%" görünüp aslında eksik kalması hatasını önler.
        const overallPct =
          done || maxNeed <= 0 || units == null
            ? done ? 100 : null
            : rawRatio != null && rawRatio >= 1
              ? 100
              : Math.max(0, Math.min(99, Math.floor(rawRatio * 100)));
        const compactBar =
          '<div class="kc-drops-compact-bar">' +
          '<span class="kc-drops-prog-track"><span class="kc-drops-prog-fill" style="width:' +
          (overallPct == null ? 0 : overallPct) +
          '%"></span></span>' +
          '</div>';
        // Durum TEK satırda: fmtProgressLine'ın "Hazır" eki ile compactLeft çakışmasın.
        // Hazırlık, yuvarlanmamış oranla belirlenir (yuvarlama 100% gösterip aslında eksik olabilir).
        let compactTime = '';
        let compactLeft = '';
        if (maxNeed > 0 && units != null) {
          if (rawRatio != null && rawRatio >= 1) {
            // tam doldu — fmtProgressLine'ın kendi "Hazır" yerine bizim durumumuz gösterilir
            compactTime = fmtUnits(Math.min(units, maxNeed)) + ' / ' + fmtUnits(maxNeed);
            compactLeft = 'Hazır · claim et';
          } else {
            compactTime = fmtProgressLine(units, maxNeed); // "X / Y · Z kaldı" içerir
            compactLeft = '';
          }
        } else if (maxNeed > 0) {
          compactTime = fmtUnits(maxNeed) + ' · ' + fmtRemain(maxNeed);
        }

        const checked = selected ? 'checked' : '';
        let badge;
        if (done) badge = '<span class="kc-drops-badge kc-drops-done">ALINDI</span>';
        else if (active) badge = '<span class="kc-drops-badge kc-drops-on">AKTİF</span>';
        else badge = '<span class="kc-drops-badge">YAKINDA</span>';

        // Summary: how many rewards done + overall toward highest requirement
        // Kompakt özet: [isim …… %] + genel çubuk + [süre/kalan]
        const doneN = rewards.filter((r) => r.claimed).length;
        let summary = '';
        if (active) {
          if (overallPct != null) {
            summary =
              '<span class="kc-drops-summary">' +
              doneN + '/' + rewards.length + ' · ' + overallPct + '%' +
              '</span>';
          } else if (selected && !hasProg) {
            summary =
              '<span class="kc-drops-summary kc-drops-summary-wait">' +
              (t('drops_prog_wait') || 'İlerleme yükleniyor…') +
              '</span>';
          }
        }

        const thumb = campaignThumbUrl(c);
        return (
          '<label class="kc-drops-item' +
          (active ? '' : ' kc-drops-upcoming') +
          (selected ? ' kc-drops-selected' : '') +
          (done ? ' kc-drops-done-item' : '') +
          '">' +
          '<span class="kc-drops-check">' +
          '<input type="checkbox" data-drop-id="' +
          c.id +
          '" ' +
          checked +
          (active ? '' : ' disabled') +
          '>' +
          '<span class="kc-drops-check-ui" aria-hidden="true"></span>' +
          '</span>' +
          (thumb
            ? '<img class="kc-drops-thumb" src="' +
              escapeHtml(thumb) +
              '" alt="" loading="lazy" decoding="async" referrerpolicy="no-referrer" onerror="this.style.display=\'none\'">'
            : '') +
          '<span class="kc-drops-meta">' +
          '<span class="kc-drops-top">' +
          '<span class="kc-drops-name">' +
          escapeHtml(c.name || 'Drop') +
          '</span>' +
          badge +
          '</span>' +
          (cat || org
            ? '<span class="kc-drops-cat">' +
              [cat, org].filter(Boolean).map(escapeHtml).join(' · ') +
              '</span>'
            : '') +
          (summary || '') +
          (active
            ? compactBar +
              (compactTime
                ? '<div class="kc-drops-compact-time">' +
                  '<span class="kc-drops-compact-prog">' + escapeHtml(compactTime) + '</span>' +
                  (compactLeft
                    ? '<span class="kc-drops-compact-left">' + escapeHtml(compactLeft) + '</span>'
                    : '') +
                  '</div>'
                : '')
            : '') +
          '</span></label>'
        );
      })
      .join('');
    host.querySelectorAll('input[data-drop-id]').forEach((inp) => {
      inp.addEventListener('change', () => {
        toggleCampaign(inp.getAttribute('data-drop-id'), inp.checked);
      });
    });
    try {
      renderDropsHud();
    } catch (_) {}
  }

  function escapeHtml(s) {
    return String(s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function resolveDropImage(url) {
    if (!url) return '';
    const s = String(url).trim();
    if (!s) return '';
    // v1.3.71: data:/blob: URL'leri OLDUĞU GİBİ bırak — CDN öneki eklemek onları bozuyordu
    if (/^data:/i.test(s) || /^blob:/i.test(s)) return s;
    if (/^https?:\/\//i.test(s)) return s;
    if (s.startsWith('//')) return 'https:' + s;
    // relative paths from Kick drops API → CDN
    return 'https://ext.cdn.kick.com/' + s.replace(/^\/+/, '');
  }

  function campaignThumbUrl(c) {
    if (!c) return '';
    const rewards = c.rewards || [];
    for (const r of rewards) {
      const u = resolveDropImage(r.image_url || r.image || '');
      if (u) return u;
    }
    const org = c.organization || {};
    const u2 = resolveDropImage(org.logo_url || org.logo || '');
    if (u2) return u2;
    const cat = c.category || {};
    return resolveDropImage(cat.image_url || cat.banner_image_url || '') || '';
  }

  // ── Detaylı izleme ilerleme paneli ──
  function buildLevelHudHtml() {
    let levelHtml = '';
    try {
      const L = KC.getLevelHudSnapshot && KC.getLevelHudSnapshot();
      const S = KC.getStreamStatusSnapshot && KC.getStreamStatusSnapshot();
      if (!(L || S)) return '';
      function esc(s) {
        return String(s == null ? '' : s)
          .replace(/&/g, '&amp;')
          .replace(/</g, '&lt;')
          .replace(/>/g, '&gt;')
          .replace(/"/g, '&quot;');
      }
      const statusLine = S ? S.status : L && L.status;
      const healthClass = S ? S.statusClass : L && L.healthClass;
      const slug = (S && S.channel) || (L && L.slug) || '—';
      // Şu an satırı kaldırıldı (kullanıcı isteği)
      levelHtml =
        '<div class="kc-combined-level">' +
        '<div class="kc-combined-level-head">Level</div>' +
        '<div class="kc-lhud-grid">' +
        '<div class="kc-lhud-row"><span class="k">Durum</span><span class="v ' +
        esc(healthClass || '') +
        '">' +
        esc(statusLine || (L && L.health) || '—') +
        '</span></div>';
      if (S) {
        const isStuck =
          S.statusClass === 'bad' ||
          S.statusClass === 'warn' ||
          (S.status && /takıl|yüklen|durak/i.test(S.status));
        // Tampon her zaman görünsün
        levelHtml +=
          '<div class="kc-lhud-row"><span class="k">Tampon</span><span class="v">' +
          esc((S.buffer || '—') + (S.bufferSec ? ' · ' + S.bufferSec : '')) +
          '</span></div>';
        if (isStuck && S.next && S.next !== '—' && S.next !== 'İzleniyor') {
          levelHtml +=
            '<div class="kc-lhud-row"><span class="k">Sıradaki</span><span class="v">' +
            esc(S.next) +
            '</span></div>';
        }
      }
      if (L) {
        levelHtml +=
          '<div class="kc-lhud-row"><span class="k">Oturum</span><span class="v">' +
          esc(L.session) +
          '</span></div>' +
          '<div class="kc-lhud-row"><span class="k">İzleme</span><span class="v">' +
          esc(L.watch) +
          '</span></div>';
      }
      levelHtml +=
        '</div>' +
        '<div class="kc-lhud-flags">' +
        '<span class="kc-flag' +
        (L && L.levelBot ? ' on' : '') +
        '">Level Bot</span>' +
        '<span class="kc-flag' +
        (L && L.antiStuck ? ' on' : '') +
        '">Anti-stuck</span>' +
        '<span class="kc-flag' +
        (L && L.bgWatch ? ' on' : '') +
        '">Aktif tut</span>' +
        '</div>' +
        '<button type="button" class="kc-btn-sm kc-lhud-next" data-dhud-next title="Sonraki yayına geç">Sonraki yayın</button>' +
        '</div>';
    } catch (_) {}
    return levelHtml;
  }


  /** Compact selectable campaign list for inside Drops HUD / panel */
  function buildInlineCampaignListHtml() {
    const ids = new Set(selectedIds());
    const list = campaigns
      .filter((c) => isActiveCampaign(c) && !isCampaignFullyClaimed(c))
      .slice()
      .sort((a, b) => (a.name || '').localeCompare(b.name || ''));
    if (!list.length) {
      return (
        '<div class="kc-inline-camps">' +
        '<div class="kc-inline-camps-head"><span>Kampanyalar</span>' +
        '<button type="button" class="kc-btn-sm kc-inline-refresh" data-inline-refresh title="Kampanyaları yenile">↻</button></div>' +
        '<div class="kc-inline-empty">Aktif kampanya yok</div></div>'
      );
    }
    const nSel = list.filter((c) => ids.has(String(c.id))).length;
    const rows = list
      .map((c) => {
        const selected = ids.has(String(c.id));
        const thumb = campaignThumbUrl(c);
        const merged = getMergedRewards(c);
        const rewards = merged.rewards;
        const units = merged.units;
        const maxNeed = rewards.reduce(
          (m, r) => Math.max(m, r.required_units || 0),
          0
        );
        const doneN = rewards.filter((r) => r.claimed).length;
        let pct = null;
        if (maxNeed > 0 && units != null) {
          pct = Math.max(0, Math.min(100, Math.round((units / maxNeed) * 100)));
        }
        const cat = (c.category && c.category.name) || '';
        return (
          '<label class="kc-inline-camp' +
          (selected ? ' is-on' : '') +
          '">' +
          '<input type="checkbox" data-drop-id="' +
          c.id +
          '" ' +
          (selected ? 'checked' : '') +
          '>' +
          (thumb
            ? '<img class="kc-inline-camp-img" src="' +
              escapeHtml(thumb) +
              '" alt="" loading="lazy" decoding="async" referrerpolicy="no-referrer" onerror="this.style.display=\'none\'">'
            : '<span class="kc-inline-camp-ph"></span>') +
          '<span class="kc-inline-camp-meta">' +
          '<span class="kc-inline-camp-name">' +
          escapeHtml(c.name || 'Drop') +
          '</span>' +
          '<span class="kc-inline-camp-sub">' +
          (cat ? escapeHtml(cat) + ' · ' : '') +
          doneN +
          '/' +
          rewards.length +
          (pct != null ? ' · ' + pct + '%' : '') +
          (maxNeed > 0 && units != null
            ? ' · ' + fmtRemain(Math.max(0, maxNeed - units))
            : maxNeed > 0
              ? ' · ' + fmtRemain(maxNeed)
              : '') +
          '</span></span></label>'
        );
      })
      .join('');
    return (
      '<div class="kc-inline-camps">' +
      '<div class="kc-inline-camps-head">' +
      '<span>Kampanyalar</span>' +
      '<span class="kc-inline-camps-count">' +
      nSel +
      '/' +
      list.length +
      '</span>' +
      '<button type="button" class="kc-btn-sm kc-inline-refresh" data-inline-refresh title="Kampanyaları yenile">↻</button>' +
      '<button type="button" class="kc-btn-sm kc-inline-all" data-inline-all>Tümü</button>' +
      '<button type="button" class="kc-btn-sm kc-inline-none" data-inline-none>Hiçbiri</button>' +
      '</div>' +
      '<div class="kc-inline-camps-list">' +
      rows +
      '</div></div>'
    );
  }

  function buildHudBodyHtml() {
    const dropsOn = !!KC.settings?.drops_enabled;
    const levelHtml = buildLevelHudHtml();

    // Drops kapalı → sadece level odaklı panel
    if (!dropsOn) {
      let live =
        '<div class="kc-prog-live">' +
        (KC.settings?.level_bot
          ? '<span class="kc-prog-dot on"></span> Level bot açık'
          : '<span class="kc-prog-dot"></span> Level modu · drop farm kapalı') +
        '</div>';
      try {
        const L = KC.getLevelHudSnapshot && KC.getLevelHudSnapshot();
        const S = KC.getStreamStatusSnapshot && KC.getStreamStatusSnapshot();
        const slug = (S && S.channel) || (L && L.slug) || '';
        const health = (S && S.status) || (L && L.health) || '';
        if (slug || health) {
          live =
            '<div class="kc-prog-live">' +
            (health && /takıl|hata|yok/i.test(health)
              ? '<span class="kc-prog-dot off"></span> '
              : '<span class="kc-prog-dot on"></span> ') +
            escapeHtml(health || 'İzleniyor') +
            (slug ? ' · <b>' + escapeHtml(slug) + '</b>' : '') +
            '</div>';
        }
      } catch (_) {}
      if (levelHtml) return live + levelHtml;
      return (
        live +
        '<div class="kc-prog-empty">' +
        '<div class="kc-prog-empty-ico">▶</div>' +
        '<div>Level bilgisi</div>' +
        '<div class="kc-prog-empty-hint">Bir kanal sayfasındayken durum burada görünür</div>' +
        '</div>'
      );
    }

    const selIds = new Set(selectedIds());
    let items = campaigns.filter(
      (c) => isActiveCampaign(c) && selIds.has(String(c.id)) && !isCampaignFullyClaimed(c)
    );
    if (!items.length) {
      items = campaigns
        .filter((c) => isActiveCampaign(c) && !isCampaignFullyClaimed(c))
        .slice(0, 3);
    }
    if (!items.length) {
      return (
        '<div class="kc-prog-live"><span class="kc-prog-dot"></span> Farm açık · kampanya seç</div>' +
        (levelHtml || '') +
        buildInlineCampaignListHtml()
      );
    }

    const slug = currentSlug();
    const controllingNow = !!controlling;
    let headerMeta =
      '<div class="kc-prog-live">' +
      (controllingNow
        ? '<span class="kc-prog-dot on"></span> İzleniyor' +
          (slug ? ' · <b>' + escapeHtml(slug) + '</b>' : '')
        : '<span class="kc-prog-dot"></span> Farm açık · uygun yayın aranıyor' + reasonHintHtml()) +
      '</div>';

    const cards = items
      .map((c) => {
        const merged = getMergedRewards(c);
        const rewards = merged.rewards;
        const units = merged.units;
        const hasProg = merged.hasProg;
        const done = isCampaignFullyClaimed(c);
        const maxNeed = rewards.reduce(
          (m, r) => Math.max(m, r.required_units || 0),
          0
        );
        const overall =
          done || maxNeed <= 0 || units == null
            ? done
              ? 100
              : null
            : Math.max(0, Math.min(100, Math.round((units / maxNeed) * 100)));
        const doneN = rewards.filter((r) => r.claimed).length;
        const left =
          maxNeed > 0 && units != null
            ? Math.max(0, maxNeed - units)
            : null;
        const cat = (c.category && c.category.name) || '';
        const cardThumb = campaignThumbUrl(c);

        const rew = rewards
          .map((r) => {
            const need = r.required_units || 0;
            const pct = rewardPct(units, need, r.claimed);
            const fill = pct == null ? 0 : pct;
            const rwImg = resolveDropImage(r.image_url || r.image || '');
            let timeLbl = '';
            let statusLbl = '';
            if (r.claimed) {
              statusLbl = 'ALINDI';
              timeLbl = need > 0 ? fmtUnits(need) : '';
            } else if (need > 0 && units != null) {
              const w = Math.min(units, need);
              const rem = Math.max(0, need - units);
              timeLbl = fmtUnits(w) + ' / ' + fmtUnits(need);
              statusLbl = rem > 0 ? fmtRemain(rem) : 'Hazır · claim et';
            } else if (need > 0) {
              timeLbl = '0 / ' + fmtUnits(need);
              statusLbl = hasProg ? 'Kalan ' + fmtUnits(need) : 'İlerleme yükleniyor…';
            }
            return (
              '<div class="kc-prog-rew' +
              (r.claimed ? ' is-done' : '') +
              (pct != null && pct >= 100 && !r.claimed ? ' is-ready' : '') +
              '">' +
              '<div class="kc-prog-rew-top">' +
              (rwImg
                ? '<img class="kc-prog-rew-img" src="' +
                  escapeHtml(rwImg) +
                  '" alt="" loading="lazy" decoding="async" referrerpolicy="no-referrer" onerror="this.style.display=\'none\'">'
                : '') +
              '<span class="kc-prog-rew-name">' +
              escapeHtml(r.name || 'Ödül') +
              '</span>' +
              '<span class="kc-prog-rew-pct">' + (pct == null ? (need > 0 ? '0%' : '—') : pct + '%') + '</span>' +
              '</div>' +
              '<div class="kc-prog-bar"><div class="kc-prog-bar-fill" style="width:' +
              fill +
              '%"></div><span class="kc-prog-bar-txt">' +
              (pct == null ? '—' : pct + '%') +
              '</span></div>' +
              '<div class="kc-prog-rew-meta">' +
              '<span>' +
              escapeHtml(timeLbl) +
              '</span>' +
              '<span class="kc-prog-rew-status">' +
              escapeHtml(statusLbl) +
              '</span></div></div>'
            );
          })
          .join('');

        return (
          '<div class="kc-prog-card' +
          (done ? ' is-done' : '') +
          '">' +
          '<div class="kc-prog-card-head">' +
          (cardThumb
            ? '<img class="kc-prog-card-img" src="' +
              escapeHtml(cardThumb) +
              '" alt="" loading="lazy" decoding="async" referrerpolicy="no-referrer" onerror="this.style.display=\'none\'">'
            : '') +
          '<div class="kc-prog-card-info">' +
          '<span class="kc-prog-card-name">' +
          escapeHtml(c.name || 'Drop') +
          '</span>' +
          (cat
            ? '<span class="kc-prog-card-cat">' + escapeHtml(cat) + '</span>'
            : '') +
          '</div>' +
          '<span class="kc-prog-card-pct">' + (overall != null ? overall + '%' : '—') + '</span>' +
          '</div>' +
          '<div class="kc-prog-card-body">' +
          '<div class="kc-prog-bar"><div class="kc-prog-bar-fill" style="width:' +
          (overall != null ? overall : 0) +
          '%"></div><span class="kc-prog-bar-txt">' +
          (overall != null ? overall + '%' : '—') +
          '</span></div>' +
          '<div class="kc-prog-card-sum">' +
          doneN +
          '/' +
          rewards.length +
          ' ödül' +
          (left != null && !done
            ? ' · ' + fmtRemain(left)
            : done
              ? ' · tamam'
              : hasProg
                ? ''
                : ' · ilerleme…') +
          (units != null && maxNeed > 0 && !done
            ? '<br><span class="kc-prog-card-eta">' +
              fmtUnits(Math.min(units, maxNeed)) +
              ' / ' +
              fmtUnits(maxNeed) +
              ' izlendi</span>'
            : '') +
          '</div>' +
          '<div class="kc-prog-rews">' +
          rew +
          '</div></div></div>'
        );
      })
      .join('');

    return (
      headerMeta +
      '<div class="kc-prog-cards">' +
      cards +
      '</div>' +
      levelHtml +
      buildInlineCampaignListHtml()
    );
  }

  /** "aranıyor" durumunda nedeni küçük gri yazıyla göster */
  function reasonHintHtml() {
    const r = lastQualReason;
    if (!r || r === 'no-slug') return '';
    const map = {
      'api-error': 'kanal bilgisi alınamadı (ağ)', offline: 'kanal çevrimdışı', 'wrong-category': 'yanlış kategori',
      'category-changed': 'kategori değişti', 'not-partner': 'kanal kampanya listesinde değil', 'no-match': 'kampanyaya uymuyor'
    };
    const txt = map[r] || (/^api-\d+$/.test(r) ? 'kanal API ' + r.slice(4) : r);
    return ' <span style="opacity:.6">(' + escapeHtml(txt) + ')</span>';
  }

  function renderDropsHud() {
    if (KC.settings?.drops_hud === false) return;
    const body = document.getElementById('kc-dhud-body');
    if (!body) return;
    const hud = document.getElementById('kc-drops-hud');
    if (hud) {
      hud.classList.toggle('kc-hud-compact', !!KC.settings?.hud_compact);
    }
    const st = document.getElementById('kc-dhud-status');
    if (st && st.textContent !== (statusText || '')) st.textContent = statusText || '';
    const html = buildHudBodyHtml();
    // İçerik değişmediyse DOM'a dokunma (takılma / görsel yeniden yükleme / scroll sıfırlanması yok)
    if (body.__kcHtml === html && body.childNodes.length) return;
    const scrollTop = body.scrollTop;
    body.__kcHtml = html;
    body.innerHTML = html;
    body.scrollTop = scrollTop;
    // Inline kampanya seçimi
    body.querySelectorAll('input[data-drop-id]').forEach((inp) => {
      inp.addEventListener('change', () => {
        toggleCampaign(inp.getAttribute('data-drop-id'), inp.checked);
        try { renderDropsHud(); } catch (_) {}
        try { renderCampaignList(); } catch (_) {}
      });
    });
    const refBtn = body.querySelector('[data-inline-refresh]');
    if (refBtn) {
      refBtn.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        pollAndClaim().catch(() => {});
        doRefreshCampaigns();
      });
    }
    const allBtn = body.querySelector('[data-inline-all]');
    if (allBtn) {
      allBtn.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        const ids = campaigns
          .filter((c) => isActiveCampaign(c) && !isCampaignFullyClaimed(c))
          .map((c) => String(c.id));
        KC.saveSetting('drops_selected', ids);
        try { renderDropsHud(); } catch (_) {}
        try { renderCampaignList(); } catch (_) {}
      });
    }
    const noneBtn = body.querySelector('[data-inline-none]');
    if (noneBtn) {
      noneBtn.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        KC.saveSetting('drops_selected', []);
        try { renderDropsHud(); } catch (_) {}
        try { renderCampaignList(); } catch (_) {}
      });
    }
    try {
      KC.renderDropsHud = renderDropsHud;
    } catch (_) {}
  }
  try {
    KC.renderDropsHud = renderDropsHud;
  } catch (_) {}


  function setHudCollapsed(collapsed) {
    const hud = document.getElementById('kc-drops-hud');
    if (!hud) return;
    hud.classList.toggle('kc-dhud-collapsed', !!collapsed);
    KC.saveSetting('drops_hud_collapsed', !!collapsed);
  }


  function buildSwitchLogRows() {
    const max = KC.switchLogMax();
    const log = Array.isArray(KC.settings?.switch_log) ? KC.settings.switch_log : [];
    if (!log.length) return '<div class="kc-slog-empty">Henüz kanal değişimi yok</div>';
    return log
      .slice(0, max)
      .map((e) => {
        const d = new Date(e.at || 0);
        const time = d.toLocaleTimeString(undefined, {
          hour: '2-digit',
          minute: '2-digit',
          second: '2-digit'
        });
        const c = KC.classifyReason(e.reason);
        return (
          '<div class="kc-slog-row" style="border-left-color:' + c.color + '">' +
          '<span class="kc-slog-time">' + time + '</span>' +
          '<span class="kc-slog-badge" style="color:' + c.color + ';border-color:' + c.color + '">' +
          escapeHtml(c.label) + '</span>' +
          '<span class="kc-slog-path">' + escapeHtml((e.from || '?') + ' → ' + (e.to || '?')) + '</span>' +
          '</div>'
        );
      })
      .join('');
  }

  function updateSwitchLogTitle() {
    const el = document.getElementById('kc-slog-title');
    if (el) el.textContent = 'Son geçişler (max ' + KC.switchLogMax() + ')';
  }

  function renderSwitchLogBody() {
    const body = document.getElementById('kc-slog-body');
    if (body) body.innerHTML = buildSwitchLogRows();
    updateSwitchLogTitle();
  }

  function exportSwitchLog() {
    const log = Array.isArray(KC.settings?.switch_log) ? KC.settings.switch_log : [];
    if (!log.length) return;
    const q = (v) => '"' + String(v == null ? '' : v).replace(/"/g, '""') + '"';
    const lines = ['Tarih,Nereden,Nereye,Neden,Kod'];
    log.forEach((e) => {
      const c = KC.classifyReason(e.reason);
      lines.push(
        [new Date(e.at || 0).toLocaleString(), e.from || '', e.to || '', c.label, e.reason || '']
          .map(q)
          .join(',')
      );
    });
    const blob = new Blob(['\ufeff' + lines.join('\r\n')], { type: 'text/csv;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'gecis-logu-' + new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-') + '.csv';
    document.documentElement.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 2000);
  }

  function setSwitchLogCollapsed(collapsed) {
    const panel = document.getElementById('kc-switch-log');
    if (!panel) return;
    panel.classList.toggle('kc-slog-collapsed', !!collapsed);
    KC.saveSetting('switch_log_collapsed', !!collapsed);
  }

  function closeSwitchLogPanel() {
    document.getElementById('kc-switch-log')?.remove();
    KC.saveSetting('switch_log_open', false);
  }

  function openSwitchLogPanel() {
    if (document.getElementById('kc-switch-log')) return;
    const panel = document.createElement('div');
    panel.id = 'kc-switch-log';
    let dropIco = '';
    try { dropIco = chrome.runtime.getURL('icons/drop-24.png'); } catch (_) {}
    panel.innerHTML =
      '<div class="kc-slog-head" id="kc-slog-head">' +
      '<button type="button" class="kc-slog-btn" data-slog-toggle title="Aç / Kapat"><i class="kc-fold"></i></button>' +
      (dropIco ? '<img class="kc-ico" src="' + dropIco + '" alt="">' : '') +
      '<span class="kc-slog-title" id="kc-slog-title">Son geçişler (max 10)</span>' +
      '<div class="kc-slog-actions">' +
      '<button type="button" class="kc-slog-btn" data-slog-close title="Kapat">×</button>' +
      '</div></div>' +
      '<div class="kc-slog-tools">' +
      '<label class="kc-slog-limit">Limit ' +
      '<select id="kc-slog-limit">' +
      KC.SWITCH_LOG_LIMITS.map((n) => '<option value="' + n + '">' + n + '</option>').join('') +
      '</select></label>' +
      '<span class="kc-slog-spacer"></span>' +
      '<button type="button" class="kc-slog-tbtn" data-slog-export>Dışa aktar</button>' +
      '<button type="button" class="kc-slog-tbtn" data-slog-clear>Temizle</button>' +
      '</div>' +
      '<div class="kc-slog-body" id="kc-slog-body"></div>';
    document.documentElement.appendChild(panel);
    const sel = panel.querySelector('#kc-slog-limit');
    if (sel) {
      sel.value = String(KC.switchLogMax());
      sel.addEventListener('change', () => {
        const n = parseInt(sel.value, 10);
        KC.saveSetting('switch_log_max', n);
        const log = Array.isArray(KC.settings?.switch_log) ? KC.settings.switch_log : [];
        if (log.length > n) KC.saveSetting('switch_log', log.slice(0, n));
        renderSwitchLogBody();
      });
    }
    renderSwitchLogBody();

    // Kaydedilen konum — taşınınca yerinde kalır
    if (KC.applyPos) KC.applyPos(panel, 'pos_switch_log', { x: 276, y: 80 });
    if (KC.makeDraggable) KC.makeDraggable(panel, panel.querySelector('#kc-slog-head'), 'pos_switch_log');

    panel.classList.toggle('kc-slog-collapsed', !!KC.settings?.switch_log_collapsed);

    panel.addEventListener('click', (e) => {
      const b = e.target.closest('[data-slog-toggle],[data-slog-close],[data-slog-clear],[data-slog-export]');
      if (!b) return;
      e.preventDefault();
      e.stopPropagation();
      if (b.hasAttribute('data-slog-close')) closeSwitchLogPanel();
      else if (b.hasAttribute('data-slog-clear')) {
        KC.saveSetting('switch_log', []);
        renderSwitchLogBody();
      } else if (b.hasAttribute('data-slog-export')) exportSwitchLog();
      else setSwitchLogCollapsed(!panel.classList.contains('kc-slog-collapsed'));
    });
    KC.saveSetting('switch_log_open', true);
  }

  function showSwitchLogPanel() {
    if (document.getElementById('kc-switch-log')) closeSwitchLogPanel();
    else openSwitchLogPanel();
  }

  function ensureDropsHud() {
    // Ayar kapalıysa HUD ve log paneli gösterilmez
    if (KC.settings?.drops_hud === false) {
      document.getElementById('kc-drops-hud')?.remove();
      document.getElementById('kc-switch-log')?.remove();
      return;
    }
    let hud = document.getElementById('kc-drops-hud');
    // Eski bozuk markup varsa yeniden kur
    if (hud && !hud.querySelector('.kc-dhud-actions')) {
      try { hud.remove(); } catch (_) {}
      hud = null;
    }
    if (!hud) {
      hud = document.createElement('div');
      hud.id = 'kc-drops-hud';
      let dropIco = '';
      try { dropIco = chrome.runtime.getURL('icons/drop-24.png'); } catch (_) {}
      hud.innerHTML =
        '<div class="kc-dhud-head" id="kc-dhud-head">' +
        '<button type="button" class="kc-dhud-btn" data-dhud-toggle title="Aç / Kapat"><i class="kc-fold"></i></button>' +
        (dropIco ? '<img class="kc-ico" src="' + dropIco + '" alt="">' : '') +
        '<span class="kc-dhud-title">Drops · Level</span>' +
        '</div>' +
        '<div class="kc-dhud-actions kc-dhud-bar">' +
        '<button type="button" class="kc-dhud-btn kc-dhud-next" data-dhud-next title="Sonraki yayına geç">Sonraki</button>' +
        '<button type="button" class="kc-dhud-btn" data-dhud-camps title="Kampanya seç">Kampanya</button>' +
        '<button type="button" class="kc-dhud-btn" data-dhud-compact title="Kompakt / Detay">Kompakt</button>' +
        '<button type="button" class="kc-dhud-btn" data-dhud-log title="Geçiş logu">Log</button>' +
        '<button type="button" class="kc-dhud-btn" data-dhud-refresh title="Yenile">Yenile</button>' +
        '</div>' +
        '<div class="kc-dhud-sub" id="kc-dhud-status"></div>' +
        '<div class="kc-dhud-body" id="kc-dhud-body"></div>';
      document.documentElement.appendChild(hud);

      // Konum: her zaman kaydedilen yerde aç
      hud.style.position = 'fixed';
      if (KC.applyPos) {
        KC.applyPos(hud, 'pos_drops_hud', { x: 16, y: 80 });
      } else {
        const pos = KC.settings?.pos_drops_hud;
        if (pos && pos.x != null && pos.y != null) {
          hud.style.left = pos.x + 'px';
          hud.style.top = pos.y + 'px';
          hud.style.right = 'auto';
          hud.style.bottom = 'auto';
        } else {
          hud.style.left = '16px';
          hud.style.top = '80px';
          hud.style.right = 'auto';
          hud.style.bottom = 'auto';
        }
      }

      if (KC.makeDraggable) {
        KC.makeDraggable(hud, hud.querySelector('#kc-dhud-head'), 'pos_drops_hud');
      } else {
        const head = hud.querySelector('#kc-dhud-head');
        if (head && head.getAttribute('data-kc-drag') !== '1') {
          head.setAttribute('data-kc-drag', '1');
          let drag = null;
          head.addEventListener('mousedown', (e) => {
            if (e.target.closest('button')) return;
            const r = hud.getBoundingClientRect();
            drag = { x: e.clientX - r.left, y: e.clientY - r.top };
            e.preventDefault();
          });
          window.addEventListener('mousemove', (e) => {
            if (!drag) return;
            let x = e.clientX - drag.x;
            let y = e.clientY - drag.y;
            x = Math.max(0, Math.min(window.innerWidth - 40, x));
            y = Math.max(0, Math.min(window.innerHeight - 40, y));
            hud.style.left = x + 'px';
            hud.style.top = y + 'px';
            hud.style.right = 'auto';
            hud.style.bottom = 'auto';
          });
          window.addEventListener('mouseup', () => {
            if (!drag) return;
            drag = null;
            const r = hud.getBoundingClientRect();
            KC.saveSetting('pos_drops_hud', { x: r.left, y: r.top });
          });
        }
      }

      hud.addEventListener('click', (e) => {
        const btn = e.target.closest(
          '[data-dhud-toggle],[data-dhud-refresh],[data-dhud-hide],[data-dhud-compact],[data-dhud-log],[data-dhud-next],[data-dhud-camps]'
        );
        if (!btn) return;
        e.preventDefault();
        e.stopPropagation();
        if (btn.hasAttribute('data-dhud-toggle')) {
          setHudCollapsed(!hud.classList.contains('kc-dhud-collapsed'));
        } else if (btn.hasAttribute('data-dhud-compact')) {
          const next = !KC.settings?.hud_compact;
          KC.saveSetting('hud_compact', next);
          renderDropsHud();
        } else if (btn.hasAttribute('data-dhud-log')) {
          showSwitchLogPanel();
        } else if (btn.hasAttribute('data-dhud-refresh')) {
          pollAndClaim().catch(() => {});
          doRefreshCampaigns();
        } else if (btn.hasAttribute('data-dhud-next')) {
          try {
            setStatus((t('next_stream') || 'Sonraki yayına geç') + '…');
            if (typeof KC.forceNextStream === 'function') {
              Promise.resolve(KC.forceNextStream('manual-hud')).catch((err) =>
                KCwarn('[KC] next stream', err)
              );
            } else if (typeof KC.forceSwitchChannel === 'function') {
              KC.forceSwitchChannel();
            } else {
              KCwarn('[KC] next stream API yok');
            }
          } catch (err) {
            KCwarn('[KC] next stream', err);
          }
        } else if (btn.hasAttribute('data-dhud-camps')) {
          openCampaignPicker();
        } else if (btn.hasAttribute('data-dhud-hide')) {
          // HUD kalıcı — sadece küçült
          setHudCollapsed(true);
        }
      });
    }
    // Eski HUD'a sonraki butonu ekle
    try {
      const acts = hud.querySelector('.kc-dhud-actions');
      if (acts && !acts.querySelector('[data-dhud-next]')) {
        const b = document.createElement('button');
        b.type = 'button';
        b.className = 'kc-dhud-btn kc-dhud-next';
        b.setAttribute('data-dhud-next', '');
        b.title = 'Sonraki yayına geç';
        b.textContent = 'Sonraki';
        acts.insertBefore(b, acts.firstChild);
      }
    } catch (_) {}
    // Mevcut HUD ise de konumu uygula
    if (KC.applyPos) {
      try { KC.applyPos(hud, 'pos_drops_hud', { x: 16, y: 80 }); } catch (_) {}
    }
    if (KC.settings?.drops_hud_collapsed) {
      hud.classList.add('kc-dhud-collapsed');
    }
    // Log paneli önceden açıksa tekrar aç
    if (KC.settings?.switch_log_open && !document.getElementById('kc-switch-log')) {
      openSwitchLogPanel();
    }
    renderDropsHud();
  }


  function updateSelSummary() {
    const el = document.getElementById('kc-drops-sel-summary');
    if (!el) return;
    const ids = selectedIds();
    const n = ids.length;
    if (!n) {
      el.textContent = 'Kampanya seçilmedi · “Kampanya seç”e tıkla';
      return;
    }
    const names = campaigns
      .filter((c) => ids.includes(String(c.id)))
      .map((c) => c.name || c.id)
      .slice(0, 3);
    el.textContent =
      n +
      ' kampanya seçili' +
      (names.length ? ': ' + names.join(', ') : '') +
      (n > 3 ? '…' : '');
  }

  function closeCampaignPicker() {
    document.getElementById('kc-camp-picker')?.remove();
    document.getElementById('kc-camp-backdrop')?.remove();
    // v1.3.72: dar ekranda gizlenen ana menüyü geri getir
    try {
      const menu = document.getElementById('kc-menu');
      if (menu && menu.hasAttribute('data-kc-hidden-by-picker')) {
        menu.removeAttribute('data-kc-hidden-by-picker');
        menu.style.visibility = '';
      }
    } catch (_) {}
    try {
      KC.saveSetting('camp_picker_open', false);
    } catch (_) {}
  }

  function openCampaignPicker() {
    // Toggle: already open → close
    if (document.getElementById('kc-camp-picker')) {
      closeCampaignPicker();
      return;
    }

    const panel = document.createElement('div');
    panel.id = 'kc-camp-picker';
    panel.className = 'kc-camp-panel';
    let dropIco = '';
    try {
      dropIco = chrome.runtime.getURL('icons/drop-24.png');
    } catch (_) {}

    panel.innerHTML =
      '<div class="kc-camp-head" id="kc-camp-head">' +
      '<button type="button" class="kc-dhud-btn" data-camp-toggle title="Aç / Kapat"><i class="kc-fold"></i></button>' +
      (dropIco ? '<img class="kc-ico" src="' + dropIco + '" alt="">' : '') +
      '<span class="kc-camp-title">Kampanyalar</span>' +
      '<div class="kc-dhud-actions" style="display:flex;margin-left:auto">' +
      '<button type="button" class="kc-dhud-btn" data-camp-refresh title="Yenile">↻</button>' +
      '<button type="button" class="kc-dhud-btn" data-camp-close title="Kapat">×</button>' +
      '</div></div>' +
      '<div class="kc-camp-sub" id="kc-camp-count">0 seçili</div>' +
      '<div class="kc-camp-body" id="kc-camp-body">' +
      '<div class="kc-camp-toolbar">' +
      '<input type="search" id="kc-camp-search" class="kc-camp-search" placeholder="Ara…" autocomplete="off" />' +
      '<button type="button" class="kc-btn-sm" data-camp-all title="Tümünü seç">Tümü</button>' +
      '<button type="button" class="kc-btn-sm" data-camp-none title="Seçimi temizle">Hiçbiri</button>' +
      '</div>' +
      '<div class="kc-camp-list" id="kc-camp-list"></div>' +
      '<div class="kc-camp-foot">' +
      '<button type="button" class="kc-btn kc-btn-primary" data-camp-done style="width:100%">Tamam</button>' +
      '</div></div>';

    document.documentElement.appendChild(panel);

    // Panelin ekrana sığmasını sağla — konum ekrana taşıyorsa içeri çek.
    // v1.3.70: modül kapsamına taşındı; renderCampaignList sonrası her güncellemede de çağrılır
    // (panel açıkken liste uzarsa / yenilenirse tekrar ölçülür).

    // Position like Drops HUD (saved / default right side)
    panel.style.position = 'fixed';
    if (KC.applyPos) {
      KC.applyPos(panel, 'pos_camp_picker', { x: 16, y: 360 });
    } else {
      const pos = KC.settings?.pos_camp_picker;
      if (pos && pos.x != null) {
        panel.style.left = pos.x + 'px';
        panel.style.top = pos.y + 'px';
        panel.style.right = 'auto';
      } else {
        panel.style.left = '16px';
        panel.style.top = '360px';
        panel.style.right = 'auto';
      }
    }
    fitPickerToViewport();
    // İçerik render edilince panel büyür — tekrar ölç
    setTimeout(fitPickerToViewport, 50);
    if (KC.makeDraggable) {
      KC.makeDraggable(panel, panel.querySelector('#kc-camp-head'), 'pos_camp_picker');
    } else {
      // minimal drag fallback
      const head = panel.querySelector('#kc-camp-head');
      let drag = null;
      head.addEventListener('pointerdown', (e) => {
        if (e.target.closest('button')) return;
        drag = { x: e.clientX, y: e.clientY, l: panel.offsetLeft, t: panel.offsetTop };
        head.setPointerCapture(e.pointerId);
      });
      head.addEventListener('pointermove', (e) => {
        if (!drag) return;
        panel.style.left = drag.l + (e.clientX - drag.x) + 'px';
        panel.style.top = drag.t + (e.clientY - drag.y) + 'px';
        panel.style.right = 'auto';
      });
      head.addEventListener('pointerup', () => {
        if (!drag) return;
        drag = null;
        const r = panel.getBoundingClientRect();
        try {
          KC.saveSetting('pos_camp_picker', { x: r.left, y: r.top });
        } catch (_) {}
      });
    }

    function refreshCount() {
      const el = document.getElementById('kc-camp-count');
      const n = selectedIds().length;
      if (el) {
        el.textContent =
          n === 0 ? 'Kampanya seçilmedi' : n + ' kampanya seçili · farm için işaretle';
      }
      updateSelSummary();
    }

    function setCollapsed(collapsed) {
      panel.classList.toggle('kc-camp-collapsed', !!collapsed);
      try {
        KC.saveSetting('camp_picker_collapsed', !!collapsed);
      } catch (_) {}
    }

    panel.addEventListener('click', (e) => {
      const b = e.target.closest(
        '[data-camp-close],[data-camp-refresh],[data-camp-done],[data-camp-all],[data-camp-none],[data-camp-toggle]'
      );
      if (!b) return;
      e.preventDefault();
      e.stopPropagation();
      if (b.hasAttribute('data-camp-close') || b.hasAttribute('data-camp-done')) {
        closeCampaignPicker();
        updateSelSummary();
      } else if (b.hasAttribute('data-camp-toggle')) {
        setCollapsed(!panel.classList.contains('kc-camp-collapsed'));
      } else if (b.hasAttribute('data-camp-refresh')) {
        doRefreshCampaigns();
        setTimeout(refreshCount, 400);
      } else if (b.hasAttribute('data-camp-all')) {
        const ids = campaigns
          .filter((c) => isActiveCampaign(c) && !isCampaignFullyClaimed(c))
          .map((c) => String(c.id));
        KC.saveSetting('drops_selected', ids);
        renderCampaignList();
        refreshCount();
      } else if (b.hasAttribute('data-camp-none')) {
        KC.saveSetting('drops_selected', []);
        renderCampaignList();
        refreshCount();
      }
    });

    const search = panel.querySelector('#kc-camp-search');
    if (search) {
      search.addEventListener('input', () => {
        const q = (search.value || '').trim().toLowerCase();
        panel.querySelectorAll('.kc-drops-item, .kc-camp-item').forEach((row) => {
          const txt = (row.textContent || '').toLowerCase();
          row.style.display = !q || txt.includes(q) ? '' : 'none';
        });
      });
    }

    panel.addEventListener('change', (e) => {
      if (e.target && e.target.matches && e.target.matches('input[data-drop-id]')) {
        refreshCount();
      }
    });

    if (KC.settings?.camp_picker_collapsed) setCollapsed(true);

    renderCampaignList();
    refreshCount();
    fitPickerToViewport(); // içerik render sonrası yeniden ölç
    fetchCampaigns(true).then(() => {
      renderCampaignList();
      refreshCount();
      fitPickerToViewport(); // taze veri geldi — tekrar ölç
    });

    try {
      KC.saveSetting('camp_picker_open', true);
    } catch (_) {}
  }

  try {
    KC.openCampaignPicker = openCampaignPicker;
  } catch (_) {}

  function ensurePanelSection() {
    const body = document.getElementById('kc-panel-body');
    if (!body || document.getElementById('kc-drops-section')) return;

    const levelLabel = body.querySelector('.kc-section-label');
    // Insert after level section if possible
    const sec = document.createElement('div');
    sec.id = 'kc-drops-section';
    sec.innerHTML =
      '<div class="kc-section-label">' +
      (t('drops_section') || 'Drops') +
      '</div>' +
      '<label class="kc-row"><span>' +
      (t('drops_enabled') || 'Drop izle') +
      '<span class="kc-row-hint">' +
      (t('drops_enabled_hint') ||
        'Seçtiğin kampanyalara uygun canlı yayınlara otomatik geçer') +
      '</span></span>' +
      '<input type="checkbox" data-k="drops_enabled" id="kc-drops-enabled-cb"' +
      (KC.settings?.drops_enabled ? ' checked' : '') +
      '></label>' +
      '<label class="kc-row"><span>' +
      (t('drops_auto_claim') || 'Otomatik al') +
      '<span class="kc-row-hint">' +
      (t('drops_auto_claim_hint') ||
        'Ödül claimable olunca otomatik alır (giriş gerekli)') +
      '</span></span>' +
      '<input type="checkbox" data-k="drops_auto_claim" id="kc-drops-auto-claim-cb"' +
      (KC.settings?.drops_auto_claim !== false ? ' checked' : '') +
      '></label>' +
      '<label class="kc-row"><span>' +
      (t('drops_hud') || 'Drop paneli') +
      '<span class="kc-row-hint">' +
      (t('drops_hud_hint') ||
        'Ekranda sürekli drop ilerlemesi (sürükle / aç-kapa)') +
      '</span></span>' +
      '<input type="checkbox" data-k="drops_hud" id="kc-drops-hud-cb"' +
      (KC.settings?.drops_hud !== false ? ' checked' : '') +
      '></label>' +
      '<div class="kc-drops-status" id="kc-drops-status">' +
      statusText +
      '</div>' +
      '<div class="kc-drops-claim-status" id="kc-drops-claim-status">' +
      (lastClaimMsg || t('drops_claim_idle') || 'Claim bekleniyor…') +
      '</div>' +
      '<div class="kc-drops-actions">' +
      '<button type="button" class="kc-btn" id="kc-drops-claim-now">' +
      (t('drops_claim_now') || 'Şimdi al') +
      '</button>' +
      '</div>' +
      '<div class="kc-drops-list" id="kc-drops-list"></div>' +
      '<div class="kc-drops-sel-summary" id="kc-drops-sel-summary"></div>';

    // Place after level section rows
    const labels = body.querySelectorAll('.kc-section-label');
    let insertAfter = null;
    for (const lab of labels) {
      if (/level/i.test(lab.textContent || '')) {
        insertAfter = lab;
        // advance past level rows
        let n = lab.nextElementSibling;
        while (n && !n.classList.contains('kc-section-label')) {
          insertAfter = n;
          n = n.nextElementSibling;
        }
        break;
      }
    }
    if (insertAfter && insertAfter.parentNode === body) {
      insertAfter.insertAdjacentElement('afterend', sec);
    } else {
      body.appendChild(sec);
    }

    const cb = sec.querySelector('#kc-drops-enabled-cb');
    if (cb) {
      cb.addEventListener('change', () => {
        KC.saveSetting('drops_enabled', !!cb.checked);
      });
    }
    const ac = sec.querySelector('#kc-drops-auto-claim-cb');
    if (ac) {
      ac.addEventListener('change', () => {
        KC.saveSetting('drops_auto_claim', !!ac.checked);
        if (ac.checked) startClaimLoop();
      });
    }
    const hudCb = sec.querySelector('#kc-drops-hud-cb');
    if (hudCb) {
      hudCb.addEventListener('change', () => {
        KC.saveSetting('drops_hud', !!hudCb.checked);
        ensureDropsHud();
      });
    }
    const openPick = sec.querySelector('#kc-drops-open-picker');
    if (openPick) {
      openPick.addEventListener('click', () => {
        openCampaignPicker();
      });
    }
    const claimBtn = sec.querySelector('#kc-drops-claim-now');
    if (claimBtn) {
      claimBtn.addEventListener('click', () => {
        claimBtn.disabled = true;
        pollAndClaim()
          .then(() => {
            claimBtn.disabled = false;
          })
          .catch(() => {
            claimBtn.disabled = false;
          });
      });
    }
    renderCampaignList();
    updateSelSummary();
  }

  // Public API — level-bot checks shouldControl() before switching
  // Dashboard için: kampanya + ödül ilerlemesi (dakika cinsinden)
  KC.getDropsSnapshot = () => {
    const selIds = new Set(selectedIds());
    const mk = (c) => {
      const m = getMergedRewards(c);
      const maxNeed = m.rewards.reduce((a, r) => Math.max(a, r.required_units || 0), 0);
      const done = isCampaignFullyClaimed(c);
      const overall = done ? 100 : maxNeed > 0 && m.units != null ? Math.max(0, Math.min(100, Math.round((m.units / maxNeed) * 100))) : null;
      return {
        id: String(c.id), name: c.name || String(c.id), category: (c.category && c.category.name) || '',
        selected: selIds.has(String(c.id)), done, units: m.units, maxNeed, overall, hasProg: m.hasProg,
        rewards: m.rewards.map((r) => ({
          name: r.name, need: r.required_units || 0, claimed: !!r.claimed,
          pct: rewardPct(m.units, r.required_units || 0, r.claimed),
          watched: m.units == null ? 0 : Math.min(m.units, r.required_units || 0)
        }))
      };
    };
    return {
      enabled: !!KC.settings?.drops_enabled, controlling: !!controlling, hasTargets: !!hasLiveTargets,
      slug: currentSlug(), reason: lastQualReason, status: statusText, selectedCount: selIds.size, claimedThisSession: claimedIds.size,
      campaigns: campaigns.filter((c) => isActiveCampaign(c)).map(mk)
    };
  };
  KC.claimNow = () => pollAndClaim();
  KC.showSwitchLog = () => showSwitchLogPanel();
  KC.startDrops = start;
  KC.stopDrops = stop;
  KC.getDropsStatus = () => statusText;
  KC.refreshDrops = () => fetchCampaigns(true);
  KC.forceDropSwitch = () => goNextDropStream('manual');
  KC.dropsShouldControl = shouldControl;
  KC.dropsHasTargets = () => !!hasLiveTargets;
  KC.dropsIsControlling = () => !!controlling;

  KC.settingsReady.then(() => {
    if (!Array.isArray(KC.settings.drops_selected)) {
      KC.settings.drops_selected = [];
    }
    // F5 sonrası HUD / paneller kampanya isteğini beklemeden kaydedilen yerde geri gelsin
    try { ensureDropsHud(); } catch (_) {}
    try {
      if (KC.settings.camp_picker_open && !document.getElementById('kc-camp-picker')) openCampaignPicker();
    } catch (_) {}
    // HUD bilgisi her zaman taze kalsın
    startClaimLoop();
    // Restore selection (prune expired ids, keep Daily Drop by name across day rollover)
    fetchCampaigns(true).then((list) => {
      reconcileSelection(list);
      ensurePanelSection();
      ensureDropsHud();
      // Re-bind checkbox states from persisted settings
      const en = document.getElementById('kc-drops-enabled-cb');
      if (en) en.checked = !!KC.settings.drops_enabled;
      const ac = document.getElementById('kc-drops-auto-claim-cb');
      if (ac) ac.checked = KC.settings.drops_auto_claim !== false;
      const hudCbInit = document.getElementById('kc-drops-hud-cb');
      if (hudCbInit) hudCbInit.checked = KC.settings.drops_hud !== false;
      renderCampaignList();
      renderDropsHud();

      if (KC.settings.drops_enabled) {
        start();
        // Ana sayfa / F5: kanalda değilsek hemen drop yayınına geç
        setTimeout(() => {
          if (!KC.settings?.drops_enabled) return;
          if (!selectedCampaigns().length) return;
          const slug = currentSlug();
          if (!slug) {
            goNextDropStream('boot-home').catch(() => {});
          } else {
            currentStreamQualifies().then((q) => {
              if (!q || !q.ok) goNextDropStream('boot-wrong').catch(() => {});
            });
          }
        }, 2500);
      } else {
        setStatus(t('drops_off') || 'Kapalı');
        if (KC.settings.drops_auto_claim !== false || KC.settings.drops_hud !== false)
          startClaimLoop();
      }
    });
  });

  KC.on('setting:drops_enabled', (on) => {
    if (on) {
      // Açılınca seçim boşsa Daily Drop’ları otomatik işaretle
      try {
        reconcileSelection(campaigns);
      } catch (_) {}
      start();
      setTimeout(() => {
        if (!currentSlug()) goNextDropStream('enable').catch(() => {});
      }, 1200);
    } else stop();
    const cb = document.getElementById('kc-drops-enabled-cb');
    if (cb) cb.checked = !!on;
  });

  KC.on('setting:drops_auto_claim', (on) => {
    const ac = document.getElementById('kc-drops-auto-claim-cb');
    if (ac) ac.checked = !!on;
    if (on) startClaimLoop();
    else if (!KC.settings?.drops_enabled) {
      if (claimTimer) clearInterval(claimTimer);
      claimTimer = null;
    }
  });

  KC.on('setting:drops_selected', () => {
    renderCampaignList();
  });

  KC.on('setting:pos_drops_hud', () => {
    const hud = document.getElementById('kc-drops-hud');
    if (hud && KC.applyPos) KC.applyPos(hud, 'pos_drops_hud');
  });
  KC.on('settings:sync', () => {
    const hud = document.getElementById('kc-drops-hud');
    if (hud && KC.applyPos) KC.applyPos(hud, 'pos_drops_hud');
  });

  KC.on('setting:drops_hud', (on) => {
    const cb = document.getElementById('kc-drops-hud-cb');
    if (cb) cb.checked = on !== false;
    ensureDropsHud();
  });

  KC.on('setting:switch_log', () => {
    try { renderSwitchLogBody(); } catch (_) {}
  });
  KC.on('setting:switch_log_max', () => {
    const sel = document.getElementById('kc-slog-limit');
    if (sel) sel.value = String(KC.switchLogMax());
    try { renderSwitchLogBody(); } catch (_) {}
  });
  KC.on('setting:pos_switch_log', () => {
    const p = document.getElementById('kc-switch-log');
    if (p && KC.applyPos) KC.applyPos(p, 'pos_switch_log');
  });


  function flashRefreshBtn(ok, msg) {
    const btns = document.querySelectorAll('#kc-drops-refresh, [data-dhud-refresh], [data-inline-refresh], [data-camp-refresh]');
    btns.forEach((b) => {
      const prev = b.textContent;
      b.disabled = true;
      b.textContent = ok ? '✓' : '✗';
      b.classList.toggle('kc-refresh-ok', !!ok);
      b.classList.toggle('kc-refresh-fail', !ok);
      setTimeout(() => {
        b.disabled = false;
        b.textContent = prev === '✓' || prev === '✗' || prev === '…' ? (b.id === 'kc-drops-refresh' ? (t('refresh') || 'Yenile') : '↻') : prev;
        b.classList.remove('kc-refresh-ok', 'kc-refresh-fail');
      }, 1800);
    });
    setStatus(msg);
    try {
      const old = document.getElementById('kc-refresh-toast');
      if (old) old.remove();
      const el = document.createElement('div');
      el.id = 'kc-refresh-toast';
      el.className = ok ? 'kc-toast-ok' : 'kc-toast-fail';
      el.textContent = msg;
      document.documentElement.appendChild(el);
      setTimeout(() => el.remove(), 2500);
    } catch (_) {}
  }

  async function doRefreshCampaigns() {
    const btns = document.querySelectorAll('#kc-drops-refresh, [data-dhud-refresh], [data-inline-refresh], [data-camp-refresh]');
    btns.forEach((b) => {
      b.disabled = true;
      b.textContent = '…';
    });
    setStatus(t('loading') || 'Yenileniyor…');
    try {
      const list = await fetchCampaigns(true);
      try { renderCampaignList(); } catch (_) {}
      try { renderDropsHud(); } catch (_) {}
      const n = Array.isArray(list) ? list.filter((c) => isActiveCampaign(c) && !isCampaignFullyClaimed(c)).length : 0;
      flashRefreshBtn(true, (t('drops_refreshed') || 'Yenilendi') + ' · ' + n + ' aktif');
      return list;
    } catch (e) {
      flashRefreshBtn(false, t('drops_refresh_fail') || 'Yenilenemedi — tekrar dene');
      return null;
    }
  }

  KC.on('drops:refresh', () => {
    doRefreshCampaigns();
  });


  // Arka plan / diğer sekme: SW keepalive → hemen progress çek
  try {
    chrome.runtime.onMessage.addListener((msg) => {
      if (msg?.type === 'kc:keepalive' || msg?.type === 'kc:drops-poll') {
        pollAndClaim().catch(() => {});
        try {
          const v = getVideo();
          if (v && v.paused && !v.ended) { if (KC.resumeVideo) KC.resumeVideo(v); else v.play().catch(() => {}); }
        } catch (_) {}
      }
    });
  } catch (_) {}

  // Sekme gizli olsa bile interval çalışsın; görünür olunca anında yenile
  try {
    document.addEventListener('visibilitychange', () => {
      pollAndClaim().catch(() => {});
      if (KC.settings?.drops_enabled) tick().catch(() => {});
    });
  } catch (_) {}

})();
