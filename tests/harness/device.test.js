import { test } from "node:test";
import assert from "node:assert/strict";
import { bytesToHex } from "@noble/hashes/utils.js";
import { getPublicKey } from "../../src/core/crypto/keys.js";
import { createFakeRelay } from "./fake-relay.js";
import { createWsBridge } from "./ws-bridge.js";
import { spawnDevice } from "./scenario.js";

// fill(4)/fill(3) (не по возрастанию!) — важно с этапа 73.3 (И3, единственный
// коммиттер по min(pubkey)): Alice здесь ОТПРАВИТЕЛЬ и ОБЯЗАНА быть
// коммиттером пары — иначе она корректно поставит сообщение в очередь
// (см. m1-repro.test.js), а этот тест конкретно про "счастливый путь"
// прямой отправки, не про И3/И4 — не нужно смешивать. Проверено эмпирически:
// bytesToHex(getPublicKey(fill(4))) < bytesToHex(getPublicKey(fill(3))).
const ALICE_PRIV_HEX = bytesToHex(new Uint8Array(32).fill(4));
const BOB_PRIV_HEX = bytesToHex(new Uint8Array(32).fill(3));
const ALICE_PUB = bytesToHex(getPublicKey(new Uint8Array(32).fill(4)));
const BOB_PUB = bytesToHex(getPublicKey(new Uint8Array(32).fill(3)));

// "Счастливый путь", БЕЗ адверсарного переупорядочивания — этап 73.2's DoD:
// подтвердить, что вся цепочка IPC+реальный сокет+продакшн-код вообще
// работает end-to-end, ПЕРЕД тем как 73.3 начнёт целенаправленно ломать
// тайминг. relay ничего не флашит сам (CONTRACTS.md, ws-bridge.js) —
// pumpUntil() держит очередь пустой, пока не осядет переданный промис
// (внутри connect() продакшн-код сам делает много REQ/EVENT round-trip'ов
// последовательно — без непрерывной откачки они бы зависли на первом же).
function pumpUntil(relay, promise) {
	const timer = setInterval(() => relay.flushAll(), 5);
	return promise.finally(() => clearInterval(timer));
}

test("2 реальных device.js-процесса через реальный сокет: Алиса отправляет — Боб видит в history()", { timeout: 30000 }, async (t) => {
	let bridge;
	const relay = createFakeRelay({ onDeliver: (connId, msg) => bridge.deliver(connId, msg) });
	bridge = createWsBridge(relay, { port: 0 });
	const { port } = await bridge.start();
	const relayUrl = `ws://127.0.0.1:${port}`;

	const alice = spawnDevice();
	const bob = spawnDevice();
	t.after(async () => {
		alice.kill();
		bob.kill();
		await bridge.stop();
	});

	await pumpUntil(relay, alice.call("init", { privKeyHex: ALICE_PRIV_HEX, relayUrl }));
	await pumpUntil(relay, bob.call("init", { privKeyHex: BOB_PRIV_HEX, relayUrl }));
	// Обходит протокол заявок (не предмет этого теста) — иначе Welcome уйдёт
	// в inboxRequests вместо автопринятия (DESIGN.md, "Этап 25" §4, AC-IB-01).
	await alice.call("becomeContact", { peerPubkey: BOB_PUB });
	await bob.call("becomeContact", { peerPubkey: ALICE_PUB });

	await pumpUntil(relay, alice.call("connect"));
	await pumpUntil(relay, bob.call("connect"));

	await pumpUntil(relay, alice.call("send", { contactPubkey: BOB_PUB, text: "привет от Алисы" }));

	// Доставка Бобу идёт через его ЖИВУЮ подписку (refreshGroupMessageSubscription,
	// установленную во время connect()) — не одноразовый REQ, поэтому опрашиваем
	// history() снаружи, пока откачка идёт в фоне.
	const pumpTimer = setInterval(() => relay.flushAll(), 5);
	let history = [];
	const deadline = Date.now() + 15000;
	while (Date.now() < deadline) {
		history = await bob.call("history", { contactPubkey: ALICE_PUB });
		if (history.length > 0) break;
		await new Promise((r) => setTimeout(r, 50));
	}
	clearInterval(pumpTimer);

	assert.equal(history.length, 1);
	assert.equal(history[0].text, "привет от Алисы");
});
