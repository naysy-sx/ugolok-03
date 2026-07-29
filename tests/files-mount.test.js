import "fake-indexeddb/auto";
import { test, before, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { db } from "../src/core/store/database.js";
import { bytesToHex } from "@noble/hashes/utils.js";
import { getPublicKey } from "../src/core/crypto/keys.js";
import { sign } from "../src/core/crypto/sign.js";
import { generateSubtreeKey, encryptShareGrant, encryptSubtreeOp } from "../src/core/crypto/share-key.js";
import { FILE_SUBTREE_OP_KIND, snapshotSubtree } from "../src/domain/files/share.js";
import { mount, applyMountSubtreeEvent, unmount } from "../src/domain/files/mount.js";
import { loadMount, loadMountState } from "../src/domain/files/store.js";
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
	await db.table("files_nodes").clear();
	counter = 0;
});

// Владелец расшаривает "Shared" (A.txt + Sub/B.txt), возвращает грант-событие
// (адресованное Alice) и снимок-событие (FILE_SUBTREE_OP_KIND), как их
// увидела бы Alice — прямое переиспользование share.js's snapshotSubtree.
function buildShareGrantAndSnapshot() {
	let S = createInitialState();
	const rootId = "n-shared";
	S = applyOp(S, createFolder(S, ROOT_ID, "Shared", rootId, label()));
	const fileA = "n-a";
	S = applyOp(S, createFile(S, rootId, "A.txt", fileA, "digest-a", label()));
	const sub = "n-sub";
	S = applyOp(S, createFolder(S, rootId, "Sub", sub, label()));
	const fileB = "n-b";
	S = applyOp(S, createFile(S, sub, "B.txt", fileB, "digest-b", label()));

	const version = 1;
	const subtreeKeyHex = bytesToHex(generateSubtreeKey());
	const grantContent = encryptShareGrant(rootId, subtreeKeyHex, version, OWNER_PRIV, ALICE_PUB);
	const grantEvent = sign({ kind: 30075, content: grantContent, tags: [["d", "irrelevant"], ["p", ALICE_PUB]], created_at: 1 }, OWNER_PRIV);

	const snapshotOps = snapshotSubtree(S, rootId, label());
	const snapshotContent = encryptSubtreeOp(JSON.stringify(snapshotOps), subtreeKeyHex, version);
	const snapshotEvent = sign({ kind: FILE_SUBTREE_OP_KIND, content: snapshotContent, tags: [["h", rootId]], created_at: 2 }, OWNER_PRIV);

	return { rootId, version, subtreeKeyHex, grantEvent, snapshotEvent, fileA, sub, fileB };
}

const dbKey = crypto.getRandomValues(new Uint8Array(32));

test("mount: создаёт узел-ссылку в дереве получателя, сохраняет запись mounts/mountKeys, Mount.state стартует пустым", async () => {
	const { rootId, version, grantEvent } = buildShareGrantAndSnapshot();
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
	const { grantEvent } = buildShareGrantAndSnapshot();
	let recipientTree = createInitialState();
	recipientTree = applyOp(recipientTree, createFolder(recipientTree, ROOT_ID, "Уже занято", "n-existing", label()));

	const result = await mount(ALICE_PUB, ALICE_PRIV, dbKey, recipientTree, grantEvent, ROOT_ID, "Уже занято", "n-mount-2", label());

	assert.ok(result instanceof Error);
	const mountRow = await loadMount(ALICE_PUB, "n-mount-2", dbKey);
	assert.equal(mountRow, undefined);
});

test("applyMountSubtreeEvent: разбирает снимок, Mount.state получает ВСЕ живые узлы доли, project() работает буквально как над обычным treeState", async () => {
	const { grantEvent, snapshotEvent, fileA, sub, fileB } = buildShareGrantAndSnapshot();
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
	const { grantEvent } = buildShareGrantAndSnapshot();
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
	const { grantEvent, snapshotEvent } = buildShareGrantAndSnapshot();
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

test("unmount: purge узла-ссылки в дереве получателя, удаляет mounts/mountKeys/Mount.state целиком", async () => {
	const { grantEvent, snapshotEvent } = buildShareGrantAndSnapshot();
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
});

test("project() над Mount.state — та же проекция, что над эквивалентным treeState, построенным напрямую через ops.js (Mount.state буквально TreeState)", async () => {
	const { grantEvent, snapshotEvent, fileA, sub, fileB } = buildShareGrantAndSnapshot();
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
