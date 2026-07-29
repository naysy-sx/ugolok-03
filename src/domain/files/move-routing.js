// Маршрутизация move через границу доли (CONTRACTS.md/DESIGN.md, этап 53
// И6, задача 6.4) — получатели ОБЪЕДИНЕНИЯ долей, покрывающих старого и
// нового родителя (TASK.md §6: "получатели — объединение старого и
// нового родителя"). Только move: остальные операции внутри уже
// расшаренного поддерева не меняют покрывающее множество (parentId тот
// же), поэтому не нуждаются в leaving/entering-развилке — этот файл их
// не касается (вне скоупа 6.4, TASK.md таблица §5.5).
import { coveringShares } from "./permissions.js";
import { liveChildrenOf } from "./tree.js";
import { publishSubtreeOps } from "./share.js";
import { loadShareMeta, getShareKey } from "./store.js";

// Снимок поддерева, корень nodeId ВКЛЮЧЁН (в отличие от share.js's
// snapshotSubtree, где корень становится виртуальным ROOT_ID точки
// монтирования — здесь корень ОБЫЧНЫЙ узел, входящий в уже видимое
// получателю поддерево доли, его реальный parentId получатель узнаёт
// ВПЕРВЫЕ через параметр parentId, остальные — из treeState как есть).
function subtreeOpsRootedAt(treeState, nodeId, parentId, label) {
	const node = treeState.nodes.get(nodeId);
	const ops = [{ type: "create", id: nodeId, kind: node.kind, blob: node.blob, parentId, name: node.name.value, origin: node.origin.value, label }];
	const stack = [...liveChildrenOf(treeState, nodeId)].map((id) => ({ id, parentId: nodeId }));
	while (stack.length > 0) {
		const { id, parentId: p } = stack.pop();
		const n = treeState.nodes.get(id);
		ops.push({ type: "create", id, kind: n.kind, blob: n.blob, parentId: p, name: n.name.value, origin: n.origin.value, label });
		for (const childId of liveChildrenOf(treeState, id)) stack.push({ id: childId, parentId: id });
	}
	return ops;
}

// Доля могла быть отозвана/удалена между вычислением coveringShares и
// публикацией (гонка, не ошибка) — meta отсутствует -> тихий no-op, тот
// же принцип, что decryptSubtreeOp на неизвестную версию.
async function publishOpsToShare(ownerPubkey, ownerPrivKey, dbKey, shareRootId, ops, publish) {
	const meta = await loadShareMeta(ownerPubkey, shareRootId, dbKey);
	if (!meta) return;
	const subtreeKeyHex = await getShareKey(ownerPubkey, shareRootId, meta.currentVersion, dbKey);
	await publishSubtreeOps(ownerPrivKey, shareRootId, subtreeKeyHex, meta.currentVersion, ops, publish);
}

// treeState — состояние ВЛАДЕЛЬЦА ДО применения op (нужен текущий
// par.value узла как oldParentId; op.value — новый родитель, ops.js's
// move()). grantsIndex — тот же вход, что permissions.js's coveringShares/
// effectivePerm (store.js's loadGrantsIndex(ownerPubkey)).
export async function routeMove(ownerPubkey, ownerPrivKey, dbKey, grantsIndex, treeState, op, label, publish) {
	const node = treeState.nodes.get(op.id);
	const oldParentId = node.par.value;
	const newParentId = op.value;

	const oldCover = coveringShares(grantsIndex, treeState, oldParentId);
	const newCover = coveringShares(grantsIndex, treeState, newParentId);

	for (const shareRootId of oldCover) {
		if (newCover.has(shareRootId)) continue; // unchanged, обрабатывается ниже
		await publishOpsToShare(ownerPubkey, ownerPrivKey, dbKey, shareRootId, [{ type: "purge", id: op.id }], publish);
	}
	for (const shareRootId of newCover) {
		if (oldCover.has(shareRootId)) continue;
		const ops = subtreeOpsRootedAt(treeState, op.id, newParentId, label);
		await publishOpsToShare(ownerPubkey, ownerPrivKey, dbKey, shareRootId, ops, publish);
	}
	for (const shareRootId of oldCover) {
		if (!newCover.has(shareRootId)) continue;
		await publishOpsToShare(ownerPubkey, ownerPrivKey, dbKey, shareRootId, [op], publish);
	}
}
