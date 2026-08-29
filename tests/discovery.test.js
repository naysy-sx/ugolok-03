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
});

after(() => {
	db.close();
});

test("DISCOVERY_KIND: 30073", () => {
	assert.equal(DISCOVERY_KIND, 30073);
});

test("buildDiscoveryEvent: kind 30073, d-tag='discovery', content — ОТКРЫТЫЙ JSON (не шифруется)", () => {
	const event = buildDiscoveryEvent(ALICE_PRIV, { visible: true, showChannels: true, channels: [{ id: "c1", name: "Кулинария", description: "рецепты" }] });
	assert.equal(event.kind, DISCOVERY_KIND);
	assert.deepEqual(event.tags.find((t) => t[0] === "d"), ["d", "discovery"]);
	assert.ok(verify(event), "событие должно быть валидно подписано");
	const parsed = JSON.parse(event.content);
	assert.equal(parsed.visible, true);
	assert.equal(parsed.showChannels, true);
	assert.deepEqual(parsed.channels, [{ id: "c1", name: "Кулинария", description: "рецепты" }]);
});

test("parseDiscoveryEvent: обычный round-trip", () => {
	const event = buildDiscoveryEvent(ALICE_PRIV, { visible: true, showChannels: false, channels: [] });
	const parsed = parseDiscoveryEvent(event);
	assert.deepEqual(parsed, { visible: true, showChannels: false, channels: [] });
});

test("parseDiscoveryEvent: защита от мусора чужого клиента — не бросает, коэрсит к безопасным значениям", () => {
	const malicious = { content: JSON.stringify({ visible: "yes", showChannels: 1, channels: "не массив" }) };
	const parsed = parseDiscoveryEvent(malicious);
	assert.equal(parsed.visible, true);
	assert.equal(parsed.showChannels, true);
	assert.deepEqual(parsed.channels, []);
});

test("parseDiscoveryEvent: невалидный JSON -> throw (вызывающий код обязан try/catch, тот же принцип, что parseProfileEvent)", () => {
	assert.throws(() => parseDiscoveryEvent({ content: "{не json" }));
});

test("parseDiscoveryEvent: элементы channels фильтруются — только валидные {id,name,description}, мусорные записи отбрасываются", () => {
	const malicious = { content: JSON.stringify({ visible: true, showChannels: true, channels: [{ id: "c1", name: "ok", description: "d" }, "мусор", { id: 123 }, null] }) };
	const parsed = parseDiscoveryEvent(malicious);
	assert.deepEqual(parsed.channels, [{ id: "c1", name: "ok", description: "d" }]);
});

test("loadDiscoverySettings: без локальной записи -> дефолт (invisible, каналы не показаны)", async () => {
	const settings = await loadDiscoverySettings(ALICE_PUB);
	assert.deepEqual(settings, { visible: false, showChannels: false, channelIds: [] });
});

test("publishDiscoverySettings: сохраняет локально СРАЗУ и публикует showChannels=false -> channels: []", async () => {
	const published = [];
	await publishDiscoverySettings(ALICE_PUB, ALICE_PRIV, DB_KEY, { visible: true, showChannels: false, channelIds: [] }, capturingPublish(published));

	const local = await loadDiscoverySettings(ALICE_PUB);
	assert.deepEqual(local, { visible: true, showChannels: false, channelIds: [] });

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
	await publishDiscoverySettings(ALICE_PUB, ALICE_PRIV, DB_KEY, { visible: true, showChannels: true, channelIds: [idA] }, capturingPublish(published));

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
		() => publishDiscoverySettings(ALICE_PUB, ALICE_PRIV, DB_KEY, { visible: true, showChannels: false, channelIds: [] }, failingPublish),
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
		() => publishDiscoverySettings(ALICE_PUB, ALICE_PRIV, DB_KEY, { visible: true, showChannels: false, channelIds: [] }, rejectingPublish),
	);
	const pending = await listPending(DB_KEY);
	assert.equal(pending.length, 1);
});
