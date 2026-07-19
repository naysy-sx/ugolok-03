import "fake-indexeddb/auto";
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { db } from "../src/core/store/database.js";
import { getPublicKey } from "../src/core/crypto/keys.js";
import { bytesToHex } from "@noble/hashes/utils.js";
import { verify } from "../src/core/crypto/sign.js";
import { buildProfileEvent, parseProfileEvent, ensureProfilePublished } from "../src/domain/identity/profile.js";

const PRIV_KEY = new Uint8Array(32).fill(11);

before(async () => {
	await db.open();
});

after(() => {
	db.close();
});

test("buildProfileEvent: kind 0, валидная подпись, content содержит name/about", () => {
	const event = buildProfileEvent(PRIV_KEY, { name: "Алиса", about: "Люблю котиков" });
	assert.equal(event.kind, 0);
	assert.equal(verify(event), true);
	const content = JSON.parse(event.content);
	assert.equal(content.name, "Алиса");
	assert.equal(content.about, "Люблю котиков");
});

// Этап 37 (правка контракта, было наоборот на этапе 26 — "picture НЕ пишется,
// аватар — локальный stand-in до Blossom"): Blossom-загрузка теперь реализована
// (uploadAvatarBlob), значит buildProfileEvent обязана уметь передать реальный URL.
test("buildProfileEvent: пишет поле picture, если передано (этап 37 — Blossom-загрузка реализована)", () => {
	const event = buildProfileEvent(PRIV_KEY, { name: "Боб", about: "", picture: "https://blossom.test/abc123.png" });
	const content = JSON.parse(event.content);
	assert.equal(content.picture, "https://blossom.test/abc123.png");
});

test("buildProfileEvent: picture не передана — в content её вообще нет (не пустая строка, честное отсутствие поля)", () => {
	const event = buildProfileEvent(PRIV_KEY, { name: "Вера", about: "тест" });
	const content = JSON.parse(event.content);
	assert.equal("picture" in content, false);
});

test("parseProfileEvent: round-trip своего же события", () => {
	const event = buildProfileEvent(PRIV_KEY, { name: "Вера", about: "тест" });
	const parsed = parseProfileEvent(event);
	assert.equal(parsed.name, "Вера");
	assert.equal(parsed.about, "тест");
});

test("parseProfileEvent: ЧУЖОЕ событие с picture парсится корректно (round-trip не только свой формат)", () => {
	const foreignEvent = { content: JSON.stringify({ name: "Кто-то", picture: "https://blossom.example/abc.png" }) };
	const parsed = parseProfileEvent(foreignEvent);
	assert.equal(parsed.picture, "https://blossom.example/abc.png");
});

test("parseProfileEvent: невалидный JSON в content — throw (граница с внешними данными relay)", () => {
	assert.throws(() => parseProfileEvent({ content: "не json{{{" }));
});

const OWNER_PUBKEY = bytesToHex(getPublicKey(PRIV_KEY));

async function seedKeystoreRow(id) {
	await db.table("keystore").put({ id, salt: new Uint8Array(1), iv: new Uint8Array(1), ciphertext: new Uint8Array(1), login: "тест-логин" });
}

test("ensureProfilePublished: первый вызов публикует {name: login}, ставит локальный флаг", async () => {
	await db.table("keystore").clear();
	await seedKeystoreRow(OWNER_PUBKEY);
	const published = [];
	await ensureProfilePublished(OWNER_PUBKEY, "тест-логин", PRIV_KEY, async (event) => {
		published.push(event);
		return { ok: true };
	});

	assert.equal(published.length, 1);
	assert.equal(published[0].kind, 0);
	assert.deepEqual(JSON.parse(published[0].content), { name: "тест-логин" });

	const row = await db.table("keystore").get(OWNER_PUBKEY);
	assert.equal(row.profileAutoPublished, true);
});

test("ensureProfilePublished: повторный вызов — no-op, publish не вызывается снова (флаг уже стоит)", async () => {
	await db.table("keystore").clear();
	await seedKeystoreRow(OWNER_PUBKEY);
	let calls = 0;
	const publish = async () => {
		calls++;
		return { ok: true };
	};
	await ensureProfilePublished(OWNER_PUBKEY, "тест-логин", PRIV_KEY, publish);
	await ensureProfilePublished(OWNER_PUBKEY, "тест-логин", PRIV_KEY, publish);
	assert.equal(calls, 1);
});

test("ensureProfilePublished АДВЕРСАРНО: publish бросает исключение — флаг всё равно стоит (не повторяет попытку при следующем логине), сам вызов НЕ бросает наружу", async () => {
	await db.table("keystore").clear();
	await seedKeystoreRow(OWNER_PUBKEY);
	await assert.doesNotReject(() =>
		ensureProfilePublished(OWNER_PUBKEY, "тест-логин", PRIV_KEY, async () => {
			throw new Error("relay недоступен");
		}),
	);
	const row = await db.table("keystore").get(OWNER_PUBKEY);
	assert.equal(row.profileAutoPublished, true, "флаг ставится ДО попытки публикации — сбой сети не должен блокировать login/connect");
});
