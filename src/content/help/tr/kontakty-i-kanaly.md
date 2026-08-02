# Kişiler ve kanallar

## Kişi nasıl eklenir

Ugolok'ta sizi "bulmaya" yarayan telefon numaraları veya takma adlar yoktur — bunun yerine her kişinin bir açık anahtarı vardır (`npub1...` ile başlar). Bu hem bir adrestir hem de sahtesi yapılamayacak bir şeydir: bu anahtarla gönderilen bir mesaj, kesinlikle o anahtardan gelir, başka birinden değil.

Adımlar:

1. Görüşmek istediğiniz kişiden açık anahtarını (`npub...`) isteyin — bu, "Profil" ekranından kopyalanabilir ve istediğiniz herhangi bir şekilde iletilebilir (sesli olarak, başka bir mesajlaşma uygulamasında, yüz yüze göstererek).
2. "Kişiler" bölümünü → "Kişi ekle" seçeneğini açın ve aldığınız anahtarı yapıştırın.
3. Kişiye bir istek gelir. Bunu kendi tarafında kabul etmesi gerekir.
4. Karşılıklı onaydan sonra kişi olursunuz ve birbirinize yazabilirsiniz.

Bir istek her zaman iptal edilebilir veya reddedilebilir — her iki tarafın da açık onayı olmadan hiçbir şey gerçekleşmez.

**Önemli:** anahtarlarınızı bağımsız bir kanal üzerinden (yüz yüze, telefonla, başka bir mesajlaşma uygulamasında) değiştirmediğiniz sürece, bir anahtarın gerçekten konuşmak istediğiniz kişiye ait olduğundan tamamen emin olamazsınız — bu, herhangi bir anahtar tabanlı sistem için genel bir kuraldır, Ugolok'a özgü bir durum değildir.

## Kişi grupları nasıl çalışır

Tüm kişilerinizi gruplar halinde düzenleyebilirsiniz (örneğin "Aile", "İş", "Arkadaşlar") — bu, hem kendi başına kullanışlıdır hem de kanallarınıza erişim doğrudan gruplara bağlı olduğu için önemlidir (aşağıya bakın).

## Kanallara erişim nasıl çalışır

Bir kanal, yaratıcısı olarak sizin yönettiğiniz kendi kişisel alanınızdır (bir gönderi akışı ile grup sohbeti arasında bir şey).

Bir kanal oluşturduğunuzda, hemen **hangi kişi gruplarınızın** onu görebileceğini seçersiniz. Bu, projenin bilinçli bir tasarım kararıdır: yabancı biri doğrudan bir kanalın "kapısını çalamaz" — önce kişiniz olması ve erişim verdiğiniz gruplardan birine girmesi gerekir.

Bazılarına bu aşırı bir kısıtlama gibi görünebilir — bir kanalı sadece okutmak için birini önceden kişilerinize eklemek her zaman istenmeyebilir. Bu modeli bilinçli olarak seçtik: anlaşılması daha kolay ("ya erişimim var ya yok — ve tam olarak hangi grup üzerinden olduğunu biliyorum") ve erişimin planlanmamış birine ulaşabileceği rastgele "delikler" bırakmıyor.

Bir kanalı *okuma* hakkından ayrı olarak, *yorum yapma* hakkı vardır — bir kişinin zaten (bir grup üzerinden) okuma erişimi olsa bile, yorum yapmak için sizin onayladığınız ayrı bir istek gönderir. Bu, yukarıda açıklanan grup kuralının yerini almaz, ek bir katmandır.
