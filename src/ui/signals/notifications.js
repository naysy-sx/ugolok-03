import { signal } from "@preact/signals";
import { getUnreadCount } from "../../domain/messaging/read-status.js";
import { getChannelUnreadCount } from "../../domain/content/channel-read-status.js";
import { listOwnedChannels, listSubscribedChannels } from "../../domain/content/channel.js";
import { contacts } from "./contacts.js";

// Этап 47 — бейдж-счётчики нава ("Сообщения [N]"/"Каналы [N]"). notify() НЕ источник
// истины для них (CONTRACTS.md) — считаются напрямую из фактического unread-состояния
// в БД, тем же путём, что уже используют per-contact/per-channel индикаторы в списках.
export const unreadMessagesCount = signal(0);
export const unreadChannelsCount = signal(0);
// ASIDE-REDESIGN/SIDEBAR-SPEC-2.md, этап 3 — раздельные суммы owned/subscribed
// (заголовки групп "Мои каналы"/"Подписки" в nav-groups.jsx) и по-элементные
// карты (точка непрочитанного на аватаре в списке) — заполняются В ТЕХ ЖЕ
// циклах, что уже обходят контакты/каналы для total, второго прохода по БД нет.
export const unreadOwnedChannelsCount = signal(0);
export const unreadSubscribedChannelsCount = signal(0);
export const unreadByContact = signal({});
export const unreadByChannel = signal({});

export async function refreshUnreadMessagesCount(ownerPubkey) {
	let total = 0;
	const byContact = {};
	for (const contactPubkey of contacts.value) {
		const count = await getUnreadCount(ownerPubkey, contactPubkey);
		byContact[contactPubkey] = count;
		total += count;
	}
	unreadMessagesCount.value = total;
	unreadByContact.value = byContact;
}

export async function refreshUnreadChannelsCount(ownerPubkey, dbKey) {
	const [owned, subscribed] = await Promise.all([listOwnedChannels(ownerPubkey, dbKey), listSubscribedChannels(ownerPubkey, dbKey)]);
	const byChannel = {};
	let ownedTotal = 0;
	for (const channel of owned) {
		const count = await getChannelUnreadCount(ownerPubkey, channel.id, dbKey);
		byChannel[channel.id] = count;
		ownedTotal += count;
	}
	let subscribedTotal = 0;
	for (const channel of subscribed) {
		const count = await getChannelUnreadCount(ownerPubkey, channel.id, dbKey);
		byChannel[channel.id] = count;
		subscribedTotal += count;
	}
	unreadOwnedChannelsCount.value = ownedTotal;
	unreadSubscribedChannelsCount.value = subscribedTotal;
	unreadChannelsCount.value = ownedTotal + subscribedTotal;
	unreadByChannel.value = byChannel;
}
