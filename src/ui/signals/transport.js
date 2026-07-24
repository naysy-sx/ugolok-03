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
import { CONTACT_REQUEST_KIND, parseContactRequestRumor, CONTACT_ACCEPTED_KIND, ACQUAINT_CANCELLED_KIND } from "../../domain/contacts/requests.js";
import { DISCOVERY_KIND, parseDiscoveryEvent } from "../../domain/discovery/discovery.js";
import {
	acceptWelcome,
	ensureOwnKeyPackagePublished,
	receiveGroupMessageEvent,
	upsertMessage,
} from "../../domain/messaging/chat.js";
import { syncDeviceMembership } from "../../domain/messaging/devices.js";
import { decryptMirrorPayload, buildMirroredMessageRow, KIND_MESSAGE_MIRROR } from "../../domain/messaging/mirror.js";
import { deriveMasterSecret, deriveMirrorKey } from "../../core/crypto/derivation.js";
import { isKnownContact, storeInboxRequest } from "../../domain/messaging/inbox-requests.js";
import { applyIncomingDeletionIfMarker } from "../../domain/messaging/deletions.js";
import { applyIncomingEditIfMarker } from "../../domain/messaging/edits.js";
import { bumpMessagingActivity } from "./chats.js";
import { profiles, addContactAction } from "./contacts.js";
import { receiveChannelKeyGrant, receiveChannelMetadata, receiveAllowlistUpdate } from "../../domain/content/channel.js";
import { receivePost } from "../../domain/content/post.js";
import { receiveComment } from "../../domain/content/comments.js";
import { receiveChannelMessage } from "../../domain/content/channel-chat.js";
import { CHANNEL_SUBSCRIBE_REQUEST_KIND, handleIncomingSubscribeRequest } from "../../domain/content/channel-access.js";
import { CHANNEL_REPORT_KIND, CHANNEL_BAN_KIND, receiveReport, receiveBanAnnouncement } from "../../domain/content/moderation.js";
import { loadUiSettings, rebuildUiSettings } from "../../domain/settings/ui-settings.js";
import { rebuildReadStatus } from "../../domain/messaging/read-status.js";
import { notify } from "../../domain/notifications/notifier.js";
import { drain } from "../../core/store/outbox.js";
import { ensureProfilePublished } from "../../domain/identity/profile.js";
import { currentUser } from "./auth.js";
import { toEncryptedRow } from "../../core/store/encrypted-table.js";
import { CONTACT_REQUESTS_PLAINTEXT_FIELDS } from "../../core/store/table-fields.js";

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

// AC-09 — auto-drain: вызывается и при первом подключении (явно, после создания
// publisher — на этот момент onStateChange уже мог отстреляться с publisher===null),
// и при каждом авто-reconnect relay-pool.js после обрыва связи (через onStateChange).
// Fire-and-forget — не должен блокировать остальной connect()/reconnect-flow; сбой
// (relay снова недоступен посреди попытки) проглатывается, не валит вызывающий код.
async function drainOutboxSafely(publish, dbKey) {
	try {
		const { sentCount } = await drain(async (record) => {
			const result = await publish(record.event);
			if (result.ok) {
				await db.table("messages").where("id").equals(record.eventId).modify({ status: "sent" });
			}
			return result;
		}, dbKey);
		if (sentCount > 0) bumpMessagingActivity();
	} catch (e) {
		console.warn("drainOutboxSafely: не удалось опустошить outbox", e);
	}
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

async function connect(pubkeyHex, privKey, dbKey) {
	assertValidPubkeyHex(pubkeyHex);
	// Этап 34 — найденное решение (бутстрап-проблема): активный relay нужен ДО того, как
	// можно что-либо получить С relay (включая kind 30072 с синхронизированным списком).
	// Локальный кэш — источник истины для ТЕКУЩЕГО подключения; build-time дефолт —
	// только фолбэк на первый запуск, пока локальной записи ещё нет вовсе.
	const localSettings = await loadUiSettings(pubkeyHex, dbKey);
	const relayUrl = localSettings.activeRelayUrl ?? DEFAULT_RELAYS[0] ?? "ws://127.0.0.1:7777";
	connection = createRelayConnection(relayUrl, {
		onStateChange: (s) => {
			connState.value = s;
			// Повторное подключение после обрыва (relay-pool.js's autoReconnect) —
			// publisher уже существует на этот момент (пережил обрыв, message-
			// handler'ы не сбрасываются). На САМОМ первом "connected" publisher
			// ещё null — этот случай покрыт явным вызовом ниже, после его создания.
			if (s === "connected" && publisher) drainOutboxSafely(publisher.publish, dbKey);
		},
	});
	connection.connect();
	await waitForConnState(connection, (s) => s === "connected", 8000);

	cryptoWorker = new CryptoWorker();
	const api = Comlink.wrap(cryptoWorker);
	const verifyBatch = (events) => api.batchVerify(events);
	verifyBatchFn = verifyBatch;

	publisher = createPublisher(connection);
	connection.addMessageHandler(publisher.handleMessage);
	drainOutboxSafely(publisher.publish, dbKey);

	await runBootstrap(connection, pubkeyHex, { verifyBatch });
	await rebuildContactsAndGroups(pubkeyHex, privKey, dbKey);
	await rebuildEffectivePermissions(pubkeyHex, privKey);
	await rebuildUiSettings(pubkeyHex, privKey, dbKey);
	// AC-06 (TECH.md §15) — read-status обязан синхронизироваться между устройствами;
	// до этого вызова foldReadStatus срабатывала ТОЛЬКО на устройстве, опубликовавшем
	// kind 30070, второе устройство той же identity никогда не читало его обратно.
	await rebuildReadStatus(pubkeyHex, privKey, dbKey);
	await ensureOwnKeyPackagePublished(pubkeyHex, privKey, dbKey, publisher.publish);
	// Этап 37 — свежезарегистрированный пользователь иначе не разослал бы имя
	// вовсе, пока сам не тронет вкладку "Био". Идемпотентно (локальный флаг),
	// best-effort (сбой сети не блокирует остальной connect()).
	if (currentUser.value?.login) {
		await ensureProfilePublished(pubkeyHex, currentUser.value.login, privKey, publisher.publish);
	}

	// DESIGN.md, этап 25, раздел 1 — распознать sibling-устройства этой identity
	// (уже опубликованные kind 443 с тегом device, включая исторические — тот же
	// authors:[я] поток, что и остальной bootstrap) и добавить в активные MLS-группы.
	await syncDeviceMembership(pubkeyHex, privKey, dbKey, publisher.publish, () => fetchOwnKeyPackageAnnounces(pubkeyHex));

	// DESIGN.md, этап 25, раздел 2 — зеркало истории: подтянуть всё, что мои другие
	// устройства (или я сам на предыдущей сессии) уже зеркалировали, чтобы новое/
	// переподключившееся устройство получило полный паритет истории чатов.
	const mirrorKey = deriveMirrorKey(deriveMasterSecret(privKey));
	await syncMirroredHistory(pubkeyHex, mirrorKey, dbKey);

	// DESIGN.md, этап 24, п.6 — ПЕРВАЯ в проекте подписка не по "authors: [я]",
	// а по адресату: входящие gift wrap (kind 1059, #p: [я]). Один REQ, диспетчеризация
	// по kind развёрнутого rumor — Welcome (444, MLS) и contact-request (3001) делят
	// один и тот же механизм доставки (NIP-59), не два разных.
	const giftWrapSubscriber = createSubscriber(connection, {
		verifyBatch,
		onBatch: async (events) => {
			const settings = await loadUiSettings(pubkeyHex, dbKey);
			// НАЙДЕНО ЖИВЫМ ЗАМЕРОМ (этап 34, AC-12): bumpMessagingActivity() на КАЖДОЕ
			// событие батча триггерит React/Preact useEffect в открытых экранах (напр.
			// contacts.jsx перечитывает всю таблицу на каждый бамп) — при батче в 1000
			// событий это O(N²) поведение (N перечитываний растущей таблицы), а не N
			// независимых O(1) операций. Один бамп на весь батч даёт ТОТ ЖЕ эффект
			// с точки зрения UI (экран узнаёт "что-то обновилось"), но за O(N), не O(N²).
			let activityChanged = false;
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
							await acceptWelcome(pubkeyHex, dbKey, welcomeContactPubkey, decodeBase64(rumor.content));
							await refreshGroupMessageSubscription(pubkeyHex, privKey, dbKey, publisher.publish);
						} else {
							await storeInboxRequest(pubkeyHex, dbKey, welcomeContactPubkey, decodeBase64(rumor.content), rumor.created_at);
						}
						activityChanged = true; // этап 27, находка 2 — UI (chat.jsx) узнаёт о новом Welcome/inbox-запросе
					} else if (rumor.kind === CONTACT_REQUEST_KIND) {
						const parsed = parseContactRequestRumor(rumor);
						await db.table("contactRequests").put(
							toEncryptedRow(
								{
									owner: pubkeyHex,
									senderPubkey: parsed.senderPubkey,
									greeting: parsed.greeting,
									createdAt: parsed.createdAt,
								},
								CONTACT_REQUESTS_PLAINTEXT_FIELDS,
								dbKey,
							),
						);
						notify(settings, "contacts", "newRequests", { title: "Новый запрос в контакты", body: parsed.greeting || "" });
						activityChanged = true; // этап 27, находка 2 — contacts.jsx узнаёт о новом запросе
					} else if (rumor.kind === CONTACT_ACCEPTED_KIND) {
						// Этап 34 — сигнал "мой запрос приняли" (найденный пробел, см. requests.js).
						notify(settings, "contacts", "accepted", { title: "Запрос принят", body: "Ваш запрос в контакты приняли" });
						// НАЙДЕНО ЖИВЫМ E2E (этап 46): sendAcquaintanceRequestAction (в отличие
						// от sendContactRequestAction, форма "Добавить контакт") НЕ добавляет
						// адресата в контакты оптимистично при отправке (инвариант DESIGN.md) —
						// без этой строки принявший так и оставался бы НЕ контактом у отправителя,
						// и его карточка не пропадала бы из "Обзора" (contacts-фильтр в discovery.js
						// не сработал бы). Идемпотентно для старого flow (там уже добавлен).
						await addContactAction(pubkeyHex, privKey, rumor.pubkey, publisher.publish);
						// Приняли МОЮ заявку из "Обзора" (если она оттуда была) — pending-запись
						// больше не актуальна.
						await db.table("outgoingAcquaintanceRequests").delete([pubkeyHex, rumor.pubkey]);
						activityChanged = true; // discovery.jsx/contacts.jsx узнают, что заявка закрылась
					} else if (rumor.kind === ACQUAINT_CANCELLED_KIND) {
						// Этап 46 — отправитель отозвал СВОЮ ещё не принятую заявку (DESIGN.md,
						// переход pending--CANCELLED_BY(A)-->none). rumor.pubkey — аутентичный
						// отправитель из unwrap, не из тега.
						await db.table("contactRequests").delete([pubkeyHex, rumor.pubkey]);
						activityChanged = true; // contacts.jsx узнаёт, что входящая заявка исчезла
					} else if (rumor.kind === CHANNEL_SUBSCRIBE_REQUEST_KIND) {
						// Этап 30 — владелец канала автоматически подтверждает COMMENT-доступ
						// (group-видимость уже была его решением при создании канала).
						const channelIdTag = rumor.tags.find((t) => t[0] === "channel_id");
						if (channelIdTag) {
							await handleIncomingSubscribeRequest(pubkeyHex, privKey, dbKey, channelIdTag[1], rumor.pubkey, publisher.publish);
						}
						activityChanged = true; // channels.jsx узнаёт о новом подписчике
					} else if (rumor.kind === CHANNEL_REPORT_KIND) {
						// Этап 33 — жалоба/авто-репорт игнора, приватно владельцу. reporterPubkey —
						// ИЗ unwrap (rumor.pubkey), не из тега (тот же принцип, что везде).
						await receiveReport(pubkeyHex, dbKey, {
							reporterPubkey: rumor.pubkey,
							channelId: rumor.tags.find((t) => t[0] === "channel_id")?.[1],
							targetPubkey: rumor.tags.find((t) => t[0] === "target")?.[1],
							contentType: rumor.tags.find((t) => t[0] === "content_type")?.[1],
							contentId: rumor.tags.find((t) => t[0] === "content_id")?.[1],
							contentText: rumor.content,
							reason: rumor.tags.find((t) => t[0] === "reason")?.[1],
							createdAt: rumor.created_at,
						});
						// "moderation" — единственная категория, игнорирующая тумблеры целиком
						// (мокап: "предупреждения, бан и удаление канала показываются всегда").
						notify(settings, "moderation", null, { title: "Новая жалоба", body: rumor.content || "" });
						activityChanged = true; // ModerationPanel узнаёт о новой жалобе
					}
					// иначе — будущий kind, discard
				} catch {
					// ошибка обработки конкретного rumor (напр. Welcome уже применён гонкой) — не ронять батч
				}
			}
			if (activityChanged) bumpMessagingActivity();
		},
	});
	connection.addMessageHandler(giftWrapSubscriber.handleMessage);
	giftWrapSubscriber.subscribe("incoming-giftwrap", [{ "#p": [pubkeyHex], kinds: [1059] }]);

	// Подписка на входящие kind 445 (Group Message) — по #h, не по authors (эфемерный
	// отправитель на каждое сообщение, NIP-EE). Восстанавливает уже установленные чаты
	// после reload; refreshGroupMessageSubscription (вызывается и выше, при Welcome)
	// обновляет фильтр, когда появляется новый чат.
	await refreshGroupMessageSubscription(pubkeyHex, privKey, dbKey, publisher.publish);

	// Этап 30 — восстановление подписок на VIEW-гранты/контент каналов после
	// reload/переподключения, тот же принцип, что refreshGroupMessageSubscription выше.
	await refreshChannelGrantSubscription(pubkeyHex, privKey, dbKey);
	await refreshChannelContentSubscription(pubkeyHex, dbKey);

	await startIncrementalSync(connection, pubkeyHex, {
		verifyBatch,
		onCaughtUp: () => {
			synced.value = true;
		},
		onEvent: async (addedCount) => {
			if (addedCount > 0) {
				await rebuildContactsAndGroups(pubkeyHex, privKey, dbKey);
				await rebuildEffectivePermissions(pubkeyHex, privKey);
			}
		},
	});
}

// Идемпотентно — singleton-соединение на вкладку. Смена identity (logout/login
// другим аккаунтом в той же вкладке) корректно рвёт старое соединение вместо
// того, чтобы молча продолжать синхронизацию под чужим pubkey-фильтром.
export async function ensureConnected(pubkeyHex, privKey, dbKey) {
	if (connectPromise && connectedForPubkey === pubkeyHex) return connectPromise;

	teardown();
	connectedForPubkey = pubkeyHex;
	connectPromise = connect(pubkeyHex, privKey, dbKey).catch((e) => {
		connectPromise = null; // не кэшировать провал — следующий вызов вправе повторить попытку
		throw e;
	});
	return connectPromise;
}

// Этап 34 — явное переподключение после смены активного relay в настройках. Полный
// разрыв (teardown) + сброс кэша ensureConnected, чтобы новый connect() не вернул
// старый connectPromise для того же pubkeyHex — connect() сам прочитает уже сохранённый
// новый activeRelayUrl из локального кэша. Вызывающий UI-код (profile.jsx/settings.jsx)
// обязан вызвать это САМ после setActiveRelayUrl — не скрытый побочный эффект внутри
// доменной функции (CONTRACTS.md, этап 34).
export async function reconnectWithNewSettings(pubkeyHex, privKey, dbKey) {
	teardown();
	connectedForPubkey = null;
	connectPromise = null;
	return ensureConnected(pubkeyHex, privKey, dbKey);
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
// lamportClockOwner (найдено реальным использованием, мультиаккаунт в разных вкладках
// ОДНОГО браузера/origin — тот же класс пробела, что owner-scoping messages/mlsGroups
// на этапе 25): без сброса при смене владельца этот module-level singleton пережил бы
// логин ДРУГИМ локальным аккаунтом в той же вкладке — второй пользователь получал бы
// тики, продолжающие счётчик первого.
let lamportClock = null;
let lamportClockOwner = null;

async function ensureLamportClock(ownerPubkey) {
	if (!lamportClock || lamportClockOwner !== ownerPubkey) {
		lamportClock = createLamportClock(await computeInitialLamportValue(ownerPubkey));
		lamportClockOwner = ownerPubkey;
	}
	return lamportClock;
}

export async function nextLamportTick(ownerPubkey) {
	const clock = await ensureLamportClock(ownerPubkey);
	const value = clock.tick();
	await persistLamportValue(ownerPubkey, value);
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
export async function receiveLamportTick(ownerPubkey, remoteLamportTs) {
	const clock = await ensureLamportClock(ownerPubkey);
	const value = clock.receive(remoteLamportTs);
	await persistLamportValue(ownerPubkey, value);
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

// Этап 46 — раздел "Обзор". Тот же одноразовый REQ+EOSE паттерн, что fetchProfiles,
// но БЕЗ authors — первая широкая (не по конкретным pubkey) подписка в проекте:
// известное ограничение, не масштабируется без пагинации за пределы локальной сети/
// альфы (CONTRACTS.md, этап 46). content — от ЛЮБОГО чужого нетрастед pubkey,
// parseDiscoveryEvent сама защищается от мусора, но JSON.parse внутри неё может
// бросить на невалидном JSON — try/catch здесь же, тот же принцип, что fetchProfiles.
export async function fetchDiscoveryProfiles() {
	if (!connection) {
		throw new Error("нет активного соединения — вызовите ensureConnected() перед fetchDiscoveryProfiles()");
	}
	const subId = "discovery-" + Math.random().toString(36).slice(2);

	await new Promise((resolve) => {
		const subscriber = createSubscriber(connection, {
			verifyBatch: verifyBatchFn,
			onBatch: async (events) => {
				for (const event of events) {
					try {
						const parsed = parseDiscoveryEvent(event);
						await db.table("discoveryProfiles").put({ pubkey: event.pubkey, ...parsed, updatedAt: event.created_at });
					} catch {
						// повреждённый/не-JSON discovery-broadcast чужого клиента — пропустить
					}
				}
			},
			onEose: () => {
				subscriber.unsubscribe(subId);
				resolve();
			},
		});
		connection.addMessageHandler(subscriber.handleMessage);
		subscriber.subscribe(subId, [{ kinds: [DISCOVERY_KIND] }]);
	});
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

let channelGrantSubscriber = null;

// Этап 30 — kind 30053 (VIEW-грант), тег #p: [я]. Постоянная подписка (тот же принцип,
// что refreshLiveProfileSubscription) — грант может прийти в любой момент (владелец
// добавил тебя в видимую группу уже ПОСЛЕ того, как ты открыл приложение).
export async function refreshChannelGrantSubscription(ownerPubkey, privKey, dbKey) {
	if (!connection) return;
	if (!channelGrantSubscriber) {
		channelGrantSubscriber = createSubscriber(connection, {
			verifyBatch: verifyBatchFn,
			onBatch: async (events) => {
				// НАЙДЕНО ЖИВЫМ ЗАМЕРОМ (этап 34, AC-12) — тот же класс находки, что
				// giftWrapSubscriber выше: refreshChannelContentSubscription (Dexie-запрос
				// + REQ-переподписка на relay) и bumpMessagingActivity на КАЖДЫЙ грант — при
				// батче из N грантов это N лишних REQ-циклов вместо одного. Один раз после
				// всего батча достаточно (topics всё равно читаются заново целиком).
				let gotNewGrant = false;
				for (const event of events) {
					try {
						await receiveChannelKeyGrant(ownerPubkey, privKey, dbKey, event.pubkey, event);
						gotNewGrant = true;
					} catch {
						// не мой грант / повреждён — пропустить, не ронять батч
					}
				}
				if (gotNewGrant) {
					// Новый канал стал известен (получен channelTopic) — переподписка на
					// контент (kind 30060/30054) обязана подхватить его topic немедленно,
					// иначе метаданные/allowlist этого канала не придут до следующего
					// перезахода (тот же класс находки, что этап 27-довесок-7 для профилей).
					await refreshChannelContentSubscription(ownerPubkey, dbKey);
					bumpMessagingActivity(); // channels.jsx узнаёт о новом "Доступном" канале
				}
			},
		});
		connection.addMessageHandler(channelGrantSubscriber.handleMessage);
	}
	channelGrantSubscriber.subscribe("channel-grants", [{ "#p": [ownerPubkey], kinds: [30053] }]);
}

let channelContentSubscriber = null;

// Этап 30 — kind 30060 (метаданные, channelKey-зашифрованные, replaceable) и kind 30054
// (comment allowlist) по known channelTopics. Топики меняются со временем (новые
// каналы/гранты) — переподписка тем же subId идемпотентна, тот же приём, что
// groupMessageSubscriber/profileSubscriber выше. Фильтр по тегу `h` (НЕ `channel` —
// найдено живым прогоном против strfry: NIP-12 индексирует только ОДНОБУКВЕННЫЕ теги,
// `{"#channel": [...]}` relay буквально отклоняет как "unindexed tag filter" — TECH.md
// исходно предлагал многобуквенный тег "channel", это протокольная ошибка спецификации,
// не домысел; `h` — тот же однобуквенный routing-тег, что уже используется для MLS-групп
// kind 445, естественное расширение того же паттерна на kind 30060/30061/30062/30054).
export async function refreshChannelContentSubscription(ownerPubkey, dbKey) {
	if (!connection) return;
	const topics = (await db.table("channels").where("ownerPubkey").equals(ownerPubkey).toArray()).map((r) => r.channelTopic);
	if (topics.length === 0) return;

	if (!channelContentSubscriber) {
		channelContentSubscriber = createSubscriber(connection, {
			verifyBatch: verifyBatchFn,
			onBatch: async (events) => {
				const settings = await loadUiSettings(ownerPubkey, dbKey);
				let activityChanged = false; // этап 34, AC-12 — см. giftWrapSubscriber выше
				for (const event of events) {
					try {
						if (event.kind === 30060) {
							await receiveChannelMetadata(ownerPubkey, dbKey, event);
						} else if (event.kind === 30054) {
							await receiveAllowlistUpdate(ownerPubkey, dbKey, ownerPubkey, event);
						} else if (event.kind === 30061) {
							// Этап 31 — receivePost сама проверяет авторство (event.pubkey ===
							// creatorPubkey, DESIGN.md формализация 2) — здесь только диспетчеризация.
							const applied = await receivePost(ownerPubkey, dbKey, event);
							// Не своё же эхо (я — владелец, вижу свой опубликованный пост через ту же
							// подписку по topic) — уведомление только на ЧУЖОЙ, т.е. буквально всегда
							// (пост может быть только от владельца, а не-владелец не пишет посты), но
							// проверка event.pubkey оставлена явной — дешевле, чем гадать по роли.
							if (applied && event.pubkey !== ownerPubkey) {
								notify(settings, "channels", "newPosts", { title: "Новый пост в канале", body: "" });
							}
						} else if (event.kind === 30062) {
							// Комментарии — вне скоупа уведомлений (мокап не содержит такого пункта
							// в дереве "Каналы", только "Новые посты"/"Сообщения в чате канала").
							await receiveComment(ownerPubkey, dbKey, event);
						} else if (event.kind === 30063) {
							// Этап 32 — receiveChannelMessage сама проверяет COMMENT-allowlist
							// (тот же принцип, что receiveComment) — здесь только диспетчеризация.
							const applied = await receiveChannelMessage(ownerPubkey, dbKey, event);
							if (applied && event.pubkey !== ownerPubkey) {
								notify(settings, "channels", "chatMessages", { title: "Новое сообщение в чате канала", body: "" });
							}
						} else if (event.kind === CHANNEL_BAN_KIND) {
							// Этап 33 — receiveBanAnnouncement сама проверяет авторство владельца
							// (DESIGN.md, "Приём kind 30064") — здесь только диспетчеризация.
							const applied = await receiveBanAnnouncement(ownerPubkey, dbKey, event);
							if (applied && event.pubkey !== ownerPubkey) {
								notify(settings, "moderation", null, { title: "Модерация канала", body: "Изменения в канале — см. вкладку Модерация" });
							}
						}
						activityChanged = true; // channels.jsx/channel.jsx перечитывают списки
					} catch {
						// повреждено/эпоха неизвестна и т.п. — пропустить, не ронять батч
					}
				}
				if (activityChanged) bumpMessagingActivity();
			},
		});
		connection.addMessageHandler(channelContentSubscriber.handleMessage);
	}
	channelContentSubscriber.subscribe("channel-content", [{ "#h": topics, kinds: [30060, 30054, 30061, 30062, 30063, CHANNEL_BAN_KIND] }]);
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
export async function refreshGroupMessageSubscription(ownerPubkey, privKey, dbKey, publish) {
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
				const settings = await loadUiSettings(ownerPubkey, dbKey);
				let activityChanged = false; // этап 34, AC-12 — см. giftWrapSubscriber выше
				for (const event of events) {
					try {
						const receivedResult = await receiveGroupMessageEvent(ownerPubkey, privKey, dbKey, event, publish);
						// Найдено реальным использованием — синхронизация Lamport-часов на входящее
						// (иначе часы двух сторон расходятся, причинный порядок сортировки ломается).
						if (receivedResult) await receiveLamportTick(ownerPubkey, receivedResult.lamportTs);
						// DESIGN.md, "Этап 25", раздел 5 — delete-маркер поверх уже расшифрованного
						// application-message; no-op (false), если это обычное сообщение/control.
						const wasDeletion = await applyIncomingDeletionIfMarker(ownerPubkey, dbKey, event, receivedResult);
						// DESIGN.md, "Этап 27-довесок-6" — edit-маркер, тот же принцип; порядок с
						// deletion неважен (разные префиксы, взаимоисключающие no-op на чужом маркере).
						const wasEdit = await applyIncomingEditIfMarker(ownerPubkey, dbKey, event, receivedResult);
						// Этап 34 — уведомление только на ОБЫЧНОЕ новое сообщение, не на служебные
						// delete/edit-маркеры (иначе пользователь получал бы уведомление на удаление
						// собственного же сообщения собеседником).
						if (receivedResult && !wasDeletion && !wasEdit) {
							notify(settings, "messages", "incoming", { title: "Новое сообщение", body: receivedResult.text });
						}
						activityChanged = true; // этап 27, находка 2 — открытый chat.jsx перечитывает окно
					} catch {
						// не удалось расшифровать/обработать конкретное сообщение — не ронять батч
					}
				}
				if (activityChanged) bumpMessagingActivity();
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
export async function syncMirroredHistory(ownerPubkey, mirrorKey, dbKey) {
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
						// AC-AT-06 — вынесено в mirror.js's buildMirroredMessageRow (юнит-тестируемо
						// отдельно от WebSocket-обвязки, см. mirror.test.js).
						await upsertMessage(buildMirroredMessageRow(ownerPubkey, payload, event.id), dbKey);
						await receiveLamportTick(ownerPubkey, payload.lamportTs);
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
