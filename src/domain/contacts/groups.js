import { sign } from '../../core/crypto/sign.js';
import { getPublicKey } from '../../core/crypto/keys.js';
import { encrypt as nip44Encrypt, decrypt as nip44Decrypt } from '../../core/crypto/nip44.js';
import { bytesToHex } from '@noble/hashes/utils.js';

export function buildGroupEvent(privKey, { groupId, name, memberPubkeys }, createdAt = Math.floor(Date.now() / 1000)) {
  const ownPubHex = bytesToHex(getPublicKey(privKey));
  const plaintext = JSON.stringify({ name, memberPubkeys });
  const content = nip44Encrypt(plaintext, privKey, ownPubHex);
  const eventTemplate = { kind: 30050, tags: [['d', groupId]], content, created_at: createdAt };
  return sign(eventTemplate, privKey);
}

export function parseGroupEvent(event, privKey) {
  const ownPubHex = bytesToHex(getPublicKey(privKey));
  const plaintext = nip44Decrypt(event.content, privKey, event.pubkey || ownPubHex);
  const parsed = JSON.parse(plaintext);
  const groupId = event.tags.find(tag => tag[0] === 'd')[1];
  return { groupId, name: parsed.name, memberPubkeys: parsed.memberPubkeys };
}

export function addMember(group, pubkey) {
  const newMemberPubkeys = [...group.memberPubkeys];
  if (!newMemberPubkeys.includes(pubkey)) {
    newMemberPubkeys.push(pubkey);
  }
  return { ...group, memberPubkeys: newMemberPubkeys };
}

export function removeMember(group, pubkey) {
  const memberPubkeys = group.memberPubkeys.filter(pk => pk !== pubkey);
  return { ...group, memberPubkeys };
}

export function renameGroup(group, newName) {
  return { ...group, name: newName };
}
