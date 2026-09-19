#!/usr/bin/env bash
# AUDIT-EGOROD H1/H3. Резервная копия данных острова: события relay (strfry
# export → gzip), метаданные Blossom (sqlite) и blob'ы (rsync с hardlink'ами —
# файлы неизменяемы и адресуются хэшем, поэтому каждый следующий снимок почти
# ничего не стоит по диску). Запускается перед выкладкой (deploy-env.sh) и по
# таймеру (deploy/island/systemd/ugolok-backup.timer).
#
# Честное ограничение: локальный снимок на том же диске защищает от ошибки
# выкладки/миграции/оператора, но НЕ от гибели диска или хоста. Для этого —
# BACKUP_REMOTE (rsync по ssh на другой хост) или вынос BACKUP_DIR на отдельный том.
#
# Переменные (значения по умолчанию — боевые):
#   ISLAND_DATA     /var/lib/ugolok             данные relay/blossom на хосте
#   BACKUP_DIR      /var/backups/ugolok         куда складывать снимки
#   BACKUP_KEEP     7                           сколько снимков хранить
#   BACKUP_REMOTE   (пусто)                     user@host:/path — зеркалировать после снимка
#   RELAY_CONTAINER ugolok-relay
#   MIN_FREE_MB     2048                        меньше свободного места — отказ (копия не должна
#                                               сама добить диск: см. AUDIT-EGOROD G2)
#   BLOSSOM_DB      $ISLAND_DATA/blossom/database.sqlite3
set -euo pipefail

ISLAND_DATA="${ISLAND_DATA:-/var/lib/ugolok}"
BACKUP_DIR="${BACKUP_DIR:-/var/backups/ugolok}"
BACKUP_KEEP="${BACKUP_KEEP:-7}"
BACKUP_REMOTE="${BACKUP_REMOTE:-}"
RELAY_CONTAINER="${RELAY_CONTAINER:-ugolok-relay}"
MIN_FREE_MB="${MIN_FREE_MB:-2048}"
BLOSSOM_DIR="$ISLAND_DATA/blossom"
BLOSSOM_DB="${BLOSSOM_DB:-$BLOSSOM_DIR/database.sqlite3}"

log() { echo "island-backup: $*" >&2; }

mkdir -p "$BACKUP_DIR"
if command -v flock >/dev/null 2>&1; then
	exec 8>"$BACKUP_DIR/.lock"
	flock -n 8 || { log "уже выполняется другой бэкап"; exit 0; }
fi

free_mb=$(df -Pk "$BACKUP_DIR" | awk 'NR==2 {print int($4/1024)}')
if [ "$free_mb" -lt "$MIN_FREE_MB" ]; then
	log "свободно ${free_mb} МБ < ${MIN_FREE_MB} МБ — бэкап отменён, чтобы не добить диск"
	exit 1
fi

STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
DEST="$BACKUP_DIR/$STAMP"
TMP="$BACKUP_DIR/.tmp-$STAMP"
trap 'rm -rf "$TMP"' EXIT
mkdir -p "$TMP"

# 1. relay: export идёт через штатное чтение LMDB, без остановки и без блокировки записи.
log "relay: strfry export"
docker exec "$RELAY_CONTAINER" /app/strfry --config=/app/strfry.conf export 2>/dev/null | gzip -c >"$TMP/relay-events.jsonl.gz"
gzip -t "$TMP/relay-events.jsonl.gz"
relay_lines=$(gzip -dc "$TMP/relay-events.jsonl.gz" | wc -l | tr -d ' ')

# 2. blossom: sqlite. Согласованная копия — штатным .backup; если sqlite3 нет на
# хосте, копируем файл вместе с WAL/SHM (Blossom работает в WAL, см. патч 0001) и
# честно помечаем в манифесте, что снимок «грубый».
sqlite_mode=""
if [ -f "$BLOSSOM_DB" ]; then
	if command -v sqlite3 >/dev/null 2>&1; then
		sqlite3 "$BLOSSOM_DB" ".backup '$TMP/blossom.sqlite3'"
		sqlite_mode="sqlite3-backup"
	else
		cp "$BLOSSOM_DB" "$TMP/blossom.sqlite3"
		[ -f "$BLOSSOM_DB-wal" ] && cp "$BLOSSOM_DB-wal" "$TMP/blossom.sqlite3-wal"
		[ -f "$BLOSSOM_DB-shm" ] && cp "$BLOSSOM_DB-shm" "$TMP/blossom.sqlite3-shm"
		sqlite_mode="file-copy-with-wal (sqlite3 на хосте нет)"
		log "ВНИМАНИЕ: sqlite3 не найден, метаданные Blossom скопированы файлом"
	fi
else
	log "ВНИМАНИЕ: $BLOSSOM_DB не найден — метаданные Blossom не сохранены"
	sqlite_mode="missing"
fi

# 3. blob'ы: hardlink-инкремент от предыдущего снимка.
mkdir -p "$TMP/blobs"
LINK=()
if [ -d "$BACKUP_DIR/latest/blobs" ]; then
	LINK=(--link-dest="$(cd "$BACKUP_DIR/latest/blobs" && pwd -P)")
fi
if [ -d "$BLOSSOM_DIR/blobs" ]; then
	log "blossom: blobs"
	rsync -a "${LINK[@]+"${LINK[@]}"}" "$BLOSSOM_DIR/blobs/" "$TMP/blobs/"
fi
blob_count=$(find "$TMP/blobs" -type f | wc -l | tr -d ' ')

cat >"$TMP/MANIFEST" <<EOM
stamp=$STAMP
relay_events=$relay_lines
blossom_db=$sqlite_mode
blob_files=$blob_count
EOM

mv "$TMP" "$DEST"
trap - EXIT
ln -sfn "$DEST" "$BACKUP_DIR/latest"
log "готово: $DEST (событий relay: $relay_lines, blob-файлов: $blob_count)"

# 4. ротация: оставляем BACKUP_KEEP последних.
ls -1d "$BACKUP_DIR"/2* 2>/dev/null | sort | awk -v keep="$BACKUP_KEEP" '{a[NR]=$0} END {for (i = 1; i <= NR - keep; i++) print a[i]}' | while read -r old; do
	[ -n "$old" ] && rm -rf "$old" && log "удалён старый снимок $old"
done || true

if [ -n "$BACKUP_REMOTE" ]; then
	log "remote: rsync → $BACKUP_REMOTE"
	rsync -a --delete-after "$BACKUP_DIR/" "$BACKUP_REMOTE/"
fi
