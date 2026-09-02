# ТЗ: CI/CD и реорганизация поставки «Уголок» (локальный этап, до покупки VPS)

Версия ТЗ: 1.3  
Дата: 2026-09-01  
Адресат: агент в терминале  
Репозиторий: https://github.com/naysy-sx/ugolok-03  
Машина: Apple Mac Mini M2, localhost / LAN  
Публичный VPS **не куплен**. DNS не настраивать. Origin на Forgejo не переносить. Не пушить, пока в сессии нет явной просьбы.

Это замена ТЗ 1.2: те же цели, меньше развилок, факты сверены с репозиторием.

---

## 0. Зачем

Сейчас в репозитории **нет CI**. Нет `.github/workflows`, нет `.forgejo/workflows`, нет runner-а, нет автовыкладки. Есть `npm test`, `npm run build`, `scripts/release-hash.sh` и текстовые runbook-и.

Нужно на домашней машине:

1. Развести исходники, релизы, окружения и будущие домены (документально + файлы-контракты).
2. Сделать каркас CI так, чтобы перенос на VPS был сменой URL и runner-а, а не переписыванием проекта.
3. Не делать магазин приложений, Capacitor, почту, продакшен-TLS, мастер установки VPS.

Итог: репозиторий знает, как собирается, проверяется, версионируется и документируется. Локально это прогоняется руками и через GitHub Actions. Позже тот же каркас переедет на `git.ugolok.tech` (Forgejo).

---

## 1. Факты репозитория (не выдумывать иное)

Клиент: Preact + signals, Dexie, Vite + `vite-plugin-singlefile`.  
Артефакт веба: `dist/index.html` + `dist/service-worker.js`.  
Тесты: `npm test` → ровно `node --test tests/*.test.js` (нерекурсивный glob, так и оставить).  
Сборка: `npm run build`.  
Подпись релиза: `scripts/release-hash.sh` (сейчас: `npm ci` + build + SHA256 только для `index.html` + **обязательный** `gpg`; без gpg скрипт падает).

Сервер сейчас без Docker: `server/strfry` `ws://127.0.0.1:7777`, `server/blossom` `http://127.0.0.1:8080`, `server/coturn` `127.0.0.1:3478`.  
`npm run dev` поднимает часть этого через Vite-плагины (`apply: "serve"`). Плагины не трогать.

Документы процесса (не ломать, не переносить в `docs/`): `CLAUDE.md`, `PROCESS-DOCS/*`, `FEATURE-SPECS/`, `FILES-DOCS/`, `PROCESS-DOCS/REGLAMENT.md`.

Пользовательские docs: `docs/RUNBOOK.md`, `docs/self-hosting.md`, `docs/verify.md`.

Эндпоинты клиента **сегодня** (нет загрузки `config.json`):

1. Явные настройки пользователя / `ugolok.bootstrapEndpoints.v1` в localStorage (`src/domain/settings/bootstrap-endpoints.js`, `ui-settings.js`).
2. Build-time `__BUILD_DEFAULT_*` из `vite.config.js` через `src/config.js`.

Дефолты Vite: relay `ws://127.0.0.1:7777`, blossom `http://127.0.0.1:8080`, ICE localhost turn `ugolok` / `ugolok-dev` + Google STUN fallback. Переопределение деплоя — env `BUILD_DEFAULT_RELAYS`, `BUILD_DEFAULT_BLOSSOM_SERVERS`, `BUILD_DEFAULT_ICE_SERVERS`, `BUILD_BOOTSTRAP_RELAYS`.

Лимит бандла NF-11 — из **текущего** `CLAUDE.md`: **1304 KB gzip** `dist/index.html` (исторические 280 КБ в `PROCESS-DOCS/PLAN.md` не использовать). Запрет тяжёлых зависимостей — тот же абзац CLAUDE.md.

Node: в RUNBOOK «≥ 22», поля `engines` в `package.json` нет. В Actions ставить **Node 22**. Допустимо одной строкой добавить `"engines": { "node": ">=22" }` в `package.json`.

`package.json` `"version": "1.0.0"` и `"name": "ugolok-2-project"` — **не** источник версии релиза. Канон версии — git-тег `vX.Y.Z`. `package.json` из-за этого ТЗ не бампать.

`.gitignore` уже закрывает `dist/`, `node_modules/`, `.env*`, `server/*/strfry-src|strfry-db|blossom-src|blossom-db`, логи coturn. Добавить `dist-updates/`, `deploy/.env`. Приватные ключи и `*.asc` с секретом не коммитить.

История коммитов — короткие сообщения на русском. Новые коммиты так же.

RUNBOOK сейчас описывает solo-поток: мелкие зелёные коммиты прямо в `main`, ветки `phase-*` / `spike-*` / `fix/*` / `chore/*`, теги фаз вроде `v0.1.0-phase1`. Это не ломать молча. Целевая модель ниже **дополняет** RUNBOOK, а не притворяется, что так уже было.

Грабля CI, уже записанная в RUNBOOK §5: npm 11+ `allow-scripts` / `fsevents`. В `ci-check.sh` и Actions это нельзя оставить сюрпризом: либо зафиксировать политику в репо (как советует RUNBOOK), либо в скрипте явно обработать, чтобы `npm ci` был воспроизводим на ubuntu-latest и на Mini.

Playwright в devDependencies есть — **e2e в этом этапе не запускать**.

---

## 2. Цели этапа

1. Явная схема поставки (ветки, теги, окружения, артефакты) в `docs/delivery.md`.
2. Контракт runtime-конфига инстанса (`config.json` / `version.json`) без обязательной пересборки клиента под IP.
3. Каркас CI: проверка PR/`main` и релиз по тегу.
4. Каркас локального стека, который потом станет VPS-стеком.
5. Пользовательская документация поставки отдельно от `PROCESS-DOCS`.

---

## 3. Вне скоупа (не делать)

- Покупка/настройка VPS и доменов, публичный TLS, DNS.
- Capacitor / Electron / Tauri, экраны «IP/login/password + Установить».
- Пароль VPS в клиенте. Почтовый сервер.
- Коммит `dist/`, APK, образов, серверных БД в git.
- Переписывание мессенджера, крипто, UI-регламента, смена стека.
- Загрузчик обновлений и сверка версии в UI. Даже тихий `console` не обязателен. Контракт + пример + docs достаточно.
- Смена origin GitHub → Forgejo.
- Долгоживущие ветки `test`, `prod`, `develop`.
- Идеальный Docker-build strfry/blossom/coturn на darwin/arm64. Если не собирается за разумное время — скелет compose + честный список блокеров.
- Запуск долгоживущего сервера из CI (`npx serve` не вызывать в workflow).
- Новая архитектура мессенджера в отчёте.

Если без правки `src/` нельзя ввести `config.json` — **не вводить загрузчик в этом этапе**. Документ и пример важнее, чем код чтения. Минимальный загрузчик допустим только если он крошечный, за feature-flag / мёртвым кодом не блокирует UX и покрыт тестом. Сомнение → не трогать `src/`.

---

## 4. Инварианты

1. `npm test` и `npm run build` проходят той же командой, что сейчас.
2. `npm run dev` на localhost работает как сейчас (Vite-плагины на месте).
3. `scripts/release-hash.sh` остаётся ручным путём с GPG на Mini. Можно обернуть и смягчить «gpg обязателен», нельзя выкинуть или сломать вызов с локальным ключом.
4. Бюджет и запрет зависимостей — CLAUDE.md (1304 KB gzip).
5. `PROCESS-DOCS/` и `REGLAMENT.md` не «чистить».
6. `server/*/setup.sh` и `run.sh` не удалять. Compose — рядом, не вместо.
7. Новые docs и комментарии — на русском.
8. Секреты, ключи GPG, `.env` с паролями не коммитить. `package-lock.json` коммитить как было.
9. Не пушить.

---

## 5. Целевые файлы

Создавать только с реальным содержанием.

```text
.github/workflows/ci.yml
.github/workflows/release.yml
.forgejo/workflows/ci.yml          # копия смысла, не второй алгоритм
.forgejo/workflows/release.yml

docs/delivery.md                   # канон поставки, без файла этап не сдан
docs/environments.md
docs/versioning.md
docs/config.md
docs/local-cicd.md
docs/RUNBOOK.md                    # обновить ссылками, убрать противоречия
docs/self-hosting.md               # ссылки, не противоречить
docs/verify.md                     # если хеш-контракт расширится

deploy/README.md
deploy/compose.yml
deploy/env.example
deploy/config.example.json
deploy/version.example.json
deploy/Caddyfile.example           # только Caddy, не Traefik

scripts/release-hash.sh            # уже есть
scripts/ci-check.sh
scripts/release-pack.sh
scripts/serve-updates.sh           # опционально, только локально, не из CI
```

Не в git: `dist/`, `dist-updates/`, бинарники strfry/blossom, `*-db/`, ключи.

Имена: везде **`dist-updates/`**. Не писать `dist-release/`.

---

## 6. Контракты файлов

### 6.1. `version.json`

Публичный манифест. Поля:

```json
{
  "name": "ugolok",
  "version": "0.0.0",
  "gitTag": "v0.0.0",
  "gitSha": "REPLACE",
  "buildHash": "REPLACE",
  "releasedAt": "1970-01-01T00:00:00Z",
  "minClientVersion": "0.0.0",
  "channels": {
    "web": { "url": "/index.html" }
  },
  "notesUrl": "https://updates.ugolok.tech/changelog.md",
  "updatesBaseUrl": "https://updates.ugolok.tech"
}
```

- `version` без префикса `v`, `gitTag` с `v`.
- `buildHash` — содержимое/хеш из `SHA256SUMS` для `index.html` (NF-18), не путать с `__BUILD_HASH__` из Vite (тот для cache-bust SW).
- В релизе файл генерирует `scripts/release-pack.sh` из тега и `SHA256SUMS`.
- Прод: `https://updates.ugolok.tech/version.json` (latest) и `https://updates.ugolok.tech/vX.Y.Z/version.json`.
- Сейчас: `http://127.0.0.1:8787/version.json` — «local updates endpoint».
- Клиент в этом этапе `version.json` не обязан читать.

### 6.2. `config.json` (runtime инстанса, не секрет)

```json
{
  "instanceName": "local",
  "relays": ["ws://127.0.0.1:7777"],
  "bootstrapRelays": [],
  "blossomServers": ["http://127.0.0.1:8080"],
  "iceServers": [
    { "urls": "stun:127.0.0.1:3478" },
    {
      "urls": "turn:127.0.0.1:3478",
      "username": "ugolok",
      "credential": "ugolok-dev"
    }
  ]
}
```

Приоритет, который нужно **задокументировать** (от факта кода + будущий слой):

1. Явные настройки пользователя в UI / localStorage bootstrap.
2. Опциональный `config.json` с того же origin (или явно заданного URL) — слой этого ТЗ, в коде может ещё не быть.
3. Build-time `__BUILD_DEFAULT_*`.

TURN credential в примере — только dev. Боевой пароль TURN в git не класть: в `deploy/env.example` плейсхолдер, в docs — «секрет окружения».

Не делать обязательную пересборку `index.html` под IP. Env `BUILD_DEFAULT_*` остаётся запасным путём оффлайн-сборки.

### 6.3. Два слоя публикации (не путать)

1. Люди / аудит: GitHub Release сейчас, позже Forgejo Release на `git.ugolok.tech`.
2. Клиенты: `updates.ugolok.tech` — канон. На git-хост клиенты за обновлениями не ходят.

Дерево канала:

```text
updates root/
  version.json
  changelog.md
  latest/
    index.html
    service-worker.js
    SHA256SUMS
    SHA256SUMS.asc      # опционален, если нет ключа
    version.json
    config.example.json
  vX.Y.Z/
    …то же…
```

`latest/` — копия той же версии, что верхний `version.json`.

Локально то же дерево собирает `scripts/release-pack.sh` в `dist-updates/` (gitignore). Раздача: `scripts/serve-updates.sh` или вручную `npx serve dist-updates -p 8787`. Из GitHub Actions сервер не поднимать.

Хеш-контракт: сейчас `release-hash.sh` пишет в `SHA256SUMS` только `index.html`.  
В этом этапе: хешировать **`index.html` и `service-worker.js`**. Обновить `docs/verify.md`: критичный файл по-прежнему `index.html`; `service-worker.js` проверяется той же командой `sha256sum -c`. Ручной путь с GPG на Mini должен продолжать работать.

---

## 7. Ветки, теги, окружения

Рабочий поток после этого этапа:

```text
feature/<коротко>  --PR-->  main
hotfix/<коротко>   --PR-->  main
короткие phase-* / spike-* / fix/* / chore/*  — допустимы, как в RUNBOOK
релиз              = annotated tag vX.Y.Z на main
```

Окружения — не ветки:

| Имя | Сейчас | Код |
|---|---|---|
| local | Mini, localhost | рабочая копия |
| test | позже VPS или другой порт/profile на Mini | `main` |
| prod | позже `ugolok.tech` | тег `vX.Y.Z` |

Правила:

- Не создавать ветки `test`, `prod`, `develop`.
- `main` всегда должна собираться.
- Solo на Mini: одношаговый зелёный коммит в `main` по-прежнему допустим (RUNBOOK §6). Каркас CI это не запрещает.
- PR на GitHub желательны для многокоммитных работ, но не блокируют каркас.
- Semver. Пока продукт нестабилен — `0.Y.Z`. Тег всегда с `v`.
- Старые теги фаз (`v0.1.0-phase1`) не переименовывать и не запрещать задним числом. Новые релизы клиента — только `vX.Y.Z`.
- Документировать оба пути: «один разработчик на Mini» и «потом PR на Forgejo».

Будущие хосты (только docs, без DNS):

| Хост | Роль |
|---|---|
| `ugolok.tech` | рабочий веб-клиент (PWA), origin пользователя |
| `git.ugolok.tech` | Forgejo: исходники, PR, Actions, теги. Не витрина сборок для клиента |
| `updates.ugolok.tech` | единственный публичный канал обновлений |
| `docs.ugolok.tech` | документация, можно позже |
| `mail.ugolok.tech` | вне скоупа |

Self-hosted остров обновляет **свой** клиент и свой compose. Он не обязан и не должен подменять собой официальный `updates.ugolok.tech`, и официальный канал не подменяет чужой инстанс.

---

## 8. CI/CD без VPS

Логика живёт в скриптах. YAML только вызывает скрипты. Не дублировать шаги в YAML и в bash разными командами.

### 8.1. `scripts/ci-check.sh` — источник истины

```text
set -euo pipefail
npm ci
npm test
npm run build
проверить наличие dist/index.html и dist/service-worker.js
gzip-размер dist/index.html: напечатать, упасть если > 1304 KB
```

Код выхода ≠ 0 при любом шаге.  
Этот же скрипт запускает человек на Mini и GitHub Actions.

Размер: если в репо уже есть проверка NF-11 — вызвать её, вторую не плодить. Иначе `gzip -c dist/index.html | wc -c`.

`allow-scripts`: сделать `npm ci` предсказуемым на linux CI и macOS. Не оставлять интерактивный запрос.

### 8.2. `scripts/release-hash.sh`

Сохранить ручной контракт Mini (есть GPG → подпись как сейчас, аргумент ключа как сейчас).

Смягчить CI-путь:

- SHA256SUMS пишется всегда (уже оба файла, §6.3).
- Подпись: если `SKIP_GPG=1`, или нет `gpg`, или нет ключа — не падать, предупредить в stderr, `.asc` не создавать.
- `npm ci` + `build` внутри скрипта оставить для ручного «одной командой», но дать переменную `SKIP_INSTALL=1` / `SKIP_BUILD=1`, чтобы pack/CI не гоняли установку трижды.

Не ломать: `./scripts/release-hash.sh` и `./scripts/release-hash.sh <key-id>` на машине с gpg.

### 8.3. `scripts/release-pack.sh`

1. Если нет готового `dist/` — вызвать `ci-check.sh` или build.
2. Вызвать hash-путь с `SKIP_GPG` по умолчанию в CI; локально без SKIP — подпись, если ключ есть.
3. Собрать дерево `dist-updates/` из §6.3. Версия: аргумент, иначе `git describe --tags --exact-match` / `v0.0.0-dev`.
4. Заполнить `version.json` (tag, sha, buildHash, releasedAt UTC).
5. Короткий `changelog.md`: сообщения с последнего тега или заглушка, не тащить генератор.
6. Не стартовать HTTP-сервер.

### 8.4. GitHub Actions

`ci.yml`:

- `pull_request` и `push` в `main`.
- `runs-on: ubuntu-latest`.
- `permissions: contents: read`.
- checkout, `actions/setup-node` **Node 22**, cache npm, `bash scripts/ci-check.sh`.
- Не использовать `pull_request_target`.

`release.yml`:

- теги `v*.*.*` (строго три числа, без `-phase1`).
- те же проверки.
- pack без обязательного GPG.
- Upload artifacts + GitHub Release с деревом §6.3 (достаточно файлов `latest/` или `vX.Y.Z/`).
- `permissions: contents: write` только в этой workflow.
- Секрет `GPG_PRIVATE_KEY` опционален. Нет секрета — релиз без `.asc`, слот описан в docs.
- `dist/` в git не коммитить.
- Экшены пинить по major (`actions/checkout@v4`, `actions/setup-node@v4`) или по SHA. Не тянуть случайный latest.

### 8.5. Forgejo

Скопировать те же workflow в `.forgejo/workflows/`.  
В docs один абзац: когда появится `git.ugolok.tech` — включить Actions, поставить runner, поменять `runs-on` на лейбл своего runner-а, перенести секреты.  
Forgejo в этом этапе не устанавливать. `deploy/forgejo-compose.yml` не обязателен и не делать, если расползается.

Не использовать GitHub-only удобства без пометки. Предпочтительнее `gh release` / универсальная заливка файлов, чем обвязка, которая на Forgejo молча умрёт. Если берётся `softprops/action-gh-release` — в docs написать замену для Forgejo.

### 8.6. Ежедневный ручной цикл на Mini

```bash
git checkout main
npm ci
./scripts/ci-check.sh
./scripts/release-pack.sh
./scripts/serve-updates.sh   # опционально
```

Compose — отдельно, только если Docker уже стоит.

---

## 9. Локальный стек → будущий VPS

Одни имена сервисов. Порты не пересекать с Vite `5173`, strfry `7777`, blossom `8080`, turn `3478`, updates `8787`:

- web static / preview: `8088` (или Vite preview `4173`, не оба сразу как обязательные)
- relay: `7777`
- blossom: `8080`
- turn: `3478`
- caddy: запас под 80/443 на VPS
- local updates: `8787`

Два пути, оба описать в `docs/local-cicd.md` и `deploy/README.md`:

A. Как сейчас: `setup.sh` / `run.sh` + `npm run dev`.  
B. `deploy/compose.yml` — каркас, на VPS станет основным.

`compose.yml` обязан:

- перечислить сервисы `web`, `relay`, `blossom`, `turn`, `proxy`;
- брать host/домен из env (`deploy/env.example`);
- монтировать `config.json` и статику клиента;
- иметь profile или явные `image: FIXME` / `build: TODO` там, где образ ещё не собирается.

Минимум, который должен быть честным: сервис `web` может раздавать статику (`dist` или `dist-updates`). Остальное можно не собрать на M2/arm64. Блокеры перечислить в `deploy/README.md` (сборка strfry, cgo, coturn на ARM).

Прокси — **Caddy**. Traefik не добавлять.

Перенос на VPS — только чеклист в `docs/environments.md`, без претензии что он исполнен:

1. Docker + Caddy.
2. Forgejo на `git.ugolok.tech` (только git/CI).
3. Static host `updates.ugolok.tech`, туда дерево релиза из CI.
4. Рабочий клиент на `ugolok.tech` (можно копия `updates/.../latest/`, origin пользователя — этот домен).
5. Remote + runner.
6. Секреты (GPG, token выкладки) в Forgejo Secrets.

---

## 10. Документация

Канон — `docs/delivery.md`. Коротко и однозначно ответить:

1. Релиз = annotated tag `vX.Y.Z` на `main`.
2. Источник артефактов = Release / дерево `updates`, не файлы из git-ветки.
3. Какие ветки существуют (и каких нет).
4. Какие окружения существуют.
5. Как клиент будет получать обновление: `https://updates.ugolok.tech/version.json`, артефакты с того же хоста; PWA ещё через SW на `ugolok.tech`. Натив/OTA — позже, URL канала уже этот.
6. Почему клиент не пересобирается под каждый IP (`config.json` / настройки / build defaults).
7. GitHub сейчас, Forgejo потом, `updates.*` как канон для клиентов.
8. Self-hosted инстанс обновляется отдельно от официального клиента.

`docs/config.md` — приоритет слоёв из §6.2 и что TURN-секрет не живёт в клиентском репо.  
`docs/versioning.md` — semver, теги, чем `version.json` отличается от `__BUILD_HASH__` и от `package.json`.  
`docs/local-cicd.md` — 5 команд на Mini, allow-scripts, как смотреть Actions.  
`docs/environments.md` — localhost / test / prod + будущие домены + чеклист дня покупки VPS.

Обновить `docs/RUNBOOK.md`: ссылка на схему поставки; §6.4/§6.7 не должны говорить «прод = ветка» (сейчас этого нет — не выдумывать проблему). Добавить, что CI появился и что релиз клиента = semver-тег. Solo-исключение мелких коммитов в `main` сохранить.  
`docs/self-hosting.md` не переписывать под публичный интернет; добавить ссылку «поставка клиента — delivery.md», серверный путь `setup.sh` оставить главным для LAN.  
`PROCESS-DOCS` в `docs/` не переносить.

---

## 11. Порядок работ

Идти сверху вниз, не ждать человека после каждого файла.

1. Прочитать `CLAUDE.md`, `docs/RUNBOOK.md`, `docs/self-hosting.md`, `docs/verify.md`, `scripts/release-hash.sh`, `package.json`, `vite.config.js`, `src/config.js`, `src/domain/settings/bootstrap-endpoints.js`, `.gitignore`.
2. Написать `docs/delivery.md` и остальные docs этого ТЗ.
3. `.gitignore`, примеры `deploy/config.example.json` и `version.example.json`.
4. `scripts/ci-check.sh`, прогнать. Нет идентичной среды Mini — всё равно те же команды; в отчёте честно написать, что прогнано.
5. Смягчить GPG через обёртку/`SKIP_GPG`, не ломая ручной путь.
6. `scripts/release-pack.sh` (+ опционально `serve-updates.sh`).
7. GitHub Actions `ci.yml` + `release.yml`.
8. Копии Forgejo + абзац в docs.
9. Каркас `deploy/` (Caddy, compose-скелет).
10. Обновить RUNBOOK / self-hosting / verify.
11. Прогнать `npm test` и `npm run build`, если среда позволяет.

Коммиты: 3–6 логических, сообщения на русском, в духе текущей истории. Не один огромный «всё сразу». Не пушить.

---

## 12. Приёмка

- [ ] Есть `docs/delivery.md` с ветками/тегами/окружениями/артефактами.
- [ ] Есть примеры `config.json` и `version.json` и описание приоритета.
- [ ] Есть `scripts/ci-check.sh`, его же вызывает CI.
- [ ] Есть GitHub Actions на PR/`main` и на тег `v*.*.*`.
- [ ] Есть заготовка Forgejo.
- [ ] В git нет `dist/`, `dist-updates/`, серверных БД.
- [ ] `npm test` и `npm run build` не сломаны (если агент мог — запущены).
- [ ] `npm run dev` концептуально не сломан.
- [ ] `scripts/release-hash.sh` сохранён или обёрнут с обратной совместимостью.
- [ ] В документации нет git-веток `prod`/`test`.
- [ ] Есть честный список «после покупки VPS».
- [ ] Capacitor, почта, пароль VPS в приложении не появились.
- [ ] Загрузчик обновлений в UI не появился без крайней нужды.
- [ ] Имена каталогов везде `dist-updates/`, прокси — Caddy.
- [ ] Лимит размера — 1304 KB gzip из CLAUDE.md, не 280.

---

## 13. Отчёт агента

Вернуть человеку:

1. Список созданных/изменённых файлов.
2. Что прогнано командами (точно: test/build/ci-check/pack).
3. Что сознательно не сделано и почему.
4. Как на Mini M2 выполнить полный локальный цикл за 5 команд.
5. Короткий чеклист дня покупки VPS.

Не предлагать новую архитектуру мессенджера.
