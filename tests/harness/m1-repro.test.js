import { test } from "node:test";
import assert from "node:assert/strict";
import { bytesToHex } from "@noble/hashes/utils.js";
import { getPublicKey } from "../../src/core/crypto/keys.js";
import { createFakeRelay } from "./fake-relay.js";
import { createWsBridge } from "./ws-bridge.js";
import { spawnDevice } from "./scenario.js";

// М1 (DESIGN.md/PLAN.md "Этап 73"): новое устройство ОДНОЙ identity, ещё не
// узнанное собеседником реактивно (kind:443 не дошёл/не обработан ДО первой
// попытки отправить), детерминированно создаёт СВОЮ независимую MLS-группу
// под тем же #h-тегом — Welcome собеседника молча отбрасывается
// (acceptWelcome: `if (existing) return`), сообщение теряется НАВСЕГДА для
// этой пары, не просто с задержкой. Красный тест — первый пункт 73.3
// (перенесён из 73.2, см. PLAN.md): доказывает баг существует НА ТЕКУЩЕМ
// коде, до И3.

const ALICE_PRIV_HEX = bytesToHex(new Uint8Array(32).fill(5));
const BOB_PRIV_HEX = bytesToHex(new Uint8Array(32).fill(6));
const ALICE_PUB = bytesToHex(getPublicKey(new Uint8Array(32).fill(5)));
const BOB_PUB = bytesToHex(getPublicKey(new Uint8Array(32).fill(6)));

function pumpAll(relay, promise) {
	const timer = setInterval(() => relay.flushAll(), 5);
	return promise.finally(() => clearInterval(timer));
}

// Запускает triggerFn() БЕЗ откачки очереди (ничего ещё не flush'ается) —
// первая же новая запись pending() принадлежит только что открытому сокету
// triggerFn()'а (ws-bridge не даёт connId напрямую, см. CONTRACTS.md "Этап
// 73.3" — диф pending() ДО старта откачки ДОСТАТОЧЕН, без правки уже
// протестированного ws-bridge.js). ПОСЛЕ поимки connId запускает pumpAll и
// дожидается resultPromise — вызывающему не нужно делать это отдельно.
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

// Непрерывно доставляет ВСЁ, КРОМЕ записей, для которых holdBackFn(p) истинно —
// держит их в очереди сколь угодно долго (прямое использование reorder()+
// flushNext() по контракту "Этап 73.2 — fake-relay.js": инструмент для
// адверсарных тестов на переупорядочивание). Возвращает id таймера — вызывающий
// обязан clearInterval() сам, когда пора либо остановить откачку, либо
// сменить holdBackFn (для этого просто создать новый pumpAllExcept).
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

// todo — ОСОЗНАННО красный: доказывает М1 на текущем коде (до И3, этап 73.3).
// node:test не роняет общий прогон из-за todo-теста (полная регрессия
// "зелёная" остаётся честной для остального кода, п.18 skill'а), но падение
// видно отдельной строкой в сводке. Снять todo и получить зелёный — это и
// есть Definition of Done для И3.
test(
	"М1: второе устройство Алисы пишет ДО реактивной досинхронизации — сообщение теряется для Боба (красный тест)",
	{ timeout: 30000, todo: "закрывается этапом 73.3 (И3 — единственный коммиттер), см. PLAN.md" },
	async (t) => {
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

	// init() не открывает сокет (только db.open()+seed uiSettings) — сокет
	// появляется только в connect(), там и ловим connId Боба, нужен ниже,
	// чтобы прицельно придержать ИМЕННО его kind:443-уведомления.
	await bob.call("init", { privKeyHex: BOB_PRIV_HEX, relayUrl });
	await pumpAll(relay, aliceA1.call("init", { privKeyHex: ALICE_PRIV_HEX, relayUrl }));
	await bob.call("becomeContact", { peerPubkey: ALICE_PUB });
	await aliceA1.call("becomeContact", { peerPubkey: BOB_PUB });

	const bobConnId = await identifyNewConnId(relay, () => bob.call("connect"));
	await pumpAll(relay, aliceA1.call("connect"));
	await pumpAll(relay, aliceA1.call("send", { contactPubkey: BOB_PUB, text: "hello от A1" }));

	const baseline = await waitForHistory(bob, 1);
	assert.equal(baseline.length, 1, "базовая линия: Боб должен видеть сообщение A1 до старта гонки");

	// Гонка М1: с этого момента ПРИДЕРЖИВАЕМ только kind:443-уведомления,
	// адресованные Бобу (deviceAnnounceSubscriber) — реальный аналог: relay
	// доставит их Бобу чуть позже, чем A2 успевает набрать и отправить первое
	// сообщение (обычный путь для нового окна, не редкий edge case — см.
	// DESIGN.md, переоценка И2). Всё остальное (включая ВСЕ собственные нужды
	// A2 — её REQ/EVENT/OK/EOSE) идёт свободно, без искусственной задержки.
	const holdTimer = pumpAllExcept(relay, (p) => p.connId === bobConnId && p.msg[0] === "EVENT" && p.msg[2]?.kind === 443);

	await aliceA2.call("init", { privKeyHex: ALICE_PRIV_HEX, relayUrl });
	await aliceA2.call("becomeContact", { peerPubkey: BOB_PUB });
	await aliceA2.call("connect");
	await aliceA2.call("send", { contactPubkey: BOB_PUB, text: "from A2" });

	// Пока announce придержан, Боб не может знать про A2 — история должна
	// остаться на 1 (сообщение A2 либо ещё не пришло, либо уже пришло по
	// #h, но не расшифровалось — оба случая дают одинаковый наблюдаемый счёт).
	await new Promise((r) => setTimeout(r, 300));
	const duringRace = await bob.call("history", { contactPubkey: ALICE_PUB });

	// Отпускаем придержанное — если бы реактивная досинхронизация могла
	// исправить дело ПОСТФАКТУМ, она сделала бы это здесь.
	clearInterval(holdTimer);
	const releaseTimer = setInterval(() => relay.flushAll(), 5);
	await new Promise((r) => setTimeout(r, 500));
	const final = await bob.call("history", { contactPubkey: ALICE_PUB });
	clearInterval(releaseTimer);

	// КРАСНЫЙ тест: на текущем коде (до И3) Боб теряет сообщение A2 —
	// acceptWelcome молча отбрасывает Welcome A2 (`if (existing) return`),
	// kind:445 от A2 не расшифровывается локальным состоянием группы Боба
	// (независимая ветка, другие ключи). Ожидаемое (желаемое, ПОСЛЕ И3) —
	// 2 сообщения; фактическое сейчас — 1, ДАЖЕ ПОСЛЕ того как Боб узнал
	// об A2 (постфактум это уже не чинит потерянное сообщение).
	assert.equal(duringRace.length, 1, "во время гонки: Боб пока не видит сообщение A2");
	assert.equal(final.length, 2, "М1: сообщение A2 должно быть видно Бобу даже после того, как он узнал об A2 постфактум (провалится на текущем коде — это и есть красный тест)");
	},
);
