# server/

Инфраструктура для локальной разработки и тестирования — **не часть
клиентского продукта** (клиент — `index.html` + `service-worker.js`,
см. CLAUDE.md). Живёт отдельно от `src/`, чтобы не путаться с кодом
приложения; версионируется только конфигурация и скрипты, не
бинарники/база данных (см. корневой `.gitignore`).

## strfry/ — тестовый Nostr relay

Проект использует **strfry** (CLAUDE.md: "Relay: strfry") и как
продакшен-relay, и как тестовый — чтобы не тестировать против
поведения, которого не будет в реальном деплое (см. обсуждение в
CONTRACTS.md/log.md этапа 16).

### Первый запуск

```bash
server/strfry/setup.sh   # клонирует + собирает strfry (один раз, ~5-10 минут)
server/strfry/run.sh     # поднимает relay на ws://127.0.0.1:7777
```

`setup.sh` идемпотентен — повторный запуск ничего не переустановит,
если `server/strfry/strfry-src/` уже существует.

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

- `relay.auth.enabled = true` — NIP-42 включён (нужен для тестирования
  автомата соединения, этап 16, и клиентской логики AUTH, этап 17).
- `relay.writePolicy.plugin = ""` — пока пусто (принимает любое
  событие от аутентифицированного клиента). Настоящий whitelist
  (AC-14 TECH.md — чужой pubkey получает `OK auth false`) — предмет
  этапа 17, не заглушка здесь: whitelist должен где-то храниться и
  синхронизироваться с клиентской моделью угроз, это содержательное
  решение того этапа.
- `db = "./strfry-db/"` — резолвится от working directory процесса,
  поэтому запускать ТОЛЬКО через `run.sh` (делает `cd` сам), не бинарник
  напрямую из произвольной директории.

### Данные

`server/strfry/strfry-db/` создаётся при первом запуске, содержит
LMDB-базу — тестовые события, не боевые данные. Можно удалить в любой
момент для чистого старта (`rm -rf server/strfry/strfry-db`, relay
должен быть остановлен).
