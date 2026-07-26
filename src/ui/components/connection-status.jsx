import { useEffect } from "preact/hooks";
import { connState, synced } from "../signals/transport.js";
import { blossomStatus, refreshBlossomStatus } from "../signals/connectivity.js";
import { BUILD_DEFAULT_RELAYS, BUILD_DEFAULT_BLOSSOM_SERVERS } from "../../config.js";

const RELAY_URL = BUILD_DEFAULT_RELAYS[0] ?? "ws://127.0.0.1:7777";
const BLOSSOM_URL = BUILD_DEFAULT_BLOSSOM_SERVERS[0];
const BLOSSOM_CHECK_INTERVAL_MS = 30000;

function relayStatusInfo(state, isSynced) {
	if (state === "disconnected") return { label: "офлайн", tone: "bad" };
	if (state === "connecting" || state === "authenticating") return { label: "подключение…", tone: "warn" };
	if ((state === "connected" || state === "subscribed") && !isSynced) return { label: "синхронизация…", tone: "warn" };
	if ((state === "connected" || state === "subscribed") && isSynced) return { label: "на связи", tone: "ok" };
	return { label: state, tone: "warn" };
}

const BLOSSOM_LABELS = {
	checking: { label: "проверка…", tone: "warn" },
	reachable: { label: "доступен", tone: "ok" },
	unreachable: { label: "недоступен", tone: "bad" },
};

// Пользователь (item 4) — постоянная панель статуса соединения под главным
// меню (не только на "Контактах"/"Сообщениях" как раньше — везде разом).
// Relay — уже отслеживаемое живое состояние (connState/synced, transport.js);
// Blossom — своей живой подписки нет (обычный HTTP, не WebSocket), поэтому
// периодическая проверка достижимости (checkBlossomReachable) раз в 30с.
export default function ConnectionStatusPanel() {
	useEffect(() => {
		refreshBlossomStatus(BLOSSOM_URL);
		const id = setInterval(() => refreshBlossomStatus(BLOSSOM_URL), BLOSSOM_CHECK_INTERVAL_MS);
		return () => clearInterval(id);
	}, []);

	const relay = relayStatusInfo(connState.value, synced.value);
	const blossom = BLOSSOM_LABELS[blossomStatus.value];

	return (
		<div class="connection-status-panel" aria-label="Статус соединения">
			<p>
				Relay: <span class={`status-${relay.tone}`}>{relay.label}</span>
				<small> {RELAY_URL}</small>
			</p>
			{BLOSSOM_URL && (
				<p>
					Blossom: <span class={`status-${blossom.tone}`}>{blossom.label}</span>
					<small> {BLOSSOM_URL}</small>
				</p>
			)}
		</div>
	);
}
