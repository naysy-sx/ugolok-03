// Rooms, этап 1 — деривация ключей комнаты. Контракт: PROCESS-DOCS/CONTRACTS.md
// "Rooms — Этап 1"; формализация: ROOMS-MATH-v2.md §1.1/§1.4, ROOMS-ALGO.md §8.
//
// Цепочка в ОДИН медленный вызов (ROOMS-ALGO §8) — kBase единственный дорогой шаг,
// всё остальное — быстрые HMAC/HKDF (те же примитивы, что core/crypto/derivation.js's
// deriveMasterSecret/opaqueDTag, не новая зависимость):
//
//   kBase  = argon2(password, saltBytes(name))   — ЕДИНСТВЕННЫЙ медленный шаг, инжектируется
//   hDisc  = HMAC(kBase, "disc")                 — не зависит от suffix: открытый режим
//                                                   находит комнату по (name,password) одному
//   kRv    = HKDF(kBase, suffix)                 — зависит от suffix (ссылка на комнату)
//   hTopic = HMAC(kRv, "topic")                  — тег маршрутизации #h
//
// argon2 — инжектируемая функция (password, saltBytes) -> Promise<Uint8Array(32)>.
// По умолчанию — defaultSlowKdf (ниже, scrypt). В тестах — быстрая заглушка.
import { hkdf } from "@noble/hashes/hkdf.js";
import { hmac } from "@noble/hashes/hmac.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { scryptAsync } from "@noble/hashes/scrypt.js";
import { utf8ToBytes, bytesToHex } from "@noble/hashes/utils.js";

// Этап 2 — решение по медленному KDF (отложено с Этапа 1, см. CONTRACTS.md
// "Rooms — Этап 2", room-keys.js): scrypt из @noble/hashes (уже зависимость
// проекта, ноль добавочного веса бандла), не отдельная WASM Argon2id-библиотека.
// N=2**15/r=8/p=1 — компромисс UX/устойчивость: комната эфемерна, локальная сеть
// (CLAUDE.md), аудитория включает слабые устройства — не оправдан параметр,
// рассчитанный на защиту долгоживущего секрета. defaultSlowKdf — значение ПО
// УМОЛЧАНИЮ для инжектируемого argon2, не единственный вариант (сигнатура
// (password, saltBytes) -> Promise<Uint8Array(32)> остаётся неизменной).
export async function defaultSlowKdf(password, saltBytes) {
	return scryptAsync(utf8ToBytes(password), saltBytes, { N: 2 ** 15, r: 8, p: 1, dkLen: 32 });
}

export async function deriveRoomKeys(name, password, suffix, argon2) {
	const kBase = await argon2(password, utf8ToBytes(name));
	const hDisc = bytesToHex(hmac(sha256, kBase, utf8ToBytes("disc")));
	const kRv = hkdf(sha256, kBase, utf8ToBytes(suffix), utf8ToBytes("Rooms/v1/rendezvous"), 32);
	const hTopic = bytesToHex(hmac(sha256, kRv, utf8ToBytes("topic")));
	return { kBase, kRv, kSess: null, hTopic, hDisc };
}

export function deriveSessionKey(kRv, salt) {
	return hkdf(sha256, kRv, salt, utf8ToBytes("Rooms/v1/session"), 32);
}
