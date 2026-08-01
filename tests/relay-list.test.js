import { test } from "node:test";
import assert from "node:assert/strict";
import { verify } from "../src/core/crypto/sign.js";
import { buildRelayListEvent, parseRelayListEvent } from "../src/domain/identity/relay-list.js";

const PRIV_KEY = new Uint8Array(32).fill(13);

// Этап 59 — relayEntries теперь {url,read,write}[] (форма этапа 58), с
// NIP-65 read/write маркерами вместо голого 'r'-тега на каждый URL.

test("buildRelayListEvent: read&&write -> тег без маркера (NIP-65: отсутствие маркера = оба)", () => {
	const event = buildRelayListEvent(PRIV_KEY, [{ url: "wss://relay-a.example", read: true, write: true }]);
	assert.equal(event.kind, 10002);
	assert.equal(verify(event), true);
	assert.deepEqual(
		event.tags.filter((t) => t[0] === "r"),
		[["r", "wss://relay-a.example"]],
	);
});

test("buildRelayListEvent: read-only -> маркер 'read'; write-only -> маркер 'write'", () => {
	const event = buildRelayListEvent(PRIV_KEY, [
		{ url: "wss://reader", read: true, write: false },
		{ url: "wss://writer", read: false, write: true },
	]);
	assert.deepEqual(
		event.tags.filter((t) => t[0] === "r"),
		[
			["r", "wss://reader", "read"],
			["r", "wss://writer", "write"],
		],
	);
});

test("buildRelayListEvent: запись с read:false И write:false пропускается целиком", () => {
	const event = buildRelayListEvent(PRIV_KEY, [
		{ url: "wss://disabled", read: false, write: false },
		{ url: "wss://active", read: true, write: true },
	]);
	assert.deepEqual(
		event.tags.filter((t) => t[0] === "r"),
		[["r", "wss://active"]],
	);
});

test("parseRelayListEvent: round-trip своего же события (both/read/write)", () => {
	const entries = [
		{ url: "wss://a", read: true, write: true },
		{ url: "wss://b", read: true, write: false },
		{ url: "wss://c", read: false, write: true },
	];
	const event = buildRelayListEvent(PRIV_KEY, entries);
	assert.deepEqual(parseRelayListEvent(event), entries);
});

test("buildRelayListEvent: пустой список — валидное событие без 'r' тегов, не бросает", () => {
	const event = buildRelayListEvent(PRIV_KEY, []);
	assert.equal(verify(event), true);
	assert.deepEqual(parseRelayListEvent(event), []);
});

test("parseRelayListEvent: отсутствующий 3-й элемент тега -> {read:true,write:true} (NIP-65: маркер опущен = оба)", () => {
	const foreignEvent = { tags: [["e", "someid"], ["r", "wss://x"], ["p", "somepubkey"]] };
	assert.deepEqual(parseRelayListEvent(foreignEvent), [{ url: "wss://x", read: true, write: true }]);
});

test("parseRelayListEvent: игнорирует посторонние теги, берёт только 'r'", () => {
	const foreignEvent = {
		tags: [
			["r", "wss://x", "read"],
			["e", "someid"],
			["r", "wss://y", "write"],
		],
	};
	assert.deepEqual(parseRelayListEvent(foreignEvent), [
		{ url: "wss://x", read: true, write: false },
		{ url: "wss://y", read: false, write: true },
	]);
});
