import { chacha20poly1305 } from "@noble/ciphers/chacha.js";
import { concatBytes } from "@noble/ciphers/utils.js";
import { hexToBytes, utf8ToBytes } from "@noble/hashes/utils.js";
import { encrypt as nip44Encrypt, decrypt as nip44Decrypt } from "./nip44.js";

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

// TECH.md §4.7.1 — создание канала: channelKey (32 байта) + channelTopic (16 байт),
// оба случайные, генерируются один раз при v=1 и на каждый revoke (новый channelKey,
// тот же channelTopic — topic не меняется, это routing-тег, не секрет).
export function generateChannelKey() {
	return crypto.getRandomValues(new Uint8Array(32));
}

export function generateChannelTopic() {
	return crypto.getRandomValues(new Uint8Array(16));
}

// kind 30053 (F-CH-04) — ТОЛЬКО ключевой материал (CONTRACTS.md, этап 30: найденный
// пробел — метаданные канала идут ОТДЕЛЬНО через kind 30060, channelKey-зашифрованный,
// не через этот грант, иначе апдейт метаданных требовал бы повторной раздачи ключей).
// НАЙДЕНО ЖИВЫМ АДВЕРСАРНЫМ ТЕСТОМ (этап 33, banMember): версия НЕ передавалась в payload
// вовсе — receiveChannelKeyGrant хардкодил version=1 для ЛЮБОГО гранта (комментарий этапа
// 30 буквально предполагал это временным: "если появится revoke, kind 30053 обязан нести
// версию явно"). Ротация ключа при бане прислала grant с v_new под тем же хардкодом "1" —
// молча ЗАТИРАЛА уже сохранённый v_old тем же номером версии, ломая исторический доступ
// и вызывая AEAD-ошибку у всех, кто ещё пытался читать старый эпоху. version — обязательный
// параметр теперь (не опциональный: подписчик БЕЗ версии — забытая правка вызывающего кода,
// должно падать явно, а не тихо считать v1).
export function encryptChannelKeyGrant(channelId, channelTopicHex, channelKeyHex, version, ownerPrivKey, readerPubkey) {
	const payload = JSON.stringify({ channelId, channelTopic: channelTopicHex, channelKey: channelKeyHex, version });
	return nip44Encrypt(payload, ownerPrivKey, readerPubkey);
}

export function decryptChannelKeyGrant(content, readerPrivKey, ownerPubkey) {
	const payload = nip44Decrypt(content, readerPrivKey, ownerPubkey);
	return JSON.parse(payload);
}

// F-CH-03 буквально: base64(uint32BE(v) ‖ nonce(12) ‖ ChaCha20-Poly1305(text, key[v], nonce)).
// Используется и для постов/комментариев (этап 31), и для kind 30060 (метаданные канала,
// этап 30 — правка контракта, см. DESIGN.md/CONTRACTS.md).
export function encryptChannelContent(plaintext, channelKeyHex, version) {
	const key = hexToBytes(channelKeyHex);
	const nonce = crypto.getRandomValues(new Uint8Array(12));
	const ciphertext = chacha20poly1305(key, nonce).encrypt(utf8ToBytes(plaintext));
	return encodeBase64(concatBytes(uint32BE(version), nonce, ciphertext));
}

// channelKeysByVersion: { [version]: hexString } — версия читается из заголовка конверта;
// версия НЕ найдена в карте (никогда не было VIEW на эту эпоху, ИЛИ эпоха ещё не
// подгружена) -> null, НЕ throw (тот же принцип, что receiveGroupMessageEvent -> null
// на "не наша группа" — рутинный случай при чтении relay-broadcast потока, где мимо
// проходит много чужих/неизвестных эпох, не только настоящая ошибка).
export function decryptChannelContent(base64Content, channelKeysByVersion) {
	const bytes = decodeBase64(base64Content);
	const version = readUint32BE(bytes.subarray(0, 4));
	const keyHex = channelKeysByVersion[version];
	if (keyHex === undefined) return null;
	const key = hexToBytes(keyHex);
	const nonce = bytes.subarray(4, 16);
	const ciphertext = bytes.subarray(16);
	const plaintextBytes = chacha20poly1305(key, nonce).decrypt(ciphertext);
	return new TextDecoder().decode(plaintextBytes);
}
