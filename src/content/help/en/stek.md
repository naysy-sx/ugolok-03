# Technology and how the project is built

This page is for those curious to look "under the hood." You don't need to understand it to use the app.

## Protocol

Ugolok is built on **Nostr** — an open protocol for decentralized messaging. The core idea of Nostr is simple: every user has a pair of keys (public and private), messages are signed with the private key and published to one or more servers (called *relays*). No one issues accounts — identity is entirely defined by the key.

## Encryption

- Private conversations use **MLS** (Messaging Layer Security) — the same class of protocol underlying encryption in major messengers. It provides *forward secrecy*: even if a key leaks in the future, old conversations can't be read after the fact.
- Channel content is encrypted with a separate channel key — forward secrecy is deliberately not applied here (a channel is by nature an archive people return to over the years, not a conversation meant to be "forgotten").
- The local database on the device is also encrypted — the encryption key is derived from your password.
- Files and attachments are encrypted separately before being uploaded to the storage server (Blossom) — the server only stores ciphertext.

## What the app is built from

- **Preact** — a lightweight UI engine (reactive, but many times smaller than better-known alternatives).
- **Dexie.js** — a wrapper around the browser's built-in database (IndexedDB), where all your conversations are stored locally.
- Cryptographic primitives — libraries from the **@noble** family (secp256k1, ChaCha20-Poly1305, SHA-256, and others), MLS implementation — **ts-mls**.
- The entire app is built into a single HTML file — this makes it simpler to deploy and update.

## Server side

- **Relay** (message server) — uses **strfry**, a mature and widely tested Nostr relay implementation.
- **Blossom** — a separate protocol and server for file storage, tied to the same keys as the rest of Nostr.
- Anyone can run both components themselves — see the self-hosting section on the profile screen.

## Open source

The project's code is open and will become fully available for anyone to study at **git.ugolok.tech**.
