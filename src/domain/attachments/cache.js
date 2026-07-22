import { db } from '../../core/store/database.js';
import { chacha20poly1305 } from '@noble/ciphers/chacha.js';
import { downloadAttachment } from './upload.js';

export const CACHE_BUDGET_BYTES = 200 * 1024 * 1024;
export const CACHE_TTL_MS = 30 * 24 * 60 * 60 * 1000;

export async function getCachedAttachment(ownerPubkey, dbKey, sha256Hex) {
  const row = await db.table('attachments').get([ownerPubkey, sha256Hex]);
  if (!row) return undefined;
  
  const decrypted = chacha20poly1305(dbKey, row.nonce).decrypt(row.ciphertext);
  await db.table('attachments').update([ownerPubkey, sha256Hex], { lastAccessedAt: Date.now() });
  
  return decrypted;
}

export async function putCachedAttachment(ownerPubkey, dbKey, sha256Hex, mime, bytes, options = {}) {
  const nonce = crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = chacha20poly1305(dbKey, nonce).encrypt(bytes);
  await db.table('attachments').put({ ownerPubkey, sha256: sha256Hex, mime, size: bytes.length, lastAccessedAt: Date.now(), nonce, ciphertext });
  await evictIfNeeded(ownerPubkey, options);
}

export async function evictIfNeeded(ownerPubkey, { budgetBytes = CACHE_BUDGET_BYTES, ttlMs = CACHE_TTL_MS } = {}) {
  let rows = await db.table('attachments').where('ownerPubkey').equals(ownerPubkey).toArray();
  
  const now = Date.now();
  const expired = rows.filter(r => now - r.lastAccessedAt > ttlMs);
  
  if (expired.length > 0) {
    await db.table('attachments').bulkDelete(expired.map(r => [r.ownerPubkey, r.sha256]));
    rows = rows.filter(r => !expired.includes(r));
  }
  
  let total = rows.reduce((sum, r) => sum + r.size, 0);
  
  if (total <= budgetBytes) return;
  
  rows.sort((a, b) => a.lastAccessedAt - b.lastAccessedAt);
  let toDelete = [];
  
  for (const r of rows) {
    if (total <= budgetBytes) break;
    toDelete.push(r);
    total -= r.size;
  }
  
  if (toDelete.length > 0) {
    await db.table('attachments').bulkDelete(toDelete.map(r => [r.ownerPubkey, r.sha256]));
  }
}

export async function getOrDownloadAttachment(ownerPubkey, dbKey, attachment, options = {}) {
  const cached = await getCachedAttachment(ownerPubkey, dbKey, attachment.sha256);
  if (cached !== undefined) return cached;
  
  const bytes = await downloadAttachment(attachment, options);
  await putCachedAttachment(ownerPubkey, dbKey, attachment.sha256, attachment.mime, bytes, options);
  return bytes;
}
