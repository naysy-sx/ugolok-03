# server/

Инфраструктура для локальной разработки и тестирования — **не часть
клиентского продукта** (клиент — `index.html` + `service-worker.js`).
Живёт отдельно от `src/`, чтобы не путаться с кодом приложения;
версионируется только конфигурация и скрипты, не бинарники/база данных
(см. корневой `.gitignore`).

## strfry/ — тестовый Nostr relay

Проект использует **strfry** и как продакшен-relay, и как тестовый —
чтобы не тестировать против поведения, которого не будет в реальном
деплое.

### Первый запуск

```bash
server/strfry/setup.sh   # клонирует + собирает strfry (один раз, ~5-10 минут)
server/strfry/run.sh     # поднимает relay на ws://127.0.0.1:7777
```

`setup.sh` идемпотентен: если `strfry-src/` ещё нет — клонирует и собирает;
если уже есть — делает `make` (перелинковка после `brew upgrade`
secp256k1/lmdb/libuv). Homebrew иногда обновляет `.dylib`, и старый
бинарник падает с dyld «Library not loaded» / exit 134 — это как раз
лечится повторным `setup.sh`, без удаления дерева.

### Зависимости сборки

**macOS (Homebrew)**, устанавливаются `setup.sh` автоматически:
`pkg-config libtool zlib lmdb flatbuffers secp256k1 libuv perl openssl@3 zstd`.

**Linux (Debian/Ubuntu)** — не проверено на этой машине, по официальной
документации strfry: `git clone https://github.com/hoytech/strfry &&
cd strfry && git submodule update --init && make setup-golpe && make -j4`
с зависимостями `libssl-dev zlib1g-dev liblmdb-dev libflatbuffers-dev
libsecp256k1-dev libzstd-dev libuv1-dev` — сверить перед использованием,
не гадать.

### Конфигурация (`strfry.conf`)

- `relay.auth.enabled = true` — NIP-42 включён.
- `relay.writePolicy.plugin = ""` — пока пусто (принимает любое
  событие от аутентифицированного клиента). Реальный whitelist по pubkey
  — `whitelist-plugin.mjs` + `whitelist.json` (см. `docs/self-hosting.md`).
- `db = "./strfry-db/"` — резолвится от working directory процесса,
  поэтому запускать ТОЛЬКО через `run.sh` (делает `cd` сам), не бинарник
  напрямую из произвольной директории.

### Данные

`server/strfry/strfry-db/` создаётся при первом запуске, содержит
LMDB-базу — тестовые события, не боевые данные. Можно удалить в любой
момент для чистого старта (`rm -rf server/strfry/strfry-db`, relay
должен быть остановлен).

## blossom/ — тестовый Blossom-сервер

Клиентский Blossom-код покрыт юнит-тестами; живой сервер здесь — тот
же принцип, что и strfry: тестируем против реального сервера, не только
против собственных моков.

Выбрана независимая реализация **`sebdeveloper6952/blossom-server`**
(Go, BUD-01/02/04/06/08) — не официальный референс (`hzrd149/blossom-
server-ts` помечен как deprecated на npm и тянет тяжёлые нативные
зависимости уровня strfry без её преимуществ), Go-бинарник собирается
без внешнего дерева зависимостей вроде brew (кроме `go` самого).

### Первый запуск

```bash
server/blossom/setup.sh   # ставит go (если нет), клонирует + собирает (~1-2 минуты)
server/blossom/run.sh     # поднимает сервер на http://127.0.0.1:8080
```

`setup.sh` идемпотентен, как `strfry/setup.sh`.

### Зависимости сборки

Требуется Go ≥1.26 (ставится `setup.sh` через Homebrew, если отсутствует)
и C-компилятор (`mattn/go-sqlite3` — нативная привязка через cgo;
на macOS уже есть через Xcode Command Line Tools).

### Конфигурация (`config.yml`)

Бинарник читает **фиксированный** относительный путь `config.yml` от
рабочей директории процесса (флага `--config`, в отличие от strfry,
нет) — поэтому `run.sh` копирует версионируемый `server/blossom/
config.yml` в `blossom-src/config.yml` при КАЖДОМ запуске (не полагается
на то, что копия не разъедется с оригиналом) и только затем `cd
blossom-src && exec ./bin/app`.

- `api_addr`/`db_path` — `127.0.0.1:8080`, тот же принцип, что
  `strfry.conf` (`bind = "127.0.0.1"`): локальная разработка, не
  публичный интернет.
- `max_upload_size_bytes: 20971520` (20 MB) — совпадает с F-AT-04/
  `validation.js` на клиенте; дублирование сознательное (defense-in-
  depth), не источник истины для клиентских лимитов.
- `access_control_rules` — `ALLOW ALL` на UPLOAD/GET, тот же принцип,
  что `strfry.conf`'s пустой `writePolicy.plugin`: whitelist по pubkey
  не в скоупе, MIME-фильтрация уже на клиенте.

### Данные

`server/blossom/blossom-db/database.sqlite3` — блобы хранятся ВНУТРИ
SQLite (не отдельными файлами на диске), создаётся при первом запуске.
Можно удалить в любой момент для чистого старта (сервер должен быть
остановлен).

### Живая проверка (этап 28, довесок)

`uploadBlob`/`downloadBlob`/`uploadAttachment`/`downloadAttachment`
проверены живьём против этого сервера (полный round-trip: шифрование →
загрузка → скачивание → расшифровка → совпадение с оригиналом), плюс
адверсарный сценарий (заведомо неверный `x`-тег в auth-событии —
сервер реально отклоняет `400`, клиент корректно пробрасывает ошибку).
См. CONTRACTS.md/log.md, этап 28.

## coturn/ — локальный TURN/STUN

Третья нога того же dev-трио, что strfry и Blossom: `npm run dev`
поднимает coturn сам (`devTurnPlugin` в `vite.config.js`). Нужен, чтобы
ICE в dev не ходил только на публичный Google STUN.

### Первый запуск

```bash
server/coturn/setup.sh   # brew install coturn, если turnserver ещё нет
server/coturn/run.sh     # поднимает stun/turn на 127.0.0.1:3478
```

`setup.sh` идемпотентен. При обычной разработке достаточно `npm run dev`.

### Конфигурация (`turnserver.conf`)

- `listening-ip`/`relay-ip`/`external-ip` = `127.0.0.1` — только localhost.
- `listening-port=3478`, relay-порты `49160–49200`.
- `lt-cred-mech` + `user=ugolok:ugolok-dev` — статические dev-креды, не
  продакшен `use-auth-secret` агента (`agent/compose/coturn.conf.tmpl`).
- `no-tls`/`no-dtls`/`no-cli` — без TLS и без admin CLI.

Клиент в `serve` получает ICE
`stun:127.0.0.1:3478` + `turn:127.0.0.1:3478` (user `ugolok`) + Google
STUN как fallback.
