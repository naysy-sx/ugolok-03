import { test } from "node:test";
import assert from "node:assert/strict";
import { rasterizeImagePreview, previewTargetWidth, overlayTargetWidth, OVERLAY_MAX_WIDTH } from "../src/domain/media/raster-image.js";
import { resolveImagePreviewUrl, resolveImageOverlayUrl } from "../src/domain/media/image-preview.js";
import { clearPlaintextCache, getPlaintextBytes, getOverlayUrl } from "../src/domain/media/plaintext-cache.js";

// MEDIA-PERF-TZ-4.md §4 A.0/A.1 — оверлей не умеет зум выше "вписать в
// экран" (проверено: gesture-machine.js/swipe-gesture.js/image-viewer.jsx —
// нет состояния/математики зума). img.decode() на исходных байтах и
// rasterizeImageBytes (полноразмерный lossless PNG) поэтому УДАЛЕНЫ —
// один путь на бабл и оверлей, rasterizeImagePreview, разная цель/качество.

test("previewTargetWidth: потолок 1024 px даже на высоком devicePixelRatio", () => {
	const orig = globalThis.devicePixelRatio;
	globalThis.devicePixelRatio = 4;
	try {
		assert.ok(previewTargetWidth() <= 1024);
	} finally {
		globalThis.devicePixelRatio = orig;
	}
});

// overlayTargetWidth — MEDIA-PERF-TZ-4.md §4 A.1.
test("overlayTargetWidth: потолок 2560 px", () => {
	assert.equal(overlayTargetWidth(10000), OVERLAY_MAX_WIDTH);
});

test("overlayTargetWidth: без аргумента (вьюпорт неизвестен) -> потолок по умолчанию", () => {
	assert.equal(overlayTargetWidth(undefined), OVERLAY_MAX_WIDTH);
});

test("overlayTargetWidth: результат ВСЕГДА кратен 256 (ключ кэша)", () => {
	for (const viewport of [100, 375, 800, 1440, 1920, 3000]) {
		const w = overlayTargetWidth(viewport, { devicePixelRatio: 1 });
		assert.equal(w % 256, 0, `${w} для вьюпорта ${viewport} должен быть кратен 256`);
	}
});

test("overlayTargetWidth: учитывает devicePixelRatio", () => {
	const w1 = overlayTargetWidth(500, { devicePixelRatio: 1 });
	const w2 = overlayTargetWidth(500, { devicePixelRatio: 2 });
	assert.ok(w2 > w1, "более высокий DPR должен давать бОльшую цель");
});

test("overlayTargetWidth: разные вьюпорты (портрет/ландшафт после поворота) обычно дают РАЗНЫЕ корзины 256px", () => {
	const portrait = overlayTargetWidth(400, { devicePixelRatio: 2 }); // например, ширина в портрете
	const landscape = overlayTargetWidth(900, { devicePixelRatio: 2 }); // высота стала шириной после поворота
	assert.notEqual(portrait, landscape, "поворот экрана должен давать другую цель — иначе кэш отдаст растр от чужой ориентации");
});

// rasterizeImagePreview — общая функция бабла и оверлея.

test("rasterizeImagePreview: источник 4000×3000, targetWidth 300 -> выходной canvas НЕ превышает 300 по большей стороне", async () => {
	let requested = null;
	const outBlob = new Uint8Array([1, 2, 3]);
	const adapters = {
		targetWidth: 300,
		createImageBitmap: async () => ({ width: 4000, height: 3000, close() {} }),
		webpSupported: true,
		convertBitmap: async (bitmap, opts) => {
			requested = opts;
			return new Blob([outBlob], { type: opts.type });
		},
	};
	const { rasterized, blobSize } = await rasterizeImagePreview(new Uint8Array(10), "image/jpeg", adapters);
	assert.equal(rasterized, true);
	assert.ok(requested.width <= 300, `выходная ширина (${requested.width}) должна быть ≤ 300`);
	assert.equal(requested.height, Math.round(3000 * (300 / 4000)), "пропорции сохранены");
	assert.equal(blobSize, outBlob.length);
});

test("rasterizeImagePreview: маленький источник (меньше targetWidth) НЕ апскейлится", async () => {
	let requested = null;
	const adapters = {
		targetWidth: 1024,
		createImageBitmap: async () => ({ width: 100, height: 80, close() {} }),
		webpSupported: true,
		convertBitmap: async (bitmap, opts) => {
			requested = opts;
			return new Blob([new Uint8Array([1])], { type: opts.type });
		},
	};
	await rasterizeImagePreview(new Uint8Array(10), "image/jpeg", adapters);
	assert.equal(requested.width, 100, "источник МЕНЬШЕ targetWidth — размер не меняется, апскейла нет");
	assert.equal(requested.height, 80);
});

test("rasterizeImagePreview: типичный JPEG — выходной blob МЕНЬШЕ исходного (было: PNG в разы больше)", async () => {
	const original = new Uint8Array(50_000);
	const smallOutput = new Uint8Array(5_000);
	const adapters = {
		targetWidth: 300,
		createImageBitmap: async () => ({ width: 4000, height: 3000, close() {} }),
		webpSupported: true,
		convertBitmap: async (bitmap, opts) => new Blob([smallOutput], { type: opts.type }),
	};
	const { blobSize } = await rasterizeImagePreview(original, "image/jpeg", adapters);
	assert.ok(blobSize < original.length, `выходной blob (${blobSize}) должен быть меньше исходного (${original.length})`);
});

test("rasterizeImagePreview: качество кодека по умолчанию — 0.82 webp / 0.85 jpeg (бабл), можно переопределить (оверлей — 0.9)", async () => {
	let requested = null;
	const spy = (bitmap, opts) => {
		requested = opts;
		return new Blob([new Uint8Array([1])], { type: opts.type });
	};
	await rasterizeImagePreview(new Uint8Array(10), "image/jpeg", {
		targetWidth: 300,
		createImageBitmap: async () => ({ width: 800, height: 600, close() {} }),
		webpSupported: true,
		convertBitmap: spy,
	});
	assert.equal(requested.quality, 0.82, "бабл по умолчанию — 0.82");

	await rasterizeImagePreview(new Uint8Array(10), "image/jpeg", {
		targetWidth: 300,
		webpQuality: 0.9,
		createImageBitmap: async () => ({ width: 800, height: 600, close() {} }),
		webpSupported: true,
		convertBitmap: spy,
	});
	assert.equal(requested.quality, 0.9, "оверлей переопределяет качество через adapters.webpQuality");
});

test("rasterizeImagePreview: WebP не поддержан движком -> baseline JPEG q0.85 по умолчанию", async () => {
	let requested = null;
	const adapters = {
		targetWidth: 300,
		createImageBitmap: async () => ({ width: 800, height: 600, close() {} }),
		webpSupported: false,
		convertBitmap: async (bitmap, opts) => {
			requested = opts;
			return new Blob([new Uint8Array([1])], { type: opts.type });
		},
	};
	await rasterizeImagePreview(new Uint8Array(10), "image/jpeg", adapters);
	assert.equal(requested.type, "image/jpeg");
	assert.equal(requested.quality, 0.85);
});

test("rasterizeImagePreview: PNG с альфой -> формат PNG (прозрачность не теряется), даже если WebP поддержан", async () => {
	let requested = null;
	const adapters = {
		targetWidth: 300,
		createImageBitmap: async () => ({ width: 800, height: 600, close() {} }),
		webpSupported: true,
		convertBitmap: async (bitmap, opts) => {
			requested = opts;
			return new Blob([new Uint8Array([1])], { type: opts.type });
		},
	};
	await rasterizeImagePreview(new Uint8Array(10), "image/png", adapters);
	assert.equal(requested.type, "image/png", "источник с альфой -> PNG, не WebP/JPEG");
});

test("rasterizeImagePreview: GIF (потенциальная альфа) -> тоже PNG", async () => {
	let requested = null;
	const adapters = {
		targetWidth: 300,
		createImageBitmap: async () => ({ width: 200, height: 200, close() {} }),
		webpSupported: true,
		convertBitmap: async (bitmap, opts) => {
			requested = opts;
			return new Blob([new Uint8Array([1])], { type: opts.type });
		},
	};
	await rasterizeImagePreview(new Uint8Array(10), "image/gif", adapters);
	assert.equal(requested.type, "image/png");
});

test("rasterizeImagePreview: без bitmap API отдаёт исходный blob (Node fallback)", async () => {
	const bytes = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3]);
	const { url, rasterized } = await rasterizeImagePreview(bytes, "image/jpeg", { createImageBitmap: null });
	assert.equal(rasterized, false);
	assert.ok(typeof url === "string");
	URL.revokeObjectURL(url);
});

// resolveImagePreviewUrl (бабл).

test("resolveImagePreviewUrl: повторный вызов не зовёт loadBytes", async () => {
	clearPlaintextCache();
	const bytes = new Uint8Array([1, 2, 3, 4, 5]);
	let loads = 0;
	const adapters = {
		createImageBitmap: async () => ({ width: 1, height: 1, close() {} }),
		convertBitmap: async () => new Blob([new Uint8Array([9, 9])], { type: "image/png" }),
	};
	const first = await resolveImagePreviewUrl("digest-a", "image/jpeg", async () => {
		loads += 1;
		return bytes;
	}, adapters);
	const second = await resolveImagePreviewUrl("digest-a", "image/jpeg", async () => {
		loads += 1;
		return bytes;
	}, adapters);
	assert.equal(loads, 1);
	assert.equal(first.url, second.url);
	assert.ok(getPlaintextBytes("digest-a"));
	clearPlaintextCache();
});

// resolveImageOverlayUrl (оверлей) — MEDIA-PERF-TZ-4.md §4 A.1/A.4.

test("resolveImageOverlayUrl: та же функция растеризации, что бабл — convertBitmap ВЫЗЫВАЕТСЯ (не img.decode())", async () => {
	clearPlaintextCache();
	let convertCalled = false;
	const bytes = new Uint8Array([1, 2, 3]);
	const result = await resolveImageOverlayUrl("digest-overlay-1", "image/jpeg", async () => bytes, {
		targetWidth: 2560,
		createImageBitmap: async () => ({ width: 10, height: 10, close() {} }),
		webpSupported: true,
		convertBitmap: async () => {
			convertCalled = true;
			return new Blob([new Uint8Array([9])], { type: "image/webp" });
		},
	});
	assert.equal(convertCalled, true, "оверлей растеризуется той же функцией, что бабл");
	assert.equal(result.rasterized, true);
	clearPlaintextCache();
});

test("resolveImageOverlayUrl: качество кодека по умолчанию 0.9 (выше бабла)", async () => {
	clearPlaintextCache();
	let requested = null;
	await resolveImageOverlayUrl("digest-overlay-quality", "image/jpeg", async () => new Uint8Array([1, 2, 3]), {
		targetWidth: 2560,
		createImageBitmap: async () => ({ width: 10, height: 10, close() {} }),
		webpSupported: true,
		convertBitmap: async (bitmap, opts) => {
			requested = opts;
			return new Blob([new Uint8Array([1])], { type: opts.type });
		},
	});
	assert.equal(requested.quality, 0.9);
	clearPlaintextCache();
});

test("resolveImageOverlayUrl: ключ кэша включает targetWidth — другой вьюпорт даёт ДРУГОЙ url, не старый растр", async () => {
	clearPlaintextCache();
	let calls = 0;
	const bytes = new Uint8Array([1, 2, 3]);
	const adaptersFor = (targetWidth) => ({
		targetWidth,
		createImageBitmap: async () => ({ width: 10, height: 10, close() {} }),
		webpSupported: true,
		convertBitmap: async () => {
			calls++;
			return new Blob([new Uint8Array([calls])], { type: "image/webp" });
		},
	});
	const small = await resolveImageOverlayUrl("digest-rotate", "image/jpeg", async () => bytes, adaptersFor(768));
	const big = await resolveImageOverlayUrl("digest-rotate", "image/jpeg", async () => bytes, adaptersFor(1536));
	assert.equal(calls, 2, "разная цель — растеризация ПОВТОРНО, не взята из кэша под чужой шириной");
	assert.notEqual(small.url, big.url);
	// Слот один на digest (не карта по ширине) — второй open() под другую цель
	// замещает первый (revoke), не копит все когда-либо запрошенные размеры.
	assert.equal(getOverlayUrl("digest-rotate", 768), undefined, "старая ширина вытеснена новой, не висит в кэше бесконечно");
	assert.equal(getOverlayUrl("digest-rotate", 1536), big.url, "актуальная (последняя запрошенная) ширина — в кэше");
	clearPlaintextCache();
});

test("resolveImageOverlayUrl: повторный вызов С ТЕМ ЖЕ targetWidth — не зовёт loadBytes и НЕ растеризует повторно", async () => {
	clearPlaintextCache();
	let loads = 0;
	let converts = 0;
	const bytes = new Uint8Array([1, 2, 3]);
	const adapters = {
		targetWidth: 2560,
		createImageBitmap: async () => ({ width: 10, height: 10, close() {} }),
		webpSupported: true,
		convertBitmap: async () => {
			converts++;
			return new Blob([new Uint8Array([9])], { type: "image/webp" });
		},
	};
	const loadBytes = async () => {
		loads++;
		return bytes;
	};
	const first = await resolveImageOverlayUrl("digest-overlay-3", "image/jpeg", loadBytes, adapters);
	const second = await resolveImageOverlayUrl("digest-overlay-3", "image/jpeg", loadBytes, adapters);
	assert.equal(loads, 1);
	assert.equal(converts, 1);
	assert.equal(first.url, second.url);
	clearPlaintextCache();
});

test("бабл и оверлей на ОДИН digest: loadBytes зовётся максимум ОДИН раз суммарно (общий plaintext-cache, §8 п.3), URL разные (разные slot'ы/цели)", async () => {
	clearPlaintextCache();
	let loads = 0;
	const bytes = new Uint8Array([1, 2, 3, 4]);
	const loadBytes = async () => {
		loads++;
		return bytes;
	};
	const bubbleAdapters = {
		targetWidth: 300,
		createImageBitmap: async () => ({ width: 10, height: 10, close() {} }),
		webpSupported: true,
		convertBitmap: async (bitmap, opts) => new Blob([new Uint8Array([9, 9])], { type: opts.type }),
	};
	const overlayAdapters = {
		targetWidth: 2560,
		createImageBitmap: async () => ({ width: 10, height: 10, close() {} }),
		webpSupported: true,
		convertBitmap: async (bitmap, opts) => new Blob([new Uint8Array([9, 9, 9])], { type: opts.type }),
	};
	const bubble = await resolveImagePreviewUrl("digest-shared-1", "image/jpeg", loadBytes, bubbleAdapters);
	const overlay = await resolveImageOverlayUrl("digest-shared-1", "image/jpeg", loadBytes, overlayAdapters);
	assert.equal(loads, 1, "оверлей после бабла НЕ должен повторно грузить байты — они уже в plaintext-cache");
	assert.notEqual(bubble.url, overlay.url, "бабл-превью и оверлей — РАЗНЫЕ URL, разные цели растра");
	clearPlaintextCache();
});
