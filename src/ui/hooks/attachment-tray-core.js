import { DomainError } from "../../domain/errors.js";
import { classOf } from "../../domain/media/media-ref.js";
import { validateAttachment } from "../../domain/files/attachment-validation.js";
import { inferLayout } from "../components/bubble-attachment-plan.js";

function typeFromMime(mime) {
	const c = classOf(mime);
	return c === "other" ? "file" : c;
}

function tooManyError(maxItems) {
	return new DomainError(`нельзя добавить больше ${maxItems} вложений`, "errors.tooManyAttachments", { max: maxItems });
}

function withValidation(mime, size) {
	try {
		validateAttachment({ mime, size });
		return undefined;
	} catch (err) {
		return err;
	}
}

function visualCount(items) {
	return items.filter((item) => item.type === "image" || item.type === "video").length;
}

function withLayout(state) {
	const n = visualCount(state.items);
	if (n < 2) return { ...state, layout: null };
	if (state.layout == null) return { ...state, layout: inferLayout(n) };
	return { ...state, layout: state.layout };
}

export function emptyTrayState() {
	return { items: [], errors: [], layout: null };
}

export function addFiles(state, files, maxItems) {
	const room = maxItems - state.items.length;
	const input = Array.from(files);
	if (room <= 0) {
		return withLayout({ items: state.items, errors: input.length > 0 ? [tooManyError(maxItems)] : [], layout: state.layout });
	}
	const taken = input.slice(0, room);
	const newItems = taken.map((file) => ({
		id: crypto.randomUUID(),
		file,
		storageRef: null,
		mime: file.type,
		name: file.name,
		size: file.size,
		type: typeFromMime(file.type),
		position: "below",
		error: withValidation(file.type, file.size),
	}));
	const errors = input.length > taken.length ? [tooManyError(maxItems)] : [];
	return withLayout({ items: [...state.items, ...newItems], errors, layout: state.layout });
}

export function addFromStorage(state, refs, maxItems) {
	const room = maxItems - state.items.length;
	const input = Array.from(refs);
	if (room <= 0) {
		return withLayout({ items: state.items, errors: input.length > 0 ? [tooManyError(maxItems)] : [], layout: state.layout });
	}
	const taken = input.slice(0, room);
	const newItems = taken.map((ref) => ({
		id: crypto.randomUUID(),
		file: null,
		storageRef: ref,
		mime: ref.manifest.mime,
		name: ref.manifest.name,
		size: ref.manifest.size,
		type: typeFromMime(ref.manifest.mime),
		position: "below",
		error: withValidation(ref.manifest.mime, ref.manifest.size),
	}));
	const errors = input.length > taken.length ? [tooManyError(maxItems)] : [];
	return withLayout({ items: [...state.items, ...newItems], errors, layout: state.layout });
}

export function setItemPosition(state, id, position) {
	const items = state.items.map((item) => (item.id === id && item.type === "image" ? { ...item, position } : item));
	return { items, errors: state.errors, layout: state.layout };
}

export function removeItem(state, id) {
	return withLayout({ items: state.items.filter((item) => item.id !== id), errors: state.errors, layout: state.layout });
}

export function setTrayLayout(state, layout) {
	if (visualCount(state.items) < 2) return { ...state, layout: null };
	return { ...state, layout };
}

export function setItemPoster(state, id, poster) {
	const items = state.items.map((item) => (item.id === id ? { ...item, poster } : item));
	return { items, errors: state.errors, layout: state.layout };
}

export function planUpload(state) {
	const items = state.items;
	const broken = items.find((item) => item.error);
	if (broken) throw broken.error;

	const resolved = state.layout ?? inferLayout(visualCount(items));
	return items.map((item) => {
		const isImage = item.type === "image";
		const isVisualItem = item.type === "image" || item.type === "video";
		const job = item.storageRef
			? { id: item.id, kind: "reference", manifestDigest: item.storageRef.manifestDigest, fileKey: item.storageRef.fileKey, manifest: item.storageRef.manifest, isImage, position: item.position }
			: { id: item.id, kind: "upload", file: item.file, mime: item.mime, name: item.name, isImage, position: item.position };
		if (isVisualItem && resolved) job.layout = resolved;
		if (item.type === "video" && item.poster) job.poster = item.poster;
		return job;
	});
}
