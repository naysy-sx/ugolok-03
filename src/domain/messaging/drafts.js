import { sign } from '../../core/crypto/sign.js';
import { getPublicKey } from '../../core/crypto/keys.js';
import { encrypt as nip44Encrypt, decrypt as nip44Decrypt } from '../../core/crypto/nip44.js';
import { bytesToHex } from '@noble/hashes/utils.js';
import { db } from '../../core/store/database.js';
import { toEncryptedRow, fromEncryptedRow } from '../../core/store/encrypted-table.js';
import { CHAT_SYNC_STATE_PLAINTEXT_FIELDS } from '../../core/store/table-fields.js';

export function buildDraftEvent(privKey, { chatId, text }, createdAt = Math.floor(Date.now() / 1000)) {
  const ownPubHex = bytesToHex(getPublicKey(privKey));
  const plaintext = JSON.stringify({ text });
  const content =nip44Encrypt(plaintext, privKey, ownPubHex);
  const eventTemplate = { kind: 30071, tags: [['d', chatId]], content, created_at: createdAt };
  return sign(eventTemplate, privKey);
}

export function parseDraftEvent(event, privKey) {
  const ownPubHex = bytesToHex(getPublicKey(privKey));
  const plaintext = nip44Decrypt(event.content, privKey, event.pubkey || ownPubHex);
  const parsed = JSON.parse(plaintext);
  const chatId = event.tags.find(tag => tag[0] === 'd')[1];
  return { chatId, text: parsed.text };
}

// ownerPubkey (owner-scoping, db.version(4)) — из event.pubkey, draft ВСЕГДА self-signed.
// draftText/draftUpdatedAt — sensitive (CONTRACTS.md, Tier 3) — decrypt-merge-encrypt,
// тот же класс находки, что messages/posts/channels на этапах 39-40: голый {...existing}
// на СЫРОЙ (уже зашифрованной) строке либо потерял бы nonce/ciphertext (если existing
// undefined на первой записи — строка осталась бы вовсе не зашифрованной), либо не
// добавил бы draftText в ciphertext.
export async function foldDraft(event, privKey, dbKey) {
  const ownerPubkey = event.pubkey;
  const { chatId, text } = parseDraftEvent(event, privKey);
  const raw = await db.table('chatSyncState').get([ownerPubkey, chatId]);
  const merged = { ...(raw ? fromEncryptedRow(raw, dbKey) : {}), ownerPubkey, chatId, draftText: text, draftUpdatedAt: event.created_at };
  await db.table('chatSyncState').put(toEncryptedRow(merged, CHAT_SYNC_STATE_PLAINTEXT_FIELDS, dbKey));
}

export async function saveDraft(ownerPubkey, privKey, dbKey, contactPubkey, text, publish) {
  const event = buildDraftEvent(privKey, { chatId: contactPubkey, text });
  const result = await publish(event);
  if (!result.ok) {
    throw new Error(result.reason || 'relay отклонил публикацию');
  } else {
    await foldDraft(event, privKey, dbKey);
  }
}

export async function getDraft(ownerPubkey, dbKey, contactPubkey) {
  const raw = await db.table('chatSyncState').get([ownerPubkey, contactPubkey]);
  if (!raw) return '';
  return fromEncryptedRow(raw, dbKey).draftText ?? '';
}
