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

	const uploadAll = useCallback(
		async (privKey, onProgress) => {
			const jobs = core.planUpload(state);
			const results = [];
			for (let i = 0; i < jobs.length; i++) {
				const job = jobs[i];
				let descriptor;
				if (job.kind === "reference") {
					descriptor = referenceStoredFile(job.manifestDigest, job.fileKey, job.manifest);
				} else {
					descriptor = await uploadMessageAttachmentStreaming(BLOSSOM_SERVER_URL, job.file, { mime: job.mime, name: job.name }, privKey);
				}
				if (job.isImage) descriptor.position = job.position;
				if (job.layout) descriptor.layout = job.layout;
				let poster = job.poster;
				if (!poster && job.kind === "upload" && job.file && typeof job.file.type === "string" && job.file.type.startsWith("video/")) {
					poster = await extractVideoPoster(job.file);
				}
				if (poster) descriptor.poster = poster;
				results.push(descriptor);
				onProgress?.(i + 1, jobs.length);
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
