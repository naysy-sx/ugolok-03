import { signal } from "@preact/signals";

// Тот же принцип, что signals/chat.js's activeChatPubkey — лёгкая связка "карточка
// канала -> открыть его", без самого экрана (channels.jsx переключает список/детали
// внутри себя по этому сигналу, как chat.jsx делает для activeChatPubkey).
export const activeChannelId = signal(null);

export function openChannel(channelId) {
	activeChannelId.value = channelId;
}
