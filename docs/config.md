# Runtime-конфиг инстанса

_Актуально на 2026-09-05, описывает config.json и приоритет источников эндпоинтов (dev/test/prod)._

`config.json` — не секрет. Это эндпоинты конкретного острова (relay, Blossom, ICE), чтобы **не пересобирать** `index.html` под каждый IP.

Загрузчик — `src/domain/settings/runtime-config.js` (этап 4A, TZ-cicd-hardening): `fetch('./config.json', {cache:'no-store'})` с таймаутом 3с, любая ошибка (сеть, 404, битый JSON, таймаут) → `{}`, приложение откатывается на build-time дефолт и не виснет. Загрузка дожидается в `transport.js` (`connect()`) до первого обращения к `readBootstrapEndpoints()` — если по какой-то причине это архитектурно невозможно в конкретном месте вызова, старт идёт с build-дефолтов с последующим переключением (сейчас такого места нет — `connect()` асинхронна и ждёт).

## Приоритет слоёв (от сильного к слабому)

1. **Явные настройки пользователя** в UI и `localStorage` ключ `ugolok.bootstrapEndpoints.v1` (`src/domain/settings/bootstrap-endpoints.js`).
2. **`config.json`** с origin инстанса, реально читается клиентом (`runtime-config.js`, `getRuntimeConfig()`) — вплетён в `buildTimeDefaults()` внутри `bootstrap-endpoints.js`, единственное место сборки дефолтов.
3. **Build-time `__BUILD_DEFAULT_*`** из `vite.config.js` через `src/config.js` — фолбэк, если `config.json` недоступен или пуст.

Дефолты Vite сегодня: relay `ws://127.0.0.1:7777`, Blossom `http://127.0.0.1:8080`, ICE localhost TURN `ugolok` / `ugolok-dev` + Google STUN fallback.

Запасной оффлайн-путь сборки (не отменяет `config.json`):

- `BUILD_DEFAULT_RELAYS`
- `BUILD_DEFAULT_BLOSSOM_SERVERS`
- `BUILD_DEFAULT_ICE_SERVERS`
- `BUILD_BOOTSTRAP_RELAYS`

## TURN-креды (этап 6, TZ-cicd-hardening)

Официальный сайт (`ugolok.tech`/`test.ugolok.tech`) **не** зашивает пароль TURN в сборку. `config.json.turnCredentialsUrl` (сейчас `/api/turn-credentials`, тот же origin) — эндпоинт временных кредов, `agent/cmd/turncreds-server` на VPS. Клиент: `src/domain/settings/bootstrap-endpoints.js`'s `fetchTurnCredentials(url)` + `resolveCallIceServers()` — вызывается перед КАЖДЫМ новым `RTCPeerConnection` (`media-controller.js`), креды кэшируются в памяти до `expiry-60с`.

Если `turnCredentialsUrl` не задан (self-host/LAN, `deploy/config.example.json`) — прежнее поведение, статические креды из `config.json`/build-time дефолта, без изменений.

Если эндпоинт недоступен (сеть, таймаут 3с, сервис лежит) — фолбэк на STUN-only (TURN-записи остаются в списке ICE-серверов, но без `username`/`credential` — браузер их просто не сможет использовать для релея). Запись в диагностику: «TURN: креды недоступны, только STUN». Звонок в одной сети (host/srflx-кандидаты) при этом всё ещё пройдёт; через симметричный NAT — нет, это ожидаемая деградация, не баг.

## Секреты

TURN credential в `deploy/config.example.json` — **только dev** (`ugolok` / `ugolok-dev`), это self-host/LAN путь, не официальный сайт (см. выше).
Боевой секрет TURN (`TURN_STATIC_AUTH_SECRET` у `turncreds-server`, `static-auth-secret` у coturn) в git не класть: `deploy/island/turncreds.env` и `deploy/island/coturn.conf` — оба в `.gitignore`, только на VPS.

Не коммитить: `deploy/.env`, приватные ключи, `*.asc` с секретом.

Пример: `deploy/config.example.json`, `deploy/island/turncreds.env.example`.
