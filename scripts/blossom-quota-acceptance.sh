#!/usr/bin/env bash
# Приёмка квот (ТЗ-04): поднимает образ Blossom с квотами (именованный том — как на Linux-хосте),
# гоняет сквозные проверки клиента (scripts/blossom-quota-e2e.mjs), затем то же с quota.enabled=false.
#   scripts/blossom-quota-acceptance.sh <образ-blossom>
set -uo pipefail
IMAGE="${1:?образ blossom, например ugolok-blossom:quota}"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
W="$(mktemp -d /tmp/blossom-quota.XXXXXX)"
C=quota-acc; V=quota-acc-data; URL=http://127.0.0.1:18310
cleanup() { docker rm -f $C >/dev/null 2>&1; docker volume rm -f $V >/dev/null 2>&1; rm -rf "$W"; }
trap cleanup EXIT; cleanup >/dev/null 2>&1; mkdir -p "$W"
cat > "$W/config.yml" <<YML
db_path: "./data/database.sqlite3"
log_level: "ERROR"
api_addr: "0.0.0.0:8000"
cdn_url: "$URL"
admin_pubkey: "0000000000000000000000000000000000000000000000000000000000000000"
max_upload_size_bytes: 3000000
access_control_rules:
  - {action: "ALLOW", pubkey: "ALL", resource: "UPLOAD"}
  - {action: "ALLOW", pubkey: "ALL", resource: "GET"}
storage: {mode: disk, blobs_dir: ./data/blobs}
quota: {enabled: true, default_bytes: 1000000, max_file_bytes: 600000}
YML
start() { # env...
  docker rm -f $C >/dev/null 2>&1; docker volume rm -f $V >/dev/null 2>&1; docker volume create $V >/dev/null
  docker run --rm -v $V:/d alpine chmod 777 /d >/dev/null
  docker run -d --name $C "$@" -p 127.0.0.1:18310:8000 -v "$W/config.yml:/app/config.yml:ro" -v $V:/app/data "$IMAGE" >/dev/null
  for i in $(seq 1 30); do curl -sf $URL/.well-known/health -o /dev/null && return 0; sleep 1; done; return 1
}
rc=0
echo "== квоты ВКЛЮЧЕНЫ"; start || exit 2; node "$ROOT/scripts/blossom-quota-e2e.mjs" enabled $URL $C || rc=1
echo "== quota.enabled=false (QUOTA_ENABLED=false)"; start -e QUOTA_ENABLED=false || exit 2; node "$ROOT/scripts/blossom-quota-e2e.mjs" disabled $URL || rc=1
exit $rc
