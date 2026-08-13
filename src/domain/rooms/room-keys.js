// Rooms, этап 1 — деривация ключей комнаты. Контракт: PROCESS-DOCS/CONTRACTS.md
// "Rooms — Этап 1"/"Этап 3"; формализация: ROOMS-MATH-v2.md §1.1/§1.2/§1.4,
// ROOMS-ALGO.md §8.
//
// Цепочка в ОДИН медленный вызов (ROOMS-ALGO §8) — kBase единственный дорогой шаг,
// всё остальное — быстрые HMAC/HKDF (те же примитивы, что core/crypto/derivation.js's
// deriveMasterSecret/opaqueDTag, не новая зависимость):
//
//   kBase    = argon2(password, saltBytes(name)) — ЕДИНСТВЕННЫЙ медленный шаг, инжектируется
//   hDisc    = HMAC(kBase, "disc")                — не зависит от suffix: открытый режим
//                                                    находит комнату по (name,password) одному
//   kPointer = HKDF(kBase, "pointer")              — Этап 3: шифрует указатель на suffix под
//                                                    hDisc (ROOMS-MATH §1.2) — НЕ kRv, тот
//                                                    зависит от suffix, которого joiner в
//                                                    открытом режиме ещё не знает
//   kRv      = HKDF(kBase, suffix)                — зависит от suffix (ссылка на комнату)
//   hTopic   = HMAC(kRv, "topic")                  — тег маршрутизации #h
//
// argon2 — инжектируемая функция (password, saltBytes) -> Promise<Uint8Array(32)>.
// По умолчанию — defaultSlowKdf (ниже, scrypt). В тестах — быстрая заглушка.
//
// Разбито на deriveKBase (медленный шаг) + derivePairKeys/deriveLinkKeys (быстрые,
// от уже вычисленного kBase) — Этап 3 (открытый режим): обнаружение suffix через
// указатель под hDisc происходит ДО того, как suffix известен, поэтому HMAC/HKDF-
// цепочка суффикса недоступна на этой фазе, но argon2 всё равно должен быть
// вызван РОВНО ОДИН раз за сессию (ROOMS-ALGO §8) — кэшируя kBase, вызывающий код
// (room-session.js) переиспользует его для deriveLinkKeys, когда suffix найдётся,
// не вызывая argon2 повторно. deriveRoomKeys — прежняя обёртка для закрытого
// режима (Этап 1/2), где suffix известен сразу, поведение не меняется.
import { hkdf } from "@noble/hashes/hkdf.js";
import { hmac } from "@noble/hashes/hmac.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { scryptAsync } from "@noble/hashes/scrypt.js";
import { utf8ToBytes, bytesToHex } from "@noble/hashes/utils.js";

const EMPTY_SALT = new Uint8Array(0);

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

export async function deriveKBase(name, password, argon2) {
	return argon2(password, utf8ToBytes(name));
}

export function derivePairKeys(kBase) {
	const hDisc = bytesToHex(hmac(sha256, kBase, utf8ToBytes("disc")));
	const kPointer = hkdf(sha256, kBase, EMPTY_SALT, utf8ToBytes("Rooms/v1/pointer"), 32);
	return { hDisc, kPointer };
}

export function deriveLinkKeys(kBase, suffix) {
	const kRv = hkdf(sha256, kBase, utf8ToBytes(suffix), utf8ToBytes("Rooms/v1/rendezvous"), 32);
	const hTopic = bytesToHex(hmac(sha256, kRv, utf8ToBytes("topic")));
	return { kRv, hTopic };
}

export async function deriveRoomKeys(name, password, suffix, argon2) {
	const kBase = await deriveKBase(name, password, argon2);
	const { hDisc, kPointer } = derivePairKeys(kBase);
	const { kRv, hTopic } = deriveLinkKeys(kBase, suffix);
	return { kBase, kRv, kSess: null, hTopic, hDisc, kPointer };
}

export function deriveSessionKey(kRv, salt) {
	return hkdf(sha256, kRv, salt, utf8ToBytes("Rooms/v1/session"), 32);
}
