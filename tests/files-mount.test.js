import "fake-indexeddb/auto";
import { test, before, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { db } from "../src/core/store/database.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex } from "@noble/hashes/utils.js";
import { getPublicKey } from "../src/core/crypto/keys.js";
import { sign } from "../src/core/crypto/sign.js";
import { generateSubtreeKey, encryptShareGrant, encryptSubtreeOp } from "../src/core/crypto/share-key.js";
import { FILE_SUBTREE_OP_KIND, snapshotSubtree } from "../src/domain/files/share.js";
import { mount, applyMountSubtreeEvent, unmount, resolveMountFileKey } from "../src/domain/files/mount.js";
import { loadMount, loadMountState, saveFileKey } from "../src/domain/files/store.js";
import { putStream, getManifest, getRange } from "../src/domain/files/content.js";
import { createInitialState, applyOp, project, liveChildrenOf, ROOT_ID } from "../src/domain/files/tree.js";
import { createFolder, createFile } from "../src/domain/files/ops.js";

const OWNER_PRIV = new Uint8Array(32).fill(4);
const OWNER_PUB = bytesToHex(getPublicKey(OWNER_PRIV));
const ALICE_PRIV = new Uint8Array(32).fill(5); // получатель
const ALICE_PUB = bytesToHex(getPublicKey(ALICE_PRIV));

let counter = 0;
function label() {
	counter += 1;
	return { counter, deviceId: "device-a" };
}

before(async () => {
	await db.open();
});

beforeEach(async () => {
	await db.table("files_mounts").clear();
	await db.table("files_mountKeys").clear();
	await db.table("files_mount_nodes").clear();
	await db.table("files_mount_file_meta").clear();
	await db.table("files_nodes").clear();
	await db.table("files_keys").clear();
	counter = 0;
});

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

// Владелец расшаривает "Shared" (A.txt + Sub/B.txt, реально залитые на
// фейковый Blossom), возвращает грант-событие (адресованное Alice) и
// снимок-событие (FILE_SUBTREE_OP_KIND), как их увидела бы Alice — прямое
// переиспользование share.js's snapshotSubtree (6.6b: снимок честно
// перезаливает файлы под производным ключом, поэтому нужен реальный сервер).
async function buildShareGrantAndSnapshot(fetchImpl) {
	let S = createInitialState();
	const rootId = "n-shared";
	S = applyOp(S, createFolder(S, ROOT_ID, "Shared", rootId, label()));

	const bytesA = new Uint8Array(200);
	crypto.getRandomValues(bytesA);
	const { manifestDigest: digestA, fileKey: fileKeyA } = await putStream(bytesA, { ...netOpts(fetchImpl), name: "A.txt", mime: "text/plain" });
	await saveFileKey(OWNER_PUB, dbKey, digestA, fileKeyA);
	const fileA = "n-a";
	S = applyOp(S, createFile(S, rootId, "A.txt", fileA, digestA, label()));

	const sub = "n-sub";
	S = applyOp(S, createFolder(S, rootId, "Sub", sub, label()));

	const bytesB = new Uint8Array(200);
	crypto.getRandomValues(bytesB);
	const { manifestDigest: digestB, fileKey: fileKeyB } = await putStream(bytesB, { ...netOpts(fetchImpl), name: "B.txt", mime: "text/plain" });
	await saveFileKey(OWNER_PUB, dbKey, digestB, fileKeyB);
	const fileB = "n-b";
	S = applyOp(S, createFile(S, sub, "B.txt", fileB, digestB, label()));

	const version = 1;
	const subtreeKeyHex = bytesToHex(generateSubtreeKey());
	const grantContent = encryptShareGrant(rootId, subtreeKeyHex, version, OWNER_PRIV, ALICE_PUB);
	const grantEvent = sign({ kind: 30075, content: grantContent, tags: [["d", "irrelevant"], ["p", ALICE_PUB]], created_at: 1 }, OWNER_PRIV);

	const snapshotOps = await snapshotSubtree(OWNER_PUB, dbKey, S, rootId, subtreeKeyHex, label(), netOpts(fetchImpl));
	const snapshotContent = encryptSubtreeOp(JSON.stringify(snapshotOps), subtreeKeyHex, version);
	const snapshotEvent = sign({ kind: FILE_SUBTREE_OP_KIND, content: snapshotContent, tags: [["h", rootId]], created_at: 2 }, OWNER_PRIV);

	return { rootId, version, subtreeKeyHex, grantEvent, snapshotEvent, fileA, bytesA, sub, fileB, bytesB };
}

test("mount: создаёт узел-ссылку в дереве получателя, сохраняет запись mounts/mountKeys, Mount.state стартует пустым", async () => {
	const { fetchImpl } = makeFakeBlossom();
	const { rootId, version, grantEvent } = await buildShareGrantAndSnapshot(fetchImpl);
	let recipientTree = createInitialState();

	const result = await mount(ALICE_PUB, ALICE_PRIV, dbKey, recipientTree, grantEvent, ROOT_ID, "Друг: Shared", "n-mount-1", label());

	assert.ok(liveChildrenOf(result.treeState, ROOT_ID).has("n-mount-1"), "узел-ссылка должен появиться в СВОЁМ дереве получателя");
	assert.equal(result.ownerPubkey, OWNER_PUB);
	assert.equal(result.rootId, rootId);
	assert.equal(result.version, version);

	const mountRow = await loadMount(ALICE_PUB, "n-mount-1", dbKey);
	assert.equal(mountRow.owner, OWNER_PUB);
	assert.equal(mountRow.rootId, rootId);
	assert.equal(mountRow.currentVersion, version);

	const mountState = await loadMountState(ALICE_PUB, "n-mount-1");
	assert.equal(liveChildrenOf(mountState, ROOT_ID).size, 2, "содержимое доли ещё не пришло — createInitialState() даёт только $trash/$lost+found");
});

test("mount: PreconditionError при коллизии имени в дереве получателя — DB не тронута", async () => {
	const { fetchImpl } = makeFakeBlossom();
	const { grantEvent } = await buildShareGrantAndSnapshot(fetchImpl);
	let recipientTree = createInitialState();
	recipientTree = applyOp(recipientTree, createFolder(recipientTree, ROOT_ID, "Уже занято", "n-existing", label()));

	const result = await mount(ALICE_PUB, ALICE_PRIV, dbKey, recipientTree, grantEvent, ROOT_ID, "Уже занято", "n-mount-2", label());

	assert.ok(result instanceof Error);
	const mountRow = await loadMount(ALICE_PUB, "n-mount-2", dbKey);
	assert.equal(mountRow, undefined);
});

test("applyMountSubtreeEvent: разбирает снимок, Mount.state получает ВСЕ живые узлы доли, project() работает буквально как над обычным treeState", async () => {
	const { fetchImpl } = makeFakeBlossom();
	const { grantEvent, snapshotEvent, fileA, sub, fileB } = await buildShareGrantAndSnapshot(fetchImpl);
	let recipientTree = createInitialState();
	const { treeState } = await mount(ALICE_PUB, ALICE_PRIV, dbKey, recipientTree, grantEvent, ROOT_ID, "Друг: Shared", "n-mount-3", label());
	recipientTree = treeState;

	const S = await applyMountSubtreeEvent(ALICE_PUB, dbKey, "n-mount-3", snapshotEvent);

	assert.ok(S !== null);
	const R = project(S);
	assert.equal(R.nodes.size, 6); // A.txt, Sub, B.txt + служебные $root/$trash/$lost+found (createInitialState())
	assert.equal(R.nodes.get(fileA).displayName, "A.txt");
	assert.equal(R.nodes.get(fileA).parent, ROOT_ID);
	assert.equal(R.nodes.get(sub).displayName, "Sub");
	assert.equal(R.nodes.get(fileB).displayName, "B.txt");
	assert.equal(R.nodes.get(fileB).parent, sub);

	const persisted = await loadMountState(ALICE_PUB, "n-mount-3");
	assert.equal(project(persisted).nodes.size, 6, "Mount.state персистируется, не только в памяти");
});

test("applyMountSubtreeEvent: неизвестная версия ключа -> null, Mount.state не меняется (грант ещё не пришёл/уже отозван до неё)", async () => {
	const { fetchImpl } = makeFakeBlossom();
	const { grantEvent } = await buildShareGrantAndSnapshot(fetchImpl);
	let recipientTree = createInitialState();
	const { treeState } = await mount(ALICE_PUB, ALICE_PRIV, dbKey, recipientTree, grantEvent, ROOT_ID, "Друг: Shared", "n-mount-4", label());
	recipientTree = treeState;

	const foreignKeyHex = bytesToHex(generateSubtreeKey());
	const foreignContent = encryptSubtreeOp(JSON.stringify([{ type: "create", id: "x", kind: "file", blob: "d", parentId: ROOT_ID, name: "X", origin: null, label: label() }]), foreignKeyHex, 99);
	const foreignEvent = sign({ kind: FILE_SUBTREE_OP_KIND, content: foreignContent, tags: [["h", "irrelevant"]], created_at: 3 }, OWNER_PRIV);

	const result = await applyMountSubtreeEvent(ALICE_PUB, dbKey, "n-mount-4", foreignEvent);
	assert.equal(result, null);

	const S = await loadMountState(ALICE_PUB, "n-mount-4");
	assert.equal(project(S).nodes.size, 3, "Mount.state не изменился — только служебные узлы createInitialState()");
});

test("Mount.state НЕ делит узлы с files_nodes того же получателя (owner-scoping)", async () => {
	const { fetchImpl } = makeFakeBlossom();
	const { grantEvent, snapshotEvent } = await buildShareGrantAndSnapshot(fetchImpl);
	let recipientTree = createInitialState();
	recipientTree = applyOp(recipientTree, createFolder(recipientTree, ROOT_ID, "Своя папка", "n-own-folder", label()));
	const { treeState } = await mount(ALICE_PUB, ALICE_PRIV, dbKey, recipientTree, grantEvent, ROOT_ID, "Друг: Shared", "n-mount-5", label());
	recipientTree = treeState;
	await applyMountSubtreeEvent(ALICE_PUB, dbKey, "n-mount-5", snapshotEvent);

	const ownRows = await db.table("files_nodes").where("ownerPubkey").equals(ALICE_PUB).toArray();
	const ownIds = new Set(ownRows.map((r) => r.id));
	assert.ok(!ownIds.has("n-a"), "содержимое доли не должно попасть в files_nodes получателя");
	assert.ok(!ownIds.has("n-sub"));
	assert.ok(!ownIds.has("n-b"));

	const mountRows = await db.table("files_mount_nodes").where("[ownerPubkey+mountId]").equals([ALICE_PUB, "n-mount-5"]).toArray();
	const mountIds = new Set(mountRows.map((r) => r.id));
	assert.ok(!mountIds.has("n-own-folder"), "своё дерево получателя не должно попасть в Mount.state");
});

test("unmount: purge узла-ссылки в дереве получателя, удаляет mounts/mountKeys/Mount.state/file_meta целиком", async () => {
	const { fetchImpl } = makeFakeBlossom();
	const { grantEvent, snapshotEvent } = await buildShareGrantAndSnapshot(fetchImpl);
	let recipientTree = createInitialState();
	const { treeState } = await mount(ALICE_PUB, ALICE_PRIV, dbKey, recipientTree, grantEvent, ROOT_ID, "Друг: Shared", "n-mount-6", label());
	recipientTree = treeState;
	await applyMountSubtreeEvent(ALICE_PUB, dbKey, "n-mount-6", snapshotEvent);

	recipientTree = await unmount(ALICE_PUB, dbKey, recipientTree, "n-mount-6");

	assert.ok(!liveChildrenOf(recipientTree, ROOT_ID).has("n-mount-6"), "узел-ссылка должен исчезнуть из живых детей корня");

	const mountRow = await loadMount(ALICE_PUB, "n-mount-6", dbKey);
	assert.equal(mountRow, undefined);
	const keyRows = await db.table("files_mountKeys").where("[ownerPubkey+nodeId]").equals([ALICE_PUB, "n-mount-6"]).toArray();
	assert.equal(keyRows.length, 0);
	const stateRows = await db.table("files_mount_nodes").where("[ownerPubkey+mountId]").equals([ALICE_PUB, "n-mount-6"]).toArray();
	assert.equal(stateRows.length, 0);
	const metaRows = await db.table("files_mount_file_meta").where("[ownerPubkey+mountId]").equals([ALICE_PUB, "n-mount-6"]).toArray();
	assert.equal(metaRows.length, 0);
});

test("project() над Mount.state — та же проекция, что над эквивалентным treeState, построенным напрямую через ops.js (Mount.state буквально TreeState)", async () => {
	const { fetchImpl } = makeFakeBlossom();
	const { grantEvent, snapshotEvent, fileA, sub, fileB } = await buildShareGrantAndSnapshot(fetchImpl);
	let recipientTree = createInitialState();
	const { treeState } = await mount(ALICE_PUB, ALICE_PRIV, dbKey, recipientTree, grantEvent, ROOT_ID, "Друг: Shared", "n-mount-7", label());
	recipientTree = treeState;
	const mountState = await applyMountSubtreeEvent(ALICE_PUB, dbKey, "n-mount-7", snapshotEvent);

	let direct = createInitialState();
	direct = applyOp(direct, createFolder(direct, ROOT_ID, "A.txt", fileA, label())); // порядок вставки неважен для project()
	direct = applyOp(direct, createFolder(direct, ROOT_ID, "Sub", sub, label()));
	direct = applyOp(direct, createFolder(direct, sub, "B.txt", fileB, label()));

	const R1 = project(mountState);
	const R2 = project(direct);
	assert.deepEqual(new Set(R1.nodes.keys()), new Set(R2.nodes.keys()));
	assert.equal(R1.nodes.get(fileA).parent, R2.nodes.get(fileA).parent);
	assert.equal(R1.nodes.get(sub).parent, R2.nodes.get(sub).parent);
	assert.equal(R1.nodes.get(fileB).parent, R2.nodes.get(fileB).parent);
});

test("resolveMountFileKey: пересчитывает fileKey файла ВНУТРИ доли, получатель реально расшифровывает содержимое (этап 53 И6, задача 6.6b)", async () => {
	const { fetchImpl } = makeFakeBlossom();
	const { grantEvent, snapshotEvent, fileA, bytesA } = await buildShareGrantAndSnapshot(fetchImpl);
	let recipientTree = createInitialState();
	const { treeState } = await mount(ALICE_PUB, ALICE_PRIV, dbKey, recipientTree, grantEvent, ROOT_ID, "Друг: Shared", "n-mount-8", label());
	recipientTree = treeState;
	const mountState = await applyMountSubtreeEvent(ALICE_PUB, dbKey, "n-mount-8", snapshotEvent);

	const fileKey = await resolveMountFileKey(ALICE_PUB, dbKey, "n-mount-8", fileA);
	assert.ok(fileKey, "ключ должен пересчитаться — сайдкар сохранён applyMountSubtreeEvent");

	const node = mountState.nodes.get(fileA);
	const manifest = await getManifest(node.blob, netOpts(fetchImpl));
	const roundtrip = await getRange(manifest, fileKey, 0, manifest.size, netOpts(fetchImpl));
	assert.deepEqual(roundtrip, bytesA, "Alice реально расшифровывает содержимое доли БЕЗ отдельного гранта на файл");
});

test("resolveMountFileKey: узел без сайдкара (никогда не приходил снимок) -> undefined, не throw", async () => {
	const { fetchImpl } = makeFakeBlossom();
	const { grantEvent } = await buildShareGrantAndSnapshot(fetchImpl);
	let recipientTree = createInitialState();
	const { treeState } = await mount(ALICE_PUB, ALICE_PRIV, dbKey, recipientTree, grantEvent, ROOT_ID, "Друг: Shared", "n-mount-9", label());
	recipientTree = treeState;

	const fileKey = await resolveMountFileKey(ALICE_PUB, dbKey, "n-mount-9", "n-never-seen");
	assert.equal(fileKey, undefined);
});
