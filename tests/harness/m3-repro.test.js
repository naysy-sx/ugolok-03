import { test } from "node:test";
import assert from "node:assert/strict";
import { bytesToHex } from "@noble/hashes/utils.js";
import { getPublicKey } from "../../src/core/crypto/keys.js";
import { createFakeRelay } from "./fake-relay.js";
import { createWsBridge } from "./ws-bridge.js";
import { spawnDevice } from "./scenario.js";

// М3 (DESIGN.md/PLAN.md "Этап 73.4"): relay не гарантирует порядок доставки —
// kind:445, продвигающий эпоху (control-commit), может прийти ПОСЛЕ события,
// которое от этой эпохи зависит. Сценарий: А1<->Боб уже разговаривают; А2
// (второе устройство Алисы) присоединяется как sibling — А1 публикует ДВА
// события: commit (kind:445, продвигает эпоху Боба) и Welcome (kind:1059, к
// А2). Держим ИМЕННО commit придержанным для Боба, пока А2 (уже приняв
// Welcome) шлёт Бобу сообщение ПОД НОВОЙ эпохой — Боб получает сообщение
// РАНЬШЕ commit'а, не может расшифровать (буферизуется), затем получает
// commit — М3 обязан ретраить буфер и восстановить сообщение без ручного
// вмешательства.

const ALICE_PRIV_HEX = bytesToHex(new Uint8Array(32).fill(7));
const BOB_PRIV_HEX = bytesToHex(new Uint8Array(32).fill(8));
const ALICE_PUB = bytesToHex(getPublicKey(new Uint8Array(32).fill(7)));
const BOB_PUB = bytesToHex(getPublicKey(new Uint8Array(32).fill(8)));

function pumpAll(relay, promise) {
	const timer = setInterval(() => relay.flushAll(), 5);
	return promise.finally(() => clearInterval(timer));
}

async function identifyNewConnId(relay, triggerFn) {
	const before = new Set(relay.pending().map((p) => p.connId));
	const resultPromise = triggerFn();
	let connId = null;
	const deadline = Date.now() + 5000;
	while (!connId && Date.now() < deadline) {
		for (const p of relay.pending()) {
			if (!before.has(p.connId)) {
				connId = p.connId;
				break;
			}
		}
		if (!connId) await new Promise((r) => setTimeout(r, 2));
	}
	if (!connId) throw new Error("identifyNewConnId: новый connId не появился");
	await pumpAll(relay, resultPromise);
	return connId;
}

function pumpAllExcept(relay, holdBackFn) {
	return setInterval(() => {
		while (relay.pending().some((p) => !holdBackFn(p))) {
			relay.reorder((a, b) => {
				const aHeld = holdBackFn(a);
				const bHeld = holdBackFn(b);
				if (aHeld === bHeld) return 0;
				return aHeld ? 1 : -1;
			});
			relay.flushNext();
		}
	}, 3);
}

async function waitForHistory(bob, minLength, timeoutMs = 10000) {
	const deadline = Date.now() + timeoutMs;
	let history = [];
	while (Date.now() < deadline) {
		history = await bob.call("history", { contactPubkey: ALICE_PUB });
		if (history.length >= minLength) break;
		await new Promise((r) => setTimeout(r, 100));
	}
	return history;
}

test("М3: сообщение из новой эпохи приходит Бобу РАНЬШЕ продвигающего её commit'а — буферизуется и восстанавливается без ручного вмешательства", { timeout: 30000 }, async (t) => {
	let bridge;
	const relay = createFakeRelay({ onDeliver: (connId, msg) => bridge.deliver(connId, msg) });
	bridge = createWsBridge(relay, { port: 0 });
	const { port } = await bridge.start();
	const relayUrl = `ws://127.0.0.1:${port}`;

	const bob = spawnDevice();
	const aliceA1 = spawnDevice();
	const aliceA2 = spawnDevice();
	t.after(async () => {
		bob.kill();
		aliceA1.kill();
		aliceA2.kill();
		await bridge.stop();
	});

	// Базовая линия: А1<->Боб штатно (доказанный 73.2 путь).
	await bob.call("init", { privKeyHex: BOB_PRIV_HEX, relayUrl });
	await pumpAll(relay, aliceA1.call("init", { privKeyHex: ALICE_PRIV_HEX, relayUrl }));
	await bob.call("becomeContact", { peerPubkey: ALICE_PUB });
	await aliceA1.call("becomeContact", { peerPubkey: BOB_PUB });

	const bobConnId = await identifyNewConnId(relay, () => bob.call("connect"));
	await pumpAll(relay, aliceA1.call("connect"));
	await pumpAll(relay, aliceA1.call("send", { contactPubkey: BOB_PUB, text: "hello от A1" }));

	const baseline = await waitForHistory(bob, 1);
	assert.equal(baseline.length, 1, "базовая линия: Боб видит сообщение A1");

	// Придерживаем ИМЕННО первое новое kind:445-событие, адресованное Бобу
	// (это будет sibling-add commit от А1, публикуемый реактивно на announce
	// А2 ниже) — ЛЮБОЕ последующее kind:445-событие Бобу (другой event.id —
	// это будет сообщение А2) проходит свободно. Реордеринг здесь — ПРЯМАЯ
	// адверсарная цель этого теста (fake-relay.js's reorder()+flushNext()
	// по контракту).
	let heldCommitId = null;
	const holdTimer = pumpAllExcept(relay, (p) => {
		if (p.connId !== bobConnId || p.msg[0] !== "EVENT" || p.msg[2]?.kind !== 445) return false;
		if (heldCommitId === null) {
			heldCommitId = p.msg[2].id;
			return true;
		}
		return p.msg[2].id === heldCommitId;
	});
	// Регистрируется СРАЗУ после создания таймера (не в конце функции) —
	// иначе провал ЛЮБОГО assert между этой точкой и "нормальной" очисткой
	// ниже оставил бы holdTimer тикать вечно (setInterval не даёт процессу
	// завершиться) — найдено этим же тестом на первом прогоне: сообщение
	// "process didn't exit" вместо понятного assertion-фейла.
	t.after(() => clearInterval(holdTimer));

	// А2 — второе устройство ТОЙ ЖЕ Алисы. connect() триггерит на стороне А1
	// (уже онлайн) реактивный sibling-add: commit (придержан для Боба выше) +
	// Welcome (доходит до А2 свободно, другой connId).
	await aliceA2.call("init", { privKeyHex: ALICE_PRIV_HEX, relayUrl });
	await aliceA2.call("becomeContact", { peerPubkey: BOB_PUB });
	await aliceA2.call("connect");

	// connect() резолвится, как только А2's СОБСТВЕННЫЙ bootstrap закончен —
	// НЕ гарантирует, что А1 уже успела отреагировать на announce А2 и что
	// А2 уже успела принять Welcome (это асинхронно, с другой стороны).
	// НЕ повторяем send() в цикле опроса — второй вызов после того, как
	// группа уже появилась (drainPendingOutgoingMessages уже мог отправить
	// первую попытку САМ), создал бы ВТОРОЕ реальное сообщение — ждём
	// фиксированную паузу (эмпирически достаточную по m1-repro.test.js) и
	// вызываем send() РОВНО ОДИН раз.
	await new Promise((r) => setTimeout(r, 3000));
	const sendResult = await aliceA2.call("send", { contactPubkey: BOB_PUB, text: "from A2 после join" });
	assert.equal(sendResult.status, undefined, "А2 обязана стать полноправным участником группы (sibling-Welcome от А1) и отправить напрямую, не через очередь И3/И4");

	// Боб получил сообщение А2 РАНЬШЕ commit'а — расшифровка обязана
	// провалиться (неверная/старая эпоха), событие уходит в буфер М3, а НЕ
	// теряется навсегда. Видимых сообщений всё ещё 1.
	await new Promise((r) => setTimeout(r, 300));
	const duringReorder = await bob.call("history", { contactPubkey: ALICE_PUB });
	assert.equal(duringReorder.length, 1, "пока commit придержан: Боб пока не видит сообщение A2 (буферизовано, не потеряно)");

	// Отпускаем commit — М3 обязан САМ, БЕЗ дополнительного триггера извне,
	// ретраить буфер сразу после успешной обработки commit'а этой же группы.
	clearInterval(holdTimer);
	const releaseTimer = setInterval(() => relay.flushAll(), 5);
	const final = await waitForHistory(bob, 2, 15000);
	clearInterval(releaseTimer);

	assert.equal(final.length, 2, "М3: сообщение A2 должно восстановиться из буфера сразу после доставки commit'а, без ручного вмешательства");
	assert.deepEqual(
		final.map((m) => m.text).sort(),
		["from A2 после join", "hello от A1"],
	);
});
