export const CONTACT_REQUEST_KIND = 3001;

export function buildContactRequestRumor(greeting = '') {
  return { kind: CONTACT_REQUEST_KIND, content: greeting, tags: [], created_at: Math.floor(Date.now() / 1000) };
}

export function parseContactRequestRumor(rumor) {
  return { greeting: rumor.content, senderPubkey: rumor.pubkey, createdAt: rumor.created_at };
}

// Этап 34 — найденный пробел: acceptContactRequestAction (signals/contacts.js) просто
// добавляет отправителя в СВОЙ contact-list (kind 3), ничего не сообщая обратно. Без
// отдельного сигнала "запрос принят" (пункт мокапа настроек) технически необнаружим —
// rebuildContactsAndGroups сканирует только СВОИ kind-3 события, не чужие. Тот же
// gift-wrap приём, что CONTACT_REQUEST_KIND/CHANNEL_SUBSCRIBE_REQUEST_KIND (3001/3002).
export const CONTACT_ACCEPTED_KIND = 3004;

export function buildContactAcceptedRumor() {
  return { kind: CONTACT_ACCEPTED_KIND, content: '', tags: [], created_at: Math.floor(Date.now() / 1000) };
}
