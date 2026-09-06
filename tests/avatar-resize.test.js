import { test } from "node:test";
import assert from "node:assert/strict";
import { resizeAvatarBlob, AVATAR_MAX_SIDE, AVATAR_TARGET_BYTES } from "../src/domain/identity/avatar-resize.js";

// createImageBitmap/OffscreenCanvas — браузерные API, недоступны в
// node --test. bitmapBackend инъецируется, чтобы проверить АРИФМЕТИКУ
// (кроп/выбор формата/два прохода качества) без реального декодирования —
// визуальный результат проверяется живьём (TZ-FIX-FILES-MEDIA-STATIC.md §8).
function fakeBackend({ width, height, sizeAtQuality }) {
	const calls = [];
	return {
		calls,
		backend: {
			async decode() {
				return { width, height };
			},
			async encode(bitmap, { side, cropX, cropY, cropSize, quality, mime }) {
				calls.push({ side, cropX, cropY, cropSize, quality, mime });
				return { size: sizeAtQuality(mime, quality), type: mime };
			},
		},
	};
}

test("resizeAvatarBlob: широкое изображение — кроп по короткой стороне (высоте), центрирован по X", async () => {
	const { backend, calls } = fakeBackend({ width: 1000, height: 400, sizeAtQuality: () => 1000 });
	await resizeAvatarBlob({}, { bitmapBackend: backend });
	const call = calls[0];
	assert.equal(call.cropSize, 400);
	assert.equal(call.cropY, 0);
	assert.equal(call.cropX, 300); // (1000-400)/2
});

test("resizeAvatarBlob: сторона результата ограничена AVATAR_MAX_SIDE даже для огромного исходника", async () => {
	const { backend, calls } = fakeBackend({ width: 4000, height: 4000, sizeAtQuality: () => 1000 });
	await resizeAvatarBlob({}, { bitmapBackend: backend });
	assert.equal(calls[0].side, AVATAR_MAX_SIDE);
});

test("resizeAvatarBlob: маленький исходник — сторона НЕ увеличивается (не апскейл)", async () => {
	const { backend, calls } = fakeBackend({ width: 100, height: 100, sizeAtQuality: () => 1000 });
	await resizeAvatarBlob({}, { bitmapBackend: backend });
	assert.equal(calls[0].side, 100);
});

test("resizeAvatarBlob: WebP меньше JPEG -> возвращается WebP", async () => {
	const { backend } = fakeBackend({
		width: 300,
		height: 300,
		sizeAtQuality: (mime) => (mime === "image/webp" ? 500 : 900),
	});
	const result = await resizeAvatarBlob({}, { bitmapBackend: backend });
	assert.equal(result.type, "image/webp");
	assert.equal(result.size, 500);
});

test("resizeAvatarBlob: JPEG меньше WebP -> возвращается JPEG", async () => {
	const { backend } = fakeBackend({
		width: 300,
		height: 300,
		sizeAtQuality: (mime) => (mime === "image/webp" ? 900 : 500),
	});
	const result = await resizeAvatarBlob({}, { bitmapBackend: backend });
	assert.equal(result.type, "image/jpeg");
});

test("resizeAvatarBlob: кодировщик WebP бросает исключение (браузер не поддерживает) -> тихий фолбэк на JPEG", async () => {
	const backend = {
		async decode() {
			return { width: 300, height: 300 };
		},
		async encode(bitmap, { mime }) {
			if (mime === "image/webp") throw new Error("unsupported");
			return { size: 500, type: "image/jpeg" };
		},
	};
	const result = await resizeAvatarBlob({}, { bitmapBackend: backend });
	assert.equal(result.type, "image/jpeg");
});

test("resizeAvatarBlob: первый проход (q0.82) не укладывается в AVATAR_TARGET_BYTES -> второй проход q0.7", async () => {
	let call = 0;
	const backend = {
		async decode() {
			return { width: 300, height: 300 };
		},
		async encode(bitmap, { quality, mime }) {
			call += 1;
			const size = quality === 0.82 ? AVATAR_TARGET_BYTES + 1 : AVATAR_TARGET_BYTES - 1;
			return { size, type: mime };
		},
	};
	const result = await resizeAvatarBlob({}, { bitmapBackend: backend });
	assert.ok(result.size <= AVATAR_TARGET_BYTES);
	assert.equal(call, 4, "два прохода × (webp+jpeg) = 4 вызова encode");
});

test("resizeAvatarBlob: первый проход УЖЕ укладывается -> второй проход не запускается (не тратим лишний CPU)", async () => {
	let call = 0;
	const backend = {
		async decode() {
			return { width: 300, height: 300 };
		},
		async encode(bitmap, { mime }) {
			call += 1;
			return { size: 100, type: mime };
		},
	};
	await resizeAvatarBlob({}, { bitmapBackend: backend });
	assert.equal(call, 2, "один проход × (webp+jpeg) = 2 вызова encode");
});
