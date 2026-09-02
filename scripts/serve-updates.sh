#!/usr/bin/env bash
set -euo pipefail

# Переходим в корень репозитория
cd "$(dirname "$0")/.."

# Проверяем наличие каталога dist-updates
if [ ! -d "dist-updates" ]; then
  echo "Каталог dist-updates не найден" >&2
  exit 1
fi

# Запускаем HTTP-сервер
exec python3 -m http.server 8787 --directory dist-updates
