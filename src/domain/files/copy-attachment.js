// ТЗ-03, раздел 7 — «Сохранить к себе»: настоящая копия вместо ссылки на чужой блоб.
//
// Раньше кнопка создавала узел «Файлов», ссылающийся на блоб автора: файл оставался на
// его месте, и когда автор освобождал место, у сохранившего пропадало «своё». Теперь —
// полная перезаливка (тот же путь, что «Принять из доли», save-to-own.js): новый
// случайный ключ, новый блоб, своё место, запись в журнале. Дубли исключены проверкой
// журнала по sourceDigest (манифест исходного вложения).
import { getManifest, getRange, putStream } from "./content.js";
import { findBySourceDigest, recordUploads, newGroupId } from "../uploads/journal.js";

function base64ToBytes(str) {
	return Uint8Array.from(atob(str), (c) => c.charCodeAt(0));
}

// attachment: дескриптор вложения {manifestDigest, fileKey(base64), name, mime}.
// -> {kind: "existing", manifestDigest}                     — копия уже была сделана;
//    {kind: "new", manifestDigest, fileKey, name, mime}     — залита новая копия.
export async function prepareOwnCopy({ attachment, name, serverUrl, privateKey, fetchImpl, onProgress }) {
	const already = await findBySourceDigest(attachment.manifestDigest);
	if (already) return { kind: "existing", manifestDigest: already.hash };

	const netOpts = { serverUrl, ...(fetchImpl ? { fetchImpl } : {}) };
	const manifest = await getManifest(attachment.manifestDigest, netOpts);
	const plaintext = await getRange(manifest, base64ToBytes(attachment.fileKey), 0, manifest.size, { ...netOpts, onProgress });
	const fileName = name || attachment.name || manifest.name;
	const put = await putStream(plaintext, { ...netOpts, privateKey, name: fileName, mime: manifest.mime, onProgress });

	// Журнал: записи копии; sourceDigest — только на манифесте (по нему ищет
	// findBySourceDigest, и его hash — то, что кладётся в узел «Файлов»).
	const group = newGroupId();
	await recordUploads(
		put.blobs.map((b) => ({
			hash: b.hash,
			size: b.size,
			role: b.role,
			purpose: "files",
			target: "from-chat",
			group,
			name: fileName,
			server: serverUrl,
			...(b.role === "manifest" ? { sourceDigest: attachment.manifestDigest } : {}),
		})),
	);
	return { kind: "new", manifestDigest: put.manifestDigest, fileKey: put.fileKey, name: fileName, mime: manifest.mime };
}
