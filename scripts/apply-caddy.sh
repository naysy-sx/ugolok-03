#!/usr/bin/env bash
# Ставит один site-файл в /etc/caddy/sites/ и делает reload.
# site — трогает только указанный site-файл, общий Caddyfile не перезаписывает.
# full — дополнительно перезаписывает общий /etc/caddy/Caddyfile (только прод).
# Запускать от root:
#   sudo -n /opt/ugolok/bin/apply-caddy.sh site <repo> test.caddy|prod.caddy
#   sudo -n /opt/ugolok/bin/apply-caddy.sh full <repo> prod.caddy
set -euo pipefail

MODE="${1:?site or full}"
ROOT="${2:?repo root}"
SITE="${3:?test.caddy or prod.caddy}"

if [[ "$MODE" != "site" && "$MODE" != "full" ]]; then
	echo "apply-caddy: mode must be site or full" >&2
	exit 2
fi
if [[ "$SITE" != "test.caddy" && "$SITE" != "prod.caddy" ]]; then
	echo "apply-caddy: site must be test.caddy or prod.caddy" >&2
	exit 2
fi
if [[ ! -f "$ROOT/deploy/caddy/$SITE" ]]; then
	echo "apply-caddy: нет $ROOT/deploy/caddy/$SITE" >&2
	exit 1
fi

install -d -m 775 /etc/caddy/sites
cp "$ROOT/deploy/caddy/$SITE" "/etc/caddy/sites/$SITE"

if [[ "$MODE" == "full" ]]; then
	if [[ ! -f "$ROOT/deploy/caddy/Caddyfile" ]]; then
		echo "apply-caddy: нет $ROOT/deploy/caddy/Caddyfile" >&2
		exit 1
	fi
	cp "$ROOT/deploy/caddy/Caddyfile" /tmp/Caddyfile.ugolok.next
	if ! caddy validate --config /tmp/Caddyfile.ugolok.next; then
		echo "apply-caddy: validate failed" >&2
		exit 1
	fi
	cp /tmp/Caddyfile.ugolok.next /etc/caddy/Caddyfile
else
	if [[ ! -f /etc/caddy/Caddyfile ]] || ! grep -qE '^[[:space:]]*import[[:space:]]+/etc/caddy/sites/\*\.caddy' /etc/caddy/Caddyfile; then
		echo "apply-caddy: /etc/caddy/Caddyfile ещё не импортирует /etc/caddy/sites/*.caddy — сначала full" >&2
		exit 1
	fi
	if ! caddy validate --config /etc/caddy/Caddyfile; then
		echo "apply-caddy: validate failed" >&2
		exit 1
	fi
fi

systemctl reload caddy
