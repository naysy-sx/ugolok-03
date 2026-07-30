import { test } from "node:test";
import assert from "node:assert/strict";
import { validateAttachment, ALLOWED_MIME_TYPES, MAX_IMAGE_FILE_SIZE, MAX_VIDEO_SIZE, MAX_VOICE_SIZE } from "../src/domain/files/attachment-validation.js";

test("validateAttachment: допустимый image в пределах лимита — не бросает (AC-AT-01)", () => {
	assert.doesNotThrow(() => validateAttachment({ mime: "image/jpeg", size: 5 * 1024 * 1024 }));
});

test("validateAttachment: допустимое видео в пределах лимита — не бросает (AC-AT-02)", () => {
	assert.doesNotThrow(() => validateAttachment({ mime: "video/mp4", size: 15 * 1024 * 1024 }));
});

test("validateAttachment: 25 MB image — отказ (AC-AT-04)", () => {
	assert.throws(() => validateAttachment({ mime: "image/jpeg", size: 25 * 1024 * 1024 }), /размер/);
});

test("validateAttachment: недопустимый MIME (.exe) — отказ (AC-AT-05)", () => {
	assert.throws(() => validateAttachment({ mime: "application/x-msdownload", size: 1024 }), /тип/);
});

test("validateAttachment: аудио свыше 50 MB — отказ, даже если формат допустим (этап 29-довесок)", () => {
	assert.throws(() => validateAttachment({ mime: "audio/ogg", size: 51 * 1024 * 1024 }), /размер/);
});

test("validateAttachment: видео ровно на границе лимита (=MAX_VIDEO_SIZE) — допустимо, > — нет", () => {
	assert.doesNotThrow(() => validateAttachment({ mime: "video/webm", size: MAX_VIDEO_SIZE }));
	assert.throws(() => validateAttachment({ mime: "video/webm", size: MAX_VIDEO_SIZE + 1 }));
});

test("validateAttachment: документы (pdf/docx/etc) допустимы и делят лимит с image, не с video/audio", () => {
	assert.doesNotThrow(() => validateAttachment({ mime: "application/pdf", size: MAX_IMAGE_FILE_SIZE }));
	assert.throws(() => validateAttachment({ mime: "application/pdf", size: MAX_IMAGE_FILE_SIZE + 1 }));
});

test("ALLOWED_MIME_TYPES: содержит все MIME из F-AT-05 буквально", () => {
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
	]) {
		assert.ok(ALLOWED_MIME_TYPES.has(mime), `${mime} должен быть в списке допустимых`);
	}
});

test("MAX_VOICE_SIZE/MAX_VIDEO_SIZE — 50 MB (этап 29-довесок, по просьбе пользователя)", () => {
	assert.equal(MAX_VOICE_SIZE, 50 * 1024 * 1024);
	assert.equal(MAX_VIDEO_SIZE, 50 * 1024 * 1024);
});
