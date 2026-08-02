# Technologies et architecture du projet

Cette page s'adresse à ceux qui sont curieux de regarder « sous le capot ». Il n'est pas nécessaire de la comprendre pour utiliser l'application.

## Protocole

Ugolok est construit sur **Nostr** — un protocole ouvert pour la messagerie décentralisée. L'idée centrale de Nostr est simple : chaque utilisateur possède une paire de clés (publique et privée), les messages sont signés avec la clé privée puis publiés sur un ou plusieurs serveurs (appelés *relays*). Personne ne délivre de comptes — l'identité est entièrement définie par la clé.

## Chiffrement

- Les conversations privées utilisent **MLS** (Messaging Layer Security) — la même famille de protocoles qui sous-tend le chiffrement des grandes messageries. Il offre la *forward secrecy* : même si une clé fuite à l'avenir, les anciennes conversations ne pourront pas être lues rétroactivement.
- Le contenu des chaînes est chiffré avec une clé de chaîne distincte — la forward secrecy n'est délibérément pas appliquée ici (une chaîne est par nature une archive à laquelle on revient pendant des années, pas une conversation destinée à être « oubliée »).
- La base de données locale sur l'appareil est également chiffrée — la clé de chiffrement est dérivée de votre mot de passe.
- Les fichiers et pièces jointes sont chiffrés séparément avant d'être envoyés sur le serveur de stockage (Blossom) — le serveur ne stocke que le texte chiffré.

## De quoi l'application est faite

- **Preact** — un moteur d'interface léger (réactif, mais bien plus petit que des alternatives plus connues).
- **Dexie.js** — une surcouche de la base de données intégrée au navigateur (IndexedDB), où toute votre conversation est stockée localement.
- Primitives cryptographiques — bibliothèques de la famille **@noble** (secp256k1, ChaCha20-Poly1305, SHA-256 et autres), l'implémentation de MLS est **ts-mls**.
- L'application entière est compilée en un seul fichier html — ce qui simplifie le déploiement et les mises à jour.

## Côté serveur

- **Relay** (serveur de messages) — utilise **strfry**, une implémentation de relay Nostr mature et largement éprouvée.
- **Blossom** — un protocole et un serveur distincts pour le stockage des fichiers, liés aux mêmes clés que le reste de Nostr.
- Chacun de ces deux composants peut être hébergé par n'importe qui — voir la section sur le serveur personnel dans les paramètres du profil.

## Code source ouvert

Le code du projet est ouvert et sera entièrement consultable par quiconque sur **git.ugolok.tech**.
