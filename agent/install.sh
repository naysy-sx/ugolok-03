#!/usr/bin/env bash
# Bootstrap self-hosted инстанса Уголка на чистом Ubuntu/Debian VPS —
# ставит недостающие зависимости (Docker, Go), собирает агента управления
# (Этап 63, И1-И3) и relay/Blossom из исходников, запускает всё через
# systemd. Запускается ИЗ ЧЕКАУТА репозитория (agent/install.sh) — тот же
# принцип, что server/strfry/setup.sh и server/blossom/setup.sh: скрипт не
# решает, КАК код Уголка попал на этот VPS (git clone/tarball/scp — отдельная
# задача дистрибуции, публичный канал ещё не выбран, см. CONTRACTS.md,
# "Этап 63, И4"), только что делать ПОСЛЕ того, как код уже здесь.
#
# Поддерживается ТОЛЬКО Ubuntu/Debian (apt) на amd64 — реальная целевая
# платформа (VPS пользователя). Идемпотентно: безопасно перезапускать,
# уже выполненные шаги пропускаются.
#
# Использование:
#   ./agent/install.sh
# Переменные окружения (все опциональны — интерактивный ввод, если не заданы):
#   RELAY_DOMAIN, BLOSSOM_DOMAIN, TURN_EXTERNAL_IP, HOST (адрес агента,
#   по умолчанию = TURN_EXTERNAL_IP), AGENT_PORT (по умолчанию 8443)
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")"
AGENT_DIR="$(pwd)"
COMPOSE_DIR="$AGENT_DIR/compose"
GO_VERSION="1.26.5"

log() { echo "[install.sh] $*"; }
die() { echo "[install.sh] ОШИБКА: $*" >&2; exit 1; }

# --- 1. Проверка ОС ---
if ! command -v apt-get >/dev/null 2>&1; then
	die "поддерживается только Ubuntu/Debian (apt-get не найден на этой машине)."
fi
if [ "$(uname -m)" != "x86_64" ]; then
	die "поддерживается только amd64 (нашёл $(uname -m)) — целевая платформа: VPS на x86_64."
fi
if [ "$(id -u)" -ne 0 ]; then
	die "запустите от root (sudo ./agent/install.sh) — нужны права на установку пакетов и systemd."
fi

# curl/git — сам скрипт (get.docker.com, git clone) на них полагается раньше,
# чем что-либо ещё проверяет; минимальные cloud-init образы не всегда несут
# оба пакета из коробки.
apt-get update -qq
apt-get install -y -qq curl git ca-certificates >/dev/null

# --- 2. Docker ---
if ! docker compose version >/dev/null 2>&1; then
	log "Docker (с compose plugin) не найден — устанавливаю через get.docker.com..."
	curl -fsSL https://get.docker.com | sh
	systemctl enable --now docker
else
	log "Docker уже установлен — пропускаю."
fi

# --- 3. Go ---
# go.mod агента (go 1.26.5) сам подтянет нужный toolchain при go build, если
# установленная версия старше, НО только начиная с Go 1.21 (механизм
# автопереключения тулчейна появился там) — apt-пакет Ubuntu/Debian часто
# старше. Поэтому ставим официальный тарбол напрямую, не полагаясь на apt.
if ! command -v go >/dev/null 2>&1; then
	log "Go не найден — устанавливаю ${GO_VERSION} с go.dev..."
	curl -fsSL "https://go.dev/dl/go${GO_VERSION}.linux-amd64.tar.gz" -o /tmp/go.tar.gz
	rm -rf /usr/local/go
	tar -C /usr/local -xzf /tmp/go.tar.gz
	rm -f /tmp/go.tar.gz
	ln -sf /usr/local/go/bin/go /usr/local/bin/go
	ln -sf /usr/local/go/bin/gofmt /usr/local/bin/gofmt
else
	log "Go уже установлен ($(go version)) — пропускаю (go.mod сам подтянет нужный toolchain при сборке)."
fi

# --- 4. Сборка агента ---
log "Собираю агент управления..."
(cd "$AGENT_DIR" && go build -o /usr/local/bin/ugolok-agent ./cmd/agent)

# --- 5. Клонирование relay-src/blossom-src ---
if [ ! -d "$COMPOSE_DIR/relay-src" ]; then
	log "Клонирую strfry (relay-src)..."
	git clone https://github.com/hoytech/strfry.git "$COMPOSE_DIR/relay-src"
	(cd "$COMPOSE_DIR/relay-src" && git submodule update --init)
else
	log "relay-src уже существует — пропускаю клонирование."
fi
if [ ! -d "$COMPOSE_DIR/blossom-src" ]; then
	log "Клонирую blossom-server (blossom-src)..."
	git clone https://github.com/sebdeveloper6952/blossom-server.git "$COMPOSE_DIR/blossom-src"
else
	log "blossom-src уже существует — пропускаю клонирование."
fi

# --- 6. Конфигурация ---
: "${RELAY_DOMAIN:=}"
: "${BLOSSOM_DOMAIN:=}"
: "${TURN_EXTERNAL_IP:=}"
: "${AGENT_PORT:=8443}"

if [ -z "$RELAY_DOMAIN" ]; then
	read -rp "Домен для relay (WSS, например relay.example.com): " RELAY_DOMAIN
fi
if [ -z "$BLOSSOM_DOMAIN" ]; then
	read -rp "Домен для Blossom (HTTPS, например files.example.com): " BLOSSOM_DOMAIN
fi
[ -n "$RELAY_DOMAIN" ] || die "RELAY_DOMAIN обязателен."
[ -n "$BLOSSOM_DOMAIN" ] || die "BLOSSOM_DOMAIN обязателен."

if [ -z "$TURN_EXTERNAL_IP" ]; then
	log "Определяю публичный IP этого VPS..."
	TURN_EXTERNAL_IP="$(curl -fsSL --max-time 5 ifconfig.me || true)"
	if [ -z "$TURN_EXTERNAL_IP" ]; then
		read -rp "Не удалось определить публичный IP автоматически — введите вручную: " TURN_EXTERNAL_IP
	else
		log "Публичный IP: $TURN_EXTERNAL_IP"
	fi
fi
[ -n "$TURN_EXTERNAL_IP" ] || die "TURN_EXTERNAL_IP обязателен (публичный IP этого VPS)."
HOST="${HOST:-$TURN_EXTERNAL_IP}"

# --- 7. systemd unit ---
log "Настраиваю systemd-сервис..."
cat > /etc/systemd/system/ugolok-agent.service << EOF
[Unit]
Description=Ugolok self-hosted agent
After=network-online.target docker.service
Wants=network-online.target
Requires=docker.service

[Service]
Type=simple
ExecStart=/usr/local/bin/ugolok-agent \\
	--state-dir=${AGENT_DIR}/state \\
	--port=${AGENT_PORT} \\
	--host=${HOST} \\
	--compose-dir=${COMPOSE_DIR} \\
	--relay-domain=${RELAY_DOMAIN} \\
	--blossom-domain=${BLOSSOM_DOMAIN} \\
	--turn-external-ip=${TURN_EXTERNAL_IP}
Restart=on-failure
RestartSec=5

[Install]
WantedBy=multi-user.target
EOF

systemctl daemon-reload
FIRST_START=1
if systemctl is-active --quiet ugolok-agent; then
	FIRST_START=0
fi
systemctl enable --now ugolok-agent

# --- 8. Пейринг-код ---
if [ "$FIRST_START" -eq 1 ]; then
	log "Жду запуск агента..."
	sleep 3
	log "=== Пейринг-код (см. также: journalctl -u ugolok-agent) ==="
	journalctl -u ugolok-agent --no-pager | grep -A1 "Пейринг-код" || log "Код не найден в логе — проверьте вручную: journalctl -u ugolok-agent"
else
	log "Агент уже был запущен ранее — пейринг-код показывается только при первом запуске (см. journalctl -u ugolok-agent, если нужно пересопряжение — потребуется удалить ${AGENT_DIR}/state/token.hex)."
fi

log "Готово. Статус: systemctl status ugolok-agent"
