# deploy/island — боевой остров ugolok.tech

Снимок стека, который крутится на VPS. Не `deploy/compose.yml` (скелет) и не `agent/compose/` (инсталлятор своего инстанса).

| Где в git | Где на VPS |
|---|---|
| `deploy/island/Caddyfile` | `/etc/caddy/Caddyfile` (Caddy на хосте) |
| остальные файлы этой папки | `/opt/ugolok/island/` |
| `coturn.conf.example` | `/opt/ugolok/island/coturn.conf` — пароль **не** в git |

Caddy на хосте. Relay и Blossom слушают только localhost. coturn — `network_mode: host`.

## Секрет TURN

`coturn.conf.example` копируется в `coturn.conf`, в `user=ugolok:…` ставится пароль из окружения оператора. Файл **chmod 644**: образ `coturn/coturn` запускается как `nobody` и иначе молча стартует без конфига (no-auth, порты вне UFW).

`deploy/island/coturn.conf` в `.gitignore`.

## Как выкатывать правку

1. Менять файлы здесь, в репозитории.
2. Коммит в `main`, push на `origin` (`git.ugolok.tech`).
3. На VPS скопировать из checkout в `/opt/ugolok/island/` (и Caddyfile в `/etc/caddy/Caddyfile`). Не перетирать боевой `coturn.conf`.
4. `docker compose up -d` в `/opt/ugolok/island`; для Caddy — `systemctl reload caddy`.
5. Клиент: `BUILD_DEFAULT_*` → `npm run build` → rsync `dist/` в `/var/www/ugolok`.

Не править конфиги «на живую» на сервере в обход git.
