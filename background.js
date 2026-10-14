const DEFAULTS = {
  level_bot: false,
  anti_stuck: true,
  bg_watch: true,
  no_mute: true,
  drops_enabled: false,
  drops_selected: [],
  drops_auto_claim: true,
  daily_reward_auto: true,
  drops_hud: false,
  drops_hud_collapsed: false,
  level_hud: true,
  level_hud_collapsed: false,
  pos_level_hud: null,
  pos_drops_hud: { x: 687, y: 364 },
  pos_control: { x: 441, y: 120.328125 },
  ui_collapsed: false,
  panel_opacity: 95,
  hud_compact: true,
  video_filter: 'off',
  switch_log: [],
  terms_accepted: false,
  level_xp_hud: true,
  level_xp_ring: true,
  level_xp_hud_mini: false,
  pos_level_xp_hud: { x: 873, y: 176 },
  camp_picker_open: false,
  dash_open: true,
  keys_overlay_open: true,
  menu_tab: 'farm',
  ui_collapsed: false,
  stall_guard: true,
  quality_160: false,
  fps_boost: false,
  fps_hide_chat: false,
  min_viewers: 10,
  col_accent: '#4296f9',
  col_bg: '#0f0f0f',
  col_text: '#ffffff',
  col_hud: ''
};

chrome.runtime.onInstalled.addListener(() => {
  chrome.storage.local.get(null, (data) => {
    const toSet = {};
    for (const [k, v] of Object.entries(DEFAULTS)) {
      if (data[k] === undefined) toSet[k] = v;
    }
    if (Object.keys(toSet).length) chrome.storage.local.set(toSet);
  });
});

// Relay storage changes to all kick.com tabs
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local') return;
  if (Object.keys(changes).every((k) => k === 'kc_errlog' || k === 'kc_bg')) return; // hata günlüğü sekmelere yayılmasın
  chrome.tabs.query({ url: 'https://kick.com/*' }, (tabs) => {
    for (const tab of tabs) {
      if (!tab.id) continue;
      chrome.tabs.sendMessage(tab.id, { type: 'kc:settings', changes }).catch(() => {});
    }
  });
});

// Keep tabs "awake" helper when bg_watch / drops / level active
chrome.alarms.create('kc-keepalive', { periodInMinutes: 1 });
chrome.alarms.create('kc-drops-poll', { periodInMinutes: 1 });
function pingKickTabs(type) {
  chrome.tabs.query({ url: 'https://kick.com/*' }, (tabs) => {
    for (const tab of tabs) {
      if (!tab.id) continue;
      chrome.tabs.sendMessage(tab.id, { type: type || 'kc:keepalive' }).catch(() => {});
    }
  });
}
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === 'kc-keepalive') {
    chrome.storage.local.get(['bg_watch', 'drops_enabled', 'level_bot'], (s) => {
      if (!s.bg_watch && !s.drops_enabled && !s.level_bot) return;
      pingKickTabs('kc:keepalive');
    });
  }
  if (alarm.name === 'kc-drops-poll') {
    // Drops ilerlemesi: farm kapalı olsa bile HUD güncel kalsın
    pingKickTabs('kc:drops-poll');
  }
});
// Sekme yenilenince / aktif olunca da dürt
chrome.tabs.onActivated.addListener(() => {
  pingKickTabs('kc:drops-poll');
});
chrome.tabs.onUpdated.addListener((tabId, info) => {
  if (info.status === 'complete') {
    chrome.tabs.sendMessage(tabId, { type: 'kc:drops-poll' }).catch(() => {});
  }
});


// ── Ağ yedeği: sayfadan "Failed to fetch" alan istekleri arka plan servisi yapar (CORS'a takılmaz) ──
const KC_FETCH_HOSTS = /^https:\/\/([a-z0-9-]+\.)*kick\.com\//i;
try {
  // Arka plan isteklerinde Origin/Referer kick.com görünsün (sadece eklenti kaynaklı istekler: tabId -1)
  chrome.declarativeNetRequest.updateSessionRules({
    removeRuleIds: [9101],
    addRules: [{
      id: 9101,
      priority: 1,
      action: {
        type: 'modifyHeaders',
        requestHeaders: [
          { header: 'Origin', operation: 'set', value: 'https://kick.com' },
          { header: 'Referer', operation: 'set', value: 'https://kick.com/' }
        ]
      },
      condition: { regexFilter: '^https://([a-z0-9-]+\\.)*kick\\.com/', resourceTypes: ['xmlhttprequest'], tabIds: [-1] }
    }]
  }).catch(() => {});
} catch (_) {}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || msg.type !== 'kc:fetch') return false;
  (async () => {
    try {
      if (!KC_FETCH_HOSTS.test(String(msg.url || ''))) throw new Error('izin verilmeyen adres');
      const init = Object.assign({ credentials: 'include', cache: 'no-store' }, msg.init || {});
      const ctl = new AbortController();
      const t = setTimeout(() => ctl.abort(), 9000);
      let res;
      try { res = await fetch(msg.url, Object.assign(init, { signal: ctl.signal })); } finally { clearTimeout(t); }
      const body = await res.text();
      sendResponse({ status: res.status, statusText: res.statusText, body });
    } catch (e) {
      sendResponse({ error: (e && e.message) || String(e) });
    }
  })();
  return true;
});


// ── v1.3.90: SAYFA AÇMADAN otomatik ödül alma (arka plan) ─────────────────────
// Hiç kick.com sekmesi açık değilken: seçili Drop kampanyalarının kazanılmış ödüllerini ve Günlük Ödülü alır.
// Açık bir kick.com sekmesi varsa sekmedeki betik zaten alıyor → çift istek olmasın diye bu döngü atlanır.
const KC_API = 'https://web.kick.com/api/v1';
const KC_CLIENT_TOKEN = 'e1393935a959b4020a4491574f6490129f678acdaa92760471263db43487f823';
chrome.alarms.create('kc-bg-claim', { periodInMinutes: 1, delayInMinutes: 0.2 });

const bgGet = (keys) => new Promise((r) => chrome.storage.local.get(keys, r));
async function bgState() { const o = await bgGet(['kc_bg']); return o.kc_bg || { drops: { claimed: [], fail: {}, lastAt: 0, lastMsg: '', total: 0 }, daily: { claimedUntil: 0, reward: null, rarity: null, lastClaimAt: 0 }, lastRunAt: 0, err: '' }; }
const bgSave = (st) => new Promise((r) => chrome.storage.local.set({ kc_bg: st }, r));

async function bgToken() {
  try {
    const c = await chrome.cookies.get({ url: 'https://kick.com/', name: 'session_token' });
    return c && c.value ? decodeURIComponent(c.value) : null;
  } catch (_) { return null; }
}
async function bgApi(method, url, tok, body) {
  const headers = { Accept: 'application/json', 'x-app-platform': 'web', 'X-Client-Token': KC_CLIENT_TOKEN, Authorization: 'Bearer ' + tok };
  if (body) headers['Content-Type'] = 'application/json';
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), 15000);
  try {
    const r = await fetch(url, { method, headers, credentials: 'include', cache: 'no-store', body: body ? JSON.stringify(body) : (method === 'POST' ? null : undefined), signal: ctl.signal });
    let json = null; try { json = await r.json(); } catch (_) {}
    return { ok: r.ok, status: r.status, json };
  } finally { clearTimeout(t); }
}
const needsLink = (c) => {
  const url = c.connect_url || c.connectUrl || '';
  if (!url) return false;
  return !(c.user_app_connected === true || c.userAppConnected === true || c.connected === true || c.is_connected === true);
};

async function bgClaimDrops(tok, st, sel) {
  const r = await bgApi('GET', KC_API + '/drops/progress', tok);
  if (!r.ok) throw new Error('drops progress HTTP ' + r.status);
  const list = Array.isArray(r.json && r.json.data) ? r.json.data : Array.isArray(r.json) ? r.json : [];
  const D = st.drops;
  for (const c of list) {
    const cid = String(c.id || c.campaign_id || '');
    if (!cid) continue;
    if (sel.length && sel.indexOf(cid) === -1) continue;       // sadece izlediğin (seçili) kampanyalar
    if (needsLink(c)) continue;                                 // hesap bağlama gerekiyorsa alma denemesi yok
    const units = Number(c.progress_units ?? c.progress ?? c.watched_units ?? 0) || 0;
    for (const rw of c.rewards || []) {
      const rid = String(rw.id || '');
      if (!rid || rw.claimed || D.claimed.indexOf(rid) !== -1) continue;
      const need = Number(rw.required_units ?? rw.required ?? 0) || 0;
      const earned = rw.claimable === true || /^claimable$/i.test(rw.status || '') ||
        (need > 0 && units >= need && rw.claimed !== true && !/^(claimed|locked)$/i.test(rw.status || ''));
      if (!earned) continue;
      const f = D.fail[rid];
      if (f && Date.now() - f.at < (f.status === 400 ? 86400000 : 5 * 60000)) continue;
      let ok = false, status = 0;
      for (const body of [{ reward_id: rid, campaign_id: cid }, { rewardId: rid, campaignId: cid }]) {
        const cr = await bgApi('POST', KC_API + '/drops/claim', tok, body);
        status = cr.status;
        if (cr.ok) { ok = true; break; }
        if ([400, 401, 403, 409, 422].indexOf(cr.status) !== -1) break;
      }
      if (ok) {
        D.claimed.push(rid); if (D.claimed.length > 300) D.claimed.shift();
        delete D.fail[rid];
        D.total = (D.total || 0) + 1; D.lastAt = Date.now();
        D.lastMsg = (rw.name || 'Drop') + (c.name ? ' · ' + c.name : '');
      } else { D.fail[rid] = { at: Date.now(), status }; }
    }
  }
}

async function bgClaimDaily(tok, st) {
  const Dl = st.daily;
  if (Dl.claimedUntil && Date.now() < Dl.claimedUntil) return;
  const r = await bgApi('GET', KC_API + '/gamification/challenges', tok);
  if (!r.ok) throw new Error('daily HTTP ' + r.status);
  const arr = Array.isArray(r.json) ? r.json : r.json && (r.json.data || r.json.challenges);
  const ch = Array.isArray(arr) ? arr.find((c) => c && c.recurrence === 'daily') : null;
  if (!ch) return;
  const ends = ch.window && ch.window.ends_at ? Date.parse(ch.window.ends_at) : NaN;
  const resetAt = Number.isFinite(ends) ? ends + 60000 : Date.now() + 3600000;
  const mark = (c2) => {
    Dl.claimedUntil = resetAt;
    const w = c2 && c2.winner;
    if (w) { Dl.reward = w.name || w.title || w.label || Dl.reward; Dl.rarity = w.rarity || Dl.rarity; }
  };
  if (ch.status === 'claimed') return mark(ch);
  if (ch.status === 'claimable' && ch.id && (!Number.isFinite(ends) || ends > Date.now())) {
    const cr = await bgApi('POST', KC_API + '/gamification/challenges/' + encodeURIComponent(ch.id) + '/claim', tok);
    if (cr.ok) {
      Dl.lastClaimAt = Date.now(); mark(ch);
      try { const a = await bgApi('GET', KC_API + '/gamification/challenges', tok); const l2 = Array.isArray(a.json) ? a.json : a.json && (a.json.data || a.json.challenges); const c3 = Array.isArray(l2) && l2.find((c) => c && c.id === ch.id); if (c3 && c3.status === 'claimed') mark(c3); } catch (_) {}
    }
  }
}

let bgBusy = false;
async function bgClaimCycle() {
  if (bgBusy) return;
  bgBusy = true;
  try {
    const tabs = await chrome.tabs.query({ url: 'https://kick.com/*' });
    if (tabs.length) return;                       // sekme açık → sekmedeki betik hallediyor
    const s = await bgGet(['drops_auto_claim', 'drops_selected', 'daily_reward_auto']);
    const wantDrops = s.drops_auto_claim !== false, wantDaily = s.daily_reward_auto !== false;
    if (!wantDrops && !wantDaily) return;
    const tok = await bgToken();
    const st = await bgState();
    st.lastRunAt = Date.now();
    if (!tok) { st.err = 'Giriş yok (kick.com\'da oturum açık değil)'; return await bgSave(st); }
    st.err = '';
    const sel = Array.isArray(s.drops_selected) ? s.drops_selected.map(String) : [];
    try { if (wantDrops) await bgClaimDrops(tok, st, sel); } catch (e) { st.err = String(e && e.message || e); }
    try { if (wantDaily) await bgClaimDaily(tok, st); } catch (e) { st.err = String(e && e.message || e); }
    await bgSave(st);
  } catch (_) {} finally { bgBusy = false; }
}
chrome.alarms.onAlarm.addListener((a) => { if (a.name === 'kc-bg-claim') bgClaimCycle(); });
chrome.runtime.onStartup.addListener(() => bgClaimCycle());
chrome.runtime.onInstalled.addListener(() => setTimeout(bgClaimCycle, 3000));
