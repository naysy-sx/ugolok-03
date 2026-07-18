import { sign } from '../../core/crypto/sign.js';

export function buildContactListEvent(privKey, pubkeys, createdAt = Math.floor(Date.now() / 1000)) {
  const eventTemplate = {
    kind: 3,
    tags: pubkeys.map(pk => ['p', pk]),
    content: '',
    created_at: createdAt
  };
  return sign(eventTemplate, privKey);
}

export function parseContactListEvent(event) {
  return event.tags.filter(t => t[0] === 'p').map(t => t[1]);
}

export function addContact(pubkeys, newPubkey) {
  if (!pubkeys.includes(newPubkey)) {
    return [...pubkeys, newPubkey];
  }
  return pubkeys.slice();
}

export function removeContact(pubkeys, pubkeyToRemove) {
  const index = pubkeys.indexOf(pubkeyToRemove);
  if (index !== -1) {
    return pubkeys.filter((_, i) => i !== index);
  }
  return pubkeys.slice();
}

export function buildMuteListEvent(privKey, pubkeys, createdAt = Math.floor(Date.now() / 1000)) {
  const eventTemplate = {
    kind: 10000,
    tags: pubkeys.map(pk => ['p', pk]),
    content: '',
    created_at: createdAt
  };
  return sign(eventTemplate, privKey);
}

export function parseMuteListEvent(event) {
  return event.tags.filter(t => t[0] === 'p').map(t => t[1]);
}

export function isBlocked(blockedPubkeys, pubkey) {
  return blockedPubkeys.includes(pubkey);
}
