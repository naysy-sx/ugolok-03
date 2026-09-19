#!/usr/bin/env bash
# GATEWAY-TZ-1.md §1. Инвариант шлюзовой модели: клиент ходит только в свой
# инстанс. Скрипт вынимает из dist/index.html и dist/service-worker.js все
# абсолютные http(s)/ws(s)-адреса и падает, если хост не в списке разрешённых.
#
# Почему проверка по ХОСТУ, а не по точному адресу, и почему список шире, чем
# «пространства имён XML/SVG» из ТЗ: в сборку попадают литералы, которые никто
# не запрашивает, — ссылки в текстах ошибок библиотек (Dexie, ProseMirror),
# плейсхолдеры полей ввода. Запретить их = править чужие библиотеки; вместо
# этого каждое исключение перечислено ниже с причиной, и новый хост, не
# попавший в список, ломает сборку. Ограничение метода: он видит только
# ЛИТЕРАЛЫ. Адрес, склеенный в рантайме (`https://${host}/…`), статически не
# проверить — такие хосты приходят из настроенных пользователем/сборкой
# серверов, и отдельным шагом это ловится только вкладкой «Сеть» (§5 п.5).
#
# Хосты, подставляемые сборкой (BUILD_DEFAULT_RELAYS, BUILD_BOOTSTRAP_RELAYS,
# BUILD_DEFAULT_BLOSSOM_SERVERS, BUILD_DEFAULT_ICE_SERVERS), разрешены
# автоматически — это и есть «свой инстанс». Без них (локальная сборка) в dist
# лежат loopback-дефолты, они тоже разрешены.
#
# Без Node: скрипт может запускаться на хосте, где есть только coreutils.
set -euo pipefail

FILES=(dist/index.html dist/service-worker.js)
for f in "${FILES[@]}"; do
  if [ ! -f "$f" ]; then
    echo "check-dist-hosts: $f не существует" >&2
    exit 1
  fi
done

# Разрешённые хосты (точное совпадение) и причины.
ALLOWED_HOSTS=(
  # пространства имён, не сетевые адреса
  www.w3.org
  # loopback-дефолты локальной сборки и плейсхолдеры полей ввода
  127.0.0.1
  localhost
  blossom.example.com
  relay.example.com
  # ссылки в сообщениях об ошибках библиотек (Dexie: MissingAPI,
  # PrematureCommit) и ProseMirror — литералы в тексте, не запросы
  tinyurl.com
  bit.ly
  prosemirror.net
)

# Хосты из переменных сборки.
for var in BUILD_DEFAULT_RELAYS BUILD_BOOTSTRAP_RELAYS BUILD_DEFAULT_BLOSSOM_SERVERS BUILD_DEFAULT_ICE_SERVERS; do
  val="${!var:-}"
  [ -z "$val" ] && continue
  while IFS= read -r h; do
    [ -n "$h" ] && ALLOWED_HOSTS+=("$h")
  done < <(printf '%s' "$val" | grep -oE '(https?|wss?|stuns?|turns?s?):(//)?[A-Za-z0-9.-]+' | sed -E 's#^[a-z]+:(//)?##')
done

is_allowed() {
  local h="$1"
  # Хост, собираемый в рантайме (`${n}`), статически не проверяется — см. шапку.
  case "$h" in '$'*) return 0 ;; esac
  local a
  for a in "${ALLOWED_HOSTS[@]}"; do
    [ "$h" = "$a" ] && return 0
  done
  return 1
}

bad=0
for f in "${FILES[@]}"; do
  while IFS= read -r url; do
    host=$(printf '%s' "$url" | sed -E 's#^[a-zA-Z]+://##; s#^[^@/]*@##; s#[/:?\#].*$##')
    if ! is_allowed "$host"; then
      echo "check-dist-hosts: чужой хост '$host' в $f ($url)" >&2
      bad=1
    fi
  done < <(grep -oE '(https?|wss?)://[^"'"'"'` <>)\\,;]+' "$f" | sort -u)
done

if [ "$bad" -ne 0 ]; then
  echo "check-dist-hosts: клиент обязан ходить только в свой инстанс (GATEWAY-TZ-1.md §1)." >&2
  echo "Если адрес — безобидный литерал (текст ошибки, плейсхолдер), добавьте его хост в ALLOWED_HOSTS с причиной." >&2
  exit 1
fi
echo "check-dist-hosts: ok"
