#!/usr/bin/env bash
# AUDIT-EGOROD G4/G5. Сторож острова: раз в несколько минут (systemd-таймер,
# deploy/island/systemd/ugolok-watchdog.timer) смотрит на заполнение диска с
# данными и пишет строку JSON с цифрами — по этому журналу видно всплеск
# загрузок/событий (G5). При переполнении САМ включает рубильники (G4):
#   - relay: создаёт policy.lock → плагин отвергает запись клиентов (read-only);
#   - blossom: правило UPLOAD в blossom-config.yml → DENY, контейнер перезапускается.
# Чтение и скачивание продолжают работать — остров деградирует, а не падает.
# Диск, забитый ботами, иначе положил бы всё сразу (relay, blossom, git на одном
# хосте). Снимается ТОЛЬКО вручную: scripts/island-watchdog.sh --release — после
# того как оператор разобрался, что произошло.
#
#   island-watchdog.sh            обычный проход
#   island-watchdog.sh --release  снять рубильники
#   island-watchdog.sh --reapply  заново применить текущее состояние (после деплоя,
#                                 который перезаписал blossom-config.yml)
#
# Переменные: ISLAND_DATA (/var/lib/ugolok), ISLAND_DIR (/opt/ugolok/island),
# WATCHDOG_STATE (/var/lib/ugolok/watchdog), WARN_PCT (80), CUT_PCT (92).
set -euo pipefail

ISLAND_DATA="${ISLAND_DATA:-/var/lib/ugolok}"
ISLAND_DIR="${ISLAND_DIR:-/opt/ugolok/island}"
STATE="${WATCHDOG_STATE:-/var/lib/ugolok/watchdog}"
WARN_PCT="${WARN_PCT:-80}"
CUT_PCT="${CUT_PCT:-92}"
BLOSSOM_C="${BLOSSOM_CONTAINER:-ugolok-blossom}"
LOCK_FILE="$ISLAND_DIR/policy-conf/policy.lock"
BLOSSOM_CFG="$ISLAND_DIR/blossom-config.yml"
FLAG="$STATE/cut"
mkdir -p "$STATE"

say() {
	echo "island-watchdog: $*" >&2
	command -v logger >/dev/null 2>&1 && logger -t ugolok-watchdog "$*" || true
}

# Переключает action у правила UPLOAD: ищет строку `resource: "UPLOAD"` и меняет
# ближайшую выше строку `action:`. Возвращает 0, если файл изменился.
set_upload() {
	local want="$1" tmp
	[ -f "$BLOSSOM_CFG" ] || return 1
	tmp="$(mktemp)"
	awk -v want="$want" '
		{ line[NR] = $0 }
		END {
			for (i = 1; i <= NR; i++) if (line[i] ~ /resource:[ ]*"UPLOAD"/) {
				for (j = i - 1; j >= 1; j--) if (line[j] ~ /action:/) {
					sub(/"(ALLOW|DENY)"/, "\"" want "\"", line[j]); break
				}
			}
			for (i = 1; i <= NR; i++) print line[i]
		}' "$BLOSSOM_CFG" >"$tmp"
	if cmp -s "$tmp" "$BLOSSOM_CFG"; then rm -f "$tmp"; return 1; fi
	cat "$tmp" >"$BLOSSOM_CFG"
	rm -f "$tmp"
	return 0
}

apply_cut() {
	mkdir -p "$(dirname "$LOCK_FILE")"
	date -u +%FT%TZ >"$LOCK_FILE"
	if set_upload DENY; then docker restart "$BLOSSOM_C" >/dev/null 2>&1 || say "не удалось перезапустить $BLOSSOM_C"; fi
}

release_cut() {
	rm -f "$LOCK_FILE" "$FLAG"
	if set_upload ALLOW; then docker restart "$BLOSSOM_C" >/dev/null 2>&1 || say "не удалось перезапустить $BLOSSOM_C"; fi
}

case "${1:-}" in
	--release) release_cut; say "рубильники сняты"; exit 0 ;;
	--reapply) [ -f "$FLAG" ] && apply_cut && say "рубильники применены заново (после деплоя)"; exit 0 ;;
esac

used_pct=$(df -Pk "$ISLAND_DATA" | awk 'NR==2 {gsub("%","",$5); print $5}')
size_kb() { du -sk "$1" 2>/dev/null | awk '{print $1}' || echo 0; }
relay_kb=$(size_kb "$ISLAND_DATA/relay"); blossom_kb=$(size_kb "$ISLAND_DATA/blossom")
now=$(date -u +%FT%TZ)
cut_active=false; [ -f "$FLAG" ] && cut_active=true
# Одна строка на проход — тренд роста виден без внешних метрик.
echo "{\"at\":\"$now\",\"diskUsedPct\":$used_pct,\"relayKB\":${relay_kb:-0},\"blossomKB\":${blossom_kb:-0},\"cut\":$cut_active}" >>"$STATE/watchdog.log"
# Не даём самому журналу расти бесконечно.
if [ "$(wc -l <"$STATE/watchdog.log")" -gt 20000 ]; then tail -n 10000 "$STATE/watchdog.log" >"$STATE/watchdog.log.tmp" && mv "$STATE/watchdog.log.tmp" "$STATE/watchdog.log"; fi

if [ "$used_pct" -ge "$CUT_PCT" ] && [ ! -f "$FLAG" ]; then
	say "ДИСК ${used_pct}% ≥ ${CUT_PCT}% — закрываю запись в relay и загрузки в Blossom (снять: island-watchdog.sh --release)"
	echo "$now diskUsedPct=$used_pct" >"$FLAG"
	apply_cut
elif [ "$used_pct" -ge "$WARN_PCT" ] && [ ! -f "$FLAG" ]; then
	say "предупреждение: диск ${used_pct}% (порог рубильников ${CUT_PCT}%)"
fi
