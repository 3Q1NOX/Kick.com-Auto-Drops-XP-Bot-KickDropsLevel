(function () {
  try {
    // --- WebSocket hook ---
    const NativeWS = window.WebSocket;
    if (NativeWS && !NativeWS.__kcPatched) {
      const BRIDGE = 'kickcontrol:ws';
      function dispatch(raw) {
        try {
          const parsed = JSON.parse(raw);
          // Dual bridge: CustomEvent (same-world) + postMessage (isolated content scripts)
          try {
            window.dispatchEvent(new CustomEvent(BRIDGE, { detail: parsed }));
          } catch (_) {}
          try {
            window.postMessage({ source: 'kickcontrol-ws', packet: parsed }, '*');
          } catch (_) {}
        } catch (_) {}
      }
      function PatchedWS(url, protocols) {
        const socket =
          protocols !== undefined ? new NativeWS(url, protocols) : new NativeWS(url);
        try {
          const u = String(url || '').toLowerCase();
          if (
            u.includes('pusher') ||
            u.includes('ws-us') ||
            u.includes('ws-eu') ||
            u.includes('ws-') ||
            u.includes('websocket') ||
            u.includes('kick.com') ||
            u.includes('ably') ||
            u.includes('centrif') ||
            u.includes('socket') ||
            u.includes('realtime')
          ) {
            socket.addEventListener('message', (e) => {
              try {
                if (typeof e.data === 'string') {
                  dispatch(e.data);
                } else if (e.data && typeof e.data === 'object' && typeof e.data.text === 'function') {
                  // Blob/ArrayBuffer rare path
                  e.data.text().then((t) => { if (t) dispatch(t); }).catch(() => {});
                }
              } catch (_) {}
            });
          }
        } catch (_) {}
        return socket;
      }
      PatchedWS.prototype = NativeWS.prototype;
      PatchedWS.CONNECTING = 0;
      PatchedWS.OPEN = 1;
      PatchedWS.CLOSING = 2;
      PatchedWS.CLOSED = 3;
      try {
        Object.defineProperty(PatchedWS, 'name', { value: 'WebSocket' });
      } catch (_) {}
      PatchedWS.__kcPatched = true;
      window.WebSocket = PatchedWS;
    }

    // --- Adblock fetch hook ---
    if (!window.__kcAdFetch) {
      window.__kcAdFetch = true;
      let adblockEnabled = false; // off by default — stripping broke Kick 2026 playback_url
      window.addEventListener('kc:adblock', (e) => {
        adblockEnabled = !!e.detail;
      });
      const AD_URL_RE =
        /doubleclick|googlesyndication|googleadservices|imasdk|ima3\.js|dai\.google|securepubads|pagead2|adservice\.google|adsafeprotected|moatads|amazon-adsystem|kickads|kick-ads|\/ad\/vast|\/vast\/|\/vmap\/|\/midroll|\/preroll|ads\.kick|adsense|pubads|aniview|spotx|freewheel|ad-delivery/i;

      const AD_SDK_KEYS = [
        'datazoom_sdk',
        'google_ads_sdk',
        'pal_sdk',
        'ima_sdk',
        'dai_sdk',
        'ssai_sdk',
        'sgai_sdk',
        'ads_sdk',
        'kick_ads_sdk',
        'ad_sdk_url',
        'ad_tag_url',
        'ima_sdk_url'
      ];

      function stripAdPayload(data) {
        let mod = false;
        if (!data || typeof data !== 'object') return { data, mod };
        // ONLY strip explicit ad SDK keys — never touch playback_url / source / HLS
        if (data.video_player && typeof data.video_player === 'object') {
          AD_SDK_KEYS.forEach((k) => {
            if (data.video_player[k]) {
              delete data.video_player[k];
              mod = true;
            }
          });
          ['ads', 'ad_config', 'advertising'].forEach((k) => {
            if (data.video_player[k] != null) {
              data.video_player[k] = null;
              mod = true;
            }
          });
        }
        // DO NOT null playback_url.live — that IS the stream URL (Kick 2026)
        if (data.video_session && typeof data.video_session === 'object') {
          ['auto_ads_enabled', 'ads_enabled', 'midroll_enabled', 'preroll_enabled'].forEach((k) => {
            if (data.video_session[k] !== undefined) {
              data.video_session[k] = false;
              mod = true;
            }
          });
        }
        ['ad_breaks', 'ad_config', 'midrolls', 'prerolls'].forEach((k) => {
          if (data[k] != null) {
            data[k] = Array.isArray(data[k]) ? [] : null;
            mod = true;
          }
        });
        return { data, mod };
      }

      const origFetch = window.fetch.bind(window);
      window.fetch = function (...args) {
        const url =
          typeof args[0] === 'string' ? args[0] : args[0] && args[0].url;
        if (adblockEnabled && typeof url === 'string' && AD_URL_RE.test(url)) {
          window.dispatchEvent(new CustomEvent('kc:ad-blocked'));
          return Promise.resolve(
            new Response('{}', {
              status: 204,
              statusText: 'No Content',
              headers: { 'content-type': 'application/json' }
            })
          );
        }
        if (
          adblockEnabled &&
          typeof url === 'string' &&
          (/\/playback(?:[/?#]|$)/.test(url) ||
            /\/video[-_]player/.test(url) ||
            /\/livestream/.test(url) ||
            /\/video_session/.test(url) ||
            /\/player\/session/.test(url))
        ) {
          return origFetch(...args).then(async (response) => {
            try {
              const ct = (response.headers.get('content-type') || '').toLowerCase();
              if (!ct.includes('json')) return response;
              const raw = await response.clone().json();
              const { data, mod } = stripAdPayload(raw);
              if (mod) {
                window.dispatchEvent(new CustomEvent('kc:ad-blocked'));
                return new Response(JSON.stringify(data), {
                  status: response.status,
                  statusText: response.statusText,
                  headers: response.headers
                });
              }
            } catch (_) {}
            return response;
          });
        }
        return origFetch(...args);
      };

      // Block Kick Ads SDK script tags (IMA / PAL / DataZoom / Kick Ads)
      try {
        const NativeCreate = Document.prototype.createElement;
        Document.prototype.createElement = function (tag, opts) {
          const el = NativeCreate.call(this, tag, opts);
          if (adblockEnabled && String(tag).toLowerCase() === 'script') {
            const desc = Object.getOwnPropertyDescriptor(HTMLScriptElement.prototype, 'src');
            if (desc && desc.set) {
              Object.defineProperty(el, 'src', {
                configurable: true,
                enumerable: true,
                get() {
                  return desc.get.call(this);
                },
                set(v) {
                  if (AD_URL_RE.test(String(v || ''))) {
                    window.dispatchEvent(new CustomEvent('kc:ad-blocked'));
                    return;
                  }
                  desc.set.call(this, v);
                }
              });
            }
          }
          return el;
        };
      } catch (_) {}
    }

    // --- Stream quality cap (m3u8 rewrite) ---
    // maxHeight: null = auto (no rewrite); number = keep only streams <= height
    if (!window.__kcSmart1080) {
      window.__kcSmart1080 = true;
      let maxHeight = null; // null = off/auto
      window.__kcQualityMax = null;

      function applyQualityCap(h) {
        if (h == null || h === 'auto' || h === 0 || h === '0') {
          maxHeight = null;
        } else {
          const n = parseInt(h, 10);
          maxHeight = n > 0 ? n : null;
        }
        window.__kcQualityMax = maxHeight;
        const payload = { enabled: maxHeight != null, maxHeight: maxHeight };
        const ping = () => {
          try {
            const bc = new BroadcastChannel('kc-smart1080');
            bc.postMessage(payload);
            try { bc.close(); } catch (_) {}
          } catch (_) {}
        };
        ping();
        setTimeout(ping, 300);
        setTimeout(ping, 1200);
        setTimeout(ping, 3000);
      }

      window.addEventListener('kc:quality', (e) => {
        try {
          const d = e && e.detail;
          if (!d) return;
          if (d.pref === 'auto' || d.height == null || d.enabled === false) applyQualityCap(null);
          else applyQualityCap(d.height);
        } catch (_) {}
      });
      window.addEventListener('kc:smart1080', (e) => {
        // legacy: true → 1080, false → auto
        applyQualityCap(e.detail === false ? null : 1080);
      });
      window.addEventListener('message', (e) => {
        try {
          if (e.source !== window) return;
          const d = e.data;
          if (!d) return;
          if (d.source === 'kickcontrol-quality') {
            applyQualityCap(d.maxHeight);
            return;
          }
          if (d.source === 'kickcontrol-smart1080') {
            applyQualityCap(d.enabled ? (d.maxHeight || 1080) : null);
          }
        } catch (_) {}
      });
      try {
        const bcIn = new BroadcastChannel('kc-smart1080');
        bcIn.onmessage = (ev) => {
          if (!ev || !ev.data) return;
          if (typeof ev.data.maxHeight !== 'undefined') {
            maxHeight = ev.data.maxHeight == null ? null : parseInt(ev.data.maxHeight, 10) || null;
            window.__kcQualityMax = maxHeight;
          } else if (typeof ev.data.enabled === 'boolean' && !ev.data.enabled) {
            maxHeight = null;
            window.__kcQualityMax = null;
          }
        };
      } catch (_) {}

      function parseAttrs(line) {
        const out = {};
        const s = line.slice(line.indexOf(':') + 1);
        const re = /([A-Z0-9-]+)=("(?:[^"\\]|\\.)*"|[^,]*)/g;
        let m;
        while ((m = re.exec(s))) out[m[1]] = m[2].replace(/^"|"$/g, '');
        return out;
      }

      function heightOf(streamAttrs) {
        const m = String(streamAttrs.RESOLUTION || '').match(/^\d+x(\d+)$/);
        return m ? Number(m[1]) : 0;
      }

      function nameHeight(name) {
        const m = String(name || '').match(/\b(160|180|240|360|480|720|1080|1440|2160)\b/);
        return m ? Number(m[1]) : 0;
      }

      function optimizeStreams(text) {
        if (maxHeight == null) return text;
        if (!text.includes('#EXTM3U') || !text.includes('#EXT-X-STREAM-INF')) return text;
        const lines = text.replace(/\r\n?/g, '\n').split('\n');
        const head = [];
        const media = [];
        const streams = [];
        for (let i = 0; i < lines.length; i++) {
          const line = lines[i];
          if (line.startsWith('#EXT-X-MEDIA:')) {
            media.push({ line, attrs: parseAttrs(line) });
            continue;
          }
          if (line.startsWith('#EXT-X-STREAM-INF:')) {
            streams.push({ info: line, uri: lines[++i] || '', attrs: parseAttrs(line) });
            continue;
          }
          if (line) head.push(line);
        }
        if (!streams.length) return text;

        function streamH(s) {
          let h = heightOf(s.attrs);
          if (h) return h;
          const group = s.attrs.VIDEO || '';
          const related = media.find(
            (m) => m.attrs.TYPE === 'VIDEO' && m.attrs['GROUP-ID'] === group
          );
          return nameHeight(related && related.attrs.NAME) || nameHeight(group);
        }

        // Keep streams at or below maxHeight; if none, keep the lowest available
        let kept = streams.filter((s) => {
          const h = streamH(s);
          return h > 0 && h <= maxHeight;
        });
        if (!kept.length) {
          let lowest = null;
          let lowestH = Infinity;
          for (const s of streams) {
            const h = streamH(s) || Infinity;
            if (h < lowestH) {
              lowestH = h;
              lowest = s;
            }
          }
          if (lowest) kept = [lowest];
          else return text;
        }
        // Prefer highest among kept as DEFAULT
        kept.sort((a, b) => streamH(b) - streamH(a));
        const primary = kept[0];
        const validGroups = new Set(
          kept.map((s) => s.attrs.VIDEO).filter(Boolean)
        );

        const finalStreams = [];
        for (let i = 0; i < kept.length; i++) {
          let info = kept[i].info.replace(/,?DEFAULT=(YES|NO)/gi, '');
          info += i === 0 ? ',DEFAULT=YES' : ',DEFAULT=NO';
          finalStreams.push(info, kept[i].uri);
        }

        const keptMedia = media
          .filter((m) => {
            if (m.attrs.TYPE !== 'VIDEO') return true;
            if (validGroups.size && !validGroups.has(m.attrs['GROUP-ID'])) return false;
            const name = String(m.attrs.NAME || '').toLowerCase();
            if (/^auto$|adaptive|otomatik/.test(name)) return false;
            return true;
          })
          .map((m) => {
            let line = m.line;
            if (/AUTOSELECT=YES/i.test(line) && m.attrs.TYPE === 'VIDEO') {
              line = line.replace(/AUTOSELECT=YES/gi, 'AUTOSELECT=NO');
            }
            if (/DEFAULT=YES/i.test(line) && m.attrs.TYPE === 'VIDEO') {
              const hName = String(m.attrs.NAME || m.attrs['GROUP-ID'] || '');
              const nh = nameHeight(hName);
              if (nh && nh !== streamH(primary)) {
                line = line.replace(/DEFAULT=YES/gi, 'DEFAULT=NO');
              }
            }
            return { ...m, line };
          });

        return [...head, ...keptMedia.map((m) => m.line), ...finalStreams, ''].join('\n');
      }

      // Page-level m3u8
      const prevFetch = window.fetch;
      window.fetch = async function (input, init) {
        const res = await prevFetch.apply(this, arguments);
        try {
          if (maxHeight == null) return res;
          const url =
            typeof input === 'string'
              ? input
              : input && input.url
                ? input.url
                : '';
          if (!/\.m3u8(?:[?#]|$)/i.test(url)) return res;
          const text = await res.clone().text();
          const rewritten = optimizeStreams(text);
          if (rewritten === text) return res;
          const headers = new Headers(res.headers);
          headers.delete('content-length');
          headers.set('content-type', 'application/vnd.apple.mpegurl');
          return new Response(rewritten, {
            status: res.status,
            statusText: res.statusText,
            headers
          });
        } catch (_) {
          return res;
        }
      };

      // IVS wasm worker patch — same maxHeight filter
      const NativeWorker = window.Worker;
      if (NativeWorker && !NativeWorker.__kcSmartPatched) {
        const IVS_WORKER_RE = /amazon-ivs-wasmworker|ivs-player|amazon-ivs/i;

        function makeWorkerBlob(originalWorkerUrl) {
          const code =
            "(() => {\n" +
            "'use strict';\n" +
            "const ORIGINAL_WORKER_URL = " +
            JSON.stringify(originalWorkerUrl) +
            ";\n" +
            "const ORIGIN = new URL(ORIGINAL_WORKER_URL).origin;\n" +
            "const nativeFetch = self.fetch.bind(self);\n" +
            "let maxHeight = null;\n" +
            "try {\n" +
            "  const bc = new BroadcastChannel('kc-smart1080');\n" +
            "  bc.onmessage = (e) => {\n" +
            "    if (!e || !e.data) return;\n" +
            "    if (typeof e.data.maxHeight !== 'undefined') {\n" +
            "      maxHeight = e.data.maxHeight == null ? null : (parseInt(e.data.maxHeight, 10) || null);\n" +
            "    } else if (e.data.enabled === false) maxHeight = null;\n" +
            "    else if (e.data.enabled === true && e.data.maxHeight == null) maxHeight = 1080;\n" +
            "  };\n" +
            "} catch (_) {}\n" +
            "function abs(input) {\n" +
            "  if (typeof input === 'string') return new URL(input, ORIGIN).href;\n" +
            "  if (input instanceof Request) {\n" +
            "    const url = new URL(input.url, ORIGIN).href;\n" +
            "    return url === input.url ? input : new Request(url, input);\n" +
            "  }\n" +
            "  return input;\n" +
            "}\n" +
            "function urlOf(input) {\n" +
            "  if (typeof input === 'string') return new URL(input, ORIGIN).href;\n" +
            "  if (input instanceof Request) return new URL(input.url, ORIGIN).href;\n" +
            "  if (input && typeof input.url === 'string') return new URL(input.url, ORIGIN).href;\n" +
            "  return '';\n" +
            "}\n" +
            "function attrs(line) {\n" +
            "  const out = {};\n" +
            "  const s = line.slice(line.indexOf(':') + 1);\n" +
            "  const re = /([A-Z0-9-]+)=(\\\"(?:[^\\\"\\\\]|\\\\.)*\\\"|[^,]*)/g;\n" +
            "  let m;\n" +
            "  while ((m = re.exec(s))) out[m[1]] = m[2].replace(/^\\\"|\\\"$/g, '');\n" +
            "  return out;\n" +
            "}\n" +
            "function heightOf(streamAttrs) {\n" +
            "  const m = String(streamAttrs.RESOLUTION || '').match(/^\\\\d+x(\\\\d+)$/);\n" +
            "  return m ? Number(m[1]) : 0;\n" +
            "}\n" +
            "function nameHeight(name) {\n" +
            "  const m = String(name || '').match(/\\\\b(160|180|240|360|480|720|1080|1440|2160)\\\\b/);\n" +
            "  return m ? Number(m[1]) : 0;\n" +
            "}\n" +
            "function optimizeStreams(text) {\n" +
            "  if (maxHeight == null) return text;\n" +
            "  if (!text.includes('#EXTM3U') || !text.includes('#EXT-X-STREAM-INF')) return text;\n" +
            "  const lines = text.replace(/\\\\r\\\\n?/g, '\\\\n').split('\\\\n');\n" +
            "  const head = [], media = [], streams = [];\n" +
            "  for (let i = 0; i < lines.length; i++) {\n" +
            "    const line = lines[i];\n" +
            "    if (line.startsWith('#EXT-X-MEDIA:')) { media.push({ line, attrs: attrs(line) }); continue; }\n" +
            "    if (line.startsWith('#EXT-X-STREAM-INF:')) {\n" +
            "      streams.push({ info: line, uri: lines[++i] || '', attrs: attrs(line) });\n" +
            "      continue;\n" +
            "    }\n" +
            "    if (line) head.push(line);\n" +
            "  }\n" +
            "  if (!streams.length) return text;\n" +
            "  function streamH(s) {\n" +
            "    let h = heightOf(s.attrs);\n" +
            "    if (h) return h;\n" +
            "    const group = s.attrs.VIDEO || '';\n" +
            "    const related = media.find(m => m.attrs.TYPE === 'VIDEO' && m.attrs['GROUP-ID'] === group);\n" +
            "    return nameHeight(related && related.attrs.NAME) || nameHeight(group);\n" +
            "  }\n" +
            "  let kept = streams.filter(s => { const h = streamH(s); return h > 0 && h <= maxHeight; });\n" +
            "  if (!kept.length) {\n" +
            "    let lowest = null, lowestH = Infinity;\n" +
            "    for (const s of streams) { const h = streamH(s) || Infinity; if (h < lowestH) { lowestH = h; lowest = s; } }\n" +
            "    if (lowest) kept = [lowest]; else return text;\n" +
            "  }\n" +
            "  kept.sort((a, b) => streamH(b) - streamH(a));\n" +
            "  const validGroups = new Set(kept.map(s => s.attrs.VIDEO).filter(Boolean));\n" +
            "  const finalStreams = [];\n" +
            "  for (let i = 0; i < kept.length; i++) {\n" +
            "    let info = kept[i].info.replace(/,?DEFAULT=(YES|NO)/gi, '');\n" +
            "    info += i === 0 ? ',DEFAULT=YES' : ',DEFAULT=NO';\n" +
            "    finalStreams.push(info, kept[i].uri);\n" +
            "  }\n" +
            "  const keptMedia = media.filter(m => {\n" +
            "    if (m.attrs.TYPE !== 'VIDEO') return true;\n" +
            "    if (validGroups.size && !validGroups.has(m.attrs['GROUP-ID'])) return false;\n" +
            "    const name = String(m.attrs.NAME || '').toLowerCase();\n" +
            "    if (/^auto$|adaptive|otomatik/.test(name)) return false;\n" +
            "    return true;\n" +
            "  }).map(m => {\n" +
            "    let line = m.line;\n" +
            "    if (/AUTOSELECT=YES/i.test(line) && m.attrs.TYPE === 'VIDEO') line = line.replace(/AUTOSELECT=YES/gi, 'AUTOSELECT=NO');\n" +
            "    return Object.assign({}, m, { line: line });\n" +
            "  });\n" +
            "  return head.concat(keptMedia.map(m => m.line), finalStreams, ['']).join('\\\\n');\n" +
            "}\n" +
            "self.fetch = async function(input, init) {\n" +
            "  const response = await nativeFetch(abs(input), init);\n" +
            "  if (maxHeight == null) return response;\n" +
            "  const url = urlOf(input);\n" +
            "  if (!/\\\\.m3u8(?:[?#]|$)/i.test(url)) return response;\n" +
            "  try {\n" +
            "    const text = await response.clone().text();\n" +
            "    const rewritten = optimizeStreams(text);\n" +
            "    if (rewritten === text) return response;\n" +
            "    const headers = new Headers(response.headers);\n" +
            "    headers.delete('content-length');\n" +
            "    headers.set('content-type', 'application/vnd.apple.mpegurl');\n" +
            "    return new Response(rewritten, { status: response.status, statusText: response.statusText, headers });\n" +
            "  } catch (_) { return response; }\n" +
            "};\n" +
            "importScripts(ORIGINAL_WORKER_URL);\n" +
            "})();\n";
          return URL.createObjectURL(new Blob([code], { type: 'application/javascript' }));
        }

        window.Worker = class extends NativeWorker {
          constructor(url, options) {
            const absoluteUrl = new URL(String(url), location.href).href;
            if (IVS_WORKER_RE.test(absoluteUrl)) {
              super(makeWorkerBlob(absoluteUrl), options);
            } else {
              super(url, options);
            }
          }
        };
        window.Worker.__kcSmartPatched = true;
      }

      let lastPosted = null;
      setInterval(() => {
        try {
          const key = maxHeight == null ? 'auto' : String(maxHeight);
          if (lastPosted === key) return;
          lastPosted = key;
          const bc = new BroadcastChannel('kc-smart1080');
          bc.postMessage({ enabled: maxHeight != null, maxHeight: maxHeight });
          try { bc.close(); } catch (_) {}
        } catch (_) {}
      }, 5000);
    }



    // --- Background watch: spoof visibility so Kick keeps counting XP ---
    if (!window.__kcVisSpoof) {
      window.__kcVisSpoof = true;
      let visSpoofOn = true; // default ON
      window.__kcBgWatchOn = true;

      function applyVisSpoof(on) {
        visSpoofOn = !!on;
        window.__kcBgWatchOn = visSpoofOn;
      }

      window.addEventListener('message', (e) => {
        try {
          if (e.source !== window) return;
          const d = e.data;
          if (!d || d.source !== 'kickcontrol-bgwatch') return;
          if (typeof d.enabled === 'boolean') applyVisSpoof(d.enabled);
        } catch (_) {}
      });

      try {
        const proto = Document.prototype;
        const patch = (name, valueFn) => {
          const desc = Object.getOwnPropertyDescriptor(proto, name);
          if (desc && !desc.configurable) return;
          Object.defineProperty(proto, name, {
            configurable: true,
            enumerable: true,
            get: function () {
              if (visSpoofOn) return valueFn();
              return desc && desc.get ? desc.get.call(this) : valueFn();
            }
          });
        };
        patch('hidden', () => false);
        patch('visibilityState', () => 'visible');
        try {
          patch('webkitHidden', () => false);
          patch('webkitVisibilityState', () => 'visible');
        } catch (_) {}
      } catch (_) {}

      try {
        const origHasFocus = Document.prototype.hasFocus;
        if (typeof origHasFocus === 'function') {
          Document.prototype.hasFocus = function () {
            if (visSpoofOn) return true;
            return origHasFocus.call(this);
          };
        }
      } catch (_) {}

      try {
        const stop = (e) => {
          if (!visSpoofOn) return;
          try {
            e.stopImmediatePropagation();
            e.preventDefault();
          } catch (_) {}
        };
        ['visibilitychange', 'webkitvisibilitychange', 'blur', 'pagehide', 'freeze'].forEach(
          (ev) => {
            document.addEventListener(ev, stop, true);
            window.addEventListener(ev, stop, true);
          }
        );
      } catch (_) {}
    }

  } catch (e) {
    console.warn('[KC] page-hook', e);
  }
})();
