import { test } from "node:test";
import assert from "node:assert/strict";
import { verify } from "../src/core/crypto/sign.js";
import { buildProfileEvent, parseProfileEvent } from "../src/domain/identity/profile.js";

const PRIV_KEY = new Uint8Array(32).fill(11);

test("buildProfileEvent: kind 0, валидная подпись, content содержит name/about", () => {
	const event = buildProfileEvent(PRIV_KEY, { name: "Алиса", about: "Люблю котиков" });
	assert.equal(event.kind, 0);
	assert.equal(verify(event), true);
	const content = JSON.parse(event.content);
	assert.equal(content.name, "Алиса");
	assert.equal(content.about, "Люблю котиков");
});

test("buildProfileEvent: НЕ пишет поле picture, даже если бы его передали (аватар — локальный stand-in до Blossom, этап 26)", () => {
	const event = buildProfileEvent(PRIV_KEY, { name: "Боб", about: "", picture: "data:image/png;base64,AAAA" });
	const content = JSON.parse(event.content);
	assert.equal("picture" in content, false);
});

test("parseProfileEvent: round-trip своего же события", () => {
	const event = buildProfileEvent(PRIV_KEY, { name: "Вера", about: "тест" });
	const parsed = parseProfileEvent(event);
	assert.equal(parsed.name, "Вера");
	assert.equal(parsed.about, "тест");
});

test("parseProfileEvent: ЧУЖОЕ событие с picture парсится корректно (мы не пишем это поле, но обязаны уметь читать)", () => {
	const foreignEvent = { content: JSON.stringify({ name: "Кто-то", picture: "https://blossom.example/abc.png" }) };
	const parsed = parseProfileEvent(foreignEvent);
	assert.equal(parsed.picture, "https://blossom.example/abc.png");
});

test("parseProfileEvent: невалидный JSON в content — throw (граница с внешними данными relay)", () => {
	assert.throws(() => parseProfileEvent({ content: "не json{{{" }));
});
