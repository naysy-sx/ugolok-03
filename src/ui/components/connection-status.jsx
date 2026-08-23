import { useEffect } from "preact/hooks";
import { connState, synced } from "../signals/transport.js";
import { blossomStatus, refreshBlossomStatus } from "../signals/connectivity.js";
import { BUILD_DEFAULT_BLOSSOM_SERVERS } from "../../config.js";
import { t } from "../signals/i18n.js";

const BLOSSOM_URL = BUILD_DEFAULT_BLOSSOM_SERVERS[0];
const BLOSSOM_CHECK_INTERVAL_MS = 30000;
const TONE_RANK = { ok: 0, warn: 1, bad: 2 };

// Экспортирована (Этап 6, Rooms) — quick.jsx переиспользует ту же классификацию
// состояний relay-pool.js для своего НЕЗАВИСИМОГО транспортного клиента
// (ROOMS-SPEC §0), чтобы тексты/цвета индикатора не разъезжались между двумя
// независимыми соединениями приложения.
export function relayStatusInfo(state, isSynced) {
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

// SIDEBAR-SPEC.md §6 — тишина означает норму: пока оба транспорта в порядке,
// панель ничего не рисует. Полные адреса Relay/Blossom — на экране
// «Диагностика», здесь диагностика была бы шумом, а не окружающей
// информацией. Relay — уже отслеживаемое живое состояние (connState/synced,
// transport.js); Blossom — своей живой подписки нет (обычный HTTP, не
// WebSocket), поэтому периодическая проверка достижимости раз в 30с.
export default function ConnectionStatusPanel() {
	useEffect(() => {
		refreshBlossomStatus(BLOSSOM_URL);
		const id = setInterval(() => refreshBlossomStatus(BLOSSOM_URL), BLOSSOM_CHECK_INTERVAL_MS);
		return () => clearInterval(id);
	}, []);

	const relay = relayStatusInfo(connState.value, synced.value);
	const blossom = BLOSSOM_LABEL_KEYS[blossomStatus.value];

	if (relay.tone === "ok" && blossomStatus.value === "reachable") return null;

	// bad важнее warn (§6).
	const worst = TONE_RANK[blossom.tone] > TONE_RANK[relay.tone] ? blossom : relay;

	return (
		<div class="conn bar" style={{ "--gap": "var(--space-2xs)", alignItems: "center" }} aria-live="polite">
			<span class="conn-dot" aria-hidden="true" />
			{worst.labelKey ? t(worst.labelKey) : worst.label}
		</div>
	);
}
