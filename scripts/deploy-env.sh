#!/usr/bin/env bash
# Сборка PWA и выкладка на VPS: test.ugolok.tech (ветка dev) или ugolok.tech (ветка prod).
# Запускается Forgejo Actions на хосте (runs-on: ugolok) из корня репозитория.
# TURN больше не несёт статического пароля в сборке (этап 6, TZ-cicd-hardening) —
# клиент получает временные креды с /api/turn-credentials (turncreds-server,
# TURN_STATIC_AUTH_SECRET там же, не здесь). /opt/ugolok/secrets/build.env для
# сборки больше не нужен.
set -euo pipefail

ENV="${1:-}"
if [[ "$ENV" != "test" && "$ENV" != "prod" ]]; then
	echo "usage: $0 test|prod" >&2
	exit 2
fi

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

if [[ "$ENV" == "test" ]]; then
	WWW="${UGOLK_WWW_TEST:-/var/www/ugolok-test}"
	RELAY_JSON='["wss://relay.test.ugolok.tech"]'
	BLOSSOM_JSON='["https://blossom.test.ugolok.tech"]'
	ISLAND_SRC="$ROOT/deploy/island-test"
	ISLAND_DST="${UGOLK_ISLAND_TEST:-/opt/ugolok/island-test}"
	CADDY_SITE=test.caddy
	CADDY_MODE=site
	APPLY_PROD_ISLAND=0
else
	WWW="${UGOLK_WWW_PROD:-/var/www/ugolok}"
	RELAY_JSON='["wss://relay.ugolok.tech"]'
	BLOSSOM_JSON='["https://blossom.ugolok.tech"]'
	ISLAND_SRC="$ROOT/deploy/island"
	ISLAND_DST="${UGOLK_ISLAND_PROD:-/opt/ugolok/island}"
	CADDY_SITE=prod.caddy
	CADDY_MODE=full
	APPLY_PROD_ISLAND=1
fi

# Только urls — ни username, ни credential (этап 6): временные TURN-креды
# клиент запрашивает у /api/turn-credentials в рантайме, не из сборки.
ICE_JSON='[{"urls":"stun:ugolok.tech:3478"},{"urls":"turn:ugolok.tech:3478?transport=udp"},{"urls":"turn:ugolok.tech:3478?transport=tcp"},{"urls":"stun:stun.l.google.com:19302"}]'

echo "deploy-env: env=$ENV www=$WWW"

ICE_FILE="$(mktemp)"
printf '%s' "$ICE_JSON" >"$ICE_FILE"
trap 'rm -f "$ICE_FILE"' EXIT

NPM_CACHE="${UGOLK_NPM_CACHE:-/var/cache/ugolok-npm}"
mkdir -p "$NPM_CACHE"

# Сборка от uid runner-а: иначе dist/ принадлежит root и запись config.json падает.
# --memory/--memory-swap: сборка падает по OOM внутри контейнера, а не роняет
# Caddy/relay на хосте (2 ГБ RAM, см. docs/environments.md "Осознанное
# отступление от ТЗ VPS"). Значения ориентировочные — подобрать по free -m.
docker run --rm \
	-u "$(id -u):$(id -g)" \
	-e HOME=/tmp \
	-e npm_config_cache=/tmp/npm \
	--memory="${UGOLK_BUILD_MEMORY:-1200m}" \
	--memory-swap="${UGOLK_BUILD_MEMORY_SWAP:-1700m}" \
	-v "$ROOT":/src \
	-v "$NPM_CACHE":/tmp/npm \
	-v "$ICE_FILE":/ice.json:ro \
	-w /src \
	-e BUILD_DEFAULT_RELAYS="$RELAY_JSON" \
	-e BUILD_BOOTSTRAP_RELAYS="$RELAY_JSON" \
	-e BUILD_DEFAULT_BLOSSOM_SERVERS="$BLOSSOM_JSON" \
	-e UGOLK_INSTANCE="$ENV" \
	node:22-bookworm \
	bash -lc 'export BUILD_DEFAULT_ICE_SERVERS="$(cat /ice.json)"
npm ci --ignore-scripts && npm test && npm run build
node -e "
const fs=require(\"fs\");
const ice=JSON.parse(fs.readFileSync(\"/ice.json\",\"utf8\"));
const relays=JSON.parse(process.env.BUILD_DEFAULT_RELAYS);
const blossom=JSON.parse(process.env.BUILD_DEFAULT_BLOSSOM_SERVERS);
const name=process.env.UGOLK_INSTANCE===\"prod\"?\"ugolok.tech\":\"test.ugolok.tech\";
fs.writeFileSync(\"dist/config.json\", JSON.stringify({
  instanceName:name, relays, bootstrapRelays:relays, blossomServers:blossom, iceServers:ice,
  turnCredentialsUrl:\"/api/turn-credentials\"
}, null, 2)+\"\\n\");
"'

if [[ ! -f dist/index.html || ! -f dist/service-worker.js || ! -f dist/config.json ]]; then
	echo "deploy-env: нет dist/index.html, service-worker.js или config.json" >&2
	exit 1
fi

bash "$ROOT/scripts/check-dist-size.sh"

mkdir -p "$WWW"
# без owner/group: каталог www принадлежит caddy, runner — ugolok; -a иначе падает на chgrp.
rsync -rltD --delete --delay-updates \
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
		"$APPLY_CADDY" "$CADDY_MODE" "$ROOT" "$CADDY_SITE"
	else
		sudo -n "$APPLY_CADDY" "$CADDY_MODE" "$ROOT" "$CADDY_SITE"
	fi
else
	echo "deploy-env: нет $APPLY_CADDY — Caddy не трогаем (первый bootstrap на VPS)" >&2
fi

echo "deploy-env: done $ENV -> $WWW"
