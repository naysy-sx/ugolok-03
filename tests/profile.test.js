import "fake-indexeddb/auto";
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { db } from "../src/core/store/database.js";
import { getPublicKey } from "../src/core/crypto/keys.js";
import { bytesToHex } from "@noble/hashes/utils.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { verify } from "../src/core/crypto/sign.js";
import { buildProfileEvent, parseProfileEvent, ensureProfilePublished, hydrateOwnProfile, uploadAvatarBlob } from "../src/domain/identity/profile.js";
import { sign } from "../src/core/crypto/sign.js";

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

// Найдено пользователем: вход в существующий аккаунт с чистого устройства
// (по мнемонике) — bootstrap (transport.js) тянет СВОЙ kind 0 в db.events
// через authors:[я], но до этой находки ничто не читало его обратно —
// avatar/bio оставались пустыми НАВСЕГДА на новом устройстве.
async function seedProfileEvent(ownerPubkey, privKey, createdAt, { name, about, picture } = {}) {
	const event = sign({ kind: 0, created_at: createdAt, tags: [], content: JSON.stringify({ name, about, picture }) }, privKey);
	await db.table("events").add(event);
	return event;
}

test("hydrateOwnProfile: пустая keystore -> bio/avatarUrl заполняются из своего же kind 0 в db.events", async () => {
	await db.table("keystore").clear();
	await db.table("events").clear();
	await seedKeystoreRow(OWNER_PUBKEY);
	await seedProfileEvent(OWNER_PUBKEY, PRIV_KEY, 1000, { name: "Алиса", about: "Люблю котиков", picture: "https://blossom.test/a.png" });

	const result = await hydrateOwnProfile(OWNER_PUBKEY);
	assert.equal(result, true);

	const row = await db.table("keystore").get(OWNER_PUBKEY);
	assert.equal(row.bio, "Люблю котиков");
	assert.equal(row.avatarUrl, "https://blossom.test/a.png");
});

test("hydrateOwnProfile: несколько копий kind 0 (разные relay/подписки) -> берёт САМУЮ СВЕЖУЮ по created_at", async () => {
	await db.table("keystore").clear();
	await db.table("events").clear();
	await seedKeystoreRow(OWNER_PUBKEY);
	await seedProfileEvent(OWNER_PUBKEY, PRIV_KEY, 1000, { about: "старое био" });
	await seedProfileEvent(OWNER_PUBKEY, PRIV_KEY, 2000, { about: "новое био" });

	await hydrateOwnProfile(OWNER_PUBKEY);
	const row = await db.table("keystore").get(OWNER_PUBKEY);
	assert.equal(row.bio, "новое био");
});

test("hydrateOwnProfile: нет ни одного kind 0 в db.events -> false, keystore не трогается", async () => {
	await db.table("keystore").clear();
	await db.table("events").clear();
	await seedKeystoreRow(OWNER_PUBKEY);

	const result = await hydrateOwnProfile(OWNER_PUBKEY);
	assert.equal(result, false);
	const row = await db.table("keystore").get(OWNER_PUBKEY);
	assert.equal(row.bio, undefined);
});

test("hydrateOwnProfile АДВЕРСАРНО: битый content (не JSON) — не бросает, возвращает false", async () => {
	await db.table("keystore").clear();
	await db.table("events").clear();
	await seedKeystoreRow(OWNER_PUBKEY);
	const badEvent = sign({ kind: 0, created_at: 1000, tags: [], content: "не json{{{" }, PRIV_KEY);
	await db.table("events").add(badEvent);

	await assert.doesNotReject(() => hydrateOwnProfile(OWNER_PUBKEY));
	assert.equal(await hydrateOwnProfile(OWNER_PUBKEY), false);
});

// Этап 57 (найдено собственной тестовой методологией этой сессии — повторные
// "чистые устройства" стирали keystore.profileAutoPublished, из-за чего
// ensureProfilePublished переиздавал ГОЛЫЙ {name} поверх содержательного kind 0,
// replaceable-семантика NIP-01 схлопывала старую версию с био/аватаром). Без
// этого фикса ЛЮБОЙ такой инцидент (не обязательно тестовый — сбой публикации
// вперемешку с гонкой между устройствами тоже мог бы дать пустой "последний по
// created_at") безусловно стирал бы уже хорошие локальные данные.
test("hydrateOwnProfile: пустое ВХОДЯЩЕЕ (about/picture отсутствуют) НЕ затирает уже непустые локальные bio/avatarUrl", async () => {
	await db.table("keystore").clear();
	await db.table("events").clear();
	await db.table("keystore").put({ id: OWNER_PUBKEY, salt: new Uint8Array(1), iv: new Uint8Array(1), ciphertext: new Uint8Array(1), login: "тест-логин", bio: "уже хорошее био", avatarUrl: "https://blossom.test/good.png" });
	await seedProfileEvent(OWNER_PUBKEY, PRIV_KEY, 1000, { name: "тест-логин" }); // голый republish, БЕЗ about/picture

	const result = await hydrateOwnProfile(OWNER_PUBKEY);
	assert.equal(result, true);
	const row = await db.table("keystore").get(OWNER_PUBKEY);
	assert.equal(row.bio, "уже хорошее био", "пустое about не должно было затереть локальное био");
	assert.equal(row.avatarUrl, "https://blossom.test/good.png", "пустой picture не должен был затереть локальный аватар");
});

test("hydrateOwnProfile: непустое входящее ПО-ПРЕЖНЕМУ побеждает (настоящее обновление проходит)", async () => {
	await db.table("keystore").clear();
	await db.table("events").clear();
	await db.table("keystore").put({ id: OWNER_PUBKEY, salt: new Uint8Array(1), iv: new Uint8Array(1), ciphertext: new Uint8Array(1), login: "тест-логин", bio: "старое био", avatarUrl: "https://blossom.test/old.png" });
	await seedProfileEvent(OWNER_PUBKEY, PRIV_KEY, 1000, { about: "новое био с другого устройства", picture: "https://blossom.test/new.png" });

	await hydrateOwnProfile(OWNER_PUBKEY);
	const row = await db.table("keystore").get(OWNER_PUBKEY);
	assert.equal(row.bio, "новое био с другого устройства");
	assert.equal(row.avatarUrl, "https://blossom.test/new.png");
});

test("hydrateOwnProfile: и локально, и во входящем пусто -> остаётся пусто (не регрессия обычного случая)", async () => {
	await db.table("keystore").clear();
	await db.table("events").clear();
	await seedKeystoreRow(OWNER_PUBKEY);
	await seedProfileEvent(OWNER_PUBKEY, PRIV_KEY, 1000, { name: "тест-логин" });

	await hydrateOwnProfile(OWNER_PUBKEY);
	const row = await db.table("keystore").get(OWNER_PUBKEY);
	assert.equal(row.bio, "");
	assert.equal(row.avatarUrl, "");
});

// uploadAvatarBlob — перенесено из tests/attachments-upload.test.js (этап 53
// И7, задача 7.4 — снятие фасада attachments, DESIGN.md). Логика не менялась,
// только импорт (uploadBlob из domain/files/blob.js, validateAttachment из
// domain/files/attachment-validation.js — оба уже переиспользуемые примитивы,
// без изменений в них самих).
function fakeResponse({ jsonBody = {} } = {}) {
	return { ok: true, status: 200, json: async () => jsonBody, text: async () => "" };
}

function makeUploadFetch(store) {
	return async (url, opts) => {
		const body = new Uint8Array(opts.body);
		const sha256Hex = bytesToHex(sha256(body));
		store.set(sha256Hex, body);
		return fakeResponse({ jsonBody: { sha256: sha256Hex, size: body.length, url: `https://blossom.test/${sha256Hex}` } });
	};
}

test("uploadAvatarBlob: НЕ шифрует — сервер получает те же байты, что переданы (публичный профиль, не сообщение)", async () => {
	const store = new Map();
	let sentBody;
	const fetchImpl = async (url, opts) => {
		sentBody = opts.body;
		return makeUploadFetch(store)(url, opts);
	};
	const original = new TextEncoder().encode("картинка-аватар (условно)");
	await uploadAvatarBlob("https://blossom.test", original, "image/png", PRIV_KEY, { fetchImpl });
	assert.deepEqual(new Uint8Array(sentBody), original, "avatar публичный — байты идут как есть, без шифрования");
});

test("uploadAvatarBlob: возвращает СТРОКУ — публичный URL из ответа сервера (response.url), не дескриптор", async () => {
	const store = new Map();
	const fetchImpl = makeUploadFetch(store);
	const url = await uploadAvatarBlob("https://blossom.test", new Uint8Array([1, 2, 3]), "image/jpeg", PRIV_KEY, { fetchImpl });
	assert.equal(typeof url, "string");
	assert.ok(url.startsWith("https://blossom.test/"));
});

test("uploadAvatarBlob: недопустимый MIME — throw ДО сети (переиспользует validateAttachment)", async () => {
	let called = false;
	const fetchImpl = async () => {
		called = true;
		return fakeResponse();
	};
	await assert.rejects(
		() => uploadAvatarBlob("https://blossom.test", new Uint8Array([1]), "application/x-msdownload", PRIV_KEY, { fetchImpl }),
		/тип/,
	);
	assert.equal(called, false);
});

test("uploadAvatarBlob: сервер не вернул response.url — фолбэк на serverUrl + '/' + sha256", async () => {
	const original = new TextEncoder().encode("аватар без url в ответе");
	const sha256Hex = bytesToHex(sha256(original));
	const fetchImpl = async () => fakeResponse({ jsonBody: { sha256: sha256Hex, size: original.length } });
	const url = await uploadAvatarBlob("https://blossom.test/", original, "image/png", PRIV_KEY, { fetchImpl });
	assert.equal(url, `https://blossom.test/${sha256Hex}`);
});

// Этап 62 — BUD-06-предпроверка (checkUploadRequirements) ПЕРЕД реальной PUT-
// загрузкой аватара, тот же приём, что uploadMessageAttachment/putStream.
test("uploadAvatarBlob: спрашивает BUD-06 (HEAD /upload) ПЕРЕД реальной загрузкой", async () => {
	const store = new Map();
	const headCalls = [];
	const fetchImpl = async (url, opts) => {
		if (opts.method === "HEAD") {
			headCalls.push({ url, opts });
			return { ok: true, status: 200, headers: { get: () => null } };
		}
		return makeUploadFetch(store)(url, opts);
	};
	await uploadAvatarBlob("https://blossom.test", new Uint8Array([1, 2, 3]), "image/png", PRIV_KEY, { fetchImpl });
	assert.equal(headCalls.length, 1);
	assert.equal(headCalls[0].url, "https://blossom.test/upload");
	assert.equal(headCalls[0].opts.headers["X-Content-Type"], "image/png");
});

test("uploadAvatarBlob: сервер отклонил по BUD-06 (413) -> throw ДО реальной загрузки, PUT не вызывается", async () => {
	let putCalled = false;
	const fetchImpl = async (url, opts) => {
		if (opts.method === "HEAD") return { ok: false, status: 413, headers: { get: (n) => (n === "X-Reason" ? "слишком большой" : null) } };
		putCalled = true;
		return fakeResponse({ jsonBody: {} });
	};
	await assert.rejects(
		() => uploadAvatarBlob("https://blossom.test", new Uint8Array([1, 2, 3]), "image/png", PRIV_KEY, { fetchImpl }),
		/413|слишком большой/,
	);
	assert.equal(putCalled, false);
});
