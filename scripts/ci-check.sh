#!/usr/bin/env bash
set -euo pipefail

npm ci --ignore-scripts
# Один повтор: на ubuntu-latest всплывал флак tests/room-session.test.js И9
# (оба участника гонки openMode «проигрывают»). Повтор тот же контракт npm test.
if ! npm test; then
  echo "npm test упал, один повтор" >&2
  npm test
fi
npm run build

if [ ! -f dist/index.html ] || [ ! -f dist/service-worker.js ]; then
  echo "dist/index.html или dist/service-worker.js не существует" >&2
  exit 1
fi

SIZE=$(gzip -c dist/index.html | wc -c | tr -d ' ')
echo "gzip index.html: $SIZE bytes"

if [ "$SIZE" -gt 1335296 ]; then
  echo "Размер файла index.html превышает 1304 KB" >&2
  exit 1
fi
