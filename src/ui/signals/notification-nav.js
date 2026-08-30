import { signal } from "@preact/signals";
import { openChat, openChannel, goTo } from "./place.js";

// Этап 47-довесок-3 (пользователь: клик по уведомлению должен вести "к месту
// события") — единая точка входа для ВСЕХ notify()'s onClick-колбэков в
// transport.js/contacts.js/call.js. app.jsx подписан на pendingNavTarget и
// зовёт applyNavTarget, которая форвардит в единый place (signals/place.js).
//
// Литералы-строители ({screen,...}) НЕ переписаны на словарь place —
// они путешествуют через journal-таблицу как часть persisted navTarget
// (менять формат — отдельная миграция данных, вне этапа 10). Перевод в
// place происходит ТОЛЬКО здесь, единственной точке потребления. Разбор
// всех форм — DESIGN.md, "Редизайн интерфейса, этап 10 (10.1)".
export const pendingNavTarget = signal(null);
// {screen: "messages", contactPubkey?}
// {screen: "channels", channelId?, postId?, commentId?, subTab?}
// {screen: "contacts"}

export function navigateFromNotification(target) {
	pendingNavTarget.value = target;
}

// Вызывается app.jsx СРАЗУ после прочтения pendingNavTarget.
export function applyNavTarget(target) {
	if (target.screen === "messages") {
		openChat(target.contactPubkey ?? null);
	} else if (target.screen === "channels") {
		openChannel(target.channelId ?? null, { postId: target.postId, commentId: target.commentId, subTab: target.subTab });
	} else if (target.screen === "contacts") {
		goTo({ kind: "people" });
	} else if (target.screen === "discovery") {
		goTo({ kind: "discovery" });
	}
}
