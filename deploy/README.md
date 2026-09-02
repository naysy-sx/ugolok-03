# deploy/ — каркас будущего VPS-стека

Рядом с двумя уже существующими путями, **не вместо** них:

| Путь | Когда |
|---|---|
| `server/*/setup.sh` + `run.sh` | LAN на Mini, главный путь сейчас (`docs/self-hosting.md`) |
| `agent/` | инсталлятор своего инстанса (этап 63, пейринг) |
| `deploy/compose.yml` | каркас поставки; на VPS станет основным |

Канон поставки клиента: `docs/delivery.md`. Локальный цикл: `docs/local-cicd.md`.

## Что умеет скелет

Сервисы (имена фиксированы): `web`, `relay`, `blossom`, `turn`, `proxy`.

- `docker compose up` — только `web`: Caddy раздаёт `../dist` на порту **8088**, монтирует `config.example.json` как `/config.json`.
- `--profile full` — пытается поднять relay/blossom/turn. Образы relay/blossom помечены `FIXME` / `TODO`.
- `--profile vps` — Caddy на 80/443.

Прокси — **Caddy**. Traefik не используется.

Скопируйте `env.example` → `.env` (gitignore). Боевой пароль TURN только там, не в git.

Не поднимать этот compose параллельно с `server/coturn` или `agent/compose/` — порты 7777/8080/3478 пересекаются.

## Блокеры на Mac Mini M2 (darwin/arm64)

Это не «потом допишем в уме», а текущий факт:

- **strfry** собирается из C++/uWebSockets; в Docker на ARM часто падает линковка (в `agent/compose/relay.Dockerfile` уже есть обход для linux-сборки — этот скелет его не дублирует).
- **blossom-server** тянет `mattn/go-sqlite3` (cgo). Кросс в контейнере на M2 может требовать отдельного toolchain.
- **coturn** образ `coturn/coturn` обычно есть под arm64, но UDP-диапазон и `network_mode` на Desktop Docker — отдельная боль; для LAN на Mini проще Homebrew-путь `server/coturn/`.
- Сборка образов в этом этапе **не** является критерием приёмки. Честный минимум — сервис `web` раздаёт статику.

Готовый рабочий Docker-бандл инстанса смотрите в `agent/compose/` (этап 63), не здесь.

## Перенос на VPS

Чеклист: `docs/environments.md`. Этот каталог тогда наполняется реальными `image:` / `build:`, Caddyfile под домены и секретами из env.
