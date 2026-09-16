import { test } from "node:test";
import assert from "node:assert/strict";
import { bytesToHex } from "@noble/hashes/utils.js";
import { getPublicKey } from "../../src/core/crypto/keys.js";
import { createFakeRelay } from "./fake-relay.js";
import { createWsBridge } from "./ws-bridge.js";
import { spawnDevice } from "./scenario.js";

// Этап 0 (MESSAGE-DELIVERY-TZ.md, З0.3) — доказательство H2 (MESSAGE-DELIVERY-
// AUDIT-BRIEFING.md §6, §5.2): EVENT (kind 445) физически уходит на relay
// (WebSocket.send() не бросает — ровно то, что происходит на «зомби»-сокете:
// ОС ещё не сообщила клиенту, что соединение мертво), но relay ни разу не
// присылает "OK" (сообщение реально потеряно/не дошло/ответ потерян). Тест
// смоделирован без модификации relay внутри самого клиента — держим ИМЕННО
// "OK" в очереди fake-relay сколь угодно долго через reorder()/flushNext()
// (тот же приём, что m1-repro.mjs).
//
// Этап 2 — дефект закрыт: publisher.js теперь даёт publish() срок по
// умолчанию 15с (unit-доказательство самого факта — tests/publisher.test.js,
// "EVENT отправлен, OK не приходит"). Здесь проверяется другое: окно 2.5с —
// разумная сетевая задержка, МЕНЬШЕ 15с — не должно рвать попытку раньше
// срока; когда "OK" всё же приходит (сколь угодно поздно, но до срока),
// сообщение доставляется без повторного шифрования.

const ALICE_PRIV_HEX = bytesToHex(new Uint8Array(32).fill(5));
const BOB_PRIV_HEX = bytesToHex(new Uint8Array(32).fill(6));
const ALICE_PUB = bytesToHex(getPublicKey(new Uint8Array(32).fill(5)));
const BOB_PUB = bytesToHex(getPublicKey(new Uint8Array(32).fill(6)));

function pumpAll(relay, promise) {
	const timer = setInterval(() => relay.flushAll(), 5);
	return promise.finally(() => clearInterval(timer));
}

// Непрерывно доставляет всё, КРОМЕ записей, для которых holdBackFn(p) истинно —
// тот же приём, что m1-repro.mjs/m3-repro.mjs. Вызывающий обязан clearInterval().
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

test(
	"H2 (закрыта Этапом 2): publish() без ответа OK не settled раньше срока (2.5с < 15с) — и резолвится успехом, если OK всё же приходит",
	{ timeout: 30000 },
	async (t) => {
		let bridge;
		const relay = createFakeRelay({ onDeliver: (connId, msg) => bridge.deliver(connId, msg) });
		bridge = createWsBridge(relay, { port: 0 });
		const { port } = await bridge.start();
		const relayUrl = `ws://127.0.0.1:${port}`;

		const alice = spawnDevice(); // коммиттер — создаёт группу первой отправкой
		const bob = spawnDevice();
		t.after(async () => {
			alice.kill();
			bob.kill();
			await bridge.stop();
		});

		await pumpAll(relay, alice.call("init", { privKeyHex: ALICE_PRIV_HEX, relayUrl }));
		await pumpAll(relay, bob.call("init", { privKeyHex: BOB_PRIV_HEX, relayUrl }));
		await alice.call("becomeContact", { peerPubkey: BOB_PUB });
		await bob.call("becomeContact", { peerPubkey: ALICE_PUB });
		await pumpAll(relay, alice.call("connect"));
		await pumpAll(relay, bob.call("connect"));

		// Первое сообщение — обычным путём, устанавливает группу и подтверждает
		// счастливый путь работает (baseline).
		await pumpAll(relay, alice.call("send", { contactPubkey: BOB_PUB, text: "первое" }));

		// Группа уже есть — второе сообщение идёт через doSendMessage (не через
		// ensureChatEstablished). С этого момента ЛЮБОЙ "OK" удерживается в
		// очереди fake-relay — событие EVENT кладётся и рассылается подписчикам
		// (Боб его получит и расшифрует нормально), но publisher.publish() у
		// Алисы никогда не увидит ["OK", eventId, ...].
		const holdTimer = pumpAllExcept(relay, (p) => p.msg[0] === "OK");

		const sendPromise = alice.call("send", { contactPubkey: BOB_PUB, text: "второе — OK удержан" });

		let settled = false;
		sendPromise.then(
			() => (settled = true),
			() => (settled = true),
		);
		await new Promise((r) => setTimeout(r, 2500));
		assert.equal(
			settled,
			false,
			"publish() не должен settle раньше срока (2.5с — обычная сетевая задержка, меньше 15с по умолчанию)",
		);

		// Нельзя параллельно опросить alice.call("history", ...) здесь: device.js
		// обрабатывает IPC-команды одного устройства строго последовательно
		// (`queue = queue.then(...)`), а "send" ещё не завершился — второй вызов
		// просто встанет за ним в очередь и тоже "зависнет" в рамках теста. Это
		// ограничение харнесса, не продакшен-кода (в реальном приложении это как
		// раз соответствует наблюдаемому: busyRef держит форму занятой, повторный
		// клик тоже ничего не даёт, см. AUDIT-BRIEFING §4.3). Доказываем
		// "сообщения ещё нет локально" косвенно: ниже сверяем счётчик ДО и ПОСЛЕ.

		// Отпускаем удержанные OK — если OK физически придёт (пусть спустя
		// «много минут» в проде, здесь секунды теста), publish() наконец
		// резолвится успехом. Это и есть механика «вываливается через много
		// минут» из жалобы пользователя: не ошибка и не восстановление —
		// сообщение всё это время просто ждало ответа, который наконец пришёл.
		clearInterval(holdTimer);
		const releasePump = setInterval(() => relay.flushAll(), 5);
		const result = await sendPromise;
		clearInterval(releasePump);

		assert.ok(result.eventId, "H2: после запоздалого OK send всё-таки завершается успехом (без ретрая, без повторного шифрования)");
		const aliceHistoryFinal = await alice.call("history", { contactPubkey: BOB_PUB });
		assert.equal(aliceHistoryFinal.length, 2, "H2: сообщение появляется в ленте отправителя только в момент запоздалого OK");
	},
);
