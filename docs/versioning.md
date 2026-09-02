# Версии

## Semver

Пока продукт нестабилен — `0.Y.Z`. Тег всегда с префиксом `v`: `v0.1.0`.
Новые релизы клиента — только `vX.Y.Z` (три числа). Исторические теги фаз (`v0.1.0-phase1`) не переименовывать и не запрещать задним числом; CI релиза на них не срабатывает.

Релиз = annotated tag на `main`.

## Три разных «хеша/версии» — не путать

| Что | Зачем | Где |
|---|---|---|
| `package.json` `"version"` | npm-формальность, сейчас `1.0.0` | **не** источник релиза, не бампать из-за поставки |
| `__BUILD_HASH__` | cache-bust Service Worker (`ugolok-cache-v…`) | Vite `define`, обычно короткий git SHA |
| `version.json` `buildHash` | аудит содержимого `index.html` (NF-18) | SHA-256 из `SHA256SUMS` |

`version` в манифесте — без `v`. `gitTag` — с `v`.

## `version.json`

Публичный манифест канала обновлений. Клиент в этом этапе его читать не обязан.

Поля: `name`, `version`, `gitTag`, `gitSha`, `buildHash`, `releasedAt`, `minClientVersion`, `channels.web.url`, `notesUrl`, `updatesBaseUrl`.

Пример: `deploy/version.example.json`.
В релизе файл генерирует `scripts/release-pack.sh` из тега и `SHA256SUMS`.

Прод: `https://updates.ugolok.tech/version.json` и `https://updates.ugolok.tech/vX.Y.Z/version.json`.
Сейчас: `http://127.0.0.1:8787/version.json`.
