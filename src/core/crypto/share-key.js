import { chacha20poly1305 } from "@noble/ciphers/chacha.js";
import { concatBytes } from "@noble/ciphers/utils.js";
import { hkdf } from "@noble/hashes/hkdf.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { hexToBytes, utf8ToBytes } from "@noble/hashes/utils.js";
import { encrypt as nip44Encrypt, decrypt as nip44Decrypt } from "./nip44.js";

// Ключ на поддерево дерева файлов (CONTRACTS.md/DESIGN.md, этап 53 И6,
// задача 6.1) — структурно идентичен core/crypto/channel-key.js (этап 30),
// сознательно НЕ обобщён под оба домена (разный payload/жизненный цикл,
// преждевременная абстракция поперёк доменов хуже трёх похожих строк),
// но копирует уже проверенный на реальных багах паттерн буквально:
// версия — ОБЯЗАТЕЛЬНАЯ часть payload гранта (этап 33: без неё revoke не
// отличает эпохи при ротации, receiveChannelKeyGrant хардкодил v1 для
// любого гранта).

function encodeBase64(bytes) {
	return btoa(String.fromCharCode.apply(null, bytes));
}

function decodeBase64(str) {
	return Uint8Array.from(atob(str), (c) => c.charCodeAt(0));
}

function uint32BE(n) {
	const buf = new Uint8Array(4);
	new DataView(buf.buffer).setUint32(0, n, false);
	return buf;
}

function readUint32BE(bytes) {
	return new DataView(bytes.buffer, bytes.byteOffset, 4).getUint32(0, false);
}

export function generateSubtreeKey() {
	return crypto.getRandomValues(new Uint8Array(32));
}

// FILE_SHARE_GRANT_KIND (30075, domain/files/share.js) — гранту нужен
// СВОЙ d-тег на читателя+версию (opaqueDTag, derivation.js) — тот же
// урок этапа 32 (П-А, CONTRACTS.md): без него второй читатель заместит
// грант первого на relay. Формирование события — вне этого модуля
// (share.js), здесь только шифрование payload.
export function encryptShareGrant(nodeId, subtreeKeyHex, version, ownerPrivKey, readerPubkey) {
	const payload = JSON.stringify({ nodeId, subtreeKey: subtreeKeyHex, version });
	return nip44Encrypt(payload, ownerPrivKey, readerPubkey);
}

export function decryptShareGrant(content, readerPrivKey, ownerPubkey) {
	const payload = nip44Decrypt(content, readerPrivKey, ownerPubkey);
	return JSON.parse(payload);
}

// base64(uint32BE(version) ‖ nonce(12) ‖ ChaCha20-Poly1305(text, key[version], nonce)) —
// буквально формат F-CH-03 (channel-key.js), переиспользован для журнала
// операций расшаренного поддерева (FILE_SUBTREE_OP_KIND).
export function encryptSubtreeOp(plaintext, subtreeKeyHex, version) {
	const key = hexToBytes(subtreeKeyHex);
	const nonce = crypto.getRandomValues(new Uint8Array(12));
	const ciphertext = chacha20poly1305(key, nonce).encrypt(utf8ToBytes(plaintext));
	return encodeBase64(concatBytes(uint32BE(version), nonce, ciphertext));
}

// subtreeKeysByVersion: {[version]: hexString} — версия читается из
// заголовка конверта; версия не найдена в карте (грант на эту эпоху
// никогда не приходил, ИЛИ эпоха ещё не подгружена, ИЛИ пользователь
// был отозван до неё) -> null, НЕ throw (рутинный случай в потоке
// relay-broadcast, не настоящая ошибка — тот же принцип, что
// decryptChannelContent).
export function decryptSubtreeOp(base64Content, subtreeKeysByVersion) {
	const bytes = decodeBase64(base64Content);
	const version = readUint32BE(bytes.subarray(0, 4));
	const keyHex = subtreeKeysByVersion[version];
	if (keyHex === undefined) return null;
	const key = hexToBytes(keyHex);
	const nonce = bytes.subarray(4, 16);
	const ciphertext = bytes.subarray(16);
	const plaintextBytes = chacha20poly1305(key, nonce).decrypt(ciphertext);
	return new TextDecoder().decode(plaintextBytes);
}

// Читает ТОЛЬКО заголовок конверта (версия), без расшифровки — decryptSubtreeOp
// не возвращает версию, которая ФАКТИЧЕСКИ расшифровала (нужна mount.js,
// чтобы пометить сайдкар files_mount_file_meta правильной версией
// subtreeKey, задача 53 И6 6.6b).
export function peekSubtreeOpVersion(base64Content) {
	const bytes = decodeBase64(base64Content);
	return readUint32BE(bytes.subarray(0, 4));
}

// fileKey файла ВНУТРИ доли (CONTRACTS.md/DESIGN.md, этап 53 И6, задача
// 6.6b) — HKDF, salt = домен-разделитель (константа), info = дайджест
// ОТКРЫТОГО текста (per-file контекст — циркулярность с дайджестом
// ШИФРОТЕКСТА разорвана: тот появляется только ПОСЛЕ шифрования, значит
// не годится как вход в деривацию ключа ДЛЯ этого же шифрования).
export function deriveShareFileKey(subtreeKeyHex, plaintextDigestHex) {
	const subtreeKey = hexToBytes(subtreeKeyHex);
	return hkdf(sha256, subtreeKey, utf8ToBytes("Ugolok/v1/share-file"), utf8ToBytes(plaintextDigestHex), 32);
}
