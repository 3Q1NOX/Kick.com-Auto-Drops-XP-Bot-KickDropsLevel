const DEFAULTS = {
  level_bot: false,
  anti_stuck: true,
  bg_watch: true,
  drops_enabled: false,
  drops_selected: [],
  drops_auto_claim: true,
  drops_hud: true,
  drops_hud_collapsed: false,
  level_hud: true,
  level_hud_collapsed: false,
  pos_level_hud: null,
  pos_drops_hud: null,
  pos_control: null,
  ui_collapsed: true,
  panel_opacity: 95,
  hud_compact: false,
  quality_160: false,
  stream_quality: 'auto',
  video_filter: 'off',
  switch_log: [],
  terms_accepted: false
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
