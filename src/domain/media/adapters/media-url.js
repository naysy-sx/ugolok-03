// Медиа-подсистема, этап D (MEDIA-SPEC.md §2.2/§3.6) — MediaRef -> src,
// адаптер (знает про DOM/browser API — URL.createObjectURL, мост SW —
// НЕ про Preact). Мост "страница <-> service worker" (registerPlayerFile/
// unregisterPlayerFile, player-bridge.js) уже построен и работает
// (file-player.jsx) — здесь не переписывается, только вызывается.
//
// Мемоизация по ref.digest — resourceOwner (владение жизненным циклом)
// и view-компонент (D3, чтение src для рендера) зовут ОДНУ И ТУ ЖЕ
// функцию без двойного счёта: единственный РЕАЛЬНЫЙ acquire/release
// держит resourceOwner (единожды на переход счётчика 0->1/1->0),
// компонент просто дожидается того же promise/результата.
//
// Кэш манифестов НЕ используется здесь (в отличие от file-player.jsx,
// который кэширует через getCachedManifest/putCachedManifest) —
// сознательное упрощение: тот кэш ownerPubkey-scoped (IndexedDB), а
// media.js НЕ импортирует auth.js (см. DESIGN.md "Этап D" — цикл
// auth.js->media.js->auth.js). В рамках ОДНОЙ сессии просмотра
// собственная мемоизация ниже даёт тот же эффект (без сети на повторный
// acquire того же digest); кросс-сессионное кэширование манифеста -
// не в скоупе этого этапа, при необходимости — отдельное решение.
import { getManifest, getRange } from "../../files/content.js";
import { registerPlayerFile, unregisterPlayerFile } from "../../files/player-bridge.js";
import { resolveImageOverlayUrl } from "../image-preview.js";
import { putPlaintextBytes } from "../plaintext-cache.js";
import { recordControllerCheck } from "../perf-trace.js";
import { downloadPercent } from "../progress-indicator.js";
import { PRIORITY } from "../../../core/transport/blossom-queue.js";

const handles = new Map(); // digest -> Promise<{kind, src, url}>

// video/audio/file-viewer читают handle.src, image-viewer — handle.url.
// Раньше object-url-фолбэк (нет SW-controller — типичный мобильный Safari)
// отдавал только `.url`, и <video src={handle.src}> получал undefined:
// после деплоя 31dd531 видео на телефонах перестало играть совсем.
export function mediaElementSrc(handle) {
	if (!handle) return null;
	return handle.src ?? handle.url ?? null;
}

// MEDIA-PERF-TZ.md §3.3 — единственный способ узнать, живёт ли Range-путь
// (§5) у реальных пользователей или все видео/аудио тихо идут по полному
// download-фолбэку ниже: копим накопительно в localStorage, ВСЕГДА, вне
// зависимости от флага ugolok:perf.
async function canUseFilesContentBridge() {
	if (typeof navigator === "undefined" || !navigator.serviceWorker) {
		recordControllerCheck(true); // окружение без SW вовсе (тесты/старый браузер) — не в счёт "фолбэка живого SW"
		return true;
	}
	if (navigator.serviceWorker.controller) {
		recordControllerCheck(true);
		return true;
	}
	try {
		await navigator.serviceWorker.ready;
	} catch {
		recordControllerCheck(false);
		return false;
	}
	const ok = !!navigator.serviceWorker.controller;
	recordControllerCheck(ok);
	return ok;
}

export async function acquireMediaUrl(ref, { serverUrl, fetchImpl, rasterAdapters, onProgress, useFilesContentBridge } = {}) {
	const cached = handles.get(ref.digest);
	if (cached) {
		const handle = await cached;
		if (handle?.kind === "bridge" && handle.manifest) {
			registerPlayerFile(ref.digest, {
				manifest: handle.manifest,
				fileKey: handle.fileKey ?? ref.key,
				serverUrl: handle.serverUrl ?? serverUrl,
				fetchImpl: handle.fetchImpl ?? fetchImpl,
			});
		}
		return handle;
	}

	const promise = (async () => {
		if (ref.mime.startsWith("image/")) {
			// Оверлей (MEDIA-PERF-TZ.md §4.1) — единственный вызывающий этой ветки
			// сейчас ImageViewer (media-overlay.jsx). Бабл (attachment-view.jsx,
			// feed-item.jsx) идёт СВОИМ путём напрямую через resolveImagePreviewUrl,
			// не через acquireMediaUrl.
			const raster = await resolveImageOverlayUrl(
				ref.digest,
				ref.mime,
				async (trace, onDownload) => {
					onProgress?.({ phase: "decrypting", percent: null });
					// MEDIA-PERF-TZ-5.md §2 — оверлей: пользователь смотрит ПРЯМО
					// СЕЙЧАС, приоритет выше фоновых превью, но ниже активного
					// плеера видео/аудио.
					const manifest = await getManifest(ref.digest, { serverUrl, fetchImpl, priority: PRIORITY.OVERLAY });
					return getRange(manifest, ref.key, 0, manifest.size, { serverUrl, fetchImpl, trace, priority: PRIORITY.OVERLAY, onProgress: onDownload });
				},
				rasterAdapters,
				onProgress,
			);
			return { kind: "cached-url", url: raster.url, src: raster.url, rasterized: raster.rasterized };
		}
		// MEDIA-PERF-TZ-5.md §2 — маленький, но блокирует всё дальнейшее (и
		// мостовой путь, и фолбэк-скачивание целиком) — PRIORITY.OVERLAY, не
		// PREVIEW, независимо от того, куда пойдёт дальше.
		const manifest = await getManifest(ref.digest, { serverUrl, fetchImpl, priority: PRIORITY.OVERLAY });
		const useBridge = useFilesContentBridge !== undefined ? useFilesContentBridge : await canUseFilesContentBridge();
		if (!useBridge) {
			// MEDIA-PERF-TZ.md §6.3 — фолбэк без SW-controller качает файл ЦЕЛИКОМ;
			// раньше единственный статус был неопределённый "preparing" (в чате —
			// "Подготовка просмотра…"). Теперь на каждый чанк отдаём процент —
			// не ускоряет скачивание, но убирает ощущение зависания, которое и
			// было предметом жалобы (§6.3, "дёшево, делать в этом проходе").
			onProgress?.({ phase: "preparing", percent: 0 });
			// MEDIA-PERF-TZ-5.md §2 — фолбэк без SW-контроллера не может быть
			// выше плеера, иначе одно видео на старом Safari забьёт весь пул;
			// PREVIEW и так значение по умолчанию, указано явно для честности.
			const bytes = await getRange(manifest, ref.key, 0, manifest.size, {
				serverUrl,
				fetchImpl,
				priority: PRIORITY.PREVIEW,
				onProgress: (p) => onProgress?.({ phase: "preparing", percent: downloadPercent(p) ?? 0 }),
			});
			putPlaintextBytes(ref.digest, bytes, ref.mime);
			const url = URL.createObjectURL(new Blob([bytes], { type: ref.mime }));
			return { kind: "object-url", url, src: url };
		}
		registerPlayerFile(ref.digest, { manifest, fileKey: ref.key, serverUrl, fetchImpl });
		const src = `/files-content/${ref.digest}`;
		return { kind: "bridge", src, url: src, manifest, fileKey: ref.key, serverUrl, fetchImpl };
	})();

	handles.set(ref.digest, promise);
	return promise;
}

// async, не fire-and-forget внутри: Promise.then() ВСЕГДА откладывает
// колбэк в микрозадачу, даже если промис уже готов (гарантия Promises/A+) —
// синхронной версии "снять регистрацию прямо сейчас" не существует в
// принципе, если acquire ещё мог быть в полёте. Функция возвращает promise
// ИМЕННО чтобы вызывающая сторона (тесты; resourceOwner — по желанию) могла
// дождаться реального завершения очистки, а не полагаться на порядок
// микрозадач угадыванием.
export async function releaseMediaUrlHandle(digest) {
	const pending = handles.get(digest);
	if (!pending) return;
	handles.delete(digest);
	try {
		const handle = await pending;
		if (handle.kind === "bridge") unregisterPlayerFile(digest);
		else if (handle.kind === "object-url") URL.revokeObjectURL(handle.url);
	} catch {
		// acquire упал — нечего освобождать
	}
}
