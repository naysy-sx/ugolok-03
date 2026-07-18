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
import {
	acceptWelcome,
	ensureOwnKeyPackagePublished,
	receiveGroupMessageEvent,
	upsertMessage,
} from "../../domain/messaging/chat.js";
import { syncDeviceMembership } from "../../domain/messaging/devices.js";
import { decryptMirrorPayload, KIND_MESSAGE_MIRROR } from "../../domain/messaging/mirror.js";
import { deriveMasterSecret, deriveMirrorKey } from "../../core/crypto/derivation.js";
import { isKnownContact, storeInboxRequest } from "../../domain/messaging/inbox-requests.js";
import { applyIncomingDeletionIfMarker } from "../../domain/messaging/deletions.js";
import { applyIncomingEditIfMarker } from "../../domain/messaging/edits.js";
import { bumpMessagingActivity } from "./chats.js";
import { profiles } from "./contacts.js";

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

	// DESIGN.md, этап 25, раздел 1 — распознать sibling-устройства этой identity
	// (уже опубликованные kind 443 с тегом device, включая исторические — тот же
	// authors:[я] поток, что и остальной bootstrap) и добавить в активные MLS-группы.
	await syncDeviceMembership(pubkeyHex, privKey, publisher.publish, () => fetchOwnKeyPackageAnnounces(pubkeyHex));

	// DESIGN.md, этап 25, раздел 2 — зеркало истории: подтянуть всё, что мои другие
	// устройства (или я сам на предыдущей сессии) уже зеркалировали, чтобы новое/
	// переподключившееся устройство получило полный паритет истории чатов.
	const mirrorKey = deriveMirrorKey(deriveMasterSecret(privKey));
	await syncMirroredHistory(pubkeyHex, mirrorKey);

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
						// Welcome от МОЕГО ЖЕ identity (rumor.pubkey === я) — это sibling-устройство
						// (DESIGN.md, "Этап 25", раздел 1), не новый контакт: rumor.pubkey не годится
						// как "с кем этот 1:1-чат" (это тоже я) — читаем contactPubkey из тега,
						// который devices.js кладёт именно для этого случая.
						const contactTag = rumor.tags.find((t) => t[0] === "contact");
						const isSibling = rumor.pubkey === pubkeyHex;
						const welcomeContactPubkey = isSibling && contactTag ? contactTag[1] : rumor.pubkey;
						// DESIGN.md, "Этап 25", раздел 4 (AC-IB-01) — Welcome от НЕ-контакта не
						// принимается автоматически: siblings всегда доверены (это я же), уже
						// известные контакты — ожидаемый разговор, настоящий незнакомец — в inbox,
						// без создания MLS-группы, пока пользователь не примет решение явно.
						if (isSibling || (await isKnownContact(pubkeyHex, welcomeContactPubkey))) {
							await acceptWelcome(pubkeyHex, welcomeContactPubkey, decodeBase64(rumor.content));
							await refreshGroupMessageSubscription(pubkeyHex, privKey, publisher.publish);
						} else {
							await storeInboxRequest(pubkeyHex, welcomeContactPubkey, decodeBase64(rumor.content), rumor.created_at);
						}
						bumpMessagingActivity(); // этап 27, находка 2 — UI (chat.jsx) узнаёт о новом Welcome/inbox-запросе
					} else if (rumor.kind === CONTACT_REQUEST_KIND) {
						const parsed = parseContactRequestRumor(rumor);
						await db.table("contactRequests").put({
							owner: pubkeyHex,
							senderPubkey: parsed.senderPubkey,
							greeting: parsed.greeting,
							createdAt: parsed.createdAt,
						});
						bumpMessagingActivity(); // этап 27, находка 2 — contacts.jsx узнаёт о новом запросе
					}
					// иначе — будущий kind, discard
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
	await refreshGroupMessageSubscription(pubkeyHex, privKey, publisher.publish);

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

async function ensureLamportClock() {
	if (!lamportClock) {
		lamportClock = createLamportClock(await computeInitialLamportValue());
	}
	return lamportClock;
}

export async function nextLamportTick() {
	const clock = await ensureLamportClock();
	const value = clock.tick();
	await persistLamportValue(value);
	return value;
}

// НАЙДЕНО РЕАЛЬНЫМ ИСПОЛЬЗОВАНИЕМ (не домысел): receive() (lamport.js, этап 19,
// L1 — уже покрыт юнит-тестами) нигде не вызывался на входящее сообщение — часы
// Алисы и Боба тикали НЕЗАВИСИМО, никогда не синхронизируясь. Из-за этого causally
// более позднее сообщение могло получить МЕНЬШИЙ lamportTs, чем уже отправленное
// сообщение собеседника (если тот дольше молчал/не писал), путая сортировку
// getChatHistory/loadChatWindow (lamportTs, senderPubkey, id) — реальный баг,
// найденный пользователем, не гипотетический. Вызывается на КАЖДОЕ входящее
// (живое kind 445 сообщение и зеркало) — receive() гарантирует value > max(текущий, remote).
export async function receiveLamportTick(remoteLamportTs) {
	const clock = await ensureLamportClock();
	const value = clock.receive(remoteLamportTs);
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

let profileSubscriber = null;

// Найденный баг (пользователь, этап 27-довесок-7): fetchProfiles/refreshProfiles — ОДНОРАЗОВЫЙ
// REQ+EOSE, обновление профиля контакта долетало только при СЛЕДУЮЩЕМ вызове refreshProfiles
// (т.е. при перемонтировании экрана — уйти и вернуться) — на уже открытом экране изменение
// собеседника не появлялось само. Аналог refreshGroupMessageSubscription, но для kind 0:
// ПОСТОЯННАЯ подписка — relay сначала отдаёт текущее состояние (REQ backlog), затем стримит
// НОВЫЕ kind-0 по мере публикации контактами, без переоткрытия экрана.
export async function refreshLiveProfileSubscription(ownerPubkey) {
	if (!connection) return;
	const contactPubkeys = (await db.table("contacts").where("owner").equals(ownerPubkey).toArray()).map((row) => row.pubkey);
	if (contactPubkeys.length === 0) return;

	if (!profileSubscriber) {
		profileSubscriber = createSubscriber(connection, {
			verifyBatch: verifyBatchFn,
			onBatch: (events) => {
				const next = { ...profiles.value };
				let changed = false;
				for (const event of events) {
					try {
						next[event.pubkey] = parseProfileEvent(event);
						changed = true;
					} catch {
						// повреждённый/не-JSON профиль чужого клиента — пропустить, не ронять батч
					}
				}
				if (changed) {
					profiles.value = next;
					bumpMessagingActivity(); // этап 27, находка 2 — открытые экраны перечитывают profiles
				}
			},
		});
		connection.addMessageHandler(profileSubscriber.handleMessage);
	}
	// Повторный вызов (новый контакт добавлен) — тот же приём, что groupMessageSubscriber:
	// переподписка тем же subId идемпотентна и дёшево обновляет набор authors.
	profileSubscriber.subscribe("live-profiles", [{ authors: contactPubkeys, kinds: [0] }]);
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
// privKey/publish (правка контракта этапа 25) — нужны, чтобы receiveGroupMessageEvent
// могло зеркалировать полученное сообщение best-effort (DESIGN.md, "Этап 25", раздел 2).
export async function refreshGroupMessageSubscription(ownerPubkey, privKey, publish) {
	if (!connection) return;
	// НАЙДЕНО РЕАЛЬНЫМ ИСПОЛЬЗОВАНИЕМ (не домысел): .toArray() без фильтра подписывал(ся)
	// на #h ГРУПП ВСЕХ локальных аккаунтов на этом устройстве, не только текущего ownerPubkey.
	const groupIds = (await db.table("mlsGroups").where("ownerPubkey").equals(ownerPubkey).toArray()).map(
		(row) => row.groupId,
	);
	if (groupIds.length === 0) return;

	if (!groupMessageSubscriber) {
		groupMessageSubscriber = createSubscriber(connection, {
			verifyBatch: verifyBatchFn,
			onBatch: async (events) => {
				for (const event of events) {
					try {
						const receivedResult = await receiveGroupMessageEvent(ownerPubkey, privKey, event, publish);
						// Найдено реальным использованием — синхронизация Lamport-часов на входящее
						// (иначе часы двух сторон расходятся, причинный порядок сортировки ломается).
						if (receivedResult) await receiveLamportTick(receivedResult.lamportTs);
						// DESIGN.md, "Этап 25", раздел 5 — delete-маркер поверх уже расшифрованного
						// application-message; no-op (false), если это обычное сообщение/control.
						await applyIncomingDeletionIfMarker(ownerPubkey, event, receivedResult);
						// DESIGN.md, "Этап 27-довесок-6" — edit-маркер, тот же принцип; порядок с
						// deletion неважен (разные префиксы, взаимоисключающие no-op на чужом маркере).
						await applyIncomingEditIfMarker(ownerPubkey, event, receivedResult);
						bumpMessagingActivity(); // этап 27, находка 2 — открытый chat.jsx перечитывает окно
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

// DESIGN.md, этап 25, раздел 1 — one-shot REQ по ВСЕМ kind 443, когда-либо
// опубликованным этой identity (включая собственные устройства) — вход для
// syncDeviceMembership (devices.js). Пустой массив — нормальный случай (аккаунт без
// второго устройства), НЕ throw (в отличие от fetchKeyPackage — отсутствие анонсов
// не ошибка, это просто "устройство пока одно").
export async function fetchOwnKeyPackageAnnounces(ownerPubkey) {
	if (!connection) {
		throw new Error("нет активного соединения — вызовите ensureConnected() перед fetchOwnKeyPackageAnnounces()");
	}
	const announces = [];
	const subId = "own-keypackages-" + Math.random().toString(36).slice(2);

	await new Promise((resolve) => {
		const subscriber = createSubscriber(connection, {
			verifyBatch: verifyBatchFn,
			onBatch: (events) => {
				for (const event of events) {
					try {
						const deviceTag = event.tags.find((t) => t[0] === "device");
						announces.push({
							wireBytes: decodeBase64(event.content),
							deviceId: deviceTag ? deviceTag[1] : undefined,
							eventPubkey: event.pubkey,
						});
					} catch {
						// повреждённый content — пропустить, не ронять весь fetch
					}
				}
			},
			onEose: () => {
				subscriber.unsubscribe(subId);
				resolve();
			},
		});
		connection.addMessageHandler(subscriber.handleMessage);
		subscriber.subscribe(subId, [{ authors: [ownerPubkey], kinds: [443] }]);
	});

	return announces;
}

// DESIGN.md, этап 25, раздел 2 — one-shot REQ по всем зеркалированным сообщениям этой
// identity (kind 446), catch-up для нового/переподключившегося устройства. Расшифровка
// одного события не блокирует остальные (console.warn + skip, не throw на весь батч —
// тот же принцип, что fetchProfiles/парсинг повреждённого профиля).
export async function syncMirroredHistory(ownerPubkey, mirrorKey) {
	if (!connection) {
		throw new Error("нет активного соединения — вызовите ensureConnected() перед syncMirroredHistory()");
	}
	const subId = "mirror-history-" + Math.random().toString(36).slice(2);

	await new Promise((resolve) => {
		const subscriber = createSubscriber(connection, {
			verifyBatch: verifyBatchFn,
			onBatch: async (events) => {
				for (const event of events) {
					try {
						const payload = decryptMirrorPayload(event.content, mirrorKey);
						await upsertMessage({
							ownerPubkey,
							chatId: payload.contactPubkey,
							lamportTs: payload.lamportTs,
							senderPubkey: payload.senderPubkey,
							id: event.id,
							text: payload.text,
							status: "sent",
							msgId: payload.msgId,
						});
						await receiveLamportTick(payload.lamportTs);
					} catch (e) {
						console.warn("syncMirroredHistory: не удалось расшифровать зеркалированное сообщение", e);
					}
				}
			},
			onEose: () => {
				subscriber.unsubscribe(subId);
				resolve();
			},
		});
		connection.addMessageHandler(subscriber.handleMessage);
		subscriber.subscribe(subId, [{ authors: [ownerPubkey], kinds: [KIND_MESSAGE_MIRROR] }]);
	});
}
