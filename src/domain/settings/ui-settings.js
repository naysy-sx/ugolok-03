import { sign } from "../../core/crypto/sign.js";
import { getPublicKey } from "../../core/crypto/keys.js";
import { encrypt as nip44Encrypt, decrypt as nip44Decrypt } from "../../core/crypto/nip44.js";
import { bytesToHex } from "@noble/hashes/utils.js";
import { db } from "../../core/store/database.js";
import { pickLatest } from "../../core/sync/lww.js";
import { BUILD_DEFAULT_RELAYS, BUILD_DEFAULT_BLOSSOM_SERVERS } from "../../config.js";
import { buildRelayListEvent } from "../identity/relay-list.js";
import { toEncryptedRow, fromEncryptedRow } from "../../core/store/encrypted-table.js";
import { UI_SETTINGS_PLAINTEXT_FIELDS } from "../../core/store/table-fields.js";

// F-SY-03 (TECH.md) — d-tag='settings' буквально, не opaque (не privacy-чувствительно,
// тот же принцип, что read-status/drafts этапа 26).
export const KIND_UI_SETTINGS = 30072;

// Этап 47 — уровни уведомления вместо булевых тумблеров (DESIGN.md: упорядоченное
// множество off/badge/popup/sound, не 3 независимых флага). Старое поле верхнего
// уровня `sound` больше не нужно — звук теперь часть шкалы уровня самой категории/
// подкатегории/entity-override, не отдельный глобальный рубильник.
export const DEFAULT_NOTIFICATIONS = {
	enabled: true,
	contacts: { newRequests: "sound", accepted: "popup" },
	messages: { default: "sound", overrides: {} }, // overrides: {[contactPubkey]: level}
	channels: {
		posts: "popup",
		comments: "popup",
		chat: "sound",
		overrides: {}, // overrides: {[channelId]: {posts?, comments?, chat?}}
	},
	replies: "sound", // ответ на МОЙ пост/комментарий — глобально, без per-entity
	moderation: { reports: "popup" }, // бан/warn/delete — принудительно вне settings, см. notifier.js
	inbox: "popup", // этап 47-довесок-3 — заявка (MLS Welcome) от НЕЗНАКОМЦА, глобально
};

export const DEFAULT_SETTINGS = {
	accentColorId: "blue",
	uiScale: "medium",
	themeMode: null, // null = "как в системе" (prefers-color-scheme); "light"|"dark" = явный выбор
	language: "ru",
	notifications: DEFAULT_NOTIFICATIONS,
	relayUrls: [],
	blossomUrls: [],
	activeBlossomUrl: null,
};

// Глубокое слияние с дефолтом — старый/неполный payload (например, сохранённый до
// добавления нового вложенного поля) не должен терять остальное дерево notifications.
function mergeWithDefaults(parsed) {
	const notifications = parsed.notifications ?? {};
	return {
		...DEFAULT_SETTINGS,
		...parsed,
		notifications: {
			...DEFAULT_NOTIFICATIONS,
			...notifications,
			contacts: { ...DEFAULT_NOTIFICATIONS.contacts, ...(notifications.contacts ?? {}) },
			messages: { ...DEFAULT_NOTIFICATIONS.messages, ...(notifications.messages ?? {}) },
			channels: { ...DEFAULT_NOTIFICATIONS.channels, ...(notifications.channels ?? {}) },
			moderation: { ...DEFAULT_NOTIFICATIONS.moderation, ...(notifications.moderation ?? {}) },
		},
	};
}

export function buildUiSettingsEvent(privKey, settings, createdAt = Math.floor(Date.now() / 1000)) {
	const ownPubHex = bytesToHex(getPublicKey(privKey));
	const content = nip44Encrypt(JSON.stringify(settings), privKey, ownPubHex);
	return sign({ kind: KIND_UI_SETTINGS, content, tags: [["d", "settings"]], created_at: createdAt }, privKey);
}

export function parseUiSettingsEvent(event, privKey) {
	const ownPubHex = bytesToHex(getPublicKey(privKey));
	const plaintext = nip44Decrypt(event.content, privKey, event.pubkey || ownPubHex);
	return mergeWithDefaults(JSON.parse(plaintext));
}

// НАЙДЕНО РАССУЖДЕНИЕМ (бутстрап-проблема) — активный relay нужен ДО того, как можно
// что-либо получить С relay (включая сам этот kind 30072). Локальная запись —
// единственный источник истины для ТЕКУЩЕГО подключения; при её отсутствии (первый
// запуск) — build-time дефолт, который тут же станет локальной записью при первом save.
export async function loadUiSettings(ownerPubkey, dbKey) {
	const row = fromEncryptedRow(await db.table("uiSettings").get(ownerPubkey), dbKey);
	if (!row) {
		return mergeWithDefaults({
			relayUrls: BUILD_DEFAULT_RELAYS.map((url) => ({ url, read: true, write: true })),
			blossomUrls: [...BUILD_DEFAULT_BLOSSOM_SERVERS],
			activeBlossomUrl: BUILD_DEFAULT_BLOSSOM_SERVERS[0] ?? null,
		});
	}
	const { ownerPubkey: _drop, ...settings } = row;
	return mergeWithDefaults(settings);
}

// Локально — сразу (офлайн-first), публикация — best-effort и НЕ бросает наружу
// (тот же принцип, что profile.jsx: локальное сохранение не зависит от публикации).
// dbKey (этап 45, Tier 4) — только для ЛОКАЛЬНОГО кэша на этом устройстве; kind 30072
// остаётся NIP-44-шифрованным для синхронизации между СВОИМИ устройствами — два разных
// шифра, не путать.
export async function saveUiSettings(ownerPubkey, privKey, dbKey, settings, publish) {
	await db.table("uiSettings").put(toEncryptedRow({ ownerPubkey, ...settings }, UI_SETTINGS_PLAINTEXT_FIELDS, dbKey));
	try {
		await publish(buildUiSettingsEvent(privKey, settings));
	} catch {
		// сеть недоступна / relay отклонил — настройка уже сохранена локально, это
		// синхронизация между СВОИМИ устройствами, не критичный путь.
	}
}

// Тот же паттерн, что rebuildContactsAndGroups (handlers.js, этап 20-24) — событие уже
// приходит через существующий bootstrap-фильтр {authors:[я]}, нового REQ не нужно.
export async function rebuildUiSettings(ownerPubkey, privKey, dbKey) {
	const events = await db.table("events").where("[pubkey+kind]").equals([ownerPubkey, KIND_UI_SETTINGS]).toArray();
	if (events.length === 0) return;
	const settings = parseUiSettingsEvent(pickLatest(events), privKey);
	await db.table("uiSettings").put(toEncryptedRow({ ownerPubkey, ...settings }, UI_SETTINGS_PLAINTEXT_FIELDS, dbKey));
}

// Этап 58 — мультирелейный транспорт: relayUrls теперь {url,read,write}[],
// "одно активное" соединение не имеет смысла при одновременной работе с
// несколькими (см. CONTRACTS.md/DESIGN.md, этап 58).
// Этап 59 — сверх локального сохранения+приватной синхронизации (kind 30072,
// уже делает saveUiSettings) каждая мутация ДОПОЛНИТЕЛЬНО публикует РЕАЛЬНЫЙ
// kind:10002 (NIP-65) — единственный способ для ДРУГИХ участников/bootstrap-
// координатора узнать relay-список по pubkey, не имея приватного ключа для
// расшифровки kind 30072 (см. CONTRACTS.md, этап 59). Best-effort — тот же
// принцип, что публикация kind 30072 внутри saveUiSettings: сеть недоступна
// -> локальное состояние всё равно уже сохранено.
async function publishRelayList(privKey, relayUrls, publish) {
	try {
		await publish(buildRelayListEvent(privKey, relayUrls));
	} catch {
		// relay недоступен/отклонил — kind:10002 не критичен для локальной работы
	}
}

export async function addRelayUrl(ownerPubkey, privKey, dbKey, url, publish) {
	const settings = await loadUiSettings(ownerPubkey, dbKey);
	if (settings.relayUrls.some((r) => r.url === url)) return; // идемпотентно
	const nextRelayUrls = [...settings.relayUrls, { url, read: true, write: true }];
	await saveUiSettings(ownerPubkey, privKey, dbKey, { ...settings, relayUrls: nextRelayUrls }, publish);
	await publishRelayList(privKey, nextRelayUrls, publish);
}

export async function removeRelayUrl(ownerPubkey, privKey, dbKey, url, publish) {
	const settings = await loadUiSettings(ownerPubkey, dbKey);
	if (settings.relayUrls.length <= 1) {
		throw new Error("нельзя удалить последний relay — список не может быть пустым");
	}
	const nextRelayUrls = settings.relayUrls.filter((r) => r.url !== url);
	await saveUiSettings(ownerPubkey, privKey, dbKey, { ...settings, relayUrls: nextRelayUrls }, publish);
	await publishRelayList(privKey, nextRelayUrls, publish);
}

export async function setRelayRole(ownerPubkey, privKey, dbKey, url, { read, write }, publish) {
	const settings = await loadUiSettings(ownerPubkey, dbKey);
	if (!settings.relayUrls.some((r) => r.url === url)) {
		throw new Error("URL отсутствует в списке — сначала добавьте");
	}
	const nextRelayUrls = settings.relayUrls.map((r) => (r.url === url ? { url, read, write } : r));
	if (!nextRelayUrls.some((r) => r.read)) {
		throw new Error("нельзя оставить список без единого read-relay — нечего будет читать");
	}
	if (!nextRelayUrls.some((r) => r.write)) {
		throw new Error("нельзя оставить список без единого write-relay — нечего будет публиковать");
	}
	await saveUiSettings(ownerPubkey, privKey, dbKey, { ...settings, relayUrls: nextRelayUrls }, publish);
	await publishRelayList(privKey, nextRelayUrls, publish);
}

export async function addBlossomUrl(ownerPubkey, privKey, dbKey, url, publish) {
	const settings = await loadUiSettings(ownerPubkey, dbKey);
	if (settings.blossomUrls.includes(url)) return;
	await saveUiSettings(ownerPubkey, privKey, dbKey, { ...settings, blossomUrls: [...settings.blossomUrls, url] }, publish);
}

export async function removeBlossomUrl(ownerPubkey, privKey, dbKey, url, publish) {
	const settings = await loadUiSettings(ownerPubkey, dbKey);
	if (url === settings.activeBlossomUrl) {
		throw new Error("нельзя удалить активный Blossom-сервер — сначала переключитесь на другой");
	}
	await saveUiSettings(ownerPubkey, privKey, dbKey, { ...settings, blossomUrls: settings.blossomUrls.filter((u) => u !== url) }, publish);
}

export async function setActiveBlossomUrl(ownerPubkey, privKey, dbKey, url, publish) {
	const settings = await loadUiSettings(ownerPubkey, dbKey);
	if (!settings.blossomUrls.includes(url)) {
		throw new Error("URL отсутствует в списке — сначала добавьте");
	}
	await saveUiSettings(ownerPubkey, privKey, dbKey, { ...settings, activeBlossomUrl: url }, publish);
}
