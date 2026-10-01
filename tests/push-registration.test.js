import "fake-indexeddb/auto";
import { test, before, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import { bytesToHex } from "@noble/hashes/utils.js";
import { db } from "../src/core/store/database.js";
import { getPublicKey } from "../src/core/crypto/keys.js";
import { toEncryptedRow } from "../src/core/store/encrypted-table.js";
import { MLS_GROUPS_PLAINTEXT_FIELDS } from "../src/core/store/table-fields.js";
import { resetRuntimeConfig, loadRuntimeConfig } from "../src/domain/settings/runtime-config.js";
import {
	isPushSupported,
	isPushEnabled,
	getMyGroupIds,
	enablePushForAccount,
	disablePushEverywhere,
	unregisterPushForAccount,
	syncPushOnLogin,
	notifyGroupsMayHaveChanged,
	resetPushRegistrationStateForTests,
	RENEWAL_INTERVAL_MS,
} from "../src/domain/push/registration.js";

function makeStorage() {
	const map = new Map();
	return {
		getItem: (k) => (map.has(k) ? map.get(k) : null),
		setItem: (k, v) => map.set(k, String(v)),
		removeItem: (k) => map.delete(k),
		clear: () => map.clear(),
	};
}

const ALICE_PRIV = new Uint8Array(32).fill(1);
const ALICE = bytesToHex(getPublicKey(ALICE_PRIV));
const BOB_PRIV = new Uint8Array(32).fill(2);
const BOB = bytesToHex(getPublicKey(BOB_PRIV));
const DB_KEY = crypto.getRandomValues(new Uint8Array(32));
const BRIDGE = "https://relay.test.ugolok.tech/push";

function fakePlatform({ os = "android", available = true, pushImpl = {} } = {}) {
	return {
		os,
		push: {
			available: () => available,
			enable: async () => {},
			disable: async () => {},
			syncFilters: async () => {},
			...pushImpl,
		},
	};
}

async function seedGroup(ownerPubkey, groupId) {
	await db.table("mlsGroups").put(
		toEncryptedRow({ ownerPubkey, groupId, contactPubkey: "x".repeat(64), state: "s", generation: 0 }, MLS_GROUPS_PLAINTEXT_FIELDS, DB_KEY),
	);
}

function fakeFetchForRegister(response = { endpoint: `${BRIDGE}/topic-a`, topic: "topic-a", expires_at: 123 }) {
	const calls = [];
	const fetchImpl = async (url, opts) => {
		calls.push({ url, opts });
		return { ok: true, status: 200, json: async () => response };
	};
	return { fetchImpl, calls };
}

before(async () => {
	await db.open();
});
beforeEach(async () => {
	await db.table("mlsGroups").clear();
	globalThis.localStorage = makeStorage();
	resetRuntimeConfig();
	resetPushRegistrationStateForTests();
});
after(() => db.close());

test("isPushSupported: android + available + сервер настроен -> true", async () => {
	await loadRuntimeConfig({ fetchImpl: async () => ({ ok: true, json: async () => ({ pushBridge: BRIDGE }) }) });
	assert.equal(isPushSupported({ platform: fakePlatform() }), true);
});

test("isPushSupported: не android -> false, даже если available()=true", () => {
	assert.equal(isPushSupported({ platform: fakePlatform({ os: "ios" }) }), false);
});

test("isPushSupported: available()=false -> false", () => {
	assert.equal(isPushSupported({ platform: fakePlatform({ available: false }) }), false);
});

test("getMyGroupIds: возвращает groupId всех MLS-групп владельца", async () => {
	await seedGroup(ALICE, "g1");
	await seedGroup(ALICE, "g2");
	await seedGroup(BOB, "g3"); // чужой аккаунт — не должен попасть
	const ids = await getMyGroupIds(ALICE, DB_KEY);
	assert.deepEqual(ids.sort(), ["g1", "g2"]);
});

test("enablePushForAccount: без pushBridge в конфиге -> ничего не делает, возвращает null", async () => {
	const { fetchImpl, calls } = fakeFetchForRegister();
	const result = await enablePushForAccount(ALICE, ALICE_PRIV, DB_KEY, { platform: fakePlatform(), fetchImpl });
	assert.equal(result, null);
	assert.equal(calls.length, 0);
	assert.equal(isPushEnabled(), false);
});

test("enablePushForAccount: регистрирует, сохраняет состояние, включает ИП6-флаг", async () => {
	await loadRuntimeConfig({ fetchImpl: async () => ({ ok: true, json: async () => ({ pushBridge: BRIDGE }) }) });
	await seedGroup(ALICE, "g1");
	const { fetchImpl, calls } = fakeFetchForRegister();
	let syncedTopics = null;
	const platform = fakePlatform({ pushImpl: { syncFilters: async (t) => { syncedTopics = t; } } });

	const result = await enablePushForAccount(ALICE, ALICE_PRIV, DB_KEY, { platform, fetchImpl });

	assert.equal(result.topic, "topic-a");
	assert.equal(calls.length, 1);
	assert.equal(calls[0].opts.method, "POST");
	const body = JSON.parse(calls[0].opts.body);
	assert.deepEqual(body.groups, ["g1"]);
	assert.equal(isPushEnabled(), true);
	assert.deepEqual(syncedTopics, [{ accountId: ALICE, endpoint: `${BRIDGE}/topic-a` }]);
});

test("enablePushForAccount: платформа не поддерживает -> null, сети не касается", async () => {
	await loadRuntimeConfig({ fetchImpl: async () => ({ ok: true, json: async () => ({ pushBridge: BRIDGE }) }) });
	const { fetchImpl, calls } = fakeFetchForRegister();
	const result = await enablePushForAccount(ALICE, ALICE_PRIV, DB_KEY, { platform: fakePlatform({ os: "ios" }), fetchImpl });
	assert.equal(result, null);
	assert.equal(calls.length, 0);
});

test("disablePushEverywhere: DELETE на мосту, чистит состояние, выключает флаг, зовёт platform.push.disable()", async () => {
	await loadRuntimeConfig({ fetchImpl: async () => ({ ok: true, json: async () => ({ pushBridge: BRIDGE }) }) });
	const reg = fakeFetchForRegister();
	const platform = fakePlatform();
	await enablePushForAccount(ALICE, ALICE_PRIV, DB_KEY, { platform, fetchImpl: reg.fetchImpl });

	const deleteCalls = [];
	let disableCalled = false;
	const fetchImplDelete = async (url, opts) => {
		deleteCalls.push({ url, opts });
		return { ok: true, status: 204, json: async () => ({}) };
	};
	const platformForDisable = fakePlatform({ pushImpl: { disable: async () => { disableCalled = true; } } });

	await disablePushEverywhere(ALICE, ALICE_PRIV, { platform: platformForDisable, fetchImpl: fetchImplDelete });

	assert.equal(deleteCalls.length, 1);
	assert.equal(deleteCalls[0].opts.method, "DELETE");
	assert.equal(isPushEnabled(), false);
	assert.equal(disableCalled, true);
});

test("disablePushEverywhere: сбой сети на DELETE всё равно выключает локально (best-effort)", async () => {
	await loadRuntimeConfig({ fetchImpl: async () => ({ ok: true, json: async () => ({ pushBridge: BRIDGE }) }) });
	const reg = fakeFetchForRegister();
	await enablePushForAccount(ALICE, ALICE_PRIV, DB_KEY, { platform: fakePlatform(), fetchImpl: reg.fetchImpl });

	const failingFetch = async () => {
		throw new Error("network down");
	};
	await assert.doesNotReject(() => disablePushEverywhere(ALICE, ALICE_PRIV, { platform: fakePlatform(), fetchImpl: failingFetch }));
	assert.equal(isPushEnabled(), false);
});

test("unregisterPushForAccount: удаляет только один аккаунт, остальные остаются зарегистрированы", async () => {
	await loadRuntimeConfig({ fetchImpl: async () => ({ ok: true, json: async () => ({ pushBridge: BRIDGE }) }) });
	const regAlice = fakeFetchForRegister({ endpoint: `${BRIDGE}/topic-alice`, topic: "topic-alice", expires_at: 1 });
	const regBob = fakeFetchForRegister({ endpoint: `${BRIDGE}/topic-bob`, topic: "topic-bob", expires_at: 1 });
	let synced = [];
	const platform = fakePlatform({ pushImpl: { syncFilters: async (t) => { synced = t; } } });

	await enablePushForAccount(ALICE, ALICE_PRIV, DB_KEY, { platform, fetchImpl: regAlice.fetchImpl });
	await enablePushForAccount(BOB, BOB_PRIV, DB_KEY, { platform, fetchImpl: regBob.fetchImpl });
	assert.equal(synced.length, 2); // мультиаккаунт — оба в списке топиков (Ворота П3)

	const del = fakeFetchForRegister();
	await unregisterPushForAccount(ALICE, ALICE_PRIV, { platform, fetchImpl: del.fetchImpl });

	assert.equal(synced.length, 1);
	assert.equal(synced[0].accountId, BOB);
	assert.equal(isPushEnabled(), true); // глобальный тумблер не тронут удалением одного аккаунта
});

test("unregisterPushForAccount: аккаунт не был зарегистрирован -> ничего не делает, сети не касается", async () => {
	await loadRuntimeConfig({ fetchImpl: async () => ({ ok: true, json: async () => ({ pushBridge: BRIDGE }) }) });
	const { fetchImpl, calls } = fakeFetchForRegister();
	await unregisterPushForAccount(ALICE, ALICE_PRIV, { platform: fakePlatform(), fetchImpl });
	assert.equal(calls.length, 0);
});

test("syncPushOnLogin: функция выключена -> ничего не делает", async () => {
	await loadRuntimeConfig({ fetchImpl: async () => ({ ok: true, json: async () => ({ pushBridge: BRIDGE }) }) });
	const { fetchImpl, calls } = fakeFetchForRegister();
	await syncPushOnLogin(ALICE, ALICE_PRIV, DB_KEY, { platform: fakePlatform(), fetchImpl });
	assert.equal(calls.length, 0);
});

test("syncPushOnLogin: включено, аккаунт ещё не зарегистрирован -> регистрирует впервые (мультиаккаунт)", async () => {
	await loadRuntimeConfig({ fetchImpl: async () => ({ ok: true, json: async () => ({ pushBridge: BRIDGE }) }) });
	const first = fakeFetchForRegister({ endpoint: `${BRIDGE}/t1`, topic: "t1", expires_at: 1 });
	await enablePushForAccount(ALICE, ALICE_PRIV, DB_KEY, { platform: fakePlatform(), fetchImpl: first.fetchImpl });

	const second = fakeFetchForRegister({ endpoint: `${BRIDGE}/t2`, topic: "t2", expires_at: 1 });
	await syncPushOnLogin(BOB, BOB_PRIV, DB_KEY, { platform: fakePlatform(), fetchImpl: second.fetchImpl });

	assert.equal(second.calls.length, 1);
	assert.equal(second.calls[0].opts.method, "POST");
});

test("syncPushOnLogin: свежая регистрация (меньше недели) -> не трогает сеть", async () => {
	await loadRuntimeConfig({ fetchImpl: async () => ({ ok: true, json: async () => ({ pushBridge: BRIDGE }) }) });
	const reg = fakeFetchForRegister();
	await enablePushForAccount(ALICE, ALICE_PRIV, DB_KEY, { platform: fakePlatform(), fetchImpl: reg.fetchImpl });

	const { fetchImpl, calls } = fakeFetchForRegister();
	await syncPushOnLogin(ALICE, ALICE_PRIV, DB_KEY, { platform: fakePlatform(), fetchImpl });
	assert.equal(calls.length, 0);
});

test("syncPushOnLogin: регистрация старше недели -> продлевает (PUT)", async () => {
	await loadRuntimeConfig({ fetchImpl: async () => ({ ok: true, json: async () => ({ pushBridge: BRIDGE }) }) });
	const now0 = 1_800_000_000_000;
	const reg = fakeFetchForRegister();
	await enablePushForAccount(ALICE, ALICE_PRIV, DB_KEY, { platform: fakePlatform(), fetchImpl: reg.fetchImpl, now: now0 });

	const { fetchImpl, calls } = fakeFetchForRegister();
	await syncPushOnLogin(ALICE, ALICE_PRIV, DB_KEY, { platform: fakePlatform(), fetchImpl, now: now0 + RENEWAL_INTERVAL_MS + 1000 });

	assert.equal(calls.length, 1);
	assert.equal(calls[0].opts.method, "PUT");
});

test("notifyGroupsMayHaveChanged: аккаунт не зарегистрирован -> ничего не планирует", async () => {
	await loadRuntimeConfig({ fetchImpl: async () => ({ ok: true, json: async () => ({ pushBridge: BRIDGE }) }) });
	let scheduled = false;
	notifyGroupsMayHaveChanged(ALICE, ALICE_PRIV, DB_KEY, ["g1"], {
		platform: fakePlatform(),
		setTimeoutImpl: () => {
			scheduled = true;
			return 0;
		},
	});
	assert.equal(scheduled, false);
});

test("notifyGroupsMayHaveChanged: список не изменился -> не планирует (дешёвая проверка, П3.3)", async () => {
	await loadRuntimeConfig({ fetchImpl: async () => ({ ok: true, json: async () => ({ pushBridge: BRIDGE }) }) });
	await seedGroup(ALICE, "g1");
	const reg = fakeFetchForRegister();
	await enablePushForAccount(ALICE, ALICE_PRIV, DB_KEY, { platform: fakePlatform(), fetchImpl: reg.fetchImpl });

	let scheduled = false;
	notifyGroupsMayHaveChanged(ALICE, ALICE_PRIV, DB_KEY, ["g1"], {
		platform: fakePlatform(),
		setTimeoutImpl: () => {
			scheduled = true;
			return 0;
		},
	});
	assert.equal(scheduled, false);
});

test("notifyGroupsMayHaveChanged: список изменился -> планирует ровно один раз, PUT уходит с СОВРЕМЕННЫМ списком на момент срабатывания", async () => {
	await loadRuntimeConfig({ fetchImpl: async () => ({ ok: true, json: async () => ({ pushBridge: BRIDGE }) }) });
	await seedGroup(ALICE, "g1");
	const reg = fakeFetchForRegister();
	await enablePushForAccount(ALICE, ALICE_PRIV, DB_KEY, { platform: fakePlatform(), fetchImpl: reg.fetchImpl });

	// между планированием и срабатыванием таймера появляется ЕЩЁ одна группа —
	// функция должна отправить g1+g2, а не g2 (снимок на момент вызова).
	let firedFn = null;
	const setTimeoutImpl = (fn) => {
		firedFn = fn;
		return 1;
	};
	const { fetchImpl, calls } = fakeFetchForRegister();

	notifyGroupsMayHaveChanged(ALICE, ALICE_PRIV, DB_KEY, ["g1", "g2"], { platform: fakePlatform(), setTimeoutImpl, fetchImpl });
	// повторный вызов, пока таймер уже запланирован — не должен планировать второй
	let scheduledTwice = false;
	notifyGroupsMayHaveChanged(ALICE, ALICE_PRIV, DB_KEY, ["g1", "g2", "g3"], {
		platform: fakePlatform(),
		setTimeoutImpl: () => {
			scheduledTwice = true;
			return 2;
		},
		fetchImpl,
	});
	assert.equal(scheduledTwice, false);

	await seedGroup(ALICE, "g2"); // "фактическое" состояние к моменту срабатывания
	await firedFn();

	assert.equal(calls.length, 1);
	assert.equal(calls[0].opts.method, "PUT");
	const body = JSON.parse(calls[0].opts.body);
	assert.deepEqual(body.groups.sort(), ["g1", "g2"]);
});

test("notifyGroupsMayHaveChanged: после срабатывания новое изменение снова планирует таймер", async () => {
	await loadRuntimeConfig({ fetchImpl: async () => ({ ok: true, json: async () => ({ pushBridge: BRIDGE }) }) });
	await seedGroup(ALICE, "g1");
	const reg = fakeFetchForRegister();
	await enablePushForAccount(ALICE, ALICE_PRIV, DB_KEY, { platform: fakePlatform(), fetchImpl: reg.fetchImpl });

	let fired = null;
	const { fetchImpl } = fakeFetchForRegister();
	notifyGroupsMayHaveChanged(ALICE, ALICE_PRIV, DB_KEY, ["g1", "g2"], {
		platform: fakePlatform(),
		setTimeoutImpl: (fn) => {
			fired = fn;
			return 1;
		},
		fetchImpl,
	});
	await seedGroup(ALICE, "g2");
	await fired();

	let scheduledAgain = false;
	notifyGroupsMayHaveChanged(ALICE, ALICE_PRIV, DB_KEY, ["g1"], {
		platform: fakePlatform(),
		setTimeoutImpl: () => {
			scheduledAgain = true;
			return 3;
		},
		fetchImpl,
	});
	assert.equal(scheduledAgain, true);
});
