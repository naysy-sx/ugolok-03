#!/usr/bin/env bash
# Клонирует и собирает strfry из исходников в server/strfry/strfry-src/.
# Идемпотентно: повторный запуск не переклонирует, если strfry-src уже существует.
# macOS (Homebrew) — см. server/README.md про Linux/Debian вариант зависимостей.
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")"

if [ ! -d "./strfry-src" ]; then
	if command -v brew >/dev/null 2>&1; then
		brew install pkg-config libtool zlib lmdb flatbuffers secp256k1 libuv perl openssl@3 zstd
	else
		echo "Homebrew не найден — установите зависимости вручную (см. server/README.md)." >&2
	fi

	git clone https://github.com/hoytech/strfry.git strfry-src
	cd strfry-src
	git submodule update --init
	make setup-golpe
	make -j"$(sysctl -n hw.ncpu 2>/dev/null || nproc)"
else
	# Не skip: Homebrew периодически обновляет secp256k1/lmdb/libuv, и уже
	# собранный бинарник остаётся привязан к старому .dylib (dyld exit 134).
	# Incremental make перелинковывает без полного клона.
	echo "strfry-src уже есть — пересобираю (нужно после brew upgrade secp256k1/lmdb/libuv)."
	cd strfry-src
	make -j"$(sysctl -n hw.ncpu 2>/dev/null || nproc)"
fi
