#!/usr/bin/env bash
# Запускает локальный тестовый strfry-relay проекта.
# cd в эту директорию обязателен — strfry.conf ссылается на db как на
# относительный путь ("./strfry-db/"), резолвящийся от working directory
# процесса, не от расположения самого конфига.
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")"

if [ ! -x "./strfry-src/strfry" ]; then
	echo "strfry не собран. См. server/README.md — сборка из исходников." >&2
	exit 1
fi

exec ./strfry-src/strfry --config=./strfry.conf relay
