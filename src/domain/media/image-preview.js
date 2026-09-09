import { getPlaintextBytes, getPreviewUrl, putPlaintextBytes, setPreviewUrl } from "./plaintext-cache.js";
import { rasterizeImageBytes } from "./raster-image.js";

export async function resolveImagePreviewUrl(digest, mime, loadBytes, adapters, onProgress) {
	const existing = getPreviewUrl(digest);
	if (existing) return { url: existing, rasterized: true };

	let bytes = getPlaintextBytes(digest);
	if (!bytes) {
		onProgress?.("loading");
		bytes = await loadBytes();
		putPlaintextBytes(digest, bytes, mime);
	}
	onProgress?.("preparing");
	const raster = await rasterizeImageBytes(bytes, mime, adapters);
	setPreviewUrl(digest, raster.url);
	return raster;
}
