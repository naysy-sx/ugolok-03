// MEDIA-PERF-TZ.md §4.1 — бабл и оверлей раньше делили ОДНУ функцию
// (resolveImagePreviewUrl) и ОДИН slot в plaintext-cache: клик по бабл-
// превью открывал оверлей с уже готовым (уменьшенным!) растром вместо
// исходного изображения. Теперь два раздельных резолвера, каждый со своим
// slot'ом (getPreviewUrl/setPreviewUrl vs getOverlayUrl/setOverlayUrl) —
// исходные РАСШИФРОВАННЫЕ байты (plaintext-cache) при этом ОДНИ на оба
// (§8 п.3, решение автора): loadBytes() бьёт в сеть максимум один раз,
// независимо от того, что открыли первым — бабл или оверлей.
//
// MEDIA-PERF-TZ-4.md §4 A.1 — оверлей больше НЕ использует img.decode() на
// исходных байтах (убрано вместе с гонкой-таймаутом — зум выше "вписать в
// экран" оверлей не умеет, полноразмерный decode не нужен никогда, см.
// raster-image.js). Обе функции ниже зовут ОДНУ и ту же rasterizeImagePreview,
// различаются только целью (targetWidth) и качеством кодека.
import { getPlaintextBytes, getPreviewUrl, getOverlayUrl, putPlaintextBytes, setPreviewUrl, setOverlayUrl } from "./plaintext-cache.js";
import { rasterizeImagePreview, overlayTargetWidth } from "./raster-image.js";
import { startTrace } from "./perf-trace.js";

// Бабл: уменьшенный растр (WebP/JPEG/PNG по формату источника). loadBytes(trace) —
// вызывающая сторона (attachment-view.jsx/feed-item.jsx) МОЖЕТ принять trace
// и передать его дальше в content.js (net/decrypt лягут в ту же строку), но
// не обязана — JS не ругается на лишний аргумент у closure с меньшим числом
// объявленных параметров (старые вызовы/тесты с () => ... продолжают работать).
export async function resolveImagePreviewUrl(digest, mime, loadBytes, adapters, onProgress) {
	const trace = startTrace("image-bubble", digest, undefined);
	const existing = getPreviewUrl(digest);
	if (existing) {
		trace.end({ cacheHit: 1 });
		return { url: existing, rasterized: true };
	}

	let bytes = getPlaintextBytes(digest);
	let bytesCacheHit = bytes ? 1 : 0;
	if (!bytes) {
		onProgress?.("loading");
		// loadBytes(trace) — closures existant с нулём объявленных параметров
		// (старые тесты/вызовы) молча игнорируют лишний аргумент, JS это
		// разрешает; новые closures (attachment-view.jsx и т.д.) принимают
		// trace и пробрасывают его в getOrDownloadMessageAttachment/getRange,
		// чтобы net/decrypt легли В ТУ ЖЕ строку, что raster ниже.
		bytes = await loadBytes(trace);
		putPlaintextBytes(digest, bytes, mime);
	}
	onProgress?.("preparing");
	const rasterStart = perfNow();
	const raster = await rasterizeImagePreview(bytes, mime, adapters);
	trace.mark("raster", perfNow() - rasterStart);
	setPreviewUrl(digest, raster.url);
	trace.end({ cacheHit: bytesCacheHit, bytes: bytes.length, outBytes: raster.blobSize ?? bytes.length });
	return raster;
}

// Оверлей: та же rasterizeImagePreview, что бабл, но с целью под вьюпорт
// (потолок 2560px вместо 1024, качество кодека 0.9 вместо 0.82 — оверлей
// рассматривают внимательно). adapters.targetWidth, если передан явно
// (media-url.js/image-viewer.jsx считают его от текущего вьюпорта*DPR),
// используется как есть; иначе — overlayTargetWidth(adapters.viewportLargerSidePx)
// с тем же потолком по умолчанию. Ключ кэша в plaintext-cache.js ВКЛЮЧАЕТ
// targetWidth — открытие того же digest после поворота экрана/resize с ДРУГИМ
// вьюпортом не покажет растр, посчитанный под старый (TZ-4 §9). Использует
// ТОТ ЖЕ plaintext-cache байт, что бабл — если бабл уже загрузил байты, здесь
// loadBytes() не вызывается.
export async function resolveImageOverlayUrl(digest, mime, loadBytes, adapters = {}, onProgress) {
	const targetWidth = adapters.targetWidth ?? overlayTargetWidth(adapters.viewportLargerSidePx, adapters);
	const trace = startTrace("image-overlay", digest, undefined);
	const existing = getOverlayUrl(digest, targetWidth);
	if (existing) {
		trace.end({ cacheHit: 1 });
		return { url: existing, rasterized: true };
	}

	let bytes = getPlaintextBytes(digest);
	let bytesCacheHit = bytes ? 1 : 0;
	if (!bytes) {
		onProgress?.("loading");
		bytes = await loadBytes(trace);
		putPlaintextBytes(digest, bytes, mime);
	}
	onProgress?.("preparing");

	const rasterStart = perfNow();
	const raster = await rasterizeImagePreview(bytes, mime, {
		...adapters,
		targetWidth,
		webpQuality: adapters.webpQuality ?? 0.9,
		jpegQuality: adapters.jpegQuality ?? 0.9,
	});
	trace.mark("raster", perfNow() - rasterStart);
	setOverlayUrl(digest, targetWidth, raster.url);
	trace.end({ cacheHit: bytesCacheHit, bytes: bytes.length, outBytes: raster.blobSize ?? bytes.length, targetWidth });
	return raster;
}

function perfNow() {
	return typeof performance !== "undefined" && typeof performance.now === "function" ? performance.now() : Date.now();
}
