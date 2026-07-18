import { sign } from '../../core/crypto/sign.js';

export function buildProfileEvent(privKey, { name, about } = {}) {
  const eventTemplate = {
    kind: 0,
    created_at: Math.floor(Date.now() / 1000),
    tags: [],
    content: JSON.stringify({ name, about })
  };
  return sign(eventTemplate, privKey);
}

export function parseProfileEvent(event) {
  return JSON.parse(event.content);
}
