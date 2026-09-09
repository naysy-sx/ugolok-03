// Просмотр: сырой progressive JPEG / interlaced PNG не отдаём в <img>.
// Декод в bitmap → lossless PNG snapshot. Файл на диске / в Blossom не меняется.

export async function rasterizeImageBytes(bytes, mime, adapters = {}) {
	const createImageBitmapFn =
		adapters.createImageBitmap ?? (typeof createImageBitmap === "function" ? createImageBitmap : null);

	if (!createImageBitmapFn) {
		const url = URL.createObjectURL(new Blob([bytes], { type: mime || "image/jpeg" }));
		return { url, rasterized: false };
	}

	const source = new Blob([bytes], { type: mime || "image/jpeg" });
	const bitmap = await createImageBitmapFn(source);
	try {
		let outBlob = null;
		if (adapters.convertBitmap) {
			outBlob = await adapters.convertBitmap(bitmap);
		} else if (typeof OffscreenCanvas === "function") {
			const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
			const ctx = canvas.getContext("2d");
			ctx.drawImage(bitmap, 0, 0);
			outBlob = await canvas.convertToBlob({ type: "image/png" });
		} else if (typeof document !== "undefined") {
			const canvas = document.createElement("canvas");
			canvas.width = bitmap.width;
			canvas.height = bitmap.height;
			const ctx = canvas.getContext("2d");
			ctx.drawImage(bitmap, 0, 0);
			outBlob = await new Promise((resolve) => canvas.toBlob(resolve, "image/png"));
		}
		if (!outBlob) {
			const url = URL.createObjectURL(source);
			return { url, rasterized: false };
		}
		return { url: URL.createObjectURL(outBlob), rasterized: true };
	} finally {
		bitmap.close?.();
	}
}
