// Rooms, этап 1 — room-keys.js. Тесты до кода (skill п.14). Контракт —
// PROCESS-DOCS/CONTRACTS.md "Rooms — Этап 1", формализация — ROOMS-MATH-v2.md
// §1.1/§1.4, ROOMS-ALGO.md §8.
import { test } from "node:test";
import assert from "node:assert/strict";
import { deriveRoomKeys, deriveSessionKey, defaultSlowKdf, deriveKBase, derivePairKeys, deriveLinkKeys } from "../src/domain/rooms/room-keys.js";

// argon2-заглушка для тестов — БЫСТРАЯ, детерминированная функция от
// (password, saltBytes), НЕ настоящий Argon2id (реальная WASM-библиотека —
// вопрос этапа 2, см. CONTRACTS.md). Она обязана вести себя как приличный
// KDF ДЛЯ ЦЕЛЕЙ ТЕСТА: детерминизм (тот же вход -> тот же выход) и
// чувствительность к обоим аргументам (иначе тесты на различимость ничего
// не докажут).
import { hkdf } from "@noble/hashes/hkdf.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { utf8ToBytes, bytesToHex } from "@noble/hashes/utils.js";

function fakeArgon2(password, saltBytes) {
	return Promise.resolve(hkdf(sha256, utf8ToBytes(password), saltBytes, utf8ToBytes("fake-argon2-test-stub"), 32));
}

test("deriveRoomKeys: детерминизм — одинаковые входы дают одинаковые kBase/kRv/hTopic/hDisc", async () => {
	const a = await deriveRoomKeys("котики", "111", "7fk2-mq91", fakeArgon2);
	const b = await deriveRoomKeys("котики", "111", "7fk2-mq91", fakeArgon2);
	assert.deepEqual(a.kBase, b.kBase);
	assert.deepEqual(a.kRv, b.kRv);
	assert.equal(a.hTopic, b.hTopic);
	assert.equal(a.hDisc, b.hDisc);
	assert.equal(a.kSess, null, "kSess не выводится в deriveRoomKeys — только deriveSessionKey");
});

test("deriveRoomKeys: hDisc НЕ зависит от suffix (открытый режим находит комнату без знания ссылки)", async () => {
	const withSuffixA = await deriveRoomKeys("котики", "111", "7fk2-mq91", fakeArgon2);
	const withSuffixB = await deriveRoomKeys("котики", "111", "sovsem-drugoy-suffix", fakeArgon2);
	assert.equal(withSuffixA.hDisc, withSuffixB.hDisc, "hDisc = HMAC(kBase, ...) — kBase не зависит от suffix");
	assert.notEqual(withSuffixA.hTopic, withSuffixB.hTopic, "hTopic = HMAC(kRv, ...) — kRv зависит от suffix, разные suffix -> разные hTopic");
});

test("deriveRoomKeys: разные (name, password) дают разные kBase/hDisc — разные комнаты не путаются", async () => {
	const a = await deriveRoomKeys("котики", "111", "s", fakeArgon2);
	const b = await deriveRoomKeys("собачки", "111", "s", fakeArgon2);
	const c = await deriveRoomKeys("котики", "222", "s", fakeArgon2);
	assert.notEqual(a.hDisc, b.hDisc);
	assert.notEqual(a.hDisc, c.hDisc);
	assert.notEqual(a.hTopic, b.hTopic);
	assert.notEqual(a.hTopic, c.hTopic);
});

test("deriveRoomKeys: argon2 вызывается РОВНО ОДИН раз (единственный медленный шаг, ROOMS-ALGO §8)", async () => {
	let callCount = 0;
	const countingArgon2 = (password, salt) => {
		callCount++;
		return fakeArgon2(password, salt);
	};
	await deriveRoomKeys("котики", "111", "s", countingArgon2);
	assert.equal(callCount, 1);
});

test("deriveSessionKey: разные salt дают разные kSess (И3/И4 — соль экземпляра различает экземпляры)", async () => {
	const { kRv } = await deriveRoomKeys("котики", "111", "s", fakeArgon2);
	const saltInstance1 = crypto.getRandomValues(new Uint8Array(32));
	const saltInstance2 = crypto.getRandomValues(new Uint8Array(32));
	const kSess1 = deriveSessionKey(kRv, saltInstance1);
	const kSess2 = deriveSessionKey(kRv, saltInstance2);
	assert.notEqual(bytesToHex(kSess1), bytesToHex(kSess2));
});

test("deriveSessionKey: тот же salt даёт тот же kSess — возврат до T+τ восстанавливает тот же экземпляр (И3)", async () => {
	const { kRv } = await deriveRoomKeys("котики", "111", "s", fakeArgon2);
	const salt = crypto.getRandomValues(new Uint8Array(32));
	const kSessFirst = deriveSessionKey(kRv, salt);
	const kSessSecond = deriveSessionKey(kRv, salt);
	assert.deepEqual(kSessFirst, kSessSecond);
});

test("И4: kSess экземпляра E1 отличается от kSess экземпляра E2 при ТОМ ЖЕ (name, password, suffix) — только salt меняется между экземплярами", async () => {
	// Два "экземпляра" одной и той же комнаты (n,p,σ) — как раз ситуация ROOMS-MATH §3:
	// разрыв связности живёт новым экземпляром с новой солью, тот же (n,p,σ).
	const keysE1 = await deriveRoomKeys("котики", "111", "7fk2-mq91", fakeArgon2);
	const keysE2 = await deriveRoomKeys("котики", "111", "7fk2-mq91", fakeArgon2);
	// kRv у обоих экземпляров ОДИНАКОВЫЙ (детерминирован рандеву, не экземпляром) —
	// различие вносит ТОЛЬКО соль экземпляра s, сгенерированная создателем.
	assert.deepEqual(keysE1.kRv, keysE2.kRv);
	const saltE1 = crypto.getRandomValues(new Uint8Array(32));
	const saltE2 = crypto.getRandomValues(new Uint8Array(32));
	const kSessE1 = deriveSessionKey(keysE1.kRv, saltE1);
	const kSessE2 = deriveSessionKey(keysE2.kRv, saltE2);
	assert.notEqual(bytesToHex(kSessE1), bytesToHex(kSessE2), "шифртекст E1 не расшифровывается ключом E2");
});

test("defaultSlowKdf (Этап 2, scrypt): детерминизм, 32 байта, чувствительность к password и salt", async () => {
	const salt = crypto.getRandomValues(new Uint8Array(16));
	const a = await defaultSlowKdf("пароль", salt);
	const b = await defaultSlowKdf("пароль", salt);
	assert.equal(a.length, 32);
	assert.deepEqual(a, b, "детерминизм: тот же (password, salt) -> тот же результат");

	const differentPassword = await defaultSlowKdf("другой-пароль", salt);
	assert.notDeepEqual(a, differentPassword);

	const differentSalt = await defaultSlowKdf("пароль", crypto.getRandomValues(new Uint8Array(16)));
	assert.notDeepEqual(a, differentSalt);
});

test("defaultSlowKdf: совместим с deriveRoomKeys как боевая реализация argon2 (не только заглушка)", async () => {
	const keys = await deriveRoomKeys("котики", "секрет", "suffix-1", defaultSlowKdf);
	assert.equal(keys.kBase.length, 32);
	assert.equal(typeof keys.hDisc, "string");
	assert.equal(typeof keys.hTopic, "string");
});

test("Этап 3: deriveRoomKeys теперь возвращает kPointer, согласованный с derivePairKeys(kBase)", async () => {
	const keys = await deriveRoomKeys("котики", "111", "s", fakeArgon2);
	assert.ok(keys.kPointer instanceof Uint8Array);
	assert.equal(keys.kPointer.length, 32);
	const kBase = await deriveKBase("котики", "111", fakeArgon2);
	const pair = derivePairKeys(kBase);
	assert.deepEqual(keys.kPointer, pair.kPointer, "kPointer из deriveRoomKeys совпадает с прямым derivePairKeys(kBase)");
	assert.equal(keys.hDisc, pair.hDisc);
});

test("kPointer НЕ зависит от suffix (иначе указатель на suffix нельзя было бы расшифровать до знания suffix)", async () => {
	const kBase = await deriveKBase("котики", "111", fakeArgon2);
	const { kPointer } = derivePairKeys(kBase);
	const linkA = deriveLinkKeys(kBase, "suffix-a");
	const linkB = deriveLinkKeys(kBase, "suffix-b");
	assert.notEqual(bytesToHex(linkA.kRv), bytesToHex(linkB.kRv), "kRv зависит от suffix");
	// kPointer вычислен ДО выбора suffix и одинаков независимо от того, какой suffix потом будет создан
	const kBaseAgain = await deriveKBase("котики", "111", fakeArgon2);
	assert.deepEqual(derivePairKeys(kBaseAgain).kPointer, kPointer);
});

test("kPointer отличается от kRv и от kBase (разные HKDF info-строки/входы — не коллизия доменов)", async () => {
	const kBase = await deriveKBase("котики", "111", fakeArgon2);
	const { kPointer } = derivePairKeys(kBase);
	const { kRv } = deriveLinkKeys(kBase, "suffix-1");
	assert.notEqual(bytesToHex(kPointer), bytesToHex(kRv));
	assert.notEqual(bytesToHex(kPointer), bytesToHex(kBase));
});

test("deriveKBase: argon2 вызывается ровно один раз, переиспользуется derivePairKeys+deriveLinkKeys без повторного вызова", async () => {
	let callCount = 0;
	const countingArgon2 = (password, salt) => {
		callCount++;
		return fakeArgon2(password, salt);
	};
	const kBase = await deriveKBase("котики", "111", countingArgon2);
	derivePairKeys(kBase);
	deriveLinkKeys(kBase, "любой-suffix");
	deriveLinkKeys(kBase, "другой-suffix");
	assert.equal(callCount, 1, "argon2 вызван один раз, даже с двумя последующими deriveLinkKeys (двухфазный открытый режим)");
});
