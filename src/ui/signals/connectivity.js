import { signal } from "@preact/signals";
import { checkBlossomReachable } from "../../core/transport/blossom-client.js";

// Пользователь (item 4) — статус Blossom-сервера в постоянной панели под
// главным меню. У Blossom, в отличие от relay (connState/synced, transport.js),
// нет живого соединения — только периодическая проверка достижимости.
export const blossomStatus = signal("checking"); // "checking" | "reachable" | "unreachable"

// "checking" — только пока статус ещё не известен ВООБЩЕ (первый вызов
// после загрузки). Периодический повторный опрос (ConnectionStatusPanel,
// раз в 30с) НЕ должен на время запроса откатывать уже известный статус
// на "checking" — найдено пользователем: .pane__bottom на мгновение
// показывал/менял высоту каждые ~30с, потому что панель молчит только
// при tone==="ok"+"reachable", а промежуточный "checking" (tone="warn")
// делал её на долю секунды видимой.
export async function refreshBlossomStatus(serverUrl) {
	if (!serverUrl) {
		blossomStatus.value = "unreachable";
		return;
	}
	if (blossomStatus.value !== "reachable" && blossomStatus.value !== "unreachable") {
		blossomStatus.value = "checking";
	}
	const ok = await checkBlossomReachable(serverUrl);
	blossomStatus.value = ok ? "reachable" : "unreachable";
}
