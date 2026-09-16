import { test } from "node:test";
import assert from "node:assert/strict";
import { formatLastSeen } from "../src/ui/format-last-seen.js";

function local(y, m, d, hh = 0, mm = 0, ss = 0) {
	return new Date(y, m, d, hh, mm, ss).getTime();
}

test("нет данных -> пустая строка", () => {
	assert.equal(formatLastSeen(null, Date.now()), "");
	assert.equal(formatLastSeen(undefined, Date.now()), "");
	assert.equal(formatLastSeen(0, Date.now()), "");
});

test("меньше 60 с назад -> был только что", () => {
	const now = local(2026, 5, 10, 12, 0, 30);
	assert.equal(formatLastSeen(now - 1_000, now, { locale: "ru" }), "был только что");
	assert.equal(formatLastSeen(now - 59_000, now, { locale: "ru" }), "был только что");
});

test("ровно 60 с — уже не «только что», те же сутки -> сегодня", () => {
	const now = local(2026, 5, 10, 12, 0, 0);
	assert.equal(formatLastSeen(now - 60_000, now, { locale: "ru" }), "сегодня в 11:59");
});

test("23:59:30 → 00:00:30 следующих суток: «вчера», не «был только что»", () => {
	const ts = local(2026, 5, 10, 23, 59, 30);
	const now = local(2026, 5, 11, 0, 0, 30);
	assert.equal(formatLastSeen(ts, now, { locale: "ru" }), "вчера в 23:59");
});

test("воскресенье 22:00, смотрим в понедельник: «вчера», хотя это и прошлая календарная неделя", () => {
	// 2026-06-14 — воскресенье, 2026-06-15 — понедельник.
	const ts = local(2026, 5, 14, 22, 0, 0);
	const now = local(2026, 5, 15, 10, 0, 0);
	assert.equal(formatLastSeen(ts, now, { locale: "ru" }), "вчера в 22:00");
});

test("пятница, смотрим на понедельник той же недели → в понедельник (позавчера уже не подходит — прошло 4 суток)", () => {
	// 2026-06-15 понедельник, 2026-06-19 пятница. C1: двое суток = «позавчера»,
	// дальше по таблице — день недели той же календарной недели.
	const ts = local(2026, 5, 15, 12, 30, 0);
	const now = local(2026, 5, 19, 18, 0, 0);
	assert.equal(formatLastSeen(ts, now, { locale: "ru" }), "в понедельник в 12:30");
});

test("среда, смотрим на воскресенье до него → в прошлое воскресенье", () => {
	const ts = local(2026, 5, 14, 11, 10, 0);
	const now = local(2026, 5, 17, 18, 0, 0);
	assert.equal(formatLastSeen(ts, now, { locale: "ru" }), "в прошлое воскресенье в 11:10");
});

test("31 декабря → 1 января: «вчера», не дата с годом", () => {
	const ts = local(2025, 11, 31, 20, 0, 0);
	const now = local(2026, 0, 1, 9, 0, 0);
	assert.equal(formatLastSeen(ts, now, { locale: "ru" }), "вчера в 20:00");
});

test("время в будущем (кривые часы контакта) зажато к now → был только что", () => {
	const now = local(2026, 5, 10, 12, 0, 0);
	assert.equal(formatLastSeen(now + 3_600_000, now, { locale: "ru" }), "был только что");
});

test("вторник во всех трёх формах: во вторник / в прошлый вторник / 12 сентября", () => {
	// 2026-09-08 вторник этой недели; с пятницы 11-го это уже не вчера/позавчера.
	assert.equal(formatLastSeen(local(2026, 8, 8, 9, 5, 0), local(2026, 8, 11, 12, 0, 0), { locale: "ru" }), "во вторник в 9:05");
	// 2026-09-01 вторник прошлой недели, смотрим с понедельника 7-го.
	assert.equal(formatLastSeen(local(2026, 8, 1, 11, 10, 0), local(2026, 8, 7, 12, 0, 0), { locale: "ru" }), "в прошлый вторник в 11:10");
	// 2026-09-12 суббота, смотрим в октябре того же года — уже не неделя.
	assert.equal(formatLastSeen(local(2026, 8, 12, 11, 10, 0), local(2026, 9, 5, 12, 0, 0), { locale: "ru" }), "12 сентября в 11:10");
});

test("позавчера — со временем", () => {
	const ts = local(2026, 5, 15, 9, 5, 0);
	const now = local(2026, 5, 17, 12, 0, 0);
	assert.equal(formatLastSeen(ts, now, { locale: "ru" }), "позавчера в 9:05");
});

test("другой год: 12 сентября 2025 без времени", () => {
	const ts = local(2025, 8, 12, 11, 10, 0);
	const now = local(2026, 2, 1, 12, 0, 0);
	assert.equal(formatLastSeen(ts, now, { locale: "ru" }), "12 сентября 2025");
});

test("сутки считаются локальной зоной (конструктор Date(y,m,d), не Date.UTC)", () => {
	const ts = local(2026, 5, 15, 23, 30, 0);
	const now = local(2026, 5, 15, 23, 45, 0);
	assert.equal(formatLastSeen(ts, now, { locale: "ru" }), "сегодня в 23:30");
});

test("en: just now / today / yesterday", () => {
	const now = local(2026, 5, 10, 12, 0, 30);
	assert.equal(formatLastSeen(now - 1_000, now, { locale: "en" }), "just now");
	assert.equal(formatLastSeen(local(2026, 5, 10, 11, 0, 0), now, { locale: "en" }), "today at 11:00");
	assert.equal(formatLastSeen(local(2026, 5, 9, 10, 10, 0), now, { locale: "en" }), "yesterday at 10:10");
});
