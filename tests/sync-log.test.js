import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { syncLog, resetSyncLog, logSync } from "../src/ui/signals/sync-log.js";

beforeEach(() => {
	resetSyncLog();
});

test("resetSyncLog: изначально/после сброса — пустой массив", () => {
	assert.deepEqual(syncLog.value, []);
});

test("logSync: добавляет запись {ts, text} в конец, не мутирует предыдущий массив (сигнальная реактивность требует нового Array)", () => {
	const before = syncLog.value;
	logSync("Подключение к серверу…");
	assert.notEqual(syncLog.value, before, "должен быть НОВЫЙ массив, не мутация старого (иначе @preact/signals не заметит изменения)");
	assert.equal(syncLog.value.length, 1);
	assert.equal(syncLog.value[0].text, "Подключение к серверу…");
	assert.equal(typeof syncLog.value[0].ts, "number");
});

test("logSync: несколько вызовов накапливаются по порядку, не заменяют друг друга", () => {
	logSync("Профиль…");
	logSync("Профиль — готово");
	logSync("Контакты…");
	assert.deepEqual(syncLog.value.map((e) => e.text), ["Профиль…", "Профиль — готово", "Контакты…"]);
});

test("logSync: ts монотонно не убывает между записями", () => {
	logSync("шаг 1");
	logSync("шаг 2");
	const [first, second] = syncLog.value;
	assert.ok(second.ts >= first.ts);
});

test("resetSyncLog: очищает накопленный лог перед новым подключением", () => {
	logSync("старая сессия");
	logSync("ещё старая сессия");
	resetSyncLog();
	assert.deepEqual(syncLog.value, [], "новое подключение не должно показывать лог прошлой сессии");
});
