import "fake-indexeddb/auto";
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { isTrustedImageUrl, safePictureUrl, registerTrustedImageOrigins } from "../src/domain/media/url-guard.js";
import { accumulateProfileVersions } from "../src/domain/identity/profile.js";

// AUDIT-EGOROD: picture чужого профиля не должен заставлять клиент ходить на чужой сервер.

beforeEach(() => registerTrustedImageOrigins(["https://blossom.ugolok.tech/"]));

test("свой Blossom, data:image и blob: — доверенные; чужой хост, javascript:, svg-data, file: — нет", () => {
	assert.equal(isTrustedImageUrl("https://blossom.ugolok.tech/" + "a".repeat(64)), true);
	assert.equal(isTrustedImageUrl("data:image/png;base64,iVBORw0KGgo="), true);
	assert.equal(isTrustedImageUrl("blob:https://ugolok.tech/1234"), true);
	assert.equal(isTrustedImageUrl("https://evil.example/pixel.png?viewer=1"), false, "трекинг-пиксель");
	assert.equal(isTrustedImageUrl("http://blossom.ugolok.tech/x"), false, "другая схема = другой origin");
	assert.equal(isTrustedImageUrl("https://blossom.ugolok.tech.evil.example/x"), false, "похожий хост");
	assert.equal(isTrustedImageUrl("https://blossom.ugolok.tech@evil.example/x"), false, "userinfo-обман");
	assert.equal(isTrustedImageUrl("javascript:alert(1)"), false);
	assert.equal(isTrustedImageUrl("data:image/svg+xml;base64,PHN2Zz4="), false);
	assert.equal(isTrustedImageUrl("file:///etc/passwd"), false);
	assert.equal(isTrustedImageUrl(""), false);
	assert.equal(isTrustedImageUrl(undefined), false);
	assert.equal(isTrustedImageUrl("https://blossom.ugolok.tech/" + "x".repeat(5000)), false, "слишком длинный");
});

test("пользовательский список Blossom-серверов расширяет доверие, замена списка — сужает", () => {
	registerTrustedImageOrigins(["https://my.blossom.example"]);
	assert.equal(isTrustedImageUrl("https://my.blossom.example/abc"), true);
	assert.equal(isTrustedImageUrl("https://blossom.ugolok.tech/abc"), false, "список заменён целиком");
});

test("safePictureUrl: недоверенный -> пустая строка (интерфейс покажет инициалы)", () => {
	assert.equal(safePictureUrl("https://evil.example/p.png"), "");
	assert.equal(safePictureUrl("https://blossom.ugolok.tech/h"), "https://blossom.ugolok.tech/h");
});

test("accumulateProfileVersions: picture чужого kind:0 фильтруется, остальные поля не тронуты", () => {
	const results = new Map();
	const ev = (id, picture, at) => ({ id, pubkey: "p", created_at: at, content: JSON.stringify({ name: "Боб", about: "hi", picture }) });
	accumulateProfileVersions(results, ev("e1", "https://evil.example/track.png", 1));
	assert.equal(results.get("p").picture, "");
	assert.equal(results.get("p").name, "Боб");
	accumulateProfileVersions(results, ev("e2", "https://blossom.ugolok.tech/ok", 2));
	assert.equal(results.get("p").picture, "https://blossom.ugolok.tech/ok");
	// профиль без picture вообще — поле не появляется
	const r2 = new Map();
	accumulateProfileVersions(r2, { id: "e3", pubkey: "q", created_at: 1, content: JSON.stringify({ name: "Q" }) });
	assert.equal("picture" in r2.get("q"), false);
});
