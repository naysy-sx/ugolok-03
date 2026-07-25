import { sign } from '../../core/crypto/sign.js';
import { getPublicKey } from '../../core/crypto/keys.js';
import { encrypt as nip44Encrypt, decrypt as nip44Decrypt } from '../../core/crypto/nip44.js';
import { bytesToHex } from '@noble/hashes/utils.js';
import { db } from '../../core/store/database.js';
import { transitionMessage } from './machine.js';
import { pickLatest } from '../../core/sync/lww.js';
import { toEncryptedRow, fromEncryptedRow } from '../../core/store/encrypted-table.js';
import { CHAT_SYNC_STATE_PLAINTEXT_FIELDS } from '../../core/store/table-fields.js';

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
export async function foldReadStatus(event, privKey, dbKey) {
  const ownerPubkey = event.pubkey;
  const { chatId, lastReadLamportTs } = parseReadStatusEvent(event, privKey);
  const raw = await db.table('chatSyncState').get([ownerPubkey, chatId]);
  // lastReadLamportTs — plaintext (CONTRACTS.md, Tier 3), проверка LWW работает на
  // сырой строке без расшифровки.
  if (raw && raw.lastReadLamportTs >= lastReadLamportTs) return;
  // decrypt-merge-encrypt (тот же класс находки, что drafts.js/foldDraft) — гарантирует,
  // что строка ВСЕГДА несёт nonce/ciphertext, даже если это первая запись для чата.
  const merged = { ...(raw ? fromEncryptedRow(raw, dbKey) : {}), ownerPubkey, chatId, lastReadLamportTs };
  await db.table('chatSyncState').put(toEncryptedRow(merged, CHAT_SYNC_STATE_PLAINTEXT_FIELDS, dbKey));
  const rows = await db.table('messages').where('[ownerPubkey+chatId]').equals([ownerPubkey, chatId]).toArray();
  for (const row of rows) {
    if (row.senderPubkey === event.pubkey || row.lamportTs > lastReadLamportTs || row.status !== 'sent') continue;
    await db.table('messages').update(row.seq, { status: transitionMessage(row.status, 'READ') });
  }
}

export async function markChatAsRead(ownerPubkey, privKey, dbKey, contactPubkey, lastReadLamportTs, publish) {
  const event = buildReadStatusEvent(privKey, { chatId: contactPubkey, lastReadLamportTs });
  const result = await publish(event);
  if (!result.ok) throw new Error(result.reason || 'relay отклонил публикацию');
  await foldReadStatus(event, privKey, dbKey);
}

// AC-06 (TECH.md §15) — тот же паттерн, что rebuildUiSettings (этап 34): читает
// уже накопленный локальный кэш bootstrap'а (широкий REQ authors:[me], без
// ограничения по kind — см. bootstrap.js) вместо сети напрямую. До этой функции
// foldReadStatus вызывалась ТОЛЬКО из markChatAsRead на устройстве-публикаторе —
// другое устройство той же identity никогда не читало чужой (или даже свой же
// с другого сеанса) kind 30070 обратно. Группировка по chatId (d-tag) обязательна:
// read-status у РАЗНЫХ чатов независим, брать глобально самый свежий event
// (как lww.js's pickLatest без группировки) стёрло бы все чаты, кроме одного.
export async function rebuildReadStatus(ownerPubkey, privKey, dbKey) {
  const events = await db.table('events').where('[pubkey+kind]').equals([ownerPubkey, 30070]).toArray();
  const byChatId = new Map();
  for (const event of events) {
    const dTag = event.tags.find((t) => t[0] === 'd')?.[1];
    if (!dTag) continue;
    const group = byChatId.get(dTag) ?? [];
    group.push(event);
    byChatId.set(dTag, group);
  }
  for (const group of byChatId.values()) {
    await foldReadStatus(pickLatest(group), privKey, dbKey);
  }
}

export async function getUnreadCount(ownerPubkey, contactPubkey) {
  const existing = await db.table('chatSyncState').get([ownerPubkey, contactPubkey]);
  const lastRead = existing?.lastReadLamportTs ?? 0;
  const rows = await db.table('messages').where('[ownerPubkey+chatId]').equals([ownerPubkey, contactPubkey]).toArray();
  return rows.filter(m => m.senderPubkey === contactPubkey && m.lamportTs > lastRead).length;
}

// Этап 50 (CONTACTS-FSM.md §6, приложение А — инвариант N1). rebuildReadStatus
// (выше) уже подтягивает курсор с ДРУГИХ устройств/сессий ДО того, как могут
// сработать уведомления redelivery-потока (вызывается в начале connect(), см.
// transport.js) — поэтому сравнение с ЭТИМ курсором корректно гасит уведомление
// о сообщении, уже прочитанном где угодно, а не только в этой сессии.
export async function isChatContentRead(ownerPubkey, contactPubkey, lamportTs) {
  const row = await db.table('chatSyncState').get([ownerPubkey, contactPubkey]);
  return lamportTs <= (row?.lastReadLamportTs ?? 0);
}
