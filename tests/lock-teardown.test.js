import { test } from "node:test";
import assert from "node:assert/strict";
import { login, lock, onLock, currentUser, privKeySig } from "../src/ui/signals/auth.js";

test("onLock: хук вызывается на lock(), до обнуления сигналов можно ещё прочитать privKey", () => {
	login("owner", "alice", new Uint8Array(32).fill(4));
	let sawPriv = false;
	const unsub = onLock(() => {
		assert.ok(privKeySig.value instanceof Uint8Array, "хук lock видит ключ до обнуления сигналов");
		sawPriv = true;
	});
	lock();
	assert.equal(sawPriv, true);
	assert.equal(currentUser.value, null);
	assert.equal(privKeySig.value, null);
	unsub();
});

test("onLock: отписка больше не зовётся", () => {
	let n = 0;
	const unsub = onLock(() => {
		n += 1;
	});
	unsub();
	login("owner", "bob", new Uint8Array(32).fill(5));
	lock();
	assert.equal(n, 0);
});

test("onLock: бросок в хуке не мешает сбросить сессию", () => {
	login("owner", "eve", new Uint8Array(32).fill(6));
	const unsub = onLock(() => {
		throw new Error("hook fail");
	});
	lock();
	assert.equal(currentUser.value, null);
	assert.equal(privKeySig.value, null);
	unsub();
});
