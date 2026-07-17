import { test } from "node:test";
import assert from "node:assert/strict";
import { transition } from "../src/core/fsm/machine.js";

// Игрушечный автомат (светофор) — не завязан ни на один реальный домен проекта,
// проверяет только сам движок.
const TRAFFIC_LIGHT = {
	red: { GO: "green" },
	green: { CAUTION: "yellow" },
	yellow: { STOP: "red" },
};

test("transition: корректный переход возвращает новое состояние", () => {
	assert.equal(transition(TRAFFIC_LIGHT, "red", "GO"), "green");
	assert.equal(transition(TRAFFIC_LIGHT, "green", "CAUTION"), "yellow");
	assert.equal(transition(TRAFFIC_LIGHT, "yellow", "STOP"), "red");
});

test("transition: недопустимый переход бросает, не no-op и не undefined", () => {
	assert.throws(() => transition(TRAFFIC_LIGHT, "red", "STOP"));
	assert.throws(() => transition(TRAFFIC_LIGHT, "green", "GO"));
});

test("transition: неизвестное состояние (не описанное в таблице вовсе) бросает", () => {
	assert.throws(() => transition(TRAFFIC_LIGHT, "blinking", "GO"));
});

test("F3: чистая функция — не мутирует переданную таблицу переходов", () => {
	const snapshot = JSON.parse(JSON.stringify(TRAFFIC_LIGHT));
	transition(TRAFFIC_LIGHT, "red", "GO");
	transition(TRAFFIC_LIGHT, "green", "CAUTION");
	assert.deepEqual(TRAFFIC_LIGHT, snapshot);
});

test("F1/F3: детерминизм — одинаковый вход даёт одинаковый выход при повторных вызовах", () => {
	const a = transition(TRAFFIC_LIGHT, "red", "GO");
	const b = transition(TRAFFIC_LIGHT, "red", "GO");
	assert.equal(a, b);
});

test("F4: wildcard-состояние — событие определено для '*', срабатывает из любого состояния", () => {
	const withWildcard = {
		disconnected: { CONNECT: "connecting" },
		connecting: { OPEN: "connected" },
		connected: {},
		"*": { CLOSE: "disconnected", ERROR: "disconnected" },
	};
	assert.equal(transition(withWildcard, "connecting", "CLOSE"), "disconnected");
	assert.equal(transition(withWildcard, "connected", "ERROR"), "disconnected");
	assert.equal(transition(withWildcard, "disconnected", "CLOSE"), "disconnected");
});

test("F4: конкретное состояние побеждает wildcard для той же пары событие/эффективный-переход", () => {
	const withOverride = {
		special: { CLOSE: "special-closed" },
		"*": { CLOSE: "generic-closed" },
	};
	assert.equal(transition(withOverride, "special", "CLOSE"), "special-closed");
	assert.equal(transition(withOverride, "other", "CLOSE"), "generic-closed");
});

test("F4: таблица без '*' не даёт неожиданных переходов на неизвестные события (нет скрытого фоллбэка)", () => {
	assert.throws(() => transition(TRAFFIC_LIGHT, "red", "CLOSE"));
});
