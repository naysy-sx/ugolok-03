import "fake-indexeddb/auto";
import { test, before, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import { db } from "../src/core/store/database.js";
import { encryptAndStore, decryptPrivateKey, listAccounts, getProfile, updateProfile } from "../src/core/crypto/keystore.js";

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
	}
});

test("getProfile: свежесозданный аккаунт — login из meta, avatar/bio пустые строки", async () => {
	await encryptAndStore(crypto.getRandomValues(new Uint8Array(32)), "pw", "acc-1", { login: "alice" });
	const profile = await getProfile("acc-1");
	assert.deepEqual(profile, { login: "alice", avatar: "", bio: "" });
});

test("getProfile: несуществующий id — понятная ошибка, не крах", async () => {
	await assert.rejects(() => getProfile("no-such-account"), /keystore/i);
});

test("updateProfile: сохраняет avatar и bio, не трогая login и секреты", async () => {
	const privKey = crypto.getRandomValues(new Uint8Array(32));
	await encryptAndStore(privKey, "pw", "acc-1", { login: "alice" });
	await updateProfile("acc-1", { avatar: "data:image/png;base64,AAAA", bio: "Привет!" });
	const profile = await getProfile("acc-1");
	assert.deepEqual(profile, { login: "alice", avatar: "data:image/png;base64,AAAA", bio: "Привет!" });
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

test("updateProfile: два разных аккаунта не пересекаются", async () => {
	await encryptAndStore(crypto.getRandomValues(new Uint8Array(32)), "pw-a", "acc-a", { login: "alice" });
	await encryptAndStore(crypto.getRandomValues(new Uint8Array(32)), "pw-b", "acc-b", { login: "bob" });
	await updateProfile("acc-a", { bio: "Био Алисы" });
	await updateProfile("acc-b", { bio: "Био Боба" });
	assert.equal((await getProfile("acc-a")).bio, "Био Алисы");
	assert.equal((await getProfile("acc-b")).bio, "Био Боба");
});
