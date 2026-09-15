import { test } from "node:test";
import assert from "node:assert/strict";
import { bytesToHex } from "@noble/hashes/utils.js";
import { getPublicKey } from "../../src/core/crypto/keys.js";
import { createFakeRelay } from "./fake-relay.js";
import { createWsBridge } from "./ws-bridge.js";
import { spawnDevice } from "./scenario.js";

// Этап 0 (MESSAGE-DELIVERY-TZ.md, З0.3) — доказательство H1 (MESSAGE-DELIVERY-
// AUDIT-BRIEFING.md §6): не-коммиттер отправляет первым, коммиттер молчит —
// сообщение НЕ появляется у получателя НИКОГДА, пока коммиттер сам не
// напишет (никакого таймера/сигнала на проводе нет — §4.5/§5.8 брифа). Когда
// коммиттер наконец пишет, drain доставляет ОБА сообщения разом — это и есть
// «вываливается через много минут» из жалобы пользователя, штатным кодом,
// без искусственной задержки сети/relay.
//
// ALICE_PRIV_HEX/BOB_PRIV_HEX — те же значения, что tests/harness/m1-repro.mjs
// (fill(5)/fill(6)): там Алиса успешно создаёт группу первой отправкой без
// awaiting_committer, значит isCommitter(ALICE,BOB)===true — Алиса коммиттер,
// Боб — нет. Здесь роли по коду те же, но первым пишет Боб (не-коммиттер).

const ALICE_PRIV_HEX = bytesToHex(new Uint8Array(32).fill(5));
const BOB_PRIV_HEX = bytesToHex(new Uint8Array(32).fill(6));
const ALICE_PUB = bytesToHex(getPublicKey(new Uint8Array(32).fill(5)));
const BOB_PUB = bytesToHex(getPublicKey(new Uint8Array(32).fill(6)));

function pumpAll(relay, promise) {
	const timer = setInterval(() => relay.flushAll(), 5);
	return promise.finally(() => clearInterval(timer));
}

// В отличие от m1-repro.mjs здесь НЕЛЬЗЯ просто обернуть await device.call("send")
// в pumpAll() и остановиться сразу по её резолву: локальный send() у отправителя
// резолвится, как только ЕГО СОБСТВЕННЫЙ publish() получил OK — Welcome и
// drain-цепочка на стороне получателя к этому моменту ещё могут физически не
// успеть завершиться (несколько круговых обменов с relay). Поэтому реле качаем
// НЕПРЕРЫВНО отдельным окном, не привязанным к резолву конкретного вызова.
async function waitForHistory(relay, device, contactPubkey, minLength, timeoutMs = 8000) {
	const pump = setInterval(() => relay.flushAll(), 5);
	try {
		const deadline = Date.now() + timeoutMs;
		let history = [];
		while (Date.now() < deadline) {
			history = await device.call("history", { contactPubkey });
			if (history.length >= minLength) break;
			await new Promise((r) => setTimeout(r, 50));
		}
		return history;
	} finally {
		clearInterval(pump);
	}
}

test(
	"H1: не-коммиттер пишет первым, коммиттер молчит — сообщение не доставляется НИКОГДА без действия коммиттера; когда тот наконец пишет, доставляются ОБА сразу",
	{ timeout: 30000 },
	async (t) => {
		let bridge;
		const relay = createFakeRelay({ onDeliver: (connId, msg) => bridge.deliver(connId, msg) });
		bridge = createWsBridge(relay, { port: 0 });
		const { port } = await bridge.start();
		const relayUrl = `ws://127.0.0.1:${port}`;

		const alice = spawnDevice(); // коммиттер (isCommitter(ALICE,BOB)===true, см. m1-repro.mjs)
		const bob = spawnDevice(); // не-коммиттер
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

		// Не-коммиттер (Боб) пишет первым — по коду обязан уйти в очередь, не в сеть.
		const bobResult = await pumpAll(relay, bob.call("send", { contactPubkey: ALICE_PUB, text: "Боб пишет первым" }));
		assert.equal(bobResult.status, "awaiting_committer", "H1: не-коммиттер обязан получить awaiting_committer, а не отправить в MLS-группу, которой ещё нет");

		// «Коммиттер молчит» — эмулируем прошедшее время (много «минут» в проде —
		// здесь секунды реального wall-clock, но relay всё это время полностью
		// жив и откачивается, ничего специально не удерживается: если бы на
		// проводе был хоть какой-то сигнал «Боб хочет говорить», Алиса бы его
		// получила и группа появилась. Его нет.
		const pump = setInterval(() => relay.flushAll(), 5);
		await new Promise((r) => setTimeout(r, 2000));
		clearInterval(pump);

		const aliceHistoryWhileSilent = await alice.call("history", { contactPubkey: BOB_PUB });
		assert.equal(
			aliceHistoryWhileSilent.length,
			0,
			"H1 CONFIRMED: сообщение Боба не появилось у Алисы за 2с активного relay без действия коммиттера — задержка НЕ ограничена никаким таймером в коде, только тем, когда коммиттер сам напишет",
		);

		// Коммиттер наконец пишет — по коду это создаёт группу, Welcome, drain
		// очереди Боба. Оба сообщения должны дойти до Алисы «одной пачкой».
		// НЕ оборачиваем в pumpAll() с автостопом по резолву — см. комментарий
		// у waitForHistory(): drain на стороне Боба продолжается уже ПОСЛЕ того,
		// как у Алисы её собственная отправка локально завершилась.
		const sendPromise = alice.call("send", { contactPubkey: BOB_PUB, text: "Алиса наконец пишет" });
		const aliceFinal = await waitForHistory(relay, alice, BOB_PUB, 2);
		await sendPromise;
		assert.equal(aliceFinal.length, 2, "H1: после того как коммиттер заговорил, drain обязан довезти отложенное сообщение Боба вместе со свежим сообщением Алисы");
		assert.deepEqual(
			aliceFinal.map((m) => m.text).sort(),
			["Алиса наконец пишет", "Боб пишет первым"].sort(),
		);
	},
);
