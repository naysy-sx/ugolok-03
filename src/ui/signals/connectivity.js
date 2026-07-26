import { signal } from "@preact/signals";
import { checkBlossomReachable } from "../../core/transport/blossom-client.js";

// Пользователь (item 4) — статус Blossom-сервера в постоянной панели под
// главным меню. У Blossom, в отличие от relay (connState/synced, transport.js),
// нет живого соединения — только периодическая проверка достижимости.
export const blossomStatus = signal("checking"); // "checking" | "reachable" | "unreachable"

export async function refreshBlossomStatus(serverUrl) {
	if (!serverUrl) {
		blossomStatus.value = "unreachable";
		return;
	}
	blossomStatus.value = "checking";
	const ok = await checkBlossomReachable(serverUrl);
	blossomStatus.value = ok ? "reachable" : "unreachable";
}
