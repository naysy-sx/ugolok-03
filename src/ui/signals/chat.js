import { signal } from "@preact/signals";

// Лёгкая связка "контакт -> открыть чат с ним", без самого экрана чата (тот
// строится этапом 24). contacts.jsx устанавливает activeChatPubkey по клику на
// аватар/никнейм контакта; app.jsx реагирует переключением на вкладку "Сообщения".
export const activeChatPubkey = signal(null);

export function openChat(pubkey) {
	activeChatPubkey.value = pubkey;
}
