import "fake-indexeddb/auto";
import { test, before, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { db } from "../src/core/store/database.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex } from "@noble/hashes/utils.js";
import { getPublicKey } from "../src/core/crypto/keys.js";
import { sign } from "../src/core/crypto/sign.js";
import { generateSubtreeKey, encryptShareGrant, encryptSubtreeOp } from "../src/core/crypto/share-key.js";
import { dbKeySig } from "../src/ui/signals/auth.js";
import { initFiles, treeState, currentFolderId, openFolder, currentEntries } from "../src/ui/signals/files.js";
import {
	activeMounts,
	mountProjections,
	activeMountRootIds,
	initMounts,
	handleIncomingShareGrant,
	handleIncomingSubtreeEvent,
	ensureMountProjection,
	saveMountedItemToOwn,
	unmountShare,
} from "../src/ui/signals/mounts.js";
import { snapshotSubtree, FILE_SUBTREE_OP_KIND } from "../src/domain/files/share.js";
import { getManifest, getRange, putStream } from "../src/domain/files/content.js";
import { getFileKey, saveFileKey, getAllMountKeys } from "../src/domain/files/store.js";
import { createInitialState, applyOp, ROOT_ID } from "../src/domain/files/tree.js";
import { createFolder, createFile } from "../src/domain/files/ops.js";

const RECIPIENT_PRIV = new Uint8Array(32).fill(20);
const RECIPIENT_PUB = bytesToHex(getPublicKey(RECIPIENT_PRIV));
const OWNER_PRIV = new Uint8Array(32).fill(21);
const OWNER_PUB = bytesToHex(getPublicKey(OWNER_PRIV));

let counter = 0;
function ownerLabel() {
	counter += 1;
	return { counter, deviceId: "owner-device" };
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

before(async () => {
	await db.open();
});

beforeEach(async () => {
	await db.table("files_nodes").clear();
	await db.table("clock").clear();
	await db.table("files_keys").clear();
	await db.table("files_mounts").clear();
	await db.table("files_mountKeys").clear();
	await db.table("files_mount_nodes").clear();
	await db.table("files_mount_file_meta").clear();
	dbKeySig.value = crypto.getRandomValues(new Uint8Array(32));
	counter = 0;
	activeMounts.value = [];
	mountProjections.value = new Map();
	await initFiles(RECIPIENT_PUB);
});

// Владелец расшаривает "Shared" (A.txt) Alice — возвращает грант-событие и
// снимок-событие, как их увидела бы Alice (прямое переиспользование
// share.js's snapshotSubtree, честная перезаливка 6.6b).
async function buildIncomingShare(fetchImpl) {
	let S = createInitialState();
	const rootId = "n-owner-shared";
	S = applyOp(S, createFolder(S, ROOT_ID, "Shared", rootId, ownerLabel()));
	const bytesA = new Uint8Array(200);
	crypto.getRandomValues(bytesA);
	const { manifestDigest, fileKey } = await putStream(bytesA, { ...netOpts(fetchImpl), name: "A.txt", mime: "text/plain" });
	await saveFileKey(OWNER_PUB, dbKeySig.value, manifestDigest, fileKey);
	const fileA = "n-owner-a";
	S = applyOp(S, createFile(S, rootId, "A.txt", fileA, manifestDigest, ownerLabel()));

	const version = 1;
	const subtreeKeyHex = bytesToHex(generateSubtreeKey());
	const grantContent = encryptShareGrant(rootId, subtreeKeyHex, version, OWNER_PRIV, RECIPIENT_PUB);
	const grantEvent = sign({ kind: 30075, content: grantContent, tags: [["d", "irrelevant"], ["p", RECIPIENT_PUB]], created_at: 1 }, OWNER_PRIV);

	const snapshotOps = await snapshotSubtree(OWNER_PUB, dbKeySig.value, S, rootId, subtreeKeyHex, ownerLabel(), netOpts(fetchImpl));
	const snapshotContent = encryptSubtreeOp(JSON.stringify(snapshotOps), subtreeKeyHex, version);
	const snapshotEvent = sign({ kind: FILE_SUBTREE_OP_KIND, content: snapshotContent, tags: [["h", rootId]], created_at: 2 }, OWNER_PRIV);

	return { rootId, grantEvent, snapshotEvent, fileA, bytesA };
}

test("handleIncomingShareGrant: монтирует новую долю в дерево получателя, добавляет в activeMounts", async () => {
	const { fetchImpl } = makeFakeBlossom();
	const { rootId, grantEvent } = await buildIncomingShare(fetchImpl);

	await handleIncomingShareGrant(RECIPIENT_PUB, RECIPIENT_PRIV, dbKeySig.value, grantEvent, "Общая папка");

	assert.equal(activeMounts.value.length, 1);
	assert.equal(activeMounts.value[0].ownerPubkey, OWNER_PUB);
	assert.equal(activeMounts.value[0].rootId, rootId);
	assert.deepEqual(activeMountRootIds.value, [rootId]);

	const entries = currentEntries.value;
	assert.ok(entries.some((e) => e.displayName === "Общая папка"), "узел-ссылка виден в СВОЁМ дереве получателя");
});

test("handleIncomingShareGrant: повторный тот же грант (owner+rootId) -> идемпотентно, не создаёт вторую папку", async () => {
	const { fetchImpl } = makeFakeBlossom();
	const { grantEvent } = await buildIncomingShare(fetchImpl);

	await handleIncomingShareGrant(RECIPIENT_PUB, RECIPIENT_PRIV, dbKeySig.value, grantEvent, "Общая папка");
	await handleIncomingShareGrant(RECIPIENT_PUB, RECIPIENT_PRIV, dbKeySig.value, grantEvent, "Общая папка");

	assert.equal(activeMounts.value.length, 1, "второй такой же грант не монтирует повторно");
	assert.equal(currentEntries.value.filter((e) => e.displayName === "Общая папка").length, 1);
});

test("handleIncomingSubtreeEvent: применяет снимок к Mount.state, обновляет mountProjections ТОЛЬКО если долю уже смотрят", async () => {
	const { fetchImpl } = makeFakeBlossom();
	const { grantEvent, snapshotEvent, fileA } = await buildIncomingShare(fetchImpl);
	await handleIncomingShareGrant(RECIPIENT_PUB, RECIPIENT_PRIV, dbKeySig.value, grantEvent, "Общая папка");
	const mountId = activeMounts.value[0].mountId;

	await handleIncomingSubtreeEvent(RECIPIENT_PUB, dbKeySig.value, snapshotEvent);
	assert.ok(!mountProjections.value.has(mountId), "долю ещё не открывали — projection не пересчитывается зря");

	await ensureMountProjection(RECIPIENT_PUB, mountId);
	assert.ok(mountProjections.value.get(mountId).nodes.has(fileA));
});

test("handleIncomingSubtreeEvent: если долю уже смотрят, повторное событие обновляет projection 'на лету'", async () => {
	const { fetchImpl } = makeFakeBlossom();
	const { grantEvent, snapshotEvent, rootId } = await buildIncomingShare(fetchImpl);
	await handleIncomingShareGrant(RECIPIENT_PUB, RECIPIENT_PRIV, dbKeySig.value, grantEvent, "Общая папка");
	const mountId = activeMounts.value[0].mountId;
	await handleIncomingSubtreeEvent(RECIPIENT_PUB, dbKeySig.value, snapshotEvent);
	await ensureMountProjection(RECIPIENT_PUB, mountId);
	assert.equal(mountProjections.value.get(mountId).nodes.size, 4); // A.txt + $root/$trash/$lost+found

	// Второй, независимый create-оп той же доли (та же subtreeKey/версия,
	// найденная ранее в mount() через грант) — публикуется в реальности
	// share.js's routeMove/дальнейшие изменения (вне скоупа этого теста),
	// здесь достаточно синтетического валидного события.
	const keysByVersion = await getAllMountKeys(RECIPIENT_PUB, mountId, dbKeySig.value);
	const version = activeMounts.value[0].currentVersion;
	const nextOp = { type: "create", id: "n-owner-c", kind: "dir", blob: null, parentId: ROOT_ID, name: "C", origin: null, label: ownerLabel() };
	const nextContent = encryptSubtreeOp(JSON.stringify([nextOp]), keysByVersion[version], version);
	const nextEvent = sign({ kind: FILE_SUBTREE_OP_KIND, content: nextContent, tags: [["h", rootId]], created_at: 3 }, OWNER_PRIV);

	await handleIncomingSubtreeEvent(RECIPIENT_PUB, dbKeySig.value, nextEvent);
	assert.equal(mountProjections.value.get(mountId).nodes.size, 5, "projection обновилась без повторного ensureMountProjection");
});

test("saveMountedItemToOwn: копирует файл из доли в СВОЁ дерево, содержимое реально расшифровывается", async () => {
	const { fetchImpl } = makeFakeBlossom();
	const { grantEvent, snapshotEvent, fileA, bytesA } = await buildIncomingShare(fetchImpl);
	await handleIncomingShareGrant(RECIPIENT_PUB, RECIPIENT_PRIV, dbKeySig.value, grantEvent, "Общая папка");
	const mountId = activeMounts.value[0].mountId;
	await handleIncomingSubtreeEvent(RECIPIENT_PUB, dbKeySig.value, snapshotEvent);

	const netOptsRecipient = { serverUrl: "https://blossom.test", privateKey: RECIPIENT_PRIV, fetchImpl };
	const ops = await saveMountedItemToOwn(RECIPIENT_PUB, dbKeySig.value, mountId, fileA, ROOT_ID, netOptsRecipient);

	assert.equal(ops.length, 1);
	const entries = currentEntries.value;
	const savedEntry = entries.find((e) => e.displayName === "A.txt");
	assert.ok(savedEntry, "копия появилась в СВОЁМ дереве получателя");

	const ownFileKey = await getFileKey(RECIPIENT_PUB, dbKeySig.value, savedEntry.blob);
	const manifest = await getManifest(savedEntry.blob, netOptsRecipient);
	const roundtrip = await getRange(manifest, ownFileKey, 0, manifest.size, netOptsRecipient);
	assert.deepEqual(roundtrip, bytesA);
});

test("unmountShare: узел-ссылка исчезает из своего дерева, activeMounts/mountProjections очищены", async () => {
	const { fetchImpl } = makeFakeBlossom();
	const { grantEvent, snapshotEvent } = await buildIncomingShare(fetchImpl);
	await handleIncomingShareGrant(RECIPIENT_PUB, RECIPIENT_PRIV, dbKeySig.value, grantEvent, "Общая папка");
	const mountId = activeMounts.value[0].mountId;
	await handleIncomingSubtreeEvent(RECIPIENT_PUB, dbKeySig.value, snapshotEvent);
	await ensureMountProjection(RECIPIENT_PUB, mountId);

	await unmountShare(RECIPIENT_PUB, dbKeySig.value, mountId);

	assert.equal(activeMounts.value.length, 0);
	assert.ok(!mountProjections.value.has(mountId));
	assert.ok(!currentEntries.value.some((e) => e.displayName === "Общая папка"));

	const mountRows = await db.table("files_mounts").where("ownerPubkey").equals(RECIPIENT_PUB).toArray();
	assert.equal(mountRows.length, 0);
});

test("initMounts: восстанавливает activeMounts из files_mounts после 'перезагрузки'", async () => {
	const { fetchImpl } = makeFakeBlossom();
	const { grantEvent } = await buildIncomingShare(fetchImpl);
	await handleIncomingShareGrant(RECIPIENT_PUB, RECIPIENT_PRIV, dbKeySig.value, grantEvent, "Общая папка");

	activeMounts.value = []; // эмулируем "новую вкладку" — в памяти пусто
	await initMounts(RECIPIENT_PUB, dbKeySig.value);

	assert.equal(activeMounts.value.length, 1);
	assert.equal(activeMounts.value[0].ownerPubkey, OWNER_PUB);
});
