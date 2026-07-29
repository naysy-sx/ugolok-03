import "fake-indexeddb/auto";
import { test, before } from "node:test";
import assert from "node:assert/strict";
import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex } from "@noble/hashes/utils.js";
import { getPublicKey } from "../src/core/crypto/keys.js";
import { sign } from "../src/core/crypto/sign.js";
import { generateSubtreeKey, encryptShareGrant, encryptSubtreeOp } from "../src/core/crypto/share-key.js";
import { putStream, getManifest, getRange } from "../src/domain/files/content.js";
import { saveToOwn } from "../src/domain/files/save-to-own.js";
import { snapshotSubtree, FILE_SUBTREE_OP_KIND } from "../src/domain/files/share.js";
import { mount, applyMountSubtreeEvent, resolveMountFileKey } from "../src/domain/files/mount.js";
import { createInitialState, applyOp, ROOT_ID, liveChildrenOf, project } from "../src/domain/files/tree.js";
import { createFolder, createFile } from "../src/domain/files/ops.js";
import { db } from "../src/core/store/database.js";
import { getFileKey, saveFileKey } from "../src/domain/files/store.js";

const OWNER_PRIV = new Uint8Array(32).fill(9);
const ALICE_PRIV = new Uint8Array(32).fill(11);
const ALICE_PUB = bytesToHex(getPublicKey(ALICE_PRIV));

let counter = 0;
function label() {
	counter += 1;
	return { counter, deviceId: "device-a" };
}

const dbKey = crypto.getRandomValues(new Uint8Array(32));

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
		const sha256HexKey = parts[parts.length - 1];
		const bytes = store.get(sha256HexKey);
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

before(async () => {
	await db.open();
});

const netOpts = () => ({ serverUrl: "https://blossom.test", privateKey: OWNER_PRIV });

// Загружает файл на фейковый Blossom КАК ВЛАДЕЛЕЦ (эмулирует уже
// существующий в доле файл) — возвращает {manifest, manifestDigest, fileKey}
// для последующего resolveFileKey в тестах.
async function seedOwnerFile(fetchImpl, bytes, name) {
	const { manifest, manifestDigest, fileKey } = await putStream(bytes, { ...netOpts(), name, mime: "application/octet-stream", fetchImpl });
	return { manifest, manifestDigest, fileKey };
}

test("saveToOwn: одиночный файл — новый digest, новый fileKey, содержимое совпадает с оригиналом", async () => {
	const { fetchImpl } = makeFakeBlossom();
	const original = new Uint8Array(3000);
	crypto.getRandomValues(original);
	const { manifestDigest, fileKey } = await seedOwnerFile(fetchImpl, original, "video.bin");

	let mountState = createInitialState();
	mountState = applyOp(mountState, createFile(mountState, ROOT_ID, "video.bin", "n-src", manifestDigest, label()));

	const destTree = createInitialState();
	const newIds = new Map([["n-src", "n-dst"]]);
	const resolveFileKey = async () => fileKey;

	const ops = await saveToOwn(ALICE_PUB, dbKey, mountState, "n-src", destTree, ROOT_ID, newIds, resolveFileKey, label(), { ...netOpts(), fetchImpl });

	assert.equal(ops.length, 1);
	assert.equal(ops[0].id, "n-dst");
	assert.equal(ops[0].kind, "file");
	assert.notEqual(ops[0].blob, manifestDigest, "новый digest — не переиспользует блоб владельца");

	const newFileKey = await getFileKey(ALICE_PUB, dbKey, ops[0].blob);
	assert.ok(newFileKey);
	assert.notDeepEqual(newFileKey, fileKey, "новый fileKey, не переиспользует ключ владельца");

	const newManifest = await getManifest(ops[0].blob, { ...netOpts(), fetchImpl });
	const { getRange } = await import("../src/domain/files/content.js");
	const roundtrip = await getRange(newManifest, newFileKey, 0, newManifest.size, { ...netOpts(), fetchImpl });
	assert.deepEqual(roundtrip, original);
});

test("saveToOwn: папка с вложенными папкой/файлом — рекурсивный обход, пустая папка не делает сетевых вызовов", async () => {
	const { fetchImpl } = makeFakeBlossom();
	const bytes = new Uint8Array(500);
	crypto.getRandomValues(bytes);
	const { manifestDigest, fileKey } = await seedOwnerFile(fetchImpl, bytes, "leaf.bin");

	let mountState = createInitialState();
	mountState = applyOp(mountState, createFolder(mountState, ROOT_ID, "Top", "n-top", label()));
	mountState = applyOp(mountState, createFolder(mountState, "n-top", "Empty", "n-empty", label()));
	mountState = applyOp(mountState, createFile(mountState, "n-top", "leaf.bin", "n-leaf", manifestDigest, label()));

	const destTree = createInitialState();
	const newIds = new Map([
		["n-top", "d-top"],
		["n-empty", "d-empty"],
		["n-leaf", "d-leaf"],
	]);
	let resolveCalls = 0;
	const resolveFileKey = async () => {
		resolveCalls += 1;
		return fileKey;
	};

	const ops = await saveToOwn(ALICE_PUB, dbKey, mountState, "n-top", destTree, ROOT_ID, newIds, resolveFileKey, label(), { ...netOpts(), fetchImpl });

	assert.equal(ops.length, 3);
	assert.equal(resolveCalls, 1, "resolveFileKey вызван РОВНО для файлов, не для пустой папки");

	const byId = Object.fromEntries(ops.map((o) => [o.id, o]));
	assert.equal(byId["d-top"].parentId, ROOT_ID);
	assert.equal(byId["d-top"].kind, "dir");
	assert.equal(byId["d-empty"].parentId, "d-top");
	assert.equal(byId["d-empty"].kind, "dir");
	assert.equal(byId["d-empty"].blob, null);
	assert.equal(byId["d-leaf"].parentId, "d-top");
	assert.equal(byId["d-leaf"].kind, "file");
	assert.notEqual(byId["d-leaf"].blob, manifestDigest);
});

test("saveToOwn: коллизия имени КОРНЯ копии в целевой папке -> суффикс \" (копия)\", потомки без суффиксов", async () => {
	const { fetchImpl } = makeFakeBlossom();
	let mountState = createInitialState();
	mountState = applyOp(mountState, createFolder(mountState, ROOT_ID, "Docs", "n-docs", label()));

	let destTree = createInitialState();
	destTree = applyOp(destTree, createFolder(destTree, ROOT_ID, "Docs", "n-existing", label()));

	const newIds = new Map([["n-docs", "d-docs"]]);
	const ops = await saveToOwn(ALICE_PUB, dbKey, mountState, "n-docs", destTree, ROOT_ID, newIds, async () => {
		throw new Error("не должен вызываться — папка без файлов");
	}, label(), { ...netOpts(), fetchImpl });

	assert.equal(ops.length, 1);
	assert.equal(ops[0].name, "Docs (копия)");
});

test("saveToOwn: origin узла-источника сохраняется в новом узле", async () => {
	const { fetchImpl } = makeFakeBlossom();
	let mountState = createInitialState();
	const op = createFile(mountState, ROOT_ID, "a.txt", "n-a", "digest-placeholder", label(), "chat-attachment");
	mountState = applyOp(mountState, op);
	// Подменяем blob на реально существующий на фейковом сервере (origin тест не про сеть).
	const bytes = new Uint8Array(10);
	const { manifestDigest, fileKey } = await seedOwnerFile(fetchImpl, bytes, "a.txt");
	mountState.nodes.get("n-a").blob = manifestDigest;

	const destTree = createInitialState();
	const newIds = new Map([["n-a", "d-a"]]);
	const ops = await saveToOwn(ALICE_PUB, dbKey, mountState, "n-a", destTree, ROOT_ID, newIds, async () => fileKey, label(), { ...netOpts(), fetchImpl });

	assert.equal(ops[0].origin, "chat-attachment");
});

test("saveToOwn: onProgress вызывается с filesDone/filesTotal по мере копирования файлов", async () => {
	const { fetchImpl } = makeFakeBlossom();
	const seededA = await seedOwnerFile(fetchImpl, new Uint8Array(10), "a.txt");
	const seededB = await seedOwnerFile(fetchImpl, new Uint8Array(10), "b.txt");

	let mountState = createInitialState();
	mountState = applyOp(mountState, createFolder(mountState, ROOT_ID, "Top", "n-top", label()));
	mountState = applyOp(mountState, createFile(mountState, "n-top", "a.txt", "n-a", seededA.manifestDigest, label()));
	mountState = applyOp(mountState, createFile(mountState, "n-top", "b.txt", "n-b", seededB.manifestDigest, label()));

	const destTree = createInitialState();
	const newIds = new Map([
		["n-top", "d-top"],
		["n-a", "d-a"],
		["n-b", "d-b"],
	]);
	const resolveFileKey = async (node) => (node.id === "n-a" ? seededA.fileKey : seededB.fileKey);
	const progressCalls = [];

	await saveToOwn(ALICE_PUB, dbKey, mountState, "n-top", destTree, ROOT_ID, newIds, resolveFileKey, label(), {
		...netOpts(),
		fetchImpl,
		onProgress: (p) => progressCalls.push({ ...p }),
	});

	assert.equal(progressCalls.length, 2);
	assert.deepEqual(progressCalls[0], { filesDone: 1, filesTotal: 2 });
	assert.deepEqual(progressCalls[1], { filesDone: 2, filesTotal: 2 });
});

test("saveToOwn: полный пайплайн share() -> mount() -> applyMountSubtreeEvent() -> resolveMountFileKey() -> saveToOwn() — гап 6.6 закрыт end-to-end (этап 53 И6, задача 6.6b)", async () => {
	const { fetchImpl } = makeFakeBlossom();

	let ownerTree = createInitialState();
	const sharedFolder = "n-e2e-shared";
	ownerTree = applyOp(ownerTree, createFolder(ownerTree, ROOT_ID, "E2E", sharedFolder, label()));
	const bytesOriginal = new Uint8Array(400);
	crypto.getRandomValues(bytesOriginal);
	const seeded = await seedOwnerFile(fetchImpl, bytesOriginal, "doc.bin");
	const OWNER_PUB = bytesToHex(getPublicKey(OWNER_PRIV));
	await saveFileKey(OWNER_PUB, dbKey, seeded.manifestDigest, seeded.fileKey);
	const fileNodeId = "n-e2e-doc";
	ownerTree = applyOp(ownerTree, createFile(ownerTree, sharedFolder, "doc.bin", fileNodeId, seeded.manifestDigest, label()));

	const version = 1;
	const subtreeKeyHex = bytesToHex(generateSubtreeKey());
	const grantContent = encryptShareGrant(sharedFolder, subtreeKeyHex, version, OWNER_PRIV, ALICE_PUB);
	const grantEvent = sign({ kind: 30075, content: grantContent, tags: [["d", "e2e"], ["p", ALICE_PUB]], created_at: 1 }, OWNER_PRIV);
	const snapshotOps = await snapshotSubtree(OWNER_PUB, dbKey, ownerTree, sharedFolder, subtreeKeyHex, label(), { ...netOpts(), fetchImpl });
	const snapshotContent = encryptSubtreeOp(JSON.stringify(snapshotOps), subtreeKeyHex, version);
	const snapshotEvent = sign({ kind: FILE_SUBTREE_OP_KIND, content: snapshotContent, tags: [["h", sharedFolder]], created_at: 2 }, OWNER_PRIV);

	let recipientTree = createInitialState();
	const { treeState } = await mount(ALICE_PUB, ALICE_PRIV, dbKey, recipientTree, grantEvent, ROOT_ID, "От владельца: E2E", "n-e2e-mount", label());
	recipientTree = treeState;
	const mountState = await applyMountSubtreeEvent(ALICE_PUB, dbKey, "n-e2e-mount", snapshotEvent);

	const destTree = createInitialState();
	const newIds = new Map([[fileNodeId, "n-e2e-own-copy"]]);
	const resolveFileKey = (node) => resolveMountFileKey(ALICE_PUB, dbKey, "n-e2e-mount", node.id);

	const ops = await saveToOwn(ALICE_PUB, dbKey, mountState, fileNodeId, destTree, ROOT_ID, newIds, resolveFileKey, label(), { ...netOpts(), fetchImpl });

	assert.equal(ops.length, 1);
	assert.notEqual(ops[0].blob, seeded.manifestDigest, "своя копия — новый digest, не ссылка на блоб владельца");

	const ownFileKey = await getFileKey(ALICE_PUB, dbKey, ops[0].blob);
	const ownManifest = await getManifest(ops[0].blob, { ...netOpts(), fetchImpl });
	const roundtrip = await getRange(ownManifest, ownFileKey, 0, ownManifest.size, { ...netOpts(), fetchImpl });
	assert.deepEqual(roundtrip, bytesOriginal, "Alice владеет РАБОЧЕЙ копией целиком, независимо от владельца/доли");
});
