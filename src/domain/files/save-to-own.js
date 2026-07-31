// saveToOwn — честно долгая операция (CONTRACTS.md/DESIGN.md, этап 53 И6,
// задача 6.6). НЕ мгновенный copy (ops.js) — тот создал бы узел, ссылающийся
// на blob-дайджест ВЛАДЕЛЬЦА, что при отзыве/чистке чужого хранилища молча
// превратило бы файл в битую ссылку (TASK.md §5.5). Настоящая копия:
// getManifest+getRange под ключом ЧТЕНИЯ (resolveFileKey — параметр, НЕ
// решается здесь, откуда он берётся, см. CONTRACTS.md 6.6 "находка при
// реализации": ничто в content.js/share.js сегодня не шифрует блоб
// подключом, производным от subtreeKey, при заливке) -> putStream ЗАНОВО
// (новый fileKey, ГЕНЕРИРУЕТСЯ) -> Op[] на СВОЁ дерево, применяет вызывающая
// сторона (тот же принцип, что ops.js's copy — случайность/применение
// снаружи).
import { bytesToHex } from "@noble/hashes/utils.js";
import { getManifest, getRange, putStream } from "./content.js";
import { saveFileKey } from "./store.js";
import { liveChildrenOf, nameOwnerInDir } from "./tree.js";

export async function saveToOwn(recipientPubkey, dbKey, mountState, sourceNodeId, destTreeState, destParentId, newIds, resolveFileKey, label, opts = {}) {
	// onProgress здесь — ФАЙЛОВЫЙ прогресс (filesDone/filesTotal, СВОЙ
	// колбэк), не путать с putStream's ЧАНКОВЫМ onProgress
	// (chunksDone/chunksTotal, content.js) — оба поля называются
	// одинаково, но означают разное; сетевые опции (serverUrl/fetchImpl/
	// privateKey) переиспользуются буквально, onProgress — НЕ пробрасывается.
	const { onProgress, ...netOpts } = opts;
	const sourceRoot = mountState.nodes.get(sourceNodeId);

	let rootName = sourceRoot.name.value;
	if (nameOwnerInDir(destTreeState, destParentId, rootName) !== undefined) {
		rootName = `${rootName} (копия)`;
		let i = 2;
		while (nameOwnerInDir(destTreeState, destParentId, rootName) !== undefined) {
			rootName = `${sourceRoot.name.value} (копия ${i})`;
			i += 1;
		}
	}

	const subtreeIds = [];
	const stack = [sourceNodeId];
	while (stack.length > 0) {
		const cur = stack.pop();
		subtreeIds.push(cur);
		for (const id of liveChildrenOf(mountState, cur)) stack.push(id);
	}

	const filesTotal = subtreeIds.filter((id) => mountState.nodes.get(id).kind === "file").length;
	let filesDone = 0;

	const ops = [];
	for (const id of subtreeIds) {
		const node = mountState.nodes.get(id);
		const newId = newIds.get(id);
		const parentId = id === sourceNodeId ? destParentId : newIds.get(node.par.value);
		const name = id === sourceNodeId ? rootName : node.name.value;

		if (node.kind === "dir") {
			ops.push({ type: "create", id: newId, kind: "dir", blob: null, parentId, name, origin: node.origin.value, label });
			continue;
		}

		const manifest = await getManifest(node.blob, netOpts);
		const readKey = await resolveFileKey(node, manifest);
		const plaintext = await getRange(manifest, readKey, 0, manifest.size, netOpts);
		const { manifestDigest, fileKey: newFileKey } = await putStream(plaintext, { ...netOpts, name, mime: manifest.mime });
		// Этап 57 — announced: true сразу (ключ едет в этой же create-операции,
		// довыдавать backfillOwnFileKeys нечего), тот же принцип, что createFileEntry.
		await saveFileKey(recipientPubkey, dbKey, manifestDigest, newFileKey, true);

		filesDone += 1;
		onProgress?.({ filesDone, filesTotal });

		// fileKey — журнал (KIND_FILES_OP) уже NIP-44-шифруется получателем самому
		// себе, поэтому провезти его прямо в create-Op безопасно: без этого другие
		// устройства получателя видели бы файл в дереве, но не смогли бы его
		// расшифровать (найдено живой проверкой, тот же класс, что этап 55 — каналы).
		ops.push({ type: "create", id: newId, kind: "file", blob: manifestDigest, parentId, name, origin: node.origin.value, label, fileKey: bytesToHex(newFileKey) });
	}

	return ops;
}
