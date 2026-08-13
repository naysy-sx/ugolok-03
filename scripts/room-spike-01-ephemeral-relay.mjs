#!/usr/bin/env node
// ROOMS-SPEC.md, Этап 0, спайк 0.1 — эфемерные kind на реальном strfry.
//
// Проверяет буквально то, на чём строится вся модель исчезновения комнаты
// (§0/§5.4 ROOMS-SPEC.md): (а) эфемерное событие (kind 20000-29999) реально
// доставляется живым подписчикам через relay; (б) после полного разрыва и
// нового REQ без since — что именно возвращает strfry. Пункт (б) намеренно
// не имеет заранее известного "правильного" ответа — strfry.conf's
// ephemeralEventsLifetimeSeconds=300 документирует, что strfry ДЕРЖИТ
// эфемерные события в памяти какое-то время (не файл, но и не "исчезает
// мгновенно") — скрипт фиксирует РЕАЛЬНОЕ поведение, не гадает.
//
// Если 0.1 проваливается (событие не доставляется живьём вообще) — по
// ROOMS-SPEC.md дальше идти нельзя, вся модель под вопросом.
//
// Использование: node scripts/room-spike-01-ephemeral-relay.mjs [relayUrl]

import { createRelayConnection } from "../src/core/transport/relay-pool.js";
import { createPublisher } from "../src/core/transport/publisher.js";
import { createSubscriber } from "../src/core/transport/subscriber.js";
import { sign } from "../src/core/crypto/sign.js";
import { getPublicKey } from "../src/core/crypto/keys.js";
import { bytesToHex } from "@noble/hashes/utils.js";

const RELAY_URL = process.argv[2] ?? "ws://127.0.0.1:7777";
const TEST_KIND = 29999; // временный, вне диапазона реальных room-kind (ещё не выбраны)

function acceptAllVerify(events) {
	return events.map(() => true);
}

// onStateChange передаётся ОДИН раз при создании соединения (relay-pool.js's
// API не позволяет добавить обработчик позже) — оборачиваем его в изменяемый
// диспетчер, чтобы каждый await waitForState() мог подписаться на следующее
// изменение без пересоздания соединения.
function openConnection(url, label) {
	const listeners = new Set();
	const conn = createRelayConnection(url, {
		onStateChange: (state) => {
			console.log(`[${label}] состояние: ${state}`);
			for (const fn of listeners) fn(state);
		},
	});
	conn.connect();
	function waitForState(predicate, timeoutMs) {
		return new Promise((resolve, reject) => {
			if (predicate(conn.getState())) return resolve();
			const timer = setTimeout(() => {
				listeners.delete(onChange);
				reject(new Error(`[${label}] waitForState: таймаут ${timeoutMs}мс, состояние=${conn.getState()}`));
			}, timeoutMs);
			function onChange(state) {
				if (!predicate(state)) return;
				clearTimeout(timer);
				listeners.delete(onChange);
				resolve();
			}
			listeners.add(onChange);
		});
	}
	return { conn, waitForState };
}

async function main() {
	console.log(`ROOMS spike 0.1 — relay: ${RELAY_URL}, TEST_KIND=${TEST_KIND}\n`);

	const privKey = crypto.getRandomValues(new Uint8Array(32));
	const pubkeyHex = bytesToHex(getPublicKey(privKey));
	console.log(`Эфемерная тестовая identity: ${pubkeyHex}\n`);

	// --- Шаг 1: подписчик A ---
	console.log("--- Шаг 1: соединение A (подписчик) ---");
	const { conn: connA, waitForState: waitA } = openConnection(RELAY_URL, "A");
	await waitA((s) => s === "connected", 8000);

	let receivedLive = null;
	const subA = createSubscriber(connA, {
		verifyBatch: acceptAllVerify,
		onBatch: async (events) => {
			for (const e of events) {
				console.log(`[A] получено событие id=${e.id.slice(0, 12)}… kind=${e.kind}`);
				if (receivedLive === null) receivedLive = { id: e.id, at: Date.now() };
			}
		},
	});
	connA.addMessageHandler(subA.handleMessage);
	subA.subscribe("spike01-a", [{ kinds: [TEST_KIND] }]);
	// Эфемерные kind не имеют backlog — EOSE, если бы мы его слушали, пришёл бы
	// почти мгновенно. Даём relay заведомо достаточное время зарегистрировать REQ.
	await new Promise((r) => setTimeout(r, 500));
	console.log("[A] подписка отправлена, пауза 500мс пройдена\n");

	// --- Шаг 2: издатель B, независимое соединение ---
	console.log("--- Шаг 2: соединение B (издатель), публикация ---");
	const { conn: connB, waitForState: waitB } = openConnection(RELAY_URL, "B");
	await waitB((s) => s === "connected", 8000);
	const pubB = createPublisher(connB);
	connB.addMessageHandler(pubB.handleMessage);

	const testEvent = sign({ kind: TEST_KIND, content: "rooms-spike-0.1", tags: [], created_at: Math.floor(Date.now() / 1000) }, privKey);
	console.log(`[B] публикую event id=${testEvent.id.slice(0, 12)}…`);
	const publishStartedAt = Date.now();
	const publishResult = await pubB.publish(testEvent);
	console.log(`[B] publish() результат: ${JSON.stringify(publishResult)}`);

	// --- Шаг 3: дождаться живой доставки A ---
	console.log("\n--- Шаг 3: ждём живую доставку подписчику A (до 5с) ---");
	const deliveryDeadline = Date.now() + 5000;
	while (receivedLive === null && Date.now() < deliveryDeadline) {
		await new Promise((r) => setTimeout(r, 100));
	}

	const liveDeliveryOk = receivedLive !== null && receivedLive.id === testEvent.id;
	const latencyMs = receivedLive ? receivedLive.at - publishStartedAt : null;
	console.log(liveDeliveryOk ? `РЕЗУЛЬТАТ 0.1a: доставлено живьём, latency=${latencyMs}мс` : "РЕЗУЛЬТАТ 0.1a: НЕ доставлено за 5с — ПРОВАЛ");

	// --- Шаг 4: полный разрыв A, новое соединение C, повторный REQ без since ---
	console.log("\n--- Шаг 4: закрываем A, поднимаем C (симуляция реконнекта), повторный REQ ---");
	connA.close();
	await new Promise((r) => setTimeout(r, 300));

	const { conn: connC, waitForState: waitC } = openConnection(RELAY_URL, "C");
	await waitC((s) => s === "connected", 8000);

	const replayedIds = [];
	const subC = createSubscriber(connC, {
		verifyBatch: acceptAllVerify,
		onBatch: async (events) => {
			for (const e of events) {
				console.log(`[C] (replay-check) получено событие id=${e.id.slice(0, 12)}… kind=${e.kind}`);
				replayedIds.push(e.id);
			}
		},
	});
	connC.addMessageHandler(subC.handleMessage);
	subC.subscribe("spike01-c", [{ kinds: [TEST_KIND] }]);
	await new Promise((r) => setTimeout(r, 2000)); // дать время на возможный backlog-ответ

	const sameEventReplayed = replayedIds.includes(testEvent.id);
	console.log(
		replayedIds.length === 0
			? "РЕЗУЛЬТАТ 0.1b: после реконнекта REQ вернул ПУСТО — strfry не отдаёт эфемерные события заново вне окна живых подписчиков"
			: `РЕЗУЛЬТАТ 0.1b: после реконнекта REQ вернул ${replayedIds.length} событие(й) (наше событие ${sameEventReplayed ? "" : "НЕ "}среди них) — strfry временно кэширует эфемерные kind (см. ephemeralEventsLifetimeSeconds=300 в strfry.conf)`,
	);

	connB.close();
	connC.close();

	console.log("\n=== ИТОГ СПАЙКА 0.1 ===");
	console.log(`Живая доставка: ${liveDeliveryOk ? "OK" : "ПРОВАЛ"}${latencyMs !== null ? ` (${latencyMs}мс)` : ""}`);
	console.log(`Поведение после реконнекта: ${replayedIds.length === 0 ? "пусто (немедленное исчезновение)" : `${replayedIds.length} событие(й) всё ещё видно (временное кэширование relay)`}`);

	if (!liveDeliveryOk) {
		console.error("\nСПАЙК 0.1 ПРОВАЛЕН — живая доставка эфемерных kind не работает. По ROOMS-SPEC.md дальше идти нельзя.");
		process.exit(1);
	}
	process.exit(0);
}

main().catch((e) => {
	console.error("СПАЙК 0.1 упал с ошибкой:", e);
	process.exit(1);
});
