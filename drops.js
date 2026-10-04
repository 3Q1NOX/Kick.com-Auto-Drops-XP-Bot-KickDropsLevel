(function () {
  const KC = (window.KickControl = window.KickControl || {});

  const CAMPAIGNS_EPS = [
    'https://web.kick.com/api/v1/drops/campaigns',
    'https://kick.com/api/v1/drops/campaigns',
    'https://kick.com/api/v2/drops/campaigns'
  ];
  const PROGRESS_EPS = [
    'https://web.kick.com/api/v1/drops/progress',
    'https://kick.com/api/v1/drops/progress'
  ];
  const CLAIM_EPS = [
    'https://web.kick.com/api/v1/drops/claim',
    'https://kick.com/api/v1/drops/claim'
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
  let lastClaimAt = 0;
  let claimInFlight = false;
  let lastClaimMsg = '';
  const claimedIds = new Set(); // reward ids claimed this session
  /** campaign ids where every reward is claimed — stop farming these */
  const completedCampaignIds = new Set();
  let progressByCampaign = {}; // id -> { progress_units, rewards[] }

  function t(k, vars) {
    try {
      return KC.t ? KC.t(k, vars) : k;
    } catch (_) {
      return k;
    }
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

  function sessionToken() {
    try {
      const m = document.cookie.match(/(?:^|;\s*)session_token=([^;]+)/);
      return m ? decodeURIComponent(m[1]) : null;
    } catch (_) {
      return null;
    }
  }

  function headers(jsonBody) {
    const h = { Accept: 'application/json', 'x-app-platform': 'web' };
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
          const earned =
            rw.claimable === true ||
            rw.status === 'claimable' ||
            (need > 0 && progressUnits >= need);
          if (!earned) continue;
          ready++;
          if (!auto) continue;

          try {
            let claimedOk = false;
            for (const claimUrl of CLAIM_EPS) {
              try {
                const cr = await fetch(claimUrl, {
                  method: 'POST',
                  credentials: 'include',
                  headers: headers(true),
                  body: JSON.stringify({
                    reward_id: rw.id,
                    campaign_id: c.id
                  })
                });
                if (cr.ok) {
                  claimedOk = true;
                  break;
                }
              } catch (_) {}
            }
            if (claimedOk) {
              claimedIds.add(String(rw.id));
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
              console.warn('[KC] drops claim failed', cr.status, rw.id);
            }
          } catch (e) {
            console.warn('[KC] drops claim error', e);
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
        showClaimToast(
          t('drops_ready_title') || 'Drop hazır!',
          (t('drops_ready_body') || 'Envanterden al veya otomatik almayı aç') +
            ' (' +
            ready +
            ')'
        );
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
      console.warn('[KC] drops progress poll failed', e);
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
    if (c.status === 'active') return true;
    const now = Date.now();
    const s = parseIso(c.starts_at);
    const e = parseIso(c.ends_at);
    if (s && e) return s.getTime() <= now && now <= e.getTime();
    return false;
  }

  function isUpcomingCampaign(c) {
    if (!c) return false;
    if (c.status === 'upcoming') return true;
    const now = Date.now();
    const s = parseIso(c.starts_at);
    return s && s.getTime() > now;
  }

  async function fetchJsonRetry(urls, opts, label) {
    const list = Array.isArray(urls) ? urls : [urls];
    let lastErr = null;
    for (const url of list) {
      for (let attempt = 0; attempt < 2; attempt++) {
        try {
          const res = await fetch(url, {
            credentials: 'include',
            cache: 'no-store',
            ...opts,
            headers: {
              Accept: 'application/json',
              'x-app-platform': 'web',
              ...(opts && opts.headers ? opts.headers : {})
            }
          });
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
    if (label) console.warn('[KC]', label, lastErr);
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

  function targetCategories() {
    const cats = new Set();
    for (const c of selectedCampaigns()) {
      const id = c.category?.id ?? c.rewards?.[0]?.category_id;
      if (id) cats.add(Number(id));
      for (const r of c.rewards || []) {
        if (r.category_id) cats.add(Number(r.category_id));
      }
    }
    return [...cats];
  }

  function targetChannelSlugs() {
    const slugs = new Set();
    for (const c of selectedCampaigns()) {
      for (const ch of c.channels || []) {
        const s = (ch.slug || ch.username || ch).toString().toLowerCase();
        if (s) slugs.add(s);
      }
    }
    return [...slugs];
  }

  async function fetchLivesForCategory(categoryId, limit) {
    try {
      const url =
        LIVES_EP +
        '?limit=' +
        (limit || 20) +
        '&sort=viewer_count_desc&category_id=' +
        encodeURIComponent(categoryId);
      const res = await fetch(url, {
        credentials: 'include',
        headers: headers(),
        cache: 'no-store'
      });
      if (!res.ok) return [];
      const j = await res.json();
      const data = j?.data;
      const list = data?.livestreams || (Array.isArray(data) ? data : []) || [];
      return list
        .map((x) => {
          const slug = (x.channel?.slug || x.slug || '').toLowerCase();
          return slug
            ? {
                slug,
                viewers: x.viewer_count || 0,
                categoryId: x.category?.id || categoryId,
                title: x.title || ''
              }
            : null;
        })
        .filter(Boolean);
    } catch (_) {
      return [];
    }
  }

  async function isSlugLive(slug) {
    try {
      const res = await fetch(
        'https://kick.com/api/v2/channels/' + encodeURIComponent(slug) + '/livestream',
        { credentials: 'include', headers: { Accept: 'application/json' }, cache: 'no-store' }
      );
      if (!res.ok) return false;
      const j = await res.json();
      const data = j?.data ?? j;
      if (!data || data.is_live === false) return false;
      return !!(data.id || data.session_title || data.playback_url);
    } catch (_) {
      return false;
    }
  }

  async function collectTargetLives() {
    const out = [];
    const seen = new Set();
    const cats = targetCategories();
    const fixed = targetChannelSlugs();

    for (const slug of fixed) {
      if (seen.has(slug)) continue;
      if (await isSlugLive(slug)) {
        seen.add(slug);
        out.push({ slug, viewers: 0, categoryId: null, title: '' });
      }
    }

    for (const cat of cats) {
      const lives = await fetchLivesForCategory(cat, 25);
      for (const L of lives) {
        if (seen.has(L.slug)) continue;
        seen.add(L.slug);
        out.push(L);
      }
    }

    out.sort((a, b) => (b.viewers || 0) - (a.viewers || 0));
    return out;
  }

  /**
   * @returns {Promise<{ok:boolean, catId:number|null, reason:string, categoryChanged:boolean}>}
   */
  async function currentStreamQualifies() {
    const slug = currentSlug();
    if (!slug) {
      return { ok: false, catId: null, reason: 'no-slug', categoryChanged: false };
    }
    const fixed = new Set(targetChannelSlugs());
    const cats = targetCategories();
    if (!cats.length && !fixed.size) {
      return { ok: false, catId: null, reason: 'no-targets', categoryChanged: false };
    }

    // Channel-list only campaigns: listed slug always qualifies
    if (fixed.has(slug) && !cats.length) {
      return { ok: true, catId: null, reason: 'listed-channel', categoryChanged: false };
    }

    let catId = null;
    try {
      const res = await fetch(
        'https://kick.com/api/v2/channels/' + encodeURIComponent(slug) + '/livestream',
        { credentials: 'include', headers: { Accept: 'application/json' }, cache: 'no-store' }
      );
      if (!res.ok) {
        return { ok: false, catId: null, reason: 'api-' + res.status, categoryChanged: false };
      }
      const j = await res.json();
      const data = j?.data ?? j;
      if (!data || data.is_live === false) {
        return { ok: false, catId: null, reason: 'offline', categoryChanged: false };
      }
      if (data.category?.id != null) catId = Number(data.category.id);
      else if (data.categories?.[0]?.id != null) catId = Number(data.categories[0].id);
    } catch (_) {
      return { ok: false, catId: null, reason: 'api-error', categoryChanged: false };
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

    if (cats.length && catId != null && cats.includes(Number(catId))) {
      lastQualifyAt = Date.now();
      return { ok: true, catId, reason: 'category-match', categoryChanged };
    }

    // Streamer switched away from drop category
    if (cats.length) {
      return {
        ok: false,
        catId,
        reason: categoryChanged ? 'category-changed' : 'wrong-category',
        categoryChanged
      };
    }

    if (fixed.has(slug)) {
      return { ok: true, catId, reason: 'listed-channel', categoryChanged };
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
      console.warn('[KC] drops: no target lives', reason);
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

  async function tick() {
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
      setStatus(
        (t('drops_bad') || 'Uygun değil') +
          ` ${consecutiveBad}/${BAD_NEED}` +
          (currentSlug() ? ' · ' + currentSlug() : '')
      );
      if (consecutiveBad >= BAD_NEED) {
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

  function fmtUnits(u) {
    if (u == null) return '';
    if (u >= 60) return Math.round(u / 60) + ' dk';
    return u + ' sn';
  }

  function fmtRemain(unitsLeft) {
    if (unitsLeft == null || unitsLeft <= 0) return 'hazır';
    const s = Math.ceil(Number(unitsLeft) || 0);
    if (s < 60) return '~' + s + ' sn';
    const m = Math.ceil(s / 60);
    if (m < 60) return '~' + m + ' dk';
    const h = Math.floor(m / 60);
    const rm = m % 60;
    return '~' + h + 's ' + rm + 'dk';
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

  function renderCampaignList() {
    const host = document.getElementById('kc-drops-list');
    if (!host) return;
    const ids = new Set(selectedIds());
    const sorted = campaigns
      .filter((c) => isActiveCampaign(c) && !isCampaignFullyClaimed(c))
      .slice()
      .sort((a, b) => (a.name || '').localeCompare(b.name || ''));
    if (!sorted.length) {
      host.innerHTML =
        '<div class="kc-drops-empty">' +
        (t('drops_empty') || 'Aktif kampanya yok') +
        '</div>';
      return;
    }
    host.innerHTML = sorted
      .map((c) => {
        const active = isActiveCampaign(c);
        const selected = ids.has(String(c.id));
        const done = isCampaignFullyClaimed(c);
        const cat = c.category?.name || '';
        const org = (c.organization && c.organization.name) || '';
        const merged = getMergedRewards(c);
        const rewards = merged.rewards;
        const units = merged.units;
        const hasProg = merged.hasProg;

        // Per-reward rows (every reward gets its own %)
        const rewRows = rewards
          .map((r) => {
            const need = r.required_units || 0;
            const rwDone = !!r.claimed;
            const pct = rewardPct(units, need, rwDone);
            const pctLabel = pct == null ? '—' : pct + '%';
            const timeLbl =
              need > 0 && units != null
                ? fmtUnits(Math.min(units, need)) + ' / ' + fmtUnits(need)
                : need > 0
                  ? fmtUnits(need)
                  : '';
            const fill = pct == null ? 0 : pct;
            return (
              '<div class="kc-drops-reward' +
              (rwDone ? ' is-done' : '') +
              '">' +
              '<div class="kc-drops-reward-head">' +
              '<span class="kc-drops-reward-name">' +
              escapeHtml(r.name || 'Ödül') +
              '</span>' +
              '<span class="kc-drops-reward-pct">' +
              pctLabel +
              '</span></div>' +
              '<div class="kc-drops-reward-bar">' +
              '<span class="kc-drops-prog-track"><span class="kc-drops-prog-fill" style="width:' +
              fill +
              '%"></span></span>' +
              (timeLbl
                ? '<span class="kc-drops-reward-time">' +
                  escapeHtml(timeLbl) +
                  '</span>'
                : '') +
              '</div></div>'
            );
          })
          .join('');

        const checked = selected ? 'checked' : '';
        let badge;
        if (done)
          badge =
            '<span class="kc-drops-badge kc-drops-done">' +
            (t('drops_badge_done') || 'ALINDI') +
            '</span>';
        else if (active)
          badge = '<span class="kc-drops-badge kc-drops-on">AKTİF</span>';
        else badge = '<span class="kc-drops-badge">YAKINDA</span>';

        // Summary: how many rewards done + overall toward highest requirement
        let summary = '';
        if (rewards.length) {
          const doneN = rewards.filter((r) => r.claimed).length;
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
          if (overall != null) {
            summary =
              '<span class="kc-drops-summary">' +
              doneN +
              '/' +
              rewards.length +
              ' · ' +
              overall +
              '%</span>';
          } else if (active && selected && !hasProg) {
            summary =
              '<span class="kc-drops-summary kc-drops-summary-wait">' +
              (t('drops_prog_wait') || 'İlerleme yükleniyor…') +
              '</span>';
          }
        }

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
          '<span class="kc-drops-meta">' +
          '<span class="kc-drops-top">' +
          '<span class="kc-drops-name">' +
          escapeHtml(c.name || 'Drop') +
          '</span>' +
          badge +
          '</span>' +
          (cat || org
            ? '<span class="kc-drops-cat">' +
              (cat ? escapeHtml(cat) : '') +
              (cat && org ? ' · ' : '') +
              (org && !cat ? escapeHtml(org) : '') +
              '</span>'
            : '') +
          (summary || '') +
          (rewRows
            ? '<div class="kc-drops-reward-list">' + rewRows + '</div>'
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

  // ── Detaylı izleme ilerleme paneli ──
  function buildHudBodyHtml() {
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
        '<div class="kc-prog-empty">' +
        '<div class="kc-prog-empty-ico">📦</div>' +
        '<div>' +
        (t('drops_hud_empty') || 'Seçili aktif drop yok') +
        '</div>' +
        '<div class="kc-prog-empty-hint">Panelden kampanya seç, farm’ı aç</div>' +
        '</div>'
      );
    }

    const slug = currentSlug();
    const controllingNow = !!controlling;
    let headerMeta =
      '<div class="kc-prog-live">' +
      (KC.settings?.drops_enabled
        ? controllingNow
          ? '<span class="kc-prog-dot on"></span> İzleniyor' +
            (slug ? ' · <b>' + escapeHtml(slug) + '</b>' : '')
          : '<span class="kc-prog-dot"></span> Farm açık · uygun yayın aranıyor'
        : '<span class="kc-prog-dot off"></span> Farm kapalı') +
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

        const ringPct = overall != null ? overall : 0;
        const ringStyle =
          'background: conic-gradient(#c8d0dc ' +
          ringPct +
          '%, #2a352a 0)';

        const rew = rewards
          .map((r) => {
            const need = r.required_units || 0;
            const pct = rewardPct(units, need, r.claimed);
            const fill = pct == null ? 0 : pct;
            let timeLbl = '';
            let statusLbl = '';
            if (r.claimed) {
              statusLbl = 'ALINDI';
              timeLbl = need > 0 ? fmtUnits(need) : '';
            } else if (need > 0 && units != null) {
              timeLbl =
                fmtUnits(Math.min(units, need)) + ' / ' + fmtUnits(need);
              const rem = Math.max(0, need - units);
              statusLbl = rem > 0 ? fmtRemain(rem) : 'Hazır';
            } else if (need > 0) {
              timeLbl = '0 / ' + fmtUnits(need);
              statusLbl = hasProg ? '…' : 'Yükleniyor';
            }
            return (
              '<div class="kc-prog-rew' +
              (r.claimed ? ' is-done' : '') +
              (pct != null && pct >= 100 && !r.claimed ? ' is-ready' : '') +
              '">' +
              '<div class="kc-prog-rew-top">' +
              '<span class="kc-prog-rew-name">' +
              escapeHtml(r.name || 'Ödül') +
              '</span>' +
              '<span class="kc-prog-rew-pct">' +
              (pct == null ? '—' : pct + '%') +
              '</span></div>' +
              '<div class="kc-prog-bar"><div class="kc-prog-bar-fill" style="width:' +
              fill +
              '%"></div></div>' +
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
          '<div class="kc-prog-ring" style="' +
          ringStyle +
          '"><span>' +
          (overall != null ? overall + '%' : '—') +
          '</span></div>' +
          '<div class="kc-prog-card-info">' +
          '<div class="kc-prog-card-name">' +
          escapeHtml(c.name || 'Drop') +
          '</div>' +
          (cat
            ? '<div class="kc-prog-card-cat">' + escapeHtml(cat) + '</div>'
            : '') +
          '<div class="kc-prog-card-sum">' +
          doneN +
          '/' +
          rewards.length +
          ' ödül' +
          (left != null && !done
            ? ' · ' + fmtRemain(left)
            : done
              ? ' · tamam'
              : '') +
          '</div></div></div>' +
          '<div class="kc-prog-rews">' +
          rew +
          '</div></div>'
        );
      })
      .join('');

    function esc(s) {
      return String(s == null ? '' : s)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
    }

    let levelHtml = '';
    try {
      const L = KC.getLevelHudSnapshot && KC.getLevelHudSnapshot();
      if (L) {
        levelHtml =
          '<div class="kc-combined-level">' +
          '<div class="kc-combined-level-head">Level</div>' +
          '<div class="kc-combined-level-status">' +
          esc(L.status) +
          '</div>' +
          '<div class="kc-lhud-grid">' +
          '<div class="kc-lhud-row"><span class="k">Kanal</span><span class="v">' +
          esc(L.slug) +
          '</span></div>' +
          '<div class="kc-lhud-row"><span class="k">Durum</span><span class="v ' +
          esc(L.healthClass) +
          '">' +
          esc(L.health) +
          '</span></div>' +
          '<div class="kc-lhud-row"><span class="k">Oturum</span><span class="v">' +
          esc(L.session) +
          '</span></div>' +
          '<div class="kc-lhud-row"><span class="k">İzleme</span><span class="v">' +
          esc(L.watch) +
          '</span></div>' +
          '</div>' +
          '<div class="kc-lhud-flags">' +
          '<span class="kc-flag' +
          (L.levelBot ? ' on' : '') +
          '">Level Bot</span>' +
          '<span class="kc-flag' +
          (L.antiStuck ? ' on' : '') +
          '">Anti-stuck</span>' +
          '<span class="kc-flag' +
          (L.bgWatch ? ' on' : '') +
          '">Aktif tut</span>' +
          '</div></div>';
      }
    } catch (_) {}

    return (
      headerMeta +
      '<div class="kc-prog-cards">' +
      cards +
      '</div>' +
      levelHtml
    );
  }

  function renderDropsHud() {
    if (KC.settings?.drops_hud === false) return;
    const body = document.getElementById('kc-dhud-body');
    if (!body) return;
    const hud = document.getElementById('kc-drops-hud');
    if (hud) {
      hud.classList.toggle('kc-hud-compact', !!KC.settings?.hud_compact);
    }
    body.innerHTML = buildHudBodyHtml();
    const st = document.getElementById('kc-dhud-status');
    if (st) st.textContent = statusText || '';
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
    const btn = hud.querySelector('[data-dhud-toggle]');
    if (btn)
      btn.textContent = collapsed ? '▸' : '▾';
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
    const btn = panel.querySelector('[data-slog-toggle]');
    if (btn) btn.textContent = collapsed ? '▸' : '▾';
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
      (dropIco ? '<img class="kc-ico" src="' + dropIco + '" alt="">' : '') +
      '<span class="kc-slog-title" id="kc-slog-title">Son geçişler (max 10)</span>' +
      '<div class="kc-slog-actions">' +
      '<button type="button" class="kc-slog-btn" data-slog-toggle title="Aç / Kapat">▾</button>' +
      '<button type="button" class="kc-slog-btn" data-slog-close title="Kapat">✕</button>' +
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
    const tb = panel.querySelector('[data-slog-toggle]');
    if (tb) tb.textContent = KC.settings?.switch_log_collapsed ? '▸' : '▾';

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
        (dropIco ? '<img class="kc-ico" src="' + dropIco + '" alt="">' : '') +
        '<span class="kc-dhud-title">Drops · Level</span>' +
        '<div class="kc-dhud-actions">' +
        '<button type="button" class="kc-dhud-btn" data-dhud-compact title="Kompakt / Detay">▣</button>' +
        '<button type="button" class="kc-dhud-btn" data-dhud-log title="Geçiş logu">☰</button>' +
        '<button type="button" class="kc-dhud-btn" data-dhud-refresh title="Yenile">↻</button>' +
        '<button type="button" class="kc-dhud-btn" data-dhud-toggle title="Küçült">▾</button>' +
        '</div></div>' +
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
        const t = e.target.closest('[data-dhud-toggle],[data-dhud-refresh],[data-dhud-hide],[data-dhud-compact],[data-dhud-log]');
        if (!t) return;
        e.preventDefault();
        e.stopPropagation();
        if (t.hasAttribute('data-dhud-toggle')) {
          setHudCollapsed(!hud.classList.contains('kc-dhud-collapsed'));
        } else if (t.hasAttribute('data-dhud-compact')) {
          const next = !KC.settings?.hud_compact;
          KC.saveSetting('hud_compact', next);
          renderDropsHud();
        } else if (t.hasAttribute('data-dhud-log')) {
          showSwitchLogPanel();
        } else if (t.hasAttribute('data-dhud-refresh')) {
          pollAndClaim().catch(() => {});
          doRefreshCampaigns();
        } else if (t.hasAttribute('data-dhud-hide')) {
          // HUD kalıcı — sadece küçült
          setHudCollapsed(true);
        }
      });
    }
    // Mevcut HUD ise de konumu uygula
    if (KC.applyPos) {
      try { KC.applyPos(hud, 'pos_drops_hud', { x: 16, y: 80 }); } catch (_) {}
    }
    if (KC.settings?.drops_hud_collapsed) {
      hud.classList.add('kc-dhud-collapsed');
      const tg = hud.querySelector('[data-dhud-toggle]');
      if (tg) tg.textContent = '▸';
    }
    // Log paneli önceden açıksa tekrar aç
    if (KC.settings?.switch_log_open && !document.getElementById('kc-switch-log')) {
      openSwitchLogPanel();
    }
    renderDropsHud();
  }

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
      '<div class="kc-drops-list" id="kc-drops-list"></div>' +
      '<div class="kc-drops-actions">' +
      '<button type="button" class="kc-btn" id="kc-drops-refresh">' +
      (t('drops_refresh') || 'Kampanyaları yenile') +
      '</button>' +
      '<button type="button" class="kc-btn" id="kc-drops-claim-now">' +
      (t('drops_claim_now') || 'Şimdi al') +
      '</button>' +
      '</div>';

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
    const ref = sec.querySelector('#kc-drops-refresh');
    if (ref) {
      ref.addEventListener('click', () => {
        doRefreshCampaigns();
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
  }

  // Public API — level-bot checks shouldControl() before switching
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
    const btns = document.querySelectorAll('#kc-drops-refresh, [data-dhud-refresh]');
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
    const btns = document.querySelectorAll('#kc-drops-refresh, [data-dhud-refresh]');
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
          if (v && v.paused && !v.ended) v.play().catch(() => {});
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

  // Panel may be created later
  const obs = new MutationObserver(() => {
    if (document.getElementById('kc-panel-body') && !document.getElementById('kc-drops-section')) {
      ensurePanelSection();
    }
  });
  try {
    obs.observe(document.documentElement, { childList: true, subtree: true });
  } catch (_) {}
})();
