# Поставка клиента «Уголок»

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

- сейчас GitHub Release репозитория;
- позже Release на `git.ugolok.tech` (Forgejo).

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

- `main` — всегда должна собираться;
- `feature/<коротко>` — PR в `main`;
- `hotfix/<коротко>` — PR в `main`;
- короткие `phase-*` / `spike-*` / `fix/*` / `chore/*` — как в `docs/RUNBOOK.md`.

Нет и не заводить: долгоживущие `test`, `prod`, `develop`.

Solo на Mini: одношаговый зелёный коммит прямо в `main` по-прежнему допустим (RUNBOOK §6). Каркас CI это не запрещает. PR желательны для многокоммитных работ.

## 4. Окружения

Окружения — **не ветки**.

| Имя | Сейчас | Код |
|---|---|---|
| local | Mini, localhost | рабочая копия |
| test | позже VPS или другой порт/profile на Mini | `main` |
| prod | позже `ugolok.tech` | тег `vX.Y.Z` |

Подробности: `docs/environments.md`.

## 5. Как клиент будет получать обновление

1. Манифест: `https://updates.ugolok.tech/version.json` (latest) и `https://updates.ugolok.tech/vX.Y.Z/version.json`.
2. Артефакты (`index.html`, `service-worker.js`, суммы) — с того же хоста.
3. PWA на рабочем origin (`ugolok.tech`) дополнительно через Service Worker.
4. Натив/OTA — позже; URL канала уже этот.

В этом этапе клиент **не обязан** читать `version.json`. Загрузчика обновлений в UI нет. Контракт и пример достаточны.

Локальный стенд канала: `http://127.0.0.1:8787/version.json` (см. `docs/local-cicd.md`).

## 6. Почему клиент не пересобирается под каждый IP

Слои эндпоинтов (от сильного к слабому):

1. Явные настройки в UI / `ugolok.bootstrapEndpoints.v1` в localStorage.
2. Опциональный `config.json` с того же origin (слой этого этапа, в коде клиента может ещё не быть).
3. Build-time `__BUILD_DEFAULT_*` из Vite.

Env `BUILD_DEFAULT_*` остаётся запасным путём оффлайн-сборки. Подробности: `docs/config.md`.

## 7. GitHub сейчас, Forgejo потом

- Исходники и Actions сейчас на GitHub (`naysy-sx/ugolok-03`).
- Позже origin переедет на `git.ugolok.tech`. Каркас workflow уже лежит в `.forgejo/workflows/` — смена URL и runner-а, не переписывание проекта.
- Клиенты как ходили, так и будут ходить на `updates.ugolok.tech`, не на git-хост.

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
