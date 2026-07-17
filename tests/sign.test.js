import { test } from "node:test";
import assert from "node:assert/strict";
import { generateSecretKey } from "nostr-tools/pure";
import { sign, verify } from "../src/core/crypto/sign.js";

function template(overrides = {}) {
	return { kind: 1, created_at: Math.floor(Date.now() / 1000), tags: [], content: "hello", ...overrides };
}

test("sign+verify: подписанное событие проходит проверку", () => {
	const sk = generateSecretKey();
	const signed = sign(template(), sk);
	assert.equal(verify(signed), true);
	assert.ok(signed.id);
	assert.ok(signed.sig);
	assert.ok(signed.pubkey);
});

test("verify: подмена content после подписи -> false", () => {
	const sk = generateSecretKey();
	const signed = sign(template(), sk);
	const tampered = { ...signed, content: "изменено" };
	assert.equal(verify(tampered), false);
});

test("verify: подмена sig -> false", () => {
	const sk = generateSecretKey();
	const signed = sign(template(), sk);
	const tampered = { ...signed, sig: "0".repeat(128) };
	assert.equal(verify(tampered), false);
});

test("verify: защита от Symbol-кэша nostr-tools (реальная находка) — тамперинг через spread не проходит как валидный", () => {
	const sk = generateSecretKey();
	const signed = sign(template(), sk);
	// verify(signed) уже мог быть вызван выше в этом файле для другого объекта —
	// здесь проверяем именно ЭТОТ конкретный сценарий: spread ПОСЛЕ верного verify
	assert.equal(verify(signed), true);
	const tamperedAfterVerify = { ...signed, content: "порча после успешной проверки оригинала" };
	assert.equal(
		verify(tamperedAfterVerify),
		false,
		"verify не должен доверять закэшированному Symbol-флагу из nostr-tools finalizeEvent/verifyEvent",
	);
});

test("sign+verify: работает с непустыми tags, подмена тега после подписи обнаруживается", () => {
	const sk = generateSecretKey();
	const signed = sign(template({ tags: [["p", "abc"], ["e", "def"]] }), sk);
	assert.equal(verify(signed), true);
	const tamperedTag = { ...signed, tags: [["p", "ИЗМЕНЕНО"], ["e", "def"]] };
	assert.equal(verify(tamperedTag), false);
});

test("verify: прямая мутация поля исходного (уже проверенного) объекта тоже обнаруживается", () => {
	const sk = generateSecretKey();
	const signed = sign(template(), sk);
	assert.equal(verify(signed), true);
	signed.content = "мутация после проверки";
	assert.equal(verify(signed), false);
});
