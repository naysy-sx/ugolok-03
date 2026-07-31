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
Контракты: PROCESS-DOCS/CONTRACTS.md (создать на этапе плана, до
первого вызова воркера).
Тесты: node --test, папка tests/.

## Расположение файлов проекта (наведён порядок в корне — этап 57-довесок)

Skill "orchestrate-workers" ссылается на CONTRACTS.md/PLAN.md/
DESIGN.md/log.md ПО ГОЛОМУ ИМЕНИ (сам skill написан как переиспользуемый,
без привязки к конкретному проекту) — в ЭТОМ проекте они физически лежат
не в корне, а здесь:

- `PROCESS-DOCS/` — живая память проекта, обновляется каждый этап:
  `TECH.md` (техзадание), `DESIGN.md` (design-записки), `CONTRACTS.md`
  (контракты между модулями), `PLAN.md` (план по этапам), `log.md`
  (телеграфный журнал вызовов воркера).
- `FEATURE-SPECS/` — точечные ТЗ уже реализованных фич, редко
  перечитываются: `VOICE.md` (FSM звонков), `CONTACTS-FSM.md` (FSM
  контактов/заявок), `VISUAL.md` (исходный HTML/SVG-фрагмент иконок,
  использован при вёрстке, в сборку не идёт).
- `FILES-DOCS/` — то же самое, но для раздела "Файлы" (`TASK.md`,
  `MATH.md`, `ALGO.MD`) — было организовано раньше, не переносилось.
- `ASSETS-SOURCE/` — сырые исходники ассетов, уже встроенных в код:
  `CALL.txt` (base64 mp3, дублируется в
  `src/domain/calls/ringtone-asset.js` — исходник хранится для справки,
  приложение его не читает).
- `docs/` — операционная документация ДЛЯ ПОЛЬЗОВАТЕЛЯ (self-hosting,
  runbook, verify), не для Claude — не путать с PROCESS-DOCS/.