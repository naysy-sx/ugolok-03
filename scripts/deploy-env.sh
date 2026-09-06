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

# Этап 7 (TZ-cicd-hardening) — два быстрых push подряд не должны выполнять
# rsync --delete/docker compose one over the other; блокирующий flock (не -n)
# — второй прогон ЖДЁТ первого, не падает. Отдельный лок на test/prod: они
# пишут в разные $WWW и не конфликтуют друг с другом.
exec 9>"/tmp/ugolok-deploy-$ENV.lock"
flock 9

if [[ "$ENV" == "test" ]]; then
	WWW="${UGOLK_WWW_TEST:-/var/www/ugolok-test}"
	RELAY_JSON='["wss://relay.test.ugolok.tech"]'
	BLOSSOM_JSON='["https://blossom.test.ugolok.tech"]'
	ISLAND_SRC="$ROOT/deploy/island-test"
	ISLAND_DST="${UGOLK_ISLAND_TEST:-/opt/ugolok/island-test}"
	CADDY_SITE=test.caddy
	CADDY_MODE=site
else
	WWW="${UGOLK_WWW_PROD:-/var/www/ugolok}"
	RELAY_JSON='["wss://relay.ugolok.tech"]'
	BLOSSOM_JSON='["https://blossom.ugolok.tech"]'
	ISLAND_SRC="$ROOT/deploy/island"
	ISLAND_DST="${UGOLK_ISLAND_PROD:-/opt/ugolok/island}"
	CADDY_SITE=prod.caddy
	CADDY_MODE=full
fi

# Только urls — ни username, ни credential (этап 6): временные TURN-креды
# клиент запрашивает у /api/turn-credentials в рантайме, не из сборки.
ICE_JSON='[{"urls":"stun:ugolok.tech:3478"},{"urls":"turn:ugolok.tech:3478?transport=udp"},{"urls":"turn:ugolok.tech:3478?transport=tcp"},{"urls":"stun:stun.l.google.com:19302"}]'

echo "deploy-env: env=$ENV www=$WWW"

ICE_FILE="$(mktemp)"
printf '%s' "$ICE_JSON" >"$ICE_FILE"
trap 'rm -f "$ICE_FILE"' EXIT

# Кэш — оптимизация, не обязательное условие деплоя: если каталог ещё не
# создан оператором ([VPS], docs/environments.md) или /var/cache недоступен
# для записи uid раннера, просто не монтируем его — контейнер использует
# свой внутренний /tmp/npm (без переиспользования между прогонами), но
# деплой не падает целиком из-за отсутствующей оптимизации.
NPM_CACHE="${UGOLK_NPM_CACHE:-/var/cache/ugolok-npm}"
NPM_CACHE_MOUNT=()
if mkdir -p "$NPM_CACHE" 2>/dev/null; then
	NPM_CACHE_MOUNT=(-v "$NPM_CACHE:/tmp/npm")
else
	echo "deploy-env: нет доступа к $NPM_CACHE — npm-кэш этого прогона не переживёт контейнер" >&2
fi

# Этап 7 — хеш сборки с ХОСТА, не полагаясь на git внутри --rm-контейнера:
# node:22-bookworm его несёт (buildpack-deps), но это неявная зависимость от
# конкретного базового образа; на хосте git точно есть (сюда же клонировал
# Forgejo Actions). vite.config.js's BUILD_HASH берёт process.env.BUILD_HASH
# первым приоритетом — если он задан, git внутри контейнера не вызывается вовсе.
BUILD_HASH="$(git -C "$ROOT" rev-parse --short HEAD)"

# Сборка от uid runner-а: иначе dist/ принадлежит root и запись config.json падает.
# --memory/--memory-swap: сборка падает по OOM внутри контейнера, а не роняет
# Caddy/relay на хосте (4 ГБ RAM по факту, см. docs/environments.md "Осознанное
# отступление от ТЗ VPS"). Значения ориентировочные — подобрать по free -m.
docker run --rm \
	-u "$(id -u):$(id -g)" \
	-e HOME=/tmp \
	-e npm_config_cache=/tmp/npm \
	--memory="${UGOLK_BUILD_MEMORY:-2g}" \
	--memory-swap="${UGOLK_BUILD_MEMORY_SWAP:-3g}" \
	-v "$ROOT":/src \
	"${NPM_CACHE_MOUNT[@]+"${NPM_CACHE_MOUNT[@]}"}" \
	-v "$ICE_FILE":/ice.json:ro \
	-w /src \
	-e BUILD_DEFAULT_RELAYS="$RELAY_JSON" \
	-e BUILD_BOOTSTRAP_RELAYS="$RELAY_JSON" \
	-e BUILD_DEFAULT_BLOSSOM_SERVERS="$BLOSSOM_JSON" \
	-e UGOLK_INSTANCE="$ENV" \
	-e BUILD_HASH="$BUILD_HASH" \
	node:22-bookworm \
	bash -lc 'set -euo pipefail
export BUILD_DEFAULT_ICE_SERVERS="$(cat /ice.json)"
# ОТДЕЛЬНЫМИ строками, не через && — под set -e команда внутри A && B && C,
# кроме последней, НЕ триггерит errexit (задокументированное исключение bash),
# то есть провал npm test здесь молча проглатывался бы, node -e ниже всё
# равно писал бы config.json, и весь docker run вернул бы 0.
npm ci --ignore-scripts
npm test
npm run build
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
# --omit-dir-times: живая проверка (прод, run #30) — "$WWW" (уже существующий,
# не создан этим же скриптом) принадлежит не ugolok, а utimensat() на чужую
# ДИРЕКТОРИЮ (не файл) требует владения даже при наличии права записи внутрь —
# без этого флага rsync доходил до конца успешно, но падал (exit 23) именно
# на попытке проставить время самому каталогу назначения, роняя весь деплой
# ПОСЛЕ того, как все файлы уже скопировались.
rsync -rltD --omit-dir-times --delete --delay-updates \
	--exclude '.git' \
	dist/ "$WWW/"

if [[ -d "$ISLAND_SRC" ]]; then
	mkdir -p "$ISLAND_DST"
	# turncreds.env — секрет оператора (этап 6), как и coturn.conf: не в git,
	# живёт только в $ISLAND_DST. Живая проверка (прод, run #33) — без этого
	# исключения --delete стирал его же в ЭТОМ прогоне, до docker compose up,
	# который его тут же требует (env_file) — деплой ронял то, что сам создал
	# оператор минуту назад.
	rsync -a --omit-dir-times --delete \
		--exclude 'relay-src' \
		--exclude 'blossom-src' \
		--exclude 'agent-src' \
		--exclude 'coturn.conf' \
		--exclude 'turncreds.env' \
		--exclude '.git' \
		"$ISLAND_SRC/" "$ISLAND_DST/"
	# turncreds-server (этап 6) собирается из agent/ этого же клона — в отличие
	# от relay-src/blossom-src (сторонний upstream, забутстрапленный один раз
	# оператором), agent/ — наш код и обязан обновляться на КАЖДЫЙ деплой.
	# Живая проверка (прод, run #36) — без этого шага docker compose падал:
	# "unable to prepare context: path /opt/agent not found" (context в
	# docker-compose.yml относительный, от $ISLAND_DST, а не от репозитория).
	if [[ -d "$ROOT/agent" ]]; then
		rsync -a --omit-dir-times --delete --exclude '.git' "$ROOT/agent/" "$ISLAND_DST/agent-src/"
	fi
	if [[ -f "$ISLAND_DST/docker-compose.yml" ]]; then
		# --build: без него compose переиспользует уже существующий образ
		# ugolok-turncreds-server:local как есть, даже если agent-src только что
		# обновился — тег статический, compose не видит, что исходники изменились.
		# Живая проверка (прод, run #42) — /api/turn-credentials оставался 502
		# ПОСЛЕ фикса 127.0.0.1->0.0.0.0 в коде: контейнер не пересобрался,
		# работал старый образ со старой привязкой.
		docker compose -f "$ISLAND_DST/docker-compose.yml" --project-directory "$ISLAND_DST" up -d --build
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
