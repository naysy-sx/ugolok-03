// Декодирование миниатюры — задача 3.8 TASK.md. Браузерные API
// (createImageBitmap/OffscreenCanvas) — не тестируется в node --test
// напрямую, живая Playwright-проверка вместо unit (тот же класс
// ограничения, что crypto.worker.js/service worker в этом проекте).
//
// Видео — сознательно НЕ здесь (только image/*): миниатюра кадра видео
// требует либо скачать файл целиком (недопустимо для больших видео — та
// же причина, по которой чанки вообще существуют, MATH.md §3.5), либо
// использовать Range-стриминг через service worker — это И4 (плеер), ещё
// не реализован в этой сессии. Как только И4 даст content.getRange через
// <video>, миниатюра кадра — естественное расширение этого модуля, не
// новый механизм.
export const THUMBNAIL_MAX_DIMENSION = 200; // px — миниатюра списка, не превью
const THUMBNAIL_MIME = "image/jpeg";
const THUMBNAIL_QUALITY = 0.7;

export function isThumbnailable(mime) {
	return typeof mime === "string" && mime.startsWith("image/");
}

// bytes — ПОЛНЫЙ расшифрованный файл (изображения малы, getRange(0, size)
// целиком — оправдано; в отличие от видео, для которого именно этого и
// избегаем). Возвращает Uint8Array маленького JPEG.
export async function createThumbnailBlob(bytes, mime, maxDimension = THUMBNAIL_MAX_DIMENSION) {
	const sourceBlob = new Blob([bytes], { type: mime });
	const bitmap = await createImageBitmap(sourceBlob);
	try {
		const scale = Math.min(1, maxDimension / Math.max(bitmap.width, bitmap.height));
		const width = Math.max(1, Math.round(bitmap.width * scale));
		const height = Math.max(1, Math.round(bitmap.height * scale));
		const canvas = new OffscreenCanvas(width, height);
		const ctx = canvas.getContext("2d");
		ctx.drawImage(bitmap, 0, 0, width, height);
		const outBlob = await canvas.convertToBlob({ type: THUMBNAIL_MIME, quality: THUMBNAIL_QUALITY });
		return new Uint8Array(await outBlob.arrayBuffer());
	} finally {
		bitmap.close();
	}
}
