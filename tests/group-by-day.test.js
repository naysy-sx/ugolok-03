import { test } from "node:test";
import assert from "node:assert/strict";
import { groupByDay } from "../src/ui/group-by-day.js";
import { setLocale } from "../src/ui/signals/i18n.js";

// CHANNEL-V2 части C3/E3 — общая группировка по дню (лента канала + чат).

setLocale("ru");

const DAY = 86400;

// "Сегодня"/"Вчера" в groupByDay читает Date.now() ЖИВЬЁМ на каждый вызов —
// если startOfToday посчитан один раз на уровне модуля, а сам тест выполнится
// позже (весь прогон tests/ занимает десятки секунд, файлы идут не мгновенно),
// смена суток посреди прогона делает "заморожённое" now устаревшим и тест
// становится гонкой по реальным часам. startOfToday() пересчитывается заново
// в каждом тесте, вплотную к вызову groupByDay — окно гонки схлопывается до
// одного синхронного вызова, а не длительности всего прогона.
//
// АДВЕРСАРНЫЙ БАГ (найден живым прогоном в часовом поясе UTC+3): начало
// суток — ЛОКАЛЬНОЕ время (setHours), НЕ Math.floor(unix/DAY)*DAY — та
// формула выравнивает по UTC-эпохе, и уже в UTC+1 и восточнее полночь по UTC
// не совпадает с локальной полночью на несколько часов, day-of-month съезжает
// на сутки. group-by-day.js's dayKey сам берёт локальное время (getFullYear/
// getMonth/getDate) — тест обязан мерить день тем же способом, иначе
// сравнивает две разные шкалы. Тот же приём, что due-schedule.js's
// groupDueRecords (тоже локальное, не getUTCHours).
function startOfToday() {
	return new Date(Date.now()).setHours(0, 0, 0, 0) / 1000;
}

test("groupByDay: пустой список -> пустой массив групп", () => {
	assert.deepEqual(groupByDay([]), []);
});

test("groupByDay: все элементы одного дня -> одна группа со всеми items", () => {
	const today = startOfToday();
	const items = [{ createdAt: today + 10 }, { createdAt: today + 20 }, { createdAt: today + 30 }];
	const groups = groupByDay(items);
	assert.equal(groups.length, 1);
	assert.equal(groups[0].items.length, 3);
});

test("groupByDay: сегодня подписан 'Сегодня', вчера — 'Вчера'", () => {
	const today = startOfToday();
	const items = [{ createdAt: today + 10 }, { createdAt: today - DAY + 10 }];
	const groups = groupByDay(items);
	assert.equal(groups.length, 2);
	assert.equal(groups[0].dayLabel, "Сегодня");
	assert.equal(groups[1].dayLabel, "Вчера");
});

test("groupByDay: дата старше вчера -> не 'Сегодня'/'Вчера', а форматированная дата", () => {
	const today = startOfToday();
	const items = [{ createdAt: today - 10 * DAY }];
	const groups = groupByDay(items);
	assert.equal(groups.length, 1);
	assert.notEqual(groups[0].dayLabel, "Сегодня");
	assert.notEqual(groups[0].dayLabel, "Вчера");
	assert.ok(groups[0].dayLabel.length > 0);
});

test("groupByDay: сохраняет порядок элементов внутри группы (не пересортировывает)", () => {
	const today = startOfToday();
	const items = [{ createdAt: today + 30, id: "c" }, { createdAt: today + 20, id: "b" }, { createdAt: today + 10, id: "a" }];
	const groups = groupByDay(items);
	assert.deepEqual(groups[0].items.map((i) => i.id), ["c", "b", "a"]);
});

test("groupByDay: смена дня посреди СМЕЖНЫХ элементов -> новая группа, не разрывает уже открытую при возврате к старому дню", () => {
	// items идут в порядке убывания даты (как лента/чат) — день не должен
	// "переоткрываться" повторно, если он не смежный с текущей группой.
	const today = startOfToday();
	const items = [
		{ createdAt: today + 10, id: "today-1" },
		{ createdAt: today - DAY + 10, id: "yesterday-1" },
		{ createdAt: today - 2 * DAY + 10, id: "day-before" },
	];
	const groups = groupByDay(items);
	assert.equal(groups.length, 3);
	assert.deepEqual(groups.map((g) => g.items.map((i) => i.id)), [["today-1"], ["yesterday-1"], ["day-before"]]);
});

test("groupByDay: кастомный getCreatedAt (например, для сообщений чата)", () => {
	const items = [{ sentAt: startOfToday() + 5 }];
	const groups = groupByDay(items, (m) => m.sentAt);
	assert.equal(groups.length, 1);
	assert.equal(groups[0].dayLabel, "Сегодня");
});
