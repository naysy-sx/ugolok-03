import { useEffect } from "preact/hooks";
import { connState, synced } from "../signals/transport.js";
import { blossomStatus, refreshBlossomStatus } from "../signals/connectivity.js";
import { BUILD_DEFAULT_RELAYS, BUILD_DEFAULT_BLOSSOM_SERVERS } from "../../config.js";
import { t } from "../signals/i18n.js";

const RELAY_URL = BUILD_DEFAULT_RELAYS[0] ?? "ws://127.0.0.1:7777";
const BLOSSOM_URL = BUILD_DEFAULT_BLOSSOM_SERVERS[0];
const BLOSSOM_CHECK_INTERVAL_MS = 30000;

function relayStatusInfo(state, isSynced) {
	if (state === "disconnected") return { labelKey: "connectionStatus.offline", tone: "bad" };
	if (state === "connecting" || state === "authenticating") return { labelKey: "connectionStatus.connecting", tone: "warn" };
	if ((state === "connected" || state === "subscribed") && !isSynced) return { labelKey: "connectionStatus.syncing", tone: "warn" };
	if ((state === "connected" || state === "subscribed") && isSynced) return { labelKey: "connectionStatus.connected", tone: "ok" };
	return { label: state, tone: "warn" };
}

const BLOSSOM_LABEL_KEYS = {
	checking: { labelKey: "connectionStatus.checking", tone: "warn" },
	reachable: { labelKey: "connectionStatus.reachable", tone: "ok" },
	unreachable: { labelKey: "connectionStatus.unreachable", tone: "bad" },
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
	const blossom = BLOSSOM_LABEL_KEYS[blossomStatus.value];

	return (
		<div class="connection-status-panel stack" style={{ "--gap": "var(--space-3xs)" }} aria-label={t("connectionStatus.panelAria")}>
			<p>
				Relay: <span class={`status-${relay.tone}`}>{relay.labelKey ? t(relay.labelKey) : relay.label}</span>
				<small> {RELAY_URL}</small>
			</p>
			{BLOSSOM_URL && (
				<p>
					Blossom: <span class={`status-${blossom.tone}`}>{t(blossom.labelKey)}</span>
					<small> {BLOSSOM_URL}</small>
				</p>
			)}
		</div>
	);
}
