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

export async function refreshUnreadMessagesCount(ownerPubkey) {
	let total = 0;
	for (const contactPubkey of contacts.value) {
		total += await getUnreadCount(ownerPubkey, contactPubkey);
	}
	unreadMessagesCount.value = total;
}

export async function refreshUnreadChannelsCount(ownerPubkey, dbKey) {
	const [owned, subscribed] = await Promise.all([listOwnedChannels(ownerPubkey, dbKey), listSubscribedChannels(ownerPubkey, dbKey)]);
	let total = 0;
	for (const channel of [...owned, ...subscribed]) {
		total += await getChannelUnreadCount(ownerPubkey, channel.id, dbKey);
	}
	unreadChannelsCount.value = total;
}
