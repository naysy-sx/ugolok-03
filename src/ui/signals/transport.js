import { signal } from "@preact/signals";
import * as Comlink from "comlink";
import CryptoWorker from "../../workers/crypto.worker.js?worker&inline";
import { BUILD_DEFAULT_RELAYS as DEFAULT_RELAYS } from "../../config.js";
import { createRelayConnection } from "../../core/transport/relay-pool.js";
import { createPublisher } from "../../core/transport/publisher.js";
import { runBootstrap } from "../../core/sync/bootstrap.js";
import { startIncrementalSync } from "../../core/sync/incremental-sync.js";
import { rebuildContactsAndGroups, rebuildEffectivePermissions } from "../../domain/events/handlers.js";
import { createLamportClock, computeInitialLamportValue, persistLamportValue } from "../../core/sync/lamport.js";
import { createSubscriber } from "../../core/transport/subscriber.js";
import { parseProfileEvent } from "../../domain/identity/profile.js";

export const connState = signal("disconnected");
export const synced = signal(false);

let connection = null;
let publisher = null;
let cryptoWorker = null;
let connectPromise = null;
let connectedForPubkey = null;
let verifyBatchFn = null;

function waitForConnState(conn, predicate, timeoutMs) {
	return new Promise((resolve, reject) => {
		if (predicate(conn.getState())) return resolve();
		const t0 = Date.now();
		const iv = setInterval(() => {
			if (predicate(conn.getState())) {
				clearInterval(iv);
				resolve();
			} else if (Date.now() - t0 > timeoutMs) {
				clearInterval(iv);
				reject(new Error(`таймаут ожидания состояния соединения (сейчас: "${conn.getState()}")`));
			}
		}, 50);
	});
}

function teardown() {
	publisher = null;
	verifyBatchFn = null;
	if (cryptoWorker) {
		cryptoWorker.terminate();
		cryptoWorker = null;
	}
	if (connection) {
		connection.close();
		connection = null;
	}
	connState.value = "disconnected";
	synced.value = false;
}

async function connect(pubkeyHex, privKey) {
	const relayUrl = DEFAULT_RELAYS[0] ?? "ws://127.0.0.1:7777";
	connection = createRelayConnection(relayUrl, { onStateChange: (s) => (connState.value = s) });
	connection.connect();
	await waitForConnState(connection, (s) => s === "connected", 8000);

	cryptoWorker = new CryptoWorker();
	const api = Comlink.wrap(cryptoWorker);
	const verifyBatch = (events) => api.batchVerify(events);
	verifyBatchFn = verifyBatch;

	publisher = createPublisher(connection);
	connection.addMessageHandler(publisher.handleMessage);

	await runBootstrap(connection, pubkeyHex, { verifyBatch });
	await rebuildContactsAndGroups(pubkeyHex, privKey);
	await rebuildEffectivePermissions(pubkeyHex, privKey);

	await startIncrementalSync(connection, pubkeyHex, {
		verifyBatch,
		onCaughtUp: () => {
			synced.value = true;
		},
		onEvent: async (addedCount) => {
			if (addedCount > 0) {
				await rebuildContactsAndGroups(pubkeyHex, privKey);
				await rebuildEffectivePermissions(pubkeyHex, privKey);
			}
		},
	});
}

// Идемпотентно — singleton-соединение на вкладку. Смена identity (logout/login
// другим аккаунтом в той же вкладке) корректно рвёт старое соединение вместо
// того, чтобы молча продолжать синхронизацию под чужим pubkey-фильтром.
export async function ensureConnected(pubkeyHex, privKey) {
	if (connectPromise && connectedForPubkey === pubkeyHex) return connectPromise;

	teardown();
	connectedForPubkey = pubkeyHex;
	connectPromise = connect(pubkeyHex, privKey).catch((e) => {
		connectPromise = null; // не кэшировать провал — следующий вызов вправе повторить попытку
		throw e;
	});
	return connectPromise;
}

export async function publish(event) {
	if (!publisher) {
		throw new Error("нет активного соединения — вызовите ensureConnected() перед publish()");
	}
	return publisher.publish(event);
}

// Единый Lamport-счётчик на сессию (TECH.md §4.4) — НЕ создаётся заново в каждом
// компоненте/вызове, иначе несколько независимых счётчиков нарушат причинный порядок
// между permission-событиями (PermissionEditor монтируется многократно — по разу на
// контакт/группу). Ленивая инициализация: computeInitialLamportValue() читает
// фактические данные при первом обращении, не доверяет только persisted-значению
// (тот же принцип, что lamport.js, этап 19).
let lamportClock = null;

export async function nextLamportTick() {
	if (!lamportClock) {
		lamportClock = createLamportClock(await computeInitialLamportValue());
	}
	const value = lamportClock.tick();
	await persistLamportValue(value);
	return value;
}

// F-CT-04 (запрос профиля при добавлении контакта) — сознательно отложено в этапе 22
// на "UI/orchestration слой, этап 23" (см. CONTRACTS.md). Одноразовый REQ+EOSE (не
// постоянная подписка) по kind 0 для набора pubkey; kind 0 replaceable — relay сам
// отдаёт только последнюю версию на каждого автора, клиентский pickLatest не нужен.
// Известное ограничение MVP: relay-pool.js не даёт removeMessageHandler — обработчик
// этого одноразового запроса остаётся в цепочке до конца сессии (дёшево — сверяет
// subId и пропускает дальше); вызывается только для ЕЩЁ не закэшированных контактов,
// не поллингом, поэтому число вызовов за сессию ограничено количеством новых контактов.
export async function fetchProfiles(pubkeys) {
	if (pubkeys.length === 0) return new Map();
	if (!connection) {
		// throw, не пустой Map — вызывающий код (ensureProfilesFetched) не должен
		// закэшировать "профиль не найден" только потому, что соединения ещё нет
		throw new Error("нет активного соединения — вызовите ensureConnected() перед fetchProfiles()");
	}
	const results = new Map();
	const subId = "profiles-" + Math.random().toString(36).slice(2);

	await new Promise((resolve) => {
		const subscriber = createSubscriber(connection, {
			verifyBatch: verifyBatchFn,
			onBatch: (events) => {
				for (const event of events) {
					try {
						results.set(event.pubkey, parseProfileEvent(event));
					} catch {
						// повреждённый/не-JSON профиль чужого клиента — пропустить, не ронять весь fetch
					}
				}
			},
			onEose: () => {
				subscriber.unsubscribe(subId);
				resolve();
			},
		});
		connection.addMessageHandler(subscriber.handleMessage);
		subscriber.subscribe(subId, [{ authors: pubkeys, kinds: [0] }]);
	});

	return results;
}
