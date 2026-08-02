# Technologie en opbouw van het project

Deze pagina is voor wie nieuwsgierig is naar wat er "onder de motorkap" gebeurt. Je hoeft het niet te begrijpen om de app te gebruiken.

## Protocol

Ugolok is gebouwd op **Nostr** — een open protocol voor gedecentraliseerde berichtgeving. Het basisidee van Nostr is eenvoudig: elke gebruiker heeft een sleutelpaar (publiek en privé), berichten worden ondertekend met de privésleutel en gepubliceerd op een of meer servers (*relays* genoemd). Niemand geeft accounts uit — de identiteit wordt volledig bepaald door de sleutel.

## Versleuteling

- Privégesprekken gebruiken **MLS** (Messaging Layer Security) — dezelfde klasse protocollen die ten grondslag ligt aan de versleuteling bij grote messengers. Het biedt *forward secrecy*: zelfs als een sleutel in de toekomst uitlekt, kunnen oude gesprekken niet met terugwerkende kracht worden gelezen.
- Kanaalinhoud wordt versleuteld met een aparte kanaalsleutel — forward secrecy wordt hier bewust niet toegepast (een kanaal is van nature een archief waar je jarenlang naar terugkeert, geen gesprek dat bedoeld is om "vergeten" te worden).
- De lokale database op het apparaat is ook versleuteld — de versleutelingssleutel wordt afgeleid van je wachtwoord.
- Bestanden en bijlagen worden apart versleuteld voordat ze naar de opslagserver (Blossom) worden geüpload — de server bewaart alleen de versleutelde tekst.

## Waaruit de app is opgebouwd

- **Preact** — een lichte interface-engine (reactief, maar veel kleiner dan bekendere alternatieven).
- **Dexie.js** — een wrapper om de in de browser ingebouwde database (IndexedDB), waarin al je gesprekken lokaal worden opgeslagen.
- Cryptografische bouwstenen — bibliotheken uit de **@noble**-familie (secp256k1, ChaCha20-Poly1305, SHA-256 en andere), de MLS-implementatie is **ts-mls**.
- De hele app wordt gebundeld in één enkel html-bestand — dit maakt implementatie en updates eenvoudiger.

## Serverzijde

- **Relay** (berichtenserver) — gebruikt **strfry**, een volwassen en breed geteste Nostr-relay-implementatie.
- **Blossom** — een apart protocol en server voor bestandsopslag, gekoppeld aan dezelfde sleutels als de rest van Nostr.
- Beide onderdelen kan iedereen zelf hosten — zie de sectie over een eigen server in de profielinstellingen.

## Open source

De code van het project is open en zal volledig te bekijken zijn door iedereen op **git.ugolok.tech**.
