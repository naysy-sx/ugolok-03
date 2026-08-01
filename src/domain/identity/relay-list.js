import { sign } from '../../core/crypto/sign.js';

// Этап 59 — relayEntries: {url,read,write}[] (форма этапа 58), отображается
// в NIP-65 read/write маркеры. Запись без read И без write пропускается
// целиком — у NIP-65 нет маркера "отключено", публиковать её значило бы
// соврать читателю, что relay доступен и на чтение, и на запись.
function relayEntryToTag({ url, read, write }) {
  if (read && write) return ['r', url];
  if (read) return ['r', url, 'read'];
  return ['r', url, 'write'];
}

export function buildRelayListEvent(privKey, relayEntries) {
  const eventTemplate = {
    kind: 10002,
    created_at: Math.floor(Date.now() / 1000),
    tags: relayEntries.filter(({ read, write }) => read || write).map(relayEntryToTag),
    content: ''
  };
  return sign(eventTemplate, privKey);
}

export function parseRelayListEvent(event) {
  return event.tags
    .filter(tag => tag[0] === 'r')
    .map(([, url, marker]) => ({ url, read: marker !== 'write', write: marker !== 'read' }));
}
