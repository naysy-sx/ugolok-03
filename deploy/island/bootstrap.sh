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

# Blossom больше не клонируется и не собирается здесь: образ форка
# (репозиторий ugolok-blossom) тянется по пинованному тегу из docker-compose.yml.

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
echo '===== PULL BLOSSOM ====='
docker compose pull blossom
echo '===== UP ====='
docker compose up -d
docker compose ps
echo 'BOOTSTRAP_OK'
