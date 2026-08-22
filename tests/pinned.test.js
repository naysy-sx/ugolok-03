import "fake-indexeddb/auto";
import { test, before, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import { db } from "../src/core/store/database.js";
import { getPublicKey } from "../src/core/crypto/keys.js";
import { bytesToHex } from "@noble/hashes/utils.js";
import {
	PINNED_KIND,
	buildPinnedEvent,
	parsePinnedEvent,
	loadPinned,
	savePinned,
	rebuildPinned,
	pinChannel,
	unpinChannel,
	pinPerson,
	unpinPerson,
} from "../src/domain/contacts/pinned.js";

const ALICE_PRIV = new Uint8Array(32).fill(1);
const ALICE_PUB = bytesToHex(getPublicKey(ALICE_PRIV));
const DB_KEY = crypto.getRandomValues(new Uint8Array(32));

before(async () => {
	await db.open();
});

beforeEach(async () => {
	await db.table("pinned").clear();
	await db.table("events").clear();
});

after(() => {
	db.close();
});

function capturingPublish(bucket) {
	return async (event) => {
		bucket.push(event);
		return { ok: true };
	};
}

test("buildPinnedEvent/parsePinnedEvent: round-trip, kind=PINNED_KIND, d-tag='pinned' буквально", () => {
	const pinned = { channels: ["chan-1"], people: ["peer-1"] };
	const event = buildPinnedEvent(ALICE_PRIV, pinned);
	assert.equal(event.kind, PINNED_KIND);
	assert.deepEqual(event.tags.find((t) => t[0] === "d"), ["d", "pinned"]);
	const parsed = parsePinnedEvent(event, ALICE_PRIV);
	assert.deepEqual(parsed.channels, ["chan-1"]);
	assert.deepEqual(parsed.people, ["peer-1"]);
});

test("loadPinned: без локальной записи -> {channels: [], people: []}", async () => {
	const pinned = await loadPinned(ALICE_PUB, DB_KEY);
	assert.deepEqual(pinned, { channels: [], people: [] });
});

test("savePinned: сохраняет локально сразу, даже если publish бросает (best-effort)", async () => {
	const failingPublish = async () => {
		throw new Error("нет сети");
	};
	await savePinned(ALICE_PUB, ALICE_PRIV, DB_KEY, { channels: ["c1"], people: [] }, failingPublish);
	const pinned = await loadPinned(ALICE_PUB, DB_KEY);
	assert.deepEqual(pinned.channels, ["c1"]);
});

test("pinChannel: добавляет id, people не трогает", async () => {
	await pinChannel(ALICE_PUB, ALICE_PRIV, DB_KEY, "chan-1", capturingPublish([]));
	const pinned = await loadPinned(ALICE_PUB, DB_KEY);
	assert.deepEqual(pinned.channels, ["chan-1"]);
	assert.deepEqual(pinned.people, []);
});

test("pinChannel: повторный вызов того же id — идемпотентно, не дублирует", async () => {
	const publish = capturingPublish([]);
	await pinChannel(ALICE_PUB, ALICE_PRIV, DB_KEY, "chan-1", publish);
	await pinChannel(ALICE_PUB, ALICE_PRIV, DB_KEY, "chan-1", publish);
	const pinned = await loadPinned(ALICE_PUB, DB_KEY);
	assert.deepEqual(pinned.channels, ["chan-1"]);
});

test("unpinChannel: убирает id из списка, channels не трогает people", async () => {
	const publish = capturingPublish([]);
	await pinChannel(ALICE_PUB, ALICE_PRIV, DB_KEY, "chan-1", publish);
	await pinPerson(ALICE_PUB, ALICE_PRIV, DB_KEY, "peer-1", publish);
	await unpinChannel(ALICE_PUB, ALICE_PRIV, DB_KEY, "chan-1", publish);
	const pinned = await loadPinned(ALICE_PUB, DB_KEY);
	assert.deepEqual(pinned.channels, []);
	assert.deepEqual(pinned.people, ["peer-1"], "unpinChannel не должен трогать people");
});

test("unpinChannel: несуществующий id — no-op, не бросает", async () => {
	await assert.doesNotReject(() => unpinChannel(ALICE_PUB, ALICE_PRIV, DB_KEY, "never-pinned", capturingPublish([])));
	const pinned = await loadPinned(ALICE_PUB, DB_KEY);
	assert.deepEqual(pinned.channels, []);
});

test("pinPerson/unpinPerson: симметричный цикл, channels не трогает", async () => {
	const publish = capturingPublish([]);
	await pinChannel(ALICE_PUB, ALICE_PRIV, DB_KEY, "chan-1", publish);
	await pinPerson(ALICE_PUB, ALICE_PRIV, DB_KEY, "peer-1", publish);
	let pinned = await loadPinned(ALICE_PUB, DB_KEY);
	assert.deepEqual(pinned.people, ["peer-1"]);
	assert.deepEqual(pinned.channels, ["chan-1"]);

	await unpinPerson(ALICE_PUB, ALICE_PRIV, DB_KEY, "peer-1", publish);
	pinned = await loadPinned(ALICE_PUB, DB_KEY);
	assert.deepEqual(pinned.people, []);
	assert.deepEqual(pinned.channels, ["chan-1"], "unpinPerson не должен трогать channels");
});

// АДВЕРСАРНО — снятие пометки не порождает событие удаления (REDESIGN-SPEC.md,
// этап 6: "снятие пометки не порождает события удаления").
test("АДВЕРСАРНО: unpinChannel публикует ТОЛЬКО PINNED_KIND, никакого kind:5", async () => {
	const published = [];
	const publish = capturingPublish(published);
	await pinChannel(ALICE_PUB, ALICE_PRIV, DB_KEY, "chan-1", publish);
	await unpinChannel(ALICE_PUB, ALICE_PRIV, DB_KEY, "chan-1", publish);
	assert.ok(published.length > 0);
	assert.ok(published.every((e) => e.kind === PINNED_KIND), "ни одного события другого kind, особенно kind:5 (NIP-09 удаление)");
});

test("rebuildPinned: сканирует events, берёт ПОСЛЕДНИЙ по created_at (LWW)", async () => {
	const older = buildPinnedEvent(ALICE_PRIV, { channels: ["old-chan"], people: [] }, 1000);
	const newer = buildPinnedEvent(ALICE_PRIV, { channels: ["new-chan"], people: ["p1"] }, 2000);
	await db.table("events").bulkAdd([
		{ id: older.id, pubkey: ALICE_PUB, kind: PINNED_KIND, created_at: older.created_at, tags: older.tags, content: older.content, sig: older.sig },
		{ id: newer.id, pubkey: ALICE_PUB, kind: PINNED_KIND, created_at: newer.created_at, tags: newer.tags, content: newer.content, sig: newer.sig },
	]);
	await rebuildPinned(ALICE_PUB, ALICE_PRIV, DB_KEY);
	const pinned = await loadPinned(ALICE_PUB, DB_KEY);
	assert.deepEqual(pinned.channels, ["new-chan"], "последняя по created_at версия выигрывает");
	assert.deepEqual(pinned.people, ["p1"]);
});

test("rebuildPinned: нет событий -> no-op, не бросает", async () => {
	await assert.doesNotReject(() => rebuildPinned(ALICE_PUB, ALICE_PRIV, DB_KEY));
	const pinned = await loadPinned(ALICE_PUB, DB_KEY);
	assert.deepEqual(pinned, { channels: [], people: [] });
});

test("AC-16: pinned хранится зашифрованным — сырой дамп не содержит id закреплённых каналов/людей", async () => {
	await pinChannel(ALICE_PUB, ALICE_PRIV, DB_KEY, "secret-channel-id", capturingPublish([]));
	const raw = await db.table("pinned").get(ALICE_PUB);
	assert.equal(JSON.stringify(raw).includes("secret-channel-id"), false);
});
