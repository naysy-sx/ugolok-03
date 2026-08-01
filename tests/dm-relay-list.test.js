import { test } from "node:test";
import assert from "node:assert/strict";
import { verify } from "../src/core/crypto/sign.js";
import { buildDmRelayListEvent, parseDmRelayListEvent } from "../src/domain/identity/dm-relay-list.js";

const PRIV_KEY = new Uint8Array(32).fill(21);

test("buildDmRelayListEvent: kind 10050, валидная подпись, тег 'relay' (не 'r')", () => {
	const urls = ["wss://relay-a.example", "wss://relay-b.example"];
	const event = buildDmRelayListEvent(PRIV_KEY, urls);
	assert.equal(event.kind, 10050);
	assert.equal(verify(event), true);
	assert.deepEqual(
		event.tags.filter((t) => t[0] === "relay"),
		[["relay", "wss://relay-a.example"], ["relay", "wss://relay-b.example"]],
	);
});

test("parseDmRelayListEvent: round-trip своего же события", () => {
	const urls = ["wss://a", "wss://b"];
	const event = buildDmRelayListEvent(PRIV_KEY, urls);
	assert.deepEqual(parseDmRelayListEvent(event), urls);
});

test("buildDmRelayListEvent: пустой список — валидное событие без 'relay' тегов, не бросает", () => {
	const event = buildDmRelayListEvent(PRIV_KEY, []);
	assert.equal(verify(event), true);
	assert.deepEqual(parseDmRelayListEvent(event), []);
});

test("parseDmRelayListEvent: игнорирует посторонние теги (включая 'r' — тег kind:10002, не этого kind)", () => {
	const foreignEvent = { tags: [["e", "someid"], ["r", "wss://wrong-kind"], ["relay", "wss://x"], ["p", "somepubkey"]] };
	assert.deepEqual(parseDmRelayListEvent(foreignEvent), ["wss://x"]);
});
