import { test } from "node:test";
import assert from "node:assert/strict";
import { verify } from "../src/core/crypto/sign.js";
import {
	buildContactListEvent,
	parseContactListEvent,
	addContact,
	removeContact,
	buildMuteListEvent,
	parseMuteListEvent,
	isBlocked,
} from "../src/domain/contacts/contacts.js";

const PRIV_KEY = new Uint8Array(32).fill(7);

test("buildContactListEvent: kind 3 (NIP-02), валидная подпись, теги 'p' по одному на pubkey", () => {
	const pubkeys = ["alice-pk", "bob-pk"];
	const event = buildContactListEvent(PRIV_KEY, pubkeys);
	assert.equal(event.kind, 3);
	assert.equal(verify(event), true);
	assert.deepEqual(
		event.tags.filter((t) => t[0] === "p"),
		[["p", "alice-pk"], ["p", "bob-pk"]],
	);
});

test("parseContactListEvent: round-trip своего же события", () => {
	const pubkeys = ["a", "b", "c"];
	const event = buildContactListEvent(PRIV_KEY, pubkeys);
	assert.deepEqual(parseContactListEvent(event), pubkeys);
});

test("parseContactListEvent: игнорирует посторонние теги, берёт только 'p'", () => {
	const foreignEvent = { tags: [["e", "someid"], ["p", "x"], ["d", "irrelevant"]] };
	assert.deepEqual(parseContactListEvent(foreignEvent), ["x"]);
});

test("addContact: добавляет новый pubkey", () => {
	assert.deepEqual(addContact(["a"], "b"), ["a", "b"]);
});

test("addContact: идемпотентно — уже существующий pubkey не дублируется", () => {
	assert.deepEqual(addContact(["a", "b"], "b"), ["a", "b"]);
});

test("addContact: не мутирует исходный массив", () => {
	const original = ["a"];
	addContact(original, "b");
	assert.deepEqual(original, ["a"]);
});

test("removeContact: удаляет существующий pubkey", () => {
	assert.deepEqual(removeContact(["a", "b", "c"], "b"), ["a", "c"]);
});

test("removeContact: отсутствующий pubkey — без изменений, не бросает", () => {
	assert.deepEqual(removeContact(["a", "b"], "z"), ["a", "b"]);
});

test("removeContact: не мутирует исходный массив", () => {
	const original = ["a", "b"];
	removeContact(original, "b");
	assert.deepEqual(original, ["a", "b"]);
});

test("buildMuteListEvent: kind 10000 (NIP-51 Mute List), валидная подпись", () => {
	const pubkeys = ["evil-pk"];
	const event = buildMuteListEvent(PRIV_KEY, pubkeys);
	assert.equal(event.kind, 10000);
	assert.equal(verify(event), true);
	assert.deepEqual(
		event.tags.filter((t) => t[0] === "p"),
		[["p", "evil-pk"]],
	);
});

test("parseMuteListEvent: round-trip своего же события", () => {
	const pubkeys = ["x", "y"];
	const event = buildMuteListEvent(PRIV_KEY, pubkeys);
	assert.deepEqual(parseMuteListEvent(event), pubkeys);
});

test("isBlocked: true для заблокированного pubkey", () => {
	assert.equal(isBlocked(["evil-pk"], "evil-pk"), true);
});

test("isBlocked: false для незнакомого pubkey", () => {
	assert.equal(isBlocked(["evil-pk"], "friend-pk"), false);
});

test("isBlocked: false на пустом списке", () => {
	assert.equal(isBlocked([], "anyone"), false);
});
