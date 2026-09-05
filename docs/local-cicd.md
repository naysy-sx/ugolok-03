# Локальный CI/CD на Mini

_Актуально на 2026-09-05, описывает origin Forgejo (`git.ugolok.tech`), деплой dev/prod, локальный прогон на Mini._

Этот документ — как прогонять ту же проверку, что CI, руками, и как реально устроен конвейер.

## Пять команд

```bash
git checkout dev
npm ci --ignore-scripts
./scripts/ci-check.sh
./scripts/release-pack.sh
./scripts/serve-updates.sh   # опционально, http://127.0.0.1:8787/
```

`npm test` — команда из `package.json`: `node --test tests/*.test.js tests/harness/*.test.js`. В сюите harness: `fake-relay.test.js` и `ws-bridge.test.js`. Хелперы без суффикса `.test.js` не подхватываются. На Node 22/24 каталог `node --test tests` не рекурсирует.

Тяжёлые repro (реальные процессы/MLS) вручную:
`node --test tests/harness/m1-repro.mjs tests/harness/m3-repro.mjs tests/harness/device.repro.mjs`

`ci-check.sh` сам делает `npm ci --ignore-scripts`, тесты, сборку и проверку размера (`scripts/check-dist-size.sh`, тот же лимит и в `deploy-env.sh`). Отдельный `npm ci` нужен, если хотите зависимости до скрипта.

Compose — отдельно, только если Docker уже стоит: `docs/environments.md`, `deploy/README.md`. Не из CI.

## allow-scripts (npm 11+)

На Mini npm 11 печатает предупреждение про неодобренные install-скрипты (`fsevents`).
В репозитории политика зафиксирована: `package.json` `"allowScripts": { "fsevents": false }`.
Скрипты CI вызывают `npm ci --ignore-scripts`, чтобы не было интерактивного запроса ни на Mini, ни на раннере.

Это не ломает сборку: единственный install-скрипт в lock — `fsevents` (macOS watcher). Playwright e2e в этом этапе не запускается.

## Как реально устроен конвейер

`origin` = Forgejo (`git.ugolok.tech`). GitHub (`naysy-sx/ugolok-03`) — второй remote, свой независимый прогон.

На Forgejo (`.forgejo/workflows/`, self-hosted раннер, лейбл `ugolok` — та же VPS, что и живой `ugolok.tech`; модель доверия — `docs/RUNBOOK.md` §6.8):

1. `push` в `dev` → `deploy-test.yml` → `scripts/deploy-env.sh test`. Тесты, сборка и проверка размера идут **внутри** этого деплоя (в контейнере `node:22-bookworm`, до `rsync`) — отдельного гейта перед деплоем нет, красная джоба означает, что `test.ugolok.tech` не тронут.
2. `push` в `prod` (ручной `main` → `prod`) → `deploy-prod.yml` → `scripts/deploy-env.sh prod`, тот же принцип.
3. `pull_request` и `push` в `main` → `.forgejo/workflows/ci.yml` (`runs-on: ugolok`, `ci-check.sh` внутри контейнера — Node на самом хосте не установлен и не планируется). Для `dev`/`prod` этот workflow не гоняется — проверка уже внутри деплоя, двойной прогон на 2 ГБ RAM не нужен.
4. `.forgejo/workflows/release.yml` по тегу `vX.Y.Z` — **не запускается** (`runs-on: ubuntu-latest`, такого раннера на Forgejo нет). Канал релиза решается отдельно, см. `docs/delivery.md` §5.

На GitHub (`.github/workflows/`) — независимая копия, только если код туда тоже запушен:

1. PR и push в `main`/`dev`/`prod` → `.github/workflows/ci.yml` (Node 22, `bash scripts/ci-check.sh`, `ubuntu-latest` — реальный хостед раннер GitHub).
2. Тег `vX.Y.Z` → `.github/workflows/release.yml`: проверка, pack, GitHub Release с деревом канала. Всегда с `SKIP_GPG=1` (секрета `GPG_PRIVATE_KEY` в Actions нет). Подпись — ручной путь на Mini: `./scripts/release-hash.sh` или `./scripts/release-hash.sh <key-id>`.

## Два пути сервера

A. Как сейчас: `server/*/setup.sh` + `run.sh` + `npm run dev` (Vite-плагины поднимают relay/blossom в dev).

B. `deploy/compose.yml` — каркас для будущего self-host, не боевой стек `ugolok.tech` (тот — `deploy/island/`). На darwin/arm64 образы relay/blossom могут не собраться — это ожидаемо, см. `deploy/README.md`.

`agent/` — отдельный инсталлятор своего инстанса, не замена этому каркасу.
