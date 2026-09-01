// Глобальный поиск, этап И2, задача 2.1 (PROCESS-DOCS/PLAN.md). Тестирует
// ЕДИНСТВЕННУЮ инфраструктурную функцию, которую пишет Claude напрямую (не
// воркер) — мост "обратный курсор Dexie -> pull-based async-генератор" под
// src/domain/search/sources/paginate-reverse.js. Это несущая конструкция
// I-EARLY-EXIT/I-SCAN-SHOWS-ORDER (DESIGN.md §SEARCH) — ошибка здесь даёт
// именно "правдоподобно неверную выдачу" (SEARCH-SPEC.md §0), поэтому тесты
// написаны и прогнаны КРАСНЫМИ до реализации (orchestrate-workers, правило 14).

import "fake-indexeddb/auto";
import { test } from "node:test";
import assert from "node:assert/strict";
import Dexie from "dexie";
import { paginateReverseByPrimaryKey, paginateReverseByCompoundIndex } from "../src/domain/search/sources/paginate-reverse.js";

function freshDb(name) {
	const db = new Dexie(name);
	db.version(1).stores({
		messages: "++seq, ownerPubkey",
		posts: "[ownerPubkey+id], [ownerPubkey+createdAt]",
	});
	return db;
}

async function collect(gen) {
	const out = [];
	for await (const row of gen) out.push(row);
	return out;
}

function isNonIncreasing(values) {
	for (let i = 1; i < values.length; i++) if (values[i] > values[i - 1]) return false;
	return true;
}

// --- paginateReverseByPrimaryKey (messages: seq автоинкремент, БЕЗ owner в
// индексе — И0 П-1: курсор читает ВСЕ строки устройства, фильтрует ownerPubkey
// в памяти) ---

test("paginateReverseByPrimaryKey: порядок строго по убыванию seq", async () => {
	const db = freshDb("pk-order");
	await db.open();
	const rows = [];
	for (let i = 0; i < 733; i++) rows.push({ ownerPubkey: i % 3 === 0 ? "owner-a" : "owner-b" });
	await db.table("messages").bulkAdd(rows);

	const signal = new AbortController().signal;
	const got = await collect(paginateReverseByPrimaryKey(db.table("messages"), "ownerPubkey", "owner-a", { signal, pageSize: 37 }));
	assert.ok(isNonIncreasing(got.map((r) => r.seq)), "seq не строго убывает");
	assert.ok(got.every((r) => r.ownerPubkey === "owner-a"), "просочилась чужая строка");
	// Полнота: столько же строк owner-a, сколько их всего в базе.
	const expectedCount = rows.filter((r) => r.ownerPubkey === "owner-a").length;
	assert.equal(got.length, expectedCount);
	await db.delete();
});

test("paginateReverseByPrimaryKey: пустая таблица и owner без строк — пустой результат, не исключение", async () => {
	const db = freshDb("pk-empty");
	await db.open();
	const signal = new AbortController().signal;
	assert.deepEqual(await collect(paginateReverseByPrimaryKey(db.table("messages"), "ownerPubkey", "nobody", { signal, pageSize: 50 })), []);
	await db.table("messages").add({ ownerPubkey: "someone-else" });
	assert.deepEqual(await collect(paginateReverseByPrimaryKey(db.table("messages"), "ownerPubkey", "nobody", { signal, pageSize: 50 })), []);
	await db.delete();
});

test("paginateReverseByPrimaryKey: I-EARLY-EXIT — первые k совпадают с первыми k полного прохода", async () => {
	const db = freshDb("pk-early-exit");
	await db.open();
	const rows = [];
	for (let i = 0; i < 950; i++) rows.push({ ownerPubkey: "owner-a" });
	await db.table("messages").bulkAdd(rows);

	const signal = new AbortController().signal;
	const full = await collect(paginateReverseByPrimaryKey(db.table("messages"), "ownerPubkey", "owner-a", { signal, pageSize: 200 }));

	for (const k of [1, 50, 199, 200, 201, 400]) {
		const partial = [];
		for await (const row of paginateReverseByPrimaryKey(db.table("messages"), "ownerPubkey", "owner-a", { signal, pageSize: 200 })) {
			partial.push(row);
			if (partial.length >= k) break;
		}
		assert.deepEqual(partial, full.slice(0, k), `k=${k}: обрыв разошёлся с полным проходом`);
	}
	await db.delete();
});

test("paginateReverseByPrimaryKey: соблюдает AbortSignal между страницами", async () => {
	const db = freshDb("pk-abort");
	await db.open();
	const rows = [];
	for (let i = 0; i < 500; i++) rows.push({ ownerPubkey: "owner-a" });
	await db.table("messages").bulkAdd(rows);

	const controller = new AbortController();
	const got = [];
	for await (const row of paginateReverseByPrimaryKey(db.table("messages"), "ownerPubkey", "owner-a", { signal: controller.signal, pageSize: 50 })) {
		got.push(row);
		if (got.length === 60) controller.abort();
	}
	// Остановка не позже одной порции (N-CANCEL, SEARCH-SPEC.md §6): 60 уже
	// прочитанных + не больше одной полной страницы(50) сверху.
	assert.ok(got.length < 60 + 50, `прочитано ${got.length} строк после abort — больше одной порции`);
	await db.delete();
});

// --- paginateReverseByCompoundIndex (posts/channelMessages: [owner+createdAt],
// owner уже встроен в диапазон индекса — И0: строго лучше messages, чужие
// строки вообще не читаются) ---

test("paginateReverseByCompoundIndex: порядок по убыванию createdAt, скоуп по owner из диапазона индекса", async () => {
	const db = freshDb("ci-order");
	await db.open();
	const rows = [];
	for (let i = 0; i < 611; i++) {
		rows.push({ ownerPubkey: i % 4 === 0 ? "owner-a" : "owner-b", id: `id-${i}`, createdAt: 1000 + i });
	}
	await db.table("posts").bulkAdd(rows);

	const signal = new AbortController().signal;
	const got = await collect(paginateReverseByCompoundIndex(db.table("posts"), "[ownerPubkey+createdAt]", "owner-a", "createdAt", { signal, pageSize: 41 }));
	assert.ok(isNonIncreasing(got.map((r) => r.createdAt)));
	assert.ok(got.every((r) => r.ownerPubkey === "owner-a"));
	assert.equal(got.length, rows.filter((r) => r.ownerPubkey === "owner-a").length);
	await db.delete();
});

test("paginateReverseByCompoundIndex: I-EARLY-EXIT — первые k совпадают с первыми k полного прохода", async () => {
	const db = freshDb("ci-early-exit");
	await db.open();
	const rows = [];
	for (let i = 0; i < 850; i++) rows.push({ ownerPubkey: "owner-a", id: `id-${i}`, createdAt: i });
	await db.table("posts").bulkAdd(rows);

	const signal = new AbortController().signal;
	const full = await collect(paginateReverseByCompoundIndex(db.table("posts"), "[ownerPubkey+createdAt]", "owner-a", "createdAt", { signal, pageSize: 200 }));

	for (const k of [1, 199, 200, 201, 500]) {
		const partial = [];
		for await (const row of paginateReverseByCompoundIndex(db.table("posts"), "[ownerPubkey+createdAt]", "owner-a", "createdAt", { signal, pageSize: 200 })) {
			partial.push(row);
			if (partial.length >= k) break;
		}
		assert.deepEqual(partial, full.slice(0, k), `k=${k}`);
	}
	await db.delete();
});

test("paginateReverseByCompoundIndex: одинаковый createdAt у нескольких записей — ни одна не теряется и не дублируется", async () => {
	const db = freshDb("ci-ties");
	await db.open();
	const rows = [];
	for (let i = 0; i < 300; i++) rows.push({ ownerPubkey: "owner-a", id: `id-${i}`, createdAt: Math.floor(i / 30) }); // много повторов createdAt
	await db.table("posts").bulkAdd(rows);

	const signal = new AbortController().signal;
	const got = await collect(paginateReverseByCompoundIndex(db.table("posts"), "[ownerPubkey+createdAt]", "owner-a", "createdAt", { signal, pageSize: 33 }));
	assert.equal(got.length, rows.length, "часть строк с повторяющимся createdAt потерялась на границе страницы");
	assert.equal(new Set(got.map((r) => r.id)).size, rows.length, "часть строк задублировалась на границе страницы");
	await db.delete();
});
