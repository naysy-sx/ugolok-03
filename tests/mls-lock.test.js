import "fake-indexeddb/auto";
import { test, before, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import { db } from "../src/core/store/database.js";
import { getPublicKey } from "../src/core/crypto/keys.js";
import { bytesToHex } from "@noble/hashes/utils.js";
import { unwrap as nip59Unwrap } from "../src/core/crypto/nip59.js";
import { createOwnKeyPackage, joinFromWelcome, serializeState } from "../src/core/crypto/mls-session.js";
import { toEncryptedRow, fromEncryptedRow } from "../src/core/store/encrypted-table.js";
import { MLS_GROUPS_PLAINTEXT_FIELDS } from "../src/core/store/table-fields.js";
import { computeGroupId, ensureChatEstablished, sendMessage, receiveGroupMessageEvent, getChatHistory } from "../src/domain/messaging/chat.js";
import { syncDeviceMembership } from "../src/domain/messaging/devices.js";
import { withGroupLock } from "../src/core/store/mls-lock.js";

// Этап 74 — T2 (CONTRACTS.md/DESIGN.md "Этап 74"): RC-3 — deviceId/MLS-состояние
// в IndexedDB, общей на профиль браузера; ДВЕ вкладки одного браузера = два
// независимых читателя-писателя ОДНОГО состояния mlsGroups. withGroupLock —
// единственный писатель на пару (ownerPubkey, groupIdHex).

const ALICE_PRIV = new Uint8Array(32).fill(1);
const BOB_PRIV = new Uint8Array(32).fill(2);
const ALICE_PUB = bytesToHex(getPublicKey(ALICE_PRIV));
const BOB_PUB = bytesToHex(getPublicKey(BOB_PRIV));
const DB_KEY = crypto.getRandomValues(new Uint8Array(32));

before(async () => {
	await db.open();
});

beforeEach(async () => {
	await db.table("ownKeyPackage").clear();
	await db.table("mlsGroups").clear();
	await db.table("messages").clear();
	await db.table("processedGroupEvents").clear();
	await db.table("knownDevices").clear();
});

after(() => {
	db.close();
});

// Deferred — контролируемый gate вместо таймингов/sleep: детерминированно
// доказывает отсутствие интерливинга, не полагается на скорость выполнения.
function deferred() {
	let resolve;
	const promise = new Promise((r) => (resolve = r));
	return { promise, resolve };
}

test("withGroupLock: сериализует конкурентные вызовы с ОДНИМ и тем же именем — второй не стартует, пока первый не завершится", async () => {
	const trace = [];
	const gate = deferred();

	const p1 = withGroupLock("owner1", "group1", async () => {
		trace.push("start1");
		await gate.promise;
		trace.push("end1");
		return "r1";
	});

	// Даём event loop шанс запустить p1 (микротаски) — p1 обязан успеть дойти
	// до await gate.promise и застрять там ДО того, как мы запустим второй вызов.
	await Promise.resolve();
	await Promise.resolve();

	const p2 = withGroupLock("owner1", "group1", async () => {
		trace.push("start2");
		return "r2";
	});

	// p2 не должен был стартовать, пока p1 держит лок.
	assert.deepEqual(trace, ["start1"]);
	gate.resolve();
	const [r1, r2] = await Promise.all([p1, p2]);
	assert.deepEqual(trace, ["start1", "end1", "start2"]);
	assert.equal(r1, "r1");
	assert.equal(r2, "r2");
});

test("withGroupLock: РАЗНЫЕ имена (owner/group) не блокируют друг друга", async () => {
	const trace = [];
	const gate = deferred();

	const p1 = withGroupLock("ownerA", "groupA", async () => {
		trace.push("start1");
		await gate.promise;
		trace.push("end1");
	});
	await Promise.resolve();
	await Promise.resolve();

	// Разный groupId — обязан выполниться немедленно, не дожидаясь p1.
	await withGroupLock("ownerA", "groupB", async () => {
		trace.push("start2-diff-group");
	});
	// Разный ownerPubkey при том же groupId — тоже независим.
	await withGroupLock("ownerB", "groupA", async () => {
		trace.push("start2-diff-owner");
	});

	assert.deepEqual(trace, ["start1", "start2-diff-group", "start2-diff-owner"]);
	gate.resolve();
	await p1;
	assert.deepEqual(trace, ["start1", "start2-diff-group", "start2-diff-owner", "end1"]);
});

test("withGroupLock: исключение из fn пробрасывается наружу, лок освобождается для следующего вызова (не дедлок)", async () => {
	await assert.rejects(
		() => withGroupLock("owner-err", "group-err", async () => {
			throw new Error("крипто-ошибка внутри лока");
		}),
		/крипто-ошибка внутри лока/,
	);
	// Если бы лок не освобождался при исключении — этот вызов зависал бы навсегда.
	const result = await withGroupLock("owner-err", "group-err", async () => "после ошибки");
	assert.equal(result, "после ошибки");
});

test("withGroupLock: fallback (без navigator.locks) тоже сериализует конкурентные вызовы с одним именем", async () => {
	const savedNavigator = globalThis.navigator;
	// Симулирует среду без Web Locks API (L-3, DESIGN.md "Этап 74") — старые
	// jsdom/Node-скрипты. Полностью убираем navigator, а не только .locks —
	// защищает тест от неверного предположения о форме объекта.
	// eslint-disable-next-line no-undef
	delete globalThis.navigator;
	try {
		const trace = [];
		const gate = deferred();
		const p1 = withGroupLock("owner-fb", "group-fb", async () => {
			trace.push("start1");
			await gate.promise;
			trace.push("end1");
		});
		await Promise.resolve();
		await Promise.resolve();
		const p2 = withGroupLock("owner-fb", "group-fb", async () => {
			trace.push("start2");
		});
		assert.deepEqual(trace, ["start1"], "fallback обязан сериализовать так же, как navigator.locks");
		gate.resolve();
		await Promise.all([p1, p2]);
		assert.deepEqual(trace, ["start1", "end1", "start2"]);
	} finally {
		globalThis.navigator = savedNavigator;
	}
});

// --- Интеграционные тесты T2.2/T2.3 через chat.js (после реализации withGroupLock
// применён к receiveGroupMessageEvent/sendMessage) ---

async function establishAliceToBob() {
	const bobKeyPackage = await createOwnKeyPackage(BOB_PUB, "bob-device");
	const fetchDeviceKeyPackages = async () => new Map([["bob-device", { wireBytes: bobKeyPackage.wireBytes, createdAt: 1000 }]]);
	let welcomeGiftWrap;
	const publish = async (event) => {
		if (event.kind === 1059) welcomeGiftWrap = event;
		return { ok: true };
	};
	await ensureChatEstablished(ALICE_PUB, ALICE_PRIV, DB_KEY, BOB_PUB, publish, fetchDeviceKeyPackages);
	const rumor = nip59Unwrap(welcomeGiftWrap, BOB_PRIV);
	const welcomeWireBytes = Uint8Array.from(atob(rumor.content), (c) => c.charCodeAt(0));
	const bobState = await joinFromWelcome(bobKeyPackage, welcomeWireBytes);
	return { groupIdHex: bytesToHex(computeGroupId(ALICE_PUB, BOB_PUB)), bobSerializedState: serializeState(bobState) };
}

test("T2.3: два конкурентных receiveGroupMessageEvent ОДНОГО события — ровно одна обработка, ноль decrypt failures", async () => {
	const { groupIdHex, bobSerializedState } = await establishAliceToBob();
	await db.table("mlsGroups").put(
		toEncryptedRow({ ownerPubkey: BOB_PUB, groupId: groupIdHex, contactPubkey: ALICE_PUB, state: bobSerializedState }, MLS_GROUPS_PLAINTEXT_FIELDS, DB_KEY),
	);

	const published = [];
	const publish = async (event) => {
		published.push(event);
		return { ok: true };
	};
	await sendMessage(ALICE_PUB, ALICE_PRIV, DB_KEY, BOB_PUB, "одно событие", 1, publish);
	const liveEvent = published.find((e) => e.kind === 445);

	// Два "таба" Боба независимо получают то же самое живое 445 — конкурентно,
	// не последовательно (без await между вызовами).
	const [r1, r2] = await Promise.all([
		receiveGroupMessageEvent(BOB_PUB, BOB_PRIV, DB_KEY, liveEvent, async () => ({ ok: true })),
		receiveGroupMessageEvent(BOB_PUB, BOB_PRIV, DB_KEY, liveEvent, async () => ({ ok: true })),
	]);
	const results = [r1, r2].filter((r) => r !== null);
	assert.equal(results.length, 1, "ровно одна обработка применяет эффект, вторая — тихий no-op (дедуп T2.3)");

	const groupRaw = await db.table("mlsGroups").get([BOB_PUB, groupIdHex]);
	const group = fromEncryptedRow(groupRaw, DB_KEY);
	assert.equal(group.consecutiveDecryptFailures ?? 0, 0, "повторная обработка не должна засчитаться как decrypt failure");
});

test("T2.2: конкурентные send (Алиса) + receive (Боб, другое сообщение) — оба успешны, состояние консистентно после", async () => {
	const { groupIdHex, bobSerializedState } = await establishAliceToBob();
	await db.table("mlsGroups").put(
		toEncryptedRow({ ownerPubkey: BOB_PUB, groupId: groupIdHex, contactPubkey: ALICE_PUB, state: bobSerializedState }, MLS_GROUPS_PLAINTEXT_FIELDS, DB_KEY),
	);

	const published = [];
	const publish = async (event) => {
		published.push(event);
		return { ok: true };
	};
	// Алиса отправляет первое сообщение (Боб его ещё не видел).
	await sendMessage(ALICE_PUB, ALICE_PRIV, DB_KEY, BOB_PUB, "первое", 1, publish);
	const firstEvent = published.find((e) => e.kind === 445);
	published.length = 0;

	// Конкурентно: Боб принимает "первое" (свой лок), Алиса шлёт "второе" (её лок,
	// другая пара owner+group — независимые локи, не должны блокировать друг друга).
	const [, sendResult] = await Promise.all([
		receiveGroupMessageEvent(BOB_PUB, BOB_PRIV, DB_KEY, firstEvent, async () => ({ ok: true })),
		sendMessage(ALICE_PUB, ALICE_PRIV, DB_KEY, BOB_PUB, "второе", 2, publish),
	]);
	assert.ok(sendResult.eventId);
	const secondEvent = published.find((e) => e.kind === 445);
	assert.ok(secondEvent);

	// Состояние консистентно: Боб способен расшифровать следующее сообщение Алисы.
	const result = await receiveGroupMessageEvent(BOB_PUB, BOB_PRIV, DB_KEY, secondEvent, async () => ({ ok: true }));
	assert.equal(result.text, "второе");
});

// АДВЕРСАРНАЯ ФАЗА (skill п.19) — прямое воспроизведение того, что реально
// нашла живая проверка 73.6 (DESIGN.md "73.6"/"Этап 74"): два "таба" одной
// identity (Алисы) одновременно узнают об одном и том же новом sibling-
// устройстве и ОБА независимо вызывают syncDeviceMembership — БЕЗ
// внутрипроцессной коалесценции handleDeviceAnnounceInFlight (та защищает
// ТОЛЬКО handleDeviceAnnounce, per-процесс/per-таб — в реальности у двух
// вкладок РАЗНЫЕ JS-процессы с РАЗНЫМИ модульными Map, друг о друге не знают;
// syncDeviceMembership вообще не имеет своей коалесценции). Единственная
// защита от рассыпания группы на два несовместимых branch'а — withGroupLock.
test("АДВЕРСАРНО (73.6): два конкурентных syncDeviceMembership для ОДНОГО нового sibling-устройства — ровно один commit+welcome, группа не расходится", async () => {
	const bobKeyPackage = await createOwnKeyPackage(BOB_PUB, "bob-device");
	const fetchDeviceKeyPackages = async () => new Map([["bob-device", { wireBytes: bobKeyPackage.wireBytes, createdAt: 1000 }]]);
	let welcomeGiftWrap;
	const establishPublish = async (event) => {
		if (event.kind === 1059) welcomeGiftWrap = event;
		return { ok: true };
	};
	await ensureChatEstablished(ALICE_PUB, ALICE_PRIV, DB_KEY, BOB_PUB, establishPublish, fetchDeviceKeyPackages);
	const rumor = nip59Unwrap(welcomeGiftWrap, BOB_PRIV);
	const bobState = await joinFromWelcome(bobKeyPackage, Uint8Array.from(atob(rumor.content), (c) => c.charCodeAt(0)));
	const groupIdHex = bytesToHex(computeGroupId(ALICE_PUB, BOB_PUB));
	await db.table("mlsGroups").put(
		toEncryptedRow({ ownerPubkey: BOB_PUB, groupId: groupIdHex, contactPubkey: ALICE_PUB, state: serializeState(bobState) }, MLS_GROUPS_PLAINTEXT_FIELDS, DB_KEY),
	);

	const siblingKeyPackage = await createOwnKeyPackage(ALICE_PUB, "sibling-1");
	const published = [];
	const publish = async (event) => {
		published.push(event);
		return { ok: true };
	};
	const fetchAnnounces = async () => [{ wireBytes: siblingKeyPackage.wireBytes, deviceId: "sibling-1" }];

	// "Два таба" — оба видят один и тот же анонс, оба реагируют одновременно.
	await Promise.all([
		syncDeviceMembership(ALICE_PUB, ALICE_PRIV, DB_KEY, publish, fetchAnnounces),
		syncDeviceMembership(ALICE_PUB, ALICE_PRIV, DB_KEY, publish, fetchAnnounces),
	]);

	const commits = published.filter((e) => e.kind === 445);
	const welcomes = published.filter((e) => e.kind === 1059);
	assert.equal(commits.length, 1, "ровно один commit — второй конкурент обязан увидеть УЖЕ добавленного сиблинга и не коммитить повторно");
	assert.equal(welcomes.length, 1, "ровно один welcome — не два независимых (иначе Welcome от второго ветвления был бы для несовместимого состояния)");

	// Группа не разошлась: sibling реально присоединяется по (единственному) welcome...
	const welcomeRumor = nip59Unwrap(welcomes[0], ALICE_PRIV);
	const welcomeWireBytes = Uint8Array.from(atob(welcomeRumor.content), (c) => c.charCodeAt(0));
	const siblingState = await joinFromWelcome(siblingKeyPackage, welcomeWireBytes);

	// ...и Боб (существующий участник) реально продвигает эпоху по (единственному) коммиту...
	const { result: commitResult, updatedBobSerializedState } = await asRowResult(BOB_PUB, ALICE_PUB, groupIdHex, serializeState(bobState), () =>
		receiveGroupMessageEvent(BOB_PUB, BOB_PRIV, DB_KEY, commits[0], async () => ({ ok: true })),
	);
	assert.equal(commitResult, null, "коммит — control-сообщение");

	// ...и после этого Алиса (главное устройство) способна отправить сообщение,
	// которое расшифровывает И Боб, И новый sibling — единое непротиворечивое состояние.
	const sendPublished = [];
	await sendMessage(ALICE_PUB, ALICE_PRIV, DB_KEY, BOB_PUB, "после гонки", 1, async (e) => {
		sendPublished.push(e);
		return { ok: true };
	});
	const liveEvent = sendPublished.find((e) => e.kind === 445);

	const { result: byBob } = await asRowResult(BOB_PUB, ALICE_PUB, groupIdHex, updatedBobSerializedState, () =>
		receiveGroupMessageEvent(BOB_PUB, BOB_PRIV, DB_KEY, liveEvent, async () => ({ ok: true })),
	);
	assert.equal(byBob.text, "после гонки", "Боб расшифровывает сообщение ПОСЛЕ гонки — эпоха не расходится");

	const { result: bySibling } = await asRowResult(ALICE_PUB, BOB_PUB, groupIdHex, serializeState(siblingState), () =>
		receiveGroupMessageEvent(ALICE_PUB, ALICE_PRIV, DB_KEY, liveEvent, async () => ({ ok: true })),
	);
	assert.equal(bySibling.text, "после гонки", "sibling (A2) успешно расшифровывает сообщение A1 — состояние не разошлось даже после гонки");
	// T1 (RC-1) + T2 (RC-3) вместе: своё сообщение от A1, увиденное A2, обязано
	// остаться исходящим (senderPubkey===ALICE_PUB), не приписаться Бобу.
	const rows = await getChatHistory(ALICE_PUB, BOB_PUB, DB_KEY);
	const savedRow = rows.find((r) => r.text === "после гонки");
	assert.equal(savedRow.senderPubkey, ALICE_PUB, "RC-1: своё сообщение от sibling-устройства не должно приписаться контакту");
});

async function asRowResult(ownerPubkey, contactPubkey, groupIdHex, serializedState, fn) {
	await db.table("mlsGroups").put(
		toEncryptedRow({ ownerPubkey, groupId: groupIdHex, contactPubkey, state: serializedState }, MLS_GROUPS_PLAINTEXT_FIELDS, DB_KEY),
	);
	await db.table("processedGroupEvents").where("ownerPubkey").equals(ownerPubkey).delete();
	const result = await fn();
	const updatedRaw = await db.table("mlsGroups").get([ownerPubkey, groupIdHex]);
	return { result, updatedBobSerializedState: fromEncryptedRow(updatedRaw, DB_KEY).state };
}
