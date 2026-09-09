// Тёплый unlock той же вкладки (TZ-FOLLOWUP-DECISIONS §2).
// На экране пароля нет privKey (teardown остаётся). Это reuse локального
// Dexie/lastSeen, не reuse сокета.

export function shouldSkipColdBootstrap(lastSessionPubkey, pubkeyHex, lastSeen) {
	return (
		typeof lastSessionPubkey === "string" &&
		lastSessionPubkey === pubkeyHex &&
		Number.isFinite(lastSeen) &&
		lastSeen > 0
	);
}
