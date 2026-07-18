import { sign } from '../../core/crypto/sign.js';

export function buildRelayListEvent(privKey, relayUrls) {
  const eventTemplate = {
    kind: 10002,
    created_at: Math.floor(Date.now() / 1000),
    tags: relayUrls.map(url => ['r', url]),
    content: ''
  };
  return sign(eventTemplate, privKey);
}

export function parseRelayListEvent(event) {
  return event.tags.filter(tag => tag[0] === 'r').map(tag => tag[1]);
}
