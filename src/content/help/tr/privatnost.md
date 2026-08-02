# Gizlilik: ne korunuyor, ne korunmuyor

Ugolok'un gerçekte sunduğundan fazlasını vaat etmek yerine, gerçekten ne sağladığı konusunda dürüst olmaya çalışıyoruz. Korumanın sınırlarını anlamak da güvenliğin bir parçasıdır — en tehlikelisi, aslında korunmayan bir şeyin korunduğunu düşünmektir.

## Sunucudan bile gizlenen şeyler

- **Mesaj içeriği.** Konuşmanın geçtiği sunucu (relay), yalnızca şifrelenmiş bir bayt dizisi görür — metni okuyamaz.
- **Kişi ve grup adları**, kanal adları, bunların erişim kuralları.
- **Dosya ve ek içerikleri** — depolama sunucusu yalnızca şifreli metni görür.

## Sunucunun (relay) yine de gördükleri

Bu bir sır değil ve Ugolok'a özgü bir eksiklik de değildir — trafiğin geçtiği herhangi bir sunucu böyle çalışır:

- **Kimin kiminle ve ne zaman etkileşime girdiği** — gönderenin ve alıcının açık anahtarları, zaman damgaları. İçerik gizlidir, ancak "bu iki anahtar şu anda bir şey alışverişi yaptı" gerçeği görünürdür.
- **Trafik hacmi ve sıklığı.**
- **Çevrimiçi durumu** — sunucuya ne zaman bağlı olduğunuz.
- **Hangi opak kanal etiketlerini okuduğunuz** — röle'nin kendisi hangi kanal olduğunu bilmez, ancak aynı anahtarın düzenli olarak aynı etikete ilgi gösterdiğini görür.

Sizin için önemli olan sadece "yazışmanın okunmaması" değil, aynı zamanda "bunu kullandığımın görünmemesi" ise — sunucu seçiminizde ve davranışınızda bunu göz önünde bulundurun.

## Ayrıca akılda tutulması gereken şeyler

- **Kilidi açık bir cihaz, kilidi açık bir yazışma geçmişi demektir.** Hiçbir şifreleme, zaten açık ve kilidi açılmış uygulamaya fiziksel erişimi olan bir kişiye karşı koruma sağlamaz.
- **Kanalların forward secrecy'si yoktur** (özel mesajların aksine) — bu bilinçli bir karardır: bir kanal doğası gereği bir sohbetten çok bir arşive benzer ve yıllar sonra tekrar bakılmak üzere tasarlanmıştır.
- **Karşı taraf da ona gönderdiğiniz şeyi görür**, kopyalayabilir, iletebilir veya kaydedebilir — şifreleme iletim kanalını korur, alıcının mesajla daha sonra ne yaptığını değil.

## Kendi başınıza yapabilecekleriniz

- Projenin sunucularına bile bağımlı olmak istemiyorsanız kendi sunucunuzu çalıştırın.
- Sizin için önemliyse ağ düzeyinde engelleri aşma araçları kullanın — Ugolok, kendisini bilinçli olarak bir sansür aşma aracı olarak konumlandırmaz ("Proje hakkında" bölümüne bakın), ancak zaten kendi kurduğunuz bir bağlantının üzerinde onu kullanmanızı engelleyen hiçbir şey yoktur.
