import { signal } from "@preact/signals";
import { db } from "../../core/store/database.js";
import { contacts } from "./contacts.js";

export const discoveryProfiles = signal([]); // [{pubkey, visible, showChannels, channels, updatedAt}]

// Отфильтровано: только visible===true И НЕ уже в contacts (DESIGN.md, этап 46 —
// человек, уже добавленный в контакты, не нуждается в повторном "знакомстве").
export async function refreshDiscoveryProfiles(ownerPubkey) {
	const rows = await db.table("discoveryProfiles").toArray();
	discoveryProfiles.value = rows.filter((r) => r.visible && !contacts.value.includes(r.pubkey));
}

// Этап 49 (CONTACTS-FSM.md — полная унификация) — раньше "Обзор" вёл СОБСТВЕННУЮ
// таблицу outgoingAcquaintanceRequests и НЕ добавлял адресата оптимистично (в
// отличие от формы "Добавить контакт", contacts.js), что было ИСТОЧНИКОМ найденного
// пользователем бага (два независимых механизма для одного и того же "я отправил
// заявку"). Оба пути теперь — sendContactRequestAction/cancelContactRequestAction/
// outgoingRequests из signals/contacts.js, единая contactRelationships. Отдельных
// экспортов здесь больше нет — discovery.jsx импортирует их напрямую оттуда.
