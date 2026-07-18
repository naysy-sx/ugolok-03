import { sign } from '../../core/crypto/sign.js';
import { getPublicKey } from '../../core/crypto/keys.js';
import { encrypt as nip44Encrypt, decrypt as nip44Decrypt } from '../../core/crypto/nip44.js';
import { bytesToHex } from '@noble/hashes/utils.js';
import { db } from '../../core/store/database.js';
import { transitionMessage } from './machine.js';

export function buildReadStatusEvent(privKey, { chatId, lastReadLamportTs }, createdAt = Math.floor(Date.now()/1000)) {
  const ownPubHex = bytesToHex(getPublicKey(privKey));
  const plaintext = JSON.stringify({lastReadLamportTs});
  const content = nip44Encrypt(plaintext, privKey, ownPubHex);
  const eventTemplate = { kind: 30070, tags: [['d', chatId]], content, created_at: createdAt };
  return sign(eventTemplate, privKey);
}

export function parseReadStatusEvent(event, privKey) {
  const ownPubHex = bytesToHex(getPublicKey(privKey));
  const plaintext = nip44Decrypt(event.content, privKey, event.pubkey || ownPubHex);
  const parsed = JSON.parse(plaintext);
  const chatId = event.tags.find(tag => tag[0] === 'd')[1];
  return { chatId, lastReadLamportTs: parsed.lastReadLamportTs };
}

// ownerPubkey (owner-scoping, db.version(4)) берётся из event.pubkey — read-status
// ВСЕГДА self-signed ("я прочитал"), отдельный параметр не нужен, не домысел.
export async function foldReadStatus(event, privKey) {
  const ownerPubkey = event.pubkey;
  const { chatId, lastReadLamportTs } = parseReadStatusEvent(event, privKey);
  let existing = await db.table('chatSyncState').get([ownerPubkey, chatId]);
  if (existing && existing.lastReadLamportTs >= lastReadLamportTs) return;
  await db.table('chatSyncState').put({ ...existing, ownerPubkey, chatId, lastReadLamportTs });
  const rows = await db.table('messages').where('[ownerPubkey+chatId]').equals([ownerPubkey, chatId]).toArray();
  for (const row of rows) {
    if (row.senderPubkey === event.pubkey || row.lamportTs > lastReadLamportTs || row.status !== 'sent') continue;
    await db.table('messages').update(row.seq, { status: transitionMessage(row.status, 'READ') });
  }
}

export async function markChatAsRead(ownerPubkey, privKey, contactPubkey, lastReadLamportTs, publish) {
  const event = buildReadStatusEvent(privKey, { chatId: contactPubkey, lastReadLamportTs });
  const result = await publish(event);
  if (!result.ok) throw new Error(result.reason || 'relay отклонил публикацию');
  await foldReadStatus(event, privKey);
}

export async function getUnreadCount(ownerPubkey, contactPubkey) {
  const existing = await db.table('chatSyncState').get([ownerPubkey, contactPubkey]);
  const lastRead = existing?.lastReadLamportTs ?? 0;
  const rows = await db.table('messages').where('[ownerPubkey+chatId]').equals([ownerPubkey, contactPubkey]).toArray();
  return rows.filter(m => m.senderPubkey === contactPubkey && m.lamportTs > lastRead).length;
}
