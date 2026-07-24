import { signal } from "@preact/signals";

// Тот же принцип, что signals/chat.js's activeChatPubkey — лёгкая связка "карточка
// канала -> открыть его", без самого экрана (channels.jsx переключает список/детали
// внутри себя по этому сигналу, как chat.jsx делает для activeChatPubkey).
export const activeChannelId = signal(null);

export function openChannel(channelId) {
	activeChannelId.value = channelId;
}

// Этап 47-довесок-3 — "куда именно в канале" (клик по уведомлению о посте/
// комментарии/ответе/чате): {postId?, commentId?, subTab?}. channel.jsx читает
// ОДИН раз на своём mount-эффекте и сбрасывает в null сразу после применения —
// иначе повторное открытие того же канала вручную снова прыгало бы к старой цели.
export const channelPostTarget = signal(null);

export function setChannelPostTarget(target) {
	channelPostTarget.value = target;
}
