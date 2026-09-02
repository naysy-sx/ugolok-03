#!/usr/bin/env bash
set -euo pipefail

# Собрать дерево канала dist-updates/ из dist/ + SHA256SUMS.
ROOT=$(cd "$(dirname "$0")/.." && pwd)
cd "$ROOT"

if [ $# -gt 0 ]; then
	RAW="$1"
else
	RAW="$(git describe --tags --exact-match 2>/dev/null || echo v0.0.0-dev)"
fi
if [[ "$RAW" == v* ]]; then
	gitTag="$RAW"
	version="${RAW#v}"
else
	gitTag="v$RAW"
	version="$RAW"
fi

SKIP_BUILD="${SKIP_BUILD:-}"
SKIP_INSTALL="${SKIP_INSTALL:-}"
SKIP_GPG="${SKIP_GPG:-}"

if [ ! -f dist/index.html ] || [ ! -f dist/service-worker.js ]; then
	if [ "$SKIP_BUILD" = 1 ]; then
		echo "нет dist/index.html или dist/service-worker.js, а SKIP_BUILD=1" >&2
		exit 1
	fi
	bash scripts/ci-check.sh
fi

if [ -z "$SKIP_GPG" ] && [ "${CI:-}" = true ]; then
	SKIP_GPG=1
fi
SKIP_GPG="$SKIP_GPG" SKIP_INSTALL="${SKIP_INSTALL:-1}" SKIP_BUILD=1 bash scripts/release-hash.sh

if [ ! -f dist/SHA256SUMS ]; then
	echo "нет dist/SHA256SUMS" >&2
	exit 1
fi

buildHash=$(awk '/index\.html$/ {print $1; exit}' dist/SHA256SUMS)
if [ -z "$buildHash" ]; then
	echo "не удалось прочитать buildHash из dist/SHA256SUMS" >&2
	exit 1
fi
gitSha=$(git rev-parse HEAD)
releasedAt=$(date -u +%Y-%m-%dT%H:%M:%SZ)

rm -rf dist-updates
mkdir -p "dist-updates/latest" "dist-updates/$gitTag"

PACK_VERSION="$version" PACK_GIT_TAG="$gitTag" PACK_GIT_SHA="$gitSha" PACK_BUILD_HASH="$buildHash" PACK_RELEASED_AT="$releasedAt" node --input-type=commonjs -e '
const fs = require("node:fs");
const out = {
  name: "ugolok",
  version: process.env.PACK_VERSION,
  gitTag: process.env.PACK_GIT_TAG,
  gitSha: process.env.PACK_GIT_SHA,
  buildHash: process.env.PACK_BUILD_HASH,
  releasedAt: process.env.PACK_RELEASED_AT,
  minClientVersion: process.env.PACK_VERSION,
  channels: { web: { url: "/index.html" } },
  notesUrl: "https://updates.ugolok.tech/changelog.md",
  updatesBaseUrl: "https://updates.ugolok.tech",
};
fs.writeFileSync("dist-updates/version.json", JSON.stringify(out, null, 2) + "\n");
'

prev="$(git describe --tags --abbrev=0 --exclude "$gitTag" 2>/dev/null || true)"
if [ -n "$prev" ]; then
	git log --pretty=format:%s "$prev"..HEAD > dist-updates/changelog.md
	echo >> dist-updates/changelog.md
else
	echo "Initial release" > dist-updates/changelog.md
fi

if [ -f deploy/config.example.json ]; then
	cp deploy/config.example.json dist-updates/config.example.json
else
	printf '%s\n' '{"instanceName":"local","relays":["ws://127.0.0.1:7777"]}' > dist-updates/config.example.json
fi

copy_tree() {
	local dest="$1"
	mkdir -p "$dest"
	cp dist/index.html dist/service-worker.js dist/SHA256SUMS "$dest/"
	if [ -f dist/SHA256SUMS.asc ]; then
		cp dist/SHA256SUMS.asc "$dest/"
	fi
	cp dist-updates/version.json "$dest/"
	cp dist-updates/config.example.json "$dest/"
}

copy_tree dist-updates/latest
copy_tree "dist-updates/$gitTag"
