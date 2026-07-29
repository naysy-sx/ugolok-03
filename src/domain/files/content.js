// putStream/getRange — единственные точки записи/чтения содержимого
// (CONTRACTS.md, этап 53, §5.4 TASK.md). Решение №11 TASK.md: чанки — НЕ
// отдельные блобы, а внутреннее деление ОДНОГО блоба файла; чтение чанка —
// HTTP Range по этому же блобу (blob.js, П-4 подтвердил живым запросом).
// Манифест — отдельный, отдельно адресуемый маленький блоб (§3.6 MATH.md).
//
// Сужение скоупа (эта сессия, зафиксировано, не молчаливый пробел):
// манифест загружается ОТКРЫТЫМ текстом (не шифруется отдельно) — метаданные
// (mime/size/число чанков) заметно менее чувствительны, чем содержимое
// (которое шифруется чанково), и уже сейчас так же доступны по хэшу, как и
// сам шифротекст, при текущей permissive-конфигурации Blossom (CONTRACTS.md,
// П-4). Пересмотреть при И6 (шаринг), если модель доступа изменится.
import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex, concatBytes } from "@noble/hashes/utils.js";
import { generateFileKey, encryptChunk, decryptChunk } from "./crypto.js";
import { planChunks, rangeToChunks } from "./manifest.js";
import { uploadBlob, downloadBlob, downloadBlobRange } from "./blob.js";

export const DEFAULT_CHUNK_SIZE = 256 * 1024; // 256 КБ, ALGO.MD §9.2 — рекомендация, не замер

// bytes — Uint8Array целиком в памяти. Потоковое чтение File/ReadableStream —
// следующий проход (замечено ALGO.MD §9.3: "файл целиком в память не читается
// никогда" — здесь это НЕ соблюдено буквально для v0.1 первого прохода;
// явно фиксирую как сужение, не как решённое требование НФ-бюджета И2).
// fileKey — необязательный оверрайд (этап 53 И6, задача 6.6b): файлы
// ВНУТРИ доли шифруются ключом, ПРОИЗВОДНЫМ от subtreeKey (share.js/
// move-routing.js), не случайным — иначе получатель не смог бы
// независимо его пересчитать. Без оверрайда — поведение НЕ меняется
// (случайный ключ, как раньше).
export async function putStream(bytes, { name, mime, chunkSize = DEFAULT_CHUNK_SIZE, onProgress, serverUrl, privateKey, fetchImpl, fileKey: overrideFileKey } = {}) {
	const fileKey = overrideFileKey ?? generateFileKey();
	const size = bytes.length;
	const { count, lastChunkSize } = planChunks(size, chunkSize);

	const chunkDigests = [];
	const cipherParts = [];
	for (let i = 0; i < count; i++) {
		const start = i * chunkSize;
		const end = i === count - 1 ? start + lastChunkSize : start + chunkSize;
		const cipherChunk = encryptChunk(bytes.subarray(start, end), fileKey, i);
		chunkDigests.push(bytesToHex(sha256(cipherChunk)));
		cipherParts.push(cipherChunk);
		onProgress?.({ chunksDone: i + 1, chunksTotal: count });
	}
	const fullCiphertext = concatBytes(...cipherParts);
	const blobSha256Local = bytesToHex(sha256(fullCiphertext));
	const uploadOptions = fetchImpl ? { fetchImpl } : {};
	const uploadResponse = await uploadBlob(serverUrl, fullCiphertext, blobSha256Local, privateKey, uploadOptions);

	// keyId — непрозрачная ССЫЛКА (§4.1 MATH.md: "Manifest.keyId : KeyId"), не
	// сырой ключ — сырой fileKey возвращается ОТДЕЛЬНЫМ полем, персистентность/
	// обёртка ключа (share.js, И6) вне ответственности content.js.
	const manifest = {
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

export async function getManifest(manifestDigest, { serverUrl, fetchImpl } = {}) {
	const options = fetchImpl ? { fetchImpl } : {};
	// Манифест — маленький (единицы-десятки КБ даже на гигабайтный файл,
	// ALGO.MD §9.4), полный GET оправдан, Range здесь не нужен.
	const bytes = await downloadBlob(serverUrl, manifestDigest, options);
	const actualDigest = bytesToHex(sha256(bytes));
	if (actualDigest !== manifestDigest) {
		throw new Error("Blossom-сервер вернул подменённый манифест (digest не совпадает)");
	}
	return JSON.parse(new TextDecoder().decode(bytes));
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

// Один чанк ЦЕЛИКОМ, расшифрованный (CONTRACTS.md, этап 53 И4, задача 4.3) —
// единица кэширования плеера (chunk-cache.js), в отличие от getRange ниже,
// который отдаёт произвольный байтовый диапазон. Вынесено аддитивно из
// getRange (было инлайном в цикле) — та же арифметика cipherChunkOffset,
// DRY по ALGO.MD §0 ("ошибка на единицу даёт битое видео и не ловится
// глазами" — не дублировать в двух местах).
export async function getChunk(manifest, fileKey, chunkIndex, { serverUrl, fetchImpl } = {}) {
	const count = manifest.chunks.length;
	const lastChunkSize = manifest.size - (count - 1) * manifest.chunkSize;
	const plainChunkSize = chunkIndex === count - 1 ? lastChunkSize : manifest.chunkSize;
	const options = fetchImpl ? { fetchImpl } : {};
	const cipherStart = cipherChunkOffset(chunkIndex, manifest.chunkSize);
	const cipherEnd = cipherStart + plainChunkSize + AEAD_TAG_BYTES - 1; // включительно (Range)
	const cipherChunk = await downloadBlobRange(serverUrl, manifest.blobSha256, cipherStart, cipherEnd, options);
	const actualDigest = bytesToHex(sha256(cipherChunk));
	if (actualDigest !== manifest.chunks[chunkIndex]) {
		throw new Error(`Blossom-сервер вернул подменённый чанк ${chunkIndex} (digest не совпадает)`);
	}
	return decryptChunk(cipherChunk, fileKey, chunkIndex);
}

// start/end — байтовый диапазон В ИСХОДНОМ (расшифрованном) файле,
// end ИСКЛЮЧАЮЩИЙ (как rangeToChunks). Возвращает ровно запрошенные байты,
// не чанк(и) целиком.
export async function getRange(manifest, fileKey, start, end, opts = {}) {
	const count = manifest.chunks.length;
	const lastChunkSize = manifest.size - (count - 1) * manifest.chunkSize;
	const { firstIdx, lastIdx, skipHead, skipTail } = rangeToChunks(start, end - start, {
		chunkSize: manifest.chunkSize,
		count,
		lastChunkSize,
	});

	const decryptedChunks = [];
	for (let i = firstIdx; i <= lastIdx; i++) {
		decryptedChunks.push(await getChunk(manifest, fileKey, i, opts));
	}

	const joined = concatBytes(...decryptedChunks);
	const tailCut = skipTail > 0 ? joined.length - skipTail : joined.length;
	return joined.subarray(skipHead, tailCut);
}
