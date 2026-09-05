# Окружения и будущие хосты

_Актуально на 2026-09-05, описывает окружения local/test/prod._

Окружения завязаны на долгоживущие ветки `dev` / `main` / `prod`. Подробности: `docs/delivery.md`.

## Сейчас

| Имя | Где | Что запущено | Какой код |
|---|---|---|---|
| local | эта машина, localhost / LAN | `npm run dev` + `server/*/run.sh` | рабочая копия |
| test | `test.ugolok.tech` | Caddy + `deploy/island-test/` | ветка `dev`, статика в `/var/www/ugolok-test` |
| prod | `ugolok.tech` | Caddy + Forgejo + `deploy/island/` + Forgejo Actions runner (лейбл `ugolok`) | ветка `prod`, статика в `/var/www/ugolok`; сборка клиента — контейнер `node:22-bookworm` на этом же хосте |

### Осознанное отступление от ТЗ VPS

ТЗ на настройку VPS (`PROCESS-DOCS/VPS/TZ-ugolok-vps-grok-terminal.md`) явно запрещало ставить Node/CI-раннер на хост — машина на 2 ГБ RAM, swap заводили только под Docker+Caddy. Раннер (лейбл `ugolok`) и сборка в `node:22-bookworm` внутри Docker всё равно поставлены на этот хост — выбрано ради простоты (нет второй машины с сетевым доступом к `/var/www` и docker-сокету).

Условие пересмотра: если после встраивания тестов в деплой (`scripts/deploy-env.sh`, `npm test` внутри контейнера) зелёный прогон стабильно дольше нескольких минут, или в `dmesg`/логах контейнера видны OOM-килы — переходить на вариант «сборка на Mini, выкладка готового `dist/` на VPS по rsync/SSH». Этот вариант в этом ТЗ не реализован, только зафиксирован как запасной путь. Пока — контейнер сборки ограничен памятью (`--memory`/`--memory-swap` в `deploy-env.sh`), чтобы падать по OOM внутри себя, а не ронять Caddy/relay на хосте.

Порты, которые нельзя пересекать:

| Порт | Роль |
|---|---|
| 5173 | Vite dev |
| 4173 | Vite preview (не держать обязательным вместе с 8088) |
| 7777 | relay (strfry) |
| 8080 | Blossom |
| 3478 | TURN/STUN |
| 8088 | static web / preview из `deploy/` |
| 8787 | локальный updates endpoint |
| 80/443 | запас Caddy на будущем VPS |

Не поднимать одновременно `deploy/compose.yml` и живой `server/coturn` — оба хотят 3478. Не поднимать `deploy/` параллельно с `agent/compose/` без смены портов.

## Будущие хосты (только план, DNS не настраивать)

| Хост | Роль |
|---|---|
| `ugolok.tech` | рабочий веб-клиент (PWA), origin пользователя |
| `git.ugolok.tech` | Forgejo: исходники, PR, Actions, теги. Не витрина сборок для клиента |
| `updates.ugolok.tech` | единственный публичный канал обновлений |
| `docs.ugolok.tech` | документация, можно позже |
| `mail.ugolok.tech` | вне скоупа |

## Чеклист дня покупки VPS

Остров `ugolok.tech` уже поднят. Канон конфигов — `deploy/island/` и `deploy/caddy/` в этом репозитории. Правки: локально → `dev` (тест) → `main` → вручную `prod` (живой сайт). Не руками на сервере в обход git.

1. Docker + Caddy на VPS.
2. Forgejo на `git.ugolok.tech` (только git/CI, не раздача клиента).
3. Static host `updates.ugolok.tech`, туда дерево релиза из CI (`dist-updates/`).
4. Рабочий клиент на `ugolok.tech` (можно копия `updates/.../latest/`; origin пользователя — этот домен).
5. git remote + runner; в workflow сменить `runs-on` на лейбл своего runner-а.
6. Секреты (GPG, token выкладки) в Forgejo Secrets. Боевой пароль TURN — только секрет окружения, не в git.
7. DNS и публичный TLS — отдельная работа, не часть текущего этапа.

Self-hosted остров настраивает свои домены/IP через `config.json` / UI, не через пересборку официального `index.html`.
