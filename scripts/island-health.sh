#!/usr/bin/env bash
# AUDIT-EGOROD H1. Проверка здоровья острова ПОСЛЕ выкладки: не «контейнер
# запущен», а «сервис отвечает по делу».
#   relay      — NIP-11 отвечает; (prod) плагин политики запускается в контейнере и
#                отвечает валидным JSON на тестовый запрос (иначе relay молча
#                отвергал бы ВСЕ записи);
#   blossom    — /stats отвечает 200;
#   turncreds  — (prod) /turn-credentials отдаёт 200.
# Повторяет проверки до HEALTH_TIMEOUT секунд (контейнеры стартуют не мгновенно).
# Код выхода: 0 — здоров, 1 — нет (выкладка откатывается, см. deploy-env.sh).
#
#   scripts/island-health.sh test|prod
set -uo pipefail

ENV="${1:-prod}"
HEALTH_TIMEOUT="${HEALTH_TIMEOUT:-90}"
if [ "$ENV" = "test" ]; then
	RELAY_C="${RELAY_CONTAINER:-ugolok-test-relay}"; RELAY_PORT=7778; BLOSSOM_PORT=8001; TURN_PORT=""; CHECK_PLUGIN=0
else
	RELAY_C="${RELAY_CONTAINER:-ugolok-relay}"; RELAY_PORT=7777; BLOSSOM_PORT=8000; TURN_PORT=8090; CHECK_PLUGIN=1
fi

fails=()
check_relay() {
	curl -fsS -m 5 -H 'Accept: application/nostr+json' "http://127.0.0.1:$RELAY_PORT/" 2>/dev/null | grep -q '"name"'
}
check_plugin() {
	[ "$CHECK_PLUGIN" = 1 ] || return 0
	# Import — не клиентский сокет, лимитер не трогается; нужен лишь валидный ответ.
	local req='{"type":"new","event":{"id":"0000000000000000000000000000000000000000000000000000000000000000","pubkey":"0000000000000000000000000000000000000000000000000000000000000000","kind":1,"content":"","tags":[]},"sourceType":"Import","sourceInfo":""}'
	printf '%s\n' "$req" | timeout 15 docker exec -i "$RELAY_C" sh -c 'POLICY_CONF_DIR=/app/policy-conf timeout 10 node /app/policy/server/strfry/whitelist-plugin.mjs' 2>/dev/null | head -n1 | grep -q '"action"'
}
check_blossom() {
	curl -fsS -m 5 -o /dev/null "http://127.0.0.1:$BLOSSOM_PORT/stats" 2>/dev/null
}
check_turn() {
	[ -n "$TURN_PORT" ] || return 0
	curl -fsS -m 5 -o /dev/null "http://127.0.0.1:$TURN_PORT/turn-credentials" 2>/dev/null
}

deadline=$(( $(date +%s) + HEALTH_TIMEOUT ))
while :; do
	fails=()
	check_relay || fails+=("relay: NIP-11 не отвечает на 127.0.0.1:$RELAY_PORT")
	check_plugin || fails+=("relay: плагин политики не отвечает в контейнере $RELAY_C")
	check_blossom || fails+=("blossom: /stats не отвечает на 127.0.0.1:$BLOSSOM_PORT")
	check_turn || fails+=("turncreds: /turn-credentials не отвечает на 127.0.0.1:$TURN_PORT")
	[ ${#fails[@]} -eq 0 ] && { echo "island-health: ok ($ENV)"; exit 0; }
	[ "$(date +%s)" -ge "$deadline" ] && break
	sleep "${HEALTH_INTERVAL:-3}"
done
for f in "${fails[@]}"; do echo "island-health: FAIL — $f" >&2; done
exit 1
