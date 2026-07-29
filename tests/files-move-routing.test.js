import "fake-indexeddb/auto";
import { test, before, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { db } from "../src/core/store/database.js";
import { bytesToHex } from "@noble/hashes/utils.js";
import { getPublicKey } from "../src/core/crypto/keys.js";
import { decryptSubtreeOp } from "../src/core/crypto/share-key.js";
import { share, FILE_SUBTREE_OP_KIND } from "../src/domain/files/share.js";
import { getShareKey, loadGrantsIndex, loadShareMeta } from "../src/domain/files/store.js";
import { routeMove } from "../src/domain/files/move-routing.js";
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
	counter = 0;
});

function makeFakePublish(published) {
	return async (event) => {
		published.push(event);
		return { ok: true };
	};
}

// ROOT/ShareA/{X/Y}, ROOT/ShareB — ShareA расшарена Alice, ShareB — Bob,
// не пересекаются (ни один узел общий предок для обеих долей).
async function buildTwoShares() {
	let S = createInitialState();
	const shareA = "n-shareA";
	S = applyOp(S, createFolder(S, ROOT_ID, "ShareA", shareA, label()));
	const x = "n-x";
	S = applyOp(S, createFolder(S, shareA, "X", x, label()));
	const y = "n-y";
	S = applyOp(S, createFile(S, x, "Y.txt", y, "digest-y", label()));
	const shareB = "n-shareB";
	S = applyOp(S, createFolder(S, ROOT_ID, "ShareB", shareB, label()));

	await share(OWNER_PUB, OWNER_PRIV, dbKey, S, shareA, [ALICE_PUB], label(), makeFakePublish([]));
	await share(OWNER_PUB, OWNER_PRIV, dbKey, S, shareB, [BOB_PUB], label(), makeFakePublish([]));

	const grantsIndex = await loadGrantsIndex(OWNER_PUB);
	return { S, shareA, shareB, x, y, grantsIndex };
}

function eventsFor(published, rootId) {
	return published.filter((e) => e.tags.some((t) => t[0] === "h" && t[1] === rootId));
}

async function decryptOne(rootId, event) {
	const meta = await loadShareMeta(OWNER_PUB, rootId, dbKey);
	const keyHex = await getShareKey(OWNER_PUB, rootId, meta.currentVersion, dbKey);
	return JSON.parse(decryptSubtreeOp(event.content, { [meta.currentVersion]: keyHex }));
}

test("routeMove: move ЧЕРЕЗ границу непересекающихся долей -> leaving получает purge, entering получает СНИМОК ВСЕГО поддерева (включая потомков)", async () => {
	const { S, shareA, shareB, x, y, grantsIndex } = await buildTwoShares();
	const op = move(S, x, shareB, label());
	assert.ok(!(op instanceof Error));

	const published = [];
	await routeMove(OWNER_PUB, OWNER_PRIV, dbKey, grantsIndex, S, op, label(), makeFakePublish(published));

	const aliceEvents = eventsFor(published, shareA);
	assert.equal(aliceEvents.length, 1, "Alice (покидаемая доля) получает РОВНО одно событие");
	const aliceOps = await decryptOne(shareA, aliceEvents[0]);
	assert.deepEqual(aliceOps, [{ type: "purge", id: x }]);

	const bobEvents = eventsFor(published, shareB);
	assert.equal(bobEvents.length, 1, "Bob (входящая доля) получает РОВНО одно событие");
	const bobOps = await decryptOne(shareB, bobEvents[0]);
	assert.equal(bobOps.length, 2, "X + его потомок Y");
	const byId = Object.fromEntries(bobOps.map((o) => [o.id, o]));
	assert.equal(byId[x].parentId, shareB, "X получает РЕАЛЬНЫЙ новый родитель (корень доли Bob), не ROOT_ID");
	assert.equal(byId[x].name, "X");
	assert.equal(byId[y].parentId, x, "потомок Y сохраняет реальный parentId (X), сам X не переродителен внутри снимка");
	assert.equal(byId[y].name, "Y.txt");

	assert.equal(published.length, 2, "никаких лишних событий кому-либо ещё");
});

test("routeMove: move ВНУТРИ одной доли -> обычный setPar, БЕЗ purge/create", async () => {
	const { S, shareA, y, grantsIndex } = await buildTwoShares();
	const op = move(S, y, shareA, label()); // Y.txt: было n-x/Y.txt, стало прямо под ShareA

	const published = [];
	await routeMove(OWNER_PUB, OWNER_PRIV, dbKey, grantsIndex, S, op, label(), makeFakePublish(published));

	assert.equal(published.length, 1, "только ОДНО событие — доля не меняется, purge/create не нужны");
	const aliceOps = await decryptOne(shareA, published[0]);
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
	let S = createInitialState();
	const free = "n-free";
	S = applyOp(S, createFolder(S, ROOT_ID, "Free", free, label()));
	const w = "n-w";
	S = applyOp(S, createFolder(S, free, "W", w, label()));
	const shareA = "n-shareA2";
	S = applyOp(S, createFolder(S, ROOT_ID, "ShareA2", shareA, label()));

	await share(OWNER_PUB, OWNER_PRIV, dbKey, S, shareA, [ALICE_PUB], label(), makeFakePublish([]));
	const grantsIndex = await loadGrantsIndex(OWNER_PUB);

	const op = move(S, w, shareA, label());
	const published = [];
	await routeMove(OWNER_PUB, OWNER_PRIV, dbKey, grantsIndex, S, op, label(), makeFakePublish(published));

	assert.equal(published.length, 1);
	const ops = await decryptOne(shareA, published[0]);
	assert.equal(ops.length, 1);
	assert.equal(ops[0].id, w);
	assert.equal(ops[0].parentId, shareA);
});
