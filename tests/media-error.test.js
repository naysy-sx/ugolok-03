import { test } from "node:test";
import assert from "node:assert/strict";
import { mediaErrorReasonKey, isTransientMediaError, MEDIA_ERR_ABORTED, MEDIA_ERR_NETWORK, MEDIA_ERR_DECODE, MEDIA_ERR_SRC_NOT_SUPPORTED } from "../src/domain/media/media-error.js";

test("mediaErrorReasonKey: MEDIA_ERR_ABORTED -> null (программная отмена, не отказ)", () => {
	assert.equal(mediaErrorReasonKey(MEDIA_ERR_ABORTED), null);
});

test("mediaErrorReasonKey: MEDIA_ERR_SRC_NOT_SUPPORTED -> ключ 'не поддерживается/повреждён' (незадеплоенный S4 — HTML вместо медиа)", () => {
	assert.equal(mediaErrorReasonKey(MEDIA_ERR_SRC_NOT_SUPPORTED), "attachment.mediaErrorUnsupported");
});

test("mediaErrorReasonKey: MEDIA_ERR_DECODE -> ключ ошибки декодирования", () => {
	assert.equal(mediaErrorReasonKey(MEDIA_ERR_DECODE), "attachment.mediaErrorDecode");
});

test("mediaErrorReasonKey: MEDIA_ERR_NETWORK -> ключ сетевой ошибки", () => {
	assert.equal(mediaErrorReasonKey(MEDIA_ERR_NETWORK), "attachment.mediaErrorNetwork");
});

test("mediaErrorReasonKey: неизвестный/отсутствующий код -> сетевая ошибка (безопасный дефолт, не молчание)", () => {
	assert.equal(mediaErrorReasonKey(undefined), "attachment.mediaErrorNetwork");
	assert.equal(mediaErrorReasonKey(99), "attachment.mediaErrorNetwork");
});

test("isTransientMediaError: сеть и 404-как-unsupported — да; abort/decode — нет", () => {
	assert.equal(isTransientMediaError(MEDIA_ERR_NETWORK), true);
	assert.equal(isTransientMediaError(MEDIA_ERR_SRC_NOT_SUPPORTED), true);
	assert.equal(isTransientMediaError(MEDIA_ERR_ABORTED), false);
	assert.equal(isTransientMediaError(MEDIA_ERR_DECODE), false);
});
