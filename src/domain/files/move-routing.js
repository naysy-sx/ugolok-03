// Маршрутизация move через границу доли (CONTRACTS.md/DESIGN.md, этап 53
// И6, задача 6.4) — получатели ОБЪЕДИНЕНИЯ долей, покрывающих старого и
// нового родителя (TASK.md §6: "получатели — объединение старого и
// нового родителя"). Только move: остальные операции внутри уже
// расшаренного поддерева не меняют покрывающее множество (parentId тот
// же), поэтому не нуждаются в leaving/entering-развилке — этот файл их
// не касается (вне скоупа 6.4, TASK.md таблица §5.5).
import { coveringShares } from "./permissions.js";
import { liveChildrenOf } from "./tree.js";
import { publishSubtreeOps, reuploadUnderShareKey } from "./share.js";
import { loadShareMeta, getShareKey } from "./store.js";

// Один create-оп: файлы честно перезаливаются под ключом, ПРОИЗВОДНЫМ от
// subtreeKey ЭТОЙ доли (CONTRACTS.md/DESIGN.md, этап 53 И6, задача 6.6b —
// та же логика, что share.js's snapshotSubtree, переиспользована буквально
// через reuploadUnderShareKey, не продублирована). Папки — без I/O, blob:null.
async function buildCreateOp(ownerPubkey, dbKey, node, parentId, subtreeKeyHex, label, opts) {
	if (node.kind === "file") {
		const { blob, plaintextDigest } = await reuploadUnderShareKey(ownerPubkey, dbKey, node, subtreeKeyHex, opts);
		return { type: "create", id: node.id, kind: "file", blob, parentId, name: node.name.value, origin: node.origin.value, label, plaintextDigest };
	}
	return { type: "create", id: node.id, kind: node.kind, blob: null, parentId, name: node.name.value, origin: node.origin.value, label };
}

// Снимок поддерева, корень nodeId ВКЛЮЧЁН (в отличие от share.js's
// snapshotSubtree, где корень становится виртуальным ROOT_ID точки
// монтирования — здесь корень ОБЫЧНЫЙ узел, входящий в уже видимое
// получателю поддерево доли, его реальный parentId получатель узнаёт
// ВПЕРВЫЕ через параметр parentId, остальные — из treeState как есть).
async function subtreeOpsRootedAt(ownerPubkey, dbKey, treeState, nodeId, parentId, subtreeKeyHex, label, opts) {
	const node = treeState.nodes.get(nodeId);
	const ops = [await buildCreateOp(ownerPubkey, dbKey, node, parentId, subtreeKeyHex, label, opts)];
	const stack = [...liveChildrenOf(treeState, nodeId)].map((id) => ({ id, parentId: nodeId }));
	while (stack.length > 0) {
		const { id, parentId: p } = stack.pop();
		const n = treeState.nodes.get(id);
		ops.push(await buildCreateOp(ownerPubkey, dbKey, n, p, subtreeKeyHex, label, opts));
		for (const childId of liveChildrenOf(treeState, id)) stack.push({ id: childId, parentId: id });
	}
	return ops;
}

// Доля могла быть отозвана/удалена между вычислением coveringShares и
// публикацией (гонка, не ошибка) — meta отсутствует -> null, вызывающая
// сторона не публикует (тот же принцип, что decryptSubtreeOp на
// неизвестную версию).
async function loadCurrentShareKey(ownerPubkey, shareRootId, dbKey) {
	const meta = await loadShareMeta(ownerPubkey, shareRootId, dbKey);
	if (!meta) return null;
	const subtreeKeyHex = await getShareKey(ownerPubkey, shareRootId, meta.currentVersion, dbKey);
	return { version: meta.currentVersion, subtreeKeyHex };
}

async function publishOpsToShare(ownerPrivKey, shareRootId, keyInfo, ops, publish) {
	if (!keyInfo) return;
	await publishSubtreeOps(ownerPrivKey, shareRootId, keyInfo.subtreeKeyHex, keyInfo.version, ops, publish);
}

// treeState — состояние ВЛАДЕЛЬЦА ДО применения op (нужен текущий
// par.value узла как oldParentId; op.value — новый родитель, ops.js's
// move()). grantsIndex — тот же вход, что permissions.js's coveringShares/
// effectivePerm (store.js's loadGrantsIndex(ownerPubkey)). opts — сетевые
// параметры (serverUrl/privateKey/fetchImpl) для честной перезаливки
// файлов, входящих в долю (6.6b) — пустые для leaving/unchanged (не
// трогают содержимое, только маршрутизацию).
export async function routeMove(ownerPubkey, ownerPrivKey, dbKey, grantsIndex, treeState, op, label, publish, opts = {}) {
	const node = treeState.nodes.get(op.id);
	const oldParentId = node.par.value;
	const newParentId = op.value;

	const oldCover = coveringShares(grantsIndex, treeState, oldParentId);
	const newCover = coveringShares(grantsIndex, treeState, newParentId);

	for (const shareRootId of oldCover) {
		if (newCover.has(shareRootId)) continue; // unchanged, обрабатывается ниже
		const keyInfo = await loadCurrentShareKey(ownerPubkey, shareRootId, dbKey);
		await publishOpsToShare(ownerPrivKey, shareRootId, keyInfo, [{ type: "purge", id: op.id }], publish);
	}
	for (const shareRootId of newCover) {
		if (oldCover.has(shareRootId)) continue;
		const keyInfo = await loadCurrentShareKey(ownerPubkey, shareRootId, dbKey);
		if (!keyInfo) continue; // доля исчезла между coveringShares и публикацией — нечего заливать
		const ops = await subtreeOpsRootedAt(ownerPubkey, dbKey, treeState, op.id, newParentId, keyInfo.subtreeKeyHex, label, opts);
		await publishOpsToShare(ownerPrivKey, shareRootId, keyInfo, ops, publish);
	}
	for (const shareRootId of oldCover) {
		if (!newCover.has(shareRootId)) continue;
		const keyInfo = await loadCurrentShareKey(ownerPubkey, shareRootId, dbKey);
		await publishOpsToShare(ownerPrivKey, shareRootId, keyInfo, [op], publish);
	}
}
