# Teknoloji ve projenin yapısı

Bu sayfa "kaputun altına" bakmak isteyenler içindir. Uygulamayı kullanmak için bunu anlamanız gerekmez.

## Protokol

Ugolok, merkezi olmayan mesajlaşma için açık bir protokol olan **Nostr** üzerine kuruludur. Nostr'un temel fikri basittir: her kullanıcının bir anahtar çifti vardır (açık ve özel), mesajlar özel anahtarla imzalanır ve bir veya birden fazla sunucuda (*relay* olarak adlandırılır) yayınlanır. Kimse hesap vermez — kimlik tamamen anahtar tarafından belirlenir.

## Şifreleme

- Özel yazışmalar, büyük mesajlaşma uygulamalarındaki şifrelemenin temelini oluşturan protokol sınıfıyla aynı olan **MLS**'yi (Messaging Layer Security) kullanır. Bu, *forward secrecy* sağlar: bir anahtar gelecekte sızsa bile, eski yazışmalar geriye dönük olarak okunamaz.
- Kanal içeriği ayrı bir kanal anahtarıyla şifrelenir — burada forward secrecy bilinçli olarak uygulanmaz (bir kanal doğası gereği yıllarca dönülen bir arşivdir, "unutulması" gereken bir sohbet değildir).
- Cihazdaki yerel veritabanı da şifrelenir — şifreleme anahtarı parolanızdan türetilir.
- Dosyalar ve ekler, depolama sunucusuna (Blossom) yüklenmeden önce ayrıca şifrelenir — sunucu yalnızca şifreli metni saklar.

## Uygulama nelerden oluşuyor

- **Preact** — hafif bir arayüz motoru (reaktif, ancak daha tanınmış alternatiflerden kat kat daha küçük).
- **Dexie.js** — tarayıcıya yerleşik veritabanının (IndexedDB) üzerine bir sarmalayıcı; tüm yazışmalarınız yerel olarak burada saklanır.
- Kriptografik ilkel yapı taşları — **@noble** ailesinden kütüphaneler (secp256k1, ChaCha20-Poly1305, SHA-256 ve diğerleri), MLS uygulaması **ts-mls**'dir.
- Tüm uygulama tek bir html dosyasında derlenir — bu, dağıtımı ve güncellemeyi kolaylaştırır.

## Sunucu tarafı

- **Relay** (mesaj sunucusu) — olgun ve yaygın olarak test edilmiş bir Nostr relay uygulaması olan **strfry** kullanılır.
- **Blossom** — dosya depolama için Nostr'un geri kalanıyla aynı anahtarlara bağlı, ayrı bir protokol ve sunucudur.
- Her iki bileşeni de isteyen herkes kendi başına çalıştırabilir — profil ayarlarındaki kendi sunucunuz bölümüne bakın.

## Açık kaynak kod

Projenin kodu açıktır ve zamanla **git.ugolok.tech** adresinde isteyen herkesin incelemesi için tamamen erişilebilir olacaktır.
