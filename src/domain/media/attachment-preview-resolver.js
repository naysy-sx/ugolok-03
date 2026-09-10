// MEDIA-PERF-TZ-5.md §3 — сторона показа: attachment.previewDigest/previewKey,
// если есть, резолвится в маленький object-URL БЕЗ единого запроса к
// оригиналу (getManifest/getRange ниже ВСЕГДА получают previewDigest/
// previewKey — по построению, не по проверке — оригинал этот модуль вообще
// не видит). Вложение БЕЗ previewDigest — не в скоупе этого модуля вовсе,
// вызывающая сторона (attachment-view.jsx/bubble-attachment-cluster.jsx)
// обязана сама решить рендерить старым путём (обратная совместимость,
// контракт §3: "без миграции старых сообщений").
import { getManifest, getRange } from "../files/content.js";
import { PRIORITY } from "../../core/transport/blossom-queue.js";

function base64ToBytes(str) {
	return Uint8Array.from(atob(str), (c) => c.charCodeAt(0));
}

// digest -> Promise<string|null> (object URL). Мемоизация по previewDigest —
// повторное открытие того же вложения (переход между экранами, ре-рендер) не
// бьёт в сеть второй раз. Промисы, разрешившиеся в null (отказ), НЕ кэшируются
// навсегда — TTL нет, но следующий вызов после отказа сам создаст новый
// промис (see: удаление из handles при отказе, тот же приём, что §7 п.1 media-
// url.js "кнопка повторить сейчас не работает").
const handles = new Map();

// PRIORITY.PREVIEW — превью в пузыре/плитке, тот же приоритет, что остальные
// фоновые превью (media-url.js §2 MEDIA-PERF-TZ-5.md), ниже активного плеера
// и оверлея.
export async function resolveAttachmentPreviewUrl(attachment, { serverUrl, fetchImpl } = {}) {
	if (!attachment?.previewDigest || !attachment?.previewKey) return null;

	const cached = handles.get(attachment.previewDigest);
	if (cached) return cached;

	const promise = (async () => {
		const manifest = await getManifest(attachment.previewDigest, { serverUrl, fetchImpl, priority: PRIORITY.PREVIEW });
		const bytes = await getRange(manifest, base64ToBytes(attachment.previewKey), 0, manifest.size, {
			serverUrl,
			fetchImpl,
			priority: PRIORITY.PREVIEW,
		});
		return URL.createObjectURL(new Blob([bytes], { type: manifest.mime || "image/jpeg" }));
	})().catch(() => {
		handles.delete(attachment.previewDigest); // отказ — не занимать кэш навсегда, следующий вызов пробует заново
		return null;
	});

	handles.set(attachment.previewDigest, promise);
	return promise;
}
