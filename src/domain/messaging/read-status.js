import { sign } from '../../core/crypto/sign.js';
import { getPublicKey } from '../../core/crypto/keys.js';
import { encrypt as nip44Encrypt, decrypt as nip44Decrypt } from '../../core/crypto/nip44.js';
import { bytesToHex } from '@noble/hashes/utils.js';
import { db } from '../../core/store/database.js';
import { transitionMessage } from './machine.js';
import { pickLatest } from '../../core/sync/lww.js';
import { toEncryptedRow, fromEncryptedRow } from '../../core/store/encrypted-table.js';
import { CHAT_SYNC_STATE_PLAINTEXT_FIELDS } from '../../core/store/table-fields.js';
import { DomainError } from '../errors.js';
import { deriveMasterSecret, opaqueDTag } from '../../core/crypto/derivation.js';

export const READ_STATUS_KIND = 30070;

// AUDIT-EGOROD J1: d-тег раньше нёс pubkey собеседника открытым текстом — relay
// видел, с кем у пользователя есть переписка и когда её открывали. Теперь d —
// opaqueDTag (HMAC от мастер-секрета), а настоящий chatId едет ВНУТРИ шифртекста.
// Замена по (pubkey, kind, d) для relay работает как раньше: HMAC стабилен для
// одного чата.
export function readStatusDTag(privKey, chatId) {
  return opaqueDTag(deriveMasterSecret(privKey), READ_STATUS_KIND, chatId);
}

export function buildReadStatusEvent(privKey, { chatId, lastReadLamportTs }, createdAt = Math.floor(Date.now()/1000)) {
  const ownPubHex = bytesToHex(getPublicKey(privKey));
  const plaintext = JSON.stringify({lastReadLamportTs, chatId});
  const content = nip44Encrypt(plaintext, privKey, ownPubHex);
  const eventTemplate = { kind: READ_STATUS_KIND, tags: [['d', readStatusDTag(privKey, chatId)]], content, created_at: createdAt };
  return sign(eventTemplate, privKey);
}

export function parseReadStatusEvent(event, privKey) {
  const ownPubHex = bytesToHex(getPublicKey(privKey));
  const plaintext = nip44Decrypt(event.content, privKey, event.pubkey || ownPubHex);
  const parsed = JSON.parse(plaintext);
  // Старые события (до AUDIT-EGOROD J1) не несут chatId в content — он в d-теге.
  const chatId = parsed.chatId ?? event.tags.find(tag => tag[0] === 'd')[1];
  return { chatId, lastReadLamportTs: parsed.lastReadLamportTs, legacy: parsed.chatId === undefined };
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

// AUDIT-EGOROD C2: открытие чата больше не публикует событие, если курсор не
// продвинулся (раньше — новое подписанное событие на КАЖДОЕ открытие, то есть
// шум для relay и лишние метаданные). Локальный курсор применяется ДО
// публикации: оффлайн бейдж непрочитанного гасится, синхронизация с другими
// устройствами — best-effort (сбой публикации бросается вызывающему, как раньше,
// но локальное состояние уже верное).
export async function markChatAsRead(ownerPubkey, privKey, dbKey, contactPubkey, lastReadLamportTs, publish) {
  const existing = await db.table('chatSyncState').get([ownerPubkey, contactPubkey]);
  if (existing && existing.lastReadLamportTs >= lastReadLamportTs) return;
  const event = buildReadStatusEvent(privKey, { chatId: contactPubkey, lastReadLamportTs });
  await foldReadStatus(event, privKey, dbKey);
  const result = await publish(event);
  if (!result.ok) {
    if (result.reason) throw new Error(result.reason);
    throw new DomainError('relay отклонил публикацию', 'errors.relayRejected');
  }
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
  const events = await db.table('events').where('[pubkey+kind]').equals([ownerPubkey, READ_STATUS_KIND]).toArray();
  // Группируем по настоящему chatId (из шифртекста, для старых событий — из
  // d-тега): d-теги теперь непрозрачны, а старые и новые события одного чата
  // имеют разные d, но должны конкурировать между собой по LWW.
  const byChatId = new Map();
  for (const event of events) {
    let chatId;
    try {
      chatId = parseReadStatusEvent(event, privKey).chatId;
    } catch {
      continue;
    }
    const group = byChatId.get(chatId) ?? [];
    group.push(event);
    byChatId.set(chatId, group);
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
