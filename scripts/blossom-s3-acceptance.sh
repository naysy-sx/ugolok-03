#!/usr/bin/env bash
# Приёмка слоя хранения S3 (ТЗ-02, раздел 5) на MinIO. Всё локально, в docker.
#
#   scripts/blossom-s3-acceptance.sh <образ-blossom> [бэкап-боевой-sqlite]
#
# Пример:  scripts/blossom-s3-acceptance.sh ugolok-blossom:s3dev /tmp/blossom-prod-copy.sqlite3
# Без второго аргумента сценарий 7 (migrate-blobs на копии боевой базы) пропускается.
# Ничего не оставляет: контейнеры, сеть и временные каталоги удаляются в конце.
set -uo pipefail
IMAGE="${1:?образ blossom, например ugolok-blossom:s3dev}"
PROD_DB="${2:-}"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
CLI="node $ROOT/scripts/blossom-cli.mjs"
MINIO_IMAGE="${MINIO_IMAGE:-quay.io/minio/minio:latest}"
MC_IMAGE="${MC_IMAGE:-quay.io/minio/mc:latest}"
NET=blossom-acc; MINIO=acc-minio; BL=acc-blossom
AK=accessuser; SK=accesssecret-123
PORT=18100; URL="http://127.0.0.1:$PORT"
WORK="$(mktemp -d /tmp/blossom-acc.XXXXXX)"
export BLOSSOM_KEY="$(node -e 'console.log(Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("hex"))')"
pass=0; fail=0
ok()   { echo "  ok   $*"; pass=$((pass+1)); }
bad()  { echo "  FAIL $*"; fail=$((fail+1)); }
check(){ local name="$1"; shift; if "$@"; then ok "$name"; else bad "$name"; fi; }
cleanup() { docker rm -f $BL $BL-mig $MINIO >/dev/null 2>&1; docker network rm $NET >/dev/null 2>&1; rm -rf "$WORK"; }
trap cleanup EXIT
cleanup >/dev/null 2>&1; mkdir -p "$WORK"

mc() { docker run --rm --network $NET -e MC_HOST_m="http://$AK:$SK@$MINIO:9000" --entrypoint mc "$MC_IMAGE" "$@"; }
inbucket() { mc ls --recursive "m/$1" 2>/dev/null | grep -q "$2"; }
notinbucket() { ! inbucket "$@"; }
nobj() { mc ls --recursive "m/$1" 2>/dev/null | grep -c . || true; }
sql() { sqlite3 -readonly "$WORK/data/database.sqlite3" "$@" 2>/dev/null; }
remote_at() { sql "select coalesce(remote_at,'NULL') from blobs where hash='$1'"; }
wait_for() { local what="$1" secs="$2"; shift 2; local i; for i in $(seq 1 "$secs"); do "$@" && return 0; sleep 1; done; echo "  (не дождались: $what)"; return 1; }
cfg() { # mode max_bytes min_free_pct
cat > "$WORK/config.yml" <<YML
db_path: "./data/database.sqlite3"
log_level: "INFO"
api_addr: "0.0.0.0:8000"
cdn_url: "$URL"
admin_pubkey: "0000000000000000000000000000000000000000000000000000000000000000"
max_upload_size_bytes: 314572800
access_control_rules:
  - {action: "ALLOW", pubkey: "ALL", resource: "UPLOAD"}
  - {action: "ALLOW", pubkey: "ALL", resource: "GET"}
storage:
  mode: $1
  blobs_dir: ./data/blobs
  cache: {max_bytes: $2, min_free_pct: $3}
  s3: {endpoint: "http://$MINIO:9000", region: auto, bucket: blossom, force_path_style: true}
YML
}
start_blossom() {
  docker rm -f $BL >/dev/null 2>&1
  docker run -d --name $BL --network $NET -p 127.0.0.1:$PORT:8000 -m 512m --memory-swap 512m \
    -e S3_ACCESS_KEY_ID=$AK -e S3_SECRET_ACCESS_KEY=$SK \
    -v "$WORK/config.yml:/app/config.yml:ro" -v "$WORK/data:/app/data" "$IMAGE" >/dev/null
  wait_for "blossom" 30 curl -sf "$URL/.well-known/health" -o /dev/null
}
start_minio() {
  docker start $MINIO >/dev/null 2>&1 || docker run -d --name $MINIO --network $NET -e MINIO_ROOT_USER=$AK -e MINIO_ROOT_PASSWORD=$SK "$MINIO_IMAGE" server /data >/dev/null
  wait_for "minio" 40 docker run --rm --network $NET --entrypoint sh "$MC_IMAGE" -c "curl -sf http://$MINIO:9000/minio/health/live" >/dev/null 2>&1 \
    || wait_for "minio" 40 mc ls m >/dev/null
}
blob_path() { echo "$WORK/data/blobs/${1:0:2}/$1"; }
fetch_count() { docker logs $BL 2>&1 | grep -c '"s3 fetch"'; }

echo "== подготовка: MinIO ($MINIO_IMAGE) и Blossom ($IMAGE)"
docker network create $NET >/dev/null
mkdir -p "$WORK/data"; chmod 777 "$WORK/data"
start_minio || { echo "MinIO не поднялся"; exit 2; }
mc mb m/blossom >/dev/null; mc mb m/prodcopy >/dev/null
cfg s3 0 0
start_blossom || { docker logs $BL | tail; echo "Blossom не поднялся"; exit 2; }

echo "== 1. заливка: строка, файл на диске, remote_at, объект в бакете"
A=$($CLI put $URL 300000 a)
check "файл на диске сразу"           test -f "$(blob_path $A)"
wait_for "remote_at" 90 bash -c "[ \"\$(sqlite3 -readonly '$WORK/data/database.sqlite3' \"select remote_at is not null from blobs where hash='$A'\" 2>/dev/null)\" = 1 ]"
check "remote_at заполнен"            bash -c "[ \"$(remote_at $A)\" != NULL ] && [ -n \"$(remote_at $A)\" ]"
check "объект виден в бакете"         inbucket blossom $A

echo "== 2. заливка при остановленном MinIO, затем досылка"
docker stop $MINIO >/dev/null
B=$($CLI put $URL 200000 b); rc=$?
check "клиент получил успех"          test $rc -eq 0 -a -n "$B"
sleep 3
check "remote_at пуст"                test "$(remote_at $B)" = NULL
docker start $MINIO >/dev/null; wait_for "minio" 40 mc ls m >/dev/null
wait_for "досылка" 300 bash -c "[ \"\$(sqlite3 -readonly '$WORK/data/database.sqlite3' \"select remote_at is not null from blobs where hash='$B'\" 2>/dev/null)\" = 1 ]"
check "после запуска MinIO remote_at появился" test "$(remote_at $B)" != NULL
check "объект дослан в бакет"         inbucket blossom $B

echo "== 3. холодное чтение: файла на диске нет → Range 206, файл вернулся"
rm -f "$(blob_path $A)"
check "файла нет на диске"            test ! -f "$(blob_path $A)"
check "Range 206, содержимое верное"  $CLI verify $URL $A 300000 a 1000-51999
check "файл снова на диске"           test -f "$(blob_path $A)"
check "полное чтение верное"          $CLI verify $URL $A 300000 a

echo "== 4. восемь одновременных Range к холодному хешу → одна загрузка"
C=$($CLI put $URL 3000000 c)
wait_for "remote_at C" 90 bash -c "[ \"\$(sqlite3 -readonly '$WORK/data/database.sqlite3' \"select remote_at is not null from blobs where hash='$C'\" 2>/dev/null)\" = 1 ]"
rm -f "$(blob_path $C)"; before=$(fetch_count)
for i in 1 2 3 4 5 6 7 8; do ( $CLI verify $URL $C 3000000 c $((i*100000))-$((i*100000+65535)) >"$WORK/par$i.out" 2>&1 ) & done; wait
okn=$(cat "$WORK"/par*.out | grep -c '^ok 206')
check "все 8 запросов вернули 206 и верные байты" test "$okn" -eq 8
check "в бакет ушла одна загрузка (fetch: +$(( $(fetch_count) - before )))" test $(( $(fetch_count) - before )) -eq 1

echo "== HEAD холодного блоба не скачивает объект"
rm -f "$(blob_path $C)"; before=$(fetch_count)
code=$(curl -s -o /dev/null -w '%{http_code}' -I "$URL/$C")
check "HEAD 200"                      test "$code" = 200
check "HEAD не скачал объект"         test $(( $(fetch_count) - before )) -eq 0
check "и не положил файл на диск"     test ! -f "$(blob_path $C)"

echo "== 5. вытеснение: только файлы с remote_at; без него остаются"
docker stop $MINIO >/dev/null
D=$($CLI put $URL 2000000 d)                       # не доедет до бакета (MinIO остановлен)
cfg s3 1000000 0; start_blossom                     # потолок кэша 1 МБ; у файлов A,B,C,D суммарно больше
echo "  (ждём проход вытеснения ~ до 2 минут: файлы должны стать старше 1 минуты)"
wait_for "вытеснение" 200 bash -c "[ ! -f '$(blob_path $A)' ]"
check "D (remote_at NULL) остался на диске"   test -f "$(blob_path $D)"
check "D всё ещё без remote_at"               test "$(remote_at $D)" = NULL
check "строка вытесненного A осталась"        test "$(sql "select count(*) from blobs where hash='$A'")" = 1
docker start $MINIO >/dev/null; wait_for "minio" 40 mc ls m >/dev/null
check "вытесненный A читается (из бакета)"    $CLI verify $URL $A 300000 a 5000-9999
wait_for "досылка D" 300 bash -c "[ \"\$(sqlite3 -readonly '$WORK/data/database.sqlite3' \"select remote_at is not null from blobs where hash='$D'\" 2>/dev/null)\" = 1 ]"
check "D дослан после запуска MinIO"          test "$(remote_at $D)" != NULL

echo "== 6. удаление: объект, файл и строка"
cfg s3 0 0; start_blossom
$CLI verify $URL $B 200000 b 0-99 >/dev/null   # подтягиваем на диск, чтобы проверить и файл
$CLI del $URL $B >/dev/null
check "объект удалён из бакета"       notinbucket blossom $B
check "файл удалён с диска"           test ! -f "$(blob_path $B)"
check "строка удалена"                test "$(sql "select count(*) from blobs where hash='$B'")" = 0
check "чтение после удаления — 404"   test "$(curl -s -o /dev/null -w '%{http_code}' $URL/$B)" = 404

echo "== 8. память: заливка и чтение файла 300 МБ при лимите 512 МиБ"
peak=0; ( while true; do m=$(docker stats --no-stream --format '{{.MemUsage}}' $BL 2>/dev/null | awk '{print $1}'); echo "$m" >> "$WORK/mem.txt"; sleep 1; done ) & MON=$!
BIG=$($CLI put $URL 300000000 big); rc=$?
check "заливка 300 МБ прошла"         test $rc -eq 0
wait_for "remote_at BIG" 300 bash -c "[ \"\$(sqlite3 -readonly '$WORK/data/database.sqlite3' \"select remote_at is not null from blobs where hash='$BIG'\" 2>/dev/null)\" = 1 ]"
rm -f "$(blob_path $BIG)"
check "холодное чтение 300 МБ (Range из середины)" $CLI verify $URL $BIG 300000000 big 150000000-150065535
check "полное чтение 300 МБ верное"   $CLI verify $URL $BIG 300000000 big
kill $MON 2>/dev/null; wait $MON 2>/dev/null
peakmib=$(awk '{v=$1; if (v ~ /GiB/) {sub(/GiB/,"",v); v=v*1024} else {sub(/MiB/,"",v)} if (v+0>m) m=v+0} END{printf "%d", m}' "$WORK/mem.txt")
oom=$(docker inspect $BL --format '{{.State.OOMKilled}}')
check "пик памяти контейнера ${peakmib} МиБ < 512, OOM нет" bash -c "[ $peakmib -lt 512 ] && [ $oom = false ]"
$CLI del $URL $BIG >/dev/null 2>&1

echo "== 7. migrate-blobs на копии боевой базы"
if [ -n "$PROD_DB" ] && [ -f "$PROD_DB" ]; then
  mkdir -p "$WORK/mig"; chmod 777 "$WORK/mig"; cp "$PROD_DB" "$WORK/mig/database.sqlite3"
  total=$(sqlite3 -readonly "$WORK/mig/database.sqlite3" "select count(*) from blobs"); legacy=$(sqlite3 -readonly "$WORK/mig/database.sqlite3" "select coalesce(sum(length(blob)),0) from blobs")
  sizebefore=$(stat -f%z "$WORK/mig/database.sqlite3" 2>/dev/null || stat -c%s "$WORK/mig/database.sqlite3")
  sed "s#bucket: blossom#bucket: prodcopy#; s#./data/#./data/#" "$WORK/config.yml" > "$WORK/config-mig.yml"
  run_mig() { docker run --rm --name $BL-mig --network $NET -m 512m -e S3_ACCESS_KEY_ID=$AK -e S3_SECRET_ACCESS_KEY=$SK \
     -v "$WORK/config-mig.yml:/app/config.yml:ro" -v "$WORK/mig:/app/data" --entrypoint /app/migrate-blobs "$IMAGE" "$@"; }
  echo "  база: $total блобов, $legacy байт в колонке blob"
  run_mig --dry-run 2>&1 | tail -2
  run_mig --vacuum 2>&1 | tail -3
  check "все $total блобов в бакете prodcopy"  test "$(nobj prodcopy)" -eq "$total"
  check "remote_at заполнен у всех"            test "$(sqlite3 -readonly "$WORK/mig/database.sqlite3" "select count(*) from blobs where remote_at is null")" = 0
  check "колонка blob очищена"                 test "$(sqlite3 -readonly "$WORK/mig/database.sqlite3" "select coalesce(sum(length(blob)),0) from blobs")" = 0
  sizeafter=$(stat -f%z "$WORK/mig/database.sqlite3" 2>/dev/null || stat -c%s "$WORK/mig/database.sqlite3")
  check "база сжалась ($sizebefore → $sizeafter байт)" test "$sizeafter" -lt $((sizebefore/10))
  echo "  повторный запуск (должен ничего не делать):"; run_mig 2>&1 | tail -1
  big=$(sqlite3 -readonly "$WORK/mig/database.sqlite3" "select hash||' '||size from blobs order by size desc limit 1")
  # читаем самый большой блоб через Blossom, поднятый на мигрированной базе, и сверяем sha256
  docker rm -f $BL >/dev/null 2>&1
  sed -i.bak "s#bucket: blossom#bucket: prodcopy#" "$WORK/config.yml"; rm -f "$WORK/config.yml.bak"
  docker run -d --name $BL --network $NET -p 127.0.0.1:$PORT:8000 -m 512m -e S3_ACCESS_KEY_ID=$AK -e S3_SECRET_ACCESS_KEY=$SK \
    -v "$WORK/config.yml:/app/config.yml:ro" -v "$WORK/mig:/app/data" "$IMAGE" >/dev/null
  wait_for "blossom" 30 curl -sf "$URL/.well-known/health" -o /dev/null
  h=${big% *}; got=$(curl -s "$URL/$h" | shasum -a 256 | cut -c1-64)
  check "самый большой блоб (${big#* } Б) читается, sha256 сходится" test "$got" = "$h"
  stats=$(curl -s $URL/stats); echo "  /stats: $stats"
  check "/stats: blob_count = $total"          bash -c "echo '$stats' | grep -q '\"blob_count\":$total'"
else
  echo "  пропущено (нет копии боевой базы)"
fi

echo "== 9. mode=disk: прежнее поведение"
docker rm -f $BL >/dev/null 2>&1; rm -rf "$WORK/data"; mkdir -p "$WORK/data"; chmod 777 "$WORK/data"
cfg disk 0 0; sed -i.bak 's#bucket: prodcopy#bucket: blossom#' "$WORK/config.yml" 2>/dev/null; rm -f "$WORK/config.yml.bak"
start_blossom
docker stop $MINIO >/dev/null   # бакет не нужен и недоступен — disk от него не зависит
E=$($CLI put $URL 500000 e); rc=$?
check "заливка в режиме disk"         test $rc -eq 0
sleep 2
check "remote_at не заполняется"      test "$(remote_at $E)" = NULL
check "чтение с диска"                $CLI verify $URL $E 500000 e 100-999
rm -f "$(blob_path $E)"
check "без файла в disk — 404 (не 503)" test "$(curl -s -o /dev/null -w '%{http_code}' $URL/$E)" = 404
check "в логе нет обращений к бакету" bash -c "! docker logs $BL 2>&1 | grep -qE 's3 (push|fetch)'"
node "$ROOT/scripts/blossom-smoke.mjs" $URL >"$WORK/smoke.out" 2>&1; rc=$?
check "blossom-smoke.mjs (9 проверок)" test $rc -eq 0

echo
echo "итог: ok=$pass fail=$fail"
[ "$fail" -eq 0 ]
