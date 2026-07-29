import "fake-indexeddb/auto";
import { test, before, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { db } from "../src/core/store/database.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex } from "@noble/hashes/utils.js";
import { getPublicKey } from "../src/core/crypto/keys.js";
import { decryptSubtreeOp, deriveShareFileKey } from "../src/core/crypto/share-key.js";
import { share, FILE_SUBTREE_OP_KIND } from "../src/domain/files/share.js";
import { getShareKey, loadGrantsIndex, loadShareMeta, saveFileKey } from "../src/domain/files/store.js";
import { routeMove } from "../src/domain/files/move-routing.js";
import { putStream, getManifest, getRange } from "../src/domain/files/content.js";
import { createInitialState, applyOp, ROOT_ID } from "../src/domain/files/tree.js";
import { createFolder, createFile, move } from "../src/domain/files/ops.js";

const OWNER_PRIV = new Uint8Array(32).fill(6);
const OWNER_PUB = bytesToHex(getPublicKey(OWNER_PRIV));
const ALICE_PRIV = new Uint8Array(32).fill(7);
const ALICE_PUB = bytesToHex(getPublicKey(ALICE_PRIV));
const BOB_PRIV = new Uint8Array(32).fill(8);
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
	return { fetchImpl };
}

const netOpts = (fetchImpl) => ({ serverUrl: "https://blossom.test", privateKey: OWNER_PRIV, fetchImpl });

// ROOT/ShareA/{X/Y.txt}, ROOT/ShareB — ShareA расшарена Alice, ShareB — Bob,
// не пересекаются. Y.txt реально залит (владельца случайным ключом,
// зарегистрирован в files_keys) — нужен реальный контент для перезаливки
// 6.6b при entering-маршрутизации.
async function buildTwoShares(fetchImpl) {
	let S = createInitialState();
	const shareA = "n-shareA";
	S = applyOp(S, createFolder(S, ROOT_ID, "ShareA", shareA, label()));
	const x = "n-x";
	S = applyOp(S, createFolder(S, shareA, "X", x, label()));

	const bytesY = new Uint8Array(300);
	crypto.getRandomValues(bytesY);
	const { manifestDigest: digestY, fileKey: fileKeyY } = await putStream(bytesY, { ...netOpts(fetchImpl), name: "Y.txt", mime: "text/plain" });
	await saveFileKey(OWNER_PUB, dbKey, digestY, fileKeyY);
	const y = "n-y";
	S = applyOp(S, createFile(S, x, "Y.txt", y, digestY, label()));

	const shareB = "n-shareB";
	S = applyOp(S, createFolder(S, ROOT_ID, "ShareB", shareB, label()));

	await share(OWNER_PUB, OWNER_PRIV, dbKey, S, shareA, [ALICE_PUB], label(), makeFakePublish([]), netOpts(fetchImpl));
	await share(OWNER_PUB, OWNER_PRIV, dbKey, S, shareB, [BOB_PUB], label(), makeFakePublish([]), netOpts(fetchImpl));

	const grantsIndex = await loadGrantsIndex(OWNER_PUB);
	return { S, shareA, shareB, x, y, bytesY, digestY, grantsIndex };
}

function eventsFor(published, rootId) {
	return published.filter((e) => e.tags.some((t) => t[0] === "h" && t[1] === rootId));
}

async function decryptOne(rootId, event) {
	const meta = await loadShareMeta(OWNER_PUB, rootId, dbKey);
	const keyHex = await getShareKey(OWNER_PUB, rootId, meta.currentVersion, dbKey);
	return { ops: JSON.parse(decryptSubtreeOp(event.content, { [meta.currentVersion]: keyHex })), subtreeKeyHex: keyHex };
}

test("routeMove: move ЧЕРЕЗ границу непересекающихся долей -> leaving получает purge, entering получает СНИМОК ВСЕГО поддерева (включая потомков), файл честно перезалит", async () => {
	const { fetchImpl } = makeFakeBlossom();
	const { S, shareA, shareB, x, y, bytesY, grantsIndex } = await buildTwoShares(fetchImpl);
	const op = move(S, x, shareB, label());
	assert.ok(!(op instanceof Error));

	const published = [];
	await routeMove(OWNER_PUB, OWNER_PRIV, dbKey, grantsIndex, S, op, label(), makeFakePublish(published), netOpts(fetchImpl));

	const aliceEvents = eventsFor(published, shareA);
	assert.equal(aliceEvents.length, 1, "Alice (покидаемая доля) получает РОВНО одно событие");
	const { ops: aliceOps } = await decryptOne(shareA, aliceEvents[0]);
	assert.deepEqual(aliceOps, [{ type: "purge", id: x }]);

	const bobEvents = eventsFor(published, shareB);
	assert.equal(bobEvents.length, 1, "Bob (входящая доля) получает РОВНО одно событие");
	const { ops: bobOps, subtreeKeyHex: bobKey } = await decryptOne(shareB, bobEvents[0]);
	assert.equal(bobOps.length, 2, "X + его потомок Y");
	const byId = Object.fromEntries(bobOps.map((o) => [o.id, o]));
	assert.equal(byId[x].parentId, shareB, "X получает РЕАЛЬНЫЙ новый родитель (корень доли Bob), не ROOT_ID");
	assert.equal(byId[x].name, "X");
	assert.equal(byId[y].parentId, x, "потомок Y сохраняет реальный parentId (X), сам X не переродителен внутри снимка");
	assert.equal(byId[y].name, "Y.txt");
	assert.ok(byId[y].plaintextDigest, "файл честно перезалит — несёт plaintextDigest для деривации (6.6b)");

	const derivedKey = deriveShareFileKey(bobKey, byId[y].plaintextDigest);
	const manifest = await getManifest(byId[y].blob, netOpts(fetchImpl));
	const roundtrip = await getRange(manifest, derivedKey, 0, manifest.size, netOpts(fetchImpl));
	assert.deepEqual(roundtrip, bytesY, "Bob реально может расшифровать перезалитый файл своим производным ключом");

	assert.equal(published.length, 2, "никаких лишних событий кому-либо ещё");
});

test("routeMove: move ВНУТРИ одной доли -> обычный setPar, БЕЗ purge/create", async () => {
	const { fetchImpl } = makeFakeBlossom();
	const { S, shareA, y, grantsIndex } = await buildTwoShares(fetchImpl);
	const op = move(S, y, shareA, label()); // Y.txt: было n-x/Y.txt, стало прямо под ShareA

	const published = [];
	await routeMove(OWNER_PUB, OWNER_PRIV, dbKey, grantsIndex, S, op, label(), makeFakePublish(published), netOpts(fetchImpl));

	assert.equal(published.length, 1, "только ОДНО событие — доля не меняется, purge/create не нужны");
	const { ops: aliceOps } = await decryptOne(shareA, published[0]);
	assert.deepEqual(aliceOps, [{ type: "setPar", id: y, value: shareA, label: op.label }]);
});

test("routeMove: move узла ВНЕ всех долей в другой узел ВНЕ всех долей -> ни одного события", async () => {
	let S = createInitialState();
	const free1 = "n-free1";
	S = applyOp(S, createFolder(S, ROOT_ID, "Free1", free1, label()));
	const free2 = "n-free2";
	S = applyOp(S, createFolder(S, ROOT_ID, "Free2", free2, label()));
	const z = "n-z";
	S = applyOp(S, createFolder(S, free1, "Z", z, label()));

	const grantsIndex = await loadGrantsIndex(OWNER_PUB); // пусто — ничего не расшарено
	const op = move(S, z, free2, label());

	const published = [];
	await routeMove(OWNER_PUB, OWNER_PRIV, dbKey, grantsIndex, S, op, label(), makeFakePublish(published));

	assert.equal(published.length, 0);
});

test("routeMove: move ИЗ НЕ-доли В долю -> только entering (создание), leaving отсутствует", async () => {
	const { fetchImpl } = makeFakeBlossom();
	let S = createInitialState();
	const free = "n-free";
	S = applyOp(S, createFolder(S, ROOT_ID, "Free", free, label()));
	const w = "n-w";
	S = applyOp(S, createFolder(S, free, "W", w, label()));
	const shareA = "n-shareA2";
	S = applyOp(S, createFolder(S, ROOT_ID, "ShareA2", shareA, label()));

	await share(OWNER_PUB, OWNER_PRIV, dbKey, S, shareA, [ALICE_PUB], label(), makeFakePublish([]), netOpts(fetchImpl));
	const grantsIndex = await loadGrantsIndex(OWNER_PUB);

	const op = move(S, w, shareA, label());
	const published = [];
	await routeMove(OWNER_PUB, OWNER_PRIV, dbKey, grantsIndex, S, op, label(), makeFakePublish(published), netOpts(fetchImpl));

	assert.equal(published.length, 1);
	const { ops } = await decryptOne(shareA, published[0]);
	assert.equal(ops.length, 1);
	assert.equal(ops[0].id, w);
	assert.equal(ops[0].parentId, shareA);
});
