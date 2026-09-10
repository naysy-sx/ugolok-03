export function dataUrlFromJpegBytes(bytes) {
	return "data:image/jpeg;base64," + btoa(String.fromCharCode(...bytes));
}

async function blobToDataUrl(blob) {
	const buf = await blob.arrayBuffer();
	return dataUrlFromJpegBytes(new Uint8Array(buf));
}

function wait(ms) {
	return new Promise((resolve) => setTimeout(() => resolve("timeout"), ms));
}

function once(target, event) {
	return new Promise((resolve) => {
		target.addEventListener(event, () => resolve(event), { once: true });
	});
}

// Общий шаг "открыть видео -> перемотать на кадр -> нарисовать в canvas ->
// закодировать JPEG" — извлечён из extractVideoPoster (MEDIA-PERF-TZ-5.md §3),
// чтобы новый extractVideoPosterCapture (сырые байты + duration/width/height
// для аплоада превью) не дублировал ~40 строк работы с <video>/<canvas>.
// Возвращает { blob, width, height, duration } исходного (не даунскейленного)
// videoWidth/videoHeight — вызывающая сторона решает, что с этим делать
// (extractVideoPoster игнорирует width/height/duration, оставляет только blob).
async function captureVideoFrame(file, options = {}) {
	if (!file || typeof file.type !== "string" || !file.type.startsWith("video/")) return null;

	const timeoutMs = options.timeoutMs ?? 4000;
	const maxWidth = options.maxWidth ?? 480;
	const jpegQuality = options.jpegQuality ?? 0.62;

	const makeVideo = options.makeVideo === undefined
		? (typeof document !== "undefined" ? () => document.createElement("video") : null)
		: options.makeVideo;
	const makeCanvas = options.makeCanvas === undefined
		? (typeof document !== "undefined" ? () => document.createElement("canvas") : null)
		: options.makeCanvas;
	const createObjectURL = options.createObjectURL ?? (typeof URL !== "undefined" && URL.createObjectURL ? URL.createObjectURL.bind(URL) : null);
	const revokeObjectURL = options.revokeObjectURL ?? (typeof URL !== "undefined" && URL.revokeObjectURL ? URL.revokeObjectURL.bind(URL) : null);

	if (!makeVideo || !makeCanvas || !createObjectURL) return null;

	let objectUrl;
	let video;
	try {
		objectUrl = createObjectURL(file);
		video = makeVideo();
		video.muted = true;
		video.playsInline = true;
		video.preload = "metadata";
		video.src = objectUrl;

		const meta = await Promise.race([once(video, "loadedmetadata"), wait(timeoutMs)]);
		if (meta === "timeout") return null;

		const duration = Number(video.duration) || 0;
		video.currentTime = Math.min(0.1, duration / 10 || 0);
		const seeked = await Promise.race([once(video, "seeked"), wait(timeoutMs)]);
		if (seeked === "timeout") return null;

		const canvas = makeCanvas();
		const srcW = video.videoWidth || maxWidth;
		const srcH = video.videoHeight || Math.round((srcW * 9) / 16);
		const width = Math.min(srcW, maxWidth) || 1;
		const height = Math.max(1, Math.round((srcH / srcW) * width));
		canvas.width = width;
		canvas.height = height;
		const ctx = canvas.getContext && canvas.getContext("2d");
		if (!ctx) return null;
		ctx.drawImage(video, 0, 0, width, height);

		const blob = await new Promise((resolve) => {
			if (typeof canvas.toBlob !== "function") {
				resolve(null);
				return;
			}
			canvas.toBlob(resolve, "image/jpeg", jpegQuality);
		});
		if (!blob) return null;
		return { blob, width: video.videoWidth || width, height: video.videoHeight || height, duration };
	} catch {
		return null;
	} finally {
		if (video) video.src = "";
		if (objectUrl && revokeObjectURL) revokeObjectURL(objectUrl);
	}
}

export async function extractVideoPoster(file, options = {}) {
	if (!file || typeof file.type !== "string" || !file.type.startsWith("video/")) return null;

	const maxBlobSize = options.maxBlobSize ?? 32768;

	if (Object.prototype.hasOwnProperty.call(options, "readyBlob")) {
		const readyBlob = options.readyBlob;
		if (!readyBlob || readyBlob.size > maxBlobSize) return null;
		try {
			return await blobToDataUrl(readyBlob);
		} catch {
			return null;
		}
	}

	const captured = await captureVideoFrame(file, options);
	if (!captured || captured.blob.size > maxBlobSize) return null;
	try {
		return await blobToDataUrl(captured.blob);
	} catch {
		return null;
	}
}

// MEDIA-PERF-TZ-5.md §3 — для дескриптора вложения (previewDigest/previewKey,
// putStream того же blob'а на Blossom, НЕ inline data:URL как у старого
// extractVideoPoster — тот больше не используется для НОВЫХ отправляемых
// сообщений, см. use-attachment-tray.js). Возвращает сырые JPEG-байты
// (для putStream) + метаданные видео, снятые БЕСПЛАТНО с того же
// loadedmetadata, что уже используется для кадра-постера.
export async function extractVideoPosterCapture(file, options = {}) {
	const captured = await captureVideoFrame(file, options);
	if (!captured) return null;
	return {
		bytes: new Uint8Array(await captured.blob.arrayBuffer()),
		mime: "image/jpeg",
		width: captured.width,
		height: captured.height,
		duration: captured.duration,
	};
}
