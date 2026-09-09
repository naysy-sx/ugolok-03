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
import { resolveImagePreviewUrl } from "../image-preview.js";
import { putPlaintextBytes } from "../plaintext-cache.js";

const handles = new Map(); // digest -> Promise<{kind, src|url}>

async function canUseFilesContentBridge() {
	if (typeof navigator === "undefined" || !navigator.serviceWorker) return true;
	if (navigator.serviceWorker.controller) return true;
	try {
		await navigator.serviceWorker.ready;
	} catch {
		return false;
	}
	return !!navigator.serviceWorker.controller;
}

export async function acquireMediaUrl(ref, { serverUrl, fetchImpl, rasterAdapters, onProgress } = {}) {
	const cached = handles.get(ref.digest);
	if (cached) return cached;

	const promise = (async () => {
		if (ref.mime.startsWith("image/")) {
			const raster = await resolveImagePreviewUrl(
				ref.digest,
				ref.mime,
				async () => {
					onProgress?.("decrypting");
					const manifest = await getManifest(ref.digest, { serverUrl, fetchImpl });
					return getRange(manifest, ref.key, 0, manifest.size, { serverUrl, fetchImpl });
				},
				rasterAdapters,
				onProgress,
			);
			return { kind: "cached-url", url: raster.url, rasterized: raster.rasterized };
		}
		const manifest = await getManifest(ref.digest, { serverUrl, fetchImpl });
		const useBridge = await canUseFilesContentBridge();
		if (!useBridge) {
			onProgress?.("preparing");
			const bytes = await getRange(manifest, ref.key, 0, manifest.size, { serverUrl, fetchImpl });
			putPlaintextBytes(ref.digest, bytes, ref.mime);
			const url = URL.createObjectURL(new Blob([bytes], { type: ref.mime }));
			return { kind: "object-url", url };
		}
		registerPlayerFile(ref.digest, { manifest, fileKey: ref.key, serverUrl, fetchImpl });
		return { kind: "bridge", src: `/files-content/${ref.digest}` };
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
