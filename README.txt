RCK Steam Manager
=================
Seçtiğin oyunları Steam'de aynı anda "oynuyor" gösterir (kart ve saat biriktirir),
oyunların başarımlarını açar, özel oyun listeleri yapmanı sağlar.

Açmak için
  1. Node.js LTS kurulu olmalı (nodejs.org).
  2. baslat.bat dosyasına çift tıkla. İlk seferde paketleri kendisi kurar.
  Eski "RCK Steam Idle" ayarların ve kayıtlı oturumun otomatik taşınır.

Tek dosya .exe yapmak için
  exe-yap.bat dosyasını çalıştır. Bittiğinde exe "dist" klasöründe olur.
  (Hata alırsan Windows'ta Geliştirici Modu'nu aç veya yönetici olarak çalıştır.)
  "Bilgisayarla birlikte başlat" için exe kullanmak en sağlıklısıdır.

Giriş
  Şifre ile ya da QR kod ile giriş yapabilirsin. QR için telefondaki Steam
  uygulamasında Steam Guard bölümünden kodu okutup girişi onaylaman yeterli.

Listelerim
  Oyunlarda seçim yap, soldaki + ile veya "Liste yap" ile liste oluştur.
  Listenin yanındaki oynat düğmesi tüm oyunlarını tek tıkla başlatır.

Grup modu
  Steam aynı anda en fazla 32 oyunu sayar. Grup modu açıkken fazlası 32'şerli
  gruplar hâlinde sırayla döner. Kapatırsan seçtiğin tüm oyunlar tek seferde
  gönderilir (32 sınırı uygulanmaz). Steam 32'den fazlasını saymayabilir.

Steam'de görünürlük
  Ayarlar > Steam'deki durumum "Çevrimiçi" iken idle sırasında adın Steam'de
  yeşil görünür. Steam'in kendi başarım balonu yalnızca oyunun içinden çıktığı
  için, başarımlar açılınca bildirimi uygulama Windows bildirimi olarak gösterir.

Başlangıç ve tepsi
  Ayarlar'dan: Windows ile başlat, gizli aç, kapat/küçült tuşunu tepsiye
  yönlendir, açılışta idle'ı otomatik başlat.

Başarımlar
  Bilgisayarında Steam istemcisi açık ve aynı hesapla giriş yapılmış olmalı.
  VAC korumalı oyunlar güvenlik için listelenmez. Bir oyunun tüm başarımlarını
  değil de sadece bazılarını açmak istersen, o oyunun yanındaki ☰ düğmesine bas;
  açılan pencerede istediklerini işaretleyip sadece onları açabilirsin.

  Bu pencere Steam'deki başarım sayfası gibi görünür: oyun görseli, açık/toplam
  ilerlemesi ve her başarım için simge, ad, açıklama, küresel açılma yüzdesi
  (nadirlik). Önce açılanlar (en yeni üstte), sonra kilitliler gelir. Açılmamış
  gizli başarımların adı ve açıklaması Steam'deki gibi gizli tutulur.
  Gerçek ad ve simgeler önce bilgisayarındaki Steam'in önbelleğinden okunur
  (anahtar gerekmez). Bulunamazsa teknik adların sadeleştirilmiş hâli gösterilir.
  Açılma tarihi için Ayarlar > "Steam Web API anahtarı" alanına ücretsiz
  anahtarını (steamcommunity.com/dev/apikey) yapıştır; ayrıca Steam profilinde
  "oyun ayrıntıları" herkese açık olmalı. Anahtar girersen ad ve simgeler de
  doğrudan Steam'den gelir. Anahtar boş kalırsa her şey eskisi gibi çalışır.

  Yanlışlıkla başarım açtıysan geri alabilirsin: Başarımlar sekmesinde birden
  fazla oyun seçip "Başarımları sıfırla" ile topluca, ya da bir oyunun ☰
  penceresinde üstteki "Aç / Sil" seçeneğinden "Sil"e geçip istediğin
  başarımları (ya da "Tümünü sıfırla" ile hepsini) tek tek kilitleyebilirsin.
  5'ten fazla başarımı etkileyen işlemler için ayrıca onay istenir.

Dil
  Ayarlar > Dil bölümünden arayüzü Türkçe/English olarak değiştirebilirsin.

Gizlilik
  Şifre hiçbir yere kaydedilmez, log tutulmaz. Steam Web API anahtarı (girersen)
  ayar dosyanda düz metin olarak saklanır ve yalnızca Steam'e gönderilir. "Oturumu hatırla" açıksa sadece
  Windows ile şifrelenmiş bir giriş anahtarı saklanır.
  Steam bu tür araçları resmi olarak desteklemez, kullanım sana aittir.

made by rodchaskai | www.rodchaskai.com.tr | discord.gg/rodchaskai
