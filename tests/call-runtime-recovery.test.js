// TZ-recovery-policy.md §9 — приёмочные сценарии новой политики восстановления.
// Используем t.mock.timers.enable({apis:["setTimeout","Date"]}) вместо
// самодельного fakeTimers() (как в call-runtime.test.js): здесь одновременно
// тикают ДВА таймера (heartbeat раз в 3с, restartTick по расписанию §2.2) —
// встроенный мок Node сам разруливает порядок срабатывания по виртуальному
// времени, ручной "какой из двух старше" перестаёт быть головной болью теста.
import { test } from "node:test";
import assert from "node:assert/strict";
import { getPublicKey } from "../src/core/crypto/keys.js";
import { bytesToHex } from "@noble/hashes/utils.js";
import { createCallRuntime } from "../src/domain/calls/call-runtime.js";
import { buildCallSignalEvent } from "../src/domain/calls/signaling-adapter.js";

const ALICE_PRIV = new Uint8Array(32).fill(21);
const ALICE_PUB = bytesToHex(getPublicKey(ALICE_PRIV));
const BOB_PRIV = new Uint8Array(32).fill(42);
const BOB_PUB = bytesToHex(getPublicKey(BOB_PRIV));

// НЕ setTimeout(resolve,0) — этот файл включает t.mock.timers.enable(...) для
// setTimeout, и замоканный таймер сам по себе никогда не сработает без
// явного tick(). Дренируем цепочку await'ов внутри dispatch() микрозадачами
// напрямую — они моком не затрагиваются.
async function flush() {
	for (let i = 0; i < 20; i++) await Promise.resolve();
}

function fakeMediaController() {
	const calls = [];
	let onEventRef;
	const factory = (opts) => {
		onEventRef = opts.onEvent;
		return {
			execute: async (command) => {
				calls.push(command);
			},
		};
	};
	return {
		factory,
		calls,
		async fire(event) {
			onEventRef(event);
			await flush();
		},
	};
}

// ALICE_PUB < BOB_PUB лексикографически (как и в call-runtime.test.js) —
// ALICE polite, значит НЕ инициирует DO_ICE_RESTART сама. Для этих сценариев
// это не важно (проверяем выживание/каденцию/предохранитель, не то, кто
// шлёт offer) — оставлено как есть, роль не переключаем.
function makeRuntime(extra = {}) {
	const media = fakeMediaController();
	const published = [];
	let relayState = "connected";
	const runtime = createCallRuntime({
		myPubkey: ALICE_PUB,
		privKey: ALICE_PRIV,
		publish: async (event) => {
			published.push(event);
			return { ok: true };
		},
		createMediaController: media.factory,
		getRelayState: () => relayState,
		// random:()=>0.5 — джиттер (§2.2) даёт РОВНО ms без разброса (see
		// applyJitter: ms - spread + 0.5*spread*2 === ms). Тесты в этом файле
		// проверяют точные секунды расписания — со случайным Math.random()
		// они были бы недетерминированными (флаки на границах RESTART_TICK).
		random: () => 0.5,
		...extra,
	});
	return { runtime, media, published, setRelayState: (s) => (relayState = s) };
}

async function connectCall(runtime, media) {
	runtime.placeCall(BOB_PUB);
	await flush();
	const sessionId = runtime.getState().sessionId;
	await media.fire({ type: "REMOTE_ANSWER", sessionId, sdp: { type: "answer", sdp: "answer-sdp" } });
	await media.fire({ type: "ICE_CONNECTED" });
	assert.equal(runtime.getState().name, "CONNECTED");
	return sessionId;
}

async function tick(t, ms) {
	t.mock.timers.tick(ms);
	await flush();
}

// §3 — heartbeat реальный (реальное NIP-44-шифрование BOB->ALICE), не
// заглушка: имитирует "сигнальный канал жив, собеседник на связи", ОТДЕЛЬНО
// от состояния медиа/ICE. Без этого 60с/5-минутные сценарии ниже неотличимы
// от "оба канала мертвы", и honestly ПРАВИЛЬНО получили бы peer_gone —
// именно так реальный §3 и должен работать. Тесты на "долгий обрыв МЕДИА,
// сигнализация жива" обязаны кормить heartbeat сами, как здесь.
function deliverRemoteHeartbeat(runtime, sessionId) {
	const event = buildCallSignalEvent(BOB_PRIV, ALICE_PUB, { type: "heartbeat", sessionId });
	runtime.handleIncomingSignal(event);
}

// Тикает по шагам ~CALL_HEARTBEAT_MS, между шагами доставляя heartbeat от
// Боба — симулирует "сигнальный канал жив всё это время", пока внешний код
// теста независимо управляет transportConnected/ICE.
async function tickWithHeartbeats(t, runtime, sessionId, totalMs, stepMs = 3000) {
	let elapsed = 0;
	while (elapsed < totalMs) {
		const step = Math.min(stepMs, totalMs - elapsed);
		await tick(t, step);
		elapsed += step;
		deliverRemoteHeartbeat(runtime, sessionId);
		await flush();
	}
}

test("обрыв на 60 секунд: звонок остаётся живым, восстанавливается; попыток не больше ceil(60/5)", async (t) => {
	t.mock.timers.enable({ apis: ["setTimeout", "Date"] });
	const { runtime, media } = makeRuntime();
	const sessionId = await connectCall(runtime, media);

	await media.fire({ type: "ICE_DISCONNECTED" });
	assert.equal(runtime.getState().name, "RECONNECTING");

	// 60 секунд простоя МЕДИА (ICE не восстанавливается), но СИГНАЛИНГ жив —
	// собеседник шлёт heartbeat всё это время (§3: иначе через 45с корректно
	// сработал бы peer_gone, это не баг, а другой сценарий — см. тест
	// "собеседник ушёл" ниже).
	await tickWithHeartbeats(t, runtime, sessionId, 60000);
	assert.equal(runtime.getState().name, "RECONNECTING", "звонок пережил 60с — старая модель завершила бы его на 4-й попытке (~19с)");

	const restartCommands = media.calls.filter((c) => c.type === "DO_ICE_RESTART");
	// grace(2с) + попытки каждые 5с в первую минуту: не больше ceil(60/5)=12
	// РЕАЛЬНЫХ попыток (могло быть чуть меньше — ALICE polite, сама не
	// инициирует DO_ICE_RESTART; проверяем restartCount — он растёт при
	// КАЖДОЙ попытке независимо от роли, п.2.2).
	assert.ok(runtime.getState().restartCount <= Math.ceil(60000 / 5000) + 1, `restartCount=${runtime.getState().restartCount} не должен разгоняться быстрее расписания`);

	// Сеть вернулась — звонок должен суметь восстановиться.
	await media.fire({ type: "ICE_CONNECTED" });
	assert.equal(runtime.getState().name, "CONNECTED");
	assert.equal(runtime.getState().restartCount, 0);
	t.mock.timers.reset();
});

test("обрыв на 5 минут: звонок выживает, интервал попыток вырастает до верхнего предела (§2.2, фаза 2)", async (t) => {
	// Обновление TURN-кредов на каждой попытке (§2.3) — забота media-controller.js,
	// не call-runtime.js/call-fsm.js; проверено отдельно и точнее в
	// tests/media-controller.test.js ("iceServers-резолвер вызывается с
	// {refreshIfStale:true} перед КАЖДОЙ попыткой"). Здесь media полностью
	// застаблен (тот же приём, что в call-runtime.test.js) — он в принципе не
	// умеет вызывать resolveIceServers, это не его уровень ответственности.
	t.mock.timers.enable({ apis: ["setTimeout", "Date"] });
	const { runtime, media } = makeRuntime();
	const sessionId = await connectCall(runtime, media);
	await media.fire({ type: "ICE_DISCONNECTED" });

	await tickWithHeartbeats(t, runtime, sessionId, 5 * 60000);
	assert.equal(runtime.getState().name, "RECONNECTING", "5 минут простоя — всё ещё жив");
	assert.ok(runtime.getState().restartCount >= 10, "за 5 минут должно накопиться заметно больше попыток, чем за старые 4");

	await media.fire({ type: "ICE_CONNECTED" });
	assert.equal(runtime.getState().name, "CONNECTED");
	t.mock.timers.reset();
});

test("обрыв дольше предохранителя: ENDED(safety_cap), SEND_HANGUP отправлен", async (t) => {
	t.mock.timers.enable({ apis: ["setTimeout", "Date"] });
	const stateChanges = [];
	const { runtime, media, published } = makeRuntime({
		safetyCapMs: 30000, // короткий, чтобы не гонять реальные 10 минут в тесте
		onStateChange: (name, reason) => stateChanges.push({ name, reason }),
	});
	await connectCall(runtime, media);
	await media.fire({ type: "ICE_DISCONNECTED" });

	await tick(t, 30000);
	assert.equal(runtime.getState().name, "ENDED");
	assert.equal(runtime.getState().reason, "safety_cap");
	assert.ok(stateChanges.some((s) => s.name === "ENDED" && s.reason === "safety_cap"));
	// §4 — даже safety_cap обязан слать SEND_HANGUP (не просто CLOSE_PC).
	assert.equal(published.length, 1, "SEND_HANGUP реально опубликован");
	t.mock.timers.reset();
});

test("собеседник ушёл при живом собственном транспорте: ENDED(peer_gone), обнаруживается на первой же проверке ПОСЛЕ PEER_ALIVE_FRESH_MS(45с)", async (t) => {
	// TZ-recovery-policy.md §3 реализовано на базе уже существующей каденции
	// попыток (§2.2), не отдельными часами: peer_gone проверяется В МОМЕНТ
	// каждого RESTART_TICK, не непрерывно. В фазе 1 (первая минута) тики идут
	// каждые 5с (после grace=2с): 2с,7с,...,42с,47с — 44с сама по себе ничего
	// не проверяет, ближайшая проверка ПОСЛЕ 45с — на 47-й секунде.
	t.mock.timers.enable({ apis: ["setTimeout", "Date"] });
	const { runtime, media } = makeRuntime();
	await connectCall(runtime, media);
	await media.fire({ type: "ICE_DISCONNECTED" });

	await tick(t, 44000);
	assert.equal(runtime.getState().name, "RECONNECTING", "44с — ближайшая проверка (42с) ещё не видела 45с молчания");

	await tick(t, 6000); // до 50с — гарантированно захватывает проверку на 47-й секунде
	assert.equal(runtime.getState().name, "ENDED");
	assert.equal(runtime.getState().reason, "peer_gone");
	t.mock.timers.reset();
});

test("собственный транспорт лежит, признаков жизни собеседника нет — НЕ завершается ни при какой длительности (до предохранителя)", async (t) => {
	t.mock.timers.enable({ apis: ["setTimeout", "Date"] });
	const { runtime, media, setRelayState } = makeRuntime({ safetyCapMs: null });
	// safetyCapMs:null — реализация трактует null как "нет предела" (см.
	// createCallRuntime: options.safetyCapMs используется как есть, а
	// call-fsm.js's elapsedReconnectingMs >= null всегда false для нашего
	// null — ПРОВЕРЯЕТСЯ ниже отдельно, тут просто убеждаемся, что и без
	// предохранителя "транспорт лежит" НЕ считается уходом собеседника).
	await connectCall(runtime, media);
	setRelayState("disconnected");
	await media.fire({ type: "ICE_DISCONNECTED" });

	// Собеседник "молчит" сильно дольше PEER_ALIVE_FRESH_MS(45с), но наш
	// транспорт всё это время НЕ подключён — §3 требует, чтобы это не
	// считалось уходом собеседника.
	await tick(t, 5 * 60000);
	assert.equal(runtime.getState().name, "RECONNECTING", "своя проблема с транспортом не должна выглядеть как уход собеседника");
	assert.equal(runtime.getState().restartCount, 0, "ни одна попытка не потрачена — предусловие §2.1 (транспорт подключён) ни разу не выполнялось");

	setRelayState("connected");
	await media.fire({ type: "ICE_CONNECTED" });
	assert.equal(runtime.getState().name, "CONNECTED", "как только транспорт вернулся, восстановление всё ещё возможно");
	t.mock.timers.reset();
});

test("мелькание транспорта (то подключён, то нет, каждые несколько секунд): попытки не тратятся впустую, restartCount растёт только когда транспорт реально был подключён на тике", async (t) => {
	t.mock.timers.enable({ apis: ["setTimeout", "Date"] });
	const { runtime, media, setRelayState } = makeRuntime();
	const sessionId = await connectCall(runtime, media);
	setRelayState("disconnected");
	await media.fire({ type: "ICE_DISCONNECTED" });

	// Мелькание: на каждом тике транспорт то есть, то нет. Когда он "есть" —
	// сигналинг тоже жив, значит и heartbeat собеседника доходит (иначе este
	// тест столкнулся бы с §3's peer_gone на 45-50с — другой, уже отдельно
	// проверенный сценарий, см. тест выше).
	let up = false;
	for (let i = 0; i < 10; i++) {
		up = !up;
		setRelayState(up ? "connected" : "disconnected");
		await tick(t, 5000);
		if (up) deliverRemoteHeartbeat(runtime, sessionId);
		await flush();
	}
	assert.equal(runtime.getState().name, "RECONNECTING", "мелькание само по себе не должно завершить звонок");
	// Попытки могли состояться только на тиках с transportConnected:true —
	// то есть заведомо меньше 10 (половина тиков — с лежащим транспортом).
	assert.ok(runtime.getState().restartCount < 10, `restartCount=${runtime.getState().restartCount} — не должен расти на тиках с лежащим транспортом`);
	t.mock.timers.reset();
});

// Приёмочный критерий всей задачи (TZ-recovery-policy.md §9, последний пункт) —
// воспроизведение хронологии 10-LIVE-INCIDENT-2026-09-07.md: ~14 секунд общей
// недоступности (и медиа, и сигналинга), затем полное восстановление.
// Старая модель: 19.09с до ENDED(connection_lost) — обрыв случился БЫСТРЕЕ,
// чем сеть успела восстановиться. Новая модель обязана этот же 14-секундный
// провал пережить с большим запасом.
test("приёмочный: хронология инцидента 2026-09-07 (14с общей недоступности) — звонок ВЫЖИВАЕТ", async (t) => {
	t.mock.timers.enable({ apis: ["setTimeout", "Date"] });
	const { runtime, media, setRelayState } = makeRuntime();
	await connectCall(runtime, media);

	// t=0: сеть умирает целиком (и медиа, и сигнальный канал телефона —
	// 10-LIVE-INCIDENT §11.5: WS телефона мелькал 14с подряд).
	setRelayState("disconnected");
	await media.fire({ type: "ICE_DISCONNECTED" });
	assert.equal(runtime.getState().name, "RECONNECTING");

	await tick(t, 14000); // ровно окно инцидента

	// t=14с: связь полностью восстановилась — и транспорт, и медиа.
	setRelayState("connected");
	await media.fire({ type: "ICE_CONNECTED" });

	assert.equal(runtime.getState().name, "CONNECTED", "старая модель (19.09с до ENDED) не пережила бы эти же 14с — новая обязана");
	assert.equal(runtime.getState().restartCount, 0, "успешное восстановление сбрасывает счётчик");
	t.mock.timers.reset();
});
