# deploy/island — боевой остров ugolok.tech

_Актуально на 2026-09-05, описывает выкладку через `scripts/deploy-env.sh` (ветки dev/prod)._

Снимок стека, который крутится на VPS. Не `deploy/compose.yml` (скелет) и не `agent/compose/` (инсталлятор своего инстанса).

| Где в git | Где на VPS |
|---|---|
| `deploy/caddy/{Caddyfile,test.caddy,prod.caddy}` | `/etc/caddy/Caddyfile` + `/etc/caddy/sites/*.caddy` (Caddy на хосте, `scripts/apply-caddy.sh`) |
| остальные файлы этой папки (`deploy/island/`) | `/opt/ugolok/island/` |
| `coturn.conf.example` | `/opt/ugolok/island/coturn.conf` — пароль **не** в git |

`deploy/island/Caddyfile` — не используется, оставлен как указатель на `deploy/caddy/` (переехало ещё до этого README).

Caddy на хосте. Relay и Blossom слушают только localhost. coturn — `network_mode: host`.

## Секрет TURN

`coturn.conf.example` копируется в `coturn.conf`; вместо статического пароля одного пользователя (`lt-cred-mech`) — `use-auth-secret` + `static-auth-secret=…` (TURN REST API, RFC-style временные креды). Файл **chmod 644**: образ `coturn/coturn` запускается как `nobody` и иначе молча стартует без конфига (no-auth, порты вне UFW).

Тот же секрет — в `TURN_STATIC_AUTH_SECRET` у `turncreds-server` (см. ниже): один статический секрет на стороне сервера, клиент никогда его не видит — получает только временные HMAC-креды с TTL.

**Порядок переключения** (см. `PROCESS-DOCS/VPS/TZ-cicd-hardening.md`, этап 6.7) — менять `coturn.conf` на боевом только ПОСЛЕ того, как клиент уже умеет запрашивать временные креды, иначе звонки на проде ломаются между шагами.

`deploy/island/coturn.conf` в `.gitignore`.

## turncreds-server

Публичный (без токена) HTTP-сервис выдачи временных TURN-кредов — `agent/cmd/turncreds-server/` (Go, переиспользует `agent/internal/turncreds.Mint`). Слушает `127.0.0.1:8090`, наружу не торчит — Caddy проксирует `/api/turn-credentials` (`deploy/caddy/{test,prod}.caddy`).

Секрет — `TURN_STATIC_AUTH_SECRET`, тот же, что `static-auth-secret` в `coturn.conf`, через `env_file` (в `.gitignore`, не в git). Контракт и CORS/rate-limit — в самом `agent/cmd/turncreds-server/main.go`.

## Как выкатывать правку

1. Менять файлы здесь, в репозитории (`deploy/island/`, `deploy/caddy/`).
2. Коммит в `dev`, push на `origin` (`git.ugolok.tech`) — сразу выкладка на `test.ugolok.tech` (`deploy-test.yml` → `scripts/deploy-env.sh test`), проверить там.
3. Если ок: `main` (ff-only merge из `dev`), затем ручной `prod` (ff-only merge из `main`), push — `deploy-prod.yml` → `scripts/deploy-env.sh prod` на живой `ugolok.tech`.

Всё остальное делает `deploy-env.sh` сам, без ручных шагов на VPS:

- собирает клиент (контейнер `node:22-bookworm`, `BUILD_DEFAULT_*` из окружения джобы) и кладёт `dist/` в `/var/www/ugolok` (или `/var/www/ugolok-test`) через rsync;
- копирует `deploy/island/` (или `deploy/island-test/`) в `/opt/ugolok/island` (`/opt/ugolok/island-test`) — кроме `coturn.conf` (боевой секрет не трогается) — и делает `docker compose up -d`;
- накатывает `deploy/caddy/{test,prod}.caddy` через `scripts/apply-caddy.sh` (режим `site` для test — трогает только один site-файл, `full` только для prod) и `systemctl reload caddy`.

Не править конфиги «на живую» на сервере в обход git — `deploy-env.sh` перезапишет ручную правку следующим же деплоем.

## Обслуживание

Build-кэш и неиспользуемые образы Docker растут с каждым `docker compose up -d --build` (сборка `turncreds-server`/relay/blossom на каждый деплой) — раз в месяц освобождать место. Разовая команда: `docker system prune -f && docker builder prune -f`. Или таймер (`deploy/island/systemd/docker-prune.{service,timer}`) — установить один раз:

```
sudo cp deploy/island/systemd/docker-prune.* /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now docker-prune.timer
```

## Ветки и выкладка

| Ветка | Когда | Куда |
|---|---|---|
| `dev` | каждый push | `test.ugolok.tech` (`scripts/deploy-env.sh test`) |
| `main` | merge из `dev` после проверки | никуда само |
| `prod` | ручной merge `main` → `prod` | `ugolok.tech` (`scripts/deploy-env.sh prod`) |

Caddy: `deploy/caddy/`. Тестовый остров (отдельные relay/Blossom): `deploy/island-test/`. TURN общий.
