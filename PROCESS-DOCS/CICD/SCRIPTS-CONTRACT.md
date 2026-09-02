# Контракт скриптов CI/CD (этап CICD-local, ТЗ 1.3)

Источник истины для воркера. YAML только вызывает эти скрипты.

Общее: `#!/usr/bin/env bash`, `set -euo pipefail`, код выхода ≠ 0 при ошибке.
Комментарии на русском. Не стартовать HTTP-сервер из ci-check/hash/pack.
Каталог артефактов канала — только `dist-updates/` (не `dist-release/`).
`npm ci` везде с `--ignore-scripts` (неинтерактивно на npm 10 и npm 11).

Переменные:
- `SKIP_INSTALL=1` — не вызывать `npm ci`
- `SKIP_BUILD=1` — не делать `rm -rf dist` и не вызывать `npm run build`
- `SKIP_GPG=1` — не подписывать, `.asc` не создавать

Лимит бандла NF-11: **1304 KB** gzip `dist/index.html` (1335296 байт). Не 280.

## `scripts/ci-check.sh`

Шаги строго в этом порядке:

1. `npm ci --ignore-scripts`
2. `npm test`
3. `npm run build`
4. Проверить, что существуют `dist/index.html` и `dist/service-worker.js`
5. Посчитать `gzip -c dist/index.html | wc -c`, напечатать размер, упасть если > 1335296

Не вызывать Playwright. Не вызывать `npx serve`.

## `scripts/release-hash.sh`

Обратная совместимость обязательна:

- `./scripts/release-hash.sh` — как раньше, если есть gpg и секретный ключ: подпись default-ключом
- `./scripts/release-hash.sh <key-id>` — `gpg --local-user "$1" --detach-sign --armor`

Порядок:

1. Если `SKIP_INSTALL` != `1` → `npm ci --ignore-scripts`
2. Если `SKIP_BUILD` != `1` → `rm -rf dist` и `npm run build`
3. Проверить `dist/index.html` и `dist/service-worker.js`
4. В `dist/` записать `SHA256SUMS` для **обоих** файлов: `index.html` и `service-worker.js` (sha256sum, иначе `shasum -a 256`)
5. Подпись в `dist/SHA256SUMS.asc`:
   - пропустить (stderr предупреждение, код 0), если `SKIP_GPG=1` ИЛИ нет команды `gpg` ИЛИ нет секретного ключа (`gpg --list-secret-keys` пуст)
   - иначе подписать как сейчас (аргумент key-id если передан)
6. Напечатать хеш и список файлов для публикации

Не требовать gpg в начале скрипта. Не падать, если подписи нет по правилам выше.

## `scripts/release-pack.sh`

Аргумент: версия (например `v1.2.3` или `1.2.3`). Если аргумента нет:
`git describe --tags --exact-match` при точном теге, иначе `v0.0.0-dev`.

Нормализация: `gitTag` всегда с префиксом `v`; `version` — без ведущего `v`.

Шаги:

1. Если нет `dist/index.html` или `dist/service-worker.js` — если `SKIP_BUILD=1`, упасть; иначе вызвать `scripts/ci-check.sh` (или build, если SKIP_INSTALL уже сделан — допустимо вызвать ci-check)
2. Вызвать `scripts/release-hash.sh` с пробросом `SKIP_INSTALL`/`SKIP_BUILD`/`SKIP_GPG`. В CI по умолчанию считать `SKIP_GPG=1`, если переменная не задана явно в `0`. Локально: если вызывающий не выставил `SKIP_GPG`, оставить пустым (подпись, если ключ есть).
3. Собрать дерево `dist-updates/`:
   - `version.json` (корень)
   - `changelog.md` (корень): сообщения `git log` с предыдущего тега, иначе заглушка «Initial release»
   - `latest/` — копии: `index.html`, `service-worker.js`, `SHA256SUMS`, `SHA256SUMS.asc` если есть, `version.json`, `config.example.json` (из `deploy/config.example.json`, если файла нет — минимальный JSON из контракта config)
   - `vX.Y.Z/` (каталог = gitTag) — то же содержимое
4. `version.json` поля:
   - `name`: `"ugolok"`
   - `version`: semver без `v`
   - `gitTag`: с `v`
   - `gitSha`: `git rev-parse HEAD`
   - `buildHash`: первое поле (хеш) строки `index.html` из `dist/SHA256SUMS`
   - `releasedAt`: UTC ISO-8601
   - `minClientVersion`: тот же `version`
   - `channels.web.url`: `"/index.html"`
   - `notesUrl`: `"https://updates.ugolok.tech/changelog.md"`
   - `updatesBaseUrl`: `"https://updates.ugolok.tech"`
5. Не стартовать HTTP-сервер. `dist/` в git не класть.

## `scripts/serve-updates.sh`

Только локально. Раздать `dist-updates/` на порту **8787**.
Не вызывать из GitHub Actions. Предпочтительно `python3 -m http.server 8787 --directory dist-updates`.
