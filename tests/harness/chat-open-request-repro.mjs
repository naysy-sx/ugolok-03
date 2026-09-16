import { test } from "node:test";
import assert from "node:assert/strict";
import { bytesToHex } from "@noble/hashes/utils.js";
import { getPublicKey } from "../../src/core/crypto/keys.js";
import { createFakeRelay } from "./fake-relay.js";
import { createWsBridge } from "./ws-bridge.js";
import { spawnDevice } from "./scenario.js";

// Этап 4 (MESSAGE-DELIVERY-TZ.md, вариант A) — приёмка: "два устройства,
// не-коммиттер пишет первым, коммиттер онлайн и молчит -> сообщение
// доставлено меньше чем за 10 с". До этого этапа (H1, tests/harness/
// h1-committer-silence-repro.mjs) единственным триггером для коммиттера было
// "сам напишет" — часы/дни/никогда. Теперь не-коммиттер шлёт коммиттеру
// gift-wrap "открой переписку" (kind 3012, chats.js) — коммиттер, будучи
// онлайн, реагирует сам, без участия человека с его стороны.

const ALICE_PRIV_HEX = bytesToHex(new Uint8Array(32).fill(5));
const BOB_PRIV_HEX = bytesToHex(new Uint8Array(32).fill(6));
const ALICE_PUB = bytesToHex(getPublicKey(new Uint8Array(32).fill(5)));
const BOB_PUB = bytesToHex(getPublicKey(new Uint8Array(32).fill(6)));

function pumpAll(relay, promise) {
	const timer = setInterval(() => relay.flushAll(), 5);
	return promise.finally(() => clearInterval(timer));
}

// Памп относительно relay качается СНАРУЖИ (весь остаток теста, см. вызов
// ниже) — эта функция только опрашивает локальную историю устройства.
async function waitForHistory(device, contactPubkey, minLength, timeoutMs) {
	const deadline = Date.now() + timeoutMs;
	let history = [];
	while (Date.now() < deadline) {
		history = await device.call("history", { contactPubkey });
		if (history.length >= minLength) break;
		await new Promise((r) => setTimeout(r, 50));
	}
	return history;
}

test(
	"Этап 4 (вариант A): не-коммиттер пишет первым, коммиттер онлайн и молчит — сообщение доставлено меньше чем за 10с (сигнал 'открой переписку', не ручное ожидание)",
	{ timeout: 30000 },
	async (t) => {
		let bridge;
		const relay = createFakeRelay({ onDeliver: (connId, msg) => bridge.deliver(connId, msg) });
		bridge = createWsBridge(relay, { port: 0 });
		const { port } = await bridge.start();
		const relayUrl = `ws://127.0.0.1:${port}`;

		const alice = spawnDevice(); // коммиттер (isCommitter(ALICE,BOB)===true, см. m1-repro.mjs) — онлайн, МОЛЧИТ
		const bob = spawnDevice(); // не-коммиттер — пишет первым
		t.after(async () => {
			alice.kill();
			bob.kill();
			await bridge.stop();
		});

		await pumpAll(relay, alice.call("init", { privKeyHex: ALICE_PRIV_HEX, relayUrl }));
		await pumpAll(relay, bob.call("init", { privKeyHex: BOB_PRIV_HEX, relayUrl }));
		await alice.call("becomeContact", { peerPubkey: BOB_PUB });
		await bob.call("becomeContact", { peerPubkey: ALICE_PUB });
		await pumpAll(relay, alice.call("connect")); // коммиттер онлайн — и НИЧЕГО больше не делает
		await pumpAll(relay, bob.call("connect"));

		// ОДИН непрерывный памп на весь остаток теста — начиная ДО отправки:
		// bob.call("send",...) сам публикует gift-wrap "открой переписку" и
		// ждёт его "OK", это тоже требует качающегося relay (тот же урок, что
		// h1-committer-silence-repro.mjs — pumpAll() с автостопом по резолву
		// одного-единственного вызова здесь не годится, останавливается СРАЗУ
		// после того как bob's send() локально завершится, до того как Алиса
		// вообще успеет отреагировать на сигнал).
		const pump = setInterval(() => relay.flushAll(), 5);
		const t0 = Date.now();
		let elapsedMs;
		let finalHistory;
		try {
			const bobResult = await bob.call("send", { contactPubkey: ALICE_PUB, text: "не-коммиттер пишет первым" });
			assert.equal(bobResult.status, "awaiting_committer", "не-коммиттер обязан уйти в очередь, не отправить напрямую");

			// Коммиттер (Алиса) НИЧЕГО не вызывает сама — только продолжает жить
			// онлайн (relay качается). Единственный источник прогресса — её
			// giftWrapSubscriber, среагировавший на chat-open-request.
			finalHistory = await waitForHistory(alice, BOB_PUB, 1, 10000);
			elapsedMs = Date.now() - t0;
		} finally {
			clearInterval(pump);
		}

		assert.equal(finalHistory.length, 1, "З4 (вариант A): сообщение обязано дойти БЕЗ действия коммиттера — только сигнал 'открой переписку'");
		assert.equal(finalHistory[0].text, "не-коммиттер пишет первым");
		assert.ok(elapsedMs < 10000, `доставка заняла ${elapsedMs}мс — приёмка требует < 10000мс`);
	},
);
