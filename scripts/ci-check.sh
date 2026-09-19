#!/usr/bin/env bash
set -euo pipefail

npm ci --ignore-scripts
# И9 стабилизирован правкой теста (первые указатели, без десятка tick).
npm test
npm run build

if [ ! -f dist/index.html ] || [ ! -f dist/service-worker.js ]; then
  echo "dist/index.html или dist/service-worker.js не существует" >&2
  exit 1
fi

bash "$(dirname "${BASH_SOURCE[0]}")/check-dist-size.sh"
bash "$(dirname "${BASH_SOURCE[0]}")/check-dist-hosts.sh"
