import { signal } from "@preact/signals";
import { db } from "../../core/store/database.js";
import { buildContactRequestRumor, buildAcquaintCancelledRumor } from "../../domain/contacts/requests.js";
import { wrap as nip59Wrap } from "../../core/crypto/nip59.js";
import { contacts } from "./contacts.js";

export const discoveryProfiles = signal([]); // [{pubkey, visible, showChannels, channels, updatedAt}]
export const outgoingRequests = signal([]); // [{owner, targetPubkey, createdAt}]

async function requirePublishOk(publish, event) {
	const result = await publish(event);
	if (!result.ok) {
		throw new Error(result.reason || "relay отклонил публикацию");
	}
}

// Отфильтровано: только visible===true И НЕ уже в contacts (DESIGN.md, этап 46 —
// человек, уже добавленный в контакты, не нуждается в повторном "знакомстве").
export async function refreshDiscoveryProfiles(ownerPubkey) {
	const rows = await db.table("discoveryProfiles").toArray();
	discoveryProfiles.value = rows.filter((r) => r.visible && !contacts.value.includes(r.pubkey));
}

export async function refreshOutgoingRequests(ownerPubkey) {
	const rows = await db.table("outgoingAcquaintanceRequests").where("owner").equals(ownerPubkey).toArray();
	outgoingRequests.value = rows;
}

// DESIGN.md, этап 46 — инвариант: НЕ вызывает addContactAction (отличие от
// sendContactRequestAction, форма "Добавить контакт" в contacts.js), иначе
// отмену в Обзоре нельзя было бы честно свести "исчезло без следа" — контакт
// остался бы добавленным. Получатель видит ТОТ ЖЕ CONTACT_REQUEST_KIND, что и
// от формы "Добавить контакт" — намеренно, чтобы не удваивать приёмный код
// (transport.js's giftWrapSubscriber, contactRequests-таблица, кнопки
// Принять/Отклонить в contacts.jsx — всё уже готово, не трогается).
export async function sendAcquaintanceRequestAction(ownerPubkey, privKey, targetPubkey, publish) {
	await db.table("outgoingAcquaintanceRequests").put({ owner: ownerPubkey, targetPubkey, createdAt: Math.floor(Date.now() / 1000) });
	const giftWrap = nip59Wrap(buildContactRequestRumor(""), privKey, targetPubkey);
	await requirePublishOk(publish, giftWrap);
}

// Оптимистично: локальная запись пропадает НЕМЕДЛЕННО, независимо от сети —
// галочка на карточке обязана исчезнуть сразу же, best-effort уведомление
// адресата (ACQUAINT_CANCELLED_KIND) не должно блокировать/откатывать это.
export async function cancelAcquaintanceRequestAction(ownerPubkey, privKey, targetPubkey, publish) {
	await db.table("outgoingAcquaintanceRequests").delete([ownerPubkey, targetPubkey]);
	try {
		await publish(nip59Wrap(buildAcquaintCancelledRumor(), privKey, targetPubkey));
	} catch {
		// сеть недоступна — получатель узнает при следующей синхронизации, не критично
	}
}
