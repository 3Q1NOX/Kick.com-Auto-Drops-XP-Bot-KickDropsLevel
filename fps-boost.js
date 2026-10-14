(function () {
  'use strict';
  /* FPS Boost — v2.2: sıfırdan, canlı Kick DOM'una göre yazıldı (2026-10 doğrulandı).
     Önceki sürüm (v1.3.107) html.kc-fpsb * + ~40 :not() clause ile her sayfa
     elemanını eşleştiriyordu + 2 setInterval çalıştırıyordu → sayfayı yoruyordu.
     Yeni sürüm: tek statik CSS, doğrulanmış pozitif seçiciler, çalışırken
     minimum ek işlem.

     Etki alanları (dört ayar, mevcut anahtarlar korundu):
       1) fps_boost      — SOHBET dekorasyonunu kapat (hover transition,
                           animate class). Player, menü, dialog, eklenti UI
                           dokunulmaz. Preview video durdurma çıkarıldı.
       2) fps_hide_chat  — Sohbet sütununu tamamen gizle, videoya yer aç.
       3) chat_hide_gifs — Sohbet mesajlarındaki animasyonlu emote
                           span'ini gizle. Statik emote'ler dokunulmaz.
       4) chat_hide_badges — Mesajlardaki identity-badge sarmalayıcılarını
                           gizle + badge rack kalıntısını temizle.

     Kick DOM (doğrulanmış 2026-10-14, kick.com/xqc):
       #channel-chatroom  → sohbet sütunu (DIV, flex; parent div.relative.flex.h-full)
       #chatroom-messages → mesaj listesi (DIV, overflow-y-auto contain-strict)
       #chatroom-footer   → sohbete yazma alanı
       MAIN               → main.relative.no-scrollbar.flex.w-xvw.grow (video alanı;
                            kardeş flex-item, display:none sonrası genişliği doldurur)
       Mesaj              → div.group.relative.px-2 > div.w-full.rounded-lg.px-2
       Emote span         → span[data-emote-id][data-emote-name] (inline-block
                            relative, sabit w-[calc(var(--chatroom-font-size)*28/13)])
       Badge              → div[data-testid^="identity-badge-"] (inline-flex shrink-0
                            sabit size-[calc(1em*(18/13))])
       Badge rack         → div.flex.items-center.gap-1.self-center.pr-1 (badges'
                            tek parent'ı; username butonu sibling)
       Video             → <video> (id YOK, video-player custom element içinde) */

  const KC = (window.KickControl = window.KickControl || {});
  const STYLE_ID = 'kc-fpsb-style';

  const on = () => KC.settings?.fps_boost === true;
  const hideChat = () => KC.settings?.fps_hide_chat === true;
  const hideGifs = () => KC.settings?.chat_hide_gifs === true;
  const hideBadges = () => KC.settings?.chat_hide_badges === true;

  /* ──────────────────────────────── 1) CSS ────────────────────────────────
     TÜM kurallar yalnızca doğrulanmış, sınırlı kapsamda eşleşir:
     - #chatroom-messages içi hover/animate class'ları
     - #channel-chatroom gizleme
     - mesaj içi emote/badge
     Video player, control bar, Radix/Headless menü, dialog, tooltip, eklenti
     UI (kc- prefix) hiçbir kurala dahil DEĞİL. */
  const CSS = `
/* ═══ FPS Boost (ana) — sohbet dekorasyonunu kapat ═══ */
html.kc-fpsb #chatroom-messages .betterhover\\:group-hover\\:bg-surface-bg-highest,
html.kc-fpsb #chatroom-messages .cursor-pointer,
html.kc-fpsb #chatroom-messages .w-full.rounded-lg.px-2 {
  transition-property: none !important;
  transition-duration: 0s !important;
}
html.kc-fpsb #chatroom-messages [class*="animate-"],
html.kc-fpsb #chatroom-messages [class*="animation-"] {
  animation-duration: 0.001s !important;
  animation-iteration-count: 1 !important;
}

/* ═══ FPS Boost: sohbeti gizle ═══ */
html.kc-fpsb.kc-fpsb-nochat
  #channel-chatroom {
  display: none !important;
}

/* ═══ Sohbet: animasyonlu emote gizle (bağımsız) ═══
   SPAN'i gizle — sabit genişlikli wrapper bırakmamak için. */
html.kc-hide-gifs
  #chatroom-messages
  span[data-emote-id][data-kc-animated="1"],
html.kc-hide-gifs
  [data-testid="chatroom-messages"]
  span[data-emote-id][data-kc-animated="1"] {
  display: none !important;
}

/* ═══ Sohbet: badge gizle (bağımsız) ═══ */
html.kc-hide-badges
  #chatroom-messages [data-testid^="identity-badge-"],
html.kc-hide-badges
  [data-testid="chatroom-messages"] [data-testid^="identity-badge-"] {
  display: none !important;
}
html.kc-hide-badges
  #chatroom-messages
  div.flex.items-center.gap-1.self-center.pr-1:has(
    > [data-testid^="identity-badge-"]
  ),
html.kc-hide-badges
  [data-testid="chatroom-messages"]
  div.flex.items-center.gap-1.self-center.pr-1:has(
    > [data-testid^="identity-badge-"]
  ) {
  display: none !important;
}
`;

  function ensureStyle() {
    let el = document.getElementById(STYLE_ID);
    if (!el) {
      el = document.createElement('style');
      el.id = STYLE_ID;
      el.textContent = CSS;
      (document.head || document.documentElement).appendChild(el);
    }
  }

  /* ─────────────────── 2) Animasyonlu emote sınıflandırması ─────────────────
     Kick emote URL'leri uzantısızdır; Content-Type animasyon bilgisi
     taşımaz (APNG de image/png döner). Bu yüzden MIME'dan animasyon tespit
     edilemez. Doğru yol: ImageDecoder ile görüntüyü bir kez decode edip
     track.animated flag'ini okumak (Chrome'da doğrulandı).

     Sınıflandırma kuralları:
       - Cache + in-flight dedup; eşzamanlı fetch sınırı (MAX_CONCURRENT).
       - Sonuçlar ID + URL bazlı doğrulanır; span'in o sırada aynı ID/URL'yi
         taşıması kontrol edilir — eski isteğin sonucu yeni span'i ezmez.
       - GIF gizleme kapatıldığında pending işler ve işaretler temizlenir.
       - Animasyon bilgisi okunamadıysa (ImageDecoder yok/hata) URL'de
         .gif/\/gif\/ → animasyonlu kabul, aksi halde statik (güvenli taraf). */
  const MAX_CONCURRENT = 4; // aynı anda en fazla 4 görüntü sınıflandır
  const classCache = new Map(); // key → {animated, src}
  const inFlight = new Set(); // key
  const pendingQueue = []; // {key, emoteId, src}
  let activeCount = 0;
  let emoteObs = null;
  let observedContainer = null;
  let containerRetryTimer = null;
  let mountObserver = null;

  const cacheKey = (emoteId, src) => emoteId + '|' + src;

  function applyMark(span, animated) {
    if (animated) span.setAttribute('data-kc-animated', '1');
    else span.removeAttribute('data-kc-animated');
  }

  /* Sonucu span'lere uygula — sadece bu istekteki ID + URL hâlâ
     geçerliyse. Eski istek yeni span'i ezmesin. */
  function applyResult(key, animated) {
    const [emoteId, src] = key.split('|');
    const scope = 'span[data-emote-id="' + emoteId + '"]';
    document.querySelectorAll(
      '#chatroom-messages ' + scope + ', [data-testid="chatroom-messages"] ' + scope
    ).forEach((span) => {
      const img = span.querySelector('img');
      if (!img || img.src !== src) return; // span'in src'si değişti → atla
      applyMark(span, animated);
    });
  }

  /* ── ImageDecoder ile animasyon bilgisi oku ──
     Doğrulanmış Chrome API: decoder.tracks[0].animated / .frameCount */
  async function classifyWithImageDecoder(src) {
    if (typeof ImageDecoder === 'undefined') return null;
    let decoder = null;
    let image = null;
    try {
      const res = await fetch(src);
      const buf = await res.arrayBuffer();
      decoder = new ImageDecoder({
        type: res.headers.get('content-type') || 'image/png',
        data: buf
      });
      ({ image } = await decoder.decode({ frameIndex: 0 }));
      const trackList = decoder.tracks;
      if (trackList && trackList.length > 0 && trackList[0]) {
        const track = trackList[0];
        // Chrome, GIF formatını HER ZAMAN animated:true olarak işaretler
        // (1 frame'lik statik GIF bile). Bu yüzden frameCount kontrolü
        // öncelikli: >1 frame → animasyonlu; 1 frame → statik.
        // Doğrulandı (2026-10): Chrome ImageDecoder —
        //   statik GIF  → animated:true, frameCount:1 (YANLIŞ flag)
        //   statik PNG  → animated:false, frameCount:1
        //   statik WebP → animated:false, frameCount:1
        //   anim  GIF  → animated:true, frameCount:2
        if (track.frameCount > 1) return true; // çoklu frame → animasyonlu
        return false; // tek frame → statik
      }
      return null; // track bilgisi yok → unknown
    } catch (_) {
      return null;
    } finally {
      // kaynak sızıntısını kapat — image.close() + decoder.close()
      try { if (image) image.close(); } catch (_) {}
      try { if (decoder) decoder.close(); } catch (_) {}
    }
  }

  function enqueueClassify(key, emoteId, src, span) {
    if (classCache.has(key)) {
      const c = classCache.get(key);
      // Cache hit — doğrudan bu span'e uygula (chat-wide sorgu YOK;
      // hot path hafif kalsın). Eğer span parametresi verilmişse
      // applyMark ile direkt işaretle; yoksa applyResult ile tüm
      // eşleşen span'leri bul.
      if (span) {
        // span'in o anki ID/URL'si hâlâ eşleşiyorsa uygula
        const img = span.querySelector('img');
        if (img && img.src === src) {
          applyMark(span, c.animated);
        } else {
          // span değişmiş — tüm eşleşenlere uygula
          applyResult(key, c.animated);
        }
      } else {
        applyResult(key, c.animated);
      }
      return;
    }
    if (inFlight.has(key)) return; // dedup
    inFlight.add(key);
    pendingQueue.push({ key, emoteId, src });
    pumpQueue();
  }

  function pumpQueue() {
    while (activeCount < MAX_CONCURRENT && pendingQueue.length > 0) {
      // GIF gizleme kapatıldıysa kuyruğu boşalt (anahtarları da temizle)
      if (!hideGifs()) {
        clearQueueOnly();
        return;
      }
      const job = pendingQueue.shift();
      activeCount++;
      const urlIsGif = /\.gif(\?|#|$)/i.test(job.src) || /\/gif\//i.test(job.src);
      (async () => {
        // ImageDecoder ile animasyon bilgisi oku
        let decoded = null;
        try {
          decoded = await classifyWithImageDecoder(job.src);
        } catch (_) { decoded = null; }
        let animated;
        if (decoded === true) animated = true;
        else if (decoded === false) animated = false;
        else if (urlIsGif) animated = true; // fallback: GIF URL → animasyonlu
        else animated = false; // fallback: statik kabul
        if (!hideGifs()) {
          // gizleme kapatıldı → sonucu uygulama, sadece cache'e yaz
          classCache.set(job.key, { animated });
          return;
        }
        classCache.set(job.key, { animated });
        applyResult(job.key, animated);
      })().finally(() => {
        activeCount--;
        inFlight.delete(job.key);
        pumpQueue(); // sonraki işi al
      });
    }
  }

  /* Sadece kuyruktaki (henüz başlamamış) işleri iptal et.
     Anahtarları inFlight'tan da sil — aktif işlerin anahtarları kalır,
     onların finally bloğu kendini temizler. */
  function clearQueueOnly() {
    for (const job of pendingQueue) inFlight.delete(job.key);
    pendingQueue.length = 0;
  }

  /* Sıradaki span'i sınıflandır — ID ve URL'yi birlikte doğrulayarak.
     Bu fonksiyon hem yeni span hem cache hit hem observer'dan gelen
     img (src değişimi / yeni img mount) durumunu kapsar. */
  function classifyEmote(span) {
    if (!hideGifs()) return; // GIF gizleme kapalı → hiçbir şey yapma
    const emoteId = span.getAttribute('data-emote-id');
    if (!emoteId) return;
    const img = span.querySelector('img');
    const src = img ? img.src : null;
    if (!src) return;
    enqueueClassify(cacheKey(emoteId, src), emoteId, src, span);
  }

  function classifyScope(root) {
    if (!hideGifs()) return;
    const sel = 'span[data-emote-id]';
    const spans = root
      ? (root.matches && root.matches(sel) ? [root] : Array.from(root.querySelectorAll(sel)))
      : Array.from(document.querySelectorAll(
          '#chatroom-messages ' + sel + ', [data-testid="chatroom-messages"] ' + sel
        ));
    for (const s of spans) classifyEmote(s);
  }

  /* GIF gizleme kapatıldığında pending işleri ve işaretleri temizle */
  function cancelPendingClassifications() {
    clearQueueOnly();
    // in-flight fetch'leri durduramayız (fetch abort yok), ama sonucu
    // uygulamayız — pumpQueue içinde hideGifs kontrolü var.
    document.querySelectorAll('[data-kc-animated]').forEach((s) =>
      s.removeAttribute('data-kc-animated')
    );
  }

  /* ── Container mount algılama (sınırlı deneme) ──
     #chatroom-messages DOM'a girince (ya da SPA nav sonrası yeniden
     mount edilince) observer'ı yeniden bağla. Sınırsız retry YOK —
     MAX_MOUNT_RETRIES ile sınırlı, chat olmayan sayfada biter.
     Sabitler aşağıda (onNav bölümü ile paylaşıyor). */
  let mountRetries = 0;

  function findContainer() {
    return document.getElementById('chatroom-messages') ||
      document.querySelector('[data-testid="chatroom-messages"]') || null;
  }

  function ensureEmoteObserver() {
    if (!hideGifs()) return; // kapalıyken kurma
    if (emoteObs && observedContainer && observedContainer.isConnected) return;
    // önce mevcut container'ı dene
    const container = findContainer();
    if (container) {
      if (emoteObs) emoteObs.disconnect();
      emoteObs = null;
      bindObserver(container);
      observedContainer = container;
      classifyScope(null); // var olan emote'leri sınıflandır
      mountRetries = 0;
      return;
    }
    // container yok → mount algılama başlat (sınırlı deneme)
    startMountObserver();
  }

  function bindObserver(container) {
    emoteObs = new MutationObserver((muts) => {
      if (!hideGifs()) return;
      for (const m of muts) {
        // yeni eklenen elementler — subtree içinde img'li div'ler de dahil
        for (const n of m.addedNodes) {
          if (n.nodeType !== 1) continue;
          // Alt ağaç içinde img varsa ve alt ağaç zaten bir emote span'inin
          // parçasıysa, o span'i sınıflandır.
          // (IMG'nin kendisi eklenirse closest span'e, div+img eklenirse
          //  alt ağacı tara.)
          if (n.tagName === 'IMG') {
            const span = n.closest && n.closest('span[data-emote-id]');
            if (span) { applyMark(span, false); classifyEmote(span); }
            continue;
          }
          // Bu node bir emote span'ının İÇİNE eklenmiş olabilir —
          // (span içine <div><img></div> insert). Enclosing span'i de
          // sınıflandır, subtree'ten bağımsız.
          const enclosing = n.closest && n.closest('span[data-emote-id]');
          if (enclosing && n !== enclosing) {
            applyMark(enclosing, false);
            classifyEmote(enclosing);
          }
          if (n.matches && n.matches('span[data-emote-id]')) {
            classifyEmote(n);
          } else if (n.querySelectorAll) {
            classifyScope(n); // subtree
          }
        }
        // attribute değişimi (src veya data-emote-id) — ID/URL eşleşmesi için
        if (m.type === 'attributes') {
          const target = m.target;
          if (target.nodeType === 1) {
            if (target.tagName === 'IMG') {
              const span = target.closest && target.closest('span[data-emote-id]');
              if (span) {
                // eski animasyon işaretini temizle (yeni src farklı olabilir)
                applyMark(span, false);
                classifyEmote(span);
              }
            } else if (target.tagName === 'SPAN' && target.matches && target.matches('span[data-emote-id]')) {
              applyMark(target, false);
              classifyEmote(target);
            }
          }
        }
      }
    });
    emoteObs.observe(container, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ['src', 'data-emote-id']
    });
  }

  /* Navigasyon keşfi — sınırlı sayıda deneme, container değişene kadar.
     onNav, observed container hâlâ bağlıysa İLK kontrolde hemen dönmez;
     24 saniyeye kadar container'ın değişip değişmediğini izler. */
  const MAX_MOUNT_RETRIES = 30; // toplam ~24 saniye
  let navCheckTimer = null;

  // findContainer ve ensureEmoteObserver yalnızca yukarıda (satır ~284) tanımlıdır.

  function startMountObserver() {
    if (mountRetries >= MAX_MOUNT_RETRIES) return; // sınır aşıldı
    if (containerRetryTimer) return;
    containerRetryTimer = setTimeout(() => {
      containerRetryTimer = null;
      mountRetries++;
      if (!hideGifs()) { mountRetries = 0; return; }
      const container = findContainer();
      if (container) {
        bindObserver(container);
        observedContainer = container;
        classifyScope(null);
        mountRetries = 0;
      } else {
        startMountObserver(); // tekrar dene (sınır dahilinde)
      }
    }, 800);
  }

  /* SPA navigasyon — container'ın değişmesi gecikebilir. Sınırlı süre
     boyunca periyodik olarak kontrol et; container değişince yeniden bağlan.
     Eski container hâlâ bağlıysa ilk kontrolde hemen vazgeçmek yerine
     MAX_MOUNT_RETRIES süresince devam et. */
  function onNav() {
    if (navCheckTimer) clearInterval(navCheckTimer);
    mountRetries = 0;
    // İlk kontrolü 600ms sonra yap; sonra her 800ms'de bir (sınır dahilinde)
    navCheckTimer = setTimeout(() => {
      navCheckTimer = null;
      checkNavContainer();
    }, 600);
  }

  function checkNavContainer() {
    if (!hideGifs()) { mountRetries = 0; return; }
    // Container kimliği değişti mi? Sadece isConnected'e değil,
    // `findContainer()`'ın şu an döndürdüğü elemente bak.
    const current = findContainer();
    if (current && current === observedContainer) {
      // Aynı element hâlâ geçerli — birkaç kez daha kontrol edelim.
      if (mountRetries >= MAX_MOUNT_RETRIES) return; // sınır
      mountRetries++;
      navCheckTimer = setTimeout(checkNavContainer, 800);
      return;
    }
    if (current && current !== observedContainer) {
      // Container DEĞİŞTİ (yeni element seçildi, eski hâlâ bağlı olabilir)
      observedContainer = null;
      if (emoteObs) { emoteObs.disconnect(); emoteObs = null; }
      mountRetries = 0;
      ensureEmoteObserver();
      return;
    }
    // Container DOM'dan çıktı → yeniden bağlan
    observedContainer = null;
    if (emoteObs) { emoteObs.disconnect(); emoteObs = null; }
    mountRetries = 0;
    ensureEmoteObserver();
  }

  function stopEmoteObserver() {
    if (emoteObs) { emoteObs.disconnect(); emoteObs = null; }
    if (containerRetryTimer) { clearTimeout(containerRetryTimer); containerRetryTimer = null; }
    if (navCheckTimer) { clearTimeout(navCheckTimer); navCheckTimer = null; }
    observedContainer = null;
    mountRetries = 0;
    cancelPendingClassifications();
  }

  /* Ana yayın video referansı — yalnızca FPS ölçümü için kullanılır.
     `video-player` custom element içindeki <video>; fallback: main içindeki
     ilk <video>. */
  const mainVideoEl = () =>
    document.querySelector('video-player video') || document.querySelector('main video');

  /* NOT: Preview (önizleme) video durdurma bu sürümden tamamen çıkarıldı.
     Doğrulanabilir bir "önizleme container" seçicisi bulunamadığı için,
     herhangi bir video'yu yanlışlıkla durdurmak riski alındı. */

  /* ───────────────────────────── 4) Uygulama ────────────────────────────── */
  function apply() {
    const root = document.documentElement;
    ensureStyle();
    root.classList.toggle('kc-fpsb', on());
    root.classList.toggle('kc-fpsb-nochat', on() && hideChat());
    root.classList.toggle('kc-hide-gifs', hideGifs());
    root.classList.toggle('kc-hide-badges', hideBadges());
    if (hideGifs()) {
      ensureEmoteObserver();
    } else {
      stopEmoteObserver();
    }
  }

  /* ───────────────────────── 5) FPS ölçümü ────────────────────────────────
     KC.fpsInfo Dashboard/Durum kutusu tarafından okunuyor. Eski 2 sn
     setInterval yerine: sadece Boost AÇIKKEN çalışan 2 sn'lik setTimeout
     zinciri. Video değişirse sayaç sıfırlanır. */
  let fpsTimer = null;
  let lastSample = null;
  let lastVideo = null;

  function stopFpsSampling() {
    if (fpsTimer) { clearTimeout(fpsTimer); fpsTimer = null; }
    KC.fpsInfo = null;
    lastSample = null;
    lastVideo = null;
  }

  function measureFps() {
    fpsTimer = null;
    if (!on()) { stopFpsSampling(); return; }
    const v = mainVideoEl();
    if (!v || v.paused || v.ended || !v.getVideoPlaybackQuality) {
      KC.fpsInfo = null;
      fpsTimer = setTimeout(measureFps, 2000);
      return;
    }
    if (v !== lastVideo) {
      lastVideo = v;
      lastSample = null;
    }
    let q;
    try { q = v.getVideoPlaybackQuality(); } catch (_) {
      fpsTimer = setTimeout(measureFps, 2000);
      return;
    }
    const now = performance.now();
    if (lastSample && now - lastSample.t >= 1800) {
      const fps = (q.totalVideoFrames - lastSample.total) / ((now - lastSample.t) / 1000);
      KC.fpsInfo = {
        fps: Math.max(0, Math.round(fps)),
        dropped: q.droppedVideoFrames || 0
      };
    }
    if (!lastSample || now - lastSample.t >= 1800) {
      lastSample = { t: now, total: q.totalVideoFrames };
    }
    fpsTimer = setTimeout(measureFps, 2000);
  }

  function startFpsSampling() {
    if (fpsTimer) return;
    fpsTimer = setTimeout(measureFps, 2000);
  }

  /* ───────────────────────────── 6) Başlatma ─────────────────────────────── */
  let initialized = false;
  function init() {
    if (initialized) return;
    initialized = true;
    apply();
    if (on()) startFpsSampling();
    KC.on('setting:fps_boost', () => {
      apply();
      if (on()) startFpsSampling();
      else stopFpsSampling();
    });
    KC.on('setting:fps_hide_chat', apply);
    KC.on('setting:chat_hide_gifs', apply);
    KC.on('setting:chat_hide_badges', apply);

    // SPA navigasyon — container mount algılaması tetiklenir
    addEventListener('popstate', onNav);
    document.addEventListener('click', (e) => {
      const a = e.target.closest && e.target.closest('a[href^="/"]');
      if (a) onNav();
    }, true);
  }

  KC.settingsReady.then(init);
  KC.applyFpsBoost = apply;
})();
