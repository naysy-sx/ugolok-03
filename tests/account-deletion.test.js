import "fake-indexeddb/auto";
import { test, before, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import { db } from "../src/core/store/database.js";
import { getPublicKey } from "../src/core/crypto/keys.js";
import { bytesToHex } from "@noble/hashes/utils.js";
import { createChannel, listOwnedChannels } from "../src/domain/content/channel.js";
import { createInitialState, applyOp, ROOT_ID } from "../src/domain/files/tree.js";
import { createFile as opCreateFile } from "../src/domain/files/ops.js";
import { saveTreeState, saveFileKey } from "../src/domain/files/store.js";
import { putStream } from "../src/domain/files/content.js";
import { deleteAccountEverywhere } from "../src/domain/identity/account-deletion.js";

const ALICE_PRIV = new Uint8Array(32).fill(1);
const BOB_PRIV = new Uint8Array(32).fill(2);
const ALICE_PUB = bytesToHex(getPublicKey(ALICE_PRIV));
const BOB_PUB = bytesToHex(getPublicKey(BOB_PRIV));
const DB_KEY_A = crypto.getRandomValues(new Uint8Array(32));
const DB_KEY_B = crypto.getRandomValues(new Uint8Array(32));
const SERVER_URL = "https://blossom.test";

const OWNER_PUBKEY_TABLES = [
	"messages", "channels", "channelKeys", "channelKeyMeta", "commentAllowlists",
	"posts", "comments", "channelMessages", "channelReaders", "channelReports",
	"channelIgnores", "bannedMembers", "uiSettings", "channelVisibilityGroups",
	"discoverySettings", "clock", "attachments", "ownKeyPackage", "mlsGroups",
	"chatSyncState", "channelSyncState", "knownDevices",
	"files_nodes", "files_mounts", "files_manifests", "files_blobs", "files_thumbs",
	"files_keys", "files_shares", "files_shareKeys", "files_shareGrantees",
	"files_mountKeys", "files_mount_nodes", "files_mount_file_meta",
];
const OWNER_TABLES = ["contacts", "blockedContacts", "groups", "permissions", "effectivePerms", "contactRequests", "inboxRequests", "contactRelationships", "journalEntries", "outgoingAcquaintanceRequests"];

before(async () => {
	await db.open();
});

after(() => {
	db.close();
});

beforeEach(async () => {
	for (const t of [...OWNER_PUBKEY_TABLES, ...OWNER_TABLES, "groupMembers", "deletions", "events", "keystore", "deviceIdentity", "discoveryProfiles", "syncState", "outbox"]) {
		await db.table(t).clear();
	}
});

function failingPublish() {
	return async () => ({ ok: false, reason: "network down" });
}
function capturingPublish(bucket) {
	return async (event) => {
		bucket.push(event);
		return { ok: true };
	};
}

// Тот же приём, что files-content.test.js/messaging-attachments.test.js —
// Range-совместимый фейковый Blossom, здесь + DELETE (BUD-02).
function makeFakeBlossom() {
	const store = new Map();
	async function sha256Hex(bytes) {
		const { sha256 } = await import("@noble/hashes/sha2.js");
		const { bytesToHex: toHex } = await import("@noble/hashes/utils.js");
		return toHex(sha256(bytes));
	}
	const deletedCalls = [];
	const fetchImpl = async (url, opts = {}) => {
		if (opts.method === "PUT") {
			const body = new Uint8Array(opts.body);
			const digest = await sha256Hex(body);
			store.set(digest, body);
			return { ok: true, status: 200, json: async () => ({ sha256: digest, size: body.length }), text: async () => "" };
		}
		if (opts.method === "DELETE") {
			const digest = url.split("/").pop();
			deletedCalls.push(digest);
			store.delete(digest);
			return { ok: true, status: 200, text: async () => "" };
		}
		const digest = url.split("/").pop();
		const bytes = store.get(digest);
		if (!bytes) return { ok: false, status: 404, text: async () => "not found" };
		if (opts.headers?.Range) {
			const m = /bytes=(\d+)-(\d+)/.exec(opts.headers.Range);
			const start = Number(m[1]);
			const end = Number(m[2]);
			const slice = bytes.subarray(start, end + 1);
			return { ok: true, status: 206, arrayBuffer: async () => slice.buffer.slice(slice.byteOffset, slice.byteOffset + slice.byteLength) };
		}
		return { ok: true, status: 200, arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) };
	};
	return { fetchImpl, store, deletedCalls };
}

async function seedFileFor(ownerPubkey, dbKey, fetchImpl) {
	const bytes = new TextEncoder().encode("файл владельца, который должен уйти при удалении аккаунта");
	const { manifestDigest, fileKey } = await putStream(bytes, { name: "x.txt", mime: "text/plain", serverUrl: SERVER_URL, privateKey: ALICE_PRIV, fetchImpl });
	let S = createInitialState();
	const op = opCreateFile(S, ROOT_ID, "x.txt", "node-1", manifestDigest, { counter: 1, deviceId: "d1" });
	S = applyOp(S, op);
	await saveTreeState(ownerPubkey, S);
	await saveFileKey(ownerPubkey, dbKey, manifestDigest, fileKey);
	return manifestDigest;
}

// Заполняет РЕПРЕЗЕНТАТИВНЫЙ набор таблиц для владельца — не все 40+, но
// по одной строке в каждую группу (owner-scoped по ownerPubkey/owner,
// плюс особые случаи groupMembers/events/deletions), чтобы тест реально
// нагружал wipeLocalData, а не был тавтологией с самим кодом.
async function seedRepresentativeData(ownerPubkey, owner) {
	await db.table("messages").add({ ownerPubkey, chatId: "c1", msgId: "m1", id: "m1", lamportTs: 1, senderPubkey: ownerPubkey, status: "sent", deleted: false });
	await db.table("clock").add({ ownerPubkey, id: "lamport", value: 5 });
	await db.table("uiSettings").add({ ownerPubkey, theme: "dark" });
	await db.table("contactRelationships").add({ owner, peer: "peer-1", state: "CONTACT" });
	const groupId = `g1-${owner}`;
	await db.table("groups").add({ owner, id: groupId, name: "Друзья" });
	await db.table("groupMembers").add({ groupId, pubkey: "peer-1" });
	await db.table("journalEntries").add({ id: `${owner}-j1`, owner, createdAt: 1 });
	await db.table("events").add({ pubkey: ownerPubkey, kind: 1, id: `ev-${owner}`, created_at: 1, content: "", tags: [], sig: "x" });
}

test("deleteAccountEverywhere: полная локальная зачистка ВЛАДЕЛЬЦА, ЧУЖИЕ данные (другой owner) не затронуты", async () => {
	await seedRepresentativeData(ALICE_PUB, ALICE_PUB);
	await seedRepresentativeData(BOB_PUB, BOB_PUB);
	await db.table("keystore").put({ id: ALICE_PUB, login: "alice", salt: new Uint8Array(1), iv: new Uint8Array(1), ciphertext: new Uint8Array(1) });
	await db.table("keystore").put({ id: BOB_PUB, login: "bob", salt: new Uint8Array(1), iv: new Uint8Array(1), ciphertext: new Uint8Array(1) });

	await deleteAccountEverywhere(ALICE_PUB, ALICE_PRIV, DB_KEY_A, "alice", failingPublish(), SERVER_URL);

	assert.equal(await db.table("messages").where("ownerPubkey").equals(ALICE_PUB).count(), 0);
	assert.equal(await db.table("clock").where("ownerPubkey").equals(ALICE_PUB).count(), 0);
	assert.equal(await db.table("uiSettings").where("ownerPubkey").equals(ALICE_PUB).count(), 0);
	assert.equal(await db.table("contactRelationships").where("owner").equals(ALICE_PUB).count(), 0);
	assert.equal(await db.table("groups").where("owner").equals(ALICE_PUB).count(), 0);
	assert.equal(await db.table("groupMembers").where("groupId").equals(`g1-${ALICE_PUB}`).count(), 0, "groupMembers удаляемого владельца (по его groupId) тоже должны уйти");
	assert.equal(await db.table("journalEntries").where("owner").equals(ALICE_PUB).count(), 0);
	assert.equal(await db.table("events").filter((e) => e.pubkey === ALICE_PUB).count(), 0);
	assert.equal(await db.table("keystore").get(ALICE_PUB), undefined);

	// Боб — полностью нетронут (мультиаккаунтная изоляция, тот же класс
	// гарантии, что весь проект отлаживал этапами 25-53).
	assert.equal(await db.table("messages").where("ownerPubkey").equals(BOB_PUB).count(), 1);
	assert.equal(await db.table("clock").where("ownerPubkey").equals(BOB_PUB).count(), 1);
	assert.equal(await db.table("uiSettings").where("ownerPubkey").equals(BOB_PUB).count(), 1);
	assert.equal(await db.table("contactRelationships").where("owner").equals(BOB_PUB).count(), 1);
	assert.equal(await db.table("groups").where("owner").equals(BOB_PUB).count(), 1);
	assert.equal(await db.table("journalEntries").where("owner").equals(BOB_PUB).count(), 1);
	assert.equal(await db.table("events").filter((e) => e.pubkey === BOB_PUB).count(), 1);
	assert.notEqual(await db.table("keystore").get(BOB_PUB), undefined);
});

test("deleteAccountEverywhere: НЕ трогает deviceIdentity/discoveryProfiles/syncState (не данные аккаунта)", async () => {
	await db.table("deviceIdentity").add({ id: "device-1" });
	await db.table("discoveryProfiles").add({ pubkey: "someone-else" });
	await db.table("syncState").add({ relay: "ws://x", since: 1 });
	await db.table("keystore").put({ id: ALICE_PUB, login: "alice", salt: new Uint8Array(1), iv: new Uint8Array(1), ciphertext: new Uint8Array(1) });

	await deleteAccountEverywhere(ALICE_PUB, ALICE_PRIV, DB_KEY_A, "alice", failingPublish(), SERVER_URL);

	assert.notEqual(await db.table("deviceIdentity").get("device-1"), undefined);
	assert.notEqual(await db.table("discoveryProfiles").get("someone-else"), undefined);
	assert.notEqual(await db.table("syncState").get("ws://x"), undefined);
});

test("deleteAccountEverywhere: сеть НЕДОСТУПНА (publish/fetch падают) — локальный вайп ВСЁ РАВНО доводится до конца, функция не бросает", async () => {
	await db.table("keystore").put({ id: ALICE_PUB, login: "alice", salt: new Uint8Array(1), iv: new Uint8Array(1), ciphertext: new Uint8Array(1) });
	await db.table("messages").add({ ownerPubkey: ALICE_PUB, chatId: "c1", msgId: "m1", id: "m1", lamportTs: 1, senderPubkey: ALICE_PUB, status: "sent", deleted: false });
	await createChannel(ALICE_PUB, ALICE_PRIV, DB_KEY_A, { name: "Канал Алисы" }, [], capturingPublish([]));

	await assert.doesNotReject(() => deleteAccountEverywhere(ALICE_PUB, ALICE_PRIV, DB_KEY_A, "alice", failingPublish(), "https://unreachable.invalid"));

	assert.equal(await db.table("messages").where("ownerPubkey").equals(ALICE_PUB).count(), 0);
	assert.equal(await db.table("channels").where("ownerPubkey").equals(ALICE_PUB).count(), 0, "channels — owner-scoped таблица, чистится общим проходом даже если deleteChannel() сетевой шаг упал");
	assert.equal(await db.table("keystore").get(ALICE_PUB), undefined);
});

test("deleteAccountEverywhere: сеть ДОСТУПНА — переиздаёт tombstone-профиль, удаляет владельческий канал (kind-5), удаляет блобы своих файлов с Blossom", async () => {
	const { fetchImpl, store } = makeFakeBlossom();
	await db.table("keystore").put({ id: ALICE_PUB, login: "alice", salt: new Uint8Array(1), iv: new Uint8Array(1), ciphertext: new Uint8Array(1) });

	const manifestDigest = await seedFileFor(ALICE_PUB, DB_KEY_A, fetchImpl);
	await createChannel(ALICE_PUB, ALICE_PRIV, DB_KEY_A, { name: "Канал Алисы" }, [], capturingPublish([]));

	const published = [];
	await deleteAccountEverywhere(ALICE_PUB, ALICE_PRIV, DB_KEY_A, "alice", capturingPublish(published), SERVER_URL, { fetchImpl });

	// tombstone-профиль (kind 0, имя с пометкой).
	const profileEvent = published.find((e) => e.kind === 0);
	assert.ok(profileEvent, "должен опубликовать kind 0");
	assert.match(JSON.parse(profileEvent.content).name, /удалённый аккаунт/);

	// kind-5 адресуемое удаление владельческого канала.
	const delEvent = published.find((e) => e.kind === 5);
	assert.ok(delEvent, "должен опубликовать kind-5 удаление канала");

	// Блоб файла реально удалён с (фейкового) Blossom-сервера.
	assert.equal(store.has(manifestDigest), false, "манифест файла должен быть удалён с сервера");
});

test("deleteAccountEverywhere: адверсарная проверка — если бы wipeLocalData ошибочно чистила ПО ownerPubkey='undefined' (баг подстановки), тест поймал бы чужие данные исчезнувшими", async () => {
	// Регрессионный тест на класс бага, который этот проект ловил многократно
	// (этапы 25/30/31/36/43/53, см. комментарии database.js): убеждаемся, что
	// удаление ОДНОГО владельца использует именно его pubkey, а не какой-то
	// глобальный/пустой ключ, который случайно совпал бы с чужими строками.
	await seedRepresentativeData(BOB_PUB, BOB_PUB);
	await db.table("keystore").put({ id: ALICE_PUB, login: "alice", salt: new Uint8Array(1), iv: new Uint8Array(1), ciphertext: new Uint8Array(1) });
	// Алиса не имеет НИ ОДНОЙ строки нигде — вайп должен быть no-op для неё
	// и НЕ должен зацепить существующие данные Боба.
	await deleteAccountEverywhere(ALICE_PUB, ALICE_PRIV, DB_KEY_A, "alice", failingPublish(), SERVER_URL);

	assert.equal(await db.table("messages").where("ownerPubkey").equals(BOB_PUB).count(), 1);
	assert.equal(await db.table("groups").where("owner").equals(BOB_PUB).count(), 1);
	assert.equal(await db.table("groupMembers").where("groupId").equals(`g1-${BOB_PUB}`).count(), 1);
	assert.equal(await db.table("events").filter((e) => e.pubkey === BOB_PUB).count(), 1);
});
