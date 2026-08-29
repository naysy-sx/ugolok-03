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
// CONTRACTS.md §DISCOVERY, T9 — пустая строка -> кнопка "Пожаловаться" скрыта.
export const BUILD_ADMIN_PUBKEY =
	typeof __BUILD_ADMIN_PUBKEY__ !== "undefined" ? __BUILD_ADMIN_PUBKEY__ : "";
