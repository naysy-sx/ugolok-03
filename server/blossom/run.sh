#!/usr/bin/env bash
# Запускает локальный тестовый Blossom-сервер проекта.
# cd в blossom-src обязателен — бинарник читает "config.yml" и "db/migrations" как
# ФИКСИРОВАННЫЕ относительные пути от рабочей директории процесса (нет флага --config,
# в отличие от strfry). config.yml копируется из server/blossom/ (версионируемый
# оригинал) при КАЖДОМ запуске — гарантирует, что наши настройки не разъезжаются
# с тем, что реально видит процесс.
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")"

if [ ! -x "./blossom-src/bin/app" ]; then
	echo "Blossom-сервер не собран. См. server/README.md — server/blossom/setup.sh." >&2
	exit 1
fi

mkdir -p ./blossom-db
cp ./config.yml ./blossom-src/config.yml
# Необязательный blossom.env (не в git, права 600): STORAGE_MODE=s3, S3_ENDPOINT, S3_BUCKET,
# S3_ACCESS_KEY_ID, S3_SECRET_ACCESS_KEY — переключает dev-сервер на локальный MinIO.
if [ -f ./blossom.env ]; then
	set -a
	# shellcheck disable=SC1091
	. ./blossom.env
	set +a
fi
cd blossom-src
exec ./bin/app
