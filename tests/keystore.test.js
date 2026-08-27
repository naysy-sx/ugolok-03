import "fake-indexeddb/auto";
import { test, before, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import { db } from "../src/core/store/database.js";
import { encryptAndStore, decryptPrivateKey, decryptMnemonic, listAccounts, getProfile, updateProfile, recordLastUnlock, lastUnlockBucket } from "../src/core/crypto/keystore.js";

before(async () => {
	await db.open();
});

beforeEach(async () => {
	await db.table("keystore").clear();
});

after(() => {
	db.close();
});

test("encryptAndStore -> decryptPrivateKey с верным паролем и id возвращает исходный privKey", async () => {
	const privKey = crypto.getRandomValues(new Uint8Array(32));
	await encryptAndStore(privKey, "correct horse battery staple", "acc-1");
	const decrypted = await decryptPrivateKey("correct horse battery staple", "acc-1");
	assert.deepEqual(new Uint8Array(decrypted), privKey);
});

test("decryptPrivateKey с неверным паролем — отклоняется (AES-GCM tag mismatch)", async () => {
	const privKey = crypto.getRandomValues(new Uint8Array(32));
	await encryptAndStore(privKey, "correct-password", "acc-1");
	await assert.rejects(() => decryptPrivateKey("wrong-password", "acc-1"));
});

test("decryptPrivateKey с несуществующим id — понятная ошибка, не крах", async () => {
	await assert.rejects(
		() => decryptPrivateKey("any-password", "no-such-account"),
		/keystore/i,
	);
});

test("хранимая запись не содержит privKey в открытом виде (реально зашифровано)", async () => {
	const privKey = crypto.getRandomValues(new Uint8Array(32));
	await encryptAndStore(privKey, "some-password", "acc-1");
	const record = await db.table("keystore").get("acc-1");
	const ciphertextBytes = new Uint8Array(record.ciphertext);
	assert.notDeepEqual(ciphertextBytes.slice(0, 32), privKey);
});

test("encryptAndStore дважды подряд на тот же id — новые salt/iv, старый пароль больше не подходит", async () => {
	const privKey = crypto.getRandomValues(new Uint8Array(32));
	await encryptAndStore(privKey, "password-one", "acc-1");
	const first = await db.table("keystore").get("acc-1");
	await encryptAndStore(privKey, "password-two", "acc-1");
	const second = await db.table("keystore").get("acc-1");
	assert.notDeepEqual(new Uint8Array(first.salt), new Uint8Array(second.salt));
	assert.notDeepEqual(new Uint8Array(first.iv), new Uint8Array(second.iv));
	await assert.rejects(() => decryptPrivateKey("password-one", "acc-1"));
	const decrypted = await decryptPrivateKey("password-two", "acc-1");
	assert.deepEqual(new Uint8Array(decrypted), privKey);
});

test("мультиаккаунт: два разных id сосуществуют независимо, свой пароль на каждый", async () => {
	const keyA = crypto.getRandomValues(new Uint8Array(32));
	const keyB = crypto.getRandomValues(new Uint8Array(32));
	await encryptAndStore(keyA, "password-a", "acc-a", { login: "alice" });
	await encryptAndStore(keyB, "password-b", "acc-b", { login: "bob" });

	assert.deepEqual(new Uint8Array(await decryptPrivateKey("password-a", "acc-a")), keyA);
	assert.deepEqual(new Uint8Array(await decryptPrivateKey("password-b", "acc-b")), keyB);
	// чужой пароль к чужому id не подходит
	await assert.rejects(() => decryptPrivateKey("password-a", "acc-b"));
});

test("meta (например login) сохраняется в записи как есть, не шифруется", async () => {
	const privKey = crypto.getRandomValues(new Uint8Array(32));
	await encryptAndStore(privKey, "password", "acc-1", { login: "testuser" });
	const record = await db.table("keystore").get("acc-1");
	assert.equal(record.login, "testuser");
});

test("listAccounts: пустой массив, когда аккаунтов нет", async () => {
	assert.deepEqual(await listAccounts(), []);
});

test("listAccounts: возвращает {id, login} для каждого аккаунта, без секретов", async () => {
	await encryptAndStore(crypto.getRandomValues(new Uint8Array(32)), "pw-a", "acc-a", { login: "alice" });
	await encryptAndStore(crypto.getRandomValues(new Uint8Array(32)), "pw-b", "acc-b", { login: "bob" });
	const accounts = await listAccounts();
	assert.equal(accounts.length, 2);
	const byId = Object.fromEntries(accounts.map((a) => [a.id, a]));
	assert.equal(byId["acc-a"].login, "alice");
	assert.equal(byId["acc-b"].login, "bob");
	for (const acc of accounts) {
		assert.equal(acc.salt, undefined);
		assert.equal(acc.iv, undefined);
		assert.equal(acc.ciphertext, undefined);
		assert.equal(acc.lastUnlockAt, undefined);
	}
});

test("recordLastUnlock + listAccounts: lastUnlockAt пишется и читается, секреты не утекают", async () => {
	await encryptAndStore(crypto.getRandomValues(new Uint8Array(32)), "pw", "acc-1", { login: "alice" });
	const at = Date.UTC(2026, 7, 26, 12, 0, 0);
	await recordLastUnlock("acc-1", at);
	const accounts = await listAccounts();
	assert.equal(accounts.length, 1);
	assert.equal(accounts[0].lastUnlockAt, at);
	assert.equal(accounts[0].ciphertext, undefined);
});

test("lastUnlockBucket: сегодня / вчера / N дней / дата", () => {
	const now = new Date(2026, 7, 26, 18, 0, 0).getTime();
	assert.deepEqual(lastUnlockBucket(new Date(2026, 7, 26, 1, 0, 0).getTime(), now), { kind: "today" });
	assert.deepEqual(lastUnlockBucket(new Date(2026, 7, 25, 23, 0, 0).getTime(), now), { kind: "yesterday" });
	assert.deepEqual(lastUnlockBucket(new Date(2026, 7, 23, 12, 0, 0).getTime(), now), { kind: "days", count: 3 });
	assert.equal(lastUnlockBucket(new Date(2026, 6, 1, 12, 0, 0).getTime(), now).kind, "date");
	assert.equal(lastUnlockBucket(null, now), null);
	assert.equal(lastUnlockBucket(undefined, now), null);
});

test("getProfile: свежесозданный аккаунт — login из meta, avatar/bio/avatarUrl пустые строки", async () => {
	await encryptAndStore(crypto.getRandomValues(new Uint8Array(32)), "pw", "acc-1", { login: "alice" });
	const profile = await getProfile("acc-1");
	assert.deepEqual(profile, { login: "alice", avatar: "", bio: "", avatarUrl: "" });
});

test("getProfile: несуществующий id — понятная ошибка, не крах", async () => {
	await assert.rejects(() => getProfile("no-such-account"), /keystore/i);
});

test("updateProfile: сохраняет avatar и bio, не трогая login и секреты", async () => {
	const privKey = crypto.getRandomValues(new Uint8Array(32));
	await encryptAndStore(privKey, "pw", "acc-1", { login: "alice" });
	await updateProfile("acc-1", { avatar: "data:image/png;base64,AAAA", bio: "Привет!" });
	const profile = await getProfile("acc-1");
	assert.deepEqual(profile, { login: "alice", avatar: "data:image/png;base64,AAAA", bio: "Привет!", avatarUrl: "" });
	assert.deepEqual(new Uint8Array(await decryptPrivateKey("pw", "acc-1")), privKey);
});

test("updateProfile: частичное обновление (только bio) не стирает уже сохранённый avatar", async () => {
	await encryptAndStore(crypto.getRandomValues(new Uint8Array(32)), "pw", "acc-1", { login: "alice" });
	await updateProfile("acc-1", { avatar: "data:image/png;base64,AAAA" });
	await updateProfile("acc-1", { bio: "Только био" });
	const profile = await getProfile("acc-1");
	assert.equal(profile.avatar, "data:image/png;base64,AAAA");
	assert.equal(profile.bio, "Только био");
});

// Этап 38-довесок — найденный реальным использованием баг: handleBioSubmit
// republish'ила kind-0 БЕЗ picture, стирая уже опубликованный аватар (kind 0
// replaceable — republish без поля означает "поля больше нет"). avatarUrl —
// ОТДЕЛЬНОЕ поле от avatar (dataUrl-превью): нужен именно ПУБЛИЧНЫЙ Blossom-URL,
// который handleBioSubmit сможет переиспользовать при своём republish.
test("updateProfile/getProfile: avatarUrl хранится отдельно от avatar (dataUrl превью не публикуемо, avatarUrl — публичный URL)", async () => {
	await encryptAndStore(crypto.getRandomValues(new Uint8Array(32)), "pw", "acc-1", { login: "alice" });
	await updateProfile("acc-1", { avatar: "data:image/png;base64,AAAA", avatarUrl: "https://blossom.test/abc123.png" });
	const profile = await getProfile("acc-1");
	assert.equal(profile.avatar, "data:image/png;base64,AAAA");
	assert.equal(profile.avatarUrl, "https://blossom.test/abc123.png");
});

test("updateProfile: обновление bio НЕ стирает уже сохранённый avatarUrl (частичный patch)", async () => {
	await encryptAndStore(crypto.getRandomValues(new Uint8Array(32)), "pw", "acc-1", { login: "alice" });
	await updateProfile("acc-1", { avatarUrl: "https://blossom.test/abc123.png" });
	await updateProfile("acc-1", { bio: "Новое био" });
	const profile = await getProfile("acc-1");
	assert.equal(profile.avatarUrl, "https://blossom.test/abc123.png");
	assert.equal(profile.bio, "Новое био");
});

test("updateProfile: два разных аккаунта не пересекаются", async () => {
	await encryptAndStore(crypto.getRandomValues(new Uint8Array(32)), "pw-a", "acc-a", { login: "alice" });
	await encryptAndStore(crypto.getRandomValues(new Uint8Array(32)), "pw-b", "acc-b", { login: "bob" });
	await updateProfile("acc-a", { bio: "Био Алисы" });
	await updateProfile("acc-b", { bio: "Био Боба" });
	assert.equal((await getProfile("acc-a")).bio, "Био Алисы");
	assert.equal((await getProfile("acc-b")).bio, "Био Боба");
});

// Этап 44 (ревью Claude Opus) — повторный показ мнемоники: раньше показывалась
// один раз при регистрации и нигде не сохранялась, потеря устройства = потеря
// identity целиком безвозвратно.
test("encryptAndStore с mnemonic -> decryptMnemonic верным паролем возвращает исходную фразу", async () => {
	const privKey = crypto.getRandomValues(new Uint8Array(32));
	await encryptAndStore(privKey, "correct-password", "acc-1", { login: "alice" }, "abandon abandon abandon ability able about above absent absorb abstract absurd abuse");
	const phrase = await decryptMnemonic("correct-password", "acc-1");
	assert.equal(phrase, "abandon abandon abandon ability able about above absent absorb abstract absurd abuse");
});

test("decryptMnemonic неверным паролем — отклоняется (AES-GCM tag mismatch)", async () => {
	await encryptAndStore(crypto.getRandomValues(new Uint8Array(32)), "correct-password", "acc-1", {}, "some mnemonic phrase here");
	await assert.rejects(() => decryptMnemonic("wrong-password", "acc-1"));
});

test("encryptAndStore БЕЗ mnemonic (5-й аргумент не передан — например импорт готового приватного ключа) -> decryptMnemonic честно бросает, не выдаёт пустую строку", async () => {
	await encryptAndStore(crypto.getRandomValues(new Uint8Array(32)), "pw", "acc-1", { login: "alice" });
	await assert.rejects(() => decryptMnemonic("pw", "acc-1"), /keystore/i);
});

test("decryptMnemonic на несуществующий id — понятная ошибка, не крах", async () => {
	await assert.rejects(() => decryptMnemonic("any-password", "no-such-account"), /keystore/i);
});

test("mnemonicCiphertext шифруется СВОИМ nonce, отдельным от iv приватного ключа (не переиспользует nonce AES-GCM-ключа)", async () => {
	await encryptAndStore(crypto.getRandomValues(new Uint8Array(32)), "pw", "acc-1", {}, "test mnemonic phrase for nonce check");
	const record = await db.table("keystore").get("acc-1");
	assert.notDeepEqual(new Uint8Array(record.mnemonicIv), new Uint8Array(record.iv));
});

test("хранимая mnemonicCiphertext не содержит фразу в открытом виде", async () => {
	const phrase = "secret words nobody should read in plaintext from disk ever";
	await encryptAndStore(crypto.getRandomValues(new Uint8Array(32)), "pw", "acc-1", {}, phrase);
	const record = await db.table("keystore").get("acc-1");
	const plainBytes = new TextEncoder().encode(phrase);
	const cipherBytes = new Uint8Array(record.mnemonicCiphertext);
	assert.notDeepEqual(cipherBytes.slice(0, plainBytes.length), plainBytes);
});

test("listAccounts: hasMnemonic=true, если мнемоника сохранена, false — если нет", async () => {
	await encryptAndStore(crypto.getRandomValues(new Uint8Array(32)), "pw-a", "acc-a", { login: "alice" }, "some mnemonic phrase");
	await encryptAndStore(crypto.getRandomValues(new Uint8Array(32)), "pw-b", "acc-b", { login: "bob" }); // без mnemonic — импорт ключа
	const accounts = await listAccounts();
	const byId = Object.fromEntries(accounts.map((a) => [a.id, a]));
	assert.equal(byId["acc-a"].hasMnemonic, true);
	assert.equal(byId["acc-b"].hasMnemonic, false);
});
