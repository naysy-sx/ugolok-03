#!/usr/bin/env bash
# Выгружает колонку blobs.blob в файлы {blobs_dir}/{hh}/{hash}.
# Идемпотентно. --drop-blob-column только после успешного полного прохода.
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")"
if [ ! -x "./blossom-src/bin/app" ] && [ ! -d "./blossom-src" ]; then
	echo "нет blossom-src — сначала setup.sh" >&2
	exit 1
fi
cp ./config.yml ./blossom-src/config.yml
cd blossom-src
exec go run ./cmd/migrate-blobs -config config.yml "$@"
