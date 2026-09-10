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
import { putFileStreaming } from "../files/stream-upload.js";
import { validateAttachment } from "../files/attachment-validation.js";
import { classOf } from "../media/media-ref.js";
import { generateAttachmentPreview } from "../media/attachment-preview.js";

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

// MEDIA-PERF-TZ-5.md §3 — превью/постер, отдельный маленький putStream ТЕМ ЖЕ
// serverUrl/privateKey/options (тот же сервер, тот же signal — отмена заливки
// оригинала отменяет и превью). ВЕСЬ блок (генерация И заливка) — под одним
// try/catch: generateAttachmentPreview сама гасит свои ошибки (возвращает
// null), но options.generatePreview — открытая DI-точка (тесты, будущие
// вызывающие) и НЕ обязана быть настолько же осторожной — контракт "отказ
// превью не должен срывать оригинал" должен держаться независимо от того,
// насколько defensively написан конкретный generate().
async function withPreview(descriptor, input, serverUrl, privateKey, options) {
	const generate = options.generatePreview ?? generateAttachmentPreview;
	// fileKey/generatePreview НЕ пробрасываются в putStream превью: fileKey —
	// оверрайд оригинала (share.js-подобные сценарии), превью ОБЯЗАНО получить
	// СВОЙ случайный ключ, не унаследованный (иначе превью и оригинал делили бы
	// пару ключ/nonce на чанк 0 — та же дыра, что проверялась в §9.1).
	const { fileKey: _origFileKeyOverride, generatePreview: _unused, ...putOptions } = options;
	try {
		const preview = await generate(input);
		if (!preview) return descriptor;
		const { manifestDigest: previewDigest, fileKey: previewFileKey } = await putStream(preview.bytes, {
			name: "preview.jpg",
			mime: preview.mime,
			serverUrl,
			privateKey,
			...putOptions,
		});
		return {
			...descriptor,
			previewDigest,
			previewKey: base64FromBytes(previewFileKey),
			...(preview.width ? { width: preview.width } : {}),
			...(preview.height ? { height: preview.height } : {}),
			...(preview.duration ? { duration: preview.duration } : {}),
		};
	} catch {
		return descriptor;
	}
}

// Путь "с диска" (chat.jsx/channel.jsx/channel-chat.jsx через use-attachment-tray.js) — реальная
// загрузка. putStream шифрует ЧАНКОВАНО (не целиком, как старый encryptFile) —
// побочный эффект: видео/аудио-вложения теперь МОГЛИ БЫ читаться через тот же
// Range-путь, что плеер "Файлы" (не реализовано этим проходом — вложения
// остаются eager whole-file чтением, attachment-view.jsx не меняет UX).
export async function uploadMessageAttachment(serverUrl, fileBytes, { mime, name }, privateKey, options = {}) {
	validateAttachment({ mime, size: fileBytes.length });
	const { manifestDigest, fileKey, size } = await putStream(fileBytes, { name, mime, serverUrl, privateKey, ...options });
	const descriptor = { type: attachmentTypeFromMime(mime), manifestDigest, fileKey: base64FromBytes(fileKey), mime, size, name };
	return withPreview(descriptor, { bytes: fileBytes, mime }, serverUrl, privateKey, options);
}

// Этап C медиа-подсистемы — тот же путь "с диска", но file — File|Blob, не
// Uint8Array: байты НЕ читаются в память целиком до загрузки (putFileStreaming
// сам делает срезы, Θ(C) память вместо Θ(S)). Используется use-attachment-
// tray.js::uploadAll — ЕДИНСТВЕННЫЙ вызывающий, у которого на входе реальный
// File (из <input type="file">), а не уже готовые байты (аватары чата/канала/
// профиля продолжают idти через uploadMessageAttachment — там bytes уже в
// руках вызывающей стороны, streaming для них не даёт выигрыша).
//
// MEDIA-PERF-TZ-5.md §3 — превью картинки требует ПОЛНЫЕ байты в памяти (canvas
// не умеет по частям); для картинок это file.arrayBuffer() ВТОРЫМ чтением
// (putFileStreaming уже читал файл срезами для шифрования, не держит целиком) —
// осознанная цена (контракт §3 "Стоимость... принимаем осознанно"), картинки
// малы. Видео превью НЕ требует чтения файла целиком — extractVideoPosterCapture
// сам семплит один кадр через <video>+object-URL.
export async function uploadMessageAttachmentStreaming(serverUrl, file, { mime, name }, privateKey, options = {}) {
	validateAttachment({ mime, size: file.size });
	const { manifestDigest, fileKey, size } = await putFileStreaming(file, { name, mime, serverUrl, privateKey, ...options });
	const descriptor = { type: attachmentTypeFromMime(mime), manifestDigest, fileKey: base64FromBytes(fileKey), mime, size, name };
	const bytes = typeof mime === "string" && mime.startsWith("image/") ? new Uint8Array(await file.arrayBuffer()) : undefined;
	return withPreview(descriptor, { bytes, file, mime }, serverUrl, privateKey, options);
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
