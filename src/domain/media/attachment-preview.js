// MEDIA-PERF-TZ-5.md §3 — превью/постер генерируются ОДИН РАЗ при заливке
// (отправитель платит батареей/трафиком за всех получателей), не при каждом
// открытии чата. Картинка -> уменьшенный JPEG; видео -> кадр-постер тем же
// кодеком + duration/width/height (снимаются бесплатно с того же
// loadedmetadata, что extract-video-poster.js уже использует).
//
// НЕ переиспользует src/domain/files/thumbnails.js::createThumbnailBlob —
// разные домены (превью вложения СООБЩЕНИЯ vs миниатюра списка "Файлы",
// files.jsx) с разными константами (320px/q0.6 здесь, 200px/q0.7 там);
// совпадение реализации (createImageBitmap+OffscreenCanvas) поверхностное,
// эволюционировать могут независимо.
import { extractVideoPosterCapture } from "../../ui/media/extract-video-poster.js";

export const PREVIEW_MAX_DIMENSION = 320; // px, контракт MEDIA-PERF-TZ-5.md §3
export const PREVIEW_JPEG_QUALITY = 0.6; // контракт §3, целевой вес 10-20 КБ
const PREVIEW_MIME = "image/jpeg";

// bytes — ПОЛНЫЙ исходный файл картинки (та же посылка, что thumbnails.js:
// картинки малы, decode целиком оправдан).
export async function createImagePreviewBytes(bytes, mime, maxDimension = PREVIEW_MAX_DIMENSION) {
	const sourceBlob = new Blob([bytes], { type: mime });
	const bitmap = await createImageBitmap(sourceBlob);
	try {
		const scale = Math.min(1, maxDimension / Math.max(bitmap.width, bitmap.height));
		const width = Math.max(1, Math.round(bitmap.width * scale));
		const height = Math.max(1, Math.round(bitmap.height * scale));
		const canvas = new OffscreenCanvas(width, height);
		const ctx = canvas.getContext("2d");
		ctx.drawImage(bitmap, 0, 0, width, height);
		const outBlob = await canvas.convertToBlob({ type: PREVIEW_MIME, quality: PREVIEW_JPEG_QUALITY });
		return { bytes: new Uint8Array(await outBlob.arrayBuffer()), mime: PREVIEW_MIME, width, height };
	} finally {
		bitmap.close();
	}
}

// Единая точка входа — attachments.js зовёт ЭТУ функцию, не разбирая
// картинка перед ней или видео. Возвращает null, если у типа файла нет
// превью (аудио/документ) ИЛИ генерация не удалась (битый файл, отказ
// canvas/video) — ЛЮБАЯ ошибка здесь гасится молча: контракт (§3) запрещает
// срывать заливку оригинала из-за отказа превью, вызывающая сторона трактует
// null как "заливаем без превью", не как исключение.
export async function generateAttachmentPreview({ bytes, file, mime }) {
	try {
		if (typeof mime === "string" && mime.startsWith("image/")) {
			if (!bytes) return null;
			const preview = await createImagePreviewBytes(bytes, mime);
			return { bytes: preview.bytes, mime: preview.mime, width: preview.width, height: preview.height };
		}
		if (typeof mime === "string" && mime.startsWith("video/") && file) {
			const captured = await extractVideoPosterCapture(file);
			if (!captured) return null;
			return { bytes: captured.bytes, mime: captured.mime, width: captured.width, height: captured.height, duration: captured.duration };
		}
		return null;
	} catch {
		return null;
	}
}
