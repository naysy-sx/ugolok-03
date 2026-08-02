# Technik und Aufbau des Projekts

Diese Seite ist für alle, die neugierig sind, „unter die Haube“ zu schauen. Um die App zu nutzen, müssen Sie sie nicht verstehen.

## Protokoll

Ugolok basiert auf **Nostr** — einem offenen Protokoll für dezentrale Nachrichten. Die Grundidee von Nostr ist einfach: Jeder Nutzer hat ein Schlüsselpaar (öffentlich und privat), Nachrichten werden mit dem privaten Schlüssel signiert und auf einem oder mehreren Servern veröffentlicht (sogenannte *Relays*). Niemand vergibt Konten — die Identität wird vollständig durch den Schlüssel bestimmt.

## Verschlüsselung

- Private Gespräche verwenden **MLS** (Messaging Layer Security) — dieselbe Protokollklasse, die der Verschlüsselung großer Messenger zugrunde liegt. Sie bietet *Forward Secrecy*: Selbst wenn ein Schlüssel künftig durchsickert, lassen sich alte Gespräche nicht nachträglich lesen.
- Der Kanalinhalt wird mit einem separaten Kanalschlüssel verschlüsselt — Forward Secrecy wird hier bewusst nicht angewendet (ein Kanal ist seiner Natur nach ein Archiv, zu dem man über Jahre zurückkehrt, kein Gespräch, das „vergessen“ werden soll).
- Die lokale Datenbank auf dem Gerät ist ebenfalls verschlüsselt — der Verschlüsselungscode wird aus Ihrem Passwort abgeleitet.
- Dateien und Anhänge werden separat verschlüsselt, bevor sie auf den Speicherserver (Blossom) hochgeladen werden — der Server speichert nur den Chiffretext.

## Woraus die App besteht

- **Preact** — eine leichte Oberflächen-Engine (reaktiv, aber um ein Vielfaches kleiner als bekanntere Alternativen).
- **Dexie.js** — eine Hülle um die im Browser eingebaute Datenbank (IndexedDB), in der Ihr gesamtes Gespräch lokal gespeichert wird.
- Kryptografische Grundbausteine — Bibliotheken der Familie **@noble** (secp256k1, ChaCha20-Poly1305, SHA-256 und andere), die MLS-Implementierung ist **ts-mls**.
- Die gesamte App wird in eine einzige HTML-Datei kompiliert — das vereinfacht Bereitstellung und Aktualisierung.

## Serverseite

- **Relay** (Nachrichtenserver) — verwendet wird **strfry**, eine ausgereifte und breit erprobte Nostr-Relay-Implementierung.
- **Blossom** — ein separates Protokoll und Server für die Dateispeicherung, gebunden an dieselben Schlüssel wie der Rest von Nostr.
- Beide Komponenten kann jeder selbst betreiben — siehe den Abschnitt zum eigenen Server in den Profileinstellungen.

## Offener Quellcode

Der Code des Projekts ist offen und wird für jeden vollständig einsehbar sein unter **git.ugolok.tech**.
