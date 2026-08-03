import { DomainError } from "../errors.js";

export const ALLOWED_MIME_TYPES = new Set([
	"image/jpeg", "image/png", "image/gif", "image/webp",
	"video/mp4", "video/webm",
	"audio/webm", "audio/ogg", "audio/mpeg", "audio/mp4",
	"application/pdf",
	"application/vnd.openxmlformats-officedocument.wordprocessingml.document",
	"application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
	"application/vnd.openxmlformats-officedocument.presentationml.presentation",
	"text/plain", "text/markdown", "text/csv", "application/json",
]);

export const MAX_SANITY_FILE_SIZE = 1 * 1024 * 1024 * 1024; // 1 ГБ

export function validateAttachment({ mime, size }) {
	if (!ALLOWED_MIME_TYPES.has(mime)) {
		throw new DomainError(`недопустимый тип файла: ${mime}`, "errors.invalidFileType", { mime });
	}

	if (size > MAX_SANITY_FILE_SIZE) {
		throw new DomainError(`файл превышает лимит размера`, "errors.fileTooLarge");
	}
}
