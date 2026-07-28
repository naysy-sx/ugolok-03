import "fake-indexeddb/auto";
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { db } from "../src/core/store/database.js";
import { createInitialState, applyOp, ROOT_ID } from "../src/domain/files/tree.js";
import { createFolder } from "../src/domain/files/ops.js";
import { saveTreeState, loadTreeState, getCachedManifest, putCachedManifest } from "../src/domain/files/store.js";

const OWNER_A = "owner-a-pubkey";
const OWNER_B = "owner-b-pubkey";

beforeEach(async () => {
	await db.table("files_nodes").clear();
	await db.table("files_manifests").clear();
});

function mkFolder(S, parentId, name, label) {
	const newId = `dir-${Math.random().toString(36).slice(2, 8)}`;
	const op = createFolder(S, parentId, name, newId, label);
	return [applyOp(S, op), newId];
}

test("saveTreeState/loadTreeState: состояние переживает 'перезагрузку' (задача 2.6 DoD)", async () => {
	let S = createInitialState();
	let a, b;
	[S, a] = mkFolder(S, ROOT_ID, "Документы", { counter: 1, deviceId: "d1" });
	[S, b] = mkFolder(S, a, "Отчёты", { counter: 2, deviceId: "d1" });

	await saveTreeState(OWNER_A, S);
	const loaded = await loadTreeState(OWNER_A);

	assert.equal(loaded.nodes.size, S.nodes.size);
	const loadedB = loaded.nodes.get(b);
	assert.equal(loadedB.name.value, "Отчёты");
	assert.equal(loadedB.par.value, a);
	assert.equal(loadedB.par.label.counter, 2);
	assert.equal(loadedB.par.label.deviceId, "d1");
	assert.equal(loadedB.purged, false);
});

test("loadTreeState: пустая база — три системных узла отсутствуют (сохраняет то, что реально было сохранено)", async () => {
	const loaded = await loadTreeState(OWNER_A);
	assert.equal(loaded.nodes.size, 0);
});

test("owner-scoping: два владельца НЕ видят узлы друг друга (тот же принцип, что contacts/attachments)", async () => {
	let SA = createInitialState();
	[SA] = mkFolder(SA, ROOT_ID, "Только у A", { counter: 1, deviceId: "d1" });
	await saveTreeState(OWNER_A, SA);

	let SB = createInitialState();
	[SB] = mkFolder(SB, ROOT_ID, "Только у B", { counter: 1, deviceId: "d2" });
	await saveTreeState(OWNER_B, SB);

	const loadedA = await loadTreeState(OWNER_A);
	const loadedB = await loadTreeState(OWNER_B);

	const namesA = [...loadedA.nodes.values()].map((n) => n.name.value);
	const namesB = [...loadedB.nodes.values()].map((n) => n.name.value);
	assert.ok(namesA.includes("Только у A"));
	assert.ok(!namesA.includes("Только у B"));
	assert.ok(namesB.includes("Только у B"));
	assert.ok(!namesB.includes("Только у A"));
});

test("saveTreeState: повторное сохранение ПЕРЕЗАПИСЫВАЕТ (не накапливает старые узлы владельца)", async () => {
	let S = createInitialState();
	let a;
	[S, a] = mkFolder(S, ROOT_ID, "A", { counter: 1, deviceId: "d1" });
	await saveTreeState(OWNER_A, S);

	// Второе сохранение — БЕЗ узла "a" (например, состояние было полностью
	// пересобрано на другом устройстве и синхронизировано заново).
	const S2 = createInitialState();
	await saveTreeState(OWNER_A, S2);

	const loaded = await loadTreeState(OWNER_A);
	assert.equal(loaded.nodes.size, S2.nodes.size, "старые узлы не должны были остаться после перезаписи");
	assert.ok(![...loaded.nodes.values()].some((n) => n.name.value === "A"));
});

test("манифест-кеш: get/put, owner-scoped", async () => {
	const manifest = { size: 100, chunkSize: 50, chunks: ["aa", "bb"], keyId: "k1", mime: "text/plain" };
	await putCachedManifest(OWNER_A, "digest-1", manifest);

	const got = await getCachedManifest(OWNER_A, "digest-1");
	assert.deepEqual(got, manifest);

	const gotForOtherOwner = await getCachedManifest(OWNER_B, "digest-1");
	assert.equal(gotForOtherOwner, undefined);
});
