import { test } from "node:test";
import assert from "node:assert/strict";
import { validateAttachment, ALLOWED_MIME_TYPES, MAX_SANITY_FILE_SIZE } from "../src/domain/files/attachment-validation.js";

// Этап 62 — правка контракта: раздельные лимиты по типу (image/video/audio)
// удалены из КЛИЕНТА, decisive-проверка теперь server-side (BUD-06,
// checkUploadRequirements). Здесь остаётся ТОЛЬКО щедрый санити-чек — один
// потолок на ВСЕ MIME, отсекающий заведомо неадекватные файлы ДО сети, не
// мнение о лимите конкретного сервера.

test("validateAttachment: допустимый image в пределах санити-потолка — не бросает", () => {
	assert.doesNotThrow(() => validateAttachment({ mime: "image/jpeg", size: 5 * 1024 * 1024 }));
});

test("validateAttachment: допустимое видео 300 MB (в пределах санити-потолка) — не бросает", () => {
	assert.doesNotThrow(() => validateAttachment({ mime: "video/mp4", size: 300 * 1024 * 1024 }));
});

test("validateAttachment: недопустимый MIME (.exe) — отказ", () => {
	assert.throws(() => validateAttachment({ mime: "application/x-msdownload", size: 1024 }), /тип/);
});

test("validateAttachment: файл ровно на границе MAX_SANITY_FILE_SIZE — допустимо, > — нет", () => {
	assert.doesNotThrow(() => validateAttachment({ mime: "video/mp4", size: MAX_SANITY_FILE_SIZE }));
	assert.throws(() => validateAttachment({ mime: "video/mp4", size: MAX_SANITY_FILE_SIZE + 1 }), /размер/);
});

test("validateAttachment: санити-потолок ОДИН И ТОТ ЖЕ для image/video/audio/документов — не делит на бакеты (это делает сервер)", () => {
	for (const mime of ["image/jpeg", "video/webm", "audio/ogg", "application/pdf"]) {
		assert.doesNotThrow(() => validateAttachment({ mime, size: MAX_SANITY_FILE_SIZE }));
		assert.throws(() => validateAttachment({ mime, size: MAX_SANITY_FILE_SIZE + 1 }), /размер/);
	}
});

test("ALLOWED_MIME_TYPES: содержит все MIME из F-AT-05 буквально, включая документы", () => {
	for (const mime of [
		"image/jpeg",
		"image/png",
		"image/gif",
		"image/webp",
		"video/mp4",
		"video/webm",
		"audio/webm",
		"audio/ogg",
		"audio/mpeg",
		"audio/mp4",
		"application/pdf",
		"application/vnd.openxmlformats-officedocument.wordprocessingml.document",
		"application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
		"application/vnd.openxmlformats-officedocument.presentationml.presentation",
		"text/plain",
		"text/markdown",
		"text/csv",
		"application/json",
	]) {
		assert.ok(ALLOWED_MIME_TYPES.has(mime), `${mime} должен быть в списке допустимых`);
	}
});

test("MAX_SANITY_FILE_SIZE — 1 ГБ (этап 62: единый щедрый клиентский потолок, не мнение сервера)", () => {
	assert.equal(MAX_SANITY_FILE_SIZE, 1 * 1024 * 1024 * 1024);
});
