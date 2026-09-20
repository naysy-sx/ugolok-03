import "fake-indexeddb/auto";
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { fetchServerBlobs, totalBytes, reconcile, buildEntries, breakdownByPurpose, breakdownByKind, freeBlobs } from "../src/domain/uploads/storage.js";
import { bindJournal, unbindJournal, recordUploads, listUploads } from "../src/domain/uploads/journal.js";
import { deriveMasterSecret, deriveDbKey, deriveJournalKey, deriveJournalSigner } from "../src/core/crypto/derivation.js";
import { db } from "../src/core/store/database.js";

const MASTER = deriveMasterSecret(new Uint8Array(32).fill(33));
const H = (n) => n.toString(16).padStart(64, "0");
const sblob = (n, size) => ({ hash: H(n), size, uploaded: 1_800_000_000 + n });

beforeEach(async () => {
	unbindJournal();
	await db.table("uploads").clear();
	await db.table("uploadBatches").clear();
	bindJournal({ ownerPubkey: "owner", dbKey: deriveDbKey(MASTER), journalKey: deriveJournalKey(MASTER), journalSigner: deriveJournalSigner(MASTER), deviceId: "cccccccc", publish: async () => ({ ok: true }), flushDelayMs: 3_600_000 });
});

test("fetchServerBlobs: разбирает ответ /list, считает сумму", async () => {
	const calls = [];
	const fetchImpl = async (url) => {
		calls.push(url);
		return { ok: true, json: async () => [{ sha256: H(1), size: 100, uploaded: 5, url: "x" }, { sha256: H(2), size: 50, uploaded: 6 }, { junk: 1 }] };
	};
	const blobs = await fetchServerBlobs("https://blossom.example/", "abc", { fetchImpl });
	assert.equal(calls[0], "https://blossom.example/list/abc");
	assert.equal(blobs.length, 2);
	assert.equal(totalBytes(blobs), 150);
	await assert.rejects(fetchServerBlobs("https://x", "abc", { fetchImpl: async () => ({ ok: false, status: 500 }) }), /500/);
});

test("reconcile: неопознанные (нет в журнале) и недоступные (нет на сервере)", () => {
	const server = [sblob(1, 100), sblob(2, 200), sblob(3, 300)];
	const journal = [{ hash: H(1) }, { hash: H(9) }];
	const r = reconcile(server, journal);
	assert.deepEqual(r.unknown.map((b) => b.hash), [H(2), H(3)]);
	assert.equal(r.unknownBytes, 500);
	assert.deepEqual(r.missing.map((x) => x.hash), [H(9)]);
});

test("buildEntries: без журнала — по строке на блоб; с журналом — вложение целиком, сортировка по размеру", () => {
	const server = [sblob(1, 40_000_000), sblob(2, 900), sblob(3, 12_000), sblob(4, 300), sblob(5, 5_000_000)];
	const noJournal = buildEntries(server, []);
	assert.equal(noJournal.length, 5);
	assert.ok(noJournal.every((e) => !e.known));
	assert.equal(noJournal[0].size, 40_000_000);

	const rows = [1, 2, 3, 4].map((n, i) => ({ hash: H(n), size: server[i].size, role: ["content", "manifest", "preview", "previewManifest"][i], group: "g", purpose: "dm", targets: ["peerA"], name: "отпуск.mp4", at: 1 }));
	const withJournal = buildEntries(server, rows);
	assert.equal(withJournal.length, 2, "одно вложение (4 блоба) + один неопознанный");
	const att = withJournal.find((e) => e.known);
	assert.equal(att.name, "отпуск.mp4");
	assert.equal(att.hashes.length, 4);
	assert.equal(att.size, 40_000_000 + 900 + 12_000 + 300);
	assert.equal(att.kind, "video");
	const bp = breakdownByPurpose(withJournal);
	assert.equal(bp.dm, att.size);
	assert.equal(bp.unknown, 5_000_000);
	assert.equal(breakdownByKind(withJournal).video, att.size);
});

test("buildEntries: блоб, удалённый с сервера, но живой в журнале, в строки не попадает", () => {
	const rows = [{ hash: H(1), size: 10, role: "content", group: "g", purpose: "dm", targets: [], name: "a.jpg", at: 1 }, { hash: H(2), size: 1, role: "manifest", group: "g", purpose: "dm", targets: [], name: "a.jpg", at: 1 }];
	const entries = buildEntries([sblob(1, 10)], rows);
	assert.equal(entries.length, 1);
	assert.deepEqual(entries[0].hashes, [H(1)]);
});

test("10. freeBlobs: DELETE на каждый блоб; 404 считается удалённым; ошибка не стирает запись из журнала", async () => {
	await recordUploads([1, 2, 3, 4].map((n) => ({ hash: H(n), size: n, role: ["content", "manifest", "preview", "previewManifest"][n - 1], purpose: "dm", target: "peerA", group: "g", name: "a.jpg" })));
	const seen = [];
	const deleteFn = async (server, hash) => {
		seen.push(hash);
		if (hash === H(2)) throw new Error("Blossom delete failed: 404 ");
		if (hash === H(3)) throw new Error("Blossom delete failed: 400 unauthorized");
	};
	const progress = [];
	const res = await freeBlobs({ serverUrl: "https://b", privateKey: new Uint8Array(32).fill(1), hashes: [H(1), H(2), H(3), H(4)], deleteFn, onProgress: (p) => progress.push(p.done) });
	assert.deepEqual(seen, [H(1), H(2), H(3), H(4)]);
	assert.deepEqual(res.deleted.sort(), [H(1), H(2), H(4)].sort());
	assert.equal(res.failed.length, 1);
	assert.equal(res.failed[0].hash, H(3));
	assert.deepEqual(progress, [1, 2, 3, 4]);
	const left = (await listUploads()).map((r) => r.hash);
	assert.deepEqual(left, [H(3)], "в журнале осталась запись, которую не удалось удалить с сервера");
});
