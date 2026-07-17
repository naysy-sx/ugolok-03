import { test } from "node:test";
import assert from "node:assert/strict";
import { generateSecretKey, getPublicKey } from "nostr-tools/pure";
import { wrap, unwrap } from "../src/core/crypto/nip59.js";

test("wrap: возвращает событие kind 1059 (gift wrap)", () => {
	const aliceSk = generateSecretKey();
	const bobPk = getPublicKey(generateSecretKey());
	const wrapped = wrap({ kind: 14, content: "hi", tags: [] }, aliceSk, bobPk);
	assert.equal(wrapped.kind, 1059);
	assert.ok(wrapped.id);
	assert.ok(wrapped.sig);
});

test("wrap: pubkey обёртки — ЭФЕМЕРНЫЙ, не совпадает с реальным pubkey отправителя (приватность метаданных)", () => {
	const aliceSk = generateSecretKey();
	const alicePk = getPublicKey(aliceSk);
	const bobPk = getPublicKey(generateSecretKey());
	const wrapped = wrap({ kind: 14, content: "hi", tags: [] }, aliceSk, bobPk);
	assert.notEqual(wrapped.pubkey, alicePk);
});

test("wrap+unwrap: round-trip восстанавливает исходный rumor (content, реальный pubkey автора)", () => {
	const aliceSk = generateSecretKey();
	const alicePk = getPublicKey(aliceSk);
	const bobSk = generateSecretKey();
	const bobPk = getPublicKey(bobSk);

	const wrapped = wrap({ kind: 14, content: "hello bob", tags: [["p", bobPk]] }, aliceSk, bobPk);
	const rumor = unwrap(wrapped, bobSk);

	assert.equal(rumor.content, "hello bob");
	assert.equal(rumor.kind, 14);
	assert.equal(rumor.pubkey, alicePk, "rumor.pubkey должен быть реальным ключом отправителя (F-EV-05 сверяет это на приёме)");
});

test("unwrap: чужим (не адресата) ключом не разворачивается", () => {
	const aliceSk = generateSecretKey();
	const bobPk = getPublicKey(generateSecretKey());
	const eveSk = generateSecretKey();
	const wrapped = wrap({ kind: 14, content: "secret", tags: [] }, aliceSk, bobPk);
	assert.throws(() => unwrap(wrapped, eveSk));
});

test("wrap: два вызова с тем же rumor дают разные wrap (эфемерный ключ + случайный created_at каждый раз)", () => {
	const aliceSk = generateSecretKey();
	const bobPk = getPublicKey(generateSecretKey());
	const rumorTemplate = { kind: 14, content: "same content", tags: [] };
	const w1 = wrap(rumorTemplate, aliceSk, bobPk);
	const w2 = wrap(rumorTemplate, aliceSk, bobPk);
	assert.notEqual(w1.id, w2.id);
	assert.notEqual(w1.pubkey, w2.pubkey, "разные эфемерные ключи на каждый wrap");
});
