// MEDIA-PERF-TZ-5.md §2 — общая очередь запросов к Blossom.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequestQueue, PRIORITY } from "../src/core/transport/request-queue.js";

function deferred() {
	let resolve;
	let reject;
	const promise = new Promise((res, rej) => {
		resolve = res;
		reject = rej;
	});
	return { promise, resolve, reject };
}

function tick(ms = 10) {
	return new Promise((r) => setTimeout(r, ms));
}

test("лимит соблюдается: 20 задач при limit=3 → одновременно не больше 3", async () => {
	const queue = createRequestQueue({ limit: 3, playerMax: 3, otherMax: 3 });
	const gates = Array.from({ length: 20 }, () => deferred());
	let maxObserved = 0;

	const results = gates.map((gate, i) =>
		queue.schedule(PRIORITY.PREVIEW, async () => {
			maxObserved = Math.max(maxObserved, queue.stats.running);
			await gate.promise;
			return i;
		}),
	);

	await tick();
	assert.equal(queue.stats.running, 3, "должны стартовать ровно 3 (limit), не 20");
	for (const gate of gates) gate.resolve();
	const values = await Promise.all(results);
	assert.deepEqual(values, gates.map((_, i) => i));
	assert.ok(maxObserved <= 3, `в любой момент работало не больше 3, замечено ${maxObserved}`);
});

test("приоритет: PLAYER, поставленный после PREVIEW, стартует раньше", async () => {
	const queue = createRequestQueue({ limit: 1, playerMax: 1, otherMax: 1 });
	const order = [];
	const busyGate = deferred();

	// Занимаем единственный слот.
	const busy = queue.schedule(PRIORITY.PREVIEW, async () => {
		order.push("busy");
		await busyGate.promise;
	});
	await tick();

	const previewGate = deferred();
	const preview = queue.schedule(PRIORITY.PREVIEW, async () => {
		order.push("preview");
		await previewGate.promise;
	});
	await tick();

	const playerGate = deferred();
	const player = queue.schedule(PRIORITY.PLAYER, async () => {
		order.push("player");
		await playerGate.promise;
	});
	await tick();

	busyGate.resolve();
	await busy;
	await tick();

	assert.deepEqual(order, ["busy", "player"], "PLAYER должен обогнать уже стоящий в очереди PREVIEW");

	playerGate.resolve();
	await player;
	previewGate.resolve();
	await preview;
});

test("FIFO внутри одного приоритета", async () => {
	const queue = createRequestQueue({ limit: 1, playerMax: 1, otherMax: 1 });
	const order = [];
	const busyGate = deferred();
	const busy = queue.schedule(PRIORITY.PREVIEW, async () => {
		await busyGate.promise;
	});
	await tick();

	const gates = [deferred(), deferred(), deferred()];
	const results = gates.map((gate, i) =>
		queue.schedule(PRIORITY.PREVIEW, async () => {
			order.push(i);
			await gate.promise;
		}),
	);
	await tick();

	busyGate.resolve();
	await busy;
	for (const gate of gates) gate.resolve();
	await Promise.all(results);

	assert.deepEqual(order, [0, 1, 2], "внутри одного приоритета порядок старта — порядок постановки");
});

test("потолок PLAYER не превышается даже при 20 PLAYER-задачах", async () => {
	const queue = createRequestQueue({ limit: 8, playerMax: 2, otherMax: 6 });
	const gates = Array.from({ length: 20 }, () => deferred());
	let maxPlayer = 0;

	const results = gates.map((gate) =>
		queue.schedule(PRIORITY.PLAYER, async () => {
			maxPlayer = Math.max(maxPlayer, queue.stats.runningByPriority.player);
			await gate.promise;
		}),
	);

	await tick();
	assert.equal(queue.stats.runningByPriority.player, 2, "потолок PLAYER — 2, даже при 20 задачах в очереди");
	for (const gate of gates) gate.resolve();
	await Promise.all(results);
	assert.ok(maxPlayer <= 2, `PLAYER никогда не превышал playerMax, замечено ${maxPlayer}`);
});

test("OVERLAY получает слот, пока идёт непрерывный поток PLAYER (защита от голодания)", async () => {
	const queue = createRequestQueue({ limit: 8, playerMax: 6, otherMax: 6 });

	// "Непрерывный поток PLAYER" — playerMax задач держат свои слоты бесконечно
	// (гейт никогда не разрешается), плюс избыток сверх потолка стоит в очереди —
	// ровно то давление, от которого OVERLAY не должен голодать.
	const neverResolve = new Promise(() => {});
	for (let i = 0; i < 6; i++) queue.schedule(PRIORITY.PLAYER, () => neverResolve);
	for (let i = 0; i < 10; i++) queue.schedule(PRIORITY.PLAYER, () => neverResolve);
	await tick();
	assert.equal(queue.stats.runningByPriority.player, 6, "PLAYER занял свой потолок целиком");

	const overlayResult = await queue.schedule(PRIORITY.OVERLAY, async () => "overlay-done");
	assert.equal(overlayResult, "overlay-done", "OVERLAY получил слот, несмотря на насыщенный поток PLAYER");
});

test("слот освобождается при отказе fn() — следующая задача всё равно выполняется", async () => {
	const queue = createRequestQueue({ limit: 1, playerMax: 1, otherMax: 1 });
	const first = queue.schedule(PRIORITY.PREVIEW, async () => {
		throw new Error("сбой сети");
	});
	await assert.rejects(() => first, /сбой сети/);

	const second = await queue.schedule(PRIORITY.PREVIEW, async () => "ok");
	assert.equal(second, "ok");
});

test("отмена до старта: задача не вызывается ни разу, промис отклонён AbortError", async () => {
	const queue = createRequestQueue({ limit: 1, playerMax: 1, otherMax: 1 });
	const busyGate = deferred();
	const busy = queue.schedule(PRIORITY.PREVIEW, async () => {
		await busyGate.promise;
	});
	await tick();

	const controller = new AbortController();
	let called = false;
	const cancelled = queue.schedule(
		PRIORITY.PREVIEW,
		async () => {
			called = true;
		},
		{ signal: controller.signal },
	);
	controller.abort();
	await assert.rejects(() => cancelled, /AbortError|Отменено/);

	busyGate.resolve();
	await busy;
	await tick();
	assert.equal(called, false, "отменённая до старта задача не должна была вызваться");
});

test("отмена после старта: fn вызвана, слот освобождён по завершении (очередь отмену не форсирует)", async () => {
	const queue = createRequestQueue({ limit: 1, playerMax: 1, otherMax: 1 });
	const controller = new AbortController();
	const gate = deferred();
	let called = false;

	const result = queue.schedule(
		PRIORITY.PREVIEW,
		async () => {
			called = true;
			await gate.promise;
			return "done";
		},
		{ signal: controller.signal },
	);
	await tick();
	assert.equal(called, true, "задача уже стартовала");
	controller.abort(); // после старта — очередь это игнорирует, сама fn должна учесть signal

	gate.resolve();
	assert.equal(await result, "done");
	assert.equal(queue.stats.running, 0, "слот освобождён после завершения");
});

test("signal уже отменён к моменту постановки — задача не встаёт в очередь вовсе", async () => {
	const queue = createRequestQueue({ limit: 1, playerMax: 1, otherMax: 1 });
	const controller = new AbortController();
	controller.abort();
	let called = false;
	await assert.rejects(
		() => queue.schedule(PRIORITY.PREVIEW, async () => { called = true; }, { signal: controller.signal }),
		/AbortError|Отменено/,
	);
	assert.equal(called, false);
	assert.equal(queue.stats.queued, 0);
});
