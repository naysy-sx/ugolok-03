#!/usr/bin/env bash
# Клонирует и собирает тестовый Blossom-сервер проекта — форк ugolok-blossom
# (git.ugolok.tech/naysy/ugolok-blossom, происхождение и правки — UPSTREAM.md там же)
# в server/blossom/blossom-src/. Тот же код, что в образе острова и self-host.
# Идемпотентно: повторный запуск не переклонирует, если blossom-src уже существует.
#   BLOSSOM_REPO  откуда клонировать (по умолчанию Forgejo; нужен вход в git.ugolok.tech)
#   BLOSSOM_TAG   тег форка (по умолчанию тот же, что в compose острова)
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")"

if [ ! -d "./blossom-src" ]; then
	if ! command -v go >/dev/null 2>&1; then
		if command -v brew >/dev/null 2>&1; then
			brew install go
		else
			echo "Homebrew не найден и Go не установлен — установите Go вручную (https://go.dev/dl/)." >&2
			exit 1
		fi
	fi

	BLOSSOM_REPO="${BLOSSOM_REPO:-https://git.ugolok.tech/naysy/ugolok-blossom.git}"
	BLOSSOM_TAG="${BLOSSOM_TAG:-ugolok-v1.1.0}"
	git clone "$BLOSSOM_REPO" blossom-src
	git -C blossom-src checkout -q "$BLOSSOM_TAG"

	cd blossom-src
	# Headless-сборка (без тега ui). CGO_ENABLED=1 нужен для mattn/go-sqlite3
	# (нативная привязка) — требует C-компилятор (Xcode CLT на macOS).
	CGO_ENABLED=1 go build -o bin/app ./cmd/api
	CGO_ENABLED=1 go build -o bin/migrate-blobs ./cmd/migrate-blobs
else
	echo "blossom-src уже существует — пропускаю клонирование/сборку. Удалите директорию для пересборки с нуля."
fi
