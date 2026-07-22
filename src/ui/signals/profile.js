import { signal } from "@preact/signals";

// Тот же паттерн, что messagingActivity (chats.js) — карточка профиля в
// сайдбаре (sidebar-profile-card.jsx) смонтирована ПОСТОЯННО, отдельно от
// экрана "Профиль", и не узнала бы об изменении аватара/био сама по себе.
export const profileActivity = signal(0);

export function bumpProfileActivity() {
	profileActivity.value++;
}
