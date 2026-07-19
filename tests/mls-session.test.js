import { test } from "node:test";
import assert from "node:assert/strict";
import { encode, mlsMessageEncoder, wireformats, protocolVersions } from "ts-mls";
import {
	createOwnKeyPackage,
	createGroup,
	addMember,
	joinFromWelcome,
	encryptApplicationMessage,
	decryptApplicationMessage,
	deriveNostrEnvelopeKeys,
	serializeState,
	deserializeState,
} from "../src/core/crypto/mls-session.js";

const ALICE_PUBKEY_HEX = "a".repeat(64);
const BOB_PUBKEY_HEX = "b".repeat(64);

async function setupGroupWithBob() {
	const alice = await createOwnKeyPackage(ALICE_PUBKEY_HEX, "alice-device");
	const groupId = crypto.getRandomValues(new Uint8Array(32));
	let aliceState = await createGroup(ALICE_PUBKEY_HEX, alice, groupId);

	const bob = await createOwnKeyPackage(BOB_PUBKEY_HEX, "bob-device");
	const addResult = await addMember(aliceState, bob.wireBytes);
	aliceState = addResult.newSessionState;

	const bobState = await joinFromWelcome(bob, addResult.welcomeWireBytes);
	return { alice, bob, aliceState, bobState, addResult };
}

test("createOwnKeyPackage: credential.identity после кодирования/декодирования совпадает с исходным hex pubkey", async () => {
	const alice = await createOwnKeyPackage(ALICE_PUBKEY_HEX, "alice-device");
	assert.ok(alice.wireBytes instanceof Uint8Array);
	assert.ok(alice.wireBytes.length > 0);
});

test("addMember + joinFromWelcome: bob реально становится участником группы (сообщение доходит)", async () => {
	const { aliceState, bobState } = await setupGroupWithBob();

	const plaintext = new TextEncoder().encode("hello bob via mls");
	const sendResult = await encryptApplicationMessage(aliceState, plaintext);

	const recvResult = await decryptApplicationMessage(bobState, sendResult.wireBytes);
	assert.deepEqual(recvResult.message, plaintext);
});

test("encryptApplicationMessage/decryptApplicationMessage: round-trip произвольных байт (не только текста)", async () => {
	const { aliceState, bobState } = await setupGroupWithBob();
	const payload = crypto.getRandomValues(new Uint8Array(500));

	const sendResult = await encryptApplicationMessage(aliceState, payload);
	const recvResult = await decryptApplicationMessage(bobState, sendResult.wireBytes);

	assert.deepEqual(recvResult.message, payload);
});

test("decryptApplicationMessage: испорченный wireBytes (побитая подпись/AEAD-тег) отклоняется, не проходит молча", async () => {
	const { aliceState, bobState } = await setupGroupWithBob();
	const plaintext = new TextEncoder().encode("original");
	const sendResult = await encryptApplicationMessage(aliceState, plaintext);

	const tampered = new Uint8Array(sendResult.wireBytes);
	tampered[tampered.length - 1] ^= 0xff; // портим последний байт (часть AEAD-тега/подписи)

	await assert.rejects(() => decryptApplicationMessage(bobState, tampered));
});

// AC-FS-02 (TECH.md §15, метод "Перемешать доставку") — Nostr-relay не гарантирует
// порядок доставки live-событий, значит kind 445 могут прийти В ЛЮБОМ порядке
// относительно того, в каком Alice их зашифровала. ts-mls обязан буферизовать
// "пропущенные" ключи для сообщений, ратчет которых уже продвинут дальше.
test("AC-FS-02: сообщения, пришедшие НЕ ПО ПОРЯДКУ (2, 3, 1), все расшифровываются — ts-mls хранит пропущенные ключи", async () => {
	let { aliceState, bobState } = await setupGroupWithBob();

	const r1 = await encryptApplicationMessage(aliceState, new TextEncoder().encode("сообщение 1"));
	aliceState = r1.newSessionState;
	const r2 = await encryptApplicationMessage(aliceState, new TextEncoder().encode("сообщение 2"));
	aliceState = r2.newSessionState;
	const r3 = await encryptApplicationMessage(aliceState, new TextEncoder().encode("сообщение 3"));
	aliceState = r3.newSessionState;

	// Боб получает 2, затем 3, затем ПРОПУЩЕННОЕ 1 — последним.
	const d2 = await decryptApplicationMessage(bobState, r2.wireBytes);
	bobState = d2.newSessionState;
	assert.equal(new TextDecoder().decode(d2.message), "сообщение 2");

	const d3 = await decryptApplicationMessage(bobState, r3.wireBytes);
	bobState = d3.newSessionState;
	assert.equal(new TextDecoder().decode(d3.message), "сообщение 3");

	const d1 = await decryptApplicationMessage(bobState, r1.wireBytes);
	assert.equal(new TextDecoder().decode(d1.message), "сообщение 1", "пропущенный ключ для сообщения 1 должен был сохраниться в состоянии");
});

test("AC-FS-02: пропущенное сообщение переживает serializeState/deserializeState (состояние между сессиями, не только в памяти)", async () => {
	let { aliceState, bobState } = await setupGroupWithBob();

	const r1 = await encryptApplicationMessage(aliceState, new TextEncoder().encode("будет получено последним"));
	aliceState = r1.newSessionState;
	const r2 = await encryptApplicationMessage(aliceState, new TextEncoder().encode("приходит первым"));
	aliceState = r2.newSessionState;

	const d2 = await decryptApplicationMessage(bobState, r2.wireBytes);
	// Симулируем закрытие/переоткрытие приложения между приёмом r2 и r1 (chat.js
	// персистит serializeState после каждого decrypt) — пропущенный ключ для r1
	// обязан пережить round-trip через сериализацию, а не жить только в памяти.
	const restoredBobState = deserializeState(serializeState(d2.newSessionState));

	const d1 = await decryptApplicationMessage(restoredBobState, r1.wireBytes);
	assert.equal(new TextDecoder().decode(d1.message), "будет получено последним");
});

test("addMember: мусорные байты вместо KeyPackage — понятная ошибка, не тихая порча состояния", async () => {
	const alice = await createOwnKeyPackage(ALICE_PUBKEY_HEX, "alice-device");
	const groupId = crypto.getRandomValues(new Uint8Array(32));
	const aliceState = await createGroup(ALICE_PUBKEY_HEX, alice, groupId);

	await assert.rejects(() => addMember(aliceState, new Uint8Array([1, 2, 3, 4])));
});

test("deriveNostrEnvelopeKeys: alice и bob получают ОДИНАКОВЫЕ ключи конверта в одной эпохе (общий exporter_secret)", async () => {
	const { aliceState, bobState } = await setupGroupWithBob();

	const aliceKeys = await deriveNostrEnvelopeKeys(aliceState);
	const bobKeys = await deriveNostrEnvelopeKeys(bobState);

	assert.deepEqual(aliceKeys.privateKey, bobKeys.privateKey);
	assert.deepEqual(aliceKeys.publicKey, bobKeys.publicKey);
});

test("deriveNostrEnvelopeKeys: ключи конверта МЕНЯЮТСЯ после смены эпохи (commit) — свойство forward secrecy", async () => {
	const { alice: aliceKp, aliceState: stateEpoch0 } = await setupGroupWithBob();
	const keysEpoch0 = await deriveNostrEnvelopeKeys(stateEpoch0);

	// alice приглашает третьего участника -> новый commit -> новая эпоха
	const carol = await createOwnKeyPackage("c".repeat(64), "carol-device");
	const { newSessionState: stateEpoch1 } = await addMember(stateEpoch0, carol.wireBytes);
	const keysEpoch1 = await deriveNostrEnvelopeKeys(stateEpoch1);

	assert.notDeepEqual(keysEpoch0.privateKey, keysEpoch1.privateKey);
});

test("serializeState/deserializeState: round-trip сохраняет рабочее состояние (можно продолжать переписку после десериализации)", async () => {
	const { aliceState, bobState } = await setupGroupWithBob();

	const restoredAliceState = deserializeState(serializeState(aliceState));

	const plaintext = new TextEncoder().encode("after restore");
	const sendResult = await encryptApplicationMessage(restoredAliceState, plaintext);
	const recvResult = await decryptApplicationMessage(bobState, sendResult.wireBytes);

	assert.deepEqual(recvResult.message, plaintext);
});

test("SM-1: возвращаемые объекты НЕ содержат поле consumed (одноразовые ключи не утекают наружу из модуля)", async () => {
	const { aliceState, bobState, addResult } = await setupGroupWithBob();

	assert.equal("consumed" in addResult, false);

	const sendResult = await encryptApplicationMessage(aliceState, new TextEncoder().encode("x"));
	assert.equal("consumed" in sendResult, false);

	const recvResult = await decryptApplicationMessage(bobState, sendResult.wireBytes);
	assert.equal("consumed" in recvResult, false);
});

test("createOwnKeyPackage: невалидный (не 64-hex) nostrPubkeyHex отклоняется", async () => {
	await assert.rejects(() => createOwnKeyPackage("not-a-valid-hex-pubkey"));
	await assert.rejects(() => createOwnKeyPackage("a".repeat(63))); // на 1 символ короче
	await assert.rejects(() => createOwnKeyPackage("A".repeat(64))); // верхний регистр — не проходит строгий regex
});

test("createOwnKeyPackage: обязательный deviceId — пустая строка/отсутствие отклоняется (этап 25)", async () => {
	await assert.rejects(() => createOwnKeyPackage(ALICE_PUBKEY_HEX));
	await assert.rejects(() => createOwnKeyPackage(ALICE_PUBKEY_HEX, ""));
});

test("createOwnKeyPackage: credential.identity кодирует '${pubkey}:${deviceId}' — два устройства ОДНОЙ identity дают РАЗНЫЙ credential (этап 25)", async () => {
	const deviceA = await createOwnKeyPackage(ALICE_PUBKEY_HEX, "device-a");
	const deviceB = await createOwnKeyPackage(ALICE_PUBKEY_HEX, "device-b");
	assert.notDeepEqual(
		deviceA.publicPackage.leafNode.credential.identity,
		deviceB.publicPackage.leafNode.credential.identity,
	);
});

test("createGroup: невалидный nostrPubkeyHex отклоняется до обращения к ts-mls", async () => {
	const alice = await createOwnKeyPackage(ALICE_PUBKEY_HEX, "alice-device");
	await assert.rejects(() => createGroup("bad", alice, crypto.getRandomValues(new Uint8Array(32))));
});

test("addMember: authService реально проверяется ts-mls (не декоративный) — credential с испорченным identity отклоняется на уровне протокола", async () => {
	const alice = await createOwnKeyPackage(ALICE_PUBKEY_HEX, "alice-device");
	const groupId = crypto.getRandomValues(new Uint8Array(32));
	const aliceState = await createGroup(ALICE_PUBKEY_HEX, alice, groupId);

	// генерируем валидный (по форме) KeyPackage, но напрямую портим identity в уже закодированных wire-байтах
	// так, чтобы decodeKeyPackage их принял (валидная TLS-структура), а identity перестал быть 64-hex
	const bob = await createOwnKeyPackage(BOB_PUBKEY_HEX, "bob-device");
	const corruptedIdentity = "z".repeat(64); // не hex — не пройдёт HEX_PUBKEY_RE в authService
	const corruptedWireBytes = encode(mlsMessageEncoder, {
		keyPackage: {
			...bob.publicPackage,
			leafNode: {
				...bob.publicPackage.leafNode,
				credential: { ...bob.publicPackage.leafNode.credential, identity: new TextEncoder().encode(corruptedIdentity) },
			},
		},
		wireformat: wireformats.mls_key_package,
		version: protocolVersions.mls10,
	});

	await assert.rejects(() => addMember(aliceState, corruptedWireBytes));
});
