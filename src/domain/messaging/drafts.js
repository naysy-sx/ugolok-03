import { sign } from '../../core/crypto/sign.js';
import { getPublicKey } from '../../core/crypto/keys.js';
import { encrypt as nip44Encrypt, decrypt as nip44Decrypt } from '../../core/crypto/nip44.js';
import { bytesToHex } from '@noble/hashes/utils.js';
import { db } from '../../core/store/database.js';

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
export async function foldDraft(event, privKey) {
  const ownerPubkey = event.pubkey;
  const { chatId, text } = parseDraftEvent(event, privKey);
  let existing = await db.table('chatSyncState').get([ownerPubkey, chatId]);
  await db.table('chatSyncState').put({ ...existing, ownerPubkey, chatId, draftText: text, draftUpdatedAt: event.created_at });
}

export async function saveDraft(ownerPubkey, privKey, contactPubkey, text, publish) {
  const event = buildDraftEvent(privKey, { chatId: contactPubkey, text });
  const result = await publish(event);
  if (!result.ok) {
    throw new Error(result.reason || 'relay отклонил публикацию');
  } else {
    await foldDraft(event, privKey);
  }
}

export async function getDraft(ownerPubkey, contactPubkey) {
  const row = await db.table('chatSyncState').get([ownerPubkey, contactPubkey]);
  return row?.draftText ?? '';
}
