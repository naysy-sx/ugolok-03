#!/usr/bin/env bash
# Ставит coturn (Homebrew) для локального TURN/STUN `npm run dev`.
# Идемпотентно: если turnserver уже в PATH — ничего не ставит.
set -euo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")"

if command -v turnserver &> /dev/null; then
  echo "coturn уже установлен: $(command -v turnserver)"
  exit 0
fi

if command -v brew &> /dev/null; then
  brew install coturn
else
  echo "Homebrew не найден — установите coturn вручную (см. server/README.md)" >&2
  exit 1
fi
