import { test } from "node:test";
import assert from "node:assert/strict";
import { bytesToHex } from "@noble/hashes/utils.js";
import { getPublicKey } from "../../src/core/crypto/keys.js";
import { createFakeRelay } from "./fake-relay.js";
import { createWsBridge } from "./ws-bridge.js";
import { spawnDevice } from "./scenario.js";

// Этап 3 (MESSAGE-DELIVERY-TZ.md, З3.3) — "445 до Welcome больше не
// проглатывается": relay не гарантирует порядок доставки между gift-wrap
// (kind 1059, несёт Welcome) и kind 445 (первое сообщение той же группы) —
// оба публикуются практически одновременно (doEnsureChatEstablished шлёт
// Welcome, следом doSendMessage шлёт 445), но это два РАЗНЫХ события на
// РАЗНЫХ подписках получателя, relay может доставить их в любом порядке.
// Раньше receiveGroupMessageEvent тихо возвращала null, когда группы ещё нет
// (chat.js "чужая/неизвестная группа") — то, что 445 пришло РАНЬШЕ Welcome,
// означало потерю НАВСЕГДА в этой сессии (единственное восстановление —
// reload, который сбрасывает processedEventIds и получает 445 заново из
// backlog при resubscribe). Теперь — тот же буфер, что и decrypt-fail (М3),
// с ретраем сразу после acceptWelcome.

const ALICE_PRIV_HEX = bytesToHex(new Uint8Array(32).fill(5));
const BOB_PRIV_HEX = bytesToHex(new Uint8Array(32).fill(6));
const ALICE_PUB = bytesToHex(getPublicKey(new Uint8Array(32).fill(5)));
const BOB_PUB = bytesToHex(getPublicKey(new Uint8Array(32).fill(6)));

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

// Непрерывно доставляет всё, КРОМЕ записей, для которых holdBackFn(p) истинно
// (тот же приём, что m1-repro.mjs/m3-repro.mjs/h2/h3).
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

test(
	"Этап 3 (З3.3): kind 445 приходит РАНЬШЕ gift-wrap Welcome — буферизуется (не теряется), доставляется сразу после acceptWelcome",
	{ timeout: 30000 },
	async (t) => {
		let bridge;
		const relay = createFakeRelay({ onDeliver: (connId, msg) => bridge.deliver(connId, msg) });
		bridge = createWsBridge(relay, { port: 0 });
		const { port } = await bridge.start();
		const relayUrl = `ws://127.0.0.1:${port}`;

		const alice = spawnDevice(); // коммиттер (isCommitter(ALICE,BOB)===true, см. m1-repro.mjs)
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
		const bobConnId = await identifyNewConnId(relay, () => bob.call("connect"));

		// Держим ИМЕННО gift-wrap (kind 1059 — несёт Welcome), адресованный
		// Бобу — kind 445 (первое сообщение) проходит свободно.
		const holdTimer = pumpAllExcept(relay, (p) => p.connId === bobConnId && p.msg[0] === "EVENT" && p.msg[2]?.kind === 1059);
		t.after(() => clearInterval(holdTimer));

		// Алиса (коммиттер) пишет первой — по коду это ОДНОВРЕМЕННО создаёт
		// группу+Welcome И публикует её собственное 445. НЕ оборачиваем в
		// pumpAll() — та делает БЕЗУСЛОВНЫЙ relay.flushAll(), который сразу же
		// пропустил бы придержанный Welcome мимо holdTimer'а (уже запущенного
		// выше). Полагаемся ИСКЛЮЧИТЕЛЬНО на holdTimer's pumpAllExcept.
		const sendResult = await alice.call("send", { contactPubkey: BOB_PUB, text: "первое сообщение" });
		assert.ok(sendResult.eventId, "коммиттер должен отправить немедленно, не уйти в очередь");

		// Продолжаем ждать (holdTimer уже качает всё, КРОМЕ Welcome) — 445
		// доходит до Боба, у него ЕЩЁ НЕТ mlsGroups для этой пары (Welcome
		// придержан) — буфер (не потеря).
		await new Promise((r) => setTimeout(r, 500));
		const historyWhileHeld = await bob.call("history", { contactPubkey: ALICE_PUB });
		assert.equal(historyWhileHeld.length, 0, "пока Welcome придержан: сообщение НЕ должно быть видно (группы ещё нет) — но и не потеряно");

		// Отпускаем Welcome — acceptWelcome должен сработать, а следом —
		// ретрай буфера (З3.3), без ожидания следующего живого 445 этой группы.
		clearInterval(holdTimer);
		const releaseTimer = setInterval(() => relay.flushAll(), 5);
		const final = await waitForHistory(bob, 1, 15000);
		clearInterval(releaseTimer);

		assert.equal(final.length, 1, "З3.3: буферизованное сообщение обязано доставиться сразу после acceptWelcome, без ручного вмешательства/reload");
		assert.equal(final[0].text, "первое сообщение");
	},
);
