# Prywatność: co jest chronione, a co nie

Staramy się być uczciwi w kwestii tego, co Ugolok faktycznie zapewnia, zamiast obiecywać więcej, niż jest w rzeczywistości. Zrozumienie granic ochrony to również część bezpieczeństwa — najgroźniejsze jest myślenie, że coś jest chronione, choć w rzeczywistości nie jest.

## Co jest ukryte nawet przed serwerem

- **Treść wiadomości.** Serwer (relay), przez który przechodzi rozmowa, widzi tylko zaszyfrowany zestaw bajtów — nie może odczytać tekstu.
- **Nazwy kontaktów i grup**, nazwy kanałów, ich zasady dostępu.
- **Treść plików i załączników** — serwer przechowywania widzi tylko szyfrogram.

## Co mimo to widzi serwer (relay)

To nie jest tajemnica ani wada specyficzna dla Ugoloka — tak działa każdy serwer, przez który przechodzi ruch:

- **Kto z kim wchodzi w interakcję i kiedy** — klucze publiczne nadawcy i odbiorcy, znaczniki czasu. Treść jest ukryta, ale fakt, że „te dwa klucze coś sobie przekazały w danym czasie”, jest widoczny.
- **Wielkość i częstotliwość ruchu.**
- **Status online** — kiedy jesteś połączony z serwerem.
- **Jakie nieprzejrzyste tagi kanałów czytasz** — sam relay nie wie, o jaki kanał chodzi, ale widzi, że ten sam klucz regularnie interesuje się tym samym tagiem.

Jeśli dla ciebie kluczowe jest nie tylko to, „żeby rozmowa nie była czytana”, ale też „żeby nie było widać samego faktu, że w ogóle z tego korzystam” — weź to pod uwagę przy wyborze serwera i sposobu zachowania.

## O czym warto pamiętać osobno

- **Odblokowane urządzenie to odblokowana historia rozmów.** Żadne szyfrowanie nie chroni przed osobą z fizycznym dostępem do już otwartej i odblokowanej aplikacji.
- **Kanały nie mają forward secrecy** (w przeciwieństwie do wiadomości prywatnych) — to świadoma decyzja: kanał z natury bliższy jest archiwum niż rozmowie i zakłada, że wraca się do starych wpisów.
- **Rozmówca również widzi to, co mu wysłałeś**, i może to skopiować, przesłać dalej lub zapisać — szyfrowanie chroni kanał transmisji, a nie to, co odbiorca robi z wiadomością później.

## Co możesz zrobić samodzielnie

- Uruchomić własny serwer, jeśli nie chcesz zależeć nawet od serwerów projektu.
- Korzystać z narzędzi omijania blokad na poziomie sieci, jeśli jest to dla ciebie istotne — Ugolok świadomie nie jest pozycjonowany jako narzędzie do obchodzenia cenzury (patrz sekcja „O projekcie”), ale nic nie stoi na przeszkodzie, by korzystać z niego na już skonfigurowanym przez ciebie połączeniu.
