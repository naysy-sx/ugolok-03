import "fake-indexeddb/auto";
import { test, before, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import { db } from "../src/core/store/database.js";
import { getPublicKey } from "../src/core/crypto/keys.js";
import { bytesToHex } from "@noble/hashes/utils.js";
import {
	KIND_UI_SETTINGS,
	DEFAULT_SETTINGS,
	buildUiSettingsEvent,
	parseUiSettingsEvent,
	loadUiSettings,
	saveUiSettings,
	rebuildUiSettings,
	addRelayUrl,
	removeRelayUrl,
	setActiveRelayUrl,
	addBlossomUrl,
	removeBlossomUrl,
	setActiveBlossomUrl,
} from "../src/domain/settings/ui-settings.js";

const ALICE_PRIV = new Uint8Array(32).fill(1);
const ALICE_PUB = bytesToHex(getPublicKey(ALICE_PRIV));

before(async () => {
	await db.open();
});

beforeEach(async () => {
	await db.table("uiSettings").clear();
	await db.table("events").clear();
});

after(() => {
	db.close();
});

function capturingPublish(bucket) {
	return async (event) => {
		bucket.push(event);
		return { ok: true };
	};
}

function failingPublish() {
	return async () => {
		throw new Error("нет соединения");
	};
}

test("buildUiSettingsEvent/parseUiSettingsEvent: round-trip, kind 30072, d-tag='settings' буквально", () => {
	const settings = { ...DEFAULT_SETTINGS, accentColorId: "teal", uiScale: "large" };
	const event = buildUiSettingsEvent(ALICE_PRIV, settings);
	assert.equal(event.kind, KIND_UI_SETTINGS);
	assert.deepEqual(event.tags.find((t) => t[0] === "d"), ["d", "settings"]);
	const parsed = parseUiSettingsEvent(event, ALICE_PRIV);
	assert.equal(parsed.accentColorId, "teal");
	assert.equal(parsed.uiScale, "large");
});

test("parseUiSettingsEvent: неполный старый payload (без notifications.channels) сливается с дефолтом, не теряя остальное дерево", () => {
	const oldShape = {
		accentColorId: "blue",
		notifications: { enabled: false, contacts: { enabled: true, newRequests: false, accepted: true } },
	};
	const event = buildUiSettingsEvent(ALICE_PRIV, oldShape);
	const parsed = parseUiSettingsEvent(event, ALICE_PRIV);
	assert.equal(parsed.notifications.enabled, false, "явно заданное поле сохраняется");
	assert.equal(parsed.notifications.contacts.newRequests, false);
	assert.deepEqual(parsed.notifications.channels, DEFAULT_SETTINGS.notifications.channels, "отсутствовавшая ветка — из дефолта");
	assert.equal(parsed.uiScale, "medium", "отсутствовавшее верхнеуровневое поле — из дефолта");
});

test("loadUiSettings: без локальной записи -> дефолт", async () => {
	const settings = await loadUiSettings(ALICE_PUB);
	assert.equal(settings.accentColorId, "blue");
	assert.equal(settings.uiScale, "medium");
	assert.deepEqual(settings.notifications, DEFAULT_SETTINGS.notifications);
});

test("saveUiSettings: сохраняет локально СРАЗУ, даже если publish бросает ошибку (best-effort)", async () => {
	const settings = { ...DEFAULT_SETTINGS, accentColorId: "violet" };
	await saveUiSettings(ALICE_PUB, ALICE_PRIV, settings, failingPublish());
	const loaded = await loadUiSettings(ALICE_PUB);
	assert.equal(loaded.accentColorId, "violet", "локальное сохранение не зависит от результата публикации");
});

test("addRelayUrl/setActiveRelayUrl/removeRelayUrl: полный цикл", async () => {
	const published = [];
	await addRelayUrl(ALICE_PUB, ALICE_PRIV, "wss://relay-a.example", capturingPublish(published));
	await addRelayUrl(ALICE_PUB, ALICE_PRIV, "wss://relay-b.example", capturingPublish(published));
	let settings = await loadUiSettings(ALICE_PUB);
	assert.deepEqual(settings.relayUrls, ["wss://relay-a.example", "wss://relay-b.example"]);

	await setActiveRelayUrl(ALICE_PUB, ALICE_PRIV, "wss://relay-b.example", capturingPublish(published));
	settings = await loadUiSettings(ALICE_PUB);
	assert.equal(settings.activeRelayUrl, "wss://relay-b.example");

	await assert.rejects(
		() => removeRelayUrl(ALICE_PUB, ALICE_PRIV, "wss://relay-b.example", capturingPublish(published)),
		/активный/,
		"нельзя удалить активный relay",
	);

	await removeRelayUrl(ALICE_PUB, ALICE_PRIV, "wss://relay-a.example", capturingPublish(published));
	settings = await loadUiSettings(ALICE_PUB);
	assert.deepEqual(settings.relayUrls, ["wss://relay-b.example"]);
});

test("addRelayUrl: повторное добавление того же URL идемпотентно (не дублирует)", async () => {
	const published = [];
	await addRelayUrl(ALICE_PUB, ALICE_PRIV, "wss://relay-a.example", capturingPublish(published));
	await addRelayUrl(ALICE_PUB, ALICE_PRIV, "wss://relay-a.example", capturingPublish(published));
	const settings = await loadUiSettings(ALICE_PUB);
	assert.deepEqual(settings.relayUrls, ["wss://relay-a.example"]);
});

test("setActiveRelayUrl: URL, которого нет в списке -> throw", async () => {
	await assert.rejects(() => setActiveRelayUrl(ALICE_PUB, ALICE_PRIV, "wss://unknown.example", capturingPublish([])), /отсутствует/);
});

test("addBlossomUrl/setActiveBlossomUrl/removeBlossomUrl: тот же цикл, что relay", async () => {
	const published = [];
	await addBlossomUrl(ALICE_PUB, ALICE_PRIV, "https://blossom-a.example", capturingPublish(published));
	await setActiveBlossomUrl(ALICE_PUB, ALICE_PRIV, "https://blossom-a.example", capturingPublish(published));
	await assert.rejects(() => removeBlossomUrl(ALICE_PUB, ALICE_PRIV, "https://blossom-a.example", capturingPublish(published)), /активный/);
	const settings = await loadUiSettings(ALICE_PUB);
	assert.equal(settings.activeBlossomUrl, "https://blossom-a.example");
});

test("rebuildUiSettings: сканирует events, берёт ПОСЛЕДНИЙ по created_at, сохраняет локально", async () => {
	const older = buildUiSettingsEvent(ALICE_PRIV, { ...DEFAULT_SETTINGS, accentColorId: "sky" }, 1000);
	const newer = buildUiSettingsEvent(ALICE_PRIV, { ...DEFAULT_SETTINGS, accentColorId: "moss" }, 2000);
	await db.table("events").bulkAdd([
		{ id: older.id, pubkey: ALICE_PUB, kind: KIND_UI_SETTINGS, created_at: older.created_at, tags: older.tags, content: older.content, sig: older.sig },
		{ id: newer.id, pubkey: ALICE_PUB, kind: KIND_UI_SETTINGS, created_at: newer.created_at, tags: newer.tags, content: newer.content, sig: newer.sig },
	]);
	await rebuildUiSettings(ALICE_PUB, ALICE_PRIV);
	const settings = await loadUiSettings(ALICE_PUB);
	assert.equal(settings.accentColorId, "moss", "последняя по created_at версия выигрывает (LWW)");
});

test("rebuildUiSettings: нет событий -> no-op, не бросает", async () => {
	await rebuildUiSettings(ALICE_PUB, ALICE_PRIV);
	const settings = await loadUiSettings(ALICE_PUB);
	assert.equal(settings.accentColorId, "blue", "остаётся дефолт");
});
