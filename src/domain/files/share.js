// Шаринг поддерева (CONTRACTS.md/DESIGN.md, этап 53 И6, задачи 6.1/6.5) —
// по прямому образцу domain/content/channel-access.js's sendViewGrant +
// domain/content/moderation.js's banMember (этапы 30/33), включая уже
// один раз найденный и исправленный живым E2E класс бага (П-А,
// CONTRACTS.md): d-тег гранта ОБЯЗАН быть уникален на читателя+версию,
// иначе второй читатель замещает грант первого на relay.
import { sign } from "../../core/crypto/sign.js";
import { generateSubtreeKey, encryptShareGrant, encryptSubtreeOp } from "../../core/crypto/share-key.js";
import { deriveMasterSecret, opaqueDTag } from "../../core/crypto/derivation.js";
import { bytesToHex } from "@noble/hashes/utils.js";
import { liveChildrenOf, ROOT_ID } from "./tree.js";
import { loadShareMeta, saveShareMeta, saveShareKey, getShareKey, addShareGrantee, removeShareGrantee, listShareGrantees } from "./store.js";

export const FILE_SHARE_GRANT_KIND = 30075;
// regular kind, journal операций расшаренного поддерева (CONTRACTS.md,
// этап 53 И6) — routing-тег #h ЕДИНОБУКВЕННЫЙ (NIP-12, урок этапа 30:
// "#channel" не индексируется).
export const FILE_SUBTREE_OP_KIND = 3008;

// Текущее содержимое nodeId (рекурсивно, только живые узлы) как пачка
// синтетических create-операций для Mount.state НОВОГО читателя (CONTRACTS.md
// 6.1: "снимок ОДИН РАЗ..., не переигровка сырых операций"). Прямые дети
// nodeId получают parentId=ROOT_ID (виртуальный корень доли — Mount.state
// использует ТУ ЖЕ tree.js-машинерию, у которой ROOT_ID жёстко "$root");
// более глубокие потомки сохраняют СВОИ реальные id/parentId без изменений.
export function snapshotSubtree(treeState, nodeId, label) {
	const ops = [];
	const stack = [...liveChildrenOf(treeState, nodeId)].map((id) => ({ id, parentId: ROOT_ID }));
	while (stack.length > 0) {
		const { id, parentId } = stack.pop();
		const node = treeState.nodes.get(id);
		ops.push({ type: "create", id, kind: node.kind, blob: node.blob, parentId, name: node.name.value, origin: node.origin.value, label });
		for (const childId of liveChildrenOf(treeState, id)) {
			stack.push({ id: childId, parentId: id });
		}
	}
	return ops;
}

// Транслирует ОДНУ пачку Op[] всем текущим читателям доли — ОДНО событие,
// шифруется ОДИН раз subtreeKey (ALGO.MD §12: "публикация — O(1), не
// O(k)" — получатели читают ОДНО и то же, не попарно). Вызывается и для
// снимка при share(), и для обычных операций внутри доли (6.4).
export async function publishSubtreeOps(ownerPrivKey, rootId, subtreeKeyHex, version, ops, publish) {
	if (ops.length === 0) return;
	const content = encryptSubtreeOp(JSON.stringify(ops), subtreeKeyHex, version);
	const event = sign({ kind: FILE_SUBTREE_OP_KIND, content, tags: [["h", rootId]], created_at: Math.floor(Date.now() / 1000) }, ownerPrivKey);
	await requirePublishOk(publish, event);
}

async function requirePublishOk(publish, event) {
	const result = await publish(event);
	if (!result.ok) {
		throw new Error(result.reason || "relay отклонил публикацию");
	}
}

async function sendShareGrant(ownerPubkey, ownerPrivKey, nodeId, subtreeKeyHex, version, readerPubkey, publish) {
	const content = encryptShareGrant(nodeId, subtreeKeyHex, version, ownerPrivKey, readerPubkey);
	const masterSecret = deriveMasterSecret(ownerPrivKey);
	const dTag = opaqueDTag(masterSecret, FILE_SHARE_GRANT_KIND, `${nodeId}:${readerPubkey}:${version}`);
	const event = sign(
		{ kind: FILE_SHARE_GRANT_KIND, content, tags: [["d", dTag], ["p", readerPubkey]], created_at: Math.floor(Date.now() / 1000) },
		ownerPrivKey,
	);
	await requirePublishOk(publish, event);
}

// Если nodeId ещё не расшарен — генерирует НОВЫЙ subtreeKey, версия 1.
// Если уже расшарен — переиспользует ТЕКУЩИЙ ключ/версию (добавление
// читателя не требует ротации, только новую обёртку ДЛЯ НЕГО — m+k, не
// m·k, CONTRACTS.md 6.1). Идемпотентно: pubkey, уже имеющий грант этой
// версии, не переспрашивается повторно. treeState/label — только если
// добавлен хотя бы ОДИН новый читатель: снимок ТЕКУЩЕГО содержимого
// публикуется ЗАНОВО при каждом расширении списка читателей (не только
// при первом share()) — иначе читатель, присоединившийся позже, не
// увидел бы уже существующее содержимое (CONTRACTS.md 6.1). Republish
// избыточен для СТАРЫХ читателей (тот же снимок ещё раз), но безвреден —
// merge() идемпотентен, "рутина, не квадратично" (n мал для этого класса
// операции — расшаривание, не массовая загрузка).
export async function share(ownerPubkey, ownerPrivKey, dbKey, treeState, nodeId, pubkeys, label, publish) {
	let meta = await loadShareMeta(ownerPubkey, nodeId, dbKey);
	let version;
	let subtreeKeyHex;
	if (!meta) {
		version = 1;
		subtreeKeyHex = bytesToHex(generateSubtreeKey());
		await saveShareMeta(ownerPubkey, nodeId, version, dbKey);
		await saveShareKey(ownerPubkey, nodeId, version, subtreeKeyHex, dbKey);
	} else {
		version = meta.currentVersion;
		subtreeKeyHex = await getShareKey(ownerPubkey, nodeId, version, dbKey);
	}

	const existingGrantees = new Set(await listShareGrantees(ownerPubkey, nodeId));
	const newlyGranted = [];
	for (const pubkey of pubkeys) {
		if (existingGrantees.has(pubkey)) continue;
		await sendShareGrant(ownerPubkey, ownerPrivKey, nodeId, subtreeKeyHex, version, pubkey, publish);
		await addShareGrantee(ownerPubkey, nodeId, pubkey);
		newlyGranted.push(pubkey);
	}

	if (newlyGranted.length > 0) {
		const snapshotOps = snapshotSubtree(treeState, nodeId, label);
		await publishSubtreeOps(ownerPrivKey, nodeId, subtreeKeyHex, version, snapshotOps, publish);
	}
	return { nodeId, version };
}

// Ротация ключа + переиздача ВСЕМ читателям КРОМЕ отозванного (буквально
// banMember, этап 33). Жёсткий инвариант (MATH.md §6.4, недостижимый
// математически, только формулировкой в UI): отозванный, уже скачавший
// версии ≤ v_old, сохраняет к ним доступ — старые версии ключа НЕ
// удаляются локально, только перестают приходить новые гранты.
export async function revoke(ownerPubkey, ownerPrivKey, dbKey, nodeId, revokedPubkey, publish) {
	const meta = await loadShareMeta(ownerPubkey, nodeId, dbKey);
	if (!meta) return; // не расшарен — нечего отзывать

	const vNew = meta.currentVersion + 1;
	const newKeyHex = bytesToHex(generateSubtreeKey());
	await saveShareKey(ownerPubkey, nodeId, vNew, newKeyHex, dbKey);
	await saveShareMeta(ownerPubkey, nodeId, vNew, dbKey);

	const grantees = await listShareGrantees(ownerPubkey, nodeId);
	const remaining = grantees.filter((p) => p !== revokedPubkey);
	for (const pubkey of remaining) {
		await sendShareGrant(ownerPubkey, ownerPrivKey, nodeId, newKeyHex, vNew, pubkey, publish);
	}
	await removeShareGrantee(ownerPubkey, nodeId, revokedPubkey);
}
