// Просмотр: сырой progressive JPEG / interlaced PNG не отдаём в <img>.
//
// MEDIA-PERF-TZ-4.md §4, задача A.0/A.1 — оверлей НЕ умеет зум выше "вписать
// в экран" (проверено: gesture-machine.js — только DRAG_H/DRAG_V/SETTLING,
// нет состояния зума; swipe-gesture.js — только axis/horizontal-commit/
// vertical-pull, нет scale-математики; image-viewer.jsx сам себя описывает
// как "без zoom/swipe"; `scale(...)` в media-overlay.jsx — только анимация
// открытия/закрытия из миниатюры, не жест пользователя). Раз показать
// пиксель крупнее вьюпорта всё равно негде — `img.decode()` НА ИСХОДНЫХ
// БАЙТАХ (что бы мы ни делали, это full-res decode) не нужен вовсе, вместе с
// гонкой-таймаутом на него (была добавлена в третьем проходе после того, как
// живой замер поймал decode() зависающим на 48-71с — TZ-4 §4 требует убрать
// ветку целиком, не просто увеличить таймаут: "аномалия decode() структурно
// невозможна", если сам decode() исходных байт больше не вызывается).
//
// Один путь на бабл И оверлей — rasterizeImagePreview, разная ТОЛЬКО цель
// (targetWidth) и качество кодека:
//   - бабл (previewTargetWidth): база 340 CSS px * DPR, потолок 1024, WebP q0.82.
//   - оверлей (overlayTargetWidth): вьюпорт по большей стороне * DPR, потолок
//     2560, WebP q0.9 (оверлей рассматривают внимательно — see image-preview.js).
// rasterizeImageBytes (старый полноразмерный lossless PNG snapshot) и
// rasterizeOriginal (decode()-путь) — УДАЛЕНЫ, ни одного вызывающего после
// перехода оверлея на rasterizeImagePreview (TZ-4 §4 A.3: если функция без
// вызывающих — удалить, не оставлять мёртвый защитный код).

// MEDIA-PERF-TZ.md §4.1 — бабл ~330 CSS px (.bubble-media { width: 20.5rem }),
// уменьшаем ПОД экран, не показываем full-res фото ради превью на 1/10 экрана.
const BUBBLE_PREVIEW_BASE_WIDTH = 340;
const BUBBLE_PREVIEW_MAX_WIDTH = 1024;

export function previewTargetWidth() {
	const dpr = (typeof globalThis !== "undefined" && globalThis.devicePixelRatio) || 1;
	return Math.min(BUBBLE_PREVIEW_MAX_WIDTH, Math.ceil(BUBBLE_PREVIEW_BASE_WIDTH * dpr));
}

// MEDIA-PERF-TZ-4.md §4 A.1 — цель оверлея: вьюпорт по БОЛЬШЕЙ стороне * DPR,
// потолок 2560px. Округление ВВЕРХ до кратного 256 — не косметика: это одновременно
// РЕАЛЬНАЯ ширина растра И часть ключа кэша (plaintext-cache.js::setOverlayUrl) —
// без округления любое разночтение в пиксель (resize окна, полоса адресной
// строки скрылась/появилась) считалось бы НОВЫМ размером, кэш никогда бы не
// попадал; округление вверх группирует близкие вьюпорты в одну и ту же
// закэшированную ширину, но РАЗНЫЕ ориентации (портрет/ландшафт после
// поворота экрана) обычно попадают в разные корзины 256px и не путаются.
export const OVERLAY_MAX_WIDTH = 2560;
const CACHE_KEY_STEP = 256;

function roundUpToStep(px, step) {
	return Math.ceil(px / step) * step;
}

export function overlayTargetWidth(viewportLargerSidePx, adapters = {}) {
	const dpr = adapters.devicePixelRatio ?? ((typeof globalThis !== "undefined" && globalThis.devicePixelRatio) || 1);
	const raw = Math.min(OVERLAY_MAX_WIDTH, Math.ceil((viewportLargerSidePx || OVERLAY_MAX_WIDTH) * dpr));
	return roundUpToStep(raw, CACHE_KEY_STEP);
}

// Однократный проб поддержки WebP-энкода (не на каждую картинку) — избегаем
// двойного convertToBlob на движках, где WebP-энкод не работает вовсе.
let webpSupportCache; // undefined = не пробовали, иначе boolean

async function probeWebpSupport(adapters) {
	if (typeof adapters.webpSupported === "boolean") return adapters.webpSupported; // тесты — без реального canvas
	if (webpSupportCache !== undefined) return webpSupportCache;
	try {
		let canvas;
		if (typeof OffscreenCanvas === "function") canvas = new OffscreenCanvas(2, 2);
		else if (typeof document !== "undefined") {
			canvas = document.createElement("canvas");
			canvas.width = 2;
			canvas.height = 2;
		} else {
			webpSupportCache = false;
			return false;
		}
		const ctx = canvas.getContext("2d");
		ctx.fillRect(0, 0, 2, 2);
		const blob = canvas.convertToBlob
			? await canvas.convertToBlob({ type: "image/webp" })
			: await new Promise((resolve) => canvas.toBlob(resolve, "image/webp"));
		webpSupportCache = !!blob && blob.type === "image/webp";
	} catch {
		webpSupportCache = false;
	}
	return webpSupportCache;
}

// targetWidth — потолок ВЫХОДНОГО canvas по большей стороне; НЕ доверяем
// слепо тому, что createImageBitmap(..., {resizeWidth}) реально уменьшил
// bitmap (опция не гарантирована всеми движками) — сами ограничиваем canvas,
// никогда не апскейлим (scale <= 1).
async function encodeBitmap(bitmap, { type, quality }, targetWidth, adapters) {
	const scale = bitmap.width > targetWidth ? targetWidth / bitmap.width : 1;
	const outW = Math.max(1, Math.round(bitmap.width * scale));
	const outH = Math.max(1, Math.round(bitmap.height * scale));
	if (adapters.convertBitmap) return adapters.convertBitmap(bitmap, { type, quality, width: outW, height: outH });
	if (typeof OffscreenCanvas === "function") {
		const canvas = new OffscreenCanvas(outW, outH);
		const ctx = canvas.getContext("2d");
		ctx.drawImage(bitmap, 0, 0, outW, outH);
		return quality != null ? canvas.convertToBlob({ type, quality }) : canvas.convertToBlob({ type });
	}
	if (typeof document !== "undefined") {
		const canvas = document.createElement("canvas");
		canvas.width = outW;
		canvas.height = outH;
		const ctx = canvas.getContext("2d");
		ctx.drawImage(bitmap, 0, 0, outW, outH);
		return new Promise((resolve) => canvas.toBlob(resolve, type, quality));
	}
	return null;
}

// image-preview.js — ОДНА функция на бабл и оверлей (TZ-4 §4 A.1: "оверлей
// растеризуется той же функцией, что бабл, но с другой целью"). Разница —
// только входные adapters:
//   бабл:    targetWidth = previewTargetWidth()  (база 340px, потолок 1024)
//   оверлей: targetWidth = overlayTargetWidth(viewport) (потолок 2560),
//            webpQuality/jpegQuality = 0.9 (выше 0.82 бабла — оверлей
//            рассматривают внимательно, TZ-4 §4 A.1)
// Уменьшенный растр: createImageBitmap(..., {resizeWidth}) дешевле
// полноразмерного decode + canvas.drawImage (движок сэмплирует уже во время
// декодирования). Формат: WebP по умолчанию, источник с возможной альфой
// (PNG/GIF) — PNG (прозрачность не теряется), движок без WebP-энкода —
// baseline JPEG.
export async function rasterizeImagePreview(bytes, mime, adapters = {}) {
	const createImageBitmapFn =
		adapters.createImageBitmap ?? (typeof createImageBitmap === "function" ? createImageBitmap : null);

	if (!createImageBitmapFn) {
		const url = URL.createObjectURL(new Blob([bytes], { type: mime || "image/jpeg" }));
		return { url, rasterized: false, blobSize: bytes.length };
	}

	const source = new Blob([bytes], { type: mime || "image/jpeg" });
	const targetWidth = adapters.targetWidth ?? previewTargetWidth();
	const webpQuality = adapters.webpQuality ?? 0.82;
	const jpegQuality = adapters.jpegQuality ?? 0.85;
	let bitmap;
	try {
		// resizeWidth — движок decode'ит уже с прицелом на меньший размер,
		// дешевле, чем полный decode + drawImage вручную. Не гарантия:
		// encodeBitmap ниже сам ограничивает canvas targetWidth, даже если
		// движок опцию проигнорировал и вернул bitmap в исходном размере.
		bitmap = await createImageBitmapFn(source, { resizeWidth: targetWidth, resizeQuality: "high" });
	} catch {
		bitmap = await createImageBitmapFn(source); // движок не принял опции resize — decode целиком, downscale ниже
	}
	try {
		const hasAlpha = mime === "image/png" || mime === "image/gif";
		const format = hasAlpha
			? { type: "image/png" }
			: (await probeWebpSupport(adapters))
				? { type: "image/webp", quality: webpQuality }
				: { type: "image/jpeg", quality: jpegQuality };
		const outBlob = await encodeBitmap(bitmap, format, targetWidth, adapters);
		if (!outBlob) {
			const url = URL.createObjectURL(source);
			return { url, rasterized: false, blobSize: bytes.length };
		}
		return { url: URL.createObjectURL(outBlob), rasterized: true, blobSize: outBlob.size };
	} finally {
		bitmap.close?.();
	}
}
