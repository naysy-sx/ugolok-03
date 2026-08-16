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

	# Патч поверх вендорного сида: апстримная 3_seed_mime_types.sql содержит
	# video/webm, но не audio/webm — голосовые сообщения (voice.js пишет Blob как
	# "audio/webm") с этапа 62 проходят BUD-06-преflight (HEAD /upload), который
	# сверяет реальный mime с этой таблицей, и получают 415. Новый файл миграции,
	# а не правка 3_seed_mime_types.sql — библиотека миграций применяет файлы по
	# имени один раз и, вероятно, палит чек-сумму уже применённых; новый файл
	# безопасен и подхватится автоматически при следующем запуске ./bin/app
	# (db.NewDB читает db/migrations на каждом старте, cmd/api/main.go).
	cat > blossom-src/db/migrations/4_add_audio_webm.sql <<'EOF'
-- +migrate Up
INSERT INTO mime_types(extension, mime_type)
VALUES
(".weba","audio/webm");

-- +migrate Down
DELETE FROM mime_types WHERE mime_type = "audio/webm";
EOF

	cd blossom-src
	# Headless-сборка (без тега ui — админ-панель на Svelte/pnpm не нужна для тестового
	# сервера, используемого только клиентом "Уголок"). CGO_ENABLED=1 нужен для
	# mattn/go-sqlite3 (нативная привязка) — требует C-компилятор (Xcode CLT на macOS).
	CGO_ENABLED=1 go build -o bin/app ./cmd/api
else
	echo "blossom-src уже существует — пропускаю клонирование/сборку. Удалите директорию для пересборки с нуля."
fi
