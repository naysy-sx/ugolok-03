import { db } from '../../core/store/database.js';
import { parseGroupEvent } from '../contacts/groups.js';
import { sign } from '../../core/crypto/sign.js';
import { getPublicKey } from '../../core/crypto/keys.js';
import { encrypt as nip44Encrypt, decrypt as nip44Decrypt } from '../../core/crypto/nip44.js';
import { deriveMasterSecret, opaqueDTag } from '../../core/crypto/derivation.js';
import { bytesToHex } from '@noble/hashes/utils.js';
import { createPermissionRecord } from '../auth/permissions.js';
import { rebuildCache } from '../auth/engine.js';
import { lwwWinner, pickLatest } from '../../core/sync/lww.js';
import { toEncryptedRow } from '../../core/store/encrypted-table.js';
import { GROUPS_PLAINTEXT_FIELDS } from '../../core/store/table-fields.js';

export function buildPermissionEvent(privKey, { subject, resource, allowMask = 0, denyMask = 0, lamportTs }) {
  const ownPubHex = bytesToHex(getPublicKey(privKey));
  const masterSecret = deriveMasterSecret(privKey);
  const dTag = opaqueDTag(masterSecret, 5051, subject + ':' + resource);
  const plaintext = JSON.stringify({ subject, resource, allowMask, denyMask, lamportTs });
  const content = nip44Encrypt(plaintext, privKey, ownPubHex);
  const eventTemplate = { kind: 5051, tags: [['d', dTag]], content, created_at: Math.floor(Date.now()/1000) };
  return sign(eventTemplate, privKey);
}

export function parsePermissionEvent(event, privKey) {
  const ownPubHex = bytesToHex(getPublicKey(privKey));
  const plaintext = nip44Decrypt(event.content, privKey, event.pubkey || ownPubHex);
  const parsed = JSON.parse(plaintext);
  return { subject: parsed.subject, resource: parsed.resource, allowMask: parsed.allowMask, denyMask: parsed.denyMask, lamportTs: parsed.lamportTs };
}

export async function rebuildEffectivePermissions(ownerPubkey, privKey) {
  const events = await db.table('events').where('[pubkey+kind]').equals([ownerPubkey, 5051]).toArray();
  const records = events.map((event) => {
    const parsed = parsePermissionEvent(event, privKey);
    return createPermissionRecord({ ...parsed, eventId: event.id });
  });
  const cache = rebuildCache(records);

  return db.transaction('rw', db.table('effectivePerms'), async () => {
    await db.table('effectivePerms').where('owner').equals(ownerPubkey).delete();
    const rows = [];
    for (const [key, mask] of cache) {
      const [subject, resource] = JSON.parse(key);
      rows.push({ owner: ownerPubkey, subject, resource, mask });
    }
    await db.table('effectivePerms').bulkAdd(rows);
  });
}

export async function foldGroup(event, privKey, dbKey) {
  const { groupId, name, memberPubkeys } = parseGroupEvent(event, privKey);

  return db.transaction('rw', db.table('groups'), db.table('groupMembers'), async () => {
    await db.table('groups').put(toEncryptedRow({ owner: event.pubkey, id: groupId, name }, GROUPS_PLAINTEXT_FIELDS, dbKey));
    await db.table('groupMembers').where('groupId').equals(groupId).delete();
    await db.table('groupMembers').bulkAdd(memberPubkeys.map(pk => ({ groupId, pubkey: pk })));
  });
}

export function validateDeletion(deleteEvent, targetEvent) {
  return deleteEvent.kind === 5 && deleteEvent.pubkey === targetEvent.pubkey;
}

export function buildAddressableDeletionEvent(privKey, kind, dTag) {
  const ownPubHex = bytesToHex(getPublicKey(privKey));
  const eventTemplate = { kind: 5, tags: [['a', `${kind}:${ownPubHex}:${dTag}`]], content: '', created_at: Math.floor(Date.now() / 1000) };
  return sign(eventTemplate, privKey);
}

// Этап 49 — переименовано из rebuildContactsAndGroups: contacts/mute (kind
// 3/10000) больше не folds-ятся сюда напрямую (contacts/blockedContacts —
// legacy-таблицы, вытеснены contactRelationships), реконсиляция теперь идёт
// через reconcileContactsFromEventLog (ui/signals/contacts.js) на contact-fsm.js
// reconcileList, не через delete-all+bulkAdd. Эта функция — только группы (30050).
export async function rebuildGroups(ownerPubkey, privKey, dbKey) {
  const groupEvents = await db.table('events').where('[pubkey+kind]').equals([ownerPubkey, 30050]).toArray();
  const latestByDTag = new Map();
  for (const ev of groupEvents) {
    const dTag = ev.tags.find((t) => t[0] === 'd')?.[1];
    if (!dTag) continue;
    const existing = latestByDTag.get(dTag);
    latestByDTag.set(dTag, existing ? lwwWinner(existing, ev) : ev);
  }

  const deletionEvents = await db.table('events').where('[pubkey+kind]').equals([ownerPubkey, 5]).toArray();
  const deletedTargets = new Set();
  for (const del of deletionEvents) {
    for (const tag of del.tags) {
      if (tag[0] === 'a') deletedTargets.add(tag[1]);
    }
  }

  for (const [dTag, event] of latestByDTag) {
    const target = `30050:${ownerPubkey}:${dTag}`;
    if (deletedTargets.has(target)) {
      await db.transaction('rw', db.table('groups'), db.table('groupMembers'), async () => {
        await db.table('groups').delete([ownerPubkey, dTag]);
        await db.table('groupMembers').where('groupId').equals(dTag).delete();
      });
    } else {
      await foldGroup(event, privKey, dbKey);
    }
  }
}
