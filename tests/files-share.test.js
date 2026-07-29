import "fake-indexeddb/auto";
import { test, before, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { db } from "../src/core/store/database.js";
import { bytesToHex } from "@noble/hashes/utils.js";
import { getPublicKey } from "../src/core/crypto/keys.js";
import { decryptShareGrant, decryptSubtreeOp } from "../src/core/crypto/share-key.js";
import { loadShareMeta, getShareKey, listShareGrantees } from "../src/domain/files/store.js";
import { share, revoke, snapshotSubtree, FILE_SHARE_GRANT_KIND, FILE_SUBTREE_OP_KIND } from "../src/domain/files/share.js";
import { createInitialState, applyOp, ROOT_ID } from "../src/domain/files/tree.js";
import { createFolder, createFile } from "../src/domain/files/ops.js";

const OWNER_PRIV = new Uint8Array(32).fill(1);
const OWNER_PUB = bytesToHex(getPublicKey(OWNER_PRIV));
const ALICE_PRIV = new Uint8Array(32).fill(2);
const ALICE_PUB = bytesToHex(getPublicKey(ALICE_PRIV));
const BOB_PRIV = new Uint8Array(32).fill(3);
const BOB_PUB = bytesToHex(getPublicKey(BOB_PRIV));

let counter = 0;
function label() {
	counter += 1;
	return { counter, deviceId: "device-a" };
}

before(async () => {
	await db.open();
});

beforeEach(async () => {
	await db.table("files_shares").clear();
	await db.table("files_shareKeys").clear();
	await db.table("files_shareGrantees").clear();
	counter = 0;
});

function makeFakePublish(published) {
	return async (event) => {
		published.push(event);
		return { ok: true };
	};
}

// Дерево: ROOT/Shared/{A.txt, Sub/B.txt} — Shared расшаривается целиком.
function buildTree() {
	let S = createInitialState();
	const shared = "n-shared";
	S = applyOp(S, createFolder(S, ROOT_ID, "Shared", shared, label()));
	const fileA = "n-a";
	S = applyOp(S, createFile(S, shared, "A.txt", fileA, "digest-a", label()));
	const sub = "n-sub";
	S = applyOp(S, createFolder(S, shared, "Sub", sub, label()));
	const fileB = "n-b";
	S = applyOp(S, createFile(S, sub, "B.txt", fileB, "digest-b", label()));
	return { S, shared, fileA, sub, fileB };
}

function grantEvents(published) {
	return published.filter((e) => e.kind === FILE_SHARE_GRANT_KIND);
}
function subtreeOpEvents(published) {
	return published.filter((e) => e.kind === FILE_SUBTREE_OP_KIND);
}

test("share: генерирует НОВЫЙ ключ версии 1, публикует грант каждому pubkey + ОДНО событие со снимком", async () => {
	const { S, shared } = buildTree();
	const dbKey = crypto.getRandomValues(new Uint8Array(32));
	const published = [];
	await share(OWNER_PUB, OWNER_PRIV, dbKey, S, shared, [ALICE_PUB, BOB_PUB], label(), makeFakePublish(published));

	assert.equal(grantEvents(published).length, 2);
	assert.equal(subtreeOpEvents(published).length, 1, "снимок — ОДНО событие, не по одному на читателя (O(1), не O(k))");

	const meta = await loadShareMeta(OWNER_PUB, shared, dbKey);
	assert.equal(meta.currentVersion, 1);

	const grantees = await listShareGrantees(OWNER_PUB, shared);
	assert.deepEqual(new Set(grantees), new Set([ALICE_PUB, BOB_PUB]));
});

test("share: снимок содержит ВСЕ живые узлы поддерева, прямые дети переродителены на ROOT_ID", async () => {
	const { S, shared, fileA, sub, fileB } = buildTree();
	const dbKey = crypto.getRandomValues(new Uint8Array(32));
	const published = [];
	await share(OWNER_PUB, OWNER_PRIV, dbKey, S, shared, [ALICE_PUB], label(), makeFakePublish(published));

	const subtreeKey = await getShareKey(OWNER_PUB, shared, 1, dbKey);
	const snapshotEvent = subtreeOpEvents(published)[0];
	const opsJson = decryptSubtreeOp(snapshotEvent.content, { 1: subtreeKey });
	const ops = JSON.parse(opsJson);

	assert.equal(ops.length, 3); // A.txt, Sub, B.txt
	const byId = Object.fromEntries(ops.map((op) => [op.id, op]));
	assert.equal(byId[fileA].parentId, ROOT_ID, "прямой ребёнок shared -> parentId ROOT_ID");
	assert.equal(byId[sub].parentId, ROOT_ID);
	assert.equal(byId[fileB].parentId, sub, "внук сохраняет РЕАЛЬНЫЙ parentId (Sub), не переродителен");
	assert.equal(byId[fileA].name, "A.txt");
	assert.equal(byId[fileA].blob, "digest-a");
});

test("share: грант расшифровывается получателем и даёт корректные nodeId/version/subtreeKey", async () => {
	const { S, shared } = buildTree();
	const dbKey = crypto.getRandomValues(new Uint8Array(32));
	const published = [];
	await share(OWNER_PUB, OWNER_PRIV, dbKey, S, shared, [ALICE_PUB], label(), makeFakePublish(published));

	const aliceEvent = grantEvents(published)[0];
	const decrypted = decryptShareGrant(aliceEvent.content, ALICE_PRIV, OWNER_PUB);
	assert.equal(decrypted.nodeId, shared);
	assert.equal(decrypted.version, 1);

	const storedKey = await getShareKey(OWNER_PUB, shared, 1, dbKey);
	assert.equal(decrypted.subtreeKey, storedKey);
});

test("share: повторный вызов на УЖЕ расшаренный узел переиспользует ТЕКУЩИЙ ключ, не ротирует", async () => {
	const { S, shared } = buildTree();
	const dbKey = crypto.getRandomValues(new Uint8Array(32));
	await share(OWNER_PUB, OWNER_PRIV, dbKey, S, shared, [ALICE_PUB], label(), makeFakePublish([]));
	const keyAfterFirst = await getShareKey(OWNER_PUB, shared, 1, dbKey);

	const published2 = [];
	await share(OWNER_PUB, OWNER_PRIV, dbKey, S, shared, [BOB_PUB], label(), makeFakePublish(published2));

	const meta = await loadShareMeta(OWNER_PUB, shared, dbKey);
	assert.equal(meta.currentVersion, 1, "добавление читателя не должно бампать версию/ротировать ключ");
	const keyAfterSecond = await getShareKey(OWNER_PUB, shared, 1, dbKey);
	assert.equal(keyAfterFirst, keyAfterSecond);

	const bobDecrypted = decryptShareGrant(grantEvents(published2)[0].content, BOB_PRIV, OWNER_PUB);
	assert.equal(bobDecrypted.subtreeKey, keyAfterFirst, "новый читатель получает ТОТ ЖЕ ключ, что уже был");
});

test("share: идемпотентно — уже имеющий грант этой версии pubkey не переспрашивается, и снимок НЕ шлётся, если новых читателей нет", async () => {
	const { S, shared } = buildTree();
	const dbKey = crypto.getRandomValues(new Uint8Array(32));
	await share(OWNER_PUB, OWNER_PRIV, dbKey, S, shared, [ALICE_PUB], label(), makeFakePublish([]));

	const published2 = [];
	await share(OWNER_PUB, OWNER_PRIV, dbKey, S, shared, [ALICE_PUB], label(), makeFakePublish(published2));

	assert.equal(published2.length, 0, "ни гранта (Alice уже есть), ни снимка (новых читателей нет)");
});

test("share: гранты РАЗНЫХ читателей имеют РАЗНЫЕ d-теги (П-А, CONTRACTS.md — иначе второй читатель замещает грант первого на relay, буквальный повтор бага этапа 32)", async () => {
	const { S, shared } = buildTree();
	const dbKey = crypto.getRandomValues(new Uint8Array(32));
	const published = [];
	await share(OWNER_PUB, OWNER_PRIV, dbKey, S, shared, [ALICE_PUB, BOB_PUB], label(), makeFakePublish(published));

	const events = grantEvents(published);
	assert.equal(events.length, 2);
	const dTags = events.map((e) => e.tags.find((t) => t[0] === "d")?.[1]);
	assert.ok(dTags[0], "d-тег обязан присутствовать");
	assert.ok(dTags[1], "d-тег обязан присутствовать");
	assert.notEqual(dTags[0], dTags[1], "d-теги разных читателей не должны совпадать");
});

test("revoke: ротирует ключ (версия+1), переиздаёт ОСТАВШИМСЯ читателям, ОТОЗВАННЫЙ новую версию не получает", async () => {
	const { S, shared } = buildTree();
	const dbKey = crypto.getRandomValues(new Uint8Array(32));
	await share(OWNER_PUB, OWNER_PRIV, dbKey, S, shared, [ALICE_PUB, BOB_PUB], label(), makeFakePublish([]));

	const published = [];
	await revoke(OWNER_PUB, OWNER_PRIV, dbKey, shared, ALICE_PUB, makeFakePublish(published));

	const meta = await loadShareMeta(OWNER_PUB, shared, dbKey);
	assert.equal(meta.currentVersion, 2);

	assert.equal(published.length, 1, "только Bob получает грант v2 — Alice отозвана");
	const decrypted = decryptShareGrant(published[0].content, BOB_PRIV, OWNER_PUB);
	assert.equal(decrypted.version, 2);

	const grantees = await listShareGrantees(OWNER_PUB, shared);
	assert.deepEqual(grantees, [BOB_PUB]);
});

test("revoke: старая версия ключа НЕ удаляется — уже скачавший сохраняет доступ к эпохам ≤v_revoke (MATH.md §6.4)", async () => {
	const { S, shared } = buildTree();
	const dbKey = crypto.getRandomValues(new Uint8Array(32));
	await share(OWNER_PUB, OWNER_PRIV, dbKey, S, shared, [ALICE_PUB], label(), makeFakePublish([]));
	const v1Key = await getShareKey(OWNER_PUB, shared, 1, dbKey);

	await revoke(OWNER_PUB, OWNER_PRIV, dbKey, shared, ALICE_PUB, makeFakePublish([]));

	const v1KeyAfterRevoke = await getShareKey(OWNER_PUB, shared, 1, dbKey);
	assert.equal(v1KeyAfterRevoke, v1Key, "версия 1 остаётся читаемой локально после revoke");
	const v2Key = await getShareKey(OWNER_PUB, shared, 2, dbKey);
	assert.notEqual(v2Key, v1Key);
});

test("snapshotSubtree: пустая папка -> пустой список операций", () => {
	let S = createInitialState();
	const empty = "n-empty";
	S = applyOp(S, createFolder(S, ROOT_ID, "Empty", empty, label()));
	assert.deepEqual(snapshotSubtree(S, empty, label()), []);
});
