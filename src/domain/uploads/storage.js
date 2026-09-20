// ТЗ-03 — экран хранилища: занятое место с сервера, сверка с журналом, освобождение.
//
// Числа берутся с сервера (GET /list/<pubkey>: хеши, размеры, даты — сервер считает свои
// байты), имена и назначения — из журнала. Экран полезен и без журнала.
import { deleteBlob } from "../files/blob.js";
import { groupRows, classOfName, sentPlaces } from "./records.js";
import { removeUploads } from "./journal.js";

// -> [{hash, size, uploaded}] (uploaded — секунды). Бросает при сетевой ошибке/не-200.
export async function fetchServerBlobs(serverUrl, pubkey, { fetchImpl = globalThis.fetch, signal } = {}) {
	const url = `${serverUrl.replace(/\/$/, "")}/list/${pubkey}`;
	const res = await fetchImpl(url, { signal });
	if (!res.ok) throw new Error(`Blossom list failed: ${res.status}`);
	const data = await res.json();
	if (!Array.isArray(data)) return [];
	return data
		.filter((b) => b && typeof b.sha256 === "string" && Number.isFinite(b.size))
		.map((b) => ({ hash: b.sha256, size: b.size, uploaded: b.uploaded ?? 0 }));
}

export function totalBytes(serverBlobs) {
	return serverBlobs.reduce((sum, b) => sum + b.size, 0);
}

// Сверка (раздел 4): что на сервере, но нет в журнале ("неопознанные") и что в журнале,
// но нет на сервере ("недоступно на сервере").
export function reconcile(serverBlobs, journalRows) {
	const journal = new Map(journalRows.map((r) => [r.hash, r]));
	const server = new Map(serverBlobs.map((b) => [b.hash, b]));
	const unknown = serverBlobs.filter((b) => !journal.has(b.hash));
	const missing = journalRows.filter((r) => !server.has(r.hash));
	return { unknown, missing, unknownBytes: totalBytes(unknown) };
}

// Строки экрана: серверные блобы, сгруппированные по вложению (если журнал их знает),
// иначе — по одному. Сортировка по размеру, крупнейшие первыми.
export function buildEntries(serverBlobs, journalRows) {
	const byHash = new Map(journalRows.map((r) => [r.hash, r]));
	const groups = groupRows(journalRows.filter((r) => serverBlobs.some((b) => b.hash === r.hash)));
	const entries = [];
	const used = new Set();
	const serverByHash = new Map(serverBlobs.map((b) => [b.hash, b]));
	for (const g of groups.values()) {
		const present = g.rows.filter((r) => serverByHash.has(r.hash));
		present.forEach((r) => used.add(r.hash));
		entries.push({
			key: "g:" + g.group,
			group: g.group,
			known: true,
			name: g.name,
			purpose: g.purpose,
			targets: g.targets,
			sentTo: sentPlaces(g.targets).length,
			hashes: present.map((r) => r.hash),
			size: present.reduce((s, r) => s + serverByHash.get(r.hash).size, 0),
			at: g.at,
			kind: classOfName(g.name),
		});
	}
	for (const b of serverBlobs) {
		if (used.has(b.hash) || byHash.has(b.hash)) continue;
		entries.push({ key: "h:" + b.hash, known: false, hashes: [b.hash], size: b.size, at: b.uploaded * 1000, kind: "other", targets: [], sentTo: 0 });
	}
	entries.sort((a, b) => b.size - a.size);
	return entries;
}

// Разбивка занятого: по назначению (из журнала; "unknown" — то, чего журнал не знает).
export function breakdownByPurpose(entries) {
	const out = {};
	for (const e of entries) {
		const key = e.known ? e.purpose : "unknown";
		out[key] = (out[key] ?? 0) + e.size;
	}
	return out;
}

// Разбивка по типам файлов — только там, где известно имя (с сервера типа не получить).
export function breakdownByKind(entries) {
	const out = {};
	for (const e of entries) {
		const key = e.known ? e.kind : "unknown";
		out[key] = (out[key] ?? 0) + e.size;
	}
	return out;
}

// Освобождение места: DELETE /{sha} на каждый блоб. 404 = уже нет (считаем удалённым).
// После — записи убираются из журнала (только реально удалённых).
export async function freeBlobs({ serverUrl, privateKey, hashes, deleteFn = deleteBlob, onProgress }) {
	const deleted = [];
	const failed = [];
	for (let i = 0; i < hashes.length; i++) {
		const hash = hashes[i];
		try {
			await deleteFn(serverUrl, hash, privateKey);
			deleted.push(hash);
		} catch (err) {
			if (/failed: 404/.test(String(err?.message))) deleted.push(hash);
			else failed.push({ hash, error: err });
		}
		onProgress?.({ done: i + 1, total: hashes.length });
	}
	if (deleted.length > 0) await removeUploads(deleted, { markFreed: true });
	return { deleted, failed };
}
