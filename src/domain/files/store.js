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
	return { nodes, pending: new Map() };
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
