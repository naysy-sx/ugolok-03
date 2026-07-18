import { test } from "node:test";
import assert from "node:assert/strict";
import { verify } from "../src/core/crypto/sign.js";
import { buildRelayListEvent, parseRelayListEvent } from "../src/domain/identity/relay-list.js";

const PRIV_KEY = new Uint8Array(32).fill(13);

test("buildRelayListEvent: kind 10002, валидная подпись, один тег 'r' на URL", () => {
	const urls = ["wss://relay-a.example", "wss://relay-b.example"];
	const event = buildRelayListEvent(PRIV_KEY, urls);
	assert.equal(event.kind, 10002);
	assert.equal(verify(event), true);
	assert.deepEqual(
		event.tags.filter((t) => t[0] === "r"),
		[["r", "wss://relay-a.example"], ["r", "wss://relay-b.example"]],
	);
});

test("parseRelayListEvent: round-trip своего же события", () => {
	const urls = ["wss://a", "wss://b", "wss://c"];
	const event = buildRelayListEvent(PRIV_KEY, urls);
	assert.deepEqual(parseRelayListEvent(event), urls);
});

test("buildRelayListEvent: пустой список URL — валидное событие без 'r' тегов, не бросает", () => {
	const event = buildRelayListEvent(PRIV_KEY, []);
	assert.equal(verify(event), true);
	assert.deepEqual(parseRelayListEvent(event), []);
});

test("parseRelayListEvent: игнорирует посторонние теги, берёт только 'r'", () => {
	const foreignEvent = { tags: [["e", "someid"], ["r", "wss://x"], ["p", "somepubkey"]] };
	assert.deepEqual(parseRelayListEvent(foreignEvent), ["wss://x"]);
});
