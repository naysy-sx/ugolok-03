# Локальный CI/CD на Mini

Публичный VPS не куплен. Этот документ — как прогонять ту же проверку, что GitHub Actions, руками.

## Пять команд

```bash
git checkout main
npm ci --ignore-scripts
./scripts/ci-check.sh
./scripts/release-pack.sh
./scripts/serve-updates.sh   # опционально, http://127.0.0.1:8787/
```

`npm test` — команда из `package.json`: `node --test tests/*.test.js tests/harness/*.test.js`. В сюите harness: `fake-relay.test.js` и `ws-bridge.test.js`. Хелперы без суффикса `.test.js` не подхватываются. На Node 22/24 каталог `node --test tests` не рекурсирует.

Тяжёлые repro (реальные процессы/MLS) вручную:
`node --test tests/harness/m1-repro.mjs tests/harness/m3-repro.mjs tests/harness/device.repro.mjs`

`ci-check.sh` сам делает `npm ci --ignore-scripts`, тесты, сборку и проверку размера. Отдельный `npm ci` нужен, если хотите зависимости до скрипта.

Compose — отдельно, только если Docker уже стоит: `docs/environments.md`, `deploy/README.md`. Не из CI.

## allow-scripts (npm 11+)

На Mini npm 11 печатает предупреждение про неодобренные install-скрипты (`fsevents`).
В репозитории политика зафиксирована: `package.json` `"allowScripts": { "fsevents": false }`.
Скрипты CI вызывают `npm ci --ignore-scripts`, чтобы не было интерактивного запроса ни на Mini, ни на `ubuntu-latest`.

Это не ломает сборку: единственный install-скрипт в lock — `fsevents` (macOS watcher). Playwright e2e в этом этапе не запускается.

## Как смотреть Actions

Пока origin GitHub:

1. PR и push в `main` → `.github/workflows/ci.yml` (проектный Node **22**, `bash scripts/ci-check.sh`). Сами экшены — `actions/checkout@v5` и `actions/setup-node@v6` (рантайм Node 24; `@v4` даёт предупреждение GitHub про deprecated Node 20).
2. Annotated тег `vX.Y.Z` (три числа, без суффикса) → `.github/workflows/release.yml`: проверка, pack, GitHub Release с деревом канала.
3. Workflow релиза **всегда** вызывает pack с `SKIP_GPG=1`. Секрета `GPG_PRIVATE_KEY` в Actions нет. Подпись — ручной путь на Mini: `./scripts/release-hash.sh` или `./scripts/release-hash.sh <key-id>`.

Вкладки: репозиторий → Actions. Локально YAML не запускает runner.

Когда появится `git.ugolok.tech`: включить Actions в Forgejo, поставить runner, поменять `runs-on` на свой лейбл, перенести секреты. Заготовки: `.forgejo/workflows/`. GitHub-only обёртка релиза (`softprops/action-gh-release`) на Forgejo заменяется на `forgejo-release` / загрузку файлов в Release Forgejo.

## Два пути сервера

A. Как сейчас: `server/*/setup.sh` + `run.sh` + `npm run dev` (Vite-плагины поднимают relay/blossom в dev).

B. `deploy/compose.yml` — каркас, на VPS станет основным. На darwin/arm64 образы relay/blossom могут не собраться — это ожидаемо, см. `deploy/README.md`.

`agent/` — отдельный инсталлятор своего инстанса, не замена этому каркасу.
