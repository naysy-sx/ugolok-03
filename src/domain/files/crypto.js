// Независимое шифрование чанков — I-CHUNK-INDEP (CONTRACTS.md/MATH.md §3.5,
// этап 53). НЕ перенос core/crypto/file-crypto.js (тот шифрует файл целиком
// одним блоком — П-3, несовместимо с перемоткой в плеере) — новый примитив
// на той же готовой крипто-библиотеке (@noble/ciphers), тот же алгоритм,
// что и везде в проекте (ChaCha20-Poly1305). Формализация — выбор параметра
// nonce-стратегии (правило 13b orchestrate-workers, крипто-исключение):
// nonce детерминированно из индекса чанка, НЕ хранится — экономит 12
// байт/чанк и делает манифест единственным источником порядка чанков.
import { chacha20poly1305 } from "@noble/ciphers/chacha.js";

export function generateFileKey() {
	return crypto.getRandomValues(new Uint8Array(32));
}

// Nonce — 12 байт, последние 4 — big-endian индекс чанка, остальное нули.
// Один и тот же fileKey никогда не встречает два чанка с одинаковым
// индексом (индекс — позиция чанка В ЭТОМ файле, не глобальный счётчик),
// поэтому пара (key, nonce) не повторяется — необходимое условие
// безопасности потокового шифра.
export function deriveChunkNonce(chunkIndex) {
	const nonce = new Uint8Array(12);
	new DataView(nonce.buffer).setUint32(8, chunkIndex, false);
	return nonce;
}

export function encryptChunk(chunkBytes, fileKey, chunkIndex) {
	return chacha20poly1305(fileKey, deriveChunkNonce(chunkIndex)).encrypt(chunkBytes);
}

export function decryptChunk(ciphertext, fileKey, chunkIndex) {
	return chacha20poly1305(fileKey, deriveChunkNonce(chunkIndex)).decrypt(ciphertext);
}
