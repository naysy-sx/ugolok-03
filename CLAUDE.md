# Проект: Мессенджер "Уголок" на протоколе nostr

Работа по skill "orchestrate-workers" — всегда.

Воркер: qwen2.5-coder:7b через ./worker.sh (Ollama, localhost).

## Стек
**Ядро:**
- **Preact + @preact/signals** — UI (4 KB, push-based реактивность)
- **Dexie.js** — IndexedDB-обёртка (append-only log, compound indexes, транзакции)
- **Vite + vite-plugin-singlefile** — сборка в один `index.html`

**Крипто:**
- **@noble/curves** — secp256k1, Schnorr-подписи
- **@noble/hashes** — SHA-256, HMAC, HKDF
- **@noble/ciphers** — ChaCha20-Poly1305 (контент каналов, БД, файлы)
- **@scure/bip39** / **@scure/bip32** — мнемоника и деривация ключей
- **nostr-tools** — NIP-01, NIP-17, NIP-19, NIP-42, NIP-44, NIP-59
- **ts-mls** — MLS (forward secrecy для DM)

**Инфраструктура:**
- **Comlink** — Web Worker для CPU-bound крипто (2 KB)
- **Web Crypto API** — как бэкенд для @noble

**Деплой:**
- Два файла: `index.html` + `service-worker.js` на HTTPS
- Relay: **strfry**
- Blob-хранилище: **Blossom** (свой HTTP-клиент, не SDK)

**Бюджет бандла:** ~190–250 KB gzip базового кода (лимит NF-11: 1304 KB — повышен пользователем на +1 МБ, этап 47-довесок-4, под встраиваемые ассеты). Категорически избегать: moment.js, lodash, axios, UI-фреймворки тяжелее Preact, runtime CSS-in-JS, XState.

Развёртывание: локальная сеть, НЕ публичный интернет.
Контракты: CONTRACTS.md (создать на этапе плана, до первого
вызова воркера).
Тесты: node --test, папка tests/.