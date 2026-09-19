import { test } from "node:test";
import assert from "node:assert/strict";
import { selectMirrorEvictions, buildPullFilter, recordAttempt, backoffDelayMs, budgetOf, LOG_AFTER_FAILURES } from "../server/strfry/mirror-lib.mjs";

// GATEWAY-TZ-1.md §3–§4: тяга и бюджет зеркала (чистые функции).

const OWN = "a".repeat(64);
const FOREIGN = "b".repeat(64);
const NOW = 1_800_000_000;
const DAY = 86400;
const PEERS = { kinds: [30050], peers: [{ id: "b", name: "Б", url: "wss://b.example" }], budget: { maxBytes: 1000, retentionDays: 10 } };
const ev = (id, pubkey, kind, ageDays, size = 100) => ({ id, pubkey, kind, created_at: NOW - ageDays * DAY, size });
const run = (events, over = {}) => selectMirrorEvictions(events, { whitelist: new Set([OWN]), peers: PEERS, nowSec: NOW, sizeOf: (e) => e.size, ...over });

test("очистка: свои события не вытесняются никогда — ни по сроку, ни по объёму", () => {
	const events = [ev("own-old", OWN, 30050, 400, 5000), ev("own-new", OWN, 30050, 1, 5000)];
	const res = run(events);
	assert.deepEqual(res.ids, []);
});

test("очистка: чужое старше срока хранения удаляется, свежее остаётся", () => {
	const res = run([ev("old", FOREIGN, 30050, 11), ev("fresh", FOREIGN, 30050, 2)]);
	assert.deepEqual(res.ids, ["old"]);
});

test("очистка: превышение потолка вытесняет самые старые чужие до нижней отметки, свои не считаются", () => {
	// 12 чужих по 100 байт = 1200 > 1000; нижняя отметка 900 → уйдут три самых старых
	const foreign = Array.from({ length: 12 }, (_, i) => ev(`f${i}`, FOREIGN, 30050, 9 - i * 0.5));
	const res = run([...foreign, ev("own", OWN, 30050, 1, 10_000_000)]);
	assert.equal(res.ids.length, 3);
	assert.deepEqual(res.ids, ["f0", "f1", "f2"]);
	assert.ok(res.keptBytes <= 900);
	assert.ok(res.sizeCutoffSec > 0, "граница для тяги записана");
});

test("очистка: чужие события посторонних kind'ов не трогаются", () => {
	assert.deepEqual(run([ev("odd", FOREIGN, 1, 100)]).ids, []);
});

test("очистка: whitelist '*' → отказ, а не удаление на глаз", () => {
	const res = run([ev("x", FOREIGN, 30050, 100)], { whitelist: new Set(["*"]) });
	assert.match(res.error, /'\*'/);
	assert.equal(res.ids, undefined);
});

test("очистка: пустой peers.json (нет зеркальных kind'ов) ничего не удаляет", () => {
	assert.deepEqual(run([ev("x", FOREIGN, 30050, 100)], { peers: { kinds: [], peers: [] } }).ids, []);
});

test("фильтр тяги: kind'ы пира, не раньше срока хранения и не раньше границы прошлой очистки", () => {
	const peer = PEERS.peers[0];
	assert.deepEqual(buildPullFilter(peer, PEERS, { nowSec: NOW }), { kinds: [30050], since: NOW - 10 * DAY });
	const cutoff = NOW - 3 * DAY;
	assert.equal(buildPullFilter(peer, PEERS, { nowSec: NOW, pruneCutoffSec: cutoff }).since, cutoff + 1);
	assert.equal(buildPullFilter(peer, PEERS, { nowSec: NOW, pruneCutoffSec: NOW - 50 * DAY }).since, NOW - 10 * DAY);
});

test("фильтр тяги: личные kind'ы вычеркиваются, пустой набор → null (нечего тянуть)", () => {
	const reckless = { kinds: [445, 1059, 30050], peers: [{ url: "wss://b.example" }] };
	assert.deepEqual(buildPullFilter(reckless.peers[0], reckless, { nowSec: NOW }).kinds, [30050]);
	const onlyPrivate = { kinds: [445, 4], peers: [{ url: "wss://b.example" }] };
	assert.equal(buildPullFilter(onlyPrivate.peers[0], onlyPrivate, { nowSec: NOW }), null);
});

test("бюджет: значения по умолчанию при мусоре в конфиге", () => {
	const b = budgetOf({ budget: { maxBytes: -5, retentionDays: "abc" } });
	assert.ok(b.maxBytes > 0 && b.retentionDays > 0);
});

test("отступление: экспонента с потолком, как computeBackoffDelay", () => {
	const noJitter = { jitter: 0, random: () => 0.5 };
	assert.equal(backoffDelayMs(0, 1000, noJitter), 1000);
	assert.ok(Math.abs(backoffDelayMs(1, 1000, noJitter) - 1700) < 1e-6);
	assert.equal(backoffDelayMs(50, 1000, { ...noJitter, maxMs: 5000 }), 5000);
});

test("недоступный пир молчит в журнале до порога, пишет один раз, потом одну строку о восстановлении", () => {
	let state;
	const logs = [];
	for (let i = 0; i < LOG_AFTER_FAILURES + 3; i++) {
		let log;
		[state, log] = recordAttempt(state, false, { nowMs: 0, baseMs: 1000, random: () => 0.5 });
		logs.push(log);
	}
	assert.deepEqual(logs.slice(0, LOG_AFTER_FAILURES - 1), Array(LOG_AFTER_FAILURES - 1).fill(null), "ниже порога — тишина");
	assert.equal(logs[LOG_AFTER_FAILURES - 1], "unreachable");
	assert.deepEqual(logs.slice(LOG_AFTER_FAILURES), [null, null, null], "повторно не пишем");
	assert.ok(state.nextAttemptAt > 0, "следующая попытка отложена");
	let log;
	[state, log] = recordAttempt(state, true, { nowMs: 0, baseMs: 1000 });
	assert.equal(log, "recovered");
	assert.equal(state.failures, 0);
	[, log] = recordAttempt(state, true, { nowMs: 0, baseMs: 1000 });
	assert.equal(log, null, "здоровый пир ничего не пишет");
});
