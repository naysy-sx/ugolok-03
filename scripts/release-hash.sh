#!/usr/bin/env bash
set -euo pipefail

SKIP_INSTALL="${SKIP_INSTALL:-}"
SKIP_BUILD="${SKIP_BUILD:-}"
SKIP_GPG="${SKIP_GPG:-}"

if [ "$SKIP_INSTALL" != "1" ]; then
    npm ci --ignore-scripts
fi

if [ "$SKIP_BUILD" != "1" ]; then
    rm -rf dist
    npm run build
fi

# Проверяем наличие файлов в dist
if [ ! -f "dist/index.html" ] || [ ! -f "dist/service-worker.js" ]; then
    echo "Файлы dist/index.html и dist/service-worker.js отсутствуют" >&2
    exit 1
fi

# Генерируем SHA256SUMS
cd dist
if command -v sha256sum &> /dev/null; then
    HASH_CMD="sha256sum"
else
    HASH_CMD="shasum -a 256"
fi
$HASH_CMD index.html > SHA256SUMS
$HASH_CMD service-worker.js >> SHA256SUMS
cd ..

have_gpg=0
have_key=0
if command -v gpg >/dev/null 2>&1; then
    have_gpg=1
    if gpg --list-secret-keys --with-colons 2>/dev/null | grep -q '^sec:'; then
        have_key=1
    fi
fi

if [ "$SKIP_GPG" = 1 ] || [ "$have_gpg" != 1 ] || [ "$have_key" != 1 ]; then
    echo "GPG-подпись пропущена (SKIP_GPG=${SKIP_GPG:-0}, gpg=$have_gpg, key=$have_key)" >&2
else
    if [ $# -ge 1 ]; then
        gpg --local-user "$1" --detach-sign --armor -o dist/SHA256SUMS.asc dist/SHA256SUMS
    else
        gpg --detach-sign --armor -o dist/SHA256SUMS.asc dist/SHA256SUMS
    fi
fi

echo "Хеш сборки: $(cat dist/SHA256SUMS)"
if [ -f dist/SHA256SUMS.asc ]; then
    echo "Файлы для публикации: dist/SHA256SUMS, dist/SHA256SUMS.asc"
else
    echo "Файлы для публикации: dist/SHA256SUMS"
fi
