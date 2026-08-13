// Rooms, этап 2 — эфемерная identity гостя. Контракт: PROCESS-DOCS/CONTRACTS.md
// "Rooms — Этап 2" (room-identity.js); ROOMS-SPEC.md §4.1.
//
// Ничего не пишет в Dexie, не создаёт keystore, не вызывает login() — И7
// (гостевая identity не персистится) обеспечивается отсутствием побочных
// эффектов, а не отдельной чисткой при закрытии вкладки.
import { generateSecretKey, getPublicKey } from "nostr-tools/pure";

export function createEphemeralIdentity() {
	const privKey = generateSecretKey();
	const pubkeyHex = getPublicKey(privKey);
	return { pubkeyHex, privKey, dbKey: null };
}
