# Уголок

Замкнутый мессенджер на протоколе Nostr для локальной сети: свой relay, своё файловое хранилище. Это не клиент публичной сети Nostr.

Клиент — два файла: `index.html` и `service-worker.js`.

## Требования

Node ≥ 22.

## Быстрый старт

```bash
git clone https://github.com/naysy-sx/ugolok-03.git
cd ugolok-03
npm ci
npm run dev
```

Откройте http://localhost:5173

## Тесты и сборка

```bash
npm test                 # tests/*.test.js и tests/harness/*.test.js (fake-relay, ws-bridge)
npm run build            # dist/index.html + dist/service-worker.js
./scripts/ci-check.sh    # ci + test + build + лимит размера
```

## Инфраструктура

| Путь | Роль сейчас |
|---|---|
| `server/*/setup.sh` + `run.sh` | главный LAN-путь на Mini |
| `agent/compose/` | Docker-бандл своего инстанса (инсталлятор) |
| `deploy/compose.yml` | скелет будущего VPS, не замена двум верхним |

- Свой сервер в LAN: [`docs/self-hosting.md`](docs/self-hosting.md)
- Инсталлятор инстанса: каталог [`agent/`](agent/)
- Поставка и релизы: [`docs/delivery.md`](docs/delivery.md)
- Проверка сборки: [`docs/verify.md`](docs/verify.md)
- Как устроен git и CI: [`docs/RUNBOOK.md`](docs/RUNBOOK.md), [`CONTRIBUTING.md`](CONTRIBUTING.md)

## Чего здесь нет

Публичный интернет из коробки, магазин приложений, Capacitor/Electron. Origin пользователя — ваш хост в локальной сети (позже свой домен), не чужой relay.
