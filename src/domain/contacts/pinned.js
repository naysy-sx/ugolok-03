import { sign } from "../../core/crypto/sign.js";
import { getPublicKey } from "../../core/crypto/keys.js";
import { encrypt as nip44Encrypt, decrypt as nip44Decrypt } from "../../core/crypto/nip44.js";
import { bytesToHex } from "@noble/hashes/utils.js";
import { db } from "../../core/store/database.js";
import { pickLatest } from "../../core/sync/lww.js";
import { toEncryptedRow, fromEncryptedRow } from "../../core/store/encrypted-table.js";
import { PINNED_PLAINTEXT_FIELDS } from "../../core/store/table-fields.js";

// Редизайн интерфейса, этап 6 (CONTRACTS.md) — закреплённое (каналы+люди),
// боковая панель. Личная настройка (НЕ публичная — синхронизация только
// между СВОИМИ устройствами), NIP-44 self-encrypt, тот же приём, что
// KIND_UI_SETTINGS (ui-settings.js). ОТДЕЛЬНЫЙ kind, не поле внутри
// uiSettings — см. обоснование в CONTRACTS.md ("Этап 6"): общее событие
// потеряло бы одну из двух конкурентных офлайн-правок при LWW-мёрдже.
export const PINNED_KIND = 30066;

const DEFAULT_PINNED = { channels: [], people: [] };

export function buildPinnedEvent(privKey, pinned, createdAt = Math.floor(Date.now() / 1000)) {
	const ownPubHex = bytesToHex(getPublicKey(privKey));
	const content = nip44Encrypt(JSON.stringify(pinned), privKey, ownPubHex);
	return sign({ kind: PINNED_KIND, content, tags: [["d", "pinned"]], created_at: createdAt }, privKey);
}

export function parsePinnedEvent(event, privKey) {
	const ownPubHex = bytesToHex(getPublicKey(privKey));
	const plaintext = nip44Decrypt(event.content, privKey, event.pubkey || ownPubHex);
	const parsed = JSON.parse(plaintext);
	return {
		channels: Array.isArray(parsed.channels) ? parsed.channels : [],
		people: Array.isArray(parsed.people) ? parsed.people : [],
	};
}

export async function loadPinned(ownerPubkey, dbKey) {
	const row = fromEncryptedRow(await db.table("pinned").get(ownerPubkey), dbKey);
	if (!row) return { ...DEFAULT_PINNED };
	return { channels: row.channels ?? [], people: row.people ?? [] };
}

// Локально — сразу (офлайн-first), публикация — best-effort, тот же принцип,
// что saveUiSettings.
export async function savePinned(ownerPubkey, privKey, dbKey, pinned, publish) {
	await db.table("pinned").put(toEncryptedRow({ ownerPubkey, ...pinned }, PINNED_PLAINTEXT_FIELDS, dbKey));
	try {
		await publish(buildPinnedEvent(privKey, pinned));
	} catch {
		// сеть недоступна/relay отклонил — уже сохранено локально, синхронизация
		// между СВОИМИ устройствами, не критичный путь.
	}
}

// Тот же паттерн, что rebuildUiSettings — событие уже приходит через
// существующий bootstrap-фильтр {authors:[я]}, нового REQ не нужно.
export async function rebuildPinned(ownerPubkey, privKey, dbKey) {
	const events = await db.table("events").where("[pubkey+kind]").equals([ownerPubkey, PINNED_KIND]).toArray();
	if (events.length === 0) return;
	const pinned = parsePinnedEvent(pickLatest(events), privKey);
	await db.table("pinned").put(toEncryptedRow({ ownerPubkey, ...pinned }, PINNED_PLAINTEXT_FIELDS, dbKey));
}

// Инвариант REDESIGN-SPEC.md, этап 6 — снятие пометки НЕ порождает событие
// удаления: pin/unpin читают текущий список, мутируют его в памяти,
// сохраняют ЦЕЛИКОМ через savePinned (замещаемое событие, relay сам держит
// только последнюю версию — NIP-09 kind:5 не нужен и не создаётся).

export async function pinChannel(ownerPubkey, privKey, dbKey, channelId, publish) {
	const pinned = await loadPinned(ownerPubkey, dbKey);
	if (pinned.channels.includes(channelId)) return; // идемпотентно
	await savePinned(ownerPubkey, privKey, dbKey, { ...pinned, channels: [...pinned.channels, channelId] }, publish);
}

export async function unpinChannel(ownerPubkey, privKey, dbKey, channelId, publish) {
	const pinned = await loadPinned(ownerPubkey, dbKey);
	await savePinned(ownerPubkey, privKey, dbKey, { ...pinned, channels: pinned.channels.filter((id) => id !== channelId) }, publish);
}

export async function pinPerson(ownerPubkey, privKey, dbKey, pubkey, publish) {
	const pinned = await loadPinned(ownerPubkey, dbKey);
	if (pinned.people.includes(pubkey)) return; // идемпотентно
	await savePinned(ownerPubkey, privKey, dbKey, { ...pinned, people: [...pinned.people, pubkey] }, publish);
}

export async function unpinPerson(ownerPubkey, privKey, dbKey, pubkey, publish) {
	const pinned = await loadPinned(ownerPubkey, dbKey);
	await savePinned(ownerPubkey, privKey, dbKey, { ...pinned, people: pinned.people.filter((p) => p !== pubkey) }, publish);
}
