// CONTRACTS.md §DISCOVERY-REDESIGN, Э4 — db.version(32): discoverySettings
// получает showBio(true)/showRules(false) через .modify() для существующих
// строк. Тест — настоящий двухфазный Dexie-апгрейд: отдельный scratch-
// экземпляр Dexie на ТОМ ЖЕ имени базы ("ugolok", database.js:4) поднимает
// её до v31 и кладёт "старую" строку БЕЗ showBio/showRules, затем
// открывается настоящий db (объявляет версии 1..32) — Dexie видит текущую
// версию 31 и применяет только диф version(32), включая .upgrade().
// Изолировано в СВОЙ файл: node --test запускает каждый файл в отдельном
// процессе, поэтому "недособранная" на промежуточных версиях scratch-БД
// не задевает остальные тестовые файлы (там открывается db.js "с нуля",
// сразу на v32, upgrade-колбэки не нужны).
import "fake-indexeddb/auto";
import { test, after } from "node:test";
import assert from "node:assert/strict";
import Dexie from "dexie";

test("db.version(32): строка discoverySettings, созданная на v31, после апгрейда получает showBio:true/showRules:false", async () => {
	const scratch = new Dexie("ugolok");
	scratch.version(31).stores({ discoverySettings: "ownerPubkey" });
	await scratch.open();
	await scratch.table("discoverySettings").put({
		ownerPubkey: "legacy-owner",
		visible: false,
		showChannels: true,
		channelIds: ["c1"],
		visibleUntil: 0,
	});
	scratch.close();

	const { db } = await import("../src/core/store/database.js");
	await db.open();
	const row = await db.table("discoverySettings").get("legacy-owner");
	assert.equal(row.showBio, true, "существующие строки не должны молча начать скрывать био");
	assert.equal(row.showRules, false);
	// Остальные поля не задеты миграцией.
	assert.equal(row.showChannels, true);
	assert.deepEqual(row.channelIds, ["c1"]);

	after(() => db.close());
});
