import { test } from "node:test";
import assert from "node:assert/strict";
import { reduce, reconcileList } from "../src/domain/contacts/contact-fsm.js";

// Этап 49 — CONTACTS-FSM.md, §4 (тест-спека). Табличные тесты: строка =
// (peerState_in, event) ⇒ (peerState_out, commands). Нет polite/impolite
// тайбрейкера (в отличие от звонка) — crossed-requests (I3) разрешается
// симметрично для обеих сторон без сравнения pubkey.

const ALICE = "alice-pubkey";
const BOB = "bob-pubkey";

function none(peer) {
	return { name: "NONE", peerPubkey: peer, resolvedAt: 0, greeting: null };
}
function withState(name, peer, extra = {}) {
	return { name, peerPubkey: peer, resolvedAt: 0, greeting: null, ...extra };
}
function names(commands) {
	return commands.map((c) => c.type);
}
function findCmd(commands, type) {
	return commands.find((c) => c.type === type);
}

// --- 1. Happy sender ---
test("happy sender: NONE -> USER_SEND_REQUEST -> OUTGOING_PENDING -> REMOTE_ACCEPT -> CONTACT", () => {
	let s = none(BOB);
	let r = reduce(s, { type: "USER_SEND_REQUEST", peer: BOB, greeting: "привет" });
	assert.equal(r.state.name, "OUTGOING_PENDING");
	assert.deepEqual(names(r.commands), ["PUBLISH_REQUEST", "UPSERT", "EMIT"]);
	assert.deepEqual(findCmd(r.commands, "PUBLISH_REQUEST"), { type: "PUBLISH_REQUEST", peer: BOB, greeting: "привет" });
	s = r.state;

	r = reduce(s, { type: "REMOTE_ACCEPT", peer: BOB, createdAt: 1000 });
	assert.equal(r.state.name, "CONTACT");
	assert.equal(r.state.resolvedAt, 1000);
	assert.deepEqual(names(r.commands), ["UPDATE_CONTACTS_LIST", "UPSERT", "LOG_JOURNAL", "EMIT"]);
	assert.deepEqual(findCmd(r.commands, "UPDATE_CONTACTS_LIST"), { type: "UPDATE_CONTACTS_LIST", peer: BOB, action: "add" });
});

// --- 2. Happy receiver ---
test("happy receiver: NONE -> REMOTE_REQUEST -> INCOMING_PENDING -> USER_ACCEPT -> CONTACT", () => {
	let s = none(ALICE);
	let r = reduce(s, { type: "REMOTE_REQUEST", peer: ALICE, greeting: "хай", createdAt: 500 });
	assert.equal(r.state.name, "INCOMING_PENDING");
	assert.equal(r.state.resolvedAt, 0, "resolvedAt НЕ трогаем при переходе в *_PENDING");
	assert.equal(r.state.greeting, "хай");
	s = r.state;

	r = reduce(s, { type: "USER_ACCEPT", peer: ALICE });
	assert.equal(r.state.name, "CONTACT");
	assert.deepEqual(names(r.commands), ["PUBLISH_ACCEPT", "UPDATE_CONTACTS_LIST", "UPSERT", "EMIT"]);
	assert.deepEqual(findCmd(r.commands, "PUBLISH_ACCEPT"), { type: "PUBLISH_ACCEPT", peer: ALICE });
});

// --- 3. Отказ, сторона отправителя ---
test("отказ (отправитель): OUTGOING_PENDING -> REMOTE_REJECT -> NONE, LOG_JOURNAL присутствует", () => {
	const s = withState("OUTGOING_PENDING", BOB, { resolvedAt: 0 });
	const r = reduce(s, { type: "REMOTE_REJECT", peer: BOB, createdAt: 2000 });
	assert.equal(r.state.name, "NONE");
	assert.ok(names(r.commands).includes("LOG_JOURNAL"));
	assert.ok(names(r.commands).includes("DELETE"));
});

// --- 4. Отказ, сторона получателя ---
test("отказ (получатель): INCOMING_PENDING -> USER_REJECT -> REJECTED_BY_ME, PUBLISH_REJECT", () => {
	const s = withState("INCOMING_PENDING", ALICE, { greeting: "хай" });
	const r = reduce(s, { type: "USER_REJECT", peer: ALICE });
	assert.equal(r.state.name, "REJECTED_BY_ME");
	assert.deepEqual(findCmd(r.commands, "PUBLISH_REJECT"), { type: "PUBLISH_REJECT", peer: ALICE });
});

// --- 5. Отмена ---
test("отмена (отправитель): OUTGOING_PENDING -> USER_CANCEL -> NONE, PUBLISH_CANCEL", () => {
	const s = withState("OUTGOING_PENDING", BOB);
	const r = reduce(s, { type: "USER_CANCEL", peer: BOB });
	assert.equal(r.state.name, "NONE");
	assert.deepEqual(findCmd(r.commands, "PUBLISH_CANCEL"), { type: "PUBLISH_CANCEL", peer: BOB });
});

test("отмена (получатель видит REMOTE_CANCEL свежий): INCOMING_PENDING -> NONE", () => {
	const s = withState("INCOMING_PENDING", ALICE, { resolvedAt: 0 });
	const r = reduce(s, { type: "REMOTE_CANCEL", peer: ALICE, createdAt: 100 });
	assert.equal(r.state.name, "NONE");
});

// --- 6. I1: redelivery старого REMOTE_ACCEPT ---
test("I1: CONTACT (resolvedAt=1000) + REMOTE_ACCEPT(createdAt=500, старее) -> состояние НЕ меняется, команды пустые", () => {
	const s = withState("CONTACT", BOB, { resolvedAt: 1000 });
	const r = reduce(s, { type: "REMOTE_ACCEPT", peer: BOB, createdAt: 500 });
	assert.deepEqual(r.state, s);
	assert.deepEqual(r.commands, []);
});

// --- 7. I2: ГЛАВНЫЙ регресс-тест бага пользователя ---
test("I2 (ГЛАВНЫЙ регресс-тест): CONTACT + REMOTE_REQUEST(ЛЮБОЙ createdAt, даже далёкое будущее) -> остаёмся CONTACT, никакой заявки не создаётся", () => {
	const s = withState("CONTACT", BOB, { resolvedAt: 1000 });
	const farFuture = 99999999999;
	const r = reduce(s, { type: "REMOTE_REQUEST", peer: BOB, greeting: "снова привет", createdAt: farFuture });
	assert.equal(r.state.name, "CONTACT", "уже принятый контакт НЕ должен снова попасть во входящие");
	assert.deepEqual(r.state, s);
	assert.deepEqual(r.commands, []);
});

// --- 8. I2: sticky BLOCKED ---
test("I2: BLOCKED + REMOTE_REQUEST(любой createdAt, даже очень свежий) -> остаёмся BLOCKED", () => {
	const s = withState("BLOCKED", BOB, { resolvedAt: 1000 });
	const r = reduce(s, { type: "REMOTE_REQUEST", peer: BOB, greeting: "x", createdAt: 99999999999 });
	assert.deepEqual(r.state, s);
	assert.deepEqual(r.commands, []);
});

// --- 9. I3: crossed-requests ---
test("I3, crossed-requests: OUTGOING_PENDING + REMOTE_REQUEST(от того же peer) -> CONTACT напрямую, БЕЗ PUBLISH_ACCEPT", () => {
	const s = withState("OUTGOING_PENDING", BOB, { resolvedAt: 0 });
	const r = reduce(s, { type: "REMOTE_REQUEST", peer: BOB, greeting: "и я тебе писал!", createdAt: 3000 });
	assert.equal(r.state.name, "CONTACT");
	assert.equal(r.state.resolvedAt, 3000);
	assert.ok(!names(r.commands).includes("PUBLISH_ACCEPT"), "crossed-requests не требует явного accept — симметрично разрешается на обеих сторонах");
	assert.ok(names(r.commands).includes("UPDATE_CONTACTS_LIST"));
});

// --- 10. I4: send-while-incoming = accept ---
test("I4: INCOMING_PENDING + USER_SEND_REQUEST -> тот же результат, что USER_ACCEPT", () => {
	const s = withState("INCOMING_PENDING", ALICE, { greeting: "хай" });
	const viaSend = reduce(s, { type: "USER_SEND_REQUEST", peer: ALICE, greeting: "добавляю в контакты" });
	const viaAccept = reduce(s, { type: "USER_ACCEPT", peer: ALICE });
	assert.equal(viaSend.state.name, "CONTACT");
	assert.deepEqual(viaSend.state, viaAccept.state);
	assert.ok(names(viaSend.commands).includes("PUBLISH_ACCEPT"), "I4 публикует ACCEPT, не REQUEST — семантически это принятие");
});

// --- 11. I6: переоткрытие REJECTED_BY_ME ---
test("I6: REJECTED_BY_ME(resolvedAt=1000) + REMOTE_REQUEST(createdAt=2000, свежий) -> INCOMING_PENDING", () => {
	const s = withState("REJECTED_BY_ME", ALICE, { resolvedAt: 1000 });
	const r = reduce(s, { type: "REMOTE_REQUEST", peer: ALICE, greeting: "передумал?", createdAt: 2000 });
	assert.equal(r.state.name, "INCOMING_PENDING");
	assert.equal(r.state.greeting, "передумал?");
});

test("I6 обратный: REJECTED_BY_ME(resolvedAt=1000) + REMOTE_REQUEST(createdAt=500, старая) -> игнор, остаёмся REJECTED_BY_ME", () => {
	const s = withState("REJECTED_BY_ME", ALICE, { resolvedAt: 1000 });
	const r = reduce(s, { type: "REMOTE_REQUEST", peer: ALICE, greeting: "x", createdAt: 500 });
	assert.deepEqual(r.state, s);
	assert.deepEqual(r.commands, []);
});

// --- 12. I5: тотальность ---
test("I5: случайное неописанное событие в NONE -> без изменений", () => {
	const s = none(BOB);
	const r = reduce(s, { type: "СОВЕРШЕННО_СЛУЧАЙНОЕ_СОБЫТИЕ", peer: BOB });
	assert.deepEqual(r.state, s);
	assert.deepEqual(r.commands, []);
});

test("I5: REMOTE_ACCEPT в NONE (нет исходящей заявки) -> игнор", () => {
	const s = none(BOB);
	const r = reduce(s, { type: "REMOTE_ACCEPT", peer: BOB, createdAt: 100 });
	assert.deepEqual(r.state, s);
	assert.deepEqual(r.commands, []);
});

test("I5: REMOTE_ACCEPT/REJECT/CANCEL в CONTACT -> игнор (нет активной исходящей заявки)", () => {
	const s = withState("CONTACT", BOB, { resolvedAt: 1000 });
	for (const type of ["REMOTE_ACCEPT", "REMOTE_REJECT", "REMOTE_CANCEL"]) {
		const r = reduce(s, { type, peer: BOB, createdAt: 99999999999 });
		assert.deepEqual(r.state, s, `${type} не должен менять CONTACT`);
		assert.deepEqual(r.commands, []);
	}
});

// --- 13. Разблокировка ---
test("разблокировка: BLOCKED -> USER_UNBLOCK -> NONE", () => {
	const s = withState("BLOCKED", BOB, { resolvedAt: 1000 });
	const r = reduce(s, { type: "USER_UNBLOCK", peer: BOB });
	assert.equal(r.state.name, "NONE");
	assert.deepEqual(findCmd(r.commands, "UPDATE_MUTE_LIST"), { type: "UPDATE_MUTE_LIST", peer: BOB, action: "remove" });
});

// --- 14. Удаление контакта ---
test("удаление контакта: CONTACT -> USER_REMOVE_CONTACT -> NONE, resolvedAt обновлён", () => {
	const s = withState("CONTACT", BOB, { resolvedAt: 1000 });
	const r = reduce(s, { type: "USER_REMOVE_CONTACT", peer: BOB });
	assert.equal(r.state.name, "NONE");
	assert.ok(r.state.resolvedAt > 1000, "resolvedAt обязан обновиться (защита от немедленного redelivery-баунса)");
	assert.deepEqual(findCmd(r.commands, "UPDATE_CONTACTS_LIST"), { type: "UPDATE_CONTACTS_LIST", peer: BOB, action: "remove" });
});

// --- Доп. переходы: USER_BLOCK из разных состояний ---
test("USER_BLOCK из OUTGOING_PENDING -> BLOCKED, PUBLISH_CANCEL (вежливо отозвать заявку)", () => {
	const s = withState("OUTGOING_PENDING", BOB);
	const r = reduce(s, { type: "USER_BLOCK", peer: BOB });
	assert.equal(r.state.name, "BLOCKED");
	assert.ok(names(r.commands).includes("PUBLISH_CANCEL"));
	assert.ok(names(r.commands).includes("UPDATE_MUTE_LIST"));
});

test("USER_BLOCK из INCOMING_PENDING -> BLOCKED", () => {
	const s = withState("INCOMING_PENDING", ALICE, { greeting: "x" });
	const r = reduce(s, { type: "USER_BLOCK", peer: ALICE });
	assert.equal(r.state.name, "BLOCKED");
});

test("USER_BLOCK из CONTACT -> BLOCKED, УБИРАЕТ из контактов И добавляет в мьют", () => {
	const s = withState("CONTACT", BOB, { resolvedAt: 1000 });
	const r = reduce(s, { type: "USER_BLOCK", peer: BOB });
	assert.equal(r.state.name, "BLOCKED");
	assert.deepEqual(findCmd(r.commands, "UPDATE_CONTACTS_LIST"), { type: "UPDATE_CONTACTS_LIST", peer: BOB, action: "remove" });
	assert.deepEqual(findCmd(r.commands, "UPDATE_MUTE_LIST"), { type: "UPDATE_MUTE_LIST", peer: BOB, action: "add" });
});

test("USER_BLOCK из REJECTED_BY_ME -> BLOCKED", () => {
	const s = withState("REJECTED_BY_ME", ALICE, { resolvedAt: 500 });
	const r = reduce(s, { type: "USER_BLOCK", peer: ALICE });
	assert.equal(r.state.name, "BLOCKED");
});

test("USER_SEND_REQUEST из REJECTED_BY_ME -> OUTGOING_PENDING (независимое действие — я решил написать тому, кто отклонил мою заявку)", () => {
	const s = withState("REJECTED_BY_ME", ALICE, { resolvedAt: 500 });
	const r = reduce(s, { type: "USER_SEND_REQUEST", peer: ALICE, greeting: "привет!" });
	assert.equal(r.state.name, "OUTGOING_PENDING");
	assert.deepEqual(findCmd(r.commands, "PUBLISH_REQUEST"), { type: "PUBLISH_REQUEST", peer: ALICE, greeting: "привет!" });
});

// --- Форма команд (без двусмысленности для воркера) ---
test("форма команд: EMIT несёт peer и stateName", () => {
	const s = none(BOB);
	const r = reduce(s, { type: "USER_SEND_REQUEST", peer: BOB, greeting: "x" });
	assert.deepEqual(findCmd(r.commands, "EMIT"), { type: "EMIT", peer: BOB, stateName: "OUTGOING_PENDING" });
});

test("форма команд: LOG_JOURNAL несёт entry с peer и message", () => {
	const s = withState("OUTGOING_PENDING", BOB);
	const r = reduce(s, { type: "REMOTE_ACCEPT", peer: BOB, createdAt: 1000 });
	const logCmd = findCmd(r.commands, "LOG_JOURNAL");
	assert.ok(logCmd, "LOG_JOURNAL обязан присутствовать при разрешении заявки принятием");
	assert.equal(logCmd.entry.peer, BOB);
	assert.equal(typeof logCmd.entry.message, "string");
});

// --- reconcileList (§1.6 — синхронизация между СВОИМИ устройствами) ---

test("reconcileList: новый CONTACT с другого устройства (peer появился в списке, локально NONE)", () => {
	const relationships = new Map();
	const r = reconcileList(relationships, "contacts", new Set([BOB]), 5000);
	assert.equal(r.relationships.get(BOB).name, "CONTACT");
	assert.equal(r.relationships.get(BOB).resolvedAt, 5000);
	assert.ok(r.commands.some((c) => c.type === "UPSERT" && c.peer === BOB));
});

test("reconcileList: контакт удалён с другого устройства (peer пропал из списка)", () => {
	const relationships = new Map([[BOB, withState("CONTACT", BOB, { resolvedAt: 1000 })]]);
	const r = reconcileList(relationships, "contacts", new Set(), 2000);
	assert.equal(r.relationships.get(BOB).name, "NONE");
});

test("reconcileList, I1 против отката: локальное решение НОВЕЕ списка -> не откатываем", () => {
	const relationships = new Map([[BOB, withState("CONTACT", BOB, { resolvedAt: 5000 })]]);
	const r = reconcileList(relationships, "contacts", new Set(), 1000); // список старее
	assert.equal(r.relationships.get(BOB).name, "CONTACT", "список старее локального решения — не откатываем");
});

test("reconcileList не трогает peer'ов, не относящихся к этому listKind", () => {
	const relationships = new Map([
		[ALICE, withState("BLOCKED", ALICE, { resolvedAt: 1000 })],
		[BOB, withState("OUTGOING_PENDING", BOB)],
	]);
	const r = reconcileList(relationships, "contacts", new Set(["someone-else"]), 5000);
	assert.deepEqual(r.relationships.get(ALICE), relationships.get(ALICE), "BLOCKED (другой listKind) не тронут");
	assert.deepEqual(r.relationships.get(BOB), relationships.get(BOB), "OUTGOING_PENDING (не sticky-состояние этого listKind) не тронут");
});

test("reconcileList: mute-список (BLOCKED) работает симметрично contacts", () => {
	const relationships = new Map();
	const r = reconcileList(relationships, "mute", new Set([BOB]), 3000);
	assert.equal(r.relationships.get(BOB).name, "BLOCKED");
});

// --- Адверсарно: reduce не мутирует замороженный вход ---
test("адверсарно: reduce не мутирует замороженный peerState", () => {
	const scenarios = [
		[Object.freeze(none(BOB)), { type: "USER_SEND_REQUEST", peer: BOB, greeting: "x" }],
		[Object.freeze(withState("OUTGOING_PENDING", BOB)), { type: "REMOTE_ACCEPT", peer: BOB, createdAt: 100 }],
		[Object.freeze(withState("CONTACT", BOB, { resolvedAt: 1000 })), { type: "REMOTE_REQUEST", peer: BOB, greeting: "x", createdAt: 99999 }],
		[Object.freeze(none(BOB)), { type: "МУСОР" }],
	];
	for (const [s, event] of scenarios) {
		assert.doesNotThrow(() => reduce(s, event));
	}
});
