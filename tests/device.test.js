import "fake-indexeddb/auto";
import { test } from "node:test";
import assert from "node:assert/strict";
import { db } from "../src/core/store/database.js";
import { getOrCreateDeviceId } from "../src/domain/identity/device.js";

test("getOrCreateDeviceId: первый вызов создаёт и персистит 32-символьный hex deviceId", async () => {
	await db.open();
	await db.table("deviceIdentity").clear();
	const deviceId = await getOrCreateDeviceId();
	assert.equal(typeof deviceId, "string");
	assert.match(deviceId, /^[0-9a-f]{32}$/, "16 случайных байт в hex");
	const row = await db.table("deviceIdentity").get("self");
	assert.equal(row.deviceId, deviceId);
	db.close();
});

test("getOrCreateDeviceId: повторный вызов возвращает ТОТ ЖЕ id, не генерирует новый", async () => {
	await db.open();
	await db.table("deviceIdentity").clear();
	const first = await getOrCreateDeviceId();
	const second = await getOrCreateDeviceId();
	assert.equal(first, second);
	const rows = await db.table("deviceIdentity").toArray();
	assert.equal(rows.length, 1, "не должно быть второй строки");
	db.close();
});

test("getOrCreateDeviceId: два разных вызова после clear() дают разные id (случайность)", async () => {
	await db.open();
	await db.table("deviceIdentity").clear();
	const a = await getOrCreateDeviceId();
	await db.table("deviceIdentity").clear();
	const b = await getOrCreateDeviceId();
	assert.notEqual(a, b);
	db.close();
});
