const KEYS = [
  'drops_enabled',
  'drops_auto_claim',
  'drops_hud',
  'level_bot',
  'anti_stuck',
  'bg_watch',
  'stall_guard',
  'quality_160'
];

chrome.storage.local.get(KEYS, (data) => {
  KEYS.forEach((k) => {
    const el = document.getElementById(k);
    if (el) {
      el.checked = k === 'stall_guard' ? data[k] !== false : !!data[k];
      el.addEventListener('change', () => {
        chrome.storage.local.set({ [k]: el.checked });
      });
    }
  });
});

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local') return;
  for (const [k, { newValue }] of Object.entries(changes)) {
    const el = document.getElementById(k);
    if (el && typeof newValue === 'boolean') el.checked = newValue;
  }
});
