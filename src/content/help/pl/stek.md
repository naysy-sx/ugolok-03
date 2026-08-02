# Technologia i budowa projektu

Ta strona jest dla tych, którzy są ciekawi, co jest „pod maską”. Nie trzeba jej rozumieć, żeby korzystać z aplikacji.

## Protokół

Ugolok jest zbudowany na **Nostr** — otwartym protokole do zdecentralizowanej komunikacji. Główna idea Nostr jest prosta: każdy użytkownik ma parę kluczy (publiczny i prywatny), wiadomości są podpisywane kluczem prywatnym i publikowane na jednym lub kilku serwerach (nazywanych *relay*). Nikt nie wydaje kont — tożsamość jest całkowicie określona przez klucz.

## Szyfrowanie

- Prywatna korespondencja wykorzystuje **MLS** (Messaging Layer Security) — tę samą klasę protokołów, która leży u podstaw szyfrowania w dużych komunikatorach. Zapewnia *forward secrecy*: nawet jeśli klucz wycieknie w przyszłości, nie da się odczytać z mocą wsteczną starej korespondencji.
- Treść kanałów jest szyfrowana osobnym kluczem kanału — forward secrecy jest tu świadomie niestosowana (kanał ze swej natury jest archiwum, do którego wraca się przez lata, a nie rozmową, która ma zostać „zapomniana”).
- Lokalna baza danych na urządzeniu również jest szyfrowana — klucz szyfrujący powstaje z twojego hasła.
- Pliki i załączniki są szyfrowane osobno przed przesłaniem na serwer przechowywania (Blossom) — serwer przechowuje tylko szyfrogram.

## Z czego zbudowana jest aplikacja

- **Preact** — lekki silnik interfejsu (reaktywny, ale wielokrotnie mniejszy niż bardziej znane odpowiedniki).
- **Dexie.js** — nakładka na wbudowaną w przeglądarkę bazę danych (IndexedDB), w której lokalnie przechowywana jest cała twoja korespondencja.
- Prymitywy kryptograficzne — biblioteki z rodziny **@noble** (secp256k1, ChaCha20-Poly1305, SHA-256 i inne), implementacja MLS to **ts-mls**.
- Cała aplikacja jest kompilowana do jednego pliku html — dzięki temu łatwiej ją wdrażać i aktualizować.

## Część serwerowa

- **Relay** (serwer wiadomości) — używa **strfry**, dojrzałej i szeroko sprawdzonej implementacji relaya Nostr.
- **Blossom** — osobny protokół i serwer do przechowywania plików, powiązany z tymi samymi kluczami co reszta Nostr.
- Obydwa komponenty może uruchomić u siebie każdy chętny — patrz sekcja o własnym serwerze w ustawieniach profilu.

## Otwarty kod źródłowy

Kod projektu jest otwarty i będzie w pełni dostępny do zapoznania się dla każdego chętnego na **git.ugolok.tech**.
