// src/config.js — единая точка доступа к build-time константам.
// Источник — define в vite.config.js (__BUILD_*__), НЕ import.meta.env.
export const BUILD_DEFAULT_RELAYS =
	typeof __BUILD_DEFAULT_RELAYS__ !== "undefined"
		? __BUILD_DEFAULT_RELAYS__
		: [];
export const BUILD_BOOTSTRAP_RELAYS =
	typeof __BUILD_BOOTSTRAP_RELAYS__ !== "undefined"
		? __BUILD_BOOTSTRAP_RELAYS__
		: [];
export const BUILD_DEFAULT_BLOSSOM_SERVERS =
	typeof __BUILD_DEFAULT_BLOSSOM_SERVERS__ !== "undefined"
		? __BUILD_DEFAULT_BLOSSOM_SERVERS__
		: [];
export const BUILD_DEFAULT_ICE_SERVERS =
	typeof __BUILD_DEFAULT_ICE_SERVERS__ !== "undefined"
		? __BUILD_DEFAULT_ICE_SERVERS__
		: [];
export const BUILD_HASH =
	typeof __BUILD_HASH__ !== "undefined" ? __BUILD_HASH__ : "dev";
// Э1.5/§4.3 — platform.info().appVersion.
export const APP_VERSION =
	typeof __APP_VERSION__ !== "undefined" ? __APP_VERSION__ : "0.0.0-dev";
// CONTRACTS.md §DISCOVERY, T9 — пустая строка -> кнопка "Пожаловаться" скрыта.
export const BUILD_ADMIN_PUBKEY =
	typeof __BUILD_ADMIN_PUBKEY__ !== "undefined" ? __BUILD_ADMIN_PUBKEY__ : "";

// Крайний запасной адрес хранилища. Читать его напрямую нельзя — только через
// domain/files/servers.js (uploadTarget / readCandidates): иначе config.json и
// настройки пользователя не действуют (ТЗ-05). Тест tests/server-addressing.test.js
// запрещает возврат.
export function getBuildBlossomServers() {
	return [...BUILD_DEFAULT_BLOSSOM_SERVERS];
}
