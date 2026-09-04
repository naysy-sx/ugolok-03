#!/usr/bin/env bash
# Сборка PWA и выкладка на VPS: test.ugolok.tech (ветка dev) или ugolok.tech (ветка prod).
# Запускается Forgejo Actions на хосте (runs-on: ugolok) из корня репозитория.
# Секреты TURN: /opt/ugolok/secrets/build.env (не в git).
set -euo pipefail

ENV="${1:-}"
if [[ "$ENV" != "test" && "$ENV" != "prod" ]]; then
	echo "usage: $0 test|prod" >&2
	exit 2
fi

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

SECRETS="${UGOLK_BUILD_ENV:-/opt/ugolok/secrets/build.env}"
if [[ -f "$SECRETS" ]]; then
	# shellcheck disable=SC1090
	set -a
	# shellcheck disable=SC1091
	source "$SECRETS"
	set +a
fi
: "${TURN_USERNAME:?TURN_USERNAME пуст — нужен $SECRETS}"
: "${TURN_PASSWORD:?TURN_PASSWORD пуст — нужен $SECRETS}"

if [[ "$ENV" == "test" ]]; then
	WWW="${UGOLK_WWW_TEST:-/var/www/ugolok-test}"
	RELAY_JSON='["wss://relay.test.ugolok.tech"]'
	BLOSSOM_JSON='["https://blossom.test.ugolok.tech"]'
	ISLAND_SRC="$ROOT/deploy/island-test"
	ISLAND_DST="${UGOLK_ISLAND_TEST:-/opt/ugolok/island-test}"
	CADDY_SITE=test.caddy
	APPLY_PROD_ISLAND=0
else
	WWW="${UGOLK_WWW_PROD:-/var/www/ugolok}"
	RELAY_JSON='["wss://relay.ugolok.tech"]'
	BLOSSOM_JSON='["https://blossom.ugolok.tech"]'
	ISLAND_SRC="$ROOT/deploy/island"
	ISLAND_DST="${UGOLK_ISLAND_PROD:-/opt/ugolok/island}"
	CADDY_SITE=prod.caddy
	APPLY_PROD_ISLAND=1
fi

ICE_JSON="$(
	TURN_USERNAME="$TURN_USERNAME" TURN_PASSWORD="$TURN_PASSWORD" python3 - <<'PY'
import json, os
u = os.environ["TURN_USERNAME"]
p = os.environ["TURN_PASSWORD"]
print(json.dumps([
	{"urls": "stun:ugolok.tech:3478"},
	{"urls": "turn:ugolok.tech:3478?transport=udp", "username": u, "credential": p},
	{"urls": "turn:ugolok.tech:3478?transport=tcp", "username": u, "credential": p},
	{"urls": "stun:stun.l.google.com:19302"},
], separators=(",", ":")))
PY
)"

echo "deploy-env: env=$ENV www=$WWW"

ICE_FILE="$(mktemp)"
printf '%s' "$ICE_JSON" >"$ICE_FILE"
trap 'rm -f "$ICE_FILE"' EXIT

docker run --rm \
	-v "$ROOT":/src \
	-v "$ICE_FILE":/ice.json:ro \
	-w /src \
	-e BUILD_DEFAULT_RELAYS="$RELAY_JSON" \
	-e BUILD_BOOTSTRAP_RELAYS="$RELAY_JSON" \
	-e BUILD_DEFAULT_BLOSSOM_SERVERS="$BLOSSOM_JSON" \
	node:22-bookworm \
	bash -lc 'export BUILD_DEFAULT_ICE_SERVERS="$(cat /ice.json)"; npm ci --ignore-scripts && npm run build'

if [[ ! -f dist/index.html || ! -f dist/service-worker.js ]]; then
	echo "deploy-env: нет dist/index.html или dist/service-worker.js" >&2
	exit 1
fi

python3 - "$RELAY_JSON" "$BLOSSOM_JSON" "$ICE_JSON" "$ENV" <<'PY'
import json, sys, pathlib
relays = json.loads(sys.argv[1])
blossom = json.loads(sys.argv[2])
ice = json.loads(sys.argv[3])
env = sys.argv[4]
name = "ugolok.tech" if env == "prod" else "test.ugolok.tech"
cfg = {
	"instanceName": name,
	"relays": relays,
	"bootstrapRelays": relays,
	"blossomServers": blossom,
	"iceServers": ice,
}
pathlib.Path("dist/config.json").write_text(json.dumps(cfg, indent=2) + "\n")
PY

mkdir -p "$WWW"
rsync -a --delete --delay-updates \
	--exclude '.git' \
	dist/ "$WWW/"

if [[ -d "$ISLAND_SRC" ]]; then
	mkdir -p "$ISLAND_DST"
	rsync -a --delete \
		--exclude 'relay-src' \
		--exclude 'blossom-src' \
		--exclude 'coturn.conf' \
		--exclude '.git' \
		"$ISLAND_SRC/" "$ISLAND_DST/"
	if [[ "$APPLY_PROD_ISLAND" -eq 1 && -f "$ISLAND_DST/docker-compose.yml" ]]; then
		docker compose -f "$ISLAND_DST/docker-compose.yml" --project-directory "$ISLAND_DST" up -d
	elif [[ "$APPLY_PROD_ISLAND" -eq 0 && -f "$ISLAND_DST/docker-compose.yml" ]]; then
		docker compose -f "$ISLAND_DST/docker-compose.yml" --project-directory "$ISLAND_DST" up -d
	fi
fi

APPLY_CADDY="${UGOLK_APPLY_CADDY:-/opt/ugolok/bin/apply-caddy.sh}"
if [[ -x "$APPLY_CADDY" ]]; then
	if [[ "${EUID}" -eq 0 ]]; then
		"$APPLY_CADDY" "$ROOT" "$CADDY_SITE"
	else
		sudo -n "$APPLY_CADDY" "$ROOT" "$CADDY_SITE"
	fi
else
	echo "deploy-env: нет $APPLY_CADDY — Caddy не трогаем (первый bootstrap на VPS)" >&2
fi

echo "deploy-env: done $ENV -> $WWW"
