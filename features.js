(function () {
  /* Özellikler penceresi: eklentideki tüm özelliklerin kısa özeti (Menü çubuğu › Özellikler) */
  const KC = (window.KickControl = window.KickControl || {});
  const ID = 'kc-features';

  const GROUPS = [
    ['Farm — Drops', [
      ['Drop farm', 'Seçtiğin kampanyaların drop yayınlarını otomatik izler; hedef bitince sıradakine geçer.'],
      ['Otomatik claim', 'Hazır olan ödülleri kendiliğinden alır.'],
      ['Drop HUD / Kompakt HUD', 'Drop ilerlemesini ekranda küçük bir panelde gösterir (kompakt = daha küçük).'],
      ['Kampanya paneli', 'Aktif kampanyaları listeler, hangilerini farmlayacağını seçersin.'],
      ['Yenile / Claim / Log', 'Kampanyaları yeniler, ödül almayı dener, kanal geçişlerinin kaydını açar.']
    ]],
    ['Farm — Level', [
      ['Level Bot', 'Canlı kanalları gezerek izleme XP\'si (level) kazandırır; yayın kapanır ya da bozulursa kanalı değiştirir.'],
      ['Level XP paneli', 'Seviye, yüzde, saatlik XP, tahmini süre ve oturum kazancını gösterir; profil resminde ilerleme halkası çıkar.'],
      ['Min. izleyici', 'Level bot yalnızca bu sayıdan fazla izleyicisi olan kanallara girer.']
    ]],
    ['Koruma', [
      ['Anti-stuck', 'Yayın durursa ya da takılırsa videoyu yeniden oynatır.'],
      ['Sekmeyi aktif tut', 'Sekme arka plandayken de Kick\'in "izliyor" saymasını (XP/drop) sürdürür.'],
      ['Yayın sessize alınmasın', 'Video sessize alınırsa sesi geri açar (kapatırsan elle sessize alabilirsin).'],
      ['Onarıcı (pencere küçülünce)', 'Tarayıcı penceresi küçülünce takılan yayını düzeltir; takılma durumunu izler.'],
      ['Gecikmede otomatik onar', 'Yayın canlıdan eşik süresinden fazla geride kalırsa otomatik canlıya geçer.'],
      ['Gecikme eşiği (sn)', 'Otomatik canlıya geçişin kaç saniye gecikmede başlayacağı. Altında Gecikme rakamı canlı görünür.'],
      ['Gecikmeyi düzelt', 'Anında canlı yayına geçer ("Canlı Yayına Geç"); kısayol atanabilir.'],
      ['Durum kutusu', 'Tampon, çözünürlük ve takılma durumunu gösteren küçük kutu.']
    ]],
    ['Yayın kontrolü', [
      ['Yayını düzelt', 'Oynatıcıyı toparlar; takılmışsa canlıya atlatıp yeniden başlatır.'],
      ['Sonraki yayın', 'Hemen başka bir yayına geçer.'],
      ['Yayın: 160p kalite', 'Veri/CPU tasarrufu için yayını en düşük kaliteye sabitler.'],
      ['FPS Boost', 'Sayfanın gereksiz işini azaltır: animasyon/geçiş, bulanıklık ve gölge efektlerini kapatır, ana yayın dışındaki önizleme videolarını durdurur. Yayın, ses, Drops ve Level bot etkilenmez. İstersen "sohbeti gizle" de açılır; kareler durum kutusunda canlı FPS olarak görünür.'],
      ['Video filtresi', 'Videoyu loş/koyu/gri yapar ya da gizler (yayın akmaya devam eder, drop/XP etkilenmez).']
    ]],
    ['Ekstra', [
      ['Kick Adblock', 'Sayfadaki reklam ve sponsor bannerlarını gizler.'],
      ['Click to Pause', 'Videoya tıklayınca yayını duraklatır.'],
      ['Koordinat seçici', 'Ekranda bir nokta/kare seçip koordinatını verir; pencere konumlarını ayarlamak için kullanılır.']
    ]],
    ['Pencereler ve ayarlar', [
      ['Dashboard', 'Yayın, Drops ve Level durumunu, drop ilerlemesini (%) ve kısayol listesini tek küçük pencerede toplar (Düzelt / Sonraki / Claim düğmeleriyle).'],
      ['Hata günlüğü', 'Eklenti uyarı/hatalarını ve drop farm kararlarının nedenlerini kaydeder; kopyala / indir / temizle.'],
      ['Geçiş logu', 'Son kanal geçişlerini ve nedenlerini listeler.'],
      ['Kısayollar', 'Menüyü açma, farm/bot, sonraki yayın, yayını/gecikmeyi düzelt vb. için tuş atarsın (çift tıkla = sil).'],
      ['Saydamlık / Menü boyutu', 'Her pencerenin arka plan, başlık, dış çerçeve ve yazı saydamlığını ve menü boyutunu ayarlar.'],
      ['Config', 'Tüm ayarları JSON dosyasına yedekler, geri yükler ya da sıfırlar.']
    ]]
  ];

  const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;');

  function build() {
    if (document.getElementById(ID)) return;
    const el = document.createElement('div');
    el.id = ID;
    el.innerHTML =
      '<div class="kf-title" id="kf-title"><span>Özellikler</span><span class="kf-x" id="kf-x" title="Kapat">×</span></div>' +
      '<div class="kf-body">' +
      GROUPS.map((g) =>
        '<div class="kf-g"><div class="kf-gh">' + esc(g[0]) + '</div>' +
        g[1].map((r) => '<div class="kf-r"><b>' + esc(r[0]) + '</b><span>' + esc(r[1]) + '</span></div>').join('') +
        '</div>'
      ).join('') +
      '</div>';
    document.documentElement.appendChild(el);
    try { KC.applyPos && KC.applyPos(el, 'pos_features', { x: 120, y: 90 }); } catch (_) {}
    try { KC.makeDraggable && KC.makeDraggable(el, el.querySelector('#kf-title'), 'pos_features'); } catch (_) {}
    el.querySelector('#kf-x').onclick = () => el.remove();
  }

  KC.toggleFeatures = function () {
    const old = document.getElementById(ID);
    if (old) old.remove();
    else build();
  };
})();
