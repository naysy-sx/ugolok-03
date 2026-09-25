// Миниатюра/иконка файла в списках («Файлы», «Полученные»). Общий компонент: раньше жил в files.jsx.
import { useState, useEffect, useRef } from "preact/hooks";
import { getManifest, getRange } from "../../domain/files/content.js";
import { getCachedManifest, putCachedManifest } from "../../domain/files/store.js";
import { getFileKeyFor, backfillMime } from "../signals/files.js";
import { isThumbnailable, createThumbnailBlob } from "../../domain/files/thumbnails.js";
import { registerPlayerFile, unregisterPlayerFile, isPlayerFileRegistered } from "../../domain/files/player-bridge.js";
import { extractVideoFrameFromSrc } from "../media/extract-video-poster.js";
import { createThumbnailQueue } from "../../domain/files/thumbnail-queue.js";
import { getMemoryCachedUrl, putMemoryCachedAttachment } from "../attachment-memory-cache.js";
import { uploadTarget } from "../../domain/files/servers.js";
import FileKindIcon from "./file-kind-icon.jsx";

// Общая на весь экран очередь — иначе каждая строка получила бы СВОЙ
// параллелизм, и общее число одновременных задач росло бы с числом видимых
// строк, а не оставалось 2-4 (ALGO.MD §15).
const thumbnailQueue = createThumbnailQueue(3);

// Миниатюра по видимости (IntersectionObserver) — задача 3.8 TASK.md.
// Манифест (mime/size) неизвестен из самого узла дерева (Node.blob — только
// дайджест, §4.1 TASK.md) — приходится сходить за ним (кэш в files_manifests,
// store.js, сперва; сеть — только если кэш пуст). Отмена — если строка
// покинула вьюпорт РАНЬШЕ, чем задание стартовало (thumbnail-queue.js);
// уже стартовавшее докручивается, не прерывается на середине.
// НАЙДЕНО ПОЛЬЗОВАТЕЛЕМ (этап 53 И7 4.4-довесок): "отправитель видит
// маленькую фотку, получатель — нормальную". Причина — ключ кэша здесь
// (entry.blob = manifestDigest) СОВПАДАЛ с ключом, которым attachment-
// view.jsx кэширует ПОЛНОРАЗМЕРНОЕ вложение чата (тот же manifestDigest,
// если файл был отправлен через дедупликацию, И7 7.4 — один и тот же
// блоб). Миниатюра (200px, downscale) — не то же самое содержимое, что
// полный файл, но раньше делила с ним ОДИН слот в attachment-memory-
// cache.js — кто первым закэшировал (превью в "Файлы" или полный
// просмотр в чате), тот и "выигрывал" для ВСЕХ последующих чтений под
// этим digest'ом. THUMB_CACHE_PREFIX — отдельный неймспейс, чтобы
// уменьшенная и полная версии никогда не делили один ключ.
const THUMB_CACHE_PREFIX = "thumb:";

// Кадр видео для плитки «Файлов». Файл целиком не скачивается: кадр берётся через тот же мост
// /files-content/…, что и плеер — браузер читает только нужные диапазоны. Без service worker
// (нет моста) и при любой неудаче остаётся иконка.
async function videoFrameThumbnail(digest, manifest, fileKey) {
	if (typeof navigator === "undefined" || !navigator.serviceWorker?.controller) return null;
	const alreadyRegistered = isPlayerFileRegistered(digest); // плеер открыт на этом файле — не трогаем его регистрацию
	if (!alreadyRegistered) registerPlayerFile(digest, { manifest, fileKey, serverUrl: uploadTarget() });
	try {
		return await extractVideoFrameFromSrc(`/files-content/${digest}`, manifest.mime);
	} finally {
		if (!alreadyRegistered) unregisterPlayerFile(digest);
	}
}

// resolveKey — как получить ключ файла (по умолчанию — свой файл; для доли — ключ из гранта).
// onManifest — что сделать с манифестом (по умолчанию — дозалить mime узлу «Файлов»).
export default function FileThumbnail({ entry, ownerPubkey, imgClass = "file-row-thumb", resolveKey, onManifest, maxDimension }) {
	// Крупная миниатюра (плитка) — свой ключ кэша: мелкая и крупная версии не делят слот.
	const cachePrefix = maxDimension ? `${THUMB_CACHE_PREFIX}${maxDimension}:` : THUMB_CACHE_PREFIX;
	const [url, setUrl] = useState(() => getMemoryCachedUrl(cachePrefix + entry.blob) ?? null);
	const [failed, setFailed] = useState(false);
	const elRef = useRef(null);

	useEffect(() => {
		if (url || failed || !entry.blob) return;
		let handle = null;
		let cancelled = false;

		const observer = new IntersectionObserver(([observedEntry]) => {
			if (observedEntry.isIntersecting && !handle) {
				handle = thumbnailQueue.enqueue(async () => {
					let manifest = await getCachedManifest(ownerPubkey, entry.blob);
					if (!manifest) {
						manifest = await getManifest(entry.blob, { serverUrl: uploadTarget() });
						await putCachedManifest(ownerPubkey, entry.blob, manifest);
					}
					// Этап E, E1-доп (DESIGN.md) — дозаливка mime старому узлу (⊥),
					// событийно: манифест и так уже резолвлен ради миниатюры. НЕ
					// блокирует саму миниатюру (fire-and-forget) — classCount обновится
					// к следующему открытию/перерисовке шапки, не в этом кадре.
					if (onManifest) onManifest(manifest);
					else if (entry.mime == null) backfillMime(entry.id, manifest.mime).catch(() => {});
					const isVideo = typeof manifest.mime === "string" && manifest.mime.startsWith("video/");
					if (!isThumbnailable(manifest.mime) && !isVideo) return null;
					const fileKey = await (resolveKey ? resolveKey() : getFileKeyFor(entry.blob));
					if (!fileKey) return null; // ключ ещё не персистирован/не наш файл
					if (isVideo) return videoFrameThumbnail(entry.blob, manifest, fileKey);
					const bytes = await getRange(manifest, fileKey, 0, manifest.size, { serverUrl: uploadTarget() });
					return maxDimension ? createThumbnailBlob(bytes, manifest.mime, maxDimension) : createThumbnailBlob(bytes, manifest.mime);
				});
				handle.promise
					.then((thumbBytes) => {
						if (cancelled) return;
						if (!thumbBytes) {
							setFailed(true);
							return;
						}
						setUrl(putMemoryCachedAttachment(cachePrefix + entry.blob, thumbBytes, "image/jpeg"));
					})
					.catch(() => {
						if (!cancelled) setFailed(true);
					});
			} else if (!observedEntry.isIntersecting && handle) {
				handle.cancel();
				handle = null;
			}
		});
		if (elRef.current) observer.observe(elRef.current);

		return () => {
			cancelled = true;
			observer.disconnect();
			handle?.cancel();
		};
	}, [entry.blob, url, failed]);

	if (url) return <img src={url} alt="" class={imgClass} />;
	// ref — на обычный <span>, не напрямую на иконку: Icon* без forwardRef,
	// ref на него не долетает до DOM (найдено живой проверкой).
	return (
		<span ref={elRef} style={{ display: "inline-flex" }}>
			<FileKindIcon mime={entry.mime} />
		</span>
	);
}

