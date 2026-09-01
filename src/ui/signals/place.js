import { signal } from "@preact/signals";

// Редизайн интерфейса, этап 10.1 (CONTRACTS.md/DESIGN.md, "Состояние
// места (10.1)") — единственный источник "где я нахожусь", заменяет
// activeId (app.jsx)/activeChatPubkey (signals/chat.js)/activeChannelId+
// channelPostTarget (signals/channel-nav.js). Формализация инвариантов —
// DESIGN.md. goTo — ПОЛНАЯ замена объекта, не merge: смена kind не может
// утащить за собой чужие postId/commentId (класс бага, который раньше
// давали три независимых сигнала, отчёт A1/A3).
export const DEFAULT_PLACE = { kind: "journal" };
export const place = signal(DEFAULT_PLACE);

export function goTo(next) {
	place.value = next;
}

// id опционален (undefined = список переписок) — единственный kind, где
// отсутствие id не значит "другой экран", а значит "тот же экран, режим
// списка" (chat.jsx уже так устроен изнутри).
export function openChat(pubkey) {
	place.value = pubkey ? { kind: "chat", id: pubkey } : { kind: "chat" };
}

// target — {postId?, commentId?, subTab?}, атомарно ОДНИМ присваиванием
// (было — два отдельных вызова openChannel()+setChannelPostTarget(),
// отдельная функция для второго убрана: единственные два вызывающих,
// notification-nav.js и today.jsx, переходят на второй параметр).
export function openChannel(channelId, target = {}) {
	place.value = channelId
		? { kind: "channel", id: channelId, subTab: target.subTab, postId: target.postId, commentId: target.commentId }
		: { kind: "channels" };
}

// ТЗ редизайн канала A — явный вход на страницу записи. postId живёт,
// пока пользователь не вернётся в ленту (openChannel(channelId)).
export function openChannelPost(channelId, postId, commentId) {
	place.value = { kind: "channel", id: channelId, postId, commentId };
}

// Глобальный поиск (SEARCH-SPEC.md §3.7). query — непустая строка,
// зафиксированная по Enter (вызывающий код гарантирует I-EMPTY-NOOP —
// на пустом поле openSearch не вызывается вовсе, не сюда).
export function openSearch(query) {
	place.value = { kind: "search", query };
}
