# Поставка клиента «Уголок»

_Актуально на 2026-09-05, описывает origin Forgejo (`git.ugolok.tech`), ветки `dev`/`main`/`prod`._

Канон поставки. Если этот файл противоречит черновику или переписке — верить ему.

## 1. Что такое релиз

Релиз клиента — **annotated git-тег `vX.Y.Z` на `main`**.

Не релиз:

- коммит в ветке без тега;
- файлы из git-ветки (`dist/` в git не хранится);
- тег фазы вроде `v0.1.0-phase1` (исторические якоря плана, не канал клиента).

Канон версии — тег, не `"version"` в `package.json`.

## 2. Откуда берутся артефакты

Источник для людей и аудита:

- `git.ugolok.tech` (Forgejo) — origin с 2026-09-05; Release там по тегу пока **не собирается** (`.forgejo/workflows/release.yml` не запускается — `runs-on: ubuntu-latest`, такого раннера на Forgejo нет);
- GitHub (`naysy-sx/ugolok-03`) остаётся вторым remote — Release там собирается, если туда тоже пушат тег.

Источник для клиентов:

- канон — хост обновлений `https://updates.ugolok.tech`;
- на git-хост клиенты за сборками **не** ходят.

Дерево канала:

```text
updates root/
  version.json
  changelog.md
  latest/
    index.html
    service-worker.js
    SHA256SUMS
    SHA256SUMS.asc      # если есть ключ
    version.json
    config.example.json
  vX.Y.Z/
    …то же…
```

`latest/` — копия той же версии, что верхний `version.json`.

Локально то же дерево собирает `scripts/release-pack.sh` в `dist-updates/` (не в git).

## 3. Ветки

Есть:

- `dev` — повседневная работа; каждый push выкладывает `test.ugolok.tech`;
- `main` — проверенное из `dev`; всегда должна собираться; на живой сайт сама не едет;
- `prod` — ручной merge `main` → `prod`; push выкладывает `ugolok.tech`;
- короткие `feature/*` / `fix/*` — в `dev`.

`dev` → `test.ugolok.tech`. `prod` → `ugolok.tech`. `main` — интеграция, без автовыкладки.

## 4. Окружения

| Имя | Где | Ветка |
|---|---|---|
| local | Mini, localhost | рабочая копия |
| test | `test.ugolok.tech` | `dev` |
| prod | `ugolok.tech` | `prod` |

Подробности: `docs/environments.md`.

## 5. Как клиент получает обновления СЕЙЧАС

Реально работающий путь, без тега и без `updates.ugolok.tech`:

1. `deploy-env.sh` при каждом push в `dev`/`prod` пишет свежий `dist/index.html` и `dist/service-worker.js` в `/var/www/ugolok-test` или `/var/www/ugolok`.
2. Caddy отдаёт оба файла с `Cache-Control: no-cache` (`deploy/caddy/{test,prod}.caddy`) — браузер каждый раз перепроверяет с сервером, не берёт слепо из своего HTTP-кэша.
3. `service-worker.js`: `self.skipWaiting()` на `install` + `self.clients.claim()` на `activate` — новый Service Worker подхватывает управление без ожидания закрытия всех вкладок. Имя кэша `ugolok-cache-v{BUILD_HASH}` — старые версии кэша чистятся на `activate`.
4. Итог: открыть/обновить страницу — почти всегда означает получить свежую сборку. Отдельного экрана «доступно обновление» и загрузчика в UI нет.

### План, не реализовано

Ниже — контракт канала `updates.ugolok.tech`, тег `vX.Y.Z`, `version.json`/`SHA256SUMS`. Описание оставлено (дерево канала пригодится), но по факту:

- клиент `version.json` **не читает** — ни на `updates.ugolok.tech`, ни где-либо ещё;
- `.forgejo/workflows/release.yml` **не запускается** на Forgejo (`runs-on: ubuntu-latest` — такого раннера там нет; см. `PROCESS-DOCS/VPS/TZ-cicd-hardening.md`, этап 5).

1. Манифест: `https://updates.ugolok.tech/version.json` (latest) и `https://updates.ugolok.tech/vX.Y.Z/version.json`.
2. Артефакты (`index.html`, `service-worker.js`, суммы) — с того же хоста.
3. PWA на рабочем origin (`ugolok.tech`) дополнительно через Service Worker.
4. Натив/OTA — позже; URL канала уже этот.

Локальный стенд канала: `http://127.0.0.1:8787/version.json` (см. `docs/local-cicd.md`).

## 6. Почему клиент не пересобирается под каждый IP

Слои эндпоинтов (от сильного к слабому):

1. Явные настройки в UI / `ugolok.bootstrapEndpoints.v1` в localStorage.
2. Опциональный `config.json` с того же origin (слой этого этапа, в коде клиента может ещё не быть).
3. Build-time `__BUILD_DEFAULT_*` из Vite.

Env `BUILD_DEFAULT_*` остаётся запасным путём оффлайн-сборки. Подробности: `docs/config.md`.

## 7. Forgejo — origin, GitHub — второй remote

- `origin` = `git.ugolok.tech` (Forgejo) — повседневная работа, PR, `dev`/`main`/`prod`, деплой-раннер (лейбл `ugolok`).
- `github` remote (`naysy-sx/ugolok-03`) остаётся — GitHub Actions (`.github/workflows/`) реально гоняются, только если код туда тоже запушен.
- Клиенты как ходили, так и ходят на `updates.ugolok.tech`, не на git-хост — но см. §5, этот канал сейчас не реализован.

## 8. Self-hosted инстанс

Свой остров обновляет **свой** клиент и свой compose/setup. Он не подменяет официальный `updates.ugolok.tech`, и официальный канал не подменяет чужой инстанс.

Три серверных пути, не смешивать:

- LAN как сейчас: `server/*/setup.sh` + `run.sh` + `npm run dev` — главный путь для локальной сети (`docs/self-hosting.md`).
- Агент этапа 63: `agent/` (пейринг, свой compose) — инсталлятор своего инстанса, не канал поставки официального клиента.
- Каркас будущего VPS: `deploy/compose.yml` — скелет рядом, не вместо.

## 9. Как собрать релиз

На Mini:

```bash
git checkout main
./scripts/ci-check.sh
./scripts/release-pack.sh          # или ./scripts/release-pack.sh vX.Y.Z
# подпись: без SKIP_GPG, если есть ключ
./scripts/serve-updates.sh         # опционально, :8787
```

Тег: `git tag -a vX.Y.Z -m "vX.Y.Z"` на зелёном `main`. Пока продукт нестабилен — `0.Y.Z`. Старые теги фаз не переименовывать.
