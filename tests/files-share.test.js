import "fake-indexeddb/auto";
import { test, before, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { db } from "../src/core/store/database.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex } from "@noble/hashes/utils.js";
import { getPublicKey } from "../src/core/crypto/keys.js";
import { decryptShareGrant, decryptSubtreeOp } from "../src/core/crypto/share-key.js";
import { loadShareMeta, getShareKey, listShareGrantees, saveFileKey } from "../src/domain/files/store.js";
import { share, revoke, snapshotSubtree, FILE_SHARE_GRANT_KIND, FILE_SUBTREE_OP_KIND } from "../src/domain/files/share.js";
import { putStream, getManifest, getRange } from "../src/domain/files/content.js";
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

const dbKey = crypto.getRandomValues(new Uint8Array(32));

before(async () => {
	await db.open();
});

beforeEach(async () => {
	await db.table("files_shares").clear();
	await db.table("files_shareKeys").clear();
	await db.table("files_shareGrantees").clear();
	await db.table("files_keys").clear();
	counter = 0;
});

function makeFakePublish(published) {
	return async (event) => {
		published.push(event);
		return { ok: true };
	};
}

// Фейковый Blossom с поддержкой Range — тот же приём, что files-content.test.js.
function makeFakeBlossom() {
	const store = new Map();
	async function sha256Hex(bytes) {
		return bytesToHex(sha256(bytes));
	}
	const fetchImpl = async (url, opts = {}) => {
		if (opts.method === "PUT") {
			const body = new Uint8Array(opts.body);
			const digest = await sha256Hex(body);
			store.set(digest, body);
			return { ok: true, status: 200, json: async () => ({ sha256: digest, size: body.length }), text: async () => "" };
		}
		const parts = url.split("/");
		const key = parts[parts.length - 1];
		const bytes = store.get(key);
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
	return { fetchImpl, store };
}

const netOpts = (fetchImpl) => ({ serverUrl: "https://blossom.test", privateKey: OWNER_PRIV, fetchImpl });

// Дерево: ROOT/Shared/{A.txt, Sub/B.txt} — Shared расшаривается целиком.
// A.txt/B.txt реально залиты на фейковый Blossom СВОИМ (владельца)
// случайным ключом, зарегистрированным в files_keys — иначе
// reuploadUnderShareKey (6.6b) не смог бы их прочитать, чтобы перезалить.
async function buildTree(fetchImpl) {
	let S = createInitialState();
	const shared = "n-shared";
	S = applyOp(S, createFolder(S, ROOT_ID, "Shared", shared, label()));

	const bytesA = new Uint8Array(300);
	crypto.getRandomValues(bytesA);
	const { manifestDigest: digestA, fileKey: fileKeyA } = await putStream(bytesA, { ...netOpts(fetchImpl), name: "A.txt", mime: "text/plain" });
	await saveFileKey(OWNER_PUB, dbKey, digestA, fileKeyA);
	const fileA = "n-a";
	S = applyOp(S, createFile(S, shared, "A.txt", fileA, digestA, label()));

	const sub = "n-sub";
	S = applyOp(S, createFolder(S, shared, "Sub", sub, label()));

	const bytesB = new Uint8Array(300);
	crypto.getRandomValues(bytesB);
	const { manifestDigest: digestB, fileKey: fileKeyB } = await putStream(bytesB, { ...netOpts(fetchImpl), name: "B.txt", mime: "text/plain" });
	await saveFileKey(OWNER_PUB, dbKey, digestB, fileKeyB);
	const fileB = "n-b";
	S = applyOp(S, createFile(S, sub, "B.txt", fileB, digestB, label()));

	return { S, shared, fileA, bytesA, digestA, sub, fileB, bytesB, digestB };
}

function grantEvents(published) {
	return published.filter((e) => e.kind === FILE_SHARE_GRANT_KIND);
}
function subtreeOpEvents(published) {
	return published.filter((e) => e.kind === FILE_SUBTREE_OP_KIND);
}

test("share: генерирует НОВЫЙ ключ версии 1, публикует грант каждому pubkey + ОДНО событие со снимком", async () => {
	const { fetchImpl } = makeFakeBlossom();
	const { S, shared } = await buildTree(fetchImpl);
	const published = [];
	await share(OWNER_PUB, OWNER_PRIV, dbKey, S, shared, [ALICE_PUB, BOB_PUB], label(), makeFakePublish(published), netOpts(fetchImpl));

	assert.equal(grantEvents(published).length, 2);
	assert.equal(subtreeOpEvents(published).length, 1, "снимок — ОДНО событие, не по одному на читателя (O(1), не O(k))");

	const meta = await loadShareMeta(OWNER_PUB, shared, dbKey);
	assert.equal(meta.currentVersion, 1);

	const grantees = await listShareGrantees(OWNER_PUB, shared);
	assert.deepEqual(new Set(grantees), new Set([ALICE_PUB, BOB_PUB]));
});

test("share: снимок содержит ВСЕ живые узлы поддерева, прямые дети переродителены на ROOT_ID, файлы честно перезалиты под производным ключом", async () => {
	const { fetchImpl } = makeFakeBlossom();
	const { S, shared, fileA, bytesA, digestA, sub, fileB, bytesB, digestB } = await buildTree(fetchImpl);
	const published = [];
	await share(OWNER_PUB, OWNER_PRIV, dbKey, S, shared, [ALICE_PUB], label(), makeFakePublish(published), netOpts(fetchImpl));

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

	assert.notEqual(byId[fileA].blob, digestA, "новый digest владельца — читатель НИКОГДА не видит блоб владельца напрямую (6.6b)");
	assert.notEqual(byId[fileB].blob, digestB);
	assert.ok(byId[fileA].plaintextDigest, "plaintextDigest — транзитное поле, нужно получателю для деривации ключа");

	// Читатель независимо пересчитывает fileKey и реально расшифровывает.
	const { deriveShareFileKey } = await import("../src/core/crypto/share-key.js");
	const derivedKeyA = deriveShareFileKey(subtreeKey, byId[fileA].plaintextDigest);
	const manifestA = await getManifest(byId[fileA].blob, netOpts(fetchImpl));
	const roundtripA = await getRange(manifestA, derivedKeyA, 0, manifestA.size, netOpts(fetchImpl));
	assert.deepEqual(roundtripA, bytesA);

	const derivedKeyB = deriveShareFileKey(subtreeKey, byId[fileB].plaintextDigest);
	const manifestB = await getManifest(byId[fileB].blob, netOpts(fetchImpl));
	const roundtripB = await getRange(manifestB, derivedKeyB, 0, manifestB.size, netOpts(fetchImpl));
	assert.deepEqual(roundtripB, bytesB);
});

test("share: грант расшифровывается получателем и даёт корректные nodeId/version/subtreeKey", async () => {
	const { fetchImpl } = makeFakeBlossom();
	const { S, shared } = await buildTree(fetchImpl);
	const published = [];
	await share(OWNER_PUB, OWNER_PRIV, dbKey, S, shared, [ALICE_PUB], label(), makeFakePublish(published), netOpts(fetchImpl));

	const aliceEvent = grantEvents(published)[0];
	const decrypted = decryptShareGrant(aliceEvent.content, ALICE_PRIV, OWNER_PUB);
	assert.equal(decrypted.nodeId, shared);
	assert.equal(decrypted.version, 1);

	const storedKey = await getShareKey(OWNER_PUB, shared, 1, dbKey);
	assert.equal(decrypted.subtreeKey, storedKey);
});

test("share: повторный вызов на УЖЕ расшаренный узел переиспользует ТЕКУЩИЙ ключ, не ротирует", async () => {
	const { fetchImpl } = makeFakeBlossom();
	const { S, shared } = await buildTree(fetchImpl);
	await share(OWNER_PUB, OWNER_PRIV, dbKey, S, shared, [ALICE_PUB], label(), makeFakePublish([]), netOpts(fetchImpl));
	const keyAfterFirst = await getShareKey(OWNER_PUB, shared, 1, dbKey);

	const published2 = [];
	await share(OWNER_PUB, OWNER_PRIV, dbKey, S, shared, [BOB_PUB], label(), makeFakePublish(published2), netOpts(fetchImpl));

	const meta = await loadShareMeta(OWNER_PUB, shared, dbKey);
	assert.equal(meta.currentVersion, 1, "добавление читателя не должно бампать версию/ротировать ключ");
	const keyAfterSecond = await getShareKey(OWNER_PUB, shared, 1, dbKey);
	assert.equal(keyAfterFirst, keyAfterSecond);

	const bobDecrypted = decryptShareGrant(grantEvents(published2)[0].content, BOB_PRIV, OWNER_PUB);
	assert.equal(bobDecrypted.subtreeKey, keyAfterFirst, "новый читатель получает ТОТ ЖЕ ключ, что уже был");
});

test("share: идемпотентно — уже имеющий грант этой версии pubkey не переспрашивается, и снимок НЕ шлётся, если новых читателей нет", async () => {
	const { fetchImpl } = makeFakeBlossom();
	const { S, shared } = await buildTree(fetchImpl);
	await share(OWNER_PUB, OWNER_PRIV, dbKey, S, shared, [ALICE_PUB], label(), makeFakePublish([]), netOpts(fetchImpl));

	const published2 = [];
	await share(OWNER_PUB, OWNER_PRIV, dbKey, S, shared, [ALICE_PUB], label(), makeFakePublish(published2), netOpts(fetchImpl));

	assert.equal(published2.length, 0, "ни гранта (Alice уже есть), ни снимка (новых читателей нет)");
});

test("share: гранты РАЗНЫХ читателей имеют РАЗНЫЕ d-теги (П-А, CONTRACTS.md — иначе второй читатель замещает грант первого на relay, буквальный повтор бага этапа 32)", async () => {
	const { fetchImpl } = makeFakeBlossom();
	const { S, shared } = await buildTree(fetchImpl);
	const published = [];
	await share(OWNER_PUB, OWNER_PRIV, dbKey, S, shared, [ALICE_PUB, BOB_PUB], label(), makeFakePublish(published), netOpts(fetchImpl));

	const events = grantEvents(published);
	assert.equal(events.length, 2);
	const dTags = events.map((e) => e.tags.find((t) => t[0] === "d")?.[1]);
	assert.ok(dTags[0], "d-тег обязан присутствовать");
	assert.ok(dTags[1], "d-тег обязан присутствовать");
	assert.notEqual(dTags[0], dTags[1], "d-теги разных читателей не должны совпадать");
});

test("revoke: ротирует ключ (версия+1), переиздаёт ОСТАВШИМСЯ читателям, ОТОЗВАННЫЙ новую версию не получает", async () => {
	const { fetchImpl } = makeFakeBlossom();
	const { S, shared } = await buildTree(fetchImpl);
	await share(OWNER_PUB, OWNER_PRIV, dbKey, S, shared, [ALICE_PUB, BOB_PUB], label(), makeFakePublish([]), netOpts(fetchImpl));

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
	const { fetchImpl } = makeFakeBlossom();
	const { S, shared } = await buildTree(fetchImpl);
	await share(OWNER_PUB, OWNER_PRIV, dbKey, S, shared, [ALICE_PUB], label(), makeFakePublish([]), netOpts(fetchImpl));
	const v1Key = await getShareKey(OWNER_PUB, shared, 1, dbKey);

	await revoke(OWNER_PUB, OWNER_PRIV, dbKey, shared, ALICE_PUB, makeFakePublish([]));

	const v1KeyAfterRevoke = await getShareKey(OWNER_PUB, shared, 1, dbKey);
	assert.equal(v1KeyAfterRevoke, v1Key, "версия 1 остаётся читаемой локально после revoke");
	const v2Key = await getShareKey(OWNER_PUB, shared, 2, dbKey);
	assert.notEqual(v2Key, v1Key);
});

test("snapshotSubtree: пустая папка -> пустой список операций", async () => {
	let S = createInitialState();
	const empty = "n-empty";
	S = applyOp(S, createFolder(S, ROOT_ID, "Empty", empty, label()));
	const ops = await snapshotSubtree(OWNER_PUB, dbKey, S, empty, "aa".repeat(32), label());
	assert.deepEqual(ops, []);
});
