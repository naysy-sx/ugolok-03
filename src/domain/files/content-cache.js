// Перенесено из domain/attachments/cache.js (этап 53 И7, задача 7.4 — снятие
// фасада, DESIGN.md). Алгоритм вытеснения (LRU по объёму + TTL) НЕ меняется.
// Меняется только: (а) ключ — manifestDigest вместо старого sha256 целого
// зашифрованного блоба (та же по сути content-addressed адресация, просто
// адресует манифест поверх чанков, а не шифротекст целиком); (б) промах кеша
// читает через downloadMessageAttachment (content.js's getManifest+getRange)
// вместо старого downloadAttachment. Таблица IndexedDB `attachments` —
// СХЕМА НЕ МЕНЯЕТСЯ (колонка называется sha256 буквально, версия БД не
// бампуется) — хранит то же самое по форме, просто другого происхождения
// значение в той же колонке.
import { db } from "../../core/store/database.js";
import { chacha20poly1305 } from "@noble/ciphers/chacha.js";
import { downloadMessageAttachment } from "../messaging/attachments.js";

export const CACHE_BUDGET_BYTES = 200 * 1024 * 1024;
export const CACHE_TTL_MS = 30 * 24 * 60 * 60 * 1000;

export async function getCachedMessageAttachment(ownerPubkey, dbKey, manifestDigest) {
	const row = await db.table("attachments").get([ownerPubkey, manifestDigest]);
	if (!row) return undefined;

	const decrypted = chacha20poly1305(dbKey, row.nonce).decrypt(row.ciphertext);
	await db.table("attachments").update([ownerPubkey, manifestDigest], { lastAccessedAt: Date.now() });

	return decrypted;
}

export async function putCachedMessageAttachment(ownerPubkey, dbKey, manifestDigest, mime, bytes, options = {}) {
	const nonce = crypto.getRandomValues(new Uint8Array(12));
	const ciphertext = chacha20poly1305(dbKey, nonce).encrypt(bytes);
	await db.table("attachments").put({ ownerPubkey, sha256: manifestDigest, mime, size: bytes.length, lastAccessedAt: Date.now(), nonce, ciphertext });
	await evictIfNeeded(ownerPubkey, options);
}

export async function evictIfNeeded(ownerPubkey, { budgetBytes = CACHE_BUDGET_BYTES, ttlMs = CACHE_TTL_MS } = {}) {
	let rows = await db.table("attachments").where("ownerPubkey").equals(ownerPubkey).toArray();

	const now = Date.now();
	const expired = rows.filter((r) => now - r.lastAccessedAt > ttlMs);

	if (expired.length > 0) {
		await db.table("attachments").bulkDelete(expired.map((r) => [r.ownerPubkey, r.sha256]));
		rows = rows.filter((r) => !expired.includes(r));
	}

	let total = rows.reduce((sum, r) => sum + r.size, 0);

	if (total <= budgetBytes) return;

	rows.sort((a, b) => a.lastAccessedAt - b.lastAccessedAt);
	const toDelete = [];

	for (const r of rows) {
		if (total <= budgetBytes) break;
		toDelete.push(r);
		total -= r.size;
	}

	if (toDelete.length > 0) {
		await db.table("attachments").bulkDelete(toDelete.map((r) => [r.ownerPubkey, r.sha256]));
	}
}

export async function getOrDownloadMessageAttachment(ownerPubkey, dbKey, attachment, options = {}) {
	const cached = await getCachedMessageAttachment(ownerPubkey, dbKey, attachment.manifestDigest);
	if (cached !== undefined) return cached;

	const bytes = await downloadMessageAttachment(attachment, options);
	await putCachedMessageAttachment(ownerPubkey, dbKey, attachment.manifestDigest, attachment.mime, bytes, options);
	return bytes;
}
