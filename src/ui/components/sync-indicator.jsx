import { t } from "../signals/i18n.js";

function label(state, synced) {
	if (state === "disconnected") return t("connectionStatus.offline");
	if (state === "connecting" || state === "authenticating") return t("connectionStatus.connecting");
	if ((state === "connected" || state === "subscribed") && !synced) return t("connectionStatus.syncing");
	if ((state === "connected" || state === "subscribed") && synced) return t("connectionStatus.connected");
	return state;
}

export default function SyncIndicator({ state, synced, url }) {
	return (
		<span role="status">
			{label(state, synced)}
			{url && (
				<small style={{ color: "var(--muted)" }}> ({url})</small>
			)}
		</span>
	);
}
