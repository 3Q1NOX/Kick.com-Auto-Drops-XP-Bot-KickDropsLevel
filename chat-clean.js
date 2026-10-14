(function () {
  'use strict';
  /* Sohbet temizliği — v2. Canlı Kick DOM'una göre sıfırdan yazıldı.
     Eski sürüm ~25 geniş [class*="chat" i] img[...] seçicisi kullanıyordu;
     bunlar composer, avatar, kanal bilgisi, streamer kartı gibi sohbet
     DIŞINDAKİ öğeleri de eşleştiriyordu → mesaj boşluğu ve site yavaşlaması.
     Yeni sürüm tek statik CSS + pozitif doğrulanmış seçiciler:

     Emote → span[data-emote-id] (inline-block, sabit genişlik)
     Badge → div[data-testid^="identity-badge-"] (inline-flex shrink-0)

     CSS ve sınıflandırma mantığı tek yerde (fps-boost.js) tutulur; bu modül
     sadece uyumluluk katmanı — eski kodun dışa açtığı applyChatClean API'sini
     korur, çift kayıt YOK (aynı event'i iki kez dinlemez). */

  const KC = (window.KickControl = window.KickControl || {});
  const gifsOn = () => KC.settings?.chat_hide_gifs === true;
  const badgesOn = () => KC.settings?.chat_hide_badges === true;

  function apply() {
    if (KC.applyFpsBoost) {
      KC.applyFpsBoost();
      return;
    }
    // fps-boost.js yüklenmediyse fallback (tek kayıt, çift dinleme yok)
    const root = document.documentElement;
    root.classList.toggle('kc-hide-gifs', gifsOn());
    root.classList.toggle('kc-hide-badges', badgesOn());
  }

  KC.applyChatClean = apply;
})();
