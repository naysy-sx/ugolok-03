function label(state, synced) {
	if (state === "disconnected") return "офлайн";
	if (state === "connecting" || state === "authenticating") return "подключение…";
	if ((state === "connected" || state === "subscribed") && !synced) return "синхронизация…";
	if ((state === "connected" || state === "subscribed") && synced) return "на связи";
	return state;
}

export default function SyncIndicator({ state, synced }) {
	return <span role="status">{label(state, synced)}</span>;
}
