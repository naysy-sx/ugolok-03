import test from "node:test";
import assert from "node:assert/strict";
import { place, openChat, getChatBackTo, goTo } from "../src/ui/signals/place.js";

test("openChat без backTo: «Назад» из чата ведёт в список чатов (точки возврата нет)", () => {
	openChat("pk1");
	assert.equal(getChatBackTo(), null);
	assert.deepEqual(place.value, { kind: "chat", id: "pk1" });
});

test("openChat с backTo запоминает, откуда пришли (например, из «Контактов»)", () => {
	openChat("pk1", { backTo: { kind: "people" } });
	assert.deepEqual(getChatBackTo(), { kind: "people" });
	assert.deepEqual(place.value, { kind: "chat", id: "pk1" });
});

test("следующий вход в чат без backTo стирает прошлую точку возврата", () => {
	openChat("pk1", { backTo: { kind: "people" } });
	openChat("pk2");
	assert.equal(getChatBackTo(), null);
});

test("список чатов (openChat(null)) тоже сбрасывает точку возврата", () => {
	openChat("pk1", { backTo: { kind: "people" } });
	openChat(null);
	assert.equal(getChatBackTo(), null);
	assert.deepEqual(place.value, { kind: "chat" });
	goTo({ kind: "journal" });
});
