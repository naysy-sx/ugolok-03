// Ресайз аватара до миниатюры ПЕРЕД публикацией (FILES-FIX-SPEC.md §9.1,
// TZ-FIX-FILES-MEDIA-STATIC.md решение №9/5.9). MAX_AVATAR_BYTES (2 МБ,
// profile.jsx) была ПРОВЕРКОЙ, не ПРИВЕДЕНИЕМ — пользователь мог залить
// ровно 2 МБ, и они летели НЕЗАШИФРОВАННЫМИ в каждую карточку контакта
// (kind 0 читают все). Здесь — приведение к квадрату ≤256px, ≤200КиБ.
//
// bitmapBackend — инъекция ради тестируемости: createImageBitmap/
// OffscreenCanvas — браузерные API, в node --test их нет. Тесты гоняют
// resizeAvatarBlob с фейковым backend'ом (проверяют кроп/выбор форматов
// арифметически), реальный визуальный результат — живая проверка,
// TZ-FIX-FILES-MEDIA-STATIC.md §8 (P8 "Аватар E").
export const AVATAR_MAX_SIDE = 256;
export const AVATAR_TARGET_BYTES = 200 * 1024;

const browserBitmapBackend = {
	async decode(blob) {
		return createImageBitmap(blob);
	},
	async encode(bitmap, { side, cropX, cropY, cropSize, quality, mime }) {
		const canvas = new OffscreenCanvas(side, side);
		const ctx = canvas.getContext("2d");
		ctx.drawImage(bitmap, cropX, cropY, cropSize, cropSize, 0, 0, side, side);
		return canvas.convertToBlob({ type: mime, quality });
	},
};

// Возвращает Blob — квадрат ≤ AVATAR_MAX_SIDE px, центр-кроп по короткой
// стороне (не искажает пропорции), JPEG q0.82 или WebP — что МЕНЬШЕ по
// байтам; если после первого прохода всё ещё > AVATAR_TARGET_BYTES —
// второй проход q0.7 (решение №9: "если не уложились — ещё один проход").
export async function resizeAvatarBlob(blob, { bitmapBackend } = {}) {
	const backend = bitmapBackend ?? browserBitmapBackend;
	const bitmap = await backend.decode(blob);
	const cropSize = Math.min(bitmap.width, bitmap.height);
	const cropX = Math.floor((bitmap.width - cropSize) / 2);
	const cropY = Math.floor((bitmap.height - cropSize) / 2);
	const side = Math.min(AVATAR_MAX_SIDE, cropSize);

	async function encodeAt(quality) {
		const geometry = { side, cropX, cropY, cropSize, quality };
		const [webp, jpeg] = await Promise.all([
			backend.encode(bitmap, { ...geometry, mime: "image/webp" }).catch(() => null),
			backend.encode(bitmap, { ...geometry, mime: "image/jpeg" }),
		]);
		return webp && webp.size < jpeg.size ? webp : jpeg;
	}

	let result = await encodeAt(0.82);
	if (result.size > AVATAR_TARGET_BYTES) {
		result = await encodeAt(0.7);
	}
	return result;
}
