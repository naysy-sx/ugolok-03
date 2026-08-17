// Персистентность CRDT-состояния дерева + кеш манифестов (CONTRACTS.md,
// этап 53, §5 TASK.md, задача 2.6). files_nodes хранит LWW-регистры
// РАЗВЁРНУТО по столбцам — прямой перевод формы Node (tree.js) в таблицу,
// без промежуточного JSON.
//
// Сужение скоупа (зафиксировано, не молчаливый пробел): S.pending (буфер
// операций, обогнавших свой create — tree.js) НЕ персистируется. Если
// приложение закроется в узком окне между "пришла операция на ещё не
// увиденный узел" и "пришёл сам create", буфер потеряется при перезапуске —
// но create для этого узла останется на relay и будет передоставлен при
// следующей синхронизации (И5), так что это не постоянная потеря данных,
// а лишь отложенная на один цикл синхронизации. files_blobs/files_thumbs —
// схема объявлена (database.js, version(17)), функции чтения/записи
// приходят вместе с этапами, которые их реально используют (И4 плеер,
// И3 миниатюры) — объявлять сейчас несуществующее поведение вокруг них
// нечем наполнить осмысленными тестами.
import { db } from "../../core/store/database.js";
import { chacha20poly1305 } from "@noble/ciphers/chacha.js";
import { rebuildIndexes } from "./tree.js";
import { toEncryptedRow, fromEncryptedRow } from "../../core/store/encrypted-table.js";
import {
	FILES_SHARES_PLAINTEXT_FIELDS,
	FILES_SHARE_KEYS_PLAINTEXT_FIELDS,
	FILES_MOUNTS_PLAINTEXT_FIELDS,
	FILES_MOUNT_KEYS_PLAINTEXT_FIELDS,
} from "../../core/store/table-fields.js";

function nodeToRow(ownerPubkey, node) {
	return {
		ownerPubkey,
		id: node.id,
		kind: node.kind,
		blob: node.blob,
		parValue: node.par.value,
		parCounter: node.par.label.counter,
		parDeviceId: node.par.label.deviceId,
		nameValue: node.name.value,
		nameCounter: node.name.label.counter,
		nameDeviceId: node.name.label.deviceId,
		originValue: node.origin.value,
		originCounter: node.origin.label.counter,
		originDeviceId: node.origin.label.deviceId,
		purged: node.purged,
		mime: node.mime,
	};
}

function rowToNode(row) {
	return {
		id: row.id,
		kind: row.kind,
		blob: row.blob,
		par: { value: row.parValue, label: { counter: row.parCounter, deviceId: row.parDeviceId } },
		name: { value: row.nameValue, label: { counter: row.nameCounter, deviceId: row.nameDeviceId } },
		origin: { value: row.originValue, label: { counter: row.originCounter, deviceId: row.originDeviceId } },
		purged: row.purged,
		mime: row.mime ?? null,
	};
}

// Перезаписывает ВСЕ строки владельца одной транзакцией (I-BATCH — задача
// 2.7: массовая запись, не по одному узлу за транзакцию). Вызывающая
// сторона решает, когда сохранять (после applyOp/merge, не на каждое
// изменение поля) — store.js сам не подписывается на изменения.
export async function saveTreeState(ownerPubkey, S) {
	const rows = [...S.nodes.values()].map((node) => nodeToRow(ownerPubkey, node));
	await db.transaction("rw", db.table("files_nodes"), async () => {
		await db.table("files_nodes").where("ownerPubkey").equals(ownerPubkey).delete();
		await db.table("files_nodes").bulkPut(rows);
	});
}

export async function loadTreeState(ownerPubkey) {
	const rows = await db.table("files_nodes").where("ownerPubkey").equals(ownerPubkey).toArray();
	const nodes = new Map();
	for (const row of rows) {
		nodes.set(row.id, rowToNode(row));
	}
	// children/namesInDir (tree.js) — производные индексы, персистируются НЕ
	// они, а nodes; пересобираются один раз при загрузке (O(n), не на
	// операцию — тот же принцип, что кэш project()).
	const { children, namesInDir, classCount } = rebuildIndexes(nodes);
	return { nodes, children, namesInDir, classCount, pending: new Map() };
}

export async function getCachedManifest(ownerPubkey, digest) {
	const row = await db.table("files_manifests").get([ownerPubkey, digest]);
	return row?.manifest;
}

export async function putCachedManifest(ownerPubkey, digest, manifest) {
	await db.table("files_manifests").put({ ownerPubkey, digest, manifest });
}

// Собственный счётчик Лампорта раздела "Файлы" — НЕ переиспользует
// domain/messaging'ов id='lamport' (тот же owner имеет РАЗНЫЕ причинные
// потоки для чатов и для дерева файлов; общий счётчик означал бы, что
// операция над файлом тратит "тик", видимый и messaging, без всякой пользы).
// computeInitialLamportValue (lamport.js) не годится буквально — та жёстко
// сканирует таблицу messages; здесь свой, отдельный ключ той же таблицы
// clock (уже owner-scoped, [ownerPubkey+id]).
export async function loadFilesClockValue(ownerPubkey) {
	const row = await db.table("clock").get([ownerPubkey, "files-lamport"]);
	return row?.value ?? 0;
}

export async function saveFilesClockValue(ownerPubkey, value) {
	await db.table("clock").put({ ownerPubkey, id: "files-lamport", value });
}

// Ключ файла (content.js's putStream -> fileKey) — БЕЗ этого файл
// нерасшифровываем после перезагрузки страницы (найдено при реализации
// миниатюр, задача 3.8). Шифруется dbKey (тот же приём, что
// domain/attachments/cache.js) — сырой симметричный ключ расшифровки
// файла в открытом виде в IndexedDB недопустим. НЕ путать с share.js/И6
// (обёртки ключа для КОНТАКТОВ) — это обычный доступ владельца к своему.
// Этап 57 — announced: "этот ключ уже путешествует внутри опубликованного
// create-Op (sync.js), backfillOwnFileKeys довыдавать не должен". По умолчанию
// false — ключи, сохранённые до этого фикса или без явного announced,
// нуждаются в довыдаче (иначе второе устройство того же владельца никогда не
// расшифрует файл — найдено живой проверкой).
export async function saveFileKey(ownerPubkey, dbKey, digest, fileKey, announced = false) {
	const nonce = crypto.getRandomValues(new Uint8Array(12));
	const ciphertext = chacha20poly1305(dbKey, nonce).encrypt(fileKey);
	await db.table("files_keys").put({ ownerPubkey, digest, nonce, ciphertext, announced });
}

export async function getFileKey(ownerPubkey, dbKey, digest) {
	const row = await db.table("files_keys").get([ownerPubkey, digest]);
	if (!row) return undefined;
	return chacha20poly1305(dbKey, row.nonce).decrypt(row.ciphertext);
}

export async function listUnannouncedFileKeys(ownerPubkey, dbKey) {
	const rows = await db.table("files_keys").where("ownerPubkey").equals(ownerPubkey).toArray();
	return rows
		.filter((row) => row.announced !== true)
		.map((row) => ({
			digest: row.digest,
			fileKey: chacha20poly1305(dbKey, row.nonce).decrypt(row.ciphertext),
		}));
}

export async function markFileKeyAnnounced(ownerPubkey, digest) {
	await db.table("files_keys").update([ownerPubkey, digest], { announced: true });
}

// Персистентность шаринга (CONTRACTS.md/DESIGN.md, этап 53 И6) — по
// прямому образцу channelKeys/channelKeyMeta/channelReaders (этапы
// 30/33). ownerPubkey здесь — владелец ДОЛИ (тот, кто расшарил), не
// путать со стороной получателя (mount.js).
export async function loadShareMeta(ownerPubkey, nodeId, dbKey) {
	return fromEncryptedRow(await db.table("files_shares").get([ownerPubkey, nodeId]), dbKey);
}

export async function saveShareMeta(ownerPubkey, nodeId, currentVersion, dbKey) {
	await db.table("files_shares").put(toEncryptedRow({ ownerPubkey, nodeId, currentVersion }, FILES_SHARES_PLAINTEXT_FIELDS, dbKey));
}

export async function saveShareKey(ownerPubkey, nodeId, version, subtreeKeyHex, dbKey) {
	await db.table("files_shareKeys").put(toEncryptedRow({ ownerPubkey, nodeId, version, subtreeKey: subtreeKeyHex }, FILES_SHARE_KEYS_PLAINTEXT_FIELDS, dbKey));
}

export async function getShareKey(ownerPubkey, nodeId, version, dbKey) {
	const row = fromEncryptedRow(await db.table("files_shareKeys").get([ownerPubkey, nodeId, version]), dbKey);
	return row?.subtreeKey;
}

// {[version]: subtreeKeyHex} — прямой вход в share-key.js's decryptSubtreeOp
// (subtreeKeysByVersion параметр).
export async function getAllShareKeys(ownerPubkey, nodeId, dbKey) {
	const rows = await db.table("files_shareKeys").where("[ownerPubkey+nodeId]").equals([ownerPubkey, nodeId]).toArray();
	const result = {};
	for (const row of rows) {
		const decrypted = fromEncryptedRow(row, dbKey);
		result[decrypted.version] = decrypted.subtreeKey;
	}
	return result;
}

// НЕ шифруется (тот же прецедент, что channelReaders — "голые" pubkey-
// списки не Tier-чувствительны, этап 39/table-fields.js).
export async function addShareGrantee(ownerPubkey, nodeId, granteePubkey) {
	await db.table("files_shareGrantees").put({ ownerPubkey, nodeId, granteePubkey });
}

export async function removeShareGrantee(ownerPubkey, nodeId, granteePubkey) {
	await db.table("files_shareGrantees").delete([ownerPubkey, nodeId, granteePubkey]);
}

export async function listShareGrantees(ownerPubkey, nodeId) {
	const rows = await db.table("files_shareGrantees").where("[ownerPubkey+nodeId]").equals([ownerPubkey, nodeId]).toArray();
	return rows.map((r) => r.granteePubkey);
}

// grantsIndex для permissions.js's effectivePerm/coveringShares —
// v0.1: share() производит ТОЛЬКО 'read' (TASK.md §5.5), поэтому каждый
// грантид получает буквально 'read', без отдельного хранения уровня.
export async function loadGrantsIndex(ownerPubkey) {
	const shareRows = await db.table("files_shares").where("ownerPubkey").equals(ownerPubkey).toArray();
	const grantsIndex = new Map();
	for (const shareRow of shareRows) {
		const grantees = await listShareGrantees(ownerPubkey, shareRow.nodeId);
		const perNode = new Map();
		for (const pubkey of grantees) perNode.set(pubkey, "read");
		grantsIndex.set(shareRow.nodeId, perNode);
	}
	return grantsIndex;
}

// Сторона ПОЛУЧАТЕЛЯ (CONTRACTS.md/DESIGN.md, этап 53 И6, задача 6.3) —
// ownerPubkey ниже означает получателя, nodeId — узел-ссылку В ЕГО дереве
// (не путать с rootId — узлом в состоянии владельца доли).
export async function saveMount(ownerPubkey, nodeId, ownerOfShare, rootId, currentVersion, dbKey) {
	await db.table("files_mounts").put(toEncryptedRow({ ownerPubkey, nodeId, owner: ownerOfShare, rootId, currentVersion }, FILES_MOUNTS_PLAINTEXT_FIELDS, dbKey));
}

export async function loadMount(ownerPubkey, nodeId, dbKey) {
	return fromEncryptedRow(await db.table("files_mounts").get([ownerPubkey, nodeId]), dbKey);
}

export async function deleteMount(ownerPubkey, nodeId) {
	await db.table("files_mounts").delete([ownerPubkey, nodeId]);
}

// Все точки монтирования получателя (этап 53 И6, задача 6.7) — для
// инициализации activeMounts (ui/signals/mounts.js) и для проверки "эта
// доля (owner+rootId) уже смонтирована?" при входящем гранте (без этого
// повторный грант того же владельца/узла монтировал бы ВТОРОЙ узел-ссылку).
export async function listMounts(ownerPubkey, dbKey) {
	const rows = await db.table("files_mounts").where("ownerPubkey").equals(ownerPubkey).toArray();
	return rows.map((row) => fromEncryptedRow(row, dbKey));
}

export async function saveMountKey(ownerPubkey, nodeId, version, subtreeKeyHex, dbKey) {
	await db.table("files_mountKeys").put(toEncryptedRow({ ownerPubkey, nodeId, version, subtreeKey: subtreeKeyHex }, FILES_MOUNT_KEYS_PLAINTEXT_FIELDS, dbKey));
}

// {[version]: subtreeKeyHex} — получатель может накопить НЕСКОЛЬКО версий
// (revoke ДРУГОГО читателя той же доли ротирует ключ и переиздаёт этому
// получателю тоже) — прямой вход в share-key.js's decryptSubtreeOp.
export async function getAllMountKeys(ownerPubkey, nodeId, dbKey) {
	const rows = await db.table("files_mountKeys").where("[ownerPubkey+nodeId]").equals([ownerPubkey, nodeId]).toArray();
	const result = {};
	for (const row of rows) {
		const decrypted = fromEncryptedRow(row, dbKey);
		result[decrypted.version] = decrypted.subtreeKey;
	}
	return result;
}

export async function deleteAllMountKeys(ownerPubkey, nodeId) {
	await db.table("files_mountKeys").where("[ownerPubkey+nodeId]").equals([ownerPubkey, nodeId]).delete();
}

// Mount.state — ОТДЕЛЬНОЕ CRDT-состояние (ALGO.MD §4.3/§12: "исчезает как
// класс" открытая задача частичной видимости именно потому, что состояния
// разделены) — по прямому образцу saveTreeState/loadTreeState, но
// скоуплено по [ownerPubkey+mountId], НЕ смешивается с files_nodes того
// же владельца ни при каких обстоятельствах.
export async function saveMountState(ownerPubkey, mountId, S) {
	const rows = [...S.nodes.values()].map((node) => ({ ...nodeToRow(ownerPubkey, node), mountId }));
	await db.transaction("rw", db.table("files_mount_nodes"), async () => {
		await db.table("files_mount_nodes").where("[ownerPubkey+mountId]").equals([ownerPubkey, mountId]).delete();
		await db.table("files_mount_nodes").bulkPut(rows);
	});
}

export async function loadMountState(ownerPubkey, mountId) {
	const rows = await db.table("files_mount_nodes").where("[ownerPubkey+mountId]").equals([ownerPubkey, mountId]).toArray();
	const nodes = new Map();
	for (const row of rows) {
		nodes.set(row.id, rowToNode(row));
	}
	const { children, namesInDir, classCount } = rebuildIndexes(nodes);
	return { nodes, children, namesInDir, classCount, pending: new Map() };
}

export async function deleteMountState(ownerPubkey, mountId) {
	await db.table("files_mount_nodes").where("[ownerPubkey+mountId]").equals([ownerPubkey, mountId]).delete();
}

// Сайдкар для деривации fileKey файлов ВНУТРИ доли (CONTRACTS.md/DESIGN.md,
// этап 53 И6, задача 6.6b) — plaintextDigest едет транзитно в create-опе,
// tree.js's Node его не хранит (mkNode его не читает), поэтому получателю
// нужно ОТДЕЛЬНОЕ место. version — версия subtreeKey, которая расшифровала
// СОБЫТИЕ с этим опом (peekSubtreeOpVersion, share-key.js) — НЕ обязательно
// текущая версия mount'а (revoke ротирует ключ вперёд, старые файлы
// остаются производными от СВОЕЙ эпохи).
export async function saveMountFileMeta(ownerPubkey, mountId, nodeId, plaintextDigest, version) {
	await db.table("files_mount_file_meta").put({ ownerPubkey, mountId, id: nodeId, plaintextDigest, version });
}

export async function getMountFileMeta(ownerPubkey, mountId, nodeId) {
	return db.table("files_mount_file_meta").get([ownerPubkey, mountId, nodeId]);
}

export async function deleteMountFileMeta(ownerPubkey, mountId) {
	await db.table("files_mount_file_meta").where("[ownerPubkey+mountId]").equals([ownerPubkey, mountId]).delete();
}
