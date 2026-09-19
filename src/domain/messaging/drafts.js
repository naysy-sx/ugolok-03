import { sign } from '../../core/crypto/sign.js';
import { getPublicKey } from '../../core/crypto/keys.js';
import { encrypt as nip44Encrypt, decrypt as nip44Decrypt } from '../../core/crypto/nip44.js';
import { bytesToHex } from '@noble/hashes/utils.js';
import { db } from '../../core/store/database.js';
import { toEncryptedRow, fromEncryptedRow } from '../../core/store/encrypted-table.js';
import { CHAT_SYNC_STATE_PLAINTEXT_FIELDS } from '../../core/store/table-fields.js';
import { DomainError } from '../errors.js';
import { deriveMasterSecret, opaqueDTag } from '../../core/crypto/derivation.js';

export const DRAFT_KIND = 30071;

// AUDIT-EGOROD J1 — см. read-status.js: d-тег непрозрачен, chatId внутри шифртекста.
export function draftDTag(privKey, chatId) {
  return opaqueDTag(deriveMasterSecret(privKey), DRAFT_KIND, chatId);
}

export function buildDraftEvent(privKey, { chatId, text }, createdAt = Math.floor(Date.now() / 1000)) {
  const ownPubHex = bytesToHex(getPublicKey(privKey));
  const plaintext = JSON.stringify({ text, chatId });
  const content =nip44Encrypt(plaintext, privKey, ownPubHex);
  const eventTemplate = { kind: DRAFT_KIND, tags: [['d', draftDTag(privKey, chatId)]], content, created_at: createdAt };
  return sign(eventTemplate, privKey);
}

export function parseDraftEvent(event, privKey) {
  const ownPubHex = bytesToHex(getPublicKey(privKey));
  const plaintext = nip44Decrypt(event.content, privKey, event.pubkey || ownPubHex);
  const parsed = JSON.parse(plaintext);
  const chatId = parsed.chatId ?? event.tags.find(tag => tag[0] === 'd')[1];
  return { chatId, text: parsed.text, legacy: parsed.chatId === undefined };
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
  const existing = raw ? fromEncryptedRow(raw, dbKey) : {};
  // LWW (AUDIT-EGOROD B2): запоздавшее старое событие не затирает более новый
  // черновик. Строго «старше»: два сохранения в одну секунду — последнее выигрывает.
  if (existing.draftUpdatedAt !== undefined && existing.draftUpdatedAt > event.created_at) return;
  const merged = { ...existing, ownerPubkey, chatId, draftText: text, draftUpdatedAt: event.created_at };
  await db.table('chatSyncState').put(toEncryptedRow(merged, CHAT_SYNC_STATE_PLAINTEXT_FIELDS, dbKey));
}

// AUDIT-EGOROD D2: локально — СРАЗУ (раньше черновик сохранялся только после
// подтверждения relay, оффлайн он пропадал). Публикация — для синхронизации
// между устройствами; отказ бросается вызывающему, как и раньше.
export async function saveDraft(ownerPubkey, privKey, dbKey, contactPubkey, text, publish) {
  const event = buildDraftEvent(privKey, { chatId: contactPubkey, text });
  await foldDraft(event, privKey, dbKey);
  const result = await publish(event);
  if (!result.ok) {
    if (result.reason) throw new Error(result.reason);
    throw new DomainError('relay отклонил публикацию', 'errors.relayRejected');
  }
}

export async function getDraft(ownerPubkey, dbKey, contactPubkey) {
  const raw = await db.table('chatSyncState').get([ownerPubkey, contactPubkey]);
  if (!raw) return '';
  return fromEncryptedRow(raw, dbKey).draftText ?? '';
}
