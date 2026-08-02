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
	hasLocalUiSettings,
	addRelayUrl,
	removeRelayUrl,
	setRelayRole,
	addBlossomUrl,
	removeBlossomUrl,
	setActiveBlossomUrl,
	pairSelfHostedServer,
	unpairSelfHostedServer,
	SelfHostedFingerprintMismatchError,
} from "../src/domain/settings/ui-settings.js";
import { parseRelayListEvent } from "../src/domain/identity/relay-list.js";
import { parseDmRelayListEvent } from "../src/domain/identity/dm-relay-list.js";

const ALICE_PRIV = new Uint8Array(32).fill(1);
const ALICE_PUB = bytesToHex(getPublicKey(ALICE_PRIV));
const DB_KEY = crypto.getRandomValues(new Uint8Array(32));

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
		notifications: { enabled: false, contacts: { newRequests: "off", accepted: "sound" } },
	};
	const event = buildUiSettingsEvent(ALICE_PRIV, oldShape);
	const parsed = parseUiSettingsEvent(event, ALICE_PRIV);
	assert.equal(parsed.notifications.enabled, false, "явно заданное поле сохраняется");
	assert.equal(parsed.notifications.contacts.newRequests, "off");
	assert.deepEqual(parsed.notifications.channels, DEFAULT_SETTINGS.notifications.channels, "отсутствовавшая ветка — из дефолта");
	assert.equal(parsed.uiScale, "medium", "отсутствовавшее верхнеуровневое поле — из дефолта");
});

test("parseUiSettingsEvent: messages.overrides из старого payload (без channels/moderation вовсе) не теряется, остальные ветки — из дефолта", () => {
	const oldShape = {
		notifications: { messages: { default: "popup", overrides: { alice: "off" } } },
	};
	const event = buildUiSettingsEvent(ALICE_PRIV, oldShape);
	const parsed = parseUiSettingsEvent(event, ALICE_PRIV);
	assert.equal(parsed.notifications.messages.default, "popup");
	assert.deepEqual(parsed.notifications.messages.overrides, { alice: "off" });
	assert.deepEqual(parsed.notifications.channels, DEFAULT_SETTINGS.notifications.channels);
	assert.deepEqual(parsed.notifications.moderation, DEFAULT_SETTINGS.notifications.moderation);
});

test("loadUiSettings: без локальной записи -> дефолт", async () => {
	const settings = await loadUiSettings(ALICE_PUB, DB_KEY);
	assert.equal(settings.accentColorId, "blue");
	assert.equal(settings.uiScale, "medium");
	assert.deepEqual(settings.notifications, DEFAULT_SETTINGS.notifications);
});

// Этап 61 — hasLocalUiSettings: loadUiSettings сама неотличима снаружи (фолбэк
// смёрджен с дефолтом так же, как настоящая запись) — нужна прямая проверка.
test("hasLocalUiSettings: false, пока не было ни одного saveUiSettings", async () => {
	assert.equal(await hasLocalUiSettings(ALICE_PUB), false);
});

test("hasLocalUiSettings: true сразу после первого saveUiSettings", async () => {
	await saveUiSettings(ALICE_PUB, ALICE_PRIV, DB_KEY, DEFAULT_SETTINGS, failingPublish());
	assert.equal(await hasLocalUiSettings(ALICE_PUB), true);
});

test("hasLocalUiSettings: не путает разных владельцев", async () => {
	const BOB_PRIV = new Uint8Array(32).fill(2);
	const BOB_PUB = bytesToHex(getPublicKey(BOB_PRIV));
	await saveUiSettings(ALICE_PUB, ALICE_PRIV, DB_KEY, DEFAULT_SETTINGS, failingPublish());
	assert.equal(await hasLocalUiSettings(BOB_PUB), false);
});

test("saveUiSettings: сохраняет локально СРАЗУ, даже если publish бросает ошибку (best-effort)", async () => {
	const settings = { ...DEFAULT_SETTINGS, accentColorId: "violet" };
	await saveUiSettings(ALICE_PUB, ALICE_PRIV, DB_KEY, settings, failingPublish());
	const loaded = await loadUiSettings(ALICE_PUB, DB_KEY);
	assert.equal(loaded.accentColorId, "violet", "локальное сохранение не зависит от результата публикации");
});

test("addRelayUrl/setRelayRole/removeRelayUrl: полный цикл (этап 58 — {url,read,write}, не одно активное)", async () => {
	const published = [];
	await addRelayUrl(ALICE_PUB, ALICE_PRIV, DB_KEY, "wss://relay-a.example", capturingPublish(published));
	await addRelayUrl(ALICE_PUB, ALICE_PRIV, DB_KEY, "wss://relay-b.example", capturingPublish(published));
	let settings = await loadUiSettings(ALICE_PUB, DB_KEY);
	assert.deepEqual(settings.relayUrls, [
		{ url: "wss://relay-a.example", read: true, write: true },
		{ url: "wss://relay-b.example", read: true, write: true },
	]);

	await setRelayRole(ALICE_PUB, ALICE_PRIV, DB_KEY, "wss://relay-b.example", { read: true, write: false }, capturingPublish(published));
	settings = await loadUiSettings(ALICE_PUB, DB_KEY);
	assert.deepEqual(
		settings.relayUrls.find((r) => r.url === "wss://relay-b.example"),
		{ url: "wss://relay-b.example", read: true, write: false },
	);
	// relay-a остаётся read+write — иначе следующий шаг (снятие read+write с b) не нарушил бы
	// инвариант "хотя бы один write" сам по себе, но проверяем именно точечную правку одной записи
	assert.deepEqual(
		settings.relayUrls.find((r) => r.url === "wss://relay-a.example"),
		{ url: "wss://relay-a.example", read: true, write: true },
	);

	await removeRelayUrl(ALICE_PUB, ALICE_PRIV, DB_KEY, "wss://relay-a.example", capturingPublish(published));
	settings = await loadUiSettings(ALICE_PUB, DB_KEY);
	assert.deepEqual(settings.relayUrls, [{ url: "wss://relay-b.example", read: true, write: false }]);

	await assert.rejects(
		() => removeRelayUrl(ALICE_PUB, ALICE_PRIV, DB_KEY, "wss://relay-b.example", capturingPublish(published)),
		/последн/i,
		"нельзя удалить последний relay — список не должен опустеть",
	);
});

test("addRelayUrl: повторное добавление того же URL идемпотентно (не дублирует)", async () => {
	const published = [];
	await addRelayUrl(ALICE_PUB, ALICE_PRIV, DB_KEY, "wss://relay-a.example", capturingPublish(published));
	await addRelayUrl(ALICE_PUB, ALICE_PRIV, DB_KEY, "wss://relay-a.example", capturingPublish(published));
	const settings = await loadUiSettings(ALICE_PUB, DB_KEY);
	assert.deepEqual(settings.relayUrls, [{ url: "wss://relay-a.example", read: true, write: true }]);
});

test("setRelayRole: URL, которого нет в списке -> throw", async () => {
	await assert.rejects(
		() => setRelayRole(ALICE_PUB, ALICE_PRIV, DB_KEY, "wss://unknown.example", { read: true, write: true }, capturingPublish([])),
		/отсутствует/,
	);
});

test("setRelayRole: нельзя оставить список без единого read:true", async () => {
	const published = [];
	await addRelayUrl(ALICE_PUB, ALICE_PRIV, DB_KEY, "wss://only.example", capturingPublish(published));
	await assert.rejects(
		() => setRelayRole(ALICE_PUB, ALICE_PRIV, DB_KEY, "wss://only.example", { read: false, write: true }, capturingPublish(published)),
		/read/,
	);
});

test("setRelayRole: нельзя оставить список без единого write:true", async () => {
	const published = [];
	await addRelayUrl(ALICE_PUB, ALICE_PRIV, DB_KEY, "wss://only.example", capturingPublish(published));
	await assert.rejects(
		() => setRelayRole(ALICE_PUB, ALICE_PRIV, DB_KEY, "wss://only.example", { read: true, write: false }, capturingPublish(published)),
		/write/,
	);
});

// Этап 59 — addRelayUrl/removeRelayUrl/setRelayRole дополнительно публикуют
// РЕАЛЬНЫЙ kind:10002 (NIP-65), отражающий список ПОСЛЕ применения мутации.
test("addRelayUrl: публикует kind:10002 с полным текущим списком relay", async () => {
	const published = [];
	await addRelayUrl(ALICE_PUB, ALICE_PRIV, DB_KEY, "wss://relay-a.example", capturingPublish(published));
	const relayListEvents = published.filter((e) => e.kind === 10002);
	assert.equal(relayListEvents.length, 1);
	assert.deepEqual(parseRelayListEvent(relayListEvents[0]), [{ url: "wss://relay-a.example", read: true, write: true }]);

	await addRelayUrl(ALICE_PUB, ALICE_PRIV, DB_KEY, "wss://relay-b.example", capturingPublish(published));
	const secondRelayListEvent = published.filter((e) => e.kind === 10002).at(-1);
	assert.deepEqual(parseRelayListEvent(secondRelayListEvent), [
		{ url: "wss://relay-a.example", read: true, write: true },
		{ url: "wss://relay-b.example", read: true, write: true },
	]);
});

test("setRelayRole: опубликованный kind:10002 отражает НОВУЮ роль (read/write маркер)", async () => {
	const published = [];
	await addRelayUrl(ALICE_PUB, ALICE_PRIV, DB_KEY, "wss://relay-a.example", capturingPublish(published));
	await addRelayUrl(ALICE_PUB, ALICE_PRIV, DB_KEY, "wss://relay-b.example", capturingPublish(published));
	await setRelayRole(ALICE_PUB, ALICE_PRIV, DB_KEY, "wss://relay-a.example", { read: true, write: false }, capturingPublish(published));
	const lastRelayListEvent = published.filter((e) => e.kind === 10002).at(-1);
	assert.deepEqual(parseRelayListEvent(lastRelayListEvent), [
		{ url: "wss://relay-a.example", read: true, write: false },
		{ url: "wss://relay-b.example", read: true, write: true },
	]);
});

test("removeRelayUrl: опубликованный kind:10002 не содержит удалённый relay", async () => {
	const published = [];
	await addRelayUrl(ALICE_PUB, ALICE_PRIV, DB_KEY, "wss://relay-a.example", capturingPublish(published));
	await addRelayUrl(ALICE_PUB, ALICE_PRIV, DB_KEY, "wss://relay-b.example", capturingPublish(published));
	await removeRelayUrl(ALICE_PUB, ALICE_PRIV, DB_KEY, "wss://relay-a.example", capturingPublish(published));
	const lastRelayListEvent = published.filter((e) => e.kind === 10002).at(-1);
	assert.deepEqual(parseRelayListEvent(lastRelayListEvent), [{ url: "wss://relay-b.example", read: true, write: true }]);
});

// Этап 60 — рядом с kind:10002 та же мутация публикует kind:10050 (NIP-17),
// но только read-relay (write-only исключаются — "сюда мне присылайте" имеет
// смысл лишь для того, что реально слушается).
test("addRelayUrl/setRelayRole: публикует kind:10050 только с read-relay", async () => {
	const published = [];
	await addRelayUrl(ALICE_PUB, ALICE_PRIV, DB_KEY, "wss://relay-a.example", capturingPublish(published));
	await addRelayUrl(ALICE_PUB, ALICE_PRIV, DB_KEY, "wss://relay-b.example", capturingPublish(published));
	let lastDmRelayEvent = published.filter((e) => e.kind === 10050).at(-1);
	assert.deepEqual(parseDmRelayListEvent(lastDmRelayEvent), ["wss://relay-a.example", "wss://relay-b.example"]);

	await setRelayRole(ALICE_PUB, ALICE_PRIV, DB_KEY, "wss://relay-b.example", { read: false, write: true }, capturingPublish(published));
	lastDmRelayEvent = published.filter((e) => e.kind === 10050).at(-1);
	assert.deepEqual(parseDmRelayListEvent(lastDmRelayEvent), ["wss://relay-a.example"], "write-only relay исключён из kind:10050");
});

test("addRelayUrl: сбой publish (нет сети) не бросает наружу — kind:10002 best-effort, как и kind 30072", async () => {
	await assert.doesNotReject(() => addRelayUrl(ALICE_PUB, ALICE_PRIV, DB_KEY, "wss://relay-a.example", failingPublish()));
	const settings = await loadUiSettings(ALICE_PUB, DB_KEY);
	assert.deepEqual(settings.relayUrls, [{ url: "wss://relay-a.example", read: true, write: true }], "локальное сохранение не зависит от результата публикации");
});

test("addBlossomUrl/setActiveBlossomUrl/removeBlossomUrl: тот же цикл, что relay", async () => {
	const published = [];
	await addBlossomUrl(ALICE_PUB, ALICE_PRIV, DB_KEY, "https://blossom-a.example", capturingPublish(published));
	await setActiveBlossomUrl(ALICE_PUB, ALICE_PRIV, DB_KEY, "https://blossom-a.example", capturingPublish(published));
	await assert.rejects(() => removeBlossomUrl(ALICE_PUB, ALICE_PRIV, DB_KEY, "https://blossom-a.example", capturingPublish(published)), /активный/);
	const settings = await loadUiSettings(ALICE_PUB, DB_KEY);
	assert.equal(settings.activeBlossomUrl, "https://blossom-a.example");
});

test("rebuildUiSettings: сканирует events, берёт ПОСЛЕДНИЙ по created_at, сохраняет локально", async () => {
	const older = buildUiSettingsEvent(ALICE_PRIV, { ...DEFAULT_SETTINGS, accentColorId: "sky" }, 1000);
	const newer = buildUiSettingsEvent(ALICE_PRIV, { ...DEFAULT_SETTINGS, accentColorId: "moss" }, 2000);
	await db.table("events").bulkAdd([
		{ id: older.id, pubkey: ALICE_PUB, kind: KIND_UI_SETTINGS, created_at: older.created_at, tags: older.tags, content: older.content, sig: older.sig },
		{ id: newer.id, pubkey: ALICE_PUB, kind: KIND_UI_SETTINGS, created_at: newer.created_at, tags: newer.tags, content: newer.content, sig: newer.sig },
	]);
	await rebuildUiSettings(ALICE_PUB, ALICE_PRIV, DB_KEY);
	const settings = await loadUiSettings(ALICE_PUB, DB_KEY);
	assert.equal(settings.accentColorId, "moss", "последняя по created_at версия выигрывает (LWW)");
});

test("rebuildUiSettings: нет событий -> no-op, не бросает", async () => {
	await rebuildUiSettings(ALICE_PUB, ALICE_PRIV, DB_KEY);
	const settings = await loadUiSettings(ALICE_PUB, DB_KEY);
	assert.equal(settings.accentColorId, "blue", "остаётся дефолт");
});

// AC-16, Tier 4 (этап 45) — сырой дамп таблицы не должен содержать relay/Blossom
// URL в открытом виде; только ownerPubkey остаётся plaintext (индекс).
test("AC-16: сырая запись uiSettings в IndexedDB не содержит relayUrls/blossomUrls в открытом виде", async () => {
	await saveUiSettings(
		ALICE_PUB,
		ALICE_PRIV,
		DB_KEY,
		{ ...DEFAULT_SETTINGS, relayUrls: [{ url: "wss://secret-relay.example", read: true, write: true }] },
		capturingPublish([]),
	);
	const row = await db.table("uiSettings").get(ALICE_PUB);
	assert.equal(row.ownerPubkey, ALICE_PUB);
	assert.equal(row.relayUrls, undefined, "поля настроек не должны лежать top-level в открытом виде");
	const dump = JSON.stringify(row);
	assert.ok(!dump.includes("secret-relay"), "URL не должен встречаться нигде в сырой записи");
	assert.ok(row.nonce && row.ciphertext, "содержимое должно быть зашифровано в nonce/ciphertext");
});

test("неверный dbKey -> loadUiSettings бросает (AES-GCM/ChaCha tag mismatch), не молча возвращает мусор", async () => {
	await saveUiSettings(ALICE_PUB, ALICE_PRIV, DB_KEY, { ...DEFAULT_SETTINGS, accentColorId: "violet" }, capturingPublish([]));
	const wrongKey = crypto.getRandomValues(new Uint8Array(32));
	await assert.rejects(() => loadUiSettings(ALICE_PUB, wrongKey));
});

// Этап 63, И3 — сопряжение с self-hosted сервером, TOFU-проверка отпечатка.
const SAMPLE_PAIRING = { host: "203.0.113.42", port: 8443, token: "deadbeef", fingerprint: "cafe0001" };

test("pairSelfHostedServer: сохраняет пейринг + pairedAt (unix-секунды)", async () => {
	const before = Math.floor(Date.now() / 1000);
	await pairSelfHostedServer(ALICE_PUB, ALICE_PRIV, DB_KEY, SAMPLE_PAIRING, capturingPublish([]));
	const settings = await loadUiSettings(ALICE_PUB, DB_KEY);
	assert.equal(settings.selfHostedServer.host, SAMPLE_PAIRING.host);
	assert.equal(settings.selfHostedServer.port, SAMPLE_PAIRING.port);
	assert.equal(settings.selfHostedServer.token, SAMPLE_PAIRING.token);
	assert.equal(settings.selfHostedServer.fingerprint, SAMPLE_PAIRING.fingerprint);
	assert.ok(settings.selfHostedServer.pairedAt >= before);
});

test("pairSelfHostedServer: НЕТ предыдущего сопряжения -> просто сохраняет, без TOFU-конфликта", async () => {
	await assert.doesNotReject(() => pairSelfHostedServer(ALICE_PUB, ALICE_PRIV, DB_KEY, SAMPLE_PAIRING, capturingPublish([])));
});

test("pairSelfHostedServer: тот же host:port, ТОТ ЖЕ отпечаток -> не конфликт (переподключение/обновление токена)", async () => {
	await pairSelfHostedServer(ALICE_PUB, ALICE_PRIV, DB_KEY, SAMPLE_PAIRING, capturingPublish([]));
	const updated = { ...SAMPLE_PAIRING, token: "newtoken" };
	await assert.doesNotReject(() => pairSelfHostedServer(ALICE_PUB, ALICE_PRIV, DB_KEY, updated, capturingPublish([])));
	const settings = await loadUiSettings(ALICE_PUB, DB_KEY);
	assert.equal(settings.selfHostedServer.token, "newtoken");
});

test("pairSelfHostedServer: тот же host:port, ДРУГОЙ отпечаток -> SelfHostedFingerprintMismatchError, не сохраняет молча", async () => {
	await pairSelfHostedServer(ALICE_PUB, ALICE_PRIV, DB_KEY, SAMPLE_PAIRING, capturingPublish([]));
	const differentFingerprint = { ...SAMPLE_PAIRING, fingerprint: "differentfp" };
	await assert.rejects(
		() => pairSelfHostedServer(ALICE_PUB, ALICE_PRIV, DB_KEY, differentFingerprint, capturingPublish([])),
		SelfHostedFingerprintMismatchError,
	);
	const settings = await loadUiSettings(ALICE_PUB, DB_KEY);
	assert.equal(settings.selfHostedServer.fingerprint, SAMPLE_PAIRING.fingerprint, "старое сопряжение не должно быть перезаписано без force");
});

test("pairSelfHostedServer: другой отпечаток, НО force:true -> перезаписывает (пользователь подтвердил)", async () => {
	await pairSelfHostedServer(ALICE_PUB, ALICE_PRIV, DB_KEY, SAMPLE_PAIRING, capturingPublish([]));
	const differentFingerprint = { ...SAMPLE_PAIRING, fingerprint: "differentfp" };
	await assert.doesNotReject(() =>
		pairSelfHostedServer(ALICE_PUB, ALICE_PRIV, DB_KEY, differentFingerprint, capturingPublish([]), { force: true }),
	);
	const settings = await loadUiSettings(ALICE_PUB, DB_KEY);
	assert.equal(settings.selfHostedServer.fingerprint, "differentfp");
});

test("pairSelfHostedServer: другой host (тот же порт) -> не конфликт, TOFU привязан к host:port вместе", async () => {
	await pairSelfHostedServer(ALICE_PUB, ALICE_PRIV, DB_KEY, SAMPLE_PAIRING, capturingPublish([]));
	const differentHost = { ...SAMPLE_PAIRING, host: "203.0.113.99", fingerprint: "totallydifferent" };
	await assert.doesNotReject(() => pairSelfHostedServer(ALICE_PUB, ALICE_PRIV, DB_KEY, differentHost, capturingPublish([])));
});

test("unpairSelfHostedServer: сбрасывает в null", async () => {
	await pairSelfHostedServer(ALICE_PUB, ALICE_PRIV, DB_KEY, SAMPLE_PAIRING, capturingPublish([]));
	await unpairSelfHostedServer(ALICE_PUB, ALICE_PRIV, DB_KEY, capturingPublish([]));
	const settings = await loadUiSettings(ALICE_PUB, DB_KEY);
	assert.equal(settings.selfHostedServer, null);
});

test("DEFAULT_SETTINGS.selfHostedServer — null по умолчанию (старые записи без этого поля не ломаются)", async () => {
	const settings = await loadUiSettings(ALICE_PUB, DB_KEY);
	assert.equal(settings.selfHostedServer, null);
});
