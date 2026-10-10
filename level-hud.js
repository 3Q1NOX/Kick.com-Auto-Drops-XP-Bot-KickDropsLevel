(function () {
  'use strict';
  const KC = (window.KickControl = window.KickControl || {});

  const API = 'https://web.kick.com/api/v1/gamification/user/level';
  const REFRESH_MS = 10000;
  const HISTORY_KEY = 'kc_level_hud_history';
  const POS_KEY = 'pos_level_xp_hud';

  const state = {
    level: null,
    progressXP: 0,
    totalXP: 0,
    xpToNext: 0,
    lastUpdate: 0,
    loading: false,
    error: '',
    minimized: false,
    history: [],
    logs: [],
    rateAnchorXP: null,
    rateAnchorAt: null,
    rateSamples: [],
    xpPerHour: 0,
    sessionStartXP: null,
    sessionGained: 0,
    timer: null,
    started: false
  };

  function enabled() {
    return KC.settings?.level_xp_hud !== false;
  }

  function $(id) {
    return document.getElementById(id);
  }

  function parseJSON(value, fallback) {
    try {
      return value ? JSON.parse(value) : fallback;
    } catch {
      return fallback;
    }
  }

  function clock(time) {
    return time
      ? new Date(time).toLocaleTimeString('tr-TR', {
          hour: '2-digit',
          minute: '2-digit',
          second: '2-digit'
        })
      : '--:--:--';
  }

  function num(value) {
    return Math.max(0, Number(value) || 0).toLocaleString('tr-TR');
  }

  function duration(seconds) {
    if (!Number.isFinite(seconds) || seconds < 0) return 'Hesaplanıyor';
    const minutes = Math.ceil(seconds / 60);
    const hours = Math.floor(minutes / 60);
    const remaining = minutes % 60;
    if (!hours) return remaining + ' dk';
    return remaining ? hours + ' sa ' + remaining + ' dk' : hours + ' sa';
  }

  function log(message, type) {
    type = type || 'info';
    state.logs.unshift({ time: Date.now(), message: String(message), type: type });
    state.logs = state.logs.slice(0, 60);
    if (type === 'error') console.warn('[KC Level XP]', message);
    renderLogs();
  }

  function sessionToken() {
    try {
      const m = document.cookie.match(/(?:^|;\s*)session_token=([^;]+)/);
      return m ? decodeURIComponent(m[1]) : null;
    } catch (_) {
      return null;
    }
  }

  function loadHistory() {
    try {
      state.history = parseJSON(localStorage.getItem(HISTORY_KEY), []).slice(0, 30);
    } catch (_) {
      state.history = [];
    }
  }

  function addHistory() {
    state.history.unshift({
      time: Date.now(),
      level: state.level,
      totalXP: state.totalXP,
      progressXP: state.progressXP
    });
    state.history = state.history.slice(0, 30);
    try {
      localStorage.setItem(HISTORY_KEY, JSON.stringify(state.history));
    } catch (_) {}
  }

  function updateRate(totalXP) {
    const now = Date.now();
    if (state.sessionStartXP === null) {
      state.sessionStartXP = totalXP;
      state.sessionGained = 0;
    } else {
      state.sessionGained = Math.max(0, totalXP - state.sessionStartXP);
    }
    if (state.rateAnchorXP === null) {
      state.rateAnchorXP = totalXP;
      state.rateAnchorAt = now;
      return;
    }
    const elapsed = now - state.rateAnchorAt;
    const gained = totalXP - state.rateAnchorXP;
    if (gained < 0) {
      state.rateAnchorXP = totalXP;
      state.rateAnchorAt = now;
      state.rateSamples = [];
      state.xpPerHour = 0;
      return;
    }
    if (elapsed >= 15000 && gained > 0) {
      state.rateSamples.push(gained / (elapsed / 3600000));
      state.rateSamples = state.rateSamples.slice(-6);
      state.xpPerHour =
        state.rateSamples.reduce((a, b) => a + b, 0) / state.rateSamples.length;
      state.rateAnchorXP = totalXP;
      state.rateAnchorAt = now;
    }
  }

  function estimateTime() {
    if (state.xpPerHour <= 0 || state.xpToNext <= 0) return 'Hız ölçülüyor';
    return duration((state.xpToNext / state.xpPerHour) * 3600);
  }

  function injectStyle() {
    if ($('kc-lx-style')) return;
    const style = document.createElement('style');
    style.id = 'kc-lx-style';
    style.textContent = `
/* Level XP HUD — ImGui / eklenti stili */
#kc-lx-card, #kc-lx-mini, #kc-lx-card *, #kc-lx-mini * { box-sizing: border-box; }
#kc-lx-card {
  position: fixed; z-index: 2147483001;
  width: 300px; max-width: calc(100vw - 16px);
  background: #0c0e12;
  border: 1px solid #2a2f3a;
  border-radius: 6px;
  box-shadow: 0 8px 32px rgba(0,0,0,0.65), inset 0 1px 0 rgba(255,255,255,0.04);
  font-family: "Segoe UI", Inter, system-ui, sans-serif;
  color: #e6eaf0;
  font-size: 12px;
  overflow: hidden;
  user-select: none;
  pointer-events: auto;
}
#kc-lx-card.kc-lx-hidden, #kc-lx-mini.kc-lx-hidden { display: none !important; }
#kc-lx-head {
  display: flex; align-items: center; gap: 6px;
  padding: 6px 8px;
  background: linear-gradient(180deg, #161a22 0%, #12151c 100%);
  border-bottom: 1px solid #2a2f3a;
  cursor: move; min-height: 30px;
}
#kc-lx-title {
  flex: 1; display: flex; align-items: center; gap: 6px;
  font-size: 11.5px; font-weight: 650; color: #c8d0dc; letter-spacing: 0.03em;
}
#kc-lx-dot {
  width: 7px; height: 7px; border-radius: 50%; background: #53df91; flex: 0 0 auto;
}
.kc-lx-actions { display: flex; gap: 3px; }
.kc-lx-btn {
  background: transparent; border: none; color: #8b95a8;
  font-size: 12px; cursor: pointer; padding: 2px 5px; border-radius: 3px; line-height: 1;
  font-family: inherit;
}
.kc-lx-btn:hover { color: #fff; background: rgba(255,255,255,0.06); }
#kc-lx-body { padding: 8px 10px 10px; max-height: min(72vh, 560px); overflow-y: auto;
  scrollbar-width: thin; scrollbar-color: #2a3344 transparent; }

.kc-lx-level-row {
  display: flex; align-items: baseline; justify-content: space-between; gap: 8px; margin-bottom: 4px;
}
.kc-lx-muted { color: #6a7388; font-size: 9.5px; font-weight: 700; letter-spacing: 0.05em; text-transform: uppercase; }
.kc-lx-level { font-size: 20px; line-height: 1.15; font-weight: 750; color: #fff; margin-top: 1px; }
.kc-lx-percent { font-size: 15px; font-weight: 700; color: #53df91; }

.kc-lx-track {
  height: 6px; background: #1a1e26; border-radius: 3px; overflow: hidden; margin: 6px 0 4px;
  border: 1px solid #252a34;
}
#kc-lx-bar {
  width: 0%; height: 100%; border-radius: inherit;
  background: linear-gradient(90deg, #1a9e5c, #53df91);
  transition: width .25s ease;
}
.kc-lx-xp-labels {
  display: flex; justify-content: space-between; gap: 6px;
  font-size: 10.5px; color: #9aa3b2; margin-bottom: 2px;
}

.kc-lx-stats {
  display: grid; grid-template-columns: 1fr 1fr; gap: 5px; margin-top: 8px;
}
.kc-lx-stat {
  background: #12161f; border: 1px solid #2a2f3a; border-radius: 4px; padding: 6px 7px; min-width: 0;
}
.kc-lx-stat-label {
  color: #6a7388; font-size: 9px; font-weight: 700; letter-spacing: 0.04em;
  text-transform: uppercase; margin-bottom: 2px;
}
.kc-lx-stat-value { font-weight: 650; overflow-wrap: anywhere; font-size: 12px; color: #e6eaf0; }

#kc-lx-status {
  margin-top: 7px; color: #8b95a8; font-size: 10.5px; overflow-wrap: anywhere;
}
#kc-lx-error {
  display: none; white-space: pre-wrap; color: #ff8a95;
  background: #1a1014; border: 1px solid #4a2830; border-radius: 4px;
  padding: 6px 7px; margin-top: 6px; font-size: 10.5px;
}

.kc-lx-section {
  margin-top: 8px; border-top: 1px solid #2a2f3a; padding-top: 6px;
}
.kc-lx-section-title {
  color: #6a7388; font-size: 9.5px; font-weight: 700; letter-spacing: 0.05em;
  text-transform: uppercase; margin-bottom: 4px;
}
#kc-lx-history, #kc-lx-logs {
  max-height: 78px; overflow: auto; white-space: pre-wrap; overflow-wrap: anywhere;
  font: 10px/1.45 Consolas, "Cascadia Mono", ui-monospace, monospace; color: #9aa3b2;
  scrollbar-width: thin; scrollbar-color: #2a3344 transparent;
}
.kc-lx-log-error { color: #ff8a95; }
.kc-lx-log-ok { color: #53df91; }

#kc-lx-footer {
  display: flex; justify-content: space-between; gap: 6px; align-items: center; margin-top: 8px;
}
#kc-lx-footer .kc-lx-muted { text-transform: none; letter-spacing: 0; font-weight: 500; font-size: 10px; }
.kc-lx-copy {
  background: #161b26; border: 1px solid #2a2f3a; color: #a0aab8;
  font-size: 10px; font-weight: 600; padding: 3px 7px; border-radius: 3px;
  cursor: pointer; font-family: inherit; line-height: 1.2;
}
.kc-lx-copy:hover { border-color: #3d4a63; color: #fff; }

/* Mini */
#kc-lx-mini {
  position: fixed; z-index: 2147483001;
  width: 260px; max-width: calc(100vw - 16px);
  padding: 6px 9px;
  background: #0c0e12; border: 1px solid #2a2f3a; border-radius: 6px;
  box-shadow: 0 6px 24px rgba(0,0,0,0.55), inset 0 1px 0 rgba(255,255,255,0.04);
  font-family: "Segoe UI", Inter, system-ui, sans-serif;
  color: #e6eaf0; font-size: 11.5px;
  cursor: pointer; user-select: none;
}
#kc-lx-mini-row {
  display: flex; align-items: center; justify-content: space-between; gap: 6px;
}
#kc-lx-mini-left {
  display: flex; align-items: center; gap: 6px; min-width: 0; white-space: nowrap;
}
#kc-lx-mini-level { font-weight: 650; color: #e6eaf0; }
#kc-lx-mini-progress { color: #8b95a8; font-size: 11px; }
#kc-lx-mini-time { color: #53df91; font-size: 10px; white-space: nowrap; }
#kc-lx-dot-mini {
  width: 6px; height: 6px; border-radius: 50%; background: #53df91;
  display: inline-block; flex: 0 0 auto;
}
`;
    document.documentElement.appendChild(style);
  }

  function createUI() {
    if ($('kc-lx-card')) return;
    injectStyle();

    const card = document.createElement('div');
    card.id = 'kc-lx-card';
    card.innerHTML =
      '<div id="kc-lx-head">' +
      '<div id="kc-lx-title"><span id="kc-lx-dot"></span>LEVEL XP</div>' +
      '<div class="kc-lx-actions">' +
      '<button type="button" class="kc-lx-btn" id="kc-lx-refresh" title="Yenile">↻</button>' +
      '<button type="button" class="kc-lx-btn" id="kc-lx-minimize" title="Küçült">−</button>' +
      '<button type="button" class="kc-lx-btn" id="kc-lx-hide" title="Gizle (F9)">×</button>' +
      '</div></div>' +
      '<div id="kc-lx-body">' +
      '<div class="kc-lx-level-row">' +
      '<div><div class="kc-lx-muted">Mevcut seviye</div><div class="kc-lx-level" id="kc-lx-level">--</div></div>' +
      '<div class="kc-lx-percent" id="kc-lx-percent">0%</div>' +
      '</div>' +
      '<div class="kc-lx-track"><div id="kc-lx-bar"></div></div>' +
      '<div class="kc-lx-xp-labels">' +
      '<span id="kc-lx-progress">0 XP</span>' +
      '<span id="kc-lx-next">Sonraki: -- XP</span>' +
      '</div>' +
      '<div class="kc-lx-stats">' +
      '<div class="kc-lx-stat"><div class="kc-lx-stat-label">Toplam XP</div><div class="kc-lx-stat-value" id="kc-lx-total">--</div></div>' +
      '<div class="kc-lx-stat"><div class="kc-lx-stat-label">Kalan</div><div class="kc-lx-stat-value" id="kc-lx-remain">--</div></div>' +
      '<div class="kc-lx-stat"><div class="kc-lx-stat-label">Saatlik</div><div class="kc-lx-stat-value" id="kc-lx-rate">Ölçülüyor</div></div>' +
      '<div class="kc-lx-stat"><div class="kc-lx-stat-label">Tahmini</div><div class="kc-lx-stat-value" id="kc-lx-eta">Hesaplanıyor</div></div>' +
      '<div class="kc-lx-stat"><div class="kc-lx-stat-label">Oturum</div><div class="kc-lx-stat-value" id="kc-lx-session">+0 XP</div></div>' +
      '<div class="kc-lx-stat"><div class="kc-lx-stat-label">Durum</div><div class="kc-lx-stat-value" id="kc-lx-status-val">Bekliyor</div></div>' +
      '</div>' +
      '<div id="kc-lx-status">API bekleniyor…</div>' +
      '<div id="kc-lx-error"></div>' +
      '<div class="kc-lx-section">' +
      '<div class="kc-lx-section-title">XP geçmişi</div>' +
      '<div id="kc-lx-history">Henüz kayıt yok.</div>' +
      '</div>' +
      '<div class="kc-lx-section">' +
      '<div class="kc-lx-section-title">İşlem kayıtları</div>' +
      '<div id="kc-lx-logs">Başlatılıyor…</div>' +
      '</div>' +
      '<div id="kc-lx-footer">' +
      '<span class="kc-lx-muted" id="kc-lx-updated">Son: bekleniyor</span>' +
      '<button type="button" class="kc-lx-copy" id="kc-lx-copy">Kaydı kopyala</button>' +
      '</div></div>';

    const mini = document.createElement('div');
    mini.id = 'kc-lx-mini';
    mini.innerHTML =
      '<div id="kc-lx-mini-row">' +
      '<div id="kc-lx-mini-left">' +
      '<span id="kc-lx-dot-mini"></span>' +
      '<span id="kc-lx-mini-level">Level --</span>' +
      '<span id="kc-lx-mini-progress">0%</span>' +
      '</div>' +
      '<span id="kc-lx-mini-time">↻ Bekleniyor</span>' +
      '</div>';

    document.documentElement.append(card, mini);

    const saved = KC.settings && KC.settings[POS_KEY];
    let left = Math.max(8, window.innerWidth - 320);
    let top = 100;
    if (saved && typeof saved.x === 'number') {
      left = saved.x;
      top = saved.y;
    }
    card.style.left = left + 'px';
    card.style.top = top + 'px';
    mini.style.left = Math.min(left, Math.max(0, window.innerWidth - 270)) + 'px';
    mini.style.top = top + 'px';

    if (typeof KC.makeDraggable === 'function') {
      KC.makeDraggable(card, $('kc-lx-head'), POS_KEY);
      KC.makeDraggable(mini, mini, POS_KEY);
    }

    $('kc-lx-refresh').addEventListener('click', (e) => {
      e.stopPropagation();
      update(true);
    });
    $('kc-lx-minimize').addEventListener('click', (e) => {
      e.stopPropagation();
      state.minimized = true;
      KC.saveSetting('level_xp_hud_mini', true);
      renderVisibility();
    });
    $('kc-lx-hide').addEventListener('click', (e) => {
      e.stopPropagation();
      KC.saveSetting('level_xp_hud', false);
    });
    $('kc-lx-mini').addEventListener('click', () => {
      state.minimized = false;
      KC.saveSetting('level_xp_hud_mini', false);
      renderVisibility();
    });
    $('kc-lx-copy').addEventListener('click', async (e) => {
      e.stopPropagation();
      const output =
        state.logs
          .map(
            (item) =>
              '[' +
              clock(item.time) +
              '] [' +
              item.type.toUpperCase() +
              '] ' +
              item.message
          )
          .join('\n') || 'Kayıt yok.';
      try {
        await navigator.clipboard.writeText(output);
        log('Kayıtlar panoya kopyalandı.', 'success');
      } catch (_) {
        window.prompt('Kopyala (Ctrl+C):', output);
      }
    });

    state.minimized = !!KC.settings?.level_xp_hud_mini;
    renderVisibility();
    render();
  }

  function renderVisibility() {
    const card = $('kc-lx-card');
    const mini = $('kc-lx-mini');
    if (!card || !mini) return;
    const on = enabled();
    if (!on) {
      card.classList.add('kc-lx-hidden');
      mini.classList.add('kc-lx-hidden');
      return;
    }
    card.classList.toggle('kc-lx-hidden', state.minimized);
    mini.classList.toggle('kc-lx-hidden', !state.minimized);
  }

  function renderLogs() {
    const target = $('kc-lx-logs');
    if (!target) return;
    target.innerHTML =
      state.logs
        .slice(0, 20)
        .map((item) => {
          const cls =
            item.type === 'error'
              ? 'kc-lx-log-error'
              : item.type === 'success'
                ? 'kc-lx-log-ok'
                : '';
          return (
            '<div class="' +
            cls +
            '">[' +
            clock(item.time) +
            '] ' +
            String(item.message)
              .replace(/&/g, '&amp;')
              .replace(/</g, '&lt;')
              .replace(/>/g, '&gt;') +
            '</div>'
          );
        })
        .join('') || 'Henüz kayıt yok.';
  }

  function renderHistory() {
    const target = $('kc-lx-history');
    if (!target) return;
    target.textContent = state.history.length
      ? state.history
          .slice(0, 10)
          .map(
            (item) =>
              clock(item.time) +
              '  Lv.' +
              item.level +
              '  •  ' +
              num(item.totalXP) +
              ' XP'
          )
          .join('\n')
      : 'Henüz kayıt yok.';
  }

  function render() {
    if (!$('kc-lx-card')) return;

    const hasData = state.level !== null;
    const denominator = state.progressXP + state.xpToNext;
    const percent =
      denominator > 0
        ? Math.max(0, Math.min(100, (state.progressXP / denominator) * 100))
        : 0;

    $('kc-lx-level').textContent = hasData ? 'Level ' + state.level : '--';
    $('kc-lx-percent').textContent = percent.toFixed(1) + '%';
    $('kc-lx-bar').style.width = percent + '%';
    $('kc-lx-progress').textContent = num(state.progressXP) + ' XP';
    $('kc-lx-next').textContent = 'Sonraki: ' + num(state.xpToNext) + ' XP';
    $('kc-lx-total').textContent = hasData ? num(state.totalXP) : '--';
    $('kc-lx-remain').textContent = hasData ? num(state.xpToNext) + ' XP' : '--';
    $('kc-lx-rate').textContent =
      state.xpPerHour > 0
        ? num(Math.round(state.xpPerHour)) + ' XP/sa'
        : 'Ölçülüyor';
    $('kc-lx-eta').textContent = estimateTime();
    $('kc-lx-session').textContent =
      '+' + num(state.sessionGained) + ' XP';
    $('kc-lx-updated').textContent = state.lastUpdate
      ? 'Son: ' + clock(state.lastUpdate)
      : 'Son: bekleniyor';

    const statusVal = $('kc-lx-status-val');
    if (statusVal) {
      statusVal.textContent = state.loading
        ? 'Güncelleniyor'
        : state.error
          ? 'Hata'
          : hasData
            ? 'Aktif'
            : 'Bekliyor';
      statusVal.style.color = state.error
        ? '#ff8a95'
        : hasData
          ? '#53df91'
          : '#8b95a8';
    }

    $('kc-lx-mini-level').textContent = hasData
      ? 'Level ' + state.level
      : 'Level --';
    $('kc-lx-mini-progress').textContent = percent.toFixed(1) + '%';
    $('kc-lx-mini-time').textContent = state.lastUpdate
      ? '↻ ' + clock(state.lastUpdate)
      : '↻ Bekleniyor';

    $('kc-lx-status').textContent = state.loading
      ? 'Veriler güncelleniyor…'
      : state.error
        ? 'Bağlantı hatası'
        : hasData
          ? 'Bağlantı aktif'
          : 'API bekleniyor…';

    const dotColor = state.error
      ? '#ff6969'
      : state.loading
        ? '#f0c45b'
        : '#53df91';
    const dot = $('kc-lx-dot');
    if (dot) dot.style.background = dotColor;
    const dotMini = $('kc-lx-dot-mini');
    if (dotMini) dotMini.style.background = dotColor;

    const errEl = $('kc-lx-error');
    if (errEl) {
      errEl.style.display = state.error ? 'block' : 'none';
      errEl.textContent = state.error || '';
    }
    renderHistory();
    renderLogs();
  }

  async function update(manual) {
    if (state.loading) return;
    if (!enabled()) return;

    const tok = sessionToken();
    if (!tok) {
      state.error =
        'Oturum bulunamadı. Kick’e giriş yapıp sayfayı yenile.';
      if (manual) log(state.error, 'error');
      render();
      return;
    }

    state.loading = true;
    state.error = '';
    render();

    try {
      const response = await fetch(API, {
        method: 'GET',
        headers: {
          Authorization: 'Bearer ' + tok,
          Accept: 'application/json',
          'x-app-platform': 'web',
          'X-Client-Token':
            'e1393935a959b4020a4491574f6490129f678acdaa92760471263db43487f823'
        },
        credentials: 'include'
      });

      if (!response.ok) {
        throw new Error('HTTP ' + response.status + ' ' + response.statusText);
      }

      const json = await response.json();
      const data = json && json.data ? json.data : json;

      if (!data || data.level === undefined) {
        throw new Error('API yanıtında level yok.');
      }

      const level = Number(data.level);
      const progressXP = Number(
        data.progress_xp ?? data.progressXP ?? data.current_xp ?? 0
      );
      const totalXP = Number(
        data.total_xp ?? data.totalXP ?? data.xp ?? 0
      );
      const xpToNext = Number(
        data.xp_to_next_level ?? data.xpToNextLevel ?? data.xp_to_next ?? 0
      );

      if (![level, progressXP, totalXP, xpToNext].every(Number.isFinite)) {
        throw new Error('XP değerleri geçersiz.');
      }

      const previousTotal = state.totalXP;
      const hadData = state.level !== null;

      state.level = level;
      state.progressXP = Math.max(0, progressXP);
      state.totalXP = Math.max(0, totalXP);
      state.xpToNext = Math.max(0, xpToNext);
      state.lastUpdate = Date.now();
      state.error = '';

      updateRate(state.totalXP);
      if (!hadData || previousTotal !== state.totalXP) addHistory();

      log(
        'Güncellendi: Level ' + level + ', toplam ' + num(totalXP) + ' XP.',
        'success'
      );

      try {
        KC.getLevelXpSnapshot = function () {
          return {
            level: state.level,
            progressXP: state.progressXP,
            totalXP: state.totalXP,
            xpToNext: state.xpToNext,
            xpPerHour: state.xpPerHour,
            sessionGained: state.sessionGained,
            lastUpdate: state.lastUpdate
          };
        };
      } catch (_) {}
    } catch (error) {
      state.error = error && error.message ? error.message : String(error);
      log('Güncelleme hatası: ' + state.error, 'error');
    } finally {
      state.loading = false;
      render();
    }
  }

  function start() {
    if (state.started) return;
    state.started = true;
    loadHistory();
    createUI();
    renderVisibility();
    log('HUD başlatıldı. Yenileme: 10 sn.', 'info');

    if (enabled()) {
      update(true);
      state.timer = setInterval(() => update(false), REFRESH_MS);
    }
  }

  function stopTimer() {
    if (state.timer) {
      clearInterval(state.timer);
      state.timer = null;
    }
  }

  function onToggle(on) {
    renderVisibility();
    if (on) {
      if (!state.timer) {
        update(true);
        state.timer = setInterval(() => update(false), REFRESH_MS);
      }
    } else {
      stopTimer();
    }
  }

  KC.settingsReady.then(() => {
    start();
    KC.on('setting:level_xp_hud', (v) => onToggle(v !== false));
    KC.on('setting:level_xp_hud_mini', (v) => {
      state.minimized = !!v;
      renderVisibility();
    });
  });

  document.addEventListener(
    'keydown',
    (e) => {
      if (e.key !== 'F9') return;
      if (
        e.target &&
        (e.target.tagName === 'INPUT' ||
          e.target.tagName === 'TEXTAREA' ||
          e.target.isContentEditable)
      )
        return;
      e.preventDefault();
      const next = !(KC.settings?.level_xp_hud !== false);
      KC.saveSetting('level_xp_hud', next);
    },
    true
  );
})();
