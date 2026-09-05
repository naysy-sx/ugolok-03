# Runtime-конфиг инстанса

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

## Секреты

TURN credential в `deploy/config.example.json` — **только dev** (`ugolok` / `ugolok-dev`).
Боевой пароль TURN в git не класть: плейсхолдер в `deploy/env.example`, в проде — секрет окружения.

Не коммитить: `deploy/.env`, приватные ключи, `*.asc` с секретом.

Пример: `deploy/config.example.json`.
