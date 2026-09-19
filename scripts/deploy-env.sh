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

# Только СВОЙ STUN/TURN (AUDIT-EGOROD, соседняя находка): публичный STUN третьей
# стороны отдавал бы ей IP каждого звонящего и ломает инвариант «клиент ходит
# только в свой инстанс» (GATEWAY-TZ-1 §1); свой coturn STUN обслуживает сам.
# Только urls — ни username, ни credential (этап 6): временные TURN-креды
# клиент запрашивает у /api/turn-credentials в рантайме, не из сборки.
ICE_JSON='[{"urls":"stun:ugolok.tech:3478"},{"urls":"turn:ugolok.tech:3478?transport=udp"},{"urls":"turn:ugolok.tech:3478?transport=tcp"}]'

echo "deploy-env: env=$ENV www=$WWW"

ICE_FILE="$(mktemp)"
printf '%s' "$ICE_JSON" >"$ICE_FILE"
trap 'rm -f "$ICE_FILE"' EXIT

# --- AUDIT-EGOROD H1: снимок перед выкладкой, проверка здоровья, откат ---------
# Раньше выкладка перекладывала PWA rsync --delete поверх и делала compose up без
# единой копии данных, без проверки «поднялось ли по делу» и без пути назад.
# Теперь (только prod — у test нет собственных образов и данных пользователей):
#   1. бэкап данных relay/Blossom (scripts/island-backup.sh);
#   2. снимок прежнего PWA, конфигов острова и тегов образов (:prev);
#   3. после compose up — scripts/island-health.sh; провал → откат кода
#      (PWA, конфиги, образы) и exit 1. Данные пользователей автоматически НЕ
#      откатываются: пока шла выкладка, люди уже успели что-то записать —
#      восстановление данных только руками из снимка (scripts/island-restore.md).
STATE_DIR="${UGOLK_STATE_DIR:-/var/lib/ugolok/deploy}"
WWW_PREV="$STATE_DIR/www-prev-$ENV"
ISLAND_PREV="$STATE_DIR/island-prev-$ENV"
BIN_DIR="${UGOLK_BIN:-/opt/ugolok/bin}"
HAVE_STATE_DIR=0
if [[ "$ENV" == "prod" ]] && mkdir -p "$STATE_DIR" 2>/dev/null; then
	HAVE_STATE_DIR=1
elif [[ "$ENV" == "prod" ]]; then
	echo "deploy-env: нет доступа к $STATE_DIR — снимок для отката не будет сохранён" >&2
fi
ISLAND_EXCLUDES=(--exclude relay-src --exclude blossom-src --exclude agent-src --exclude policy --exclude policy-conf --exclude '.git')
DEPLOY_IMAGES=(ugolok-strfry ugolok-blossom ugolok-turncreds-server)

pre_deploy_backup() {
	[[ "$ENV" == "prod" ]] || return 0
	if [[ -x "$ROOT/scripts/island-backup.sh" ]]; then
		if ! bash "$ROOT/scripts/island-backup.sh"; then
			if [[ "${UGOLK_BACKUP_REQUIRED:-0}" == "1" ]]; then
				echo "deploy-env: бэкап не удался, UGOLK_BACKUP_REQUIRED=1 — выкладка отменена" >&2
				exit 1
			fi
			echo "deploy-env: ВНИМАНИЕ — бэкап перед выкладкой не удался, выкладка продолжается без него (UGOLK_BACKUP_REQUIRED=1 делает это ошибкой)" >&2
		fi
	fi
}

snapshot_www() {
	[[ "$HAVE_STATE_DIR" == 1 && -d "$WWW" ]] || return 0
	mkdir -p "$WWW_PREV" && rsync -a --delete --omit-dir-times "$WWW/" "$WWW_PREV/" || echo "deploy-env: снимок PWA не сохранён" >&2
}

snapshot_island() {
	[[ "$HAVE_STATE_DIR" == 1 && -d "$ISLAND_DST" ]] || return 0
	mkdir -p "$ISLAND_PREV" && rsync -a --delete --omit-dir-times "${ISLAND_EXCLUDES[@]}" "$ISLAND_DST/" "$ISLAND_PREV/" || echo "deploy-env: снимок конфигов острова не сохранён" >&2
	for img in "${DEPLOY_IMAGES[@]}"; do
		docker image inspect "$img:local" >/dev/null 2>&1 && docker tag "$img:local" "$img:prev" || true
	done
}

rollback_deploy() {
	echo "deploy-env: ОТКАТ кода к предыдущей версии" >&2
	if [[ -d "$WWW_PREV" ]]; then
		rsync -a --delete --omit-dir-times "$WWW_PREV/" "$WWW/" || echo "deploy-env: не удалось откатить PWA" >&2
	fi
	if [[ -d "$ISLAND_PREV" ]]; then
		rsync -a --delete --omit-dir-times "${ISLAND_EXCLUDES[@]}" --exclude coturn.conf --exclude turncreds.env "$ISLAND_PREV/" "$ISLAND_DST/" || echo "deploy-env: не удалось откатить конфиги" >&2
	fi
	for img in "${DEPLOY_IMAGES[@]}"; do
		docker image inspect "$img:prev" >/dev/null 2>&1 && docker tag "$img:prev" "$img:local" || true
	done
	docker compose -f "$ISLAND_DST/docker-compose.yml" --project-directory "$ISLAND_DST" up -d --no-build --force-recreate \
		|| echo "deploy-env: откат образов не удался — нужен ручной разбор" >&2
	bash "$ROOT/scripts/island-health.sh" "$ENV" || echo "deploy-env: и ПОСЛЕ отката остров нездоров — вмешательство оператора" >&2
}

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

pre_deploy_backup
snapshot_www
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
	snapshot_island
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
		--exclude 'policy' \
		--exclude 'policy-conf' \
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
	# AUDIT-EGOROD G1/G4: код плагина политики записи (монтируется в контейнер relay,
	# см. deploy/island/docker-compose.yml) и редактируемые оператором файлы.
	# policy — код, перезаписывается каждый деплой; policy-conf — правки оператора
	# на хосте, НИКОГДА не перезаписываются (создаются только если их нет).
	if [[ "$ENV" == "prod" ]]; then
		POLICY_DST="$ISLAND_DST/policy"
		mkdir -p "$POLICY_DST/server/strfry" "$POLICY_DST/src/domain/discovery" "$ISLAND_DST/policy-conf"
		for f in whitelist-plugin.mjs write-policy.mjs rate-limit.mjs; do
			install -m 755 "$ROOT/server/strfry/$f" "$POLICY_DST/server/strfry/$f"
		done
		for f in wordfilter.js stopwords.json; do
			install -m 644 "$ROOT/src/domain/discovery/$f" "$POLICY_DST/src/domain/discovery/$f"
		done
		[[ -f "$ISLAND_DST/policy-conf/whitelist.json" ]] || echo '["*"]' >"$ISLAND_DST/policy-conf/whitelist.json"
		[[ -f "$ISLAND_DST/policy-conf/peers.json" ]] || printf '{\n\t"kinds": [],\n\t"peers": []\n}\n' >"$ISLAND_DST/policy-conf/peers.json"
		[[ -f "$ISLAND_DST/policy-conf/policy.json" ]] || printf '{\n\t"mode": "open"\n}\n' >"$ISLAND_DST/policy-conf/policy.json"
		# скрипты эксплуатации — рядом с apply-caddy.sh, чтобы systemd-юниты не
		# зависели от временного каталога раннера
		if [[ -d "$BIN_DIR" && -w "$BIN_DIR" ]]; then
			for f in island-backup.sh island-health.sh island-watchdog.sh; do
				install -m 755 "$ROOT/scripts/$f" "$BIN_DIR/$f" || true
			done
		fi
		# деплой перезаписал blossom-config.yml — если сторож диска держит запись
		# закрытой, повторно применить рубильник
		[[ -x "$BIN_DIR/island-watchdog.sh" ]] && "$BIN_DIR/island-watchdog.sh" --reapply || true
	fi
	# blossom-src исключён из rsync (сторонний форк, клон один раз). Патчи
	# живут в deploy/island/patches — без этого шага test-деплой обновляет
	# только PWA, а ugolok-test-blossom крутит старый образ (415 audio/webm).
	# Образ общий (ugolok-blossom:local), собираем из /opt/ugolok/island.
	BLOSSOM_SRC="${UGOLK_ISLAND_PROD:-/opt/ugolok/island}/blossom-src"
	BLOSSOM_PATCHES="$ROOT/deploy/island/patches"
	BLOSSOM_REF="${BLOSSOM_REF:-ba1444c31d517de9fcb512f7fff92bfed421aaa7}"
	BLOSSOM_STAMP_FILE="${UGOLK_ISLAND_PROD:-/opt/ugolok/island}/.blossom-patches.sha"
	BLOSSOM_REBUILT=0
	if [[ -d "$BLOSSOM_SRC/.git" && -d "$BLOSSOM_PATCHES" ]]; then
		BLOSSOM_STAMP="$(ls -1 "$BLOSSOM_PATCHES"/*.patch 2>/dev/null | sort | xargs sha256sum | sha256sum | awk '{print $1}')"
		if [[ ! -f "$BLOSSOM_STAMP_FILE" || "$(cat "$BLOSSOM_STAMP_FILE")" != "$BLOSSOM_STAMP" ]]; then
			echo "deploy-env: blossom patches changed — checkout $BLOSSOM_REF + apply + build"
			# blossom-src на VPS принадлежит root, раннер — ugolok: без
			# safe.directory git 2.35+ орёт "dubious ownership" и set -e
			# роняет ВЕСЬ деплой уже после rsync PWA (живая проверка:
			# test 15af37c / prod 945fc42 — Action красный, сайт обновлён).
			git_blossom() { git -c safe.directory="$BLOSSOM_SRC" -C "$BLOSSOM_SRC" "$@"; }
			blossom_ok=0
			git_blossom fetch --tags origin || true
			if git_blossom checkout -f "$BLOSSOM_REF"; then
				blossom_ok=1
				for p in "$BLOSSOM_PATCHES"/*.patch; do
					[[ -f "$p" ]] || continue
					if ! git_blossom apply "$p"; then
						blossom_ok=0
						break
					fi
				done
			fi
			PROD_COMPOSE="${UGOLK_ISLAND_PROD:-/opt/ugolok/island}/docker-compose.yml"
			PROD_DIR="${UGOLK_ISLAND_PROD:-/opt/ugolok/island}"
			if [[ "$blossom_ok" == 1 ]] && docker compose -f "$PROD_COMPOSE" --project-directory "$PROD_DIR" build blossom; then
				echo "$BLOSSOM_STAMP" > "$BLOSSOM_STAMP_FILE" || true
				BLOSSOM_REBUILT=1
			else
				echo "deploy-env: blossom rebuild не удался — PWA уже выложена, образ не трогаем" >&2
			fi
		fi
	fi
	if [[ -f "$ISLAND_DST/docker-compose.yml" ]]; then
		# --build: без него compose переиспользует уже существующий образ
		# ugolok-turncreds-server:local как есть, даже если agent-src только что
		# обновился — тег статический, compose не видит, что исходники изменились.
		# Живая проверка (прод, run #42) — /api/turn-credentials оставался 502
		# ПОСЛЕ фикса 127.0.0.1->0.0.0.0 в коде: контейнер не пересобрался,
		# работал старый образ со старой привязкой.
		docker compose -f "$ISLAND_DST/docker-compose.yml" --project-directory "$ISLAND_DST" up -d --build
		# test-compose берёт готовый ugolok-blossom:local без build: — без
		# recreate контейнер останется на старом sha даже после build выше.
		if [[ "$BLOSSOM_REBUILT" == 1 ]]; then
			docker compose -f "$ISLAND_DST/docker-compose.yml" --project-directory "$ISLAND_DST" up -d --force-recreate --no-deps blossom
		fi
	fi
	# AUDIT-EGOROD H1: «поднялось» != «работает». Провал проверки на prod откатывает
	# код (см. rollback_deploy); на test — только красный прогон.
	if [[ -f "$ISLAND_DST/docker-compose.yml" ]]; then
		if ! bash "$ROOT/scripts/island-health.sh" "$ENV"; then
			if [[ "$ENV" == "prod" ]]; then
				rollback_deploy
			fi
			echo "deploy-env: проверка здоровья после выкладки не пройдена" >&2
			exit 1
		fi
	fi
fi

APPLY_CADDY="${UGOLK_APPLY_CADDY:-/opt/ugolok/bin/apply-caddy.sh}"
if [[ -x "$APPLY_CADDY" ]]; then
	if [[ "${EUID}" -eq 0 ]]; then
		"$APPLY_CADDY" "$CADDY_MODE" "$ROOT" "$CADDY_SITE"
	elif ! sudo -n "$APPLY_CADDY" "$CADDY_MODE" "$ROOT" "$CADDY_SITE"; then
		echo "deploy-env: apply-caddy не применился (sudo -n) — Caddy не трогаем" >&2
	fi
else
	echo "deploy-env: нет $APPLY_CADDY — Caddy не трогаем (первый bootstrap на VPS)" >&2
fi

echo "deploy-env: done $ENV -> $WWW"
