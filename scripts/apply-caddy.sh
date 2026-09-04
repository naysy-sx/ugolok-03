#!/usr/bin/env bash
# Ставит Caddyfile + один site-файл и reload. Запускать от root
# (sudo -n /opt/ugolok/bin/apply-caddy.sh <repo> test.caddy|prod.caddy).
set -euo pipefail

ROOT="${1:?repo root}"
SITE="${2:?test.caddy or prod.caddy}"
if [[ "$SITE" != "test.caddy" && "$SITE" != "prod.caddy" ]]; then
	echo "apply-caddy: site must be test.caddy or prod.caddy" >&2
	exit 2
fi
if [[ ! -f "$ROOT/deploy/caddy/Caddyfile" || ! -f "$ROOT/deploy/caddy/$SITE" ]]; then
	echo "apply-caddy: нет $ROOT/deploy/caddy/{Caddyfile,$SITE}" >&2
	exit 1
fi

install -d -m 775 /etc/caddy/sites
cp "$ROOT/deploy/caddy/$SITE" "/etc/caddy/sites/$SITE"
cp "$ROOT/deploy/caddy/Caddyfile" /tmp/Caddyfile.ugolok.next
if ! caddy validate --config /tmp/Caddyfile.ugolok.next; then
	echo "apply-caddy: validate failed" >&2
	exit 1
fi
cp /tmp/Caddyfile.ugolok.next /etc/caddy/Caddyfile
systemctl reload caddy
