// Глобальный поиск, этап И2, задачи 2.4/2.5/2.6 (PROCESS-DOCS/PLAN.md).
// Контракт — SEARCH-SPEC.md §3.3/§3.4/§3.5, псевдокод ядра — DESIGN.md
// §SEARCH ("Псевдокод engine.js"). Написаны ДО реализации engine.js
// (orchestrate-workers, правило 14) — изначально все красные.
//
// searchOverSources — внутренний экспорт сверх контракта §3.3 (сам
// search(ctx, rawQuery, {signal, limitPerType}) параметра "источники" не
// принимает — контракт заморожен буквально). searchOverSources принимает
// явный список источников и тестируется здесь мок-источниками, без
// IndexedDB — быстро и изолированно от 2.2/2.3. Один интеграционный тест
// внизу файла проверяет search() целиком, с реальными источниками и
// fake-indexeddb, чтобы зафиксировать порядок очереди §3.3 буквально.

import "fake-indexeddb/auto";
import { test } from "node:test";
import assert from "node:assert/strict";
import { search, searchOverSources, SOURCES_IN_ORDER } from "../src/domain/search/engine.js";
import { db } from "../src/core/store/database.js";
import { toEncryptedRow } from "../src/core/store/encrypted-table.js";
import { CHANNELS_PLAINTEXT_FIELDS, MESSAGES_PLAINTEXT_FIELDS } from "../src/core/store/table-fields.js";

const OWNER = "e".repeat(64);
const dbKey = crypto.getRandomValues(new Uint8Array(32));

function mulberry32(seed) {
	return function () {
		seed |= 0;
		seed = (seed + 0x6d2b79f5) | 0;
		let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
		t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}

function mockSource(type, order, records) {
	return {
		type,
		order,
		async *scan(ctx, { signal }) {
			for (const r of records) {
				if (signal.aborted) return;
				yield r;
			}
		},
	};
}

async function collect(gen) {
	const out = [];
	for await (const item of gen) out.push(item);
	return out;
}

// --- 2.4: очередь источников, форма выдачи ---
test("searchOverSources: порядок очереди — источники обходятся в порядке списка, каждый целиком (unordered) до следующего", async () => {
	const a = mockSource("contact", "unordered", [{ key: "1", sortKey: null, fields: ["сокол"] }]);
	const b = mockSource("channel", "unordered", [{ key: "2", sortKey: null, fields: ["сокол"] }]);
	const got = await collect(searchOverSources([a, b], { ownerPubkey: OWNER, dbKey }, "сокол", { signal: new AbortController().signal, limitPerType: 100 }));
	assert.deepEqual(got.map((g) => g.type), ["contact", "channel"]);
});

test("searchOverSources: SOURCES_IN_ORDER — порядок ровно contacts,channels,comments,posts,channelMessages,messages (§3.3)", () => {
	assert.deepEqual(SOURCES_IN_ORDER.map((s) => s.type), ["contact", "channel", "comment", "post", "channelMessage", "message"]);
});

test("searchOverSources: matches применяется, несовпавшие записи не идут в выдачу", async () => {
	const a = mockSource("contact", "unordered", [
		{ key: "1", sortKey: null, fields: ["kukusya", "обожает питона"] },
		{ key: "2", sortKey: null, fields: ["другой человек", "ничего общего"] },
	]);
	const got = await collect(searchOverSources([a], { ownerPubkey: OWNER, dbKey }, "kukusya", { signal: new AbortController().signal, limitPerType: 100 }));
	assert.deepEqual(got.map((g) => g.key), ["1"]);
});

// --- I-EMPTY-NOOP на уровне движка ---
test("searchOverSources: пустой запрос — источники не читаются вовсе", async () => {
	let scanCalled = false;
	const a = {
		type: "contact",
		order: "unordered",
		async *scan() {
			scanCalled = true;
		},
	};
	const got = await collect(searchOverSources([a], { ownerPubkey: OWNER, dbKey }, "   ", { signal: new AbortController().signal, limitPerType: 100 }));
	assert.deepEqual(got, []);
	assert.equal(scanCalled, false, "источник не должен вызываться на пустом запросе");
});

// --- I-EARLY-EXIT на уровне движка: обрыв только для order:"recent" ---
test("searchOverSources: unordered-источник обходится ЦЕЛИКОМ, даже когда совпадений больше limitPerType", async () => {
	const records = Array.from({ length: 10 }, (_, i) => ({ key: `k${i}`, sortKey: null, fields: [`слово${i} корень`] }));
	const a = mockSource("comment", "unordered", records);
	const got = await collect(searchOverSources([a], { ownerPubkey: OWNER, dbKey }, "корень", { signal: new AbortController().signal, limitPerType: 3 }));
	assert.equal(got.length, 10, "unordered-источник не должен обрываться по limitPerType");
});

test("searchOverSources: recent-источник обрывается ровно на limitPerType совпадениях", async () => {
	const records = Array.from({ length: 10 }, (_, i) => ({ key: `k${i}`, sortKey: 100 - i, fields: [`слово${i} корень`] }));
	const a = mockSource("message", "recent", records);
	const got = await collect(searchOverSources([a], { ownerPubkey: OWNER, dbKey }, "корень", { signal: new AbortController().signal, limitPerType: 3 }));
	assert.equal(got.length, 3);
	assert.deepEqual(got.map((g) => g.key), ["k0", "k1", "k2"], "обрыв должен взять именно ПЕРВЫЕ по порядку scan(), не случайные");
});

test("searchOverSources: recent-источник — обрыв считает только СОВПАВШИЕ записи, не все прочитанные", async () => {
	// 2 несовпадения перед каждым совпадением — limitPerType=2 должен всё
	// равно прочитать 6 записей источника, но yield-нуть только 2.
	const records = [
		{ key: "no1", sortKey: 10, fields: ["мимо"] },
		{ key: "no2", sortKey: 9, fields: ["мимо"] },
		{ key: "yes1", sortKey: 8, fields: ["корень"] },
		{ key: "no3", sortKey: 7, fields: ["мимо"] },
		{ key: "no4", sortKey: 6, fields: ["мимо"] },
		{ key: "yes2", sortKey: 5, fields: ["корень"] },
		{ key: "yes3", sortKey: 4, fields: ["корень"] },
	];
	const a = mockSource("message", "recent", records);
	const got = await collect(searchOverSources([a], { ownerPubkey: OWNER, dbKey }, "корень", { signal: new AbortController().signal, limitPerType: 2 }));
	assert.deepEqual(got.map((g) => g.key), ["yes1", "yes2"]);
});

// --- Property-тест 3, §8 SEARCH-SPEC.md: обрыв == первые k полного прохода ---
test("I-EARLY-EXIT (property, §8 №3): выдача с обрывом совпадает с первыми k записями полного обхода того же источника", async () => {
	const rng = mulberry32(42);
	const ROOTS = ["работ", "деньг", "код", "файл"];
	for (let seed = 0; seed < 60; seed++) {
		const n = 30 + Math.floor(rng() * 60);
		const records = [];
		for (let i = 0; i < n; i++) {
			const hasRoot = rng() < 0.4;
			const word = hasRoot ? ROOTS[Math.floor(rng() * ROOTS.length)] + "а" : "постороннее" + i;
			records.push({ key: `k${i}`, sortKey: n - i, fields: [word] });
		}
		const source = mockSource("message", "recent", records);
		const full = await collect(searchOverSources([source], { ownerPubkey: OWNER, dbKey }, "работ", { signal: new AbortController().signal, limitPerType: 1_000_000 }));
		for (const limitPerType of [1, 2, 5]) {
			if (full.length < limitPerType) continue;
			const partial = await collect(searchOverSources([mockSource("message", "recent", records)], { ownerPubkey: OWNER, dbKey }, "работ", { signal: new AbortController().signal, limitPerType }));
			assert.deepEqual(partial, full.slice(0, limitPerType), `seed=${seed}, limitPerType=${limitPerType}`);
		}
	}
});

// --- I-CANCEL-CLEAN: signal.aborted останавливает выдачу, включая между источниками ---
test("searchOverSources: abort посреди первого источника — второй источник не читается вовсе", async () => {
	const controller = new AbortController();
	let bScanCalled = false;
	const a = {
		type: "contact",
		order: "unordered",
		async *scan(ctx, { signal }) {
			yield { key: "1", sortKey: null, fields: ["корень"] };
			controller.abort();
			if (signal.aborted) return;
			yield { key: "2", sortKey: null, fields: ["корень"] };
		},
	};
	const b = {
		type: "channel",
		order: "unordered",
		async *scan() {
			bScanCalled = true;
		},
	};
	const got = await collect(searchOverSources([a, b], { ownerPubkey: OWNER, dbKey }, "корень", { signal: controller.signal, limitPerType: 100 }));
	assert.deepEqual(got.map((g) => g.key), ["1"]);
	assert.equal(bScanCalled, false, "источник после отменённого — не должен запускаться");
});

test("I-CANCEL-CLEAN: две перекрывающиеся сессии — устаревшая (по runId потребителя) не попадает в состояние", async () => {
	// Ровно та дисциплина потребителя, что предусмотрена для search.js
	// (DESIGN.md §SEARCH: счётчик запусков — вне engine.js, в потребителе).
	// Тест воспроизводит эту дисциплину явно, без самого search.js (И3).
	let runCounter = 0;
	let state = null;

	async function runSearch(records, query, signal) {
		const myRun = ++runCounter;
		const results = [];
		for await (const item of searchOverSources([mockSource("message", "recent", records)], { ownerPubkey: OWNER, dbKey }, query, { signal, limitPerType: 100 })) {
			results.push(item);
		}
		if (myRun === runCounter) state = results; // устаревший прогон отбрасывается тут
	}

	const slowRecords = Array.from({ length: 5 }, (_, i) => ({ key: `slow${i}`, sortKey: 10 - i, fields: ["корень"] }));
	const fastRecords = [{ key: "fast0", sortKey: 1, fields: ["корень"] }];

	const controllerA = new AbortController();
	const runA = runSearch(slowRecords, "корень", controllerA.signal);
	// Второй запуск стартует ДО завершения первого — тот же сценарий, что
	// повторный Enter (SEARCH-SPEC.md §3.5).
	controllerA.abort();
	const runB = runSearch(fastRecords, "корень", new AbortController().signal);
	await Promise.all([runA, runB]);

	assert.deepEqual(state.map((r) => r.key), ["fast0"], "выдача отменённого прогона A попала в состояние");
});

// --- Интеграционный тест: search() целиком, реальные источники, fake-indexeddb ---
test("search(): интеграция — реальные источники, оба сценария постановки задачи", async () => {
	await db.delete();
	await db.open();
	await db.table("channels").add(
		toEncryptedRow({ ownerPubkey: OWNER, id: "ch1", role: "owner", creatorPubkey: OWNER, createdAt: 1, updatedAt: 1, allowChatAttachments: true, name: "Кухня", description: "", rules: "мясо не должно быть протухшим" }, CHANNELS_PLAINTEXT_FIELDS, dbKey),
	);
	await db.table("messages").add(
		toEncryptedRow({ ownerPubkey: OWNER, chatId: "c1", msgId: "m1", lamportTs: 1, senderPubkey: OWNER, id: "id1", status: "sent", deleted: false, text: "нужны деньги на работу" }, MESSAGES_PLAINTEXT_FIELDS, dbKey),
	);

	const rulesHits = await collect(search({ ownerPubkey: OWNER, dbKey }, "протух", { signal: new AbortController().signal, limitPerType: 100 }));
	assert.deepEqual(rulesHits.map((h) => h.type), ["channel"]);

	const wordRootHits = await collect(search({ ownerPubkey: OWNER, dbKey }, "работ деньг", { signal: new AbortController().signal, limitPerType: 100 }));
	assert.deepEqual(wordRootHits.map((h) => h.type), ["message"]);

	// Закрытие пробела контракта (И3, CONTRACTS.md §SEARCH): search() обязан
	// прокидывать data источника, а не только {type,key,sortKey} — иначе
	// потребителю (экрану) нечем ни показать запись, ни перейти по ней.
	assert.deepEqual(rulesHits[0].data, { channelId: "ch1", name: "Кухня", description: "", rules: "мясо не должно быть протухшим" });
	assert.deepEqual(wordRootHits[0].data.text, "нужны деньги на работу");

	await db.delete();
});
