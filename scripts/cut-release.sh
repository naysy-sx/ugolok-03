#!/usr/bin/env bash
set -euo pipefail

# Выпустить релиз: создать тег vX.Y.Z и запушить его в ОБА remote.
#
# Почему оба руками: Forgejo (origin) не настроен push-mirror-ом на GitHub
# (проверено API — /push_mirrors пуст, repo.mirror=false), а сборка Android/
# Windows/macOS/Linux живёт только в .github/workflows/release.yml — она
# нужна на GitHub-хостед раннерах (ubuntu-latest/windows-latest/macos-latest),
# self-hosted "ugolok" ограничен 2 ГБ RAM в Docker и не потянет Android SDK/
# Gradle или сборку Tauri (см. комментарии в native-android-build.yml и
# native-desktop-build.yml). Тег должен попасть на GitHub, иначе релизный
# workflow там не запустится вовсе.
#
# Публикация готовых пакетов в Forgejo Releases (git.ugolok.tech) происходит
# ВНУТРИ этого GitHub workflow (job publish-to-forgejo, через API с токеном
# FORGEJO_RELEASE_TOKEN) — отдельно пушить ничего больше не нужно.

ROOT=$(cd "$(dirname "$0")/.." && pwd)
cd "$ROOT"

if [ $# -ne 1 ]; then
	echo "использование: $0 vX.Y.Z" >&2
	exit 1
fi
TAG="$1"
if [[ ! "$TAG" =~ ^v[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
	echo "ожидается тег вида vX.Y.Z (без суффиксов — суффиксы считаются pre-release и CI их игнорирует), получено: $TAG" >&2
	exit 1
fi

if [ -n "$(git status --porcelain)" ]; then
	echo "рабочее дерево не чистое — закоммитьте/отложите изменения перед релизом" >&2
	exit 1
fi

git tag -a "$TAG" -m "Релиз $TAG"
git push origin "$TAG"
git push github "$TAG"

echo "Тег $TAG отправлен в origin (Forgejo) и github (зеркало)."
echo "Сборка: https://github.com/naysy-sx/ugolok-03/actions"
echo "Результат появится в https://git.ugolok.tech/naysy/ugolok/releases/tag/$TAG"
