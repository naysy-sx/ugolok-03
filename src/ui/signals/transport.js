import { signal } from "@preact/signals";
import * as Comlink from "comlink";
import CryptoWorker from "../../workers/crypto.worker.js?worker&inline";
import { BUILD_DEFAULT_RELAYS as DEFAULT_RELAYS } from "../../config.js";
import { createRelayPool, publishToRelay } from "../../core/transport/relay-pool.js";
import { createPublisher } from "../../core/transport/publisher.js";
import { pickLatest } from "../../core/sync/lww.js";
import { runBootstrap } from "../../core/sync/bootstrap.js";
import { startIncrementalSync } from "../../core/sync/incremental-sync.js";
import { rebuildGroups, rebuildEffectivePermissions } from "../../domain/events/handlers.js";
import { createLamportClock, computeInitialLamportValue, persistLamportValue } from "../../core/sync/lamport.js";
import { createSubscriber } from "../../core/transport/subscriber.js";
import { parseProfileEvent } from "../../domain/identity/profile.js";
import { unwrap as nip59Unwrap } from "../../core/crypto/nip59.js";
import { db } from "../../core/store/database.js";
import { CONTACT_REQUEST_KIND, CONTACT_ACCEPTED_KIND, CONTACT_REJECTED_KIND, ACQUAINT_CANCELLED_KIND } from "../../domain/contacts/requests.js";
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
import { profiles, ensureProfilesFetched, configureContactRuntime, handleIncomingContactRumor, reconcileContactsFromEventLog } from "./contacts.js";
import { navigateFromNotification } from "./notification-nav.js";
import { configureCallRuntime, handleIncomingCallSignal } from "./call.js";
import { CALL_SIGNAL_KIND } from "../../domain/calls/signaling-adapter.js";
import { receiveChannelKeyGrant, receiveChannelMetadata, receiveAllowlistUpdate, receiveChannelDeletion, backfillOwnChannelGrants } from "../../domain/content/channel.js";
import { receivePost } from "../../domain/content/post.js";
import { receiveComment } from "../../domain/content/comments.js";
import { receiveChannelMessage } from "../../domain/content/channel-chat.js";
import { CHANNEL_SUBSCRIBE_REQUEST_KIND, handleIncomingSubscribeRequest } from "../../domain/content/channel-access.js";
import { CHANNEL_REPORT_KIND, CHANNEL_BAN_KIND, receiveReport, receiveBanAnnouncement } from "../../domain/content/moderation.js";
import { loadUiSettings, rebuildUiSettings } from "../../domain/settings/ui-settings.js";
import { buildRelayListEvent } from "../../domain/identity/relay-list.js";
import { buildDmRelayListEvent, parseDmRelayListEvent } from "../../domain/identity/dm-relay-list.js";
import { rebuildReadStatus, isChatContentRead } from "../../domain/messaging/read-status.js";
import { rebuildFilesLog } from "./files.js";
import { FILE_SHARE_GRANT_KIND, FILE_SUBTREE_OP_KIND } from "../../domain/files/share.js";
import { initMounts, activeMountRootIds, handleIncomingShareGrant, handleIncomingSubtreeEvent } from "./mounts.js";
import { rebuildChannelReadStatus, isChannelContentRead } from "../../domain/content/channel-read-status.js";
import { notifyAndLog } from "../../domain/notifications/journal.js";
import { drain } from "../../core/store/outbox.js";
import { ensureProfilePublished, hydrateOwnProfile } from "../../domain/identity/profile.js";
import { bumpProfileActivity } from "./profile.js";
import { currentUser } from "./auth.js";
import { resetSyncLog, logSync } from "./sync-log.js";
import { fromEncryptedRow } from "../../core/store/encrypted-table.js";

function decodeBase64(str) {
	return Uint8Array.from(atob(str), (c) => c.charCodeAt(0));
}

// Этап 47-довесок-3 — "сделай уведомления информативными" (пользователь). Профиль
// может быть ещё не закэширован на момент прихода события (fetchProfiles — сеть) —
// вызывающий код обязан await ensureProfilesFetched([pubkeyHex], fetchProfiles) ДО
// вызова этого хелпера, иначе первое уведомление от нового автора покажет усечённый
// pubkey вместо имени (не идеально, но не хуже, чем остальной UI в том же случае).
function usernameFor(pubkeyHex) {
	const name = profiles.value[pubkeyHex]?.name?.trim();
	return name || `${pubkeyHex.slice(0, 8)}…`;
}

function truncateForNotification(text, maxLength = 120) {
	if (!text) return "";
	return text.length > maxLength ? `${text.slice(0, maxLength)}…` : text;
}

async function channelNameFor(ownerPubkey, dbKey, channelId) {
	if (!channelId) return "неизвестном канале";
	const raw = await db.table("channels").get([ownerPubkey, channelId]);
	const row = raw ? fromEncryptedRow(raw, dbKey) : null;
	return row?.name || "канале без названия";
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

// НАЙДЕНО ПОЛЬЗОВАТЕЛЕМ (этап 47-довесок-4) — "~10 уведомлений на ОДНО сообщение".
// Корень: refreshGroupMessageSubscription/refreshChannelContentSubscription/
// refreshChannelGrantSubscription — ПОСТОЯННЫЕ подписчики (singleton), но subscribe()
// вызывается БЕЗУСЛОВНО на каждый триггер (новое сообщение, новый грант, новый
// подписчик канала — см. chats.js "идемпотентна — дешевле, чем проверять") — REQ с
// тем же subId ЗАСТАВЛЯЕТ relay передоставить ВСЮ историю, матчащую фильтр (обычное
// поведение NIP-01, не протокольный баг). receivePost/receiveComment/
// receiveChannelMessage/receiveGroupMessageEvent возвращают truthy на "успешно
// расшифровано+авторизовано", а НЕ на "это действительно новое" — redelivery старого
// события проходит ВЕСЬ конвейер заново, notify() срабатывает повторно на уже
// виденный контент. Хуже: channelGrantSubscriber на каждый (передоставленный!) грант
// сам вызывает refreshChannelContentSubscription — мультипликативный каскад (N
// грантов × M событий контента). Дедуп по event.id — ОДИН раз, на входе КАЖДОГО
// onBatch, а не патч в каждой receiveX (та же логика в 5 разных местах была бы
// хрупкой). In-memory, сбрасывается на teardown() — не переживает reload/переподключение
// (не нужно: слот открывается заново, начинать с чистого листа — правильно).
const processedEventIds = new Set();

function isNewEvent(eventId) {
	if (processedEventIds.has(eventId)) return false;
	processedEventIds.add(eventId);
	return true;
}

// Этап 60 — кэш обнаруженных inbox-relay (kind:10050) получателей: без него
// КАЖДОЕ сообщение в чате делало бы новый REQ+EOSE round-трип перед попыткой
// доставки. TTL, не "навсегда" — получатель может сменить relay-список в
// любой момент сессии, а наша копия не узнает об этом сама по себе.
const INBOX_RELAY_CACHE_TTL_MS = 5 * 60 * 1000;
const inboxRelayCache = new Map(); // pubkeyHex -> { relays: string[], fetchedAt: number }

function teardown() {
	publisher = null;
	verifyBatchFn = null;
	groupMessageSubscriber = null;
	// Найдено живой проверкой (этап 58 — reconnectWithNewSettings, вызываемый из
	// новой relay-настроек UI, до этого пути редко доходили с уже установленными
	// подписками): эти пять singleton-подписчиков, в отличие от groupMessageSubscriber
	// выше, не сбрасывались здесь — каждый держит closure над СТАРЫМ (уже закрытым
	// после connection.close() ниже) connection/pool. Следующий вызов их refresh*
	// (после нового connect()) видел "уже создан" и переиспользовал протухший
	// объект, чей .send() бросал на закрытом соединении — тот же класс пробела,
	// что уже чинился для groupMessageSubscriber, просто для этих пяти не был
	// закрыт тогда же.
	profileSubscriber = null;
	channelGrantSubscriber = null;
	channelContentSubscriber = null;
	fileShareGrantSubscriber = null;
	fileSubtreeOpSubscriber = null;
	processedEventIds.clear();
	inboxRelayCache.clear();
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
	resetSyncLog();
	logSync("Подключение к серверу…");
	// Этап 34 — найденное решение (бутстрап-проблема): relay-список нужен ДО того, как
	// можно что-либо получить С relay (включая kind 30072 с синхронизированным списком).
	// Локальный кэш — источник истины для ТЕКУЩЕГО подключения; build-time дефолт —
	// только фолбэк на первый запуск, пока локальной записи ещё нет вовсе.
	// Этап 58 — мультирелейный транспорт: пул реализует ТОТ ЖЕ интерфейс, что одно
	// соединение (DESIGN.md, "ключевое архитектурное решение") — весь код ниже,
	// обращающийся к `connection`, не меняется ни строкой.
	const localSettings = await loadUiSettings(pubkeyHex, dbKey);
	const relayEntries = localSettings.relayUrls.length > 0 ? localSettings.relayUrls : [{ url: DEFAULT_RELAYS[0] ?? "ws://127.0.0.1:7777", read: true, write: true }];
	connection = createRelayPool(relayEntries, {
		onStateChange: (s) => {
			connState.value = s;
			// Повторное подключение после обрыва (relay-pool.js's autoReconnect) —
			// publisher уже существует на этот момент (пережил обрыв, message-
			// handler'ы не сбрасываются). На САМОМ первом "connected" publisher
			// ещё null — этот случай покрыт явным вызовом ниже, после его создания.
			if (s === "connected" && publisher) drainOutboxSafely(publish, dbKey);
		},
	});
	connection.connect();
	await waitForConnState(connection, (s) => s === "connected", 8000);
	logSync("Подключение к серверу — готово");

	cryptoWorker = new CryptoWorker();
	const api = Comlink.wrap(cryptoWorker);
	const verifyBatch = (events) => api.batchVerify(events);
	verifyBatchFn = verifyBatch;

	publisher = createPublisher(connection);
	connection.addMessageHandler(publisher.handleMessage);
	drainOutboxSafely(publish, dbKey);

	// Этап 48 — голосовая связь: один call-runtime на подключение (тот же принцип,
	// что configureDefaultBackend в app.jsx, этап 47) — publisher.publish уже готов.
	configureCallRuntime({ myPubkey: pubkeyHex, privKey, publish, dbKey });
	// Этап 49 — контакты: один contact-runtime на подключение, тот же принцип.
	// load() внутри себя мигрирует legacy-таблицы (contacts/blockedContacts/
	// contactRequests, отложено до unlock — dbKey недоступен в Dexie upgrade).
	await configureContactRuntime({ ownerPubkey: pubkeyHex, privKey, dbKey, publish });

	logSync("Загрузка истории с сервера…");
	const bootstrapResult = await runBootstrap(connection, pubkeyHex, { verifyBatch });
	logSync(`Загрузка истории — готово (${bootstrapResult.addedCount} новых событий)`);
	logSync("Контакты…");
	await reconcileContactsFromEventLog(pubkeyHex);
	logSync("Контакты — готово");
	logSync("Права доступа…");
	await rebuildGroups(pubkeyHex, privKey, dbKey);
	await rebuildEffectivePermissions(pubkeyHex, privKey);
	logSync("Права доступа — готово");
	logSync("Настройки…");
	await rebuildUiSettings(pubkeyHex, privKey, dbKey);
	logSync("Настройки — готово");
	// Этап 59 — backfill: делает kind:10002 реальным для аккаунтов, заведённых
	// до этапа 59 (relayUrls до сих пор нигде публично не анонсировался, кроме
	// куцего self-check'а diagnostics.jsx). Без флага "announced" (в отличие от
	// этапа 57's file-key backfill) — kind:10002 replaceable (NIP-01) и дешёвый,
	// republish на каждый вход безопасен и идемпотентен по протокольной природе.
	const settingsAfterRebuild = await loadUiSettings(pubkeyHex, dbKey);
	publisher.publish(buildRelayListEvent(privKey, settingsAfterRebuild.relayUrls)).catch(() => {});
	// Этап 60 — тот же backfill-принцип, для kind:10050 (NIP-17, "куда мне
	// присылайте") — только read-relay, см. ui-settings.js's publishRelayList.
	publisher
		.publish(buildDmRelayListEvent(privKey, settingsAfterRebuild.relayUrls.filter((r) => r.read).map((r) => r.url)))
		.catch(() => {});
	logSync("Отметки прочтения…");
	// AC-06 (TECH.md §15) — read-status обязан синхронизироваться между устройствами;
	// до этого вызова foldReadStatus срабатывала ТОЛЬКО на устройстве, опубликовавшем
	// kind 30070, второе устройство той же identity никогда не читало его обратно.
	await rebuildReadStatus(pubkeyHex, privKey, dbKey);
	// Этап 47 — тот же класс кросс-device синхронизации, что AC-06 выше, но для
	// read-tracking каналов (kind 30074), не личных чатов.
	await rebuildChannelReadStatus(pubkeyHex, privKey);
	logSync("Отметки прочтения — готово");
	logSync("Публикация ключа и профиля…");
	await ensureOwnKeyPackagePublished(pubkeyHex, privKey, dbKey, publish);
	// Этап 37 — свежезарегистрированный пользователь иначе не разослал бы имя
	// вовсе, пока сам не тронет вкладку "Био". Идемпотентно (локальный флаг),
	// best-effort (сбой сети не блокирует остальной connect()).
	if (currentUser.value?.login) {
		await ensureProfilePublished(pubkeyHex, currentUser.value.login, privKey, publish);
	}
	logSync("Публикация ключа и профиля — готово");

	logSync("Устройства…");
	// DESIGN.md, этап 25, раздел 1 — распознать sibling-устройства этой identity
	// (уже опубликованные kind 443 с тегом device, включая исторические — тот же
	// authors:[я] поток, что и остальной bootstrap) и добавить в активные MLS-группы.
	await syncDeviceMembership(pubkeyHex, privKey, dbKey, publish, () => fetchOwnKeyPackageAnnounces(pubkeyHex));
	logSync("Устройства — готово");

	logSync("История переписки…");
	// DESIGN.md, этап 25, раздел 2 — зеркало истории: подтянуть всё, что мои другие
	// устройства (или я сам на предыдущей сессии) уже зеркалировали, чтобы новое/
	// переподключившееся устройство получило полный паритет истории чатов.
	const mirrorKey = deriveMirrorKey(deriveMasterSecret(privKey));
	await syncMirroredHistory(pubkeyHex, mirrorKey, dbKey);
	logSync("История переписки — готово");

	// Найдено пользователем (живая проверка — вход с чистого устройства по
	// мнемонике): bootstrap выше уже стянул kind 0 (профиль) в db.events через
	// authors:[я], но ничто не читало его в keystore — avatar/bio оставались
	// пустыми НАВСЕГДА, не временно (не гонка, отдельный пробел). Второе —
	// bumpMessagingActivity()/bumpProfileActivity() здесь ни разу не звучали
	// на этом отрезке: chat.jsx/app.jsx-бейджи перечитывают контакты/непрочитанное
	// ТОЛЬКО по этим сигналам, а до сих пор их бампали только ЖИВЫЕ входящие
	// события (см. ниже) — если экран уже смонтирован (чат/бейдж в сайдбаре
	// видны сразу после логина), его эффект отработал ОДИН раз на ещё пустом
	// состоянии и не перезапускался, даже когда bootstrap выше всё заполнил.
	logSync("Профиль…");
	await hydrateOwnProfile(pubkeyHex);
	logSync("Профиль — готово");
	bumpProfileActivity();
	bumpMessagingActivity();

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
				if (!isNewEvent(event.id)) continue; // redelivery при resubscribe — уже обработан этой сессией
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
							await refreshGroupMessageSubscription(pubkeyHex, privKey, dbKey, publish);
						} else {
							await storeInboxRequest(pubkeyHex, dbKey, welcomeContactPubkey, decodeBase64(rumor.content), rumor.created_at);
							// Этап 47-довесок-3 — найденный пробел: заявка (MLS Welcome) от НЕЗНАКОМЦА
							// раньше попадала в inbox БЕЗ единого уведомления вовсе (только activityChanged,
							// заметно лишь если пользователь уже был на вкладке "Сообщения"). Профиль
							// незнакомца обычно ещё не закэширован — та же оговорка, что usernameFor.
							await ensureProfilesFetched([welcomeContactPubkey], fetchProfiles).catch(() => {});
							await notifyAndLog(pubkeyHex, dbKey, settings, "inbox", null, {
								title: "Новый запрос от незнакомца",
								body: `${usernameFor(welcomeContactPubkey)} хочет написать вам`,
								navTarget: { screen: "messages" },
								onClick: () => navigateFromNotification({ screen: "messages" }),
								occurredAt: rumor.created_at * 1000,
							});
						}
						activityChanged = true; // этап 27, находка 2 — UI (chat.jsx) узнаёт о новом Welcome/inbox-запросе
					} else if (
						rumor.kind === CONTACT_REQUEST_KIND ||
						rumor.kind === CONTACT_ACCEPTED_KIND ||
						rumor.kind === CONTACT_REJECTED_KIND ||
						rumor.kind === ACQUAINT_CANCELLED_KIND
					) {
						// Этап 49 — единая маршрутизация в contact-runtime.js (Map состояний +
						// FSM, contact-fsm.js): I1/I2 внутри reduce() САМИ решают, применять ли
						// событие (redelivery старого/уже решённого — игнор) — раньше именно
						// отсутствие этой проверки здесь было причиной обеих найденных пользователем
						// багов (лавина повторных заявок, дублирование во входящих+контактах).
						// Уведомления теперь идут через LOG_JOURNAL -> onJournal (contacts.js),
						// не отсюда — профиль должен быть закэширован ДО dispatch (там же usernameFor).
						await ensureProfilesFetched([rumor.pubkey], fetchProfiles).catch(() => {});
						await handleIncomingContactRumor(rumor);
						activityChanged = true; // этап 27, находка 2 — contacts.jsx узнаёт об изменении
					} else if (rumor.kind === CHANNEL_SUBSCRIBE_REQUEST_KIND) {
						// Этап 30 — владелец канала автоматически подтверждает COMMENT-доступ
						// (group-видимость уже была его решением при создании канала).
						const channelIdTag = rumor.tags.find((t) => t[0] === "channel_id");
						if (channelIdTag) {
							await handleIncomingSubscribeRequest(pubkeyHex, privKey, dbKey, channelIdTag[1], rumor.pubkey, publish);
						}
						activityChanged = true; // channels.jsx узнаёт о новом подписчике
					} else if (rumor.kind === CHANNEL_REPORT_KIND) {
						// Этап 33 — жалоба/авто-репорт игнора, приватно владельцу. reporterPubkey —
						// ИЗ unwrap (rumor.pubkey), не из тега (тот же принцип, что везде).
						const reportChannelId = rumor.tags.find((t) => t[0] === "channel_id")?.[1];
						await receiveReport(pubkeyHex, dbKey, {
							reporterPubkey: rumor.pubkey,
							channelId: reportChannelId,
							targetPubkey: rumor.tags.find((t) => t[0] === "target")?.[1],
							contentType: rumor.tags.find((t) => t[0] === "content_type")?.[1],
							contentId: rumor.tags.find((t) => t[0] === "content_id")?.[1],
							contentText: rumor.content,
							reason: rumor.tags.find((t) => t[0] === "reason")?.[1],
							createdAt: rumor.created_at,
						});
						// Этап 47 — "reports" единственная moderation-подкатегория, ставшая
						// настраиваемой (бан/warn/delete по-прежнему принудительны, см. notifier.js).
						await notifyAndLog(pubkeyHex, dbKey, settings, "moderation", "reports", {
							title: `Новая жалоба в канале «${await channelNameFor(pubkeyHex, dbKey, reportChannelId)}»`,
							body: truncateForNotification(rumor.content),
							navTarget: { screen: "channels", channelId: reportChannelId, subTab: "moderation" },
							onClick: () => navigateFromNotification({ screen: "channels", channelId: reportChannelId, subTab: "moderation" }),
							occurredAt: rumor.created_at * 1000,
						});
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

	// Этап 48 — сигналинг звонка (kind 20075, эфемерный, NIP-44 напрямую — CONTRACTS.md
	// "Этап 48"). Постоянная подписка, тот же принцип, что giftWrapSubscriber выше —
	// #p:[я], НЕ authors (звонить может любой контакт в любой момент). Дедуп по
	// event.id (isNewEvent) — тот же приём, что везде в этом файле (довесок-4):
	// эфемерные kind relay не обязан хранить, но защита не помешает.
	const callSignalSubscriber = createSubscriber(connection, {
		verifyBatch,
		onBatch: (events) => {
			for (const event of events) {
				if (!isNewEvent(event.id)) continue;
				handleIncomingCallSignal(event);
			}
		},
	});
	connection.addMessageHandler(callSignalSubscriber.handleMessage);
	callSignalSubscriber.subscribe("call-signal", [{ "#p": [pubkeyHex], kinds: [CALL_SIGNAL_KIND] }]);

	// Подписка на входящие kind 445 (Group Message) — по #h, не по authors (эфемерный
	// отправитель на каждое сообщение, NIP-EE). Восстанавливает уже установленные чаты
	// после reload; refreshGroupMessageSubscription (вызывается и выше, при Welcome)
	// обновляет фильтр, когда появляется новый чат.
	await refreshGroupMessageSubscription(pubkeyHex, privKey, dbKey, publish);

	logSync("Каналы…");
	// Этап 30 — восстановление подписок на VIEW-гранты/контент каналов после
	// reload/переподключения, тот же принцип, что refreshGroupMessageSubscription выше.
	await refreshChannelGrantSubscription(pubkeyHex, privKey, dbKey);
	await refreshChannelContentSubscription(pubkeyHex, dbKey);
	// Этап 55 — довыдача self-гранта владельческим каналам, созданным ДО фикса
	// (включая уже существующие реальные каналы) — без этого второе устройство
	// той же личности никогда не расшифрует собственный канал.
	const backfilledChannelCount = await backfillOwnChannelGrants(pubkeyHex, privKey, dbKey, publish);
	if (backfilledChannelCount > 0) {
		logSync(`Каналы: довыдан ключ для ${backfilledChannelCount} канала(ов)`);
	} else {
		logSync("Каналы — без изменений");
	}

	logSync("Файлы…");
	// Этап 53 И6, задача 6.7 — доли: восстанавливает activeMounts ИЗ ХРАНИЛИЩА
	// (не из UI-состояния экрана "Файлы" — тот мог не открываться в этой
	// сессии вовсе) ДО подписки на #h, иначе fileSubtreeOpSubscription не
	// узнает rootId уже смонтированных долей.
	await initMounts(pubkeyHex, dbKey);
	await refreshFileShareGrantSubscription(pubkeyHex, privKey, dbKey);
	await refreshFileSubtreeOpSubscription(pubkeyHex, dbKey);
	logSync("Файлы — готово");

	await startIncrementalSync(connection, pubkeyHex, {
		verifyBatch,
		onCaughtUp: () => {
			synced.value = true;
			logSync("Синхронизация завершена");
			// Инкрементальная синхронизация — отдельный, более поздний рубеж, чем
			// основной bootstrap выше (может донести то, что пришло уже во время
			// него) — тот же бамп, та же причина: экраны/бейджи, смонтированные
			// ДО этого момента, сами не перечитаются.
			bumpMessagingActivity();
			bumpProfileActivity();
		},
		onEvent: async (addedCount) => {
			if (addedCount > 0) {
				await reconcileContactsFromEventLog(pubkeyHex);
				await rebuildGroups(pubkeyHex, privKey, dbKey);
				await rebuildEffectivePermissions(pubkeyHex, privKey);
				// Этап 53 И5 (задача 5.3) — живой фолд журнала операций дерева
				// файлов. Безопасный no-op, если экран "Файлы" ни разу не
				// открывался в этой сессии (CONTRACTS.md — ленивая активация,
				// осознанное отличие от трёх вызовов выше).
				await rebuildFilesLog(pubkeyHex, privKey);
			}
		},
	});
}

// Идемпотентно — singleton-соединение на вкладку. Смена identity (logout/login
// другим аккаунтом в той же вкладке) корректно рвёт старое соединение вместо
// того, чтобы молча продолжать синхронизацию под чужим pubkey-фильтром.
//
// НАЙДЕНО ПОЛЬЗОВАТЕЛЕМ ЖИВЫМ ИСПОЛЬЗОВАНИЕМ (этап 46-довесок): раньше проверялся
// только факт "connectPromise когда-то резолвился" — не РЕАЛЬНОЕ текущее
// состояние соединения. Если WebSocket с тех пор отвалился и снова восстановился
// (autoReconnect relay-pool.js сам чинит его в фоне, с экспоненциальным backoff)
// БЕЗ явного teardown(), возможны два расхождения со старой проверкой: (а)
// connectPromise ещё "жив", но соединение прямо сейчас НЕ "connected" (реконнект
// в процессе) — раньше код уходил на publish()/подписку немедленно и падал с
// "relay-pool: send() недоступен в состоянии 'disconnected'"; (б) connectPromise
// уже сброшен в null где-то ещё, а соединение уже СНОВА "connected" — раньше это
// ошибочно уходило в полный teardown()+connect(), обрывая рабочее соединение
// просто потому, что один флаг не совпал. Проверка ниже основана на РЕАЛЬНОМ
// connection.getState(), а не на связке кэш-флагов.
export async function ensureConnected(pubkeyHex, privKey, dbKey) {
	if (connectedForPubkey === pubkeyHex && connection) {
		if (connection.getState() === "connected") return;
		if (connectPromise) {
			await connectPromise;
			if (connection.getState() === "connected") return;
		}
		await waitForConnState(connection, (s) => s === "connected", 8000);
		return;
	}

	teardown();
	connectedForPubkey = pubkeyHex;
	connectPromise = connect(pubkeyHex, privKey, dbKey).catch((e) => {
		connectPromise = null; // не кэшировать провал — следующий вызов вправе повторить попытку
		throw e;
	});
	return connectPromise;
}

// Этап 34 — явное переподключение после смены relay-настроек. Полный разрыв
// (teardown) + сброс кэша ensureConnected, чтобы новый connect() не вернул
// старый connectPromise для того же pubkeyHex — connect() сам прочитает уже
// сохранённый новый relayUrls из локального кэша (этап 58 — весь список, не
// одно активное). Вызывающий UI-код (profile.jsx) обязан вызвать это САМ
// после addRelayUrl/removeRelayUrl/setRelayRole — не скрытый побочный эффект
// внутри доменной функции (CONTRACTS.md, этап 34).
export async function reconnectWithNewSettings(pubkeyHex, privKey, dbKey) {
	teardown();
	connectedForPubkey = null;
	connectPromise = null;
	return ensureConnected(pubkeyHex, privKey, dbKey);
}

// Этап 60 — one-shot REQ+EOSE по kind:10050 (NIP-17) конкретного pubkey, тот
// же паттерн, что fetchProfiles. pickLatest (не merge нескольких копий) —
// replaceable событие, при запросе через собственный пул (несколько СВОИХ
// read-relay, этап 58) разные relay пула МОГУТ вернуть разные по свежести
// версии одного и того же kind:10050 автора; берём ровно одну, самую свежую.
// Кэш (INBOX_RELAY_CACHE_TTL_MS) — иначе каждое сообщение делало бы новый
// round-трип перед попыткой доставки.
export async function fetchInboxRelays(pubkeyHex) {
	const cached = inboxRelayCache.get(pubkeyHex);
	if (cached && Date.now() - cached.fetchedAt < INBOX_RELAY_CACHE_TTL_MS) return cached.relays;
	if (!connection) {
		throw new Error("нет активного соединения — вызовите ensureConnected() перед fetchInboxRelays()");
	}
	const subId = "inbox-relays-" + Math.random().toString(36).slice(2);
	const collected = [];

	await new Promise((resolve) => {
		const subscriber = createSubscriber(connection, {
			verifyBatch: verifyBatchFn,
			onBatch: (events) => {
				collected.push(...events);
			},
			onEose: () => {
				subscriber.unsubscribe(subId);
				resolve();
			},
		});
		connection.addMessageHandler(subscriber.handleMessage);
		subscriber.subscribe(subId, [{ authors: [pubkeyHex], kinds: [10050] }]);
	});

	const relays = collected.length > 0 ? parseDmRelayListEvent(pickLatest(collected)) : [];
	inboxRelayCache.set(pubkeyHex, { relays, fetchedAt: Date.now() });
	return relays;
}

// Этап 60 — фактическая доставка НА RELAY ПОЛУЧАТЕЛЯ: получатель мог не
// объявить kind:10050 вовсе, или сеть недоступна — best-effort целиком, не
// должно мешать основному publish() на СВОИ relay (см. publish()/
// publishToContact() ниже — вызывается fire-and-forget, не await).
// Не фильтрует relay, уже входящие в собственный список отправителя (см.
// CONTRACTS.md, этап 60 — сознательно, изредка избыточный повторный publish,
// relay дедуплицирует по id).
async function deliverToInboxRelays(recipientPubkeyHex, event) {
	try {
		const relays = await fetchInboxRelays(recipientPubkeyHex);
		await Promise.allSettled(relays.map((url) => publishToRelay(url, event)));
	} catch {
		// получатель не объявил inbox-relay / сеть недоступна — не критично
	}
}

// Правка контракта (этап 60) — сверх публикации на СВОИ relay (поведение не
// изменилось, тот же publisher.publish) теперь дополнительно best-effort
// доставляет на relay получателя, если у события есть тег #p (ЛЮБОЙ такой
// тег — не только gift wrap: kind:1059 несёт #p по протоколу NIP-59 всегда,
// kind:30053 channel VIEW-грант — тоже, см. CONTRACTS.md, этап 60). Не await —
// не должно задерживать/влиять на возврат publish() (AC-09 outbox-путь
// chat.js полагается на его текущий тайминг).
export async function publish(event) {
	if (!publisher) {
		throw new Error("нет активного соединения — вызовите ensureConnected() перед publish()");
	}
	const result = await publisher.publish(event);
	const recipientTag = event.tags?.find((t) => t[0] === "p");
	if (recipientTag) deliverToInboxRelays(recipientTag[1], event);
	return result;
}

// Этап 60 — для kind:445 (MLS group message), у которого НЕТ тега #p
// (адресация по #h группы, эфемерный отправитель — сознательное решение
// этапа 24). Вызывает publisher.publish НАПРЯМУЮ, не через publish() выше —
// иначе Welcome (несёт #p САМ, kind:1059) получил бы двойную доставку.
export async function publishToContact(event, contactPubkeyHex) {
	if (!publisher) {
		throw new Error("нет активного соединения — вызовите ensureConnected() перед publishToContact()");
	}
	const result = await publisher.publish(event);
	deliverToInboxRelays(contactPubkeyHex, event);
	return result;
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
//
// НАЙДЕНО ПОЛЬЗОВАТЕЛЕМ (этап 46-довесок): фильтр БЕЗ authors — ПОЛНЫЙ снимок
// сети на каждый вызов, а не инкрементальное дополнение (в отличие от
// fetchProfiles, где authors — известное подмножество). Раньше put() только
// добавлял/обновлял — событие, пропавшее с relay (автор больше не публикует,
// событие удалено вручную и т.п.), навсегда оставалось в локальном кэше и
// продолжало рисовать карточку. Теперь — реконсиляция: всё, чего НЕ было в
// ЭТОМ полном снимке, удаляется из локального кэша.
export async function fetchDiscoveryProfiles() {
	if (!connection) {
		throw new Error("нет активного соединения — вызовите ensureConnected() перед fetchDiscoveryProfiles()");
	}
	const subId = "discovery-" + Math.random().toString(36).slice(2);
	const seenPubkeys = new Set();

	await new Promise((resolve) => {
		const subscriber = createSubscriber(connection, {
			verifyBatch: verifyBatchFn,
			onBatch: async (events) => {
				for (const event of events) {
					try {
						const parsed = parseDiscoveryEvent(event);
						seenPubkeys.add(event.pubkey);
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

	const cachedPubkeys = await db.table("discoveryProfiles").toCollection().primaryKeys();
	const stalePubkeys = cachedPubkeys.filter((pk) => !seenPubkeys.has(pk));
	if (stalePubkeys.length > 0) {
		await db.table("discoveryProfiles").bulkDelete(stalePubkeys);
	}
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
					if (!isNewEvent(event.id)) continue; // redelivery при resubscribe
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
					// КРИТИЧНО именно здесь (этап 47-довесок-4): без этой проверки redelivery
					// СТАРОГО гранта на resubscribe снова ставил бы gotNewGrant=true и запускал
					// бы refreshChannelContentSubscription — мультипликативный каскад с ним же.
					if (!isNewEvent(event.id)) continue;
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
					if (!isNewEvent(event.id)) continue; // redelivery при resubscribe (этап 47-довесок-4)
					try {
						// Разрешаем channelId по h-тегу ОДИН раз — нужен как entityId для
						// notify() (этап 47, per-channel override) во всех ветках ниже, кроме
						// 30060/30054 (у них своя, более ранняя точка входа без уведомлений).
						// Расшифровываем ЗДЕСЬ, ДО любых мутаций этой итерации (этап 47-довесок-3,
						// найденное — receiveBanAnnouncement ниже может УДАЛИТЬ эту же строку
						// channels, если банят самого owner'а/зрителя; название нужно взять из
						// состояния "до", а не гонять новый запрос "после" и получить пустоту).
						const hTag = event.tags.find((t) => t[0] === "h");
						const channelRowForNotifyRaw = hTag
							? await db.table("channels").where("channelTopic").equals(hTag[1]).and((r) => r.ownerPubkey === ownerPubkey).first()
							: null;
						const channelRowForNotify = channelRowForNotifyRaw ? fromEncryptedRow(channelRowForNotifyRaw, dbKey) : null;
						const channelId = channelRowForNotify?.id;
						const channelName = channelRowForNotify?.name || "канал без названия";

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
							// Этап 50 (N1) — redelivery на релогине/reconnect иначе повторно
							// уведомлял бы о контенте, уже прочитанном (в этой сессии или на
							// другом устройстве) — курсор channelSyncState уже синхронизирован
							// на этот момент (rebuildChannelReadStatus в начале connect()).
							if (applied && event.pubkey !== ownerPubkey && !(await isChannelContentRead(ownerPubkey, channelId, event.created_at))) {
								// postId — тот же приём, что post.js's receivePost (d-tag формата
								// "{channelId}:{postId}", plaintext) — нужен и для чтения только что
								// сохранённого текста (для тела уведомления), и для click-нав.
								const dTag = event.tags.find((t) => t[0] === "d")?.[1];
								const postId = dTag?.slice(dTag.indexOf(":") + 1);
								const postRow = postId ? fromEncryptedRow(await db.table("posts").get([ownerPubkey, postId]), dbKey) : null;
								const navTarget = { screen: "channels", channelId, postId, subTab: "posts" };
								await notifyAndLog(
									ownerPubkey,
									dbKey,
									settings,
									"channels",
									"posts",
									{
										title: `Новый пост в канале «${channelName}»`,
										body: truncateForNotification(postRow?.text),
										navTarget,
										onClick: () => navigateFromNotification(navTarget),
										occurredAt: event.created_at * 1000,
									},
									channelId,
								);
							}
						} else if (event.kind === 30062) {
							// Этап 47 — раньше комментарии были вне скоупа уведомлений вовсе
							// (найденный пробел, CONTRACTS.md). receiveComment сама проверяет
							// COMMENT-allowlist — здесь диспетчеризация + обнаружение "ответили мне".
							const applied = await receiveComment(ownerPubkey, dbKey, event);
							// Этап 50 (N1) — см. пояснение у kind 30061 выше.
							if (applied && event.pubkey !== ownerPubkey && !(await isChannelContentRead(ownerPubkey, channelId, event.created_at))) {
								// commentId парсится из d-тега тем же приёмом, что comments.js's
								// receiveComment (d-tag формата "{postId}:{commentId}", plaintext, без
								// расшифровки) — нужен и для тела уведомления, и для click-нав, и для
								// поиска родителя ниже.
								const dTag = event.tags.find((t) => t[0] === "d")?.[1];
								const commentId = dTag?.slice(dTag.indexOf(":") + 1);
								const storedComment = commentId ? fromEncryptedRow(await db.table("comments").get([ownerPubkey, commentId]), dbKey) : null;
								const commentNavTarget = { screen: "channels", channelId, postId: storedComment?.postId, commentId, subTab: "posts" };
								await notifyAndLog(
									ownerPubkey,
									dbKey,
									settings,
									"channels",
									"comments",
									{
										title: `Комментарий в канале «${channelName}»`,
										body: truncateForNotification(storedComment?.text),
										navTarget: commentNavTarget,
										onClick: () => navigateFromNotification(commentNavTarget),
										occurredAt: event.created_at * 1000,
									},
									channelId,
								);
								// "Ответили МНЕ" — отдельная, обычно более громкая категория (DESIGN.md):
								// родитель (parentId) — либо мой пост, либо мой же комментарий.
								const parentId = storedComment?.parentId;
								if (parentId) {
									const parentPost = await db.table("posts").get([ownerPubkey, parentId]);
									const parentComment = !parentPost ? await db.table("comments").get([ownerPubkey, parentId]) : null;
									const parentAuthor = parentPost
										? fromEncryptedRow(parentPost, dbKey)?.authorPubkey
										: parentComment
											? fromEncryptedRow(parentComment, dbKey)?.authorPubkey
											: null;
									if (parentAuthor === ownerPubkey) {
										await ensureProfilesFetched([event.pubkey], fetchProfiles).catch(() => {});
										await notifyAndLog(ownerPubkey, dbKey, settings, "replies", null, {
											title: `${channelName}: ${usernameFor(event.pubkey)} вам ответил`,
											body: `«${truncateForNotification(storedComment?.text)}»`,
											navTarget: commentNavTarget,
											onClick: () => navigateFromNotification(commentNavTarget),
											occurredAt: event.created_at * 1000,
										});
									}
								}
							}
						} else if (event.kind === 30063) {
							// Этап 32 — receiveChannelMessage сама проверяет COMMENT-allowlist
							// (тот же принцип, что receiveComment) — здесь только диспетчеризация.
							const applied = await receiveChannelMessage(ownerPubkey, dbKey, event);
							// Этап 50 (N1) — см. пояснение у kind 30061 выше.
							if (applied && event.pubkey !== ownerPubkey && !(await isChannelContentRead(ownerPubkey, channelId, event.created_at))) {
								const dTag = event.tags.find((t) => t[0] === "d")?.[1];
								const messageId = dTag?.slice(dTag.indexOf(":") + 1);
								const messageRow = messageId
									? fromEncryptedRow(await db.table("channelMessages").get([ownerPubkey, messageId]), dbKey)
									: null;
								await ensureProfilesFetched([event.pubkey], fetchProfiles).catch(() => {});
								const chatNavTarget = { screen: "channels", channelId, subTab: "chat" };
								await notifyAndLog(
									ownerPubkey,
									dbKey,
									settings,
									"channels",
									"chat",
									{
										title: `Сообщение в чате канала «${channelName}»`,
										body: `${usernameFor(event.pubkey)}: ${truncateForNotification(messageRow?.text)}`,
										navTarget: chatNavTarget,
										onClick: () => navigateFromNotification(chatNavTarget),
										occurredAt: event.created_at * 1000,
									},
									channelId,
								);
							}
						} else if (event.kind === 5) {
							// Этап 50-довесок-2 — владелец удалил канал целиком (kind-5 адресуемое
							// удаление kind 30060). receiveChannelDeletion сама проверяет авторство
							// (двойная сверка — тег И channelRow.creatorPubkey, см. channel.js) и
							// каскадно чистит локальные данные (deleteChannelLocally). Читает имя
							// ДО удаления — нужно для текста уведомления, после звать поздно.
							const deletionResult = await receiveChannelDeletion(ownerPubkey, dbKey, event);
							if (deletionResult.applied) {
								// category "moderation" (не "channels" — там нет подходящей
								// подкатегории под "канал исчез целиком", а notifications.channels.*
								// без записи в settings всегда 'off', см. resolveNotificationLevel) —
								// тот же bucket, что бан ("моё отношение к каналу необратимо
								// изменилось, узнать обязан всегда"), поэтому ВСЕГДА 'sound'.
								const deletedNavTarget = { screen: "channels" };
								await notifyAndLog(ownerPubkey, dbKey, settings, "moderation", "ban", {
									title: `Канал «${deletionResult.channelName}» удалён владельцем`,
									body: "",
									navTarget: deletedNavTarget,
									onClick: () => navigateFromNotification(deletedNavTarget),
									occurredAt: event.created_at * 1000,
								});
							}
						} else if (event.kind === CHANNEL_BAN_KIND) {
							// Этап 33 — receiveBanAnnouncement сама проверяет авторство владельца
							// (DESIGN.md, "Приём kind 30064") — здесь только диспетчеризация. Без
							// N1-гейта — бан не "контент", read-cursor к нему не относится (тот
							// же принцип, что moderation/ban всегда 'sound' независимо от settings).
							const applied = await receiveBanAnnouncement(ownerPubkey, dbKey, event);
							if (applied && event.pubkey !== ownerPubkey) {
								const banNavTarget = { screen: "channels", channelId, subTab: "moderation" };
								await notifyAndLog(ownerPubkey, dbKey, settings, "moderation", "ban", {
									title: `Модерация канала «${channelName}»`,
									body: "Изменения в канале — см. вкладку Модерация",
									navTarget: banNavTarget,
									onClick: () => navigateFromNotification(banNavTarget),
									occurredAt: event.created_at * 1000,
								});
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
	channelContentSubscriber.subscribe("channel-content", [{ "#h": topics, kinds: [30060, 30054, 30061, 30062, 30063, CHANNEL_BAN_KIND, 5] }]);
}

let fileShareGrantSubscriber = null;

// Этап 53 И6, задача 6.7 — FILE_SHARE_GRANT_KIND (тег #p:[я]), буквально
// тот же паттерн, что refreshChannelGrantSubscription выше (постоянная
// подписка, не ленивая активация — доля может прийти в любой момент,
// независимо от того, открыт ли экран "Файлы"). handleIncomingShareGrant
// (mounts.js) сама решает идемпотентность (owner+rootId уже смонтирован ->
// no-op) и переиспользует ЕДИНЫЙ Лампорт-счётчик дерева файлов (files.js's
// экспортированный label()) — без этого два независимых счётчика одного
// дерева (свои операции vs монтирование доли) разошлись бы.
export async function refreshFileShareGrantSubscription(ownerPubkey, privKey, dbKey) {
	if (!connection) return;
	if (!fileShareGrantSubscriber) {
		fileShareGrantSubscriber = createSubscriber(connection, {
			verifyBatch: verifyBatchFn,
			onBatch: async (events) => {
				let gotNewMount = false;
				for (const event of events) {
					if (!isNewEvent(event.id)) continue;
					const beforeCount = activeMountRootIds.value.length;
					// Имя по умолчанию — короткий hex владельца (человекочитаемое имя
					// из контактов — решение UI-слоя при отображении, не здесь;
					// пользователь всегда может переименовать узел-ссылку как любую
					// другую папку, ops.js's rename не меняется).
					await handleIncomingShareGrant(ownerPubkey, privKey, dbKey, event, `Общая папка (${event.pubkey.slice(0, 8)})`);
					if (activeMountRootIds.value.length > beforeCount) gotNewMount = true;
				}
				if (gotNewMount) {
					// Новая доля — переподписка на #h ОБЯЗАНА подхватить её rootId
					// немедленно (тот же принцип, что refreshChannelContentSubscription
					// после нового channel-грантa).
					await refreshFileSubtreeOpSubscription(ownerPubkey, dbKey);
				}
			},
		});
		connection.addMessageHandler(fileShareGrantSubscriber.handleMessage);
	}
	fileShareGrantSubscriber.subscribe("file-share-grants", [{ "#p": [ownerPubkey], kinds: [FILE_SHARE_GRANT_KIND] }]);
}

let fileSubtreeOpSubscriber = null;

// Этап 53 И6, задача 6.7 — FILE_SUBTREE_OP_KIND (тег #h:[rootId,...] всех
// активных долей получателя), тот же паттерн, что refreshChannelContentSubscription
// (топики меняются со временем — новые доли — переподписка тем же subId
// идемпотентна).
export async function refreshFileSubtreeOpSubscription(ownerPubkey, dbKey) {
	if (!connection) return;
	const rootIds = activeMountRootIds.value;
	if (rootIds.length === 0) return;

	if (!fileSubtreeOpSubscriber) {
		fileSubtreeOpSubscriber = createSubscriber(connection, {
			verifyBatch: verifyBatchFn,
			onBatch: async (events) => {
				for (const event of events) {
					if (!isNewEvent(event.id)) continue;
					await handleIncomingSubtreeEvent(ownerPubkey, dbKey, event);
				}
			},
		});
		connection.addMessageHandler(fileSubtreeOpSubscriber.handleMessage);
	}
	fileSubtreeOpSubscriber.subscribe("file-subtree-ops", [{ "#h": rootIds, kinds: [FILE_SUBTREE_OP_KIND] }]);
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
					// КРИТИЧНО именно здесь (этап 47-довесок-4, найденный пользователем баг
					// "~10 уведомлений на одно сообщение"): sendChatMessageAction (chats.js)
					// БЕЗУСЛОВНО вызывает refreshGroupMessageSubscription на КАЖДУЮ отправку —
					// resubscribe с тем же subId заставляет relay передоставить ВСЮ историю
					// kind 445 по фильтру заново. decryptApplicationMessage (MLS ratchet)
					// толерантен к redelivery в пределах окна (иначе не пережил бы обычную
					// сетевую доставку не по порядку) — без этой проверки КАЖДАЯ такая
					// редоставка старого сообщения проходила бы весь конвейер заново и
					// notify()'ла бы уже виденное сообщение повторно.
					if (!isNewEvent(event.id)) continue;
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
						// Этап 50 (N1) — тот же класс redelivery, что комментарий выше (isNewEvent)
						// защищает только НА ЭТУ сессию; chatSyncState.lastReadLamportTs уже
						// синхронизирован с других устройств/сессий к этому моменту
						// (rebuildReadStatus в начале connect()) — гасит уведомление о
						// сообщении, уже прочитанном где угодно, включая ДО релогина.
						if (
							receivedResult &&
							!wasDeletion &&
							!wasEdit &&
							!(await isChatContentRead(ownerPubkey, receivedResult.contactPubkey, receivedResult.lamportTs))
						) {
							await ensureProfilesFetched([receivedResult.contactPubkey], fetchProfiles).catch(() => {});
							const messageNavTarget = { screen: "messages", contactPubkey: receivedResult.contactPubkey };
							await notifyAndLog(
								ownerPubkey,
								dbKey,
								settings,
								"messages",
								null,
								{
									title: `Новое сообщение от ${usernameFor(receivedResult.contactPubkey)}`,
									body: receivedResult.text,
									navTarget: messageNavTarget,
									onClick: () => navigateFromNotification(messageNavTarget),
									occurredAt: event.created_at * 1000,
								},
								receivedResult.contactPubkey,
							);
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
