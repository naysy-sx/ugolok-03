import "fake-indexeddb/auto";
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import Dexie from "dexie";
import { db } from "../src/core/store/database.js";

// AUDIT-EGOROD E2. Раньше миграции проверял единственный тест (v32). Здесь:
//  1. «замороженная история схемы» — объявления старых версий Dexie править НЕЛЬЗЯ
//     (правка задним числом молча ломает апгрейд у тех, кто уже на этой версии);
//  2. реальные апгрейды: база версии N с данными открывается текущей схемой и
//     данные целы, для каждого N от FIRST_UPGRADABLE до текущей;
//  3. граница совместимости: базы старше FIRST_UPGRADABLE (смена первичных
//     ключей в версиях 4–6 и 14, Dexie так не умеет) НЕ открываются — фиксируем это
//     как известное поведение, чтобы оно не менялось незаметно (UnlockScreen
//     предлагает пользователю осознанный сброс, unlock.jsx step "db-error").
//
// Внутренний API db._versions используется только в тестах (Dexie закреплён ^4).

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURE = join(HERE, "fixtures/dexie-schema-history.json");
const FIRST_UPGRADABLE = 14; // старее — смена первичных ключей существующих таблиц (v4–v6, v14: channelSyncState)
const declared = db._versions.map((v) => ({ version: v._cfg.version, stores: v._cfg.storesSource }));
const CURRENT = declared.at(-1).version;

test("история схемы: объявления уже выпущенных версий не изменены (append-only)", () => {
	if (!existsSync(FIXTURE) || process.env.UPDATE_DEXIE_FIXTURE === "1") {
		writeFileSync(FIXTURE, JSON.stringify(declared, null, "\t") + "\n");
	}
	const frozen = JSON.parse(readFileSync(FIXTURE, "utf8"));
	for (const old of frozen) {
		const now = declared.find((d) => d.version === old.version);
		assert.ok(now, `версия ${old.version} исчезла из database.js — удалять версии нельзя`);
		assert.deepEqual(now.stores, old.stores, `версия ${old.version} изменена задним числом: добавьте НОВУЮ версию (обновить зафиксированную историю: UPDATE_DEXIE_FIXTURE=1 — только при добавлении версий)`);
	}
});

function scratchAt(version) {
	const scratch = new Dexie("ugolok");
	for (const d of declared.filter((x) => x.version <= version)) scratch.version(d.version).stores(d.stores);
	return scratch;
}

async function resetAll() {
	db.close();
	await Dexie.delete("ugolok");
}

for (const from of declared.map((d) => d.version).filter((v) => v >= FIRST_UPGRADABLE && v < CURRENT)) {
	test(`апгрейд v${from} → v${CURRENT}: данные целы`, async () => {
		await resetAll();
		const old = scratchAt(from);
		await old.open();
		await old.table("events").put({ id: "evt-1", pubkey: "p", kind: 1, created_at: 1, tags: [], flatTags: [] });
		await old.table("messages").put({ ownerPubkey: "o", chatId: "c", msgId: "m1", lamportTs: 1, senderPubkey: "s", id: "msg-1", status: "sent", deleted: 0, text: "секрет" });
		if (from >= 13) await old.table("discoverySettings").put({ ownerPubkey: "o", visible: true, showChannels: true, channelIds: [] });
		if (from >= 24) await old.table("contactProfiles").put({ ownerPubkey: "o", contactPubkey: "c1", name: "Боб" });
		old.close();

		await db.open();
		assert.equal(db.verno, CURRENT);
		assert.equal((await db.table("events").where("id").equals("evt-1").first()).kind, 1);
		const msg = await db.table("messages").where("id").equals("msg-1").first();
		assert.equal(msg.text, "секрет");
		assert.equal(msg.chatId, "c");

		// апгрейды со смыслом данных — только там, где они объявлены
		if (from >= 13 && from < 30) {
			const row = await db.table("discoverySettings").get("o");
			assert.equal(row.visible, false, "v30: никого не оставляем «видимым бессрочно» молча");
			assert.equal(row.visibleUntil, 0);
		}
		if (from >= 13 && from < 32) assert.equal((await db.table("discoverySettings").get("o")).showBio, true);
		if (from >= 24 && from < 29) {
			const p = await db.table("contactProfiles").get(["o", "c1"]);
			assert.equal(p.watched, 0, "v29: старые профили — это контакты");
			assert.equal(p.seenAt, 0);
		}
	});
}

test("новая база создаётся сразу на текущей версии со всеми таблицами", async () => {
	await resetAll();
	await db.open();
	assert.equal(db.verno, CURRENT);
	assert.ok(db.tables.length >= 60);
});

// Граница проверяется В ОБЕ стороны: версия ниже FIRST_UPGRADABLE обязана не
// открываться, а сама FIRST_UPGRADABLE — открываться. Так константа выше не может
// молча разойтись с реальностью (например, если кто-то изменит первичный ключ в
// новой версии — тест апгрейда выше упадёт, а не проскочит).
for (const from of [3, 6, 13]) {
	test(`граница совместимости: база v${from} не открывается (смена первичных ключей) — известное поведение, UI предлагает сброс`, async () => {
		await resetAll();
		const old = scratchAt(from);
		await old.open();
		old.close();
		await assert.rejects(() => db.open(), (e) => e.name === "UpgradeError" && /primary key/i.test(e.message));
		await resetAll();
	});
}

test(`граница совместимости: v${FIRST_UPGRADABLE} — самая старая открываемая версия`, async () => {
	await resetAll();
	const old = scratchAt(FIRST_UPGRADABLE);
	await old.open();
	old.close();
	await db.open();
	assert.equal(db.verno, CURRENT);
	await resetAll();
});

// AUDIT-EGOROD E3: вкладка со старым кодом при апгрейде базы другой вкладкой
// закрывает соединение явно и сообщает об этом оболочке (событие), а не молча
// продолжает жить с падающими операциями.
test("versionchange: старая вкладка закрывает базу и шлёт событие для перезагрузки", async () => {
	await resetAll();
	await db.open();
	const events = [];
	const origWindow = globalThis.window;
	globalThis.window = { dispatchEvent: (e) => events.push(e.type) };
	try {
		// объявление «новой вкладки»: все прежние версии + одна новая
		const full = new Dexie("ugolok");
		for (const d of declared) full.version(d.version).stores(d.stores);
		full.version(CURRENT + 1).stores({ zz_future_table: "id" });
		await full.open(); // вызывает versionchange у уже открытого db
		assert.equal(db.isOpen(), false, "старое соединение закрыто явно");
		assert.deepEqual(events, ["ugolok:db-versionchange"]);
		full.close();
	} finally {
		globalThis.window = origWindow;
		await Dexie.delete("ugolok");
	}
});
