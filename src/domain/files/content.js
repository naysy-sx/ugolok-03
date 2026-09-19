import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex, concatBytes } from "@noble/hashes/utils.js";
import { generateFileKey, encryptChunk, decryptChunk } from "./crypto.js";
import { planChunks, rangeToChunks } from "./manifest.js";
import { uploadBlob, downloadBlob, downloadBlobRange, checkUploadRequirements } from "./blob.js";
import { getCachedCipherChunk, putCachedCipherChunk } from "./blob-cache.js";
import { DomainError } from "../errors.js";

export const DEFAULT_CHUNK_SIZE = 256 * 1024; // 256 КБ, ALGO.MD §9.2 — рекомендация, не замер
const GET_RANGE_CONCURRENCY = 6;

// Экспортирован (MEDIA-PERF-TZ.md §5.1) — player-session.js::readRange раньше
// грузил чанки ОДНОГО Range-окна последовательно (for+await), в отличие от
// этого файла; теперь переиспользует тот же пул, вместо второй реализации.
export async function mapPool(items, limit, fn) {
	const result = new Array(items.length);
	let next = 0;
	async function worker() {
		while (true) {
			const idx = next++;
			if (idx >= items.length) return;
			result[idx] = await fn(items[idx], idx);
		}
	}
	const n = Math.min(limit, items.length);
	if (n === 0) return result;
	await Promise.all(Array.from({ length: n }, () => worker()));
	return result;
}

// bytes — Uint8Array целиком в памяти. Потоковое чтение File/ReadableStream —
// следующий проход (замечено ALGO.MD §9.3: "файл целиком в память не читается
// никогда" — здесь это НЕ соблюдено буквально для v0.1 первого прохода;
// явно фиксирую как сужение, не как решённое требование НФ-бюджета И2).
// fileKey — необязательный оверрайд (этап 53 И6, задача 6.6b): файлы
// ВНУТРИ доли шифруются ключом, ПРОИЗВОДНЫМ от subtreeKey (share.js/
// move-routing.js), не случайным — иначе получатель не смог бы
// независимо его пересчитать. Без оверрайда — поведение НЕ меняется
// (случайный ключ, как раньше).
// signal — необязательный AbortSignal (§7 TASK.md: "прогресс и отмена для
// загрузки... без индикатора это выглядит как зависание") — проверяется
// МЕЖДУ чанками шифрования (дёшево прервать на границе, не насильно
// посреди одного чанка) и пробрасывается в fetch (uploadBlob) — отмена
// во время самой сетевой передачи тоже срабатывает, тем же AbortError,
// что и стандартный fetch.
export async function putStream(
	bytes,
	{ name, mime, chunkSize = DEFAULT_CHUNK_SIZE, onProgress, serverUrl, privateKey, fetchImpl, fileKey: overrideFileKey, signal, timeoutMs, retries, backoffMs, expirationSec } = {},
) {
	const fileKey = overrideFileKey ?? generateFileKey();
	const size = bytes.length;
	const { count, lastChunkSize } = planChunks(size, chunkSize);

	const chunkDigests = new Array(count);
	const cipherParts = new Array(count);
	let encrypted = 0;
	await mapPool([...Array(count).keys()], GET_RANGE_CONCURRENCY, (i) => {
		if (signal?.aborted) throw new DOMException("Загрузка отменена", "AbortError");
		const start = i * chunkSize;
		const end = i === count - 1 ? start + lastChunkSize : start + chunkSize;
		const cipherChunk = encryptChunk(bytes.subarray(start, end), fileKey, i);
		chunkDigests[i] = bytesToHex(sha256(cipherChunk));
		cipherParts[i] = cipherChunk;
		encrypted += 1;
		onProgress?.({ phase: "encrypt", chunksDone: encrypted, chunksTotal: count });
	});
	const fullCiphertext = concatBytes(...cipherParts);
	const blobSha256Local = bytesToHex(sha256(fullCiphertext));
	const uploadOptions = { ...(fetchImpl ? { fetchImpl } : {}), signal, timeoutMs, retries, backoffMs, expirationSec };
	const requirements = await checkUploadRequirements(serverUrl, { sha256Hex: blobSha256Local, mime, size: fullCiphertext.length }, privateKey, uploadOptions);
	if (!requirements.ok) {
		const detail = requirements.status ? ' (' + requirements.status + (requirements.reason ? ': ' + requirements.reason : '') + ')' : '';
		throw new DomainError('Blossom-сервер отклонил файл' + detail, 'errors.blossomRejectedFile', { detail });
	}
	const uploadResponse = await uploadBlob(serverUrl, fullCiphertext, blobSha256Local, privateKey, {
		...uploadOptions,
		onUploadProgress: onProgress ? ({ loaded, total }) => onProgress({ phase: "upload", bytesSent: loaded, bytesTotal: total ?? fullCiphertext.length }) : undefined,
	});
	onProgress?.({ phase: "manifest" });

	// keyId — непрозрачная ССЫЛКА (§4.1 MATH.md: "Manifest.keyId : KeyId"), не
	// сырой ключ — сырой fileKey возвращается ОТДЕЛЬНЫМ полем, персистентность/
	// обёртка ключа (share.js, И6) вне ответственности content.js.
	const manifest = {
		v: MANIFEST_VERSION,
		size,
		chunkSize,
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

// AUDIT-EGOROD E4. Версия формата манифеста. Раньше поля версии не было, и любое
// изменение геометрии чанков (MEDIA-PERF-TZ-6 §7) пришлось бы распознавать «по
// отсутствию полей». Теперь новые манифесты несут v, а старые (без v) читаются
// как версия 1 навсегда — файлы, уже лежащие на Blossom, не перезаливаются.
// Клиент, встретивший версию новее известной, отказывает ЧЕСТНО (иначе битое
// видео вместо ошибки — «ошибка на единицу не ловится глазами»).
export const MANIFEST_VERSION = 1;

export function assertManifestSupported(manifest) {
	const v = manifest.v ?? 1;
	if (!Number.isInteger(v) || v > MANIFEST_VERSION) {
		throw new DomainError("Манифест создан более новой версией приложения", "errors.manifestTooNew");
	}
}

const MANIFEST_CACHE_MAX = 64;
const manifestCache = new Map();

export function clearManifestCache() {
	manifestCache.clear();
	cipherRam.clear();
}

export async function getManifest(manifestDigest, { serverUrl, fetchImpl, priority } = {}) {
	const cached = manifestCache.get(manifestDigest);
	if (cached) return cached;
	const options = { ...(fetchImpl ? { fetchImpl } : {}), ...(priority !== undefined ? { priority } : {}) };
	// Манифест — маленький (единицы-десятки КБ даже на гигабайтный файл,
	// ALGO.MD §9.4), полный GET оправдан, Range здесь не нужен.
	const bytes = await downloadBlob(serverUrl, manifestDigest, options);
	const actualDigest = bytesToHex(sha256(bytes));
	if (actualDigest !== manifestDigest) {
		throw new DomainError("Blossom-сервер вернул подменённый манифест (digest не совпадает)", "errors.blossomManifestTampered");
	}
	const manifest = JSON.parse(new TextDecoder().decode(bytes));
	assertManifestSupported(manifest);
	if (manifestCache.size >= MANIFEST_CACHE_MAX) {
		const oldest = manifestCache.keys().next().value;
		manifestCache.delete(oldest);
	}
	manifestCache.set(manifestDigest, manifest);
	return manifest;
}

const AEAD_TAG_BYTES = 16; // ChaCha20-Poly1305 — тег фиксированной длины на чанк

// Смещение чанка i В ШИФРОТЕКСТЕ (не в исходном файле!) — каждый чанк несёт
// СВОЙ тег аутентификации (+16 байт), поэтому байтовые offset'ы в блобе НЕ
// совпадают с offset'ами в plaintext. Нашёл сам при реализации (не было явно
// в TASK.md/MATH.md/ALGO.MD) — до фикса Range указывал бы не туда начиная
// со второго чанка, тихо возвращая испорченные байты.
function cipherChunkOffset(i, chunkSize) {
	return i * (chunkSize + AEAD_TAG_BYTES);
}

function cipherChunkLength(manifest, chunkIndex) {
	const count = manifest.chunks.length;
	const lastChunkSize = manifest.size - (count - 1) * manifest.chunkSize;
	const plainChunkSize = chunkIndex === count - 1 ? lastChunkSize : manifest.chunkSize;
	return plainChunkSize + AEAD_TAG_BYTES;
}

const cipherRam = new Map(); // `${blobSha256}:${chunkIndex}` -> ciphertext

function cipherRamKey(digest, chunkIndex) {
	return `${digest}:${chunkIndex}`;
}

const CIPHER_RAM_BUDGET = 32 * 1024 * 1024;

function evictCipherRam() {
	let total = 0;
	for (const v of cipherRam.values()) total += v.length;
	while (total > CIPHER_RAM_BUDGET && cipherRam.size > 1) {
		const first = cipherRam.keys().next().value;
		total -= cipherRam.get(first).length;
		cipherRam.delete(first);
	}
}

function rememberCipherChunk(digest, chunkIndex, ciphertext) {
	const key = cipherRamKey(digest, chunkIndex);
	if (cipherRam.has(key)) cipherRam.delete(key);
	cipherRam.set(key, ciphertext);
	evictCipherRam();
	putCachedCipherChunk(digest, chunkIndex, ciphertext);
}

function assertChunkDigest(manifest, chunkIndex, cipherChunk) {
	const actualDigest = bytesToHex(sha256(cipherChunk));
	if (actualDigest !== manifest.chunks[chunkIndex]) {
		throw new DomainError(`Blossom-сервер вернул подменённый чанк ${chunkIndex} (digest не совпадает)`, "errors.blossomChunkTampered", { chunkIndex });
	}
}

// Один чанк ЦЕЛИКОМ, расшифрованный (CONTRACTS.md, этап 53 И4, задача 4.3) —
// единица кэширования плеера (chunk-cache.js), в отличие от getRange ниже,
// который отдаёт произвольный байтовый диапазон. Вынесено аддитивно из
// getRange (было инлайном в цикле) — та же арифметика cipherChunkOffset,
// DRY по ALGO.MD §0 ("ошибка на единицу даёт битое видео и не ловится
// глазами" — не дублировать в двух местах).
// trace — необязательный объект perf-trace.js (MEDIA-PERF-TZ.md §3.2): сеть и
// расшифровка мерятся ОТДЕЛЬНО (mark("net", ms) / mark("decrypt", ms)), плюс
// счётчик фактических HTTP-запросов (count("requests")) — на параллельном
// пуле (getRange/mapPool) несколько чанков меряются одновременно, поэтому
// накопительная сумма в mark(phase, ms), не последовательная дельта.
export async function getChunk(manifest, fileKey, chunkIndex, { serverUrl, fetchImpl, trace, priority } = {}) {
	const options = { ...(fetchImpl ? { fetchImpl } : {}), ...(priority !== undefined ? { priority } : {}) };
	const cipherChunk = await obtainCipherChunk(manifest, chunkIndex, { serverUrl, options, trace });
	// Расшифровка — у каждого вызывающего своя, вне реестра (MEDIA-PERF-TZ-6.md
	// §6): fileKey одного блоба может различаться (перезаливка под ключом доли),
	// а общий plaintext-буфер сделал бы владение байтами неочевидным.
	const decStart = trace ? nowMs() : 0;
	const plain = decryptChunk(cipherChunk, fileKey, chunkIndex);
	if (trace) trace.mark("decrypt", nowMs() - decStart);
	return plain;
}

// MEDIA-PERF-TZ-6.md §6. Реестр чанков «в полёте»: ключ тот же, что у
// cipherRam, значение — промис ШИФРОТЕКСТА. Дубли давали prefetch плеера,
// несколько потребителей одного файла и два независимых пула
// (getRange/player-session); очередь §2 лишь ограничивала параллелизм, но
// честно выполняла оба запроса. Запись снимается и при успехе, и при отказе:
// закэшированный отказ навсегда ломал бы чанк до перезагрузки вкладки.
// Известное ограничение: приоритет очереди у объединённого запроса — того, кто
// пришёл первым. Если PREVIEW уже отдал запрос в blossomQueue, а тот же чанк
// потом понадобился PLAYER, плеер ждёт низкоприоритетный запрос: перепланировать
// отданное нельзя без переделки очереди. Размен осознанный — дубль стоил бы
// слота и полного тела чанка, а тут проигрыш только в задержке.
const chunkInflight = new Map(); // cipherRamKey -> Promise<Uint8Array>

function obtainCipherChunk(manifest, chunkIndex, { serverUrl, options, trace }) {
	const ramKey = cipherRamKey(manifest.blobSha256, chunkIndex);
	const inflight = chunkInflight.get(ramKey);
	if (inflight) {
		trace?.count("dedup");
		return inflight;
	}
	const promise = fetchCipherChunk(manifest, chunkIndex, ramKey, { serverUrl, options, trace });
	chunkInflight.set(ramKey, promise);
	// Снятие — обработчиком, зарегистрированным ДО обработчиков ожидающих:
	// к моменту, когда они проснутся, записи уже нет, и повтор после отказа
	// снова идёт в сеть. Проверка на тождество — на случай, если запись успели
	// заменить.
	const clear = () => {
		if (chunkInflight.get(ramKey) === promise) chunkInflight.delete(ramKey);
	};
	promise.then(clear, clear);
	return promise;
}

async function fetchCipherChunk(manifest, chunkIndex, ramKey, { serverUrl, options, trace }) {
	let cipherChunk = cipherRam.get(ramKey);
	if (cipherChunk) {
		cipherRam.delete(ramKey);
		cipherRam.set(ramKey, cipherChunk);
	} else {
		cipherChunk = await getCachedCipherChunk(manifest.blobSha256, chunkIndex);
		if (cipherChunk) {
			if (cipherRam.has(ramKey)) cipherRam.delete(ramKey);
			cipherRam.set(ramKey, cipherChunk);
			evictCipherRam();
		}
	}
	if (!cipherChunk) {
		const cipherStart = cipherChunkOffset(chunkIndex, manifest.chunkSize);
		const cipherEnd = cipherStart + cipherChunkLength(manifest, chunkIndex) - 1;
		const netStart = trace ? nowMs() : 0;
		cipherChunk = await downloadBlobRange(serverUrl, manifest.blobSha256, cipherStart, cipherEnd, options);
		if (trace) {
			trace.mark("net", nowMs() - netStart);
			// Только у владельца запроса: счётчик обязан показывать число
			// реальных HTTP-запросов (по нему §0 мерил нагрузку).
			trace.count("requests");
		}
		assertChunkDigest(manifest, chunkIndex, cipherChunk);
		rememberCipherChunk(manifest.blobSha256, chunkIndex, cipherChunk);
	} else {
		assertChunkDigest(manifest, chunkIndex, cipherChunk);
	}
	return cipherChunk;
}

function nowMs() {
	return typeof performance !== "undefined" && typeof performance.now === "function" ? performance.now() : Date.now();
}

// start/end — байтовый диапазон В ИСХОДНОМ (расшифрованном) файле,
// end ИСКЛЮЧАЮЩИЙ (как rangeToChunks). Возвращает ровно запрошенные байты,
// не чанк(и) целиком.
// onProgress — MEDIA-PERF-TZ.md §6.3: фолбэк без SW-controller (media-url.js)
// качает видео/аудио ЦЕЛИКОМ этим путём — раньше единственный статус был
// неопределённый "Загрузка…"; теперь на каждый завершённый чанк отдаём
// {chunksDone, chunksTotal, bytesDone, bytesTotal}, UI считает процент сам
// (порядок завершения чанков в пуле не гарантирован — bytesDone копится по
// ФАКТУ завершения, не по индексу, поэтому не строго монотонно приближается
// к 100% по чанку N, но общий процент всё равно растёт корректно).
export async function getRange(manifest, fileKey, start, end, opts = {}) {
	const { onProgress, trace } = opts;
	const count = manifest.chunks.length;
	const lastChunkSize = manifest.size - (count - 1) * manifest.chunkSize;
	const { firstIdx, lastIdx, skipHead, skipTail } = rangeToChunks(start, end - start, {
		chunkSize: manifest.chunkSize,
		count,
		lastChunkSize,
	});

	const indices = [];
	for (let i = firstIdx; i <= lastIdx; i++) indices.push(i);
	const chunksTotal = indices.length;
	const bytesTotal = end - start;
	let chunksDone = 0;
	let bytesDone = 0;
	const decryptedChunks = await mapPool(indices, GET_RANGE_CONCURRENCY, async (i) => {
		const bytes = await getChunk(manifest, fileKey, i, opts);
		chunksDone += 1;
		bytesDone += bytes.length;
		onProgress?.({ phase: "download", chunksDone, chunksTotal, bytesDone: Math.min(bytesDone, bytesTotal), bytesTotal });
		return bytes;
	});
	trace?.count("chunks", chunksTotal);

	const joined = concatBytes(...decryptedChunks);
	const tailCut = skipTail > 0 ? joined.length - skipTail : joined.length;
	return joined.subarray(skipHead, tailCut);
}
