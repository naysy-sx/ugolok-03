// Монтирование чужой доли (CONTRACTS.md/DESIGN.md, этап 53 И6, задача 6.3) —
// Mount.state — ОТДЕЛЬНОЕ, полностью самостоятельное CRDT-состояние
// (createInitialState() + те же applyOp/merge/project() из tree.js), НЕ
// проекция/фильтрация состояния владельца. Именно поэтому §6.5 матдока
// ("сходимость R не доказана для наблюдателя с частичной видимостью")
// не применяется к получателю доли — доказательство см. DESIGN.md, этап
// 53 И6, п.3.
import { decryptShareGrant, decryptSubtreeOp } from "../../core/crypto/share-key.js";
import { createFolder, purge } from "./ops.js";
import { applyOp, createInitialState } from "./tree.js";
import { saveMount, deleteMount, saveMountKey, getAllMountKeys, deleteAllMountKeys, saveMountState, loadMountState, deleteMountState } from "./store.js";

// mount(): расшифровывает грант (event — сырое FILE_SHARE_GRANT_KIND
// событие, event.pubkey — владелец доли, отправитель), создаёт узел-ссылку
// В СВОЁМ дереве получателя ОБЫЧНОЙ локальной операцией (createFolder —
// ops.js/tree.js контракт И1 не меняется буквально, публикация/синхронизация
// этого узла — обычный путь И5, не здесь). Mount.state инициализируется
// ПУСТЫМ (createInitialState() — три системных узла, тот же старт, что
// у любого TreeState) — содержимое доли приходит ОТДЕЛЬНЫМИ
// FILE_SUBTREE_OP_KIND-событиями (первое из них — снимок, share.js),
// применяются applyMountSubtreeEvent (ниже), не здесь: эта функция не
// делает сеть/подписку, только локальное состояние + разбор уже
// полученного гранта.
export async function mount(recipientPubkey, recipientPrivKey, dbKey, treeState, grantEvent, parentId, name, newLocalId, label) {
	const ownerPubkey = grantEvent.pubkey;
	const { nodeId: rootId, subtreeKey, version } = decryptShareGrant(grantEvent.content, recipientPrivKey, ownerPubkey);

	const op = createFolder(treeState, parentId, name, newLocalId, label);
	if (op instanceof Error) return op;
	const newTreeState = applyOp(treeState, op);

	await saveMount(recipientPubkey, newLocalId, ownerPubkey, rootId, version, dbKey);
	await saveMountKey(recipientPubkey, newLocalId, version, subtreeKey, dbKey);
	await saveMountState(recipientPubkey, newLocalId, createInitialState());

	return { treeState: newTreeState, mountId: newLocalId, ownerPubkey, rootId, version };
}

// Применяет ОДНО FILE_SUBTREE_OP_KIND-событие к Mount.state (снимок при
// mount() — такое же событие, как и любое последующее — publishSubtreeOps
// в share.js не различает их, applyMountSubtreeEvent тоже). Маршрутизация
// "это событие — для ЭТОГО mountId" (сверка тега #h с mount.rootId) —
// на стороне вызывающего (тот же уровень, что rebuildFilesLog в sync.js
// решает, какие события КАКОГО ownerPubkey разбирать). Неизвестная версия
// ключа (грант ещё не пришёл/уже отозван до неё) -> decryptSubtreeOp
// возвращает null, здесь no-op, НЕ throw — рутинный случай relay-потока,
// тот же принцип, что decryptChannelContent.
export async function applyMountSubtreeEvent(recipientPubkey, dbKey, mountId, event) {
	const subtreeKeysByVersion = await getAllMountKeys(recipientPubkey, mountId, dbKey);
	const opsJson = decryptSubtreeOp(event.content, subtreeKeysByVersion);
	if (opsJson === null) return null;

	const ops = JSON.parse(opsJson);
	let S = await loadMountState(recipientPubkey, mountId);
	for (const op of ops) {
		S = applyOp(S, op);
	}
	await saveMountState(recipientPubkey, mountId, S);
	return S;
}

// unmount(): удаляет узел-ссылку ОБЫЧНЫМ purge (как любой узел получателя —
// та же операция, что чистка корзины, ops.js не меняется) + запись mounts
// + ВСЕ версии mountKeys + Mount.state целиком (CONTRACTS.md 6.3, буквально).
export async function unmount(recipientPubkey, dbKey, treeState, mountId) {
	const op = purge(treeState, mountId);
	const newTreeState = applyOp(treeState, op);

	await deleteMount(recipientPubkey, mountId);
	await deleteAllMountKeys(recipientPubkey, mountId);
	await deleteMountState(recipientPubkey, mountId);

	return newTreeState;
}
