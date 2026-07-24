import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { toasts, pushToast, dismissToast } from "../src/ui/signals/toasts.js";

beforeEach(() => {
	toasts.value = [];
});

test("pushToast: добавляет тост в очередь с уникальным id, leaving=false", () => {
	const id = pushToast({ title: "Заголовок", body: "Тело" });
	assert.equal(toasts.value.length, 1);
	assert.equal(toasts.value[0].id, id);
	assert.equal(toasts.value[0].title, "Заголовок");
	assert.equal(toasts.value[0].leaving, false);
});

test("pushToast: несколько тостов сосуществуют, id разные", () => {
	const id1 = pushToast({ title: "A" });
	const id2 = pushToast({ title: "B" });
	assert.notEqual(id1, id2);
	assert.equal(toasts.value.length, 2);
});

test("dismissToast: сначала помечает leaving=true, НЕ удаляет сразу (даёт анимации отыграть)", () => {
	const id = pushToast({ title: "t" });
	dismissToast(id);
	assert.equal(toasts.value.length, 1, "тост ещё в массиве — уходит по таймеру, не мгновенно");
	assert.equal(toasts.value[0].leaving, true);
});

test("dismissToast: спустя время анимации ухода — реально удаляет из очереди", async () => {
	const id = pushToast({ title: "t" });
	dismissToast(id);
	await new Promise((resolve) => setTimeout(resolve, 250));
	assert.equal(toasts.value.length, 0);
});

test("dismissToast: несуществующий id -> не бросает, не трогает остальные", () => {
	pushToast({ title: "A" });
	assert.doesNotThrow(() => dismissToast(999999));
	assert.equal(toasts.value.length, 1);
});
