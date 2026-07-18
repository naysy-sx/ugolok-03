import { test } from "node:test";
import assert from "node:assert/strict";
import { verify } from "../src/core/crypto/sign.js";
import {
	buildGroupEvent,
	parseGroupEvent,
	addMember,
	removeMember,
	renameGroup,
} from "../src/domain/contacts/groups.js";

const PRIV_KEY = new Uint8Array(32).fill(11);
const OTHER_PRIV_KEY = new Uint8Array(32).fill(22);

test("buildGroupEvent: kind 30050, валидная подпись, d-tag = groupId в открытом виде", () => {
	const event = buildGroupEvent(PRIV_KEY, { groupId: "group-1", name: "Друзья", memberPubkeys: ["a", "b"] });
	assert.equal(event.kind, 30050);
	assert.equal(verify(event), true);
	assert.deepEqual(event.tags.filter((t) => t[0] === "d"), [["d", "group-1"]]);
});

test("buildGroupEvent: content зашифрован — не содержит имя/участников в открытом виде", () => {
	const event = buildGroupEvent(PRIV_KEY, { groupId: "group-1", name: "Секретная группа", memberPubkeys: ["alice-pubkey"] });
	assert.equal(event.content.includes("Секретная группа"), false);
	assert.equal(event.content.includes("alice-pubkey"), false);
});

test("parseGroupEvent: round-trip своего же события (self-encrypt)", () => {
	const event = buildGroupEvent(PRIV_KEY, { groupId: "group-1", name: "Друзья", memberPubkeys: ["a", "b"] });
	assert.deepEqual(parseGroupEvent(event, PRIV_KEY), { groupId: "group-1", name: "Друзья", memberPubkeys: ["a", "b"] });
});

test("parseGroupEvent: чужим приватным ключом расшифровать нельзя (throw)", () => {
	const event = buildGroupEvent(PRIV_KEY, { groupId: "group-1", name: "Друзья", memberPubkeys: ["a"] });
	assert.throws(() => parseGroupEvent(event, OTHER_PRIV_KEY));
});

test("addMember: добавляет pubkey", () => {
	const group = { groupId: "g1", name: "X", memberPubkeys: ["a"] };
	assert.deepEqual(addMember(group, "b"), { groupId: "g1", name: "X", memberPubkeys: ["a", "b"] });
});

test("addMember: идемпотентно — не дублирует", () => {
	const group = { groupId: "g1", name: "X", memberPubkeys: ["a", "b"] };
	assert.deepEqual(addMember(group, "b"), { groupId: "g1", name: "X", memberPubkeys: ["a", "b"] });
});

test("addMember: не мутирует исходный объект", () => {
	const group = { groupId: "g1", name: "X", memberPubkeys: ["a"] };
	addMember(group, "b");
	assert.deepEqual(group.memberPubkeys, ["a"]);
});

test("removeMember: удаляет pubkey", () => {
	const group = { groupId: "g1", name: "X", memberPubkeys: ["a", "b"] };
	assert.deepEqual(removeMember(group, "a"), { groupId: "g1", name: "X", memberPubkeys: ["b"] });
});

test("renameGroup: меняет только name", () => {
	const group = { groupId: "g1", name: "Старое имя", memberPubkeys: ["a"] };
	assert.deepEqual(renameGroup(group, "Новое имя"), { groupId: "g1", name: "Новое имя", memberPubkeys: ["a"] });
});

test("F-GR-02: один pubkey состоит в нескольких независимых группах одновременно", () => {
	const g1 = buildGroupEvent(PRIV_KEY, { groupId: "g1", name: "Друзья", memberPubkeys: ["shared-pk"] });
	const g2 = buildGroupEvent(PRIV_KEY, { groupId: "g2", name: "Работа", memberPubkeys: ["shared-pk"] });
	assert.deepEqual(parseGroupEvent(g1, PRIV_KEY).memberPubkeys, ["shared-pk"]);
	assert.deepEqual(parseGroupEvent(g2, PRIV_KEY).memberPubkeys, ["shared-pk"]);
});
