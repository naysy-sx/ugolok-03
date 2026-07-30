import "fake-indexeddb/auto";
import { test, before, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { db } from "../src/core/store/database.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex } from "@noble/hashes/utils.js";
import { getPublicKey } from "../src/core/crypto/keys.js";
import { dbKeySig } from "../src/ui/signals/auth.js";
import { initFiles, createFolder, openFolder } from "../src/ui/signals/files.js";
import { sharedNodeIds, initShares, shareFolder, revokeAccess, listGrantees } from "../src/ui/signals/shares.js";

const OWNER_PRIV = new Uint8Array(32).fill(30);
const OWNER_PUB = bytesToHex(getPublicKey(OWNER_PRIV));
const ALICE_PUB = bytesToHex(getPublicKey(new Uint8Array(32).fill(31)));
const BOB_PUB = bytesToHex(getPublicKey(new Uint8Array(32).fill(32)));

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
		return { ok: true, status: 200, arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) };
	};
	return { fetchImpl };
}

function makeFakePublish(published) {
	return async (event) => {
		published.push(event);
		return { ok: true };
	};
}

before(async () => {
	await db.open();
});

beforeEach(async () => {
	await db.table("files_nodes").clear();
	await db.table("clock").clear();
	await db.table("files_shares").clear();
	await db.table("files_shareKeys").clear();
	await db.table("files_shareGrantees").clear();
	dbKeySig.value = crypto.getRandomValues(new Uint8Array(32));
	sharedNodeIds.value = new Set();
	await initFiles(OWNER_PUB);
});

test("shareFolder: помечает узел в sharedNodeIds, revokeAccess снимает пометку, когда читателей не осталось", async () => {
	const { fetchImpl } = makeFakeBlossom();
	const folder = await createFolder("Общая папка");
	openFolder(folder.id);

	const published = [];
	const result = await shareFolder(OWNER_PUB, OWNER_PRIV, dbKeySig.value, folder.id, [ALICE_PUB, BOB_PUB], makeFakePublish(published), { serverUrl: "https://blossom.test", privateKey: OWNER_PRIV, fetchImpl });

	assert.ok(!(result instanceof Error));
	assert.ok(sharedNodeIds.value.has(folder.id));
	assert.deepEqual(new Set(await listGrantees(OWNER_PUB, folder.id)), new Set([ALICE_PUB, BOB_PUB]));

	await revokeAccess(OWNER_PUB, OWNER_PRIV, dbKeySig.value, folder.id, ALICE_PUB, makeFakePublish([]));
	assert.ok(sharedNodeIds.value.has(folder.id), "остался Bob — папка всё ещё расшарена");

	await revokeAccess(OWNER_PUB, OWNER_PRIV, dbKeySig.value, folder.id, BOB_PUB, makeFakePublish([]));
	assert.ok(!sharedNodeIds.value.has(folder.id), "читателей не осталось — пометка снята");
});

test("initShares: восстанавливает sharedNodeIds из files_shares после 'перезагрузки'", async () => {
	const { fetchImpl } = makeFakeBlossom();
	const folder = await createFolder("Общая папка");
	openFolder(folder.id);
	await shareFolder(OWNER_PUB, OWNER_PRIV, dbKeySig.value, folder.id, [ALICE_PUB], makeFakePublish([]), { serverUrl: "https://blossom.test", privateKey: OWNER_PRIV, fetchImpl });

	sharedNodeIds.value = new Set(); // эмулируем "новую вкладку"
	await initShares(OWNER_PUB);

	assert.ok(sharedNodeIds.value.has(folder.id));
});
