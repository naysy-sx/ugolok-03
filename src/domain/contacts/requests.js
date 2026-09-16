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

// Этап 46 — раздел "Обзор": отправитель отзывает ещё НЕ принятую заявку (DESIGN.md,
// переход pending--CANCEL(A)-->none). Минимальный шаблон, тот же приём, что
// CONTACT_ACCEPTED_KIND — смысл несёт rumor.pubkey после unwrap, не content.
export const ACQUAINT_CANCELLED_KIND = 3005;

export function buildAcquaintCancelledRumor() {
  return { kind: ACQUAINT_CANCELLED_KIND, content: '', tags: [], created_at: Math.floor(Date.now() / 1000) };
}

// Этап 49 (CONTACTS-FSM.md §3) — раньше отказа не существовало как сигнала вовсе
// (rejectContactRequestAction молча блокировала локально, отправитель никогда не
// узнавал). PUBLISH_REJECT (contact-fsm.js) требует именно эту команду. Тот же
// минимальный приём, что CONTACT_ACCEPTED_KIND/ACQUAINT_CANCELLED_KIND.
export const CONTACT_REJECTED_KIND = 3006;

export function buildContactRejectedRumor() {
  return { kind: CONTACT_REJECTED_KIND, content: '', tags: [], created_at: Math.floor(Date.now() / 1000) };
}

// Этап 4 (MESSAGE-DELIVERY-TZ.md, вариант A) — "сигнал открой переписку":
// не-коммиттер (проигравший И3, chat.js's doEnsureChatEstablished) не имеет
// способа сообщить об этом на проводе — раньше единственный триггер для
// коммиттера был "сам напишет" (минуты/часы/никогда, если человек не заходит).
// Пустой rumor — смысл несёт rumor.pubkey после unwrap (это и есть
// не-коммиттер, который хочет начать разговор), тот же минимальный приём,
// что CONTACT_ACCEPTED_KIND/ACQUAINT_CANCELLED_KIND/CONTACT_REJECTED_KIND.
// 3012, НЕ 3007 (буквальное предложение брифа TZ) — 3007 уже занят ДВАЖДЫ
// (CHANNEL_UNVIEW_KIND, content/channel-access.js; KIND_FILES_OP_LEGACY,
// files/sync.js) — автор ТЗ прямо предупреждал, что код не читал.
export const CHAT_OPEN_REQUEST_KIND = 3012;

export function buildChatOpenRequestRumor() {
  return { kind: CHAT_OPEN_REQUEST_KIND, content: '', tags: [], created_at: Math.floor(Date.now() / 1000) };
}
