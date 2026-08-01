import { sign } from '../../core/crypto/sign.js';

// Этап 60 — NIP-17 "DM Relay List" (kind:10050, номер сверен по спеке, не
// угадан). Тег 'relay' (НЕ 'r', как у relay-list.js's kind:10002 — разные
// NIP). Без read/write маркеров: сам смысл события — "сюда мне присылайте",
// read-сторона получателя, роли различать нечего.
export function buildDmRelayListEvent(privKey, relayUrls) {
  const eventTemplate = {
    kind: 10050,
    created_at: Math.floor(Date.now() / 1000),
    tags: relayUrls.map(url => ['relay', url]),
    content: ''
  };
  return sign(eventTemplate, privKey);
}

export function parseDmRelayListEvent(event) {
  return event.tags.filter(tag => tag[0] === 'relay').map(tag => tag[1]);
}
