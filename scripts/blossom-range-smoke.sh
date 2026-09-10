#!/usr/bin/env bash
# Приёмка Range без подъёма всего блоба в RAM. Если локальный blossom не
# запущен — гоняет Go-тест httpapi.TestGetRangeDoesNotRequireFullBodyInSQL.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT/server/blossom/blossom-src"
if [[ "${1:-}" == "--go" ]] || ! curl -sf -o /dev/null --max-time 1 http://127.0.0.1:8080/.well-known/health 2>/dev/null; then
	echo "blossom не слушает :8080 — CGO go test Range/HEAD/orphan/dual-read"
	CGO_ENABLED=1 go test ./internal/httpapi -count=1 -run 'TestGetRange|TestHeadBlob|TestOrphanMeta|TestDualRead'
	exit 0
fi
echo "живой blossom на :8080 — нужен заранее залитый hash (BLOSSOM_HASH) ≥20МиБ"
HASH="${BLOSSOM_HASH:?укажите BLOSSOM_HASH=64hex}"
URL="http://127.0.0.1:8080/${HASH}"
curl -sD- -o /dev/null -H 'Range: bytes=0-65535' "$URL" | head -n 20
echo "--- HEAD ---"
curl -sI "$URL" | head -n 20
