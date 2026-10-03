// Mime и размер файлов списка — из манифестов (в узле дерева их нет). Кэш IndexedDB → сеть, не больше
// трёх запросов одновременно; уже известные не запрашиваются. Возвращает { [nodeId]: { mime, size, name } }.
import { useState, useEffect } from "preact/hooks";
import { getManifest } from "../../domain/files/content.js";
import { getCachedManifest, putCachedManifest } from "../../domain/files/store.js";

const CONCURRENCY = 3;

export function useManifestInfo(ownerPubkey, files, serverUrl) {
	const [info, setInfo] = useState({});
	const key = files.map((f) => f.id).join("|");
	useEffect(() => {
		let cancelled = false;
		const todo = files.filter((f) => f.blob && !info[f.id]);
		if (todo.length === 0) return;
		let next = 0;
		async function worker() {
			while (!cancelled && next < todo.length) {
				const node = todo[next++];
				try {
					let manifest = await getCachedManifest(ownerPubkey, node.blob);
					if (!manifest) {
						manifest = await getManifest(node.blob, { serverUrl });
						await putCachedManifest(ownerPubkey, node.blob, manifest);
					}
					if (!cancelled) setInfo((prev) => ({ ...prev, [node.id]: { mime: manifest.mime, size: manifest.size, name: manifest.name } }));
				} catch {
					// нет манифеста (сервер недоступен / файл убран) — строка остаётся без размера
				}
			}
		}
		for (let i = 0; i < CONCURRENCY; i++) worker();
		return () => {
			cancelled = true;
		};
		// info намеренно не в зависимостях: иначе каждая загрузка перезапускала бы эффект
		// eslint-disable-next-line
	}, [ownerPubkey, key, serverUrl]);
	return info;
}
