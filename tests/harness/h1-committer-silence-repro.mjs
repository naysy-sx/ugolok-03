import { test } from "node:test";
import assert from "node:assert/strict";
import { bytesToHex } from "@noble/hashes/utils.js";
import { getPublicKey } from "../../src/core/crypto/keys.js";
import { createFakeRelay } from "./fake-relay.js";
import { createWsBridge } from "./ws-bridge.js";
import { spawnDevice } from "./scenario.js";

// Этап 0 (MESSAGE-DELIVERY-TZ.md, З0.3) — ИСТОРИЯ доказательства H1
// (MESSAGE-DELIVERY-AUDIT-BRIEFING.md §6): не-коммиттер отправляет первым,
// коммиттер молчит — раньше сообщение НЕ появлялось у получателя НИКОГДА,
// пока коммиттер сам не напишет (никакого таймера/сигнала на проводе не
// было — §4.5/§5.8 брифа). Это и есть «вываливается через много минут» из
// жалобы пользователя — задержка была равна "сколько человек не заходит".
//
// Этап 4 (вариант A) ЗАКРЫЛ этот класс: не-коммиттер теперь шлёт коммиттеру
// gift-wrap "открой переписку" (kind 3012, chats.js) — коммиттер, будучи
// онлайн, реагирует САМ, без участия человека с его стороны. Тест
// переписан — раньше он доказывал бесконечное ожидание (красный до этапа 4
// был бы неверен само по себе, тест исторически писался ПОСЛЕ Этапа 0 как
// доказательство бага, не regression-барьер), теперь доказывает, что тот же
// сценарий больше НЕ воспроизводится: сообщение доходит за секунды. Более
// подробная версия этого сценария (явный таймер < 10с, приёмка Этапа 4) —
// tests/harness/chat-open-request-repro.mjs; этот файл сохранён как прямая
// регрессионная проверка ИМЕННО исходной формулировки H1.
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
// резолвится, как только ЕГО СОБСТВЕННЫЙ publish() получил OK — реакция
// коммиттера на сигнал происходит уже ПОСЛЕ этого момента. Поэтому реле качаем
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
	"H1 (закрыта Этапом 4): не-коммиттер пишет первым, коммиттер онлайн и молчит — сообщение доходит за секунды (сигнал 'открой переписку'), не остаётся висеть, пока человек сам не напишет",
	{ timeout: 30000 },
	async (t) => {
		let bridge;
		const relay = createFakeRelay({ onDeliver: (connId, msg) => bridge.deliver(connId, msg) });
		bridge = createWsBridge(relay, { port: 0 });
		const { port } = await bridge.start();
		const relayUrl = `ws://127.0.0.1:${port}`;

		const alice = spawnDevice(); // коммиттер (isCommitter(ALICE,BOB)===true, см. m1-repro.mjs) — онлайн, молчит
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

		// Алиса (коммиттер) НИЧЕГО не делает — только продолжает жить онлайн.
		// До Этапа 4 сообщение Боба не появилось бы здесь НИКОГДА без этого —
		// теперь giftWrapSubscriber Алисы реагирует на сигнал сам.
		const aliceFinal = await waitForHistory(relay, alice, BOB_PUB, 1, 10000);
		assert.equal(aliceFinal.length, 1, "H1 ЗАКРЫТА: сообщение Боба обязано дойти без единого действия коммиттера — сигнал 'открой переписку' делает это за секунды, не 'сколько человек не зайдёт'");
		assert.equal(aliceFinal[0].text, "Боб пишет первым");
	},
);
