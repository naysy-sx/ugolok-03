#!/bin/bash
set -euo pipefail

if ! command -v gpg > /dev/null 2>&1; then
    echo "gpg не найден, установите GnuPG" >&2
    exit 1
fi

npm ci
rm -rf dist
npm run build

if command -v sha256sum > /dev/null 2>&1; then
    HASH_CMD="sha256sum"
else
    HASH_CMD="shasum -a 256"
fi

cd dist
$HASH_CMD index.html > SHA256SUMS
cd ..

if [ $# -ge 1 ]; then
    gpg --local-user "$1" --detach-sign --armor -o dist/SHA256SUMS.asc dist/SHA256SUMS
else
    gpg --detach-sign --armor -o dist/SHA256SUMS.asc dist/SHA256SUMS
fi

echo "Хеш сборки: $(cat dist/SHA256SUMS)"
echo "Файлы для публикации: dist/SHA256SUMS, dist/SHA256SUMS.asc"
