#!/bin/bash
set -euo pipefail
export DEBIAN_FRONTEND=noninteractive LC_ALL=C LANG=C
ROOT=/opt/ugolok/island
install -d -m 750 "$ROOT"
install -d -m 750 /var/lib/ugolok/relay /var/lib/ugolok/blossom

if [ ! -d "$ROOT/relay-src/.git" ]; then
  git clone --recursive https://github.com/hoytech/strfry.git "$ROOT/relay-src"
else
  git -C "$ROOT/relay-src" submodule update --init --recursive
fi

# BLOSSOM_REF — FILES-FIX-SPEC.md §8.6/TZ-FIX-FILES-MEDIA-STATIC.md §5.10:
# без пина следующий разворот VPS с нуля молча подтянет ДРУГОЙ HEAD апстрима.
# SHA снят И0 2026-09-06 с боя: git -C /opt/ugolok/island/blossom-src log -1.
BLOSSOM_REF="${BLOSSOM_REF:-ba1444c31d517de9fcb512f7fff92bfed421aaa7}"
if [ ! -d "$ROOT/blossom-src/.git" ]; then
  git clone https://github.com/sebdeveloper6952/blossom-server.git "$ROOT/blossom-src"
fi
if [ -n "$BLOSSOM_REF" ]; then
  git -C "$ROOT/blossom-src" fetch --tags origin
  # -f: чистый SHA, затем накладываем патчи из этого репозитория
  # (CORS/MIME/WAL). Без -f повторный bootstrap на уже пропатченном
  # дереве оставил бы грязный working tree и git apply упал бы.
  git -C "$ROOT/blossom-src" checkout -f "$BLOSSOM_REF"
fi
# Патчи форка — в git этого проекта, сам blossom-src игнорируется.
# Порядок: 0001-*.patch … Имена заголовков CORS сверять с живым OPTIONS
# (X-Sha-256 vs X-SHA-256): gin канонизирует регистр сам.
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
if [ -d "$SCRIPT_DIR/patches" ]; then
  for p in "$SCRIPT_DIR/patches"/*.patch; do
    [ -f "$p" ] || continue
    git -C "$ROOT/blossom-src" apply "$p"
  done
fi

# data dir must be writable by container users
chown -R 1000:1000 /var/lib/ugolok/relay || true
chmod 750 /var/lib/ugolok/relay /var/lib/ugolok/blossom

cd "$ROOT"
# coturn tag fallback
if ! docker pull coturn/coturn:4.6.3 >/tmp/coturn-pull.log 2>&1; then
  echo 'coturn 4.6.3 missing, trying 4.6.2'
  sed -i 's|coturn/coturn:4.6.3|coturn/coturn:4.6.2|' docker-compose.yml
  docker pull coturn/coturn:4.6.2
fi

echo '===== BUILD RELAY ====='
docker compose build relay
echo '===== BUILD BLOSSOM ====='
docker compose build blossom
echo '===== UP ====='
docker compose up -d
docker compose ps
echo 'BOOTSTRAP_OK'
