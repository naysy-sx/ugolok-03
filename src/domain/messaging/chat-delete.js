import { bytesToHex } from "@noble/hashes/utils.js";
import { db } from "../../core/store/database.js";
import { fromEncryptedRow } from "../../core/store/encrypted-table.js";
import { withGroupLock } from "../../core/store/mls-lock.js";
import { computeGroupId, bumpChatGeneration } from "./chat.js";
import { putChatTombstone } from "./chat-tombstone.js";

// Запас на события «в пути»: сообщение, отправленное за минуты до удаления, но ещё не
// доехавшее до этого устройства, тоже считается удалённым. Пять минут — компромисс: больше
// рискует отбить настоящий новый разговор собеседника с отстающими часами.
const IN_FLIGHT_SLACK_SEC = 300;

// «Удалить переписку навсегда» — только на ЭТОМ устройстве: сообщения, MLS-группа (ключи),
// черновик и курсоры чтения, очередь неотправленного, запись в списке чатов. Собеседник и
// другие мои устройства ничего не узнают (ничего не публикуется).
//
// «Навсегда» обеспечивает надгробие (chat-tombstone.js): всё, что относится к переписке и
// создано не позже deletedAt, при перезапуске игнорируется (Welcome, kind 445, зеркало 446).
// Поколение разговора увеличивается: если позже я сам напишу этому человеку, новый Welcome
// заменит группу у собеседника (иначе тот отбросил бы его как дубль старой).
//
// Надгробие пишется ПЕРВЫМ, до стирания данных: пока идёт удаление, входящее событие уже
// не сможет вернуть только что стёртое.
export async function deleteChatForever(ownerPubkey, dbKey, contactPubkey, nowSec = Math.floor(Date.now() / 1000)) {
	const groupIdHex = bytesToHex(computeGroupId(ownerPubkey, contactPubkey));

	const activityRaw = await db.table("chatActivity").get([ownerPubkey, contactPubkey]);
	const lastKnownAt = activityRaw ? Number(fromEncryptedRow(activityRaw, dbKey).lastAt) || 0 : 0;
	const deletedAt = Math.max(lastKnownAt, nowSec - IN_FLIGHT_SLACK_SEC);

	await putChatTombstone({ ownerPubkey, contactPubkey, groupId: groupIdHex, deletedAt });
	await bumpChatGeneration(ownerPubkey, contactPubkey);

	await withGroupLock(ownerPubkey, groupIdHex, async () => {
		await db.table("messages").where("[ownerPubkey+chatId]").equals([ownerPubkey, contactPubkey]).delete();
		await db.table("mlsGroups").delete([ownerPubkey, groupIdHex]);
		await db.table("chatActivity").delete([ownerPubkey, contactPubkey]);
		await db.table("chatSyncState").delete([ownerPubkey, contactPubkey]);
		await db.table("pendingOutgoingMessages").where("[ownerPubkey+contactPubkey]").equals([ownerPubkey, contactPubkey]).delete();
		await db.table("peerCursors").delete([ownerPubkey, contactPubkey]);
		await db.table("peerPresence").delete([ownerPubkey, contactPubkey]);
		await db.table("knownContactDevices").where("[ownerPubkey+contactPubkey]").equals([ownerPubkey, contactPubkey]).delete();
	});

	return { groupIdHex, deletedAt };
}
