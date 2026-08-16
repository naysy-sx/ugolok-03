import { useState, useCallback } from "preact/hooks";
import * as core from "./attachment-tray-core.js";
import { errorMessage } from "../signals/i18n.js";
import { uploadMessageAttachment, referenceStoredFile } from "../../domain/messaging/attachments.js";
import { BUILD_DEFAULT_BLOSSOM_SERVERS } from "../../config.js";

const BLOSSOM_SERVER_URL = BUILD_DEFAULT_BLOSSOM_SERVERS[0];

export function useAttachmentTray({ maxItems }) {
	const [state, setState] = useState(core.emptyTrayState());

	const addFiles = useCallback((files) => setState((s) => core.addFiles(s, files, maxItems)), [maxItems]);
	const addFromStorage = useCallback((refs) => setState((s) => core.addFromStorage(s, refs, maxItems)), [maxItems]);
	const setPosition = useCallback((id, position) => setState((s) => core.setItemPosition(s, id, position)), []);
	const remove = useCallback((id) => setState((s) => core.removeItem(s, id)), []);
	const reset = useCallback(() => setState(core.emptyTrayState()), []);

	const uploadAll = useCallback(
		async (privKey, onProgress) => {
			const jobs = core.planUpload(state.items);
			const results = [];
			for (let i = 0; i < jobs.length; i++) {
				const job = jobs[i];
				let descriptor;
				if (job.kind === "reference") {
					descriptor = referenceStoredFile(job.manifestDigest, job.fileKey, job.manifest);
				} else {
					const bytes = new Uint8Array(await job.file.arrayBuffer());
					descriptor = await uploadMessageAttachment(BLOSSOM_SERVER_URL, bytes, { mime: job.mime, name: job.name }, privKey);
				}
				if (job.isImage) descriptor.position = job.position;
				results.push(descriptor);
				onProgress?.(i + 1, jobs.length);
			}
			return results;
		},
		[state.items],
	);

	return {
		items: state.items.map((item) => ({ ...item, error: item.error ? errorMessage(item.error) : undefined })),
		errors: state.errors.map(errorMessage),
		addFiles,
		addFromStorage,
		setPosition,
		remove,
		reset,
		uploadAll,
	};
}
