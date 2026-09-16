import { test } from "node:test";
import assert from "node:assert/strict";
import { bytesToHex } from "@noble/hashes/utils.js";
import { getPublicKey } from "../../src/core/crypto/keys.js";
import { createFakeRelay } from "./fake-relay.js";
import { createWsBridge } from "./ws-bridge.js";
import { spawnDevice } from "./scenario.js";

// Этап 0 (MESSAGE-DELIVERY-TZ.md, З0.3) — доказательство H3 (MESSAGE-DELIVERY-
// AUDIT-BRIEFING.md §6, §5.3): fetchDeviceKeyPackages ждал ТОЛЬКО "EOSE" на
// REQ {authors:[peer], kinds:[443]} — если EOSE не приходит (реле требует AUTH
// и закрывает подписку auth-required без REQ replay после AUTH_OK, либо просто
// сеть потеряла кадр), ensureChatEstablished (и вся sendChatMessageAction)
// висела бесконечно — тот же класс дефекта, что H2, на другом REQ/EOSE-пути.
//
// Этап 2 — дефект закрыт: fetchDeviceKeyPackages теперь идёт через
// oneShotRequest (core/transport/deadline.js, unit-доказательство —
// tests/deadline.test.js) со сроком 10с и DomainError("errors.keyPackageTimeout")
// по истечении. relay-auth.js's reportAuthFail теперь тоже реплеит активные
// REQ (tests/relay-pool.test.js) — щель AUTH-без-replay больше не единственная
// причина живого зависания, но сам таймаут закрывает ЛЮБУЮ причину разом.

const ALICE_PRIV_HEX = bytesToHex(new Uint8Array(32).fill(5));
const BOB_PRIV_HEX = bytesToHex(new Uint8Array(32).fill(6));
const ALICE_PUB = bytesToHex(getPublicKey(new Uint8Array(32).fill(5)));
const BOB_PUB = bytesToHex(getPublicKey(new Uint8Array(32).fill(6)));

function pumpAll(relay, promise) {
	const timer = setInterval(() => relay.flushAll(), 5);
	return promise.finally(() => clearInterval(timer));
}

// Непрерывно доставляет всё, КРОМЕ записей, для которых holdBackFn(p) истинно —
// тот же приём, что m1-repro.mjs/m3-repro.mjs/h2-publish-hang-repro.mjs.
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
	"H3 (закрыта Этапом 2, oneShotRequest): ensureChatEstablished не settled раньше срока, если EOSE на REQ kind:443 задерживается, и продолжается после",
	{ timeout: 30000 },
	async (t) => {
		let bridge;
		const relay = createFakeRelay({ onDeliver: (connId, msg) => bridge.deliver(connId, msg) });
		bridge = createWsBridge(relay, { port: 0 });
		const { port } = await bridge.start();
		const relayUrl = `ws://127.0.0.1:${port}`;

		const alice = spawnDevice(); // коммиттер — первым напишет Бобу
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

		// Боб подключается первым и публикует kind:443 (ensureOwnKeyPackagePublished
		// внутри connect()) — он должен реально лежать на relay к моменту, когда
		// Алиса его запросит.
		await pumpAll(relay, bob.call("connect"));
		// Алиса подключается ДО начала удержания EOSE — её собственный connect()
		// (bootstrap-синхронизация и штатные подписки) опирается на EOSE и не
		// должен зависнуть сам по себе; проверяем именно REQ fetchDeviceKeyPackages,
		// который случится позже, внутри send().
		await pumpAll(relay, alice.call("connect"));

		// С этого момента держим ЛЮБОЙ EOSE — включая тот, что Алиса ждёт от
		// своего REQ {authors:[BOB_PUB], kinds:[443]} внутри fetchDeviceKeyPackages.
		const holdTimer = pumpAllExcept(relay, (p) => p.msg[0] === "EOSE");

		const sendPromise = alice.call("send", { contactPubkey: BOB_PUB, text: "привет Бобу" });

		let settled = false;
		sendPromise.then(
			() => (settled = true),
			() => (settled = true),
		);
		await new Promise((r) => setTimeout(r, 2000));
		assert.equal(
			settled,
			false,
			"ensureChatEstablished не должен settle раньше срока (2с — обычная сетевая задержка, меньше 10с по умолчанию для fetchDeviceKeyPackages)",
		);

		// Отпускаем EOSE — REQ Алисы наконец получает свой EOSE, fetchDeviceKeyPackages
		// возвращается с устройствами Боба, establish+send продолжаются штатно.
		clearInterval(holdTimer);
		const releasePump = setInterval(() => relay.flushAll(), 5);
		const result = await sendPromise;
		clearInterval(releasePump);

		assert.ok(!result.status || result.status !== "awaiting_committer", "H3: коммиттер не должен уйти в очередь — группа обязана установиться после EOSE");
		const aliceHistory = await alice.call("history", { contactPubkey: BOB_PUB });
		assert.equal(aliceHistory.length, 1, "H3: после запоздалого EOSE сообщение всё-таки уходит");
	},
);
