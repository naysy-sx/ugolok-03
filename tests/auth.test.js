import { test } from "node:test";
import assert from "node:assert/strict";
import {
	currentUser,
	privKeySig,
	masterSecretSig,
	dbKeySig,
	login,
	lock,
	touch,
	isIdle,
} from "../src/ui/signals/auth.js";
import { getMemoryCachedUrl, putMemoryCachedAttachment } from "../src/ui/attachment-memory-cache.js";

test("исходное состояние: все сигналы пусты", () => {
	lock(); // сброс на случай порядка выполнения тестов
	assert.equal(currentUser.value, null);
	assert.equal(privKeySig.value, null);
	assert.equal(masterSecretSig.value, null);
	assert.equal(dbKeySig.value, null);
});

test("login: заполняет currentUser/privKey/masterSecret/dbKey", () => {
	const privKey = new Uint8Array(32).fill(3);
	login("account-id-1", "alice", privKey);
	assert.deepEqual(currentUser.value, { id: "account-id-1", login: "alice" });
	assert.deepEqual(privKeySig.value, privKey);
	assert.ok(masterSecretSig.value instanceof Uint8Array);
	assert.equal(masterSecretSig.value.length, 32);
	assert.ok(dbKeySig.value instanceof Uint8Array);
	assert.equal(dbKeySig.value.length, 32);
	assert.notDeepEqual(masterSecretSig.value, dbKeySig.value);
	lock();
});

test("lock: сбрасывает все 4 сигнала в null", () => {
	login("account-id-2", "bob", new Uint8Array(32).fill(7));
	lock();
	assert.equal(currentUser.value, null);
	assert.equal(privKeySig.value, null);
	assert.equal(masterSecretSig.value, null);
	assert.equal(dbKeySig.value, null);
});

test("lock: чистит кэш расшифрованных вложений в памяти (найдено ревью Opus — иначе медиа переживает блокировку сессии в оперативке)", () => {
	putMemoryCachedAttachment("some-sha256", new Uint8Array([1, 2, 3]), "image/png");
	lock();
	assert.equal(getMemoryCachedUrl("some-sha256"), undefined);
});

test("login: masterSecret/dbKey детерминированы (та же деривация, что этап 8)", () => {
	const privKey = new Uint8Array(32).fill(9);
	login("acc", "x", privKey);
	const ms1 = masterSecretSig.value;
	lock();
	login("acc", "x", privKey);
	const ms2 = masterSecretSig.value;
	assert.deepEqual(ms1, ms2);
	lock();
});

test("isIdle: false сразу после touch(), true спустя >24ч (инъекция времени, без реального ожидания)", () => {
	const t0 = 1_000_000_000_000; // произвольная опорная точка
	touch(t0);
	assert.equal(isIdle(t0), false, "0мс спустя — не idle");
	assert.equal(isIdle(t0 + 23 * 60 * 60 * 1000), false, "23ч спустя — ещё не idle");
	assert.equal(isIdle(t0 + 24 * 60 * 60 * 1000 + 1), true, "24ч+1мс спустя — idle");
});

test("login вызывает touch неявно (сбрасывает отсчёт активности)", () => {
	const t0 = 2_000_000_000_000;
	touch(t0);
	assert.equal(isIdle(t0 + 25 * 60 * 60 * 1000), true, "без login — давно idle");
	login("acc", "x", new Uint8Array(32), t0 + 25 * 60 * 60 * 1000);
	assert.equal(isIdle(t0 + 25 * 60 * 60 * 1000), false, "login сбросил отсчёт");
	lock();
});
