// Медиа-подсистема, этап C (MEDIA-SPEC.md §3.9, MEDIA-MATH.md §8.4/8.5,
// MEDIA-ALGO.md §4.7) — потоковая загрузка. putStream (content.js) читает
// bytes целиком в память; putFileStreaming читает file.slice()-срезами,
// резидентно живёт только текущий чанк — Θ(C), не Θ(S).
import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex } from "@noble/hashes/utils.js";
import { generateFileKey } from "./crypto.js";
import { planChunks } from "./manifest.js";
import { MANIFEST_VERSION } from "./content.js";
import { uploadBlob, checkUploadRequirements } from "./blob.js";
import { chunkSizeFor } from "../media/upload-plan.js";
import { createThumbnailQueue } from "./thumbnail-queue.js";
import { DomainError } from "../errors.js";

// Импорт "?worker&inline" понимает только vite — под node --test (никакого
// vite в рантайме тестов) резолвер падает буквально при ЗАГРУЗКЕ модуля
// (проверено: не при вызове функции, раньше). Значит грузить его можно
// ТОЛЬКО лениво, изнутри функции, и только когда реально нужно шифровать
// чанк по умолчанию (тесты подставляют свой encryptChunk и сюда не заходят).
async function defaultEncryptChunk(chunkBytes, fileKey, chunkIndex) {
	const { encryptChunkRemote } = await import("./stream-crypto-worker.js");
	return encryptChunkRemote(chunkBytes, fileKey, chunkIndex);
}

function abortError() {
	return new DOMException("Загрузка отменена", "AbortError");
}

// file — File | Blob (нужны только .size и .slice()). Остальные опции —
// как у putStream (content.js), signal/fetchImpl/fileKey — тот же смысл.
export async function putFileStreaming(
	file,
	{
		name,
		mime,
		chunkSize,
		signal,
		onProgress,
		serverUrl,
		privateKey,
		fetchImpl,
		fileKey: overrideFileKey,
		encryptChunk = defaultEncryptChunk,
		timeoutMs,
		retries,
		backoffMs,
		expirationSec,
	} = {},
) {
	const fileKey = overrideFileKey ?? generateFileKey();
	const size = file.size;
	const cSize = chunkSize ?? chunkSizeFor(size);
	const { count, lastChunkSize } = planChunks(size, cSize);

	const hasher = sha256.create();
	const chunkDigests = [];
	const parts = [];
	for (let i = 0; i < count; i++) {
		if (signal?.aborted) throw abortError();
		const start = i * cSize;
		const end = i === count - 1 ? start + lastChunkSize : start + cSize;
		const plainChunk = new Uint8Array(await file.slice(start, end).arrayBuffer());
		const cipherChunk = await encryptChunk(plainChunk, fileKey, i);
		if (signal?.aborted) throw abortError();
		hasher.update(cipherChunk);
		chunkDigests.push(bytesToHex(sha256(cipherChunk)));
		parts.push(new Blob([cipherChunk]));
		// phase:"encrypt" — старые поля chunksDone/chunksTotal НЕ переименованы
		// (FILES-FIX-SPEC.md §5.1.2, TZ-FIX-FILES-MEDIA-STATIC.md 5.3): это
		// НЕ сетевой прогресс, само по себе не объясняет "минуты тишины после
		// 100%" — именно поэтому ниже добавлена фаза "upload" по факту сети.
		onProgress?.({ phase: "encrypt", chunksDone: i + 1, chunksTotal: count });
	}

	const blobSha256Local = bytesToHex(hasher.digest());
	const body = new Blob(parts);
	const uploadOptions = { ...(fetchImpl ? { fetchImpl } : {}), signal, timeoutMs, retries, backoffMs, expirationSec };
	const requirements = await checkUploadRequirements(serverUrl, { sha256Hex: blobSha256Local, mime, size: body.size }, privateKey, uploadOptions);
	if (!requirements.ok) {
		const detail = requirements.status ? " (" + requirements.status + (requirements.reason ? ": " + requirements.reason : "") + ")" : "";
		throw new DomainError("Blossom-сервер отклонил файл" + detail, "errors.blossomRejectedFile", { detail });
	}
	const uploadResponse = await uploadBlob(serverUrl, body, blobSha256Local, privateKey, {
		...uploadOptions,
		onUploadProgress: onProgress ? ({ loaded, total }) => onProgress({ phase: "upload", bytesSent: loaded, bytesTotal: total ?? body.size }) : undefined,
	});

	onProgress?.({ phase: "manifest" });
	const manifest = {
		v: MANIFEST_VERSION, // AUDIT-EGOROD E4 — тот же формат, что content.js::putStream (тест «бит-в-бит»)
		size,
		chunkSize: cSize,
		chunks: chunkDigests,
		keyId: bytesToHex(crypto.getRandomValues(new Uint8Array(16))),
		mime,
		name,
		blobSha256: uploadResponse.sha256,
	};
	const manifestBytes = new TextEncoder().encode(JSON.stringify(manifest));
	const manifestDigest = bytesToHex(sha256(manifestBytes));
	await uploadBlob(serverUrl, manifestBytes, manifestDigest, privateKey, uploadOptions);

	return { manifest, manifestDigest, fileKey, size };
}

// jobs: Array<{ file, options }> — options тот же объект, что putFileStreaming
// принимает вторым параметром (БЕЗ signal — общий signal ниже прокидывается
// в каждый job сам). Конвейер — DESIGN.md "Медиа-подсистема — Этап C,
// Уровень 2": стадия A (шифрование) одного файла естественно перекрывается
// со стадией B (сеть) другого при concurrency>1, переиспользуем уже
// протестированный createThumbnailQueue вместо изобретения нового
// bounded producer/consumer.
// onJobError — довесок FILES-FIX-SPEC.md §7.3/TZ-FIX-FILES-MEDIA-STATIC.md
// решение №4 ("ошибка одного файла не должна останавливать очередь
// остальных"): Promise.all ниже НЕ переписан (сохраняет форму результата —
// см. tests/stream-upload.test.js "порядок результатов = порядок jobs",
// results[i] — сырой результат putFileStreaming, не {ok,...}-обёртка) —
// он по-прежнему падает с ПЕРВОЙ ошибкой первого зафейлившегося job'а, ЭТО
// НЕ регрессия: остальные job'ы из очереди продолжают выполняться независимо
// (createThumbnailQueue не отменяет их, ошибка одного не убирает других из
// running/pending) — просто aggregate-промис их уже не дожидается. Вызывающая
// сторона (files.jsx), которой нужна сводка по КАЖДОМУ файлу, обязана
// подписаться на onJobDone/onJobError, а не полагаться на резолв целиком.
// НЕ вызываем handle.cancel() по signal'у здесь (было в первой версии) —
// createThumbnailQueue.cancel() на ЕЩЁ НЕ стартовавшем задании молча снимает
// его из очереди БЕЗ resolve/reject (сделано для превью миниатюр, files.jsx —
// там никто не ждёт ВСЕ промисы разом, повисший навсегда промис безвреден).
// Здесь вызывающая сторона МОЖЕТ ждать все jobs через onJobDone/onJobError
// (см. files.jsx) — если бы pending job молча завис, счётчик "все job'ы
// отчитались" никогда бы не дошёл до jobs.length. Достаточно проверки
// `signal?.aborted` В НАЧАЛЕ task() — задание, до которого очередь дошла
// ПОСЛЕ отмены, тут же отклоняется (ни одного байта в сеть), но КОРРЕКТНО
// settle'ится, не повисает.
export async function putFilesStreaming(jobs, { concurrency = 2, signal, onJobDone, onJobError } = {}) {
	const queue = createThumbnailQueue(concurrency);
	const handles = jobs.map((job, i) =>
		queue.enqueue(async () => {
			try {
				if (signal?.aborted) throw abortError();
				const result = await putFileStreaming(job.file, { ...job.options, signal });
				onJobDone?.(i, result);
				return result;
			} catch (err) {
				onJobError?.(i, err);
				throw err;
			}
		}),
	);
	return Promise.all(handles.map((h) => h.promise));
}
