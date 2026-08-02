İşte GitHub'daki README'ye yapıştıracağın metin (kopyala, dosyanın en üstüne ekle):

Relay
Arkadaşlarınla sesli sohbet et, mesajlaş, grup kur. Basit, hızlı ve ücretsiz.

İndirme
Uygulamayı sağ taraftaki Releases bölümünden indirebilirsin.

Kurulum rehberi — "Windows kişisel bilgisayarınızı korudu" uyarısı
Uygulamayı kurarken Windows'un şu uyarıyı vermesi çok normaldir:

Microsoft Defender SmartScreen: Tanınmayan bir uygulamanın başlamasını engelledi.

Bu, uygulamanın virüslü olduğu anlamına gelmez.

Bu uyarı neden çıkıyor?
Windows, büyük şirketlerin yazdığı programları tanır çünkü o şirketler "imza sertifikası" denilen pahalı bir sertifika satın alır (yılda binlerce dolar). Relay ise tek bir geliştirici tarafından yapılıyor; bu sertifikaya sahip olmadığı için Windows "bu programı tanımıyorum, bir bak" der. Tıpkı bir arkadaşının yaptığı yemeği ilk kez denediğinde temkinli olman gibi — tanımadık diye zehirli olduğu anlamına gelmez.

İndirme sayısı arttıkça Windows bu uyarıyı göstermeyi kendiliğinden bırakır.

Uyarıyı geçip kurmak için (3 saniyelik iş)
Uyarı ekranında "More info" (Daha fazla bilgi) yazısına tıkla
Altta beliren "Run anyway" (Yine de çalıştır) butonuna bas
Kurulum başlar, hepsi bu!
Emin olmak istiyorsan
İndirdiğin dosyayı virustotal.com adresine sürükle-bırak, 60 saniye içinde tarama sonucunu görürsün. Sonuç temiz çıkar.

Tarayıcıdan indirirken uyarı çıkarsa
Tarayıcı fark etmez (Chrome, Edge, Opera, Firefox) — indirilen dosya aynıdır. Bazı tarayıcılar indirmeyi "güvenli değil" diye engelleyebilir:

Tarayıcı	Yapman gereken
Chrome / Edge	Sağ üstteki indirme simgesine tıkla → dosyanın yanındaki oka bas → "Keep" (Sakla)
Opera	İndirme çubuğunda "İndirmeye izin ver" de
Firefox	"Dosyayı kaydet" seçeneğine tıkla
Dosya indikten sonra kurulumda çıkan "More info → Run anyway" uyarısı da aynı şekilde normaldir.

Sık karşılaşılan sorunlar
S: Eski sürüm kurulu, yeni sürüm hata veriyor. C: Ayarlar → Uygulamalar → Relay → Kaldır, sonra kurulumu yeniden çalıştır.

S: "Cannot find module" hatası alıyorum. C: Eski sürüm kurulu demektir. Önce kaldır, sonra güncel dosyayı kur.

S: Kayıt olurken e-posta gelmiyor. C: Gelen kutusu + Spam (Gereksiz) klasörünü kontrol et. Kod e-postası 1-2 dakika içinde gelir.

İletişim
Sorunların ve soruların için: relaydestek@gmail.com
