// Кэш шифротекста крипто-чанков в Dexie files_blobs (TZ-ORIGIN-MEDIA слой C).
// Не plaintext: lock() не чистит. Wipe — account-deletion (таблица уже в списке).
import { db } from "../../core/store/database.js";

export const FILES_BLOBS_BUDGET_BYTES = 400 * 1024 * 1024;

let ownerPubkey = null;

export function setFilesBlobsOwner(pubkey) {
	ownerPubkey = pubkey || null;
}

export function getFilesBlobsOwner() {
	return ownerPubkey;
}

export async function getCachedCipherChunk(digest, chunkIndex) {
	if (!ownerPubkey) return undefined;
	const row = await db.table("files_blobs").get([ownerPubkey, digest, chunkIndex]);
	if (!row) return undefined;
	await db.table("files_blobs").update([ownerPubkey, digest, chunkIndex], { lastAccess: Date.now() });
	return row.ciphertext instanceof Uint8Array ? row.ciphertext : new Uint8Array(row.ciphertext);
}

export async function putCachedCipherChunk(digest, chunkIndex, ciphertext) {
	if (!ownerPubkey) return;
	const byteLength = ciphertext.length;
	if (byteLength > FILES_BLOBS_BUDGET_BYTES) return;
	const existing = await db.table("files_blobs").get([ownerPubkey, digest, chunkIndex]);
	if (existing) {
		await db.table("files_blobs").put({
			ownerPubkey,
			digest,
			chunkIndex,
			ciphertext,
			byteLength,
			lastAccess: Date.now(),
		});
		return;
	}
	await evictFilesBlobsIfNeeded(ownerPubkey, byteLength);
	const total = await sumOwnerBytes(ownerPubkey);
	if (total + byteLength > FILES_BLOBS_BUDGET_BYTES) return;
	await db.table("files_blobs").put({
		ownerPubkey,
		digest,
		chunkIndex,
		ciphertext,
		byteLength,
		lastAccess: Date.now(),
	});
}

export async function evictFilesBlobsIfNeeded(owner, incomingBytes = 0, budgetBytes = FILES_BLOBS_BUDGET_BYTES) {
	let rows = await db.table("files_blobs").where("ownerPubkey").equals(owner).toArray();
	let total = rows.reduce((sum, r) => sum + (r.byteLength || 0), 0);
	if (total + incomingBytes <= budgetBytes) return;
	rows.sort((a, b) => (a.lastAccess || 0) - (b.lastAccess || 0));
	const toDelete = [];
	for (const r of rows) {
		if (total + incomingBytes <= budgetBytes) break;
		toDelete.push([r.ownerPubkey, r.digest, r.chunkIndex]);
		total -= r.byteLength || 0;
	}
	if (toDelete.length > 0) await db.table("files_blobs").bulkDelete(toDelete);
}

async function sumOwnerBytes(owner) {
	const rows = await db.table("files_blobs").where("ownerPubkey").equals(owner).toArray();
	return rows.reduce((sum, r) => sum + (r.byteLength || 0), 0);
}
