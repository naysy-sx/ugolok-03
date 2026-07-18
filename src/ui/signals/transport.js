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
import { unwrap as nip59Unwrap } from "../../core/crypto/nip59.js";
import { db } from "../../core/store/database.js";
import { CONTACT_REQUEST_KIND, parseContactRequestRumor } from "../../domain/contacts/requests.js";
import { acceptWelcome, ensureOwnKeyPackagePublished, receiveGroupMessageEvent } from "../../domain/messaging/chat.js";

function decodeBase64(str) {
	return Uint8Array.from(atob(str), (c) => c.charCodeAt(0));
}

export const connState = signal("disconnected");
export const synced = signal(false);

let connection = null;
let publisher = null;
let cryptoWorker = null;
let connectPromise = null;
let connectedForPubkey = null;
let verifyBatchFn = null;
let groupMessageSubscriber = null;

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
	groupMessageSubscriber = null;
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

// Найдено на реальном использовании: невалидный pubkeyHex (напр. нечётной длины)
// добирался незамеченным до REQ-фильтра bootstrap'а и молча ронял соединение
// на стороне relay ("bad req: error parsing authors: uneven size input to
// from_hex") — с точки зрения пользователя это выглядело как необъяснимый
// обрыв, а не ясная ошибка. Проверяем формат СРАЗУ, на входе.
function assertValidPubkeyHex(pubkeyHex) {
	if (typeof pubkeyHex !== "string" || !/^[0-9a-f]{64}$/i.test(pubkeyHex)) {
		throw new Error(`невалидный pubkey (ожидается 64-hex): "${pubkeyHex}"`);
	}
}

async function connect(pubkeyHex, privKey) {
	assertValidPubkeyHex(pubkeyHex);
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
	await ensureOwnKeyPackagePublished(pubkeyHex, privKey, publisher.publish);

	// DESIGN.md, этап 24, п.6 — ПЕРВАЯ в проекте подписка не по "authors: [я]",
	// а по адресату: входящие gift wrap (kind 1059, #p: [я]). Один REQ, диспетчеризация
	// по kind развёрнутого rumor — Welcome (444, MLS) и contact-request (3001) делят
	// один и тот же механизм доставки (NIP-59), не два разных.
	const giftWrapSubscriber = createSubscriber(connection, {
		verifyBatch,
		onBatch: async (events) => {
			for (const event of events) {
				let rumor;
				try {
					rumor = nip59Unwrap(event, privKey);
				} catch {
					continue; // не наш gift wrap / повреждён — пропустить, не ронять остальной батч
				}
				try {
					if (rumor.kind === 444) {
						await acceptWelcome(pubkeyHex, rumor.pubkey, decodeBase64(rumor.content));
						await refreshGroupMessageSubscription(pubkeyHex);
					} else if (rumor.kind === CONTACT_REQUEST_KIND) {
						const parsed = parseContactRequestRumor(rumor);
						await db.table("contactRequests").put({
							owner: pubkeyHex,
							senderPubkey: parsed.senderPubkey,
							greeting: parsed.greeting,
							createdAt: parsed.createdAt,
						});
					}
					// иначе — будущий kind (этапы 25+, напр. inbox-request-сообщения от НЕ-контактов), discard
				} catch {
					// ошибка обработки конкретного rumor (напр. Welcome уже применён гонкой) — не ронять батч
				}
			}
		},
	});
	connection.addMessageHandler(giftWrapSubscriber.handleMessage);
	giftWrapSubscriber.subscribe("incoming-giftwrap", [{ "#p": [pubkeyHex], kinds: [1059] }]);

	// Подписка на входящие kind 445 (Group Message) — по #h, не по authors (эфемерный
	// отправитель на каждое сообщение, NIP-EE). Восстанавливает уже установленные чаты
	// после reload; refreshGroupMessageSubscription (вызывается и выше, при Welcome)
	// обновляет фильтр, когда появляется новый чат.
	await refreshGroupMessageSubscription(pubkeyHex);

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

// Аналог fetchProfiles, но kind 443 (KeyPackage) — одноразовый REQ, throw если
// не найден (chat.js's ensureChatEstablished превращает это в понятную ошибку
// "у контакта нет опубликованного ключа для сообщений").
export async function fetchKeyPackage(pubkeyHex) {
	if (!connection) {
		throw new Error("нет активного соединения — вызовите ensureConnected() перед fetchKeyPackage()");
	}
	let found = null;
	const subId = "keypackage-" + Math.random().toString(36).slice(2);

	await new Promise((resolve) => {
		const subscriber = createSubscriber(connection, {
			verifyBatch: verifyBatchFn,
			onBatch: (events) => {
				for (const event of events) {
					found = decodeBase64(event.content);
				}
			},
			onEose: () => {
				subscriber.unsubscribe(subId);
				resolve();
			},
		});
		connection.addMessageHandler(subscriber.handleMessage);
		subscriber.subscribe(subId, [{ authors: [pubkeyHex], kinds: [443] }]);
	});

	if (!found) {
		throw new Error("у контакта нет опубликованного ключа для сообщений");
	}
	return found;
}

// DESIGN.md, этап 24, п.5 — подписка на входящие kind 445 по #h (не authors —
// отправитель эфемерный на каждое сообщение). Вызывается при коннекте (восстановить
// уже установленные чаты после reload) и при каждом новом Welcome (новый чат).
// Пересоздание REQ с обновлённым списком тегов — простая, не инкрементальная схема (MVP).
export async function refreshGroupMessageSubscription(ownerPubkey) {
	if (!connection) return;
	const groupIds = (await db.table("mlsGroups").toArray()).map((row) => row.groupId);
	if (groupIds.length === 0) return;

	if (!groupMessageSubscriber) {
		groupMessageSubscriber = createSubscriber(connection, {
			verifyBatch: verifyBatchFn,
			onBatch: async (events) => {
				for (const event of events) {
					try {
						await receiveGroupMessageEvent(ownerPubkey, event);
					} catch {
						// не удалось расшифровать/обработать конкретное сообщение — не ронять батч
					}
				}
			},
		});
		connection.addMessageHandler(groupMessageSubscriber.handleMessage);
	}
	groupMessageSubscriber.subscribe("group-messages", [{ "#h": groupIds, kinds: [445] }]);
}
