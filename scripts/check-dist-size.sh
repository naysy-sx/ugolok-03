#!/usr/bin/env bash
# Проверка размера dist/index.html после сборки. Общий шаг: ci-check.sh
# (на хосте с Node) и deploy-env.sh (на хосте, ПОСЛЕ выхода из контейнера
# сборки — на VPS самого Node нет, только gzip/wc, которые есть везде).
set -euo pipefail

LIMIT_BYTES=1335296

if [ ! -f dist/index.html ]; then
  echo "check-dist-size: dist/index.html не существует" >&2
  exit 1
fi

SIZE=$(gzip -c dist/index.html | wc -c | tr -d ' ')
echo "gzip index.html: $SIZE bytes"

if [ "$SIZE" -gt "$LIMIT_BYTES" ]; then
  echo "Размер файла index.html превышает 1304 KB" >&2
  exit 1
fi
