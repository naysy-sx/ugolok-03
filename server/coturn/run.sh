#!/usr/bin/env bash
# Запускает локальный coturn. cd обязателен — turnserver.conf ссылается
# на pidfile как на относительный путь ("./turnserver.pid").
# Не daemon: процесс остаётся на переднем плане, его спавнит Vite.
set -euo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")"

if ! command -v turnserver &> /dev/null
then
  if [ -f /opt/homebrew/opt/coturn/bin/turnserver ]; then
    TURNSERVER=/opt/homebrew/opt/coturn/bin/turnserver
  elif [ -f /usr/local/opt/coturn/bin/turnserver ]; then
    TURNSERVER=/usr/local/opt/coturn/bin/turnserver
  else
    echo "coturn не установлен. См. server/README.md — server/coturn/setup.sh." >&2
    exit 1
  fi
else
  TURNSERVER=turnserver
fi

exec "$TURNSERVER" -c ./turnserver.conf
