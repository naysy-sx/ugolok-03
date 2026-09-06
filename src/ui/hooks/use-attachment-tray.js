import { useState, useCallback } from "preact/hooks";
import * as core from "./attachment-tray-core.js";
import { errorMessage } from "../signals/i18n.js";
import { uploadMessageAttachmentStreaming, referenceStoredFile } from "../../domain/messaging/attachments.js";
import { BUILD_DEFAULT_BLOSSOM_SERVERS } from "../../config.js";
import { extractVideoPoster } from "../media/extract-video-poster.js";

const BLOSSOM_SERVER_URL = BUILD_DEFAULT_BLOSSOM_SERVERS[0];

function schedulePosters(items, setState) {
	for (const item of items) {
		if (item.type !== "video" || !item.file || item.poster) continue;
		extractVideoPoster(item.file).then((poster) => {
			if (poster) setState((s) => core.setItemPoster(s, item.id, poster));
		});
	}
}

export function useAttachmentTray({ maxItems }) {
	const [state, setState] = useState(core.emptyTrayState());

	const addFiles = useCallback(
		(files) =>
			setState((s) => {
				const next = core.addFiles(s, files, maxItems);
				schedulePosters(next.items, setState);
				return next;
			}),
		[maxItems],
	);
	const addFromStorage = useCallback((refs) => setState((s) => core.addFromStorage(s, refs, maxItems)), [maxItems]);
	const setPosition = useCallback((id, position) => setState((s) => core.setItemPosition(s, id, position)), []);
	const setLayout = useCallback((layout) => setState((s) => core.setTrayLayout(s, layout)), []);
	const remove = useCallback((id) => setState((s) => core.removeItem(s, id)), []);
	const reset = useCallback(() => setState(core.emptyTrayState()), []);

	// FILES-FIX-SPEC.md §7.4, TZ-FIX-FILES-MEDIA-STATIC.md 5.6 — раньше первая
	// же неудача (одна фотка не долетела) выбрасывала исключение НЕМЕДЛЕННО,
	// не пытаясь залить остальные вложения пачки. Теперь цикл ПРОДОЛЖАЕТСЯ по
	// всем job'ам; если хоть один провалился — агрегатная ошибка бросается В
	// КОНЦЕ (существующие вызывающие стороны chat.jsx/channel-composer.jsx уже
	// оборачивают uploadAll в try/catch и НЕ отправляют сообщение при throw —
	// то самое "не слать с дырой"), но partialResults/failures на ошибке
	// сохраняют то, что реально успело залиться — задел под будущее "повторить
	// только неудавшиеся" без переисполнения уже готовых вложений.
	// options.signal — отмена (BUD-02 идемпотентен по хешу, повторный PUT того
	// же содержимого не страшен, но недогруженный PUT должен прерываться).
	const uploadAll = useCallback(
		async (privKey, onProgress, options = {}) => {
			const { signal } = options;
			const jobs = core.planUpload(state);
			const results = [];
			const failures = [];
			for (let i = 0; i < jobs.length; i++) {
				const job = jobs[i];
				if (signal?.aborted) {
					failures.push({ index: i, error: new DOMException("Отменено", "AbortError") });
					continue;
				}
				try {
					let descriptor;
					if (job.kind === "reference") {
						descriptor = referenceStoredFile(job.manifestDigest, job.fileKey, job.manifest);
					} else {
						descriptor = await uploadMessageAttachmentStreaming(BLOSSOM_SERVER_URL, job.file, { mime: job.mime, name: job.name }, privKey, { signal });
					}
					if (job.isImage) descriptor.position = job.position;
					if (job.layout) descriptor.layout = job.layout;
					let poster = job.poster;
					if (!poster && job.kind === "upload" && job.file && typeof job.file.type === "string" && job.file.type.startsWith("video/")) {
						poster = await extractVideoPoster(job.file);
					}
					if (poster) descriptor.poster = poster;
					results.push(descriptor);
				} catch (err) {
					failures.push({ index: i, error: err });
				}
				onProgress?.(i + 1, jobs.length);
			}
			if (failures.length > 0) {
				const first = failures[0].error;
				const aggregate = first instanceof Error ? first : new Error(String(first));
				aggregate.partialResults = results;
				aggregate.failures = failures;
				throw aggregate;
			}
			return results;
		},
		[state],
	);

	return {
		items: state.items.map((item) => ({ ...item, error: item.error ? errorMessage(item.error) : undefined })),
		errors: state.errors.map(errorMessage),
		layout: state.layout,
		addFiles,
		addFromStorage,
		setPosition,
		setLayout,
		remove,
		reset,
		uploadAll,
	};
}
