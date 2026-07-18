import { db } from '../../core/store/database.js';
import { parseContactListEvent, parseMuteListEvent } from '../contacts/contacts.js';
import { parseGroupEvent } from '../contacts/groups.js';
import { sign } from '../../core/crypto/sign.js';
import { getPublicKey } from '../../core/crypto/keys.js';
import { encrypt as nip44Encrypt, decrypt as nip44Decrypt } from '../../core/crypto/nip44.js';
import { deriveMasterSecret, opaqueDTag } from '../../core/crypto/derivation.js';
import { bytesToHex } from '@noble/hashes/utils.js';
import { createPermissionRecord } from '../auth/permissions.js';
import { rebuildCache } from '../auth/engine.js';

export async function foldContactList(event) {
  const pubkeys = parseContactListEvent(event);
  await db.transaction('rw', db.contacts, async () => {
    await db.contacts.where('owner').equals(event.pubkey).delete();
    await db.contacts.bulkAdd(pubkeys.map(pk => ({ owner: event.pubkey, pubkey: pk })));
  });
}

export async function foldMuteList(event) {
  const pubkeys = parseMuteListEvent(event);
  await db.transaction('rw', db.blockedContacts, async () => {
    await db.blockedContacts.where('owner').equals(event.pubkey).delete();
    await db.blockedContacts.bulkAdd(pubkeys.map(pk => ({ owner: event.pubkey, pubkey: pk })));
  });
}

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

export async function foldGroup(event, privKey) {
  const { groupId, name, memberPubkeys } = parseGroupEvent(event, privKey);

  return db.transaction('rw', db.table('groups'), db.table('groupMembers'), async () => {
    await db.table('groups').put({ owner: event.pubkey, id: groupId, name });
    await db.table('groupMembers').where('groupId').equals(groupId).delete();
    await db.table('groupMembers').bulkAdd(memberPubkeys.map(pk => ({ groupId, pubkey: pk })));
  });
}

export function validateDeletion(deleteEvent, targetEvent) {
  return deleteEvent.kind === 5 && deleteEvent.pubkey === targetEvent.pubkey;
}
