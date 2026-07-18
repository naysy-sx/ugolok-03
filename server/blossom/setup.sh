#!/usr/bin/env bash
# Клонирует и собирает тестовый Blossom-сервер (sebdeveloper6952/blossom-server, Go,
# BUD-01/02/04/06/08) в server/blossom/blossom-src/.
# Идемпотентно: повторный запуск не переклонирует, если blossom-src уже существует.
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

	git clone https://github.com/sebdeveloper6952/blossom-server.git blossom-src
	cd blossom-src
	# Headless-сборка (без тега ui — админ-панель на Svelte/pnpm не нужна для тестового
	# сервера, используемого только клиентом "Уголок"). CGO_ENABLED=1 нужен для
	# mattn/go-sqlite3 (нативная привязка) — требует C-компилятор (Xcode CLT на macOS).
	CGO_ENABLED=1 go build -o bin/app ./cmd/api
else
	echo "blossom-src уже существует — пропускаю клонирование/сборку. Удалите директорию для пересборки с нуля."
fi
