import { signal } from "@preact/signals";
import { openChat } from "./chat.js";
import { openChannel, setChannelPostTarget } from "./channel-nav.js";

// Этап 47-довесок-3 (пользователь: клик по уведомлению должен вести "к месту
// события") — единая точка входа для ВСЕХ notify()'s onClick-колбэков в
// transport.js. app.jsx подписан на pendingNavTarget и переключает вкладку
// нава + форвардит контакт/канал в уже существующие сигналы (activeChatPubkey/
// activeChannelId) — здесь НЕ дублируется их роль, только оркестрация.
export const pendingNavTarget = signal(null);
// {screen: "messages", contactPubkey}
// {screen: "channels", channelId, postId?, commentId?, subTab?}
// {screen: "contacts"}

export function navigateFromNotification(target) {
	pendingNavTarget.value = target;
}

// Вызывается app.jsx СРАЗУ после прочтения pendingNavTarget — само переключение
// экрана (activeId) остаётся в app.jsx (там же живёт setActiveId), эта функция
// только форвардит специфику конкретного экрана в его собственный сигнал.
export function applyNavTarget(target) {
	if (target.screen === "messages" && target.contactPubkey) {
		openChat(target.contactPubkey);
	} else if (target.screen === "channels" && target.channelId) {
		openChannel(target.channelId);
		setChannelPostTarget({ postId: target.postId, commentId: target.commentId, subTab: target.subTab });
	}
}
