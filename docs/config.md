# Runtime-конфиг инстанса

`config.json` — не секрет. Это эндпоинты конкретного острова (relay, Blossom, ICE), чтобы **не пересобирать** `index.html` под каждый IP.

Клиент в этом этапе файл может ещё не загружать. Контракт и пример важнее загрузчика. Если загрузчик появится — крошечный, с того же origin (или явно заданного URL), не блокирует UX при отсутствии файла.

## Приоритет слоёв (от сильного к слабому)

1. **Явные настройки пользователя** в UI и `localStorage` ключ `ugolok.bootstrapEndpoints.v1` (`src/domain/settings/bootstrap-endpoints.js`).
2. **Опциональный `config.json`** с origin инстанса — слой этого ТЗ, в `src/` может отсутствовать.
3. **Build-time `__BUILD_DEFAULT_*`** из `vite.config.js` через `src/config.js`.

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
