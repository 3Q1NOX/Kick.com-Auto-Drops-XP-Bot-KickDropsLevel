(function () {
  'use strict';
  const KC = (window.KickControl = window.KickControl || {});

  let overlay = null;
  let box = null;
  let sizeTag = null;
  let label = null;
  let active = false;
  let dragging = false;
  let startX = 0;
  let startY = 0;
  let lastRect = null;
  let lastCopied = '';
  let pointCallback = null; // pickCoordFor

  function enabled() {
    return !!KC.settings?.coord_picker || !!pointCallback;
  }

  function ensureUI() {
    if (overlay) return;
    if (!document.getElementById('kc-coord-style')) {
      const style = document.createElement('style');
      style.id = 'kc-coord-style';
      style.textContent = `
#kc-coord-overlay {
  position: fixed;
  inset: 0;
  z-index: 2147483646;
  pointer-events: none;
  cursor: crosshair;
  display: none;
}
#kc-coord-overlay.kc-coord-on {
  display: block;
  pointer-events: auto;
  background: rgba(0, 0, 0, 0.35);
}
#kc-coord-box {
  position: fixed;
  border: 2px solid #53fc18;
  background: rgba(83, 252, 24, 0.08);
  box-shadow:
    0 0 0 9999px rgba(0, 0, 0, 0.45),
    inset 0 0 0 1px rgba(83, 252, 24, 0.4);
  pointer-events: none;
  z-index: 2147483647;
  display: none;
  box-sizing: border-box;
  border-radius: 2px;
}
#kc-coord-box::before,
#kc-coord-box::after {
  content: '';
  position: absolute;
  background: #53fc18;
  pointer-events: none;
}
/* köşe tutamaçları */
#kc-coord-box .kc-coord-h {
  position: absolute;
  width: 8px;
  height: 8px;
  background: #53fc18;
  border: 1px solid #0a0a0a;
  border-radius: 1px;
  pointer-events: none;
}
#kc-coord-box .kc-coord-h.tl { top: -5px; left: -5px; }
#kc-coord-box .kc-coord-h.tr { top: -5px; right: -5px; }
#kc-coord-box .kc-coord-h.bl { bottom: -5px; left: -5px; }
#kc-coord-box .kc-coord-h.br { bottom: -5px; right: -5px; }
#kc-coord-size {
  position: fixed;
  z-index: 2147483647;
  pointer-events: none;
  background: #53fc18;
  color: #0a0a0a;
  font: 700 11px/1 "Segoe UI", Inter, system-ui, monospace;
  padding: 3px 6px;
  border-radius: 3px;
  display: none;
  white-space: nowrap;
}
#kc-coord-label {
  position: fixed;
  left: 12px;
  top: 12px;
  z-index: 2147483647;
  pointer-events: none;
  background: rgba(12, 14, 18, 0.95);
  border: 1px solid #2a2f3a;
  border-radius: 8px;
  padding: 8px 12px;
  font: 600 12px/1.4 "Segoe UI", Inter, system-ui, monospace;
  color: #e6eaf0;
  box-shadow: 0 8px 24px rgba(0,0,0,0.5);
  display: none;
  max-width: 320px;
}
#kc-coord-label b { color: #53fc18; }
#kc-coord-label .kc-coord-hint {
  display: block;
  margin-top: 4px;
  font-size: 11px;
  font-weight: 500;
  color: #8b95a8;
}
#kc-coord-label.kc-coord-ok b { color: #5b9fff; }
`;
      document.documentElement.appendChild(style);
    }

    overlay = document.createElement('div');
    overlay.id = 'kc-coord-overlay';

    box = document.createElement('div');
    box.id = 'kc-coord-box';
    box.innerHTML =
      '<span class="kc-coord-h tl"></span>' +
      '<span class="kc-coord-h tr"></span>' +
      '<span class="kc-coord-h bl"></span>' +
      '<span class="kc-coord-h br"></span>';

    sizeTag = document.createElement('div');
    sizeTag.id = 'kc-coord-size';

    label = document.createElement('div');
    label.id = 'kc-coord-label';

    document.documentElement.append(overlay, box, sizeTag, label);

    // document-level for reliable drag
    overlay.addEventListener('mousedown', onDown);
    document.addEventListener('mousemove', onMove, true);
    document.addEventListener('mouseup', onUp, true);
    overlay.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      cancelPick();
    });
  }

  function rectFrom(x1, y1, x2, y2) {
    const x = Math.min(x1, x2);
    const y = Math.min(y1, y2);
    const w = Math.max(0, Math.abs(x2 - x1));
    const h = Math.max(0, Math.abs(y2 - y1));
    return {
      x: Math.round(x),
      y: Math.round(y),
      w: Math.round(w),
      h: Math.round(h)
    };
  }

  function formatRect(r) {
    return r.x + ' ' + r.y + ' ' + r.w + ' ' + r.h;
  }

  function showBox(r) {
    if (!r || (r.w < 1 && r.h < 1)) {
      box.style.display = 'none';
      sizeTag.style.display = 'none';
      return;
    }
    box.style.display = 'block';
    box.style.left = r.x + 'px';
    box.style.top = r.y + 'px';
    box.style.width = r.w + 'px';
    box.style.height = r.h + 'px';

    sizeTag.style.display = 'block';
    sizeTag.textContent = r.w + ' × ' + r.h;
    let sx = r.x + r.w / 2 - 28;
    let sy = r.y - 22;
    if (sy < 4) sy = r.y + r.h + 6;
    if (sx < 4) sx = 4;
    sizeTag.style.left = sx + 'px';
    sizeTag.style.top = sy + 'px';
  }

  function setLabel(html, ok) {
    label.style.display = 'block';
    label.classList.toggle('kc-coord-ok', !!ok);
    label.innerHTML = html;
  }

  function onDown(e) {
    if (!active) return;
    if (e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation();

    // Nokta seçimi (menü konum Seç)
    if (pointCallback) {
      const x = Math.round(e.clientX);
      const y = Math.round(e.clientY);
      const cb = pointCallback;
      pointCallback = null;
      try {
        cb(x, y);
      } catch (_) {}
      stop();
      try {
        KC.saveSetting('coord_picker', false);
      } catch (_) {}
      return;
    }

    dragging = true;
    startX = e.clientX;
    startY = e.clientY;
    lastRect = rectFrom(startX, startY, startX, startY);
    showBox(lastRect);
    setLabel(
      '<b>' +
        formatRect(lastRect) +
        '</b><span class="kc-coord-hint">Sürükle — yeşil kare seçim alanı</span>'
    );
  }

  function onMove(e) {
    if (!active || !dragging) return;
    lastRect = rectFrom(startX, startY, e.clientX, e.clientY);
    showBox(lastRect);
    setLabel(
      '<b>' +
        formatRect(lastRect) +
        '</b><span class="kc-coord-hint">' +
        lastRect.w +
        '×' +
        lastRect.h +
        ' px — bırakınca kopyalanır</span>'
    );
  }

  async function onUp(e) {
    if (!active || !dragging) return;
    dragging = false;
    const cx = e && e.clientX != null ? e.clientX : startX;
    const cy = e && e.clientY != null ? e.clientY : startY;
    lastRect = rectFrom(startX, startY, cx, cy);

    // Çok küçük tık → en az görünsün diye 1px
    if (lastRect.w < 2 && lastRect.h < 2) {
      lastRect.w = 0;
      lastRect.h = 0;
    }

    showBox(lastRect);
    const text = formatRect(lastRect);
    lastCopied = text;

    try {
      await navigator.clipboard.writeText(text);
    } catch (_) {
      try {
        window.prompt('Koordinat (Ctrl+C):', text);
      } catch (__) {}
    }

    setLabel(
      '<b>' +
        text +
        '</b><span class="kc-coord-hint">Kopyalandı · yeni kare için tekrar sürükle · Esc/sağ tık kapat</span>',
      true
    );

    try {
      KC.emit('coord:copied', {
        x: lastRect.x,
        y: lastRect.y,
        w: lastRect.w,
        h: lastRect.h,
        text: text
      });
    } catch (_) {}
  }

  function start() {
    ensureUI();
    active = true;
    dragging = false;
    overlay.classList.add('kc-coord-on');
    box.style.display = 'none';
    sizeTag.style.display = 'none';
    setLabel(
      '<b>x y width height</b><span class="kc-coord-hint">Sürükleyerek yeşil kare çiz · Sağ tık / Esc kapat</span>'
    );
  }

  function stop() {
    active = false;
    dragging = false;
    pointCallback = null;
    if (overlay) overlay.classList.remove('kc-coord-on');
    if (box) box.style.display = 'none';
    if (sizeTag) sizeTag.style.display = 'none';
    if (label) label.style.display = 'none';
  }

  function cancelPick() {
    stop();
    try {
      KC.saveSetting('coord_picker', false);
    } catch (_) {}
  }

  function sync() {
    if (KC.settings?.coord_picker || pointCallback) start();
    else if (!pointCallback) stop();
  }

  KC.pickCoordFor = function (callback) {
    ensureUI();
    pointCallback = callback;
    start();
    setLabel(
      '<b>Nokta seç</b><span class="kc-coord-hint">Tıkla → konum atanır · Esc iptal</span>'
    );
  };

  KC.startCoordPicker = start;
  KC.stopCoordPicker = stop;
  KC.getLastCoord = () =>
    lastRect
      ? {
          x: lastRect.x,
          y: lastRect.y,
          w: lastRect.w,
          h: lastRect.h,
          text: lastCopied
        }
      : { x: 0, y: 0, w: 0, h: 0, text: lastCopied };

  KC.settingsReady.then(() => {
    sync();
    KC.on('setting:coord_picker', (v) => {
      if (v) {
        pointCallback = null;
        start();
      } else if (!pointCallback) stop();
    });
  });

  document.addEventListener(
    'keydown',
    (e) => {
      if (e.key !== 'Escape' || !active) return;
      e.preventDefault();
      cancelPick();
    },
    true
  );
})();
