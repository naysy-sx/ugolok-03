import "fake-indexeddb/auto";
import { test, before, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import { db } from "../src/core/store/database.js";
import { getPublicKey } from "../src/core/crypto/keys.js";
import { bytesToHex } from "@noble/hashes/utils.js";
import { verify } from "../src/core/crypto/sign.js";
import { createChannel } from "../src/domain/content/channel.js";
import {
	DISCOVERY_KIND,
	buildDiscoveryEvent,
	parseDiscoveryEvent,
	loadDiscoverySettings,
	publishDiscoverySettings,
	markDiscoveryExpired,
} from "../src/domain/discovery/discovery.js";
import { listPending } from "../src/core/store/outbox.js";

const ALICE_PRIV = new Uint8Array(32).fill(7);
const ALICE_PUB = bytesToHex(getPublicKey(ALICE_PRIV));
const DB_KEY = crypto.getRandomValues(new Uint8Array(32));

const capturingPublish = (bucket) => async (event) => {
	bucket.push(event);
	return { ok: true };
};

before(async () => {
	await db.open();
});

beforeEach(async () => {
	await db.table("discoverySettings").clear();
	await db.table("channels").clear();
	await db.table("channelKeys").clear();
	await db.table("channelKeyMeta").clear();
	await db.table("outbox").clear();
	await db.table("keystore").clear();
});

after(() => {
	db.close();
});

test("DISCOVERY_KIND: 30073", () => {
	assert.equal(DISCOVERY_KIND, 30073);
});

const FAR_FUTURE = Math.floor(Date.now() / 1000) + 86400;

test("buildDiscoveryEvent: kind 30073, d-tag='discovery', content — ОТКРЫТЫЙ JSON (не шифруется)", () => {
	const event = buildDiscoveryEvent(ALICE_PRIV, { visible: true, showChannels: true, channels: [{ id: "c1", name: "Кулинария", description: "рецепты" }], visibleUntil: FAR_FUTURE, bio: "привет" });
	assert.equal(event.kind, DISCOVERY_KIND);
	assert.deepEqual(event.tags.find((t) => t[0] === "d"), ["d", "discovery"]);
	assert.ok(verify(event), "событие должно быть валидно подписано");
	const parsed = JSON.parse(event.content);
	assert.equal(parsed.visible, true);
	assert.equal(parsed.showChannels, true);
	assert.deepEqual(parsed.channels, [{ id: "c1", name: "Кулинария", description: "рецепты" }]);
});

// CONTRACTS.md §DISCOVERY, T4 — обязателен при visible:true.
test("buildDiscoveryEvent: visible:true без валидного visibleUntil -> throw", () => {
	assert.throws(() => buildDiscoveryEvent(ALICE_PRIV, { visible: true, showChannels: false, channels: [] }));
	assert.throws(() => buildDiscoveryEvent(ALICE_PRIV, { visible: true, showChannels: false, channels: [], visibleUntil: 0 }));
	assert.throws(() => buildDiscoveryEvent(ALICE_PRIV, { visible: true, showChannels: false, channels: [], visibleUntil: -5 }));
});

test("buildDiscoveryEvent: visible:false не требует visibleUntil", () => {
	assert.doesNotThrow(() => buildDiscoveryEvent(ALICE_PRIV, { visible: false, showChannels: false, channels: [] }));
});

// NIP-40 (шаблон тега — blossom-client.js:13) — рядом с d-тегом, только когда visible.
test("buildDiscoveryEvent: тег expiration равен visibleUntil, есть только при visible:true", () => {
	const visibleEvent = buildDiscoveryEvent(ALICE_PRIV, { visible: true, showChannels: false, channels: [], visibleUntil: FAR_FUTURE });
	assert.deepEqual(visibleEvent.tags.find((t) => t[0] === "expiration"), ["expiration", String(FAR_FUTURE)]);

	const hiddenEvent = buildDiscoveryEvent(ALICE_PRIV, { visible: false, showChannels: false, channels: [] });
	assert.equal(hiddenEvent.tags.find((t) => t[0] === "expiration"), undefined);
});

test("buildDiscoveryEvent: bio обрезается до лимита при сборке", () => {
	const longBio = "а".repeat(400);
	const event = buildDiscoveryEvent(ALICE_PRIV, { visible: false, showChannels: false, channels: [], bio: longBio });
	const parsed = JSON.parse(event.content);
	assert.equal(parsed.bio.length, 300);
});

test("parseDiscoveryEvent: обычный round-trip", () => {
	const event = buildDiscoveryEvent(ALICE_PRIV, { visible: true, showChannels: false, channels: [], visibleUntil: FAR_FUTURE, bio: "обо мне" });
	const parsed = parseDiscoveryEvent(event);
	assert.deepEqual(parsed, { visible: true, showChannels: false, channels: [], visibleUntil: FAR_FUTURE, bio: "обо мне" });
});

test("parseDiscoveryEvent: защита от мусора чужого клиента — не бросает, коэрсит к безопасным значениям", () => {
	const malicious = { content: JSON.stringify({ visible: "yes", showChannels: 1, channels: "не массив", visibleUntil: FAR_FUTURE }) };
	const parsed = parseDiscoveryEvent(malicious);
	assert.equal(parsed.visible, true);
	assert.equal(parsed.showChannels, true);
	assert.deepEqual(parsed.channels, []);
});

test("parseDiscoveryEvent: невалидный JSON -> throw (вызывающий код обязан try/catch, тот же принцип, что parseProfileEvent)", () => {
	assert.throws(() => parseDiscoveryEvent({ content: "{не json" }));
});

// CONTRACTS.md §DISCOVERY, T4 — событие невалидно, если заявляет visible:true без срока
// (чужой клиент соврал или устарел) — тот же класс ошибки, что "невалидный JSON".
test("parseDiscoveryEvent: visible:true без валидного visibleUntil -> throw", () => {
	assert.throws(() => parseDiscoveryEvent({ content: JSON.stringify({ visible: true, showChannels: false, channels: [] }) }));
	assert.throws(() => parseDiscoveryEvent({ content: JSON.stringify({ visible: true, showChannels: false, channels: [], visibleUntil: "не число" }) }));
});

test("parseDiscoveryEvent: visible:false с мусорным/отсутствующим visibleUntil -> коэрсится в 0, не бросает", () => {
	const parsed = parseDiscoveryEvent({ content: JSON.stringify({ visible: false, showChannels: false, channels: [] }) });
	assert.equal(parsed.visibleUntil, 0);
});

test("parseDiscoveryEvent: bio длиннее лимита — обрезается, не бросает; отсутствие bio -> ''", () => {
	const longBioEvent = { content: JSON.stringify({ visible: false, showChannels: false, channels: [], bio: "б".repeat(500) }) };
	assert.equal(parseDiscoveryEvent(longBioEvent).bio.length, 300);

	const noBioEvent = { content: JSON.stringify({ visible: false, showChannels: false, channels: [] }) };
	assert.equal(parseDiscoveryEvent(noBioEvent).bio, "");

	const junkBioEvent = { content: JSON.stringify({ visible: false, showChannels: false, channels: [], bio: 12345 }) };
	assert.equal(parseDiscoveryEvent(junkBioEvent).bio, "");
});

test("parseDiscoveryEvent: элементы channels фильтруются — только валидные {id,name,description}, мусорные записи отбрасываются", () => {
	const malicious = { content: JSON.stringify({ visible: true, showChannels: true, channels: [{ id: "c1", name: "ok", description: "d" }, "мусор", { id: 123 }, null], visibleUntil: FAR_FUTURE }) };
	const parsed = parseDiscoveryEvent(malicious);
	assert.deepEqual(parsed.channels, [{ id: "c1", name: "ok", description: "d" }]);
});

test("loadDiscoverySettings: без локальной записи -> дефолт (invisible, каналы не показаны)", async () => {
	const settings = await loadDiscoverySettings(ALICE_PUB);
	assert.deepEqual(settings, { visible: false, showChannels: false, channelIds: [], visibleUntil: 0 });
});

test("publishDiscoverySettings: сохраняет локально СРАЗУ и публикует showChannels=false -> channels: []", async () => {
	const published = [];
	await publishDiscoverySettings(ALICE_PUB, ALICE_PRIV, DB_KEY, { visible: true, showChannels: false, channelIds: [], visibleUntil: FAR_FUTURE }, capturingPublish(published));

	const local = await loadDiscoverySettings(ALICE_PUB);
	assert.deepEqual(local, { visible: true, showChannels: false, channelIds: [], visibleUntil: FAR_FUTURE });

	assert.equal(published.length, 1);
	const parsed = parseDiscoveryEvent(published[0]);
	assert.equal(parsed.visible, true);
	assert.equal(parsed.showChannels, false);
	assert.deepEqual(parsed.channels, [], "showChannels=false -> НИ ОДИН канал не публикуется, даже если channelIds непуст");
});

test("publishDiscoverySettings: showChannels=true — публикует ТОЛЬКО отмеченные владельцем каналы (name+description), не все подряд", async () => {
	const { channelId: idA } = await createChannel(ALICE_PUB, ALICE_PRIV, DB_KEY, { name: "Кулинария", description: "рецепты", rules: "" }, [], capturingPublish([]));
	const { channelId: idB } = await createChannel(ALICE_PUB, ALICE_PRIV, DB_KEY, { name: "Приватный черновик", description: "не для рекламы", rules: "" }, [], capturingPublish([]));

	const published = [];
	await publishDiscoverySettings(ALICE_PUB, ALICE_PRIV, DB_KEY, { visible: true, showChannels: true, channelIds: [idA], visibleUntil: FAR_FUTURE }, capturingPublish(published));

	const parsed = parseDiscoveryEvent(published[0]);
	assert.equal(parsed.channels.length, 1, "только отмеченный канал, не оба");
	assert.equal(parsed.channels[0].id, idA);
	assert.equal(parsed.channels[0].name, "Кулинария");
	assert.equal(parsed.channels[0].description, "рецепты");
	assert.ok(!parsed.channels.some((c) => c.id === idB), "неотмеченный канал не должен утечь в публичный broadcast");
});

test("publishDiscoverySettings: сбой publish (исключение) БРОСАЕТ наверх, но локальная запись всё равно сохранена, событие уходит в outbox", async () => {
	const failingPublish = async () => {
		throw new Error("нет соединения");
	};
	await assert.rejects(
		() => publishDiscoverySettings(ALICE_PUB, ALICE_PRIV, DB_KEY, { visible: true, showChannels: false, channelIds: [], visibleUntil: FAR_FUTURE }, failingPublish),
	);

	const local = await loadDiscoverySettings(ALICE_PUB);
	assert.equal(local.visible, true, "put() случается до publish — локальное сохранение не зависит от сети");

	const pending = await listPending(DB_KEY);
	assert.equal(pending.length, 1, "событие, не долетевшее до реле, обязано остаться в outbox для drainOutboxSafely");
	assert.equal(parseDiscoveryEvent(pending[0].event).visible, true);
});

test("publishDiscoverySettings: реле вернуло {ok:false} (не исключение) — тоже бросает и тоже уходит в outbox", async () => {
	const rejectingPublish = async () => ({ ok: false, reason: "relay отклонил" });
	await assert.rejects(
		() => publishDiscoverySettings(ALICE_PUB, ALICE_PRIV, DB_KEY, { visible: true, showChannels: false, channelIds: [], visibleUntil: FAR_FUTURE }, rejectingPublish),
	);
	const pending = await listPending(DB_KEY);
	assert.equal(pending.length, 1);
});

// CONTRACTS.md §DISCOVERY, T4 — publishDiscoverySettings сам читает bio из
// keystore (тот же приём, что уже применяется к listOwnedChannels), а не
// принимает его параметром из UI.
test("publishDiscoverySettings: bio берётся из keystore (getProfile), не из параметров вызова, и обрезается до лимита", async () => {
	await db.table("keystore").put({ id: ALICE_PUB, bio: "б".repeat(500) });
	const published = [];
	await publishDiscoverySettings(ALICE_PUB, ALICE_PRIV, DB_KEY, { visible: true, showChannels: false, channelIds: [], visibleUntil: FAR_FUTURE }, capturingPublish(published));
	const parsed = parseDiscoveryEvent(published[0]);
	assert.equal(parsed.bio.length, 300);
});

test("publishDiscoverySettings: нет записи в keystore (не должно происходить в реальности, но не обязано ронять публикацию) -> bio ''", async () => {
	const published = [];
	await publishDiscoverySettings(ALICE_PUB, ALICE_PRIV, DB_KEY, { visible: true, showChannels: false, channelIds: [], visibleUntil: FAR_FUTURE }, capturingPublish(published));
	const parsed = parseDiscoveryEvent(published[0]);
	assert.equal(parsed.bio, "");
});

// CONTRACTS.md §DISCOVERY, T5 — автоистечение в UI: локальный флаг гасится
// БЕЗ публикации (expiration+фильтр читателя уже делают своё дело сами).
test("markDiscoveryExpired: гасит visible локально, не трогает остальные поля, не публикует", async () => {
	// Реальный канал — начиная с §DISCOVERY-REDESIGN (D5) publishDiscoverySettings
	// отбрасывает channelIds, которых нет среди listOwnedChannels; "c1" не был бы каналом.
	const { channelId } = await createChannel(ALICE_PUB, ALICE_PRIV, DB_KEY, { name: "Канал", description: "d", rules: "" }, [], capturingPublish([]));
	await publishDiscoverySettings(ALICE_PUB, ALICE_PRIV, DB_KEY, { visible: true, showChannels: true, channelIds: [channelId], visibleUntil: FAR_FUTURE }, capturingPublish([]));

	await markDiscoveryExpired(ALICE_PUB);

	const local = await loadDiscoverySettings(ALICE_PUB);
	assert.deepEqual(local, { visible: false, showChannels: true, channelIds: [channelId], visibleUntil: FAR_FUTURE });
});

// CONTRACTS.md §DISCOVERY-REDESIGN, D1 — "Скрыть сейчас" раньше публиковало
// visible:false С ПОЛНЫМ содержимым (bio, каналы) и БЕЗ expiration — такое
// событие оставалось на реле навсегда, доступное кому угодно по REQ. Читающий
// клиент прятал карточку по фильтру visible, но данные утекали публично.
test("publishDiscoverySettings: visible:false публикует НАДГРОБИЕ (bio='', channels=[], showChannels=false, visibleUntil=0), не текущее содержимое (D1)", async () => {
	await db.table("keystore").put({ id: ALICE_PUB, bio: "личное био" });
	const { channelId } = await createChannel(ALICE_PUB, ALICE_PRIV, DB_KEY, { name: "Канал", description: "описание", rules: "" }, [], capturingPublish([]));

	await publishDiscoverySettings(ALICE_PUB, ALICE_PRIV, DB_KEY, { visible: true, showChannels: true, channelIds: [channelId], visibleUntil: FAR_FUTURE }, capturingPublish([]));

	const published = [];
	await publishDiscoverySettings(ALICE_PUB, ALICE_PRIV, DB_KEY, { visible: false, showChannels: true, channelIds: [channelId], visibleUntil: FAR_FUTURE }, capturingPublish(published));

	const parsed = parseDiscoveryEvent(published[0]);
	assert.equal(parsed.visible, false);
	assert.equal(parsed.bio, "", "надгробие не должно нести старое bio");
	assert.deepEqual(parsed.channels, [], "надгробие не должно нести список каналов");
	assert.equal(parsed.showChannels, false);
	assert.equal(parsed.visibleUntil, 0);
});

test("publishDiscoverySettings: выключение НЕ сбрасывает локальные showChannels/channelIds — это настройки пользователя, не часть надгробия (D1)", async () => {
	const { channelId } = await createChannel(ALICE_PUB, ALICE_PRIV, DB_KEY, { name: "Канал", description: "описание", rules: "" }, [], capturingPublish([]));
	await publishDiscoverySettings(ALICE_PUB, ALICE_PRIV, DB_KEY, { visible: false, showChannels: true, channelIds: [channelId], visibleUntil: FAR_FUTURE }, capturingPublish([]));

	const local = await loadDiscoverySettings(ALICE_PUB);
	assert.equal(local.showChannels, true);
	assert.deepEqual(local.channelIds, [channelId]);
	assert.equal(local.visible, false);
});

// CONTRACTS.md §DISCOVERY-REDESIGN, D2 — раньше buildDiscoveryEvent проверял
// только visibleUntil > 0, событие с истёкшим сроком относительно СВОЕГО ЖЕ
// created_at уходило на реле, где отвергалось/мгновенно истекало молча.
test("buildDiscoveryEvent: visible:true и visibleUntil <= createdAt -> throw, не только <= 0 (D2)", () => {
	const createdAt = Math.floor(Date.now() / 1000);
	assert.throws(() => buildDiscoveryEvent(ALICE_PRIV, { visible: true, showChannels: false, channels: [], visibleUntil: createdAt }, createdAt));
	assert.throws(() => buildDiscoveryEvent(ALICE_PRIV, { visible: true, showChannels: false, channels: [], visibleUntil: createdAt - 10 }, createdAt));
	assert.doesNotThrow(() => buildDiscoveryEvent(ALICE_PRIV, { visible: true, showChannels: false, channels: [], visibleUntil: createdAt + 10 }, createdAt));
});

// CONTRACTS.md §DISCOVERY-REDESIGN, D5 — снимок канала протухает: если канал
// удалён, его id продолжал мусорить в локальном channelIds (событие уже
// фильтровало через listOwnedChannels, локальная копия — нет).
test("publishDiscoverySettings: отбрасывает channelIds несуществующих каналов — и локально, и в событии (D5)", async () => {
	const { channelId: realId } = await createChannel(ALICE_PUB, ALICE_PRIV, DB_KEY, { name: "Настоящий", description: "d", rules: "" }, [], capturingPublish([]));
	const GHOST_ID = "уже-удалённый-канал";

	const published = [];
	await publishDiscoverySettings(ALICE_PUB, ALICE_PRIV, DB_KEY, { visible: true, showChannels: true, channelIds: [realId, GHOST_ID], visibleUntil: FAR_FUTURE }, capturingPublish(published));

	const local = await loadDiscoverySettings(ALICE_PUB);
	assert.deepEqual(local.channelIds, [realId], "несуществующий id не должен остаться в локальном наборе");

	const parsed = parseDiscoveryEvent(published[0]);
	assert.deepEqual(parsed.channels.map((c) => c.id), [realId]);
});

// Найдено адверсарной живой проверкой (T5, skill run-ugolok): быстрое
// "включить" -> "Скрыть сейчас" в пределах ОДНОЙ секунды wall-clock давало
// ДВА kind:30073 с ОДИНАКОВЫМ created_at (Math.floor(Date.now()/1000)) —
// strfry как параметризованно-заменяемое событие (NIP-01, kind 30000-39999)
// отклоняет второе с "replaced: have newer event" (не строго больше), UI
// показывал ошибку хотя пользователь просто выключил тумблер. created_at
// обязан быть строго монотонным ПОВЕРХ wall-clock секунд для этого потока.
test("publishDiscoverySettings: два вызова подряд (в пределах одной секунды) -> строго возрастающий created_at", async () => {
	const published = [];
	await publishDiscoverySettings(ALICE_PUB, ALICE_PRIV, DB_KEY, { visible: true, showChannels: false, channelIds: [], visibleUntil: FAR_FUTURE }, capturingPublish(published));
	await publishDiscoverySettings(ALICE_PUB, ALICE_PRIV, DB_KEY, { visible: false, showChannels: false, channelIds: [], visibleUntil: FAR_FUTURE }, capturingPublish(published));

	assert.equal(published.length, 2);
	assert.ok(published[1].created_at > published[0].created_at, "второе событие обязано иметь строго больший created_at, даже если публикации попали в одну и ту же секунду");
});
