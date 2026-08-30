import "fake-indexeddb/auto";
import { test, before, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import { db } from "../src/core/store/database.js";
import { getPublicKey } from "../src/core/crypto/keys.js";
import { bytesToHex } from "@noble/hashes/utils.js";
import { contacts, discoveryProfiles, refreshDiscoveryProfiles } from "../src/ui/signals/contacts.js";
import { hideDiscoveryProfileLocally } from "../src/domain/discovery/reports.js";

const ALICE_PRIV = new Uint8Array(32).fill(9);
const ALICE_PUB = bytesToHex(getPublicKey(ALICE_PRIV));
const BOB_PRIV = new Uint8Array(32).fill(10);
const BOB_PUB = bytesToHex(getPublicKey(BOB_PRIV));
const CAROL_PRIV = new Uint8Array(32).fill(11);
const CAROL_PUB = bytesToHex(getPublicKey(CAROL_PRIV));

before(async () => {
	await db.open();
});

beforeEach(async () => {
	contacts.value = [];
	discoveryProfiles.value = [];
	await db.table("discoveryProfiles").clear();
	await db.table("contacts").clear();
	await db.table("discoveryHidden").clear();
});

after(() => {
	db.close();
});

// Этап 49 — sendAcquaintanceRequestAction/cancelAcquaintanceRequestAction/
// outgoingRequests/refreshOutgoingRequests убраны отсюда: оба пути отправки
// заявки ("Добавить контакт" И "Обзор") унифицированы в signals/contacts.js
// (sendContactRequestAction/cancelContactRequestAction/outgoingRequests) — их
// поведение (включая ЭТУ гарантию — "Обзор" не добавляет адресата оптимистично,
// это уже структурно верно для ОБОИХ путей теперь) покрыто contacts-signals.test.js.
// refreshDiscoveryProfiles — единственное, что осталось от discovery-специфичной
// логики (kind 30073, не связано с contact-relationship FSM); физически теперь в
// signals/contacts.js (этап 7, CONTRACTS.md — грид переехал на экран "Люди").

const FAR_FUTURE = Math.floor(Date.now() / 1000) + 86400;

test("refreshDiscoveryProfiles: показывает только visible=true И НЕ уже существующих контактов", async () => {
	await db.table("discoveryProfiles").bulkPut([
		{ pubkey: BOB_PUB, visible: true, showChannels: false, channels: [], visibleUntil: FAR_FUTURE, updatedAt: 1 },
		{ pubkey: CAROL_PUB, visible: true, showChannels: false, channels: [], visibleUntil: FAR_FUTURE, updatedAt: 1 },
		{ pubkey: "invisible-pub", visible: false, showChannels: false, channels: [], visibleUntil: FAR_FUTURE, updatedAt: 1 },
	]);
	await db.table("contacts").put({ owner: ALICE_PUB, pubkey: CAROL_PUB });
	contacts.value = [CAROL_PUB];

	await refreshDiscoveryProfiles(ALICE_PUB);

	const pubkeys = discoveryProfiles.value.map((p) => p.pubkey);
	assert.deepEqual(pubkeys, [BOB_PUB], "Кэрол уже контакт — скрыта; invisible-pub — не visible, тоже скрыт");
});

// CONTRACTS.md §DISCOVERY, T4 — читатель обязан отсеивать протухшие карточки
// сам (реле может не поддерживать NIP-40 expiration).
test("refreshDiscoveryProfiles: отсеивает записи с истёкшим visibleUntil", async () => {
	const past = Math.floor(Date.now() / 1000) - 10;
	await db.table("discoveryProfiles").bulkPut([
		{ pubkey: BOB_PUB, visible: true, showChannels: false, channels: [], visibleUntil: FAR_FUTURE, updatedAt: 1 },
		{ pubkey: CAROL_PUB, visible: true, showChannels: false, channels: [], visibleUntil: past, updatedAt: 1 },
	]);

	await refreshDiscoveryProfiles(ALICE_PUB);

	const pubkeys = discoveryProfiles.value.map((p) => p.pubkey);
	assert.deepEqual(pubkeys, [BOB_PUB], "у Кэрол visibleUntil в прошлом — протухла, скрыта");
});

// CONTRACTS.md §DISCOVERY, T9 — жалоба скрывает карточку у пожаловавшегося
// немедленно и навсегда, независимо от исхода публикации.
test("refreshDiscoveryProfiles: отсеивает записи, скрытые через discoveryHidden (для ЭТОГО владельца)", async () => {
	await db.table("discoveryProfiles").bulkPut([
		{ pubkey: BOB_PUB, visible: true, showChannels: false, channels: [], visibleUntil: FAR_FUTURE, bio: "", updatedAt: 1 },
		{ pubkey: CAROL_PUB, visible: true, showChannels: false, channels: [], visibleUntil: FAR_FUTURE, bio: "", updatedAt: 1 },
	]);
	await hideDiscoveryProfileLocally(ALICE_PUB, CAROL_PUB);

	await refreshDiscoveryProfiles(ALICE_PUB);

	const pubkeys = discoveryProfiles.value.map((p) => p.pubkey);
	assert.deepEqual(pubkeys, [BOB_PUB], "Кэрол скрыта локально этим владельцем");
});

test("refreshDiscoveryProfiles: скрытие ДРУГИМ владельцем не влияет — не общий бан-лист", async () => {
	await db.table("discoveryProfiles").bulkPut([
		{ pubkey: BOB_PUB, visible: true, showChannels: false, channels: [], visibleUntil: FAR_FUTURE, bio: "", updatedAt: 1 },
	]);
	await hideDiscoveryProfileLocally("someone-else-owner", BOB_PUB);

	await refreshDiscoveryProfiles(ALICE_PUB);

	assert.deepEqual(discoveryProfiles.value.map((p) => p.pubkey), [BOB_PUB]);
});

// CONTRACTS.md §DISCOVERY, T8 — не прошедшие словарь отсеиваются тихо, тем же
// фильтром. Синтетический словарь через мок в самом discoveryProfiles не
// нужен — refreshDiscoveryProfiles читает реальный stopwords.json, поэтому
// тест использует РЕАЛЬНОЕ слово из него, не подставное (иначе тест ничего
// не проверил бы про интеграцию с настоящим словарём).
test("refreshDiscoveryProfiles: отсеивает карточки, чьё bio не проходит словарный фильтр", async () => {
	const stopwordsModule = await import("../src/domain/discovery/stopwords.json", { with: { type: "json" } });
	const badWord = stopwordsModule.default[0];
	await db.table("discoveryProfiles").bulkPut([
		{ pubkey: BOB_PUB, visible: true, showChannels: false, channels: [], visibleUntil: FAR_FUTURE, bio: "нормальное био", updatedAt: 1 },
		{ pubkey: CAROL_PUB, visible: true, showChannels: false, channels: [], visibleUntil: FAR_FUTURE, bio: `текст с ${badWord} внутри`, updatedAt: 1 },
	]);

	await refreshDiscoveryProfiles(ALICE_PUB);

	assert.deepEqual(discoveryProfiles.value.map((p) => p.pubkey), [BOB_PUB]);
});

test("refreshDiscoveryProfiles: отсеивает карточки, чьё название/описание канала не проходит словарь", async () => {
	const stopwordsModule = await import("../src/domain/discovery/stopwords.json", { with: { type: "json" } });
	const badWord = stopwordsModule.default[0];
	await db.table("discoveryProfiles").bulkPut([
		{ pubkey: BOB_PUB, visible: true, showChannels: true, channels: [{ id: "c1", name: "Обычный канал", description: "норм" }], visibleUntil: FAR_FUTURE, bio: "", updatedAt: 1 },
		{ pubkey: CAROL_PUB, visible: true, showChannels: true, channels: [{ id: "c2", name: badWord, description: "" }], visibleUntil: FAR_FUTURE, bio: "", updatedAt: 1 },
	]);

	await refreshDiscoveryProfiles(ALICE_PUB);

	assert.deepEqual(discoveryProfiles.value.map((p) => p.pubkey), [BOB_PUB]);
});

// CONTRACTS.md §DISCOVERY-REDESIGN, D6 (обязательная часть) — строки с
// visibleUntil, истёкшим БОЛЕЕ СУТОК назад, физически удаляются из
// discoveryProfiles (кэш чужих карточек иначе растёт бесконечно). Guard
// > 0 — недавно истёкшая (в пределах суток) строка НЕ удаляется этим
// проходом, только перестаёт попадать в сигнал (уже покрыто отдельным тестом
// "отсеивает записи с истёкшим visibleUntil" выше).
test("refreshDiscoveryProfiles: физически удаляет из discoveryProfiles строки, протухшие БОЛЕЕ СУТОК назад (D6)", async () => {
	const longExpired = Math.floor(Date.now() / 1000) - 86400 - 10;
	const recentlyExpired = Math.floor(Date.now() / 1000) - 10;
	await db.table("discoveryProfiles").bulkPut([
		{ pubkey: BOB_PUB, visible: true, showChannels: false, channels: [], visibleUntil: longExpired, updatedAt: 1 },
		{ pubkey: CAROL_PUB, visible: true, showChannels: false, channels: [], visibleUntil: recentlyExpired, updatedAt: 1 },
	]);

	await refreshDiscoveryProfiles(ALICE_PUB);

	assert.equal(await db.table("discoveryProfiles").get(BOB_PUB), undefined, "протухшая больше суток назад строка должна быть физически удалена");
	assert.notEqual(await db.table("discoveryProfiles").get(CAROL_PUB), undefined, "недавно истёкшая строка остаётся в кэше — просто не показывается");
});

// CONTRACTS.md §DISCOVERY-REDESIGN, §2 — rules добавлено в тот же словарный
// фильтр, что name/description канала (isDiscoveryCardClean, D9).
test("refreshDiscoveryProfiles: отсеивает карточки, чьи ПРАВИЛА канала не проходят словарь", async () => {
	const stopwordsModule = await import("../src/domain/discovery/stopwords.json", { with: { type: "json" } });
	const badWord = stopwordsModule.default[0];
	await db.table("discoveryProfiles").bulkPut([
		{ pubkey: BOB_PUB, visible: true, showChannels: true, showRules: true, channels: [{ id: "c1", name: "Обычный канал", description: "норм", rules: "без рекламы" }], visibleUntil: FAR_FUTURE, bio: "", updatedAt: 1 },
		{ pubkey: CAROL_PUB, visible: true, showChannels: true, showRules: true, channels: [{ id: "c2", name: "Канал", description: "норм", rules: badWord }], visibleUntil: FAR_FUTURE, bio: "", updatedAt: 1 },
	]);

	await refreshDiscoveryProfiles(ALICE_PUB);

	assert.deepEqual(discoveryProfiles.value.map((p) => p.pubkey), [BOB_PUB]);
});
