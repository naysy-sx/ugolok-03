// Мост между domain/files/share.js и UI — сторона ВЛАДЕЛЬЦА доли (CONTRACTS.md,
// этап 53 И6, задача 6.7). label()/treeState — переиспользуют files.js (тот
// же принцип, что mounts.js), publish — параметром снаружи (тот же принцип,
// что files.js's initFiles — тестируемость без реальной сети).
import { signal } from "@preact/signals";
import { treeState, label as filesLabel } from "./files.js";
import { share, revoke } from "../../domain/files/share.js";
import { listShareGrantees, loadGrantsIndex } from "../../domain/files/store.js";

// Какие узлы СВОЕГО дерева расшарены (хотя бы одному читателю) — для бейджа
// в списке файлов. Прямые гранты, БЕЗ наследования (тот же грантсИндекс,
// что coveringShares/effectivePerm, permissions.js).
export const sharedNodeIds = signal(new Set());

export async function initShares(ownerPubkey) {
	const grantsIndex = await loadGrantsIndex(ownerPubkey);
	sharedNodeIds.value = new Set(grantsIndex.keys());
}

export async function shareFolder(ownerPubkey, ownerPrivKey, dbKey, nodeId, pubkeys, publish, opts) {
	const result = await share(ownerPubkey, ownerPrivKey, dbKey, treeState.value, nodeId, pubkeys, await filesLabel(ownerPubkey), publish, opts);
	if (!(result instanceof Error)) {
		sharedNodeIds.value = new Set(sharedNodeIds.value).add(nodeId);
	}
	return result;
}

export async function revokeAccess(ownerPubkey, ownerPrivKey, dbKey, nodeId, pubkey, publish) {
	await revoke(ownerPubkey, ownerPrivKey, dbKey, nodeId, pubkey, publish);
	const remaining = await listShareGrantees(ownerPubkey, nodeId);
	if (remaining.length === 0) {
		const next = new Set(sharedNodeIds.value);
		next.delete(nodeId);
		sharedNodeIds.value = next;
	}
}

export async function listGrantees(ownerPubkey, nodeId) {
	return listShareGrantees(ownerPubkey, nodeId);
}
