// Замена domain/attachments/upload.js (этап 53 И7, задача 7.4 — снятие
// фасада, DESIGN.md "Этап 53, И7, задача 7.4"). Шифрование/загрузка/чтение
// содержимого — ПОЛНОСТЬЮ переиспользуют domain/files/content.js (putStream/
// getManifest/getRange), ничего в content.js не меняется. Единственное, что
// добавляет этот модуль — messaging-специфичная форма дескриптора вложения
// (type/manifestDigest/fileKey-base64/mime/size/name, тот же набор полей,
// что было у старого {type,sha256,blossomUrl,encryptionKey,mime,size,name},
// просто источник ключа/адресации — content-addressed чанкованное хранилище
// files, а не отдельное whole-file шифрование attachments).
import { putStream, getManifest, getRange } from "../files/content.js";
import { validateAttachment } from "../files/attachment-validation.js";
import { classOf } from "../media/media-ref.js";

function base64FromBytes(bytes) {
	return btoa(String.fromCharCode(...bytes));
}

function base64ToBytes(str) {
	return Uint8Array.from(atob(str), (c) => c.charCodeAt(0));
}

// Этап A медиа-подсистемы (MEDIA-SPEC.md §3.1) — classOf единственное место
// классификации mime; "other" -> "file" сохраняет уже принятый в дескрипторах
// и сохранённых сообщениях словарь, менять его нельзя (не новый формат).
function attachmentTypeFromMime(mime) {
	const c = classOf(mime);
	return c === "other" ? "file" : c;
}

// Путь "с диска" (chat.jsx/channel.jsx/channel-chat.jsx через use-attachment-tray.js) — реальная
// загрузка. putStream шифрует ЧАНКОВАНО (не целиком, как старый encryptFile) —
// побочный эффект: видео/аудио-вложения теперь МОГЛИ БЫ читаться через тот же
// Range-путь, что плеер "Файлы" (не реализовано этим проходом — вложения
// остаются eager whole-file чтением, attachment-view.jsx не меняет UX).
export async function uploadMessageAttachment(serverUrl, fileBytes, { mime, name }, privateKey, options = {}) {
	validateAttachment({ mime, size: fileBytes.length });
	const { manifestDigest, fileKey, size } = await putStream(fileBytes, { name, mime, serverUrl, privateKey, ...options });
	return { type: attachmentTypeFromMime(mime), manifestDigest, fileKey: base64FromBytes(fileKey), mime, size, name };
}

// Путь "из хранилища" (chat.jsx, 7.3, переделка этого прохода) — БЕЗ СЕТИ.
// Дедупликация (MATH.md §7: "передают Digest блоба, а не копию байтов") —
// собирает дескриптор из УЖЕ известных manifest+ключа узла "Файлы", не
// перезаливает и не порождает новый блоб. mime/size/name читаются ИЗ
// manifest (name может отличаться от node.displayName — вызывающая сторона
// решает, что показать; здесь буквально то, что было при заливке).
export function referenceStoredFile(manifestDigest, fileKeyBytes, manifest) {
	return {
		type: attachmentTypeFromMime(manifest.mime),
		manifestDigest,
		fileKey: base64FromBytes(fileKeyBytes),
		mime: manifest.mime,
		size: manifest.size,
		name: manifest.name,
	};
}

// Чтение (attachment-view.jsx через content-cache.js на промахе кеша) —
// eager, целиком в память (вложения чата не перематываются, в отличие от
// плеера "Файлы" — getRange(0, size) целиком оправдан тем же приёмом, что
// file-player.jsx для картинок, И7 довесок).
export async function downloadMessageAttachment({ manifestDigest, fileKey }, options = {}) {
	const manifest = await getManifest(manifestDigest, options);
	return getRange(manifest, base64ToBytes(fileKey), 0, manifest.size, options);
}
