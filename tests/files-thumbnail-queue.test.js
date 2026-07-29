import { test } from "node:test";
import assert from "node:assert/strict";
import { createThumbnailQueue } from "../src/domain/files/thumbnail-queue.js";

function deferred() {
	let resolve;
	const promise = new Promise((r) => {
		resolve = r;
	});
	return { promise, resolve };
}

test("не превышает maxConcurrent одновременно работающих задач", async () => {
	const queue = createThumbnailQueue(2);
	const gates = [deferred(), deferred(), deferred(), deferred()];
	const maxObserved = { value: 0 };

	const handles = gates.map((gate, i) =>
		queue.enqueue(async () => {
			maxObserved.value = Math.max(maxObserved.value, queue.runningCount);
			await gate.promise;
			return i;
		}),
	);

	await new Promise((r) => setTimeout(r, 10)); // дать очереди стартовать первые maxConcurrent
	assert.equal(queue.runningCount, 2, "должны стартовать ровно 2 (maxConcurrent), не 4");

	gates[0].resolve();
	gates[1].resolve();
	await new Promise((r) => setTimeout(r, 10));
	assert.equal(queue.runningCount, 2, "освободившиеся слоты подхватили следующие 2 из очереди");

	gates[2].resolve();
	gates[3].resolve();
	const results = await Promise.all(handles.map((h) => h.promise));
	assert.deepEqual(results, [0, 1, 2, 3]);
	assert.ok(maxObserved.value <= 2, `в любой момент работало не больше 2, замечено ${maxObserved.value}`);
});

test("cancel() ДО старта — задача вообще не вызывается", async () => {
	const queue = createThumbnailQueue(1);
	const gate = deferred();
	let taskCalls = 0;

	// Занимаем единственный слот долгой задачей.
	const busy = queue.enqueue(async () => {
		taskCalls++;
		await gate.promise;
	});
	await new Promise((r) => setTimeout(r, 5));

	// Вторая задача встаёт в очередь (слот занят) — отменяем ДО того, как освободится слот.
	let secondTaskCalled = false;
	const second = queue.enqueue(async () => {
		secondTaskCalled = true;
	});
	second.cancel();

	gate.resolve();
	await busy.promise;
	await new Promise((r) => setTimeout(r, 10));

	assert.equal(secondTaskCalled, false, "отменённая ДО старта задача не должна была вызваться");
	assert.equal(taskCalls, 1);
});

test("cancel() ПОСЛЕ старта — задача докручивается (отмена не прерывает уже идущее)", async () => {
	const queue = createThumbnailQueue(1);
	const gate = deferred();
	let completed = false;

	const handle = queue.enqueue(async () => {
		await gate.promise;
		completed = true;
		return "done";
	});
	await new Promise((r) => setTimeout(r, 10)); // задача уже стартовала
	handle.cancel(); // ALGO.MD: отмена работает только для ещё не стартовавших

	gate.resolve();
	const result = await handle.promise;
	assert.equal(completed, true);
	assert.equal(result, "done");
});

test("отклонение задачи не роняет очередь — следующие задачи всё равно выполняются", async () => {
	const queue = createThumbnailQueue(1);
	const first = queue.enqueue(async () => {
		throw new Error("сбой декодирования");
	});
	await assert.rejects(() => first.promise, /сбой декодирования/);

	const second = queue.enqueue(async () => "ok");
	assert.equal(await second.promise, "ok");
});

test("runningCount/pendingCount отражают реальное состояние очереди", async () => {
	const queue = createThumbnailQueue(1);
	const gate = deferred();
	queue.enqueue(async () => gate.promise);
	queue.enqueue(async () => {});
	queue.enqueue(async () => {});
	await new Promise((r) => setTimeout(r, 5));

	assert.equal(queue.runningCount, 1);
	assert.equal(queue.pendingCount, 2);
	gate.resolve();
});
