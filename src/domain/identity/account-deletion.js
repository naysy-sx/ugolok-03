// Удаление аккаунта — пользователь: "должно быть максимально подчищено,
// насколько это вообще позволяет текущая архитектура". Два явных решения
// пользователя (не додуманы): (1) сетевая очистка — BEST-EFFORT, локальный
// вайп доводится до конца ВСЕГДА, даже если relay/Blossom недоступны;
// (2) подтверждение — повторный ввод логина+пароля (UI, не эта функция).
//
// Архитектурные пределы (описаны честно, не как баг):
// - уже ДОСТАВЛЕННЫЕ контактам сообщения/вложения не исчезают у них —
//   тот же принцип "нет отзыва после отправки", что и everywhere в проекте
//   (ключ вложения уехал вместе с сообщением, назад не забрать);
// - если тот же npub залогинен на ДРУГОМ устройстве — там ничего не
//   меняется (в keystore нет cross-device sync, удаление строго локальное
//   для этого устройства);
// - подписчики каналов, уже скачавшие себе посты/вложения, сохранят
//   локальную копию — kind-5 удаление (уже существующий deleteChannel())
//   чистит СТРУКТУРУ у них при получении, не то, что уже утекло на диск;
// - вложения ВНУТРИ уже отправленных сообщений/постов (не файлы из
//   личного дерева "Файлы" и не аватары каналов) НЕ удаляются с Blossom —
//   потребовало бы расшифровать КАЖДОЕ отправленное сообщение/пост ради
//   извлечения digest'а, сознательно вне периметра этого прохода.
import { db } from "../../core/store/database.js";
import { buildProfileEvent } from "./profile.js";
import { listOwnedChannels, deleteChannel } from "../content/channel.js";
import { loadTreeState } from "../files/store.js";
import { getManifest } from "../files/content.js";
import { deleteBlob } from "../files/blob.js";

// Таблицы, owner-scoped полем "ownerPubkey" (этапы 25-53 — см. database.js).
const OWNER_PUBKEY_TABLES = [
	"messages",
	"channels",
	"channelKeys",
	"channelKeyMeta",
	"commentAllowlists",
	"posts",
	"comments",
	"channelMessages",
	"channelReaders",
	"channelReports",
	"channelIgnores",
	"bannedMembers",
	"uiSettings",
	"channelVisibilityGroups",
	"discoverySettings",
	"clock",
	"attachments",
	"ownKeyPackage",
	"mlsGroups",
	"chatSyncState",
	"channelSyncState",
	"knownDevices",
	"files_nodes",
	"files_mounts",
	"files_manifests",
	"files_blobs",
	"files_thumbs",
	"files_keys",
	"files_shares",
	"files_shareKeys",
	"files_shareGrantees",
	"files_mountKeys",
	"files_mount_nodes",
	"files_mount_file_meta",
];

// Таблицы, owner-scoped полем "owner" (легаси-именование, этапы 11-50 —
// contactRelationships вытесняет contacts/blockedContacts/contactRequests,
// но те остаются в схеме, могут содержать хвосты — чистим все).
const OWNER_TABLES = [
	"contacts",
	"blockedContacts",
	"groups",
	"permissions",
	"effectivePerms",
	"contactRequests",
	"inboxRequests",
	"contactRelationships",
	"journalEntries",
	"outgoingAcquaintanceRequests",
];

// НЕ трогаются намеренно (не пробел, честный выбор — см. комментарии database.js):
// deviceIdentity (метка ФИЗИЧЕСКОГО устройства, общая для всех identity на нём),
// discoveryProfiles (чужие публичные профили, не данные этого аккаунта),
// syncState (per-relay, не per-owner), outbox (не owner-scoped по индексу —
// оставшиеся ненаправленные записи безвредны, ссылаются на уже неактуальный
// приватный ключ и просто перестанут публиковаться).

// Best-effort — публикация нового kind 0 c пометкой в имени. Профиль НЕ
// кэшируется в IndexedDB у контактов (только in-memory signal + живая
// подписка, ui/signals/contacts.js) — обновление придёт само тем, у кого
// открыт чат, без отдельного протокола "аккаунт удалён".
async function tombstoneProfile(login, privKey, publish) {
	const event = buildProfileEvent(privKey, { name: `${login} (удалённый аккаунт)` });
	await publish(event);
}

// Best-effort — существующий deleteChannel() публикует kind-5 (сами
// подписчики почистят у себя структуру при получении) + чистит локальные
// channel-таблицы этого владельца. Аватар канала (если был) — отдельно,
// deleteChannelLocally сам блобы не трогает (найдено разведкой кодовой
// базы этого прохода).
async function deleteOwnedChannels(ownerPubkey, privKey, dbKey, publish, serverUrl, opts) {
	const owned = await listOwnedChannels(ownerPubkey, dbKey);
	for (const channelRow of owned) {
		if (channelRow.avatar?.manifestDigest) {
			try {
				const manifest = await getManifest(channelRow.avatar.manifestDigest, { serverUrl, ...opts });
				await deleteBlob(serverUrl, manifest.blobSha256, privKey, opts);
			} catch {
				// best-effort — сервер недоступен/блоб уже отсутствует, не блокирует остальное
			}
			try {
				await deleteBlob(serverUrl, channelRow.avatar.manifestDigest, privKey, opts);
			} catch {}
		}
		try {
			await deleteChannel(ownerPubkey, privKey, dbKey, channelRow.id, publish);
		} catch {
			// сеть недоступна/publish отклонён — локальную зачистку канала всё равно
			// довершит общий проход по files_nodes-таблицам ниже (channels — owner-scoped)
		}
	}
}

// Best-effort — собственные файлы из "Файлы": у КАЖДОГО файла (не папки)
// два блоба на Blossom (содержимое + манифест, content.js's putStream) —
// удаляем оба. Ключ расшифровки НЕ нужен для удаления (BUD-02 delete-auth
// проверяет только подпись pubkey исходного загрузчика).
async function deleteOwnFileBlobs(ownerPubkey, privKey, serverUrl, opts) {
	const treeState = await loadTreeState(ownerPubkey);
	for (const node of treeState.nodes.values()) {
		if (node.kind !== "file" || !node.blob) continue;
		try {
			const manifest = await getManifest(node.blob, { serverUrl, ...opts });
			await deleteBlob(serverUrl, manifest.blobSha256, privKey, opts);
		} catch {}
		try {
			await deleteBlob(serverUrl, node.blob, privKey, opts);
		} catch {}
	}
}

// Полная локальная зачистка — БЕЗ сети, всегда доводится до конца.
// groupMembers/deletions/events не owner-scoped напрямую по одному полю —
// отдельная логика для каждой. keystore — последней (сама запись аккаунта,
// после неё listAccounts() аккаунт больше не покажет).
async function wipeLocalData(ownerPubkey) {
	const ownGroupIds = (await db.table("groups").where("owner").equals(ownerPubkey).toArray()).map((g) => g.id);

	for (const table of OWNER_PUBKEY_TABLES) {
		await db.table(table).where("ownerPubkey").equals(ownerPubkey).delete();
	}
	for (const table of OWNER_TABLES) {
		await db.table(table).where("owner").equals(ownerPubkey).delete();
	}
	for (const groupId of ownGroupIds) {
		await db.table("groupMembers").where("groupId").equals(groupId).delete();
	}
	await db.table("deletions").where("deleterPubkey").equals(ownerPubkey).delete();
	// events — только события, АВТОРОМ которых является сам аккаунт (не все
	// закэшированные события, среди которых полно чужих — pubkey тут автор
	// в сети, не "локальный владелец"). Нет отдельного индекса по одному
	// pubkey (только [pubkey+kind]) — полный скан таблицы, приемлемо для
	// объёма персонального мессенджера.
	await db.table("events").filter((e) => e.pubkey === ownerPubkey).delete();
	await db.table("keystore").delete(ownerPubkey);
}

// Точка входа — вызывается из UI (settings.jsx) ПОСЛЕ подтверждения
// (повторный ввод логина+пароля — проверяется вызывающей стороной).
export async function deleteAccountEverywhere(ownerPubkey, privKey, dbKey, login, publish, serverUrl, opts = {}) {
	try {
		await tombstoneProfile(login, privKey, publish);
	} catch {}
	try {
		await deleteOwnedChannels(ownerPubkey, privKey, dbKey, publish, serverUrl, opts);
	} catch {}
	try {
		await deleteOwnFileBlobs(ownerPubkey, privKey, serverUrl, opts);
	} catch {}
	await wipeLocalData(ownerPubkey);
}
