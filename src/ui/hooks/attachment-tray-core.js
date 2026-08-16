import { DomainError } from "../../domain/errors.js";
import { classOf } from "../../domain/media/media-ref.js";
import { validateAttachment } from "../../domain/files/attachment-validation.js";

// Та же переклассификация, что messaging/attachments.js::attachmentTypeFromMime
// (приватная там) — сознательный дубль.
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

export function emptyTrayState() {
	return { items: [], errors: [] };
}

export function addFiles(state, files, maxItems) {
	const room = maxItems - state.items.length;
	const input = Array.from(files);
	if (room <= 0) {
		return { items: state.items, errors: input.length > 0 ? [tooManyError(maxItems)] : [] };
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
	return { items: [...state.items, ...newItems], errors };
}

export function addFromStorage(state, refs, maxItems) {
	const room = maxItems - state.items.length;
	const input = Array.from(refs);
	if (room <= 0) {
		return { items: state.items, errors: input.length > 0 ? [tooManyError(maxItems)] : [] };
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
	return { items: [...state.items, ...newItems], errors };
}

export function setItemPosition(state, id, position) {
	const items = state.items.map((item) => (item.id === id && item.type === "image" ? { ...item, position } : item));
	return { items, errors: state.errors };
}

export function removeItem(state, id) {
	return { items: state.items.filter((item) => item.id !== id), errors: state.errors };
}

export function planUpload(items) {
	const broken = items.find((item) => item.error);
	if (broken) throw broken.error;

	return items.map((item) => {
		const isImage = item.type === "image";
		if (item.storageRef) {
			return { id: item.id, kind: "reference", manifestDigest: item.storageRef.manifestDigest, fileKey: item.storageRef.fileKey, manifest: item.storageRef.manifest, isImage, position: item.position };
		}
		return { id: item.id, kind: "upload", file: item.file, mime: item.mime, name: item.name, isImage, position: item.position };
	});
}
