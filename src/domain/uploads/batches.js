// ТЗ-03 — пачки журнала: границы пачек, шифрование, событие. Чистая логика.
//
// Пачка закрывается при 100 операциях (или при разрастании по байтам, чтобы событие
// уместилось в maxEventSize relay = 65536) либо с наступлением новых суток.
// Открытая пачка публикуется при изменениях, закрытая не переписывается, кроме
// удаления записей (freeSpace) — тогда она переписывается без них.
import { chacha20poly1305 } from "@noble/ciphers/chacha.js";
import { concatBytes } from "@noble/ciphers/utils.js";
import { getPublicKey } from "../../core/crypto/keys.js";
import { sign } from "../../core/crypto/sign.js";
import { sanitizeOp } from "./records.js";

// Свободный kind (занятые: 30060-30075, 3001-3012, 29001-29005 …).
export const JOURNAL_KIND = 30076;
export const BATCH_MAX_OPS = 100;
// NIP-44/relay: событие ≤ 65536 байт целиком, base64 добавляет ~33% — держим
// открытый текст ≤ 28 КБ.
export const BATCH_MAX_BYTES = 28_000;
export const PAYLOAD_VERSION = 1;

const enc = new TextEncoder();
const dec = new TextDecoder();

export function dayKey(ms) {
	return new Date(ms).toISOString().slice(0, 10);
}

export function devShort(deviceId) {
	return String(deviceId).replace(/[^0-9a-f]/gi, "").slice(0, 8).padEnd(8, "0");
}

export function batchId(day, dev, seq) {
	return `uploads-${day}-${dev}-${seq}`;
}

export function parseBatchId(d) {
	const m = /^uploads-(\d{4}-\d{2}-\d{2})-([0-9a-f]{8})-(\d+)$/.exec(String(d));
	if (!m) return null;
	return { day: m[1], dev: m[2], seq: Number(m[3]) };
}

function opBytes(op) {
	return enc.encode(JSON.stringify(op)).length;
}

function batchBytes(batch) {
	return enc.encode(JSON.stringify(batch.ops)).length;
}

// Добавляет операции в пачки СВОЕГО устройства. batches — массив ВСЕХ известных
// пачек (мутируется: новые пачки добавляются). Возвращает множество изменённых d.
// Правила: открытая пачка сегодняшних суток принимает операции до лимита; прошлые
// сутки закрываются; заполненная закрывается и открывается следующая.
export function appendOps(batches, ops, { dev, now }) {
	const day = dayKey(now);
	const touched = new Set();
	const own = () => batches.filter((b) => b.dev === dev);

	// закрыть открытые пачки прошлых суток
	for (const b of own()) {
		if (!b.closed && b.day !== day) {
			b.closed = true;
			b.dirty = true;
			b.updatedAt = now;
			touched.add(b.d);
		}
	}
	const openToday = () => own().find((b) => !b.closed && b.day === day);
	const nextSeq = () => own().filter((b) => b.day === day).reduce((m, b) => Math.max(m, b.seq), 0) + 1;

	for (const op of ops) {
		let b = openToday();
		if (b && (b.ops.length >= BATCH_MAX_OPS || batchBytes(b) + opBytes(op) > BATCH_MAX_BYTES)) {
			b.closed = true;
			b.dirty = true;
			b.updatedAt = now;
			touched.add(b.d);
			b = undefined;
		}
		if (!b) {
			const seq = nextSeq();
			b = { d: batchId(day, dev, seq), day, dev, seq, ops: [], closed: false, dirty: true, updatedAt: now };
			batches.push(b);
		}
		b.ops.push(op);
		b.dirty = true;
		b.updatedAt = now;
		touched.add(b.d);
		if (b.ops.length >= BATCH_MAX_OPS) b.closed = true;
	}
	return touched;
}

function b64(bytes) {
	let s = "";
	for (const x of bytes) s += String.fromCharCode(x);
	return btoa(s);
}

function unb64(str) {
	return Uint8Array.from(atob(str), (c) => c.charCodeAt(0));
}

export function encryptPayload(payload, journalKey) {
	const nonce = crypto.getRandomValues(new Uint8Array(12));
	const ct = chacha20poly1305(journalKey, nonce).encrypt(enc.encode(JSON.stringify(payload)));
	return b64(concatBytes(nonce, ct));
}

export function decryptPayload(content, journalKey) {
	const raw = unb64(content);
	const pt = chacha20poly1305(journalKey, raw.subarray(0, 12)).decrypt(raw.subarray(12));
	return JSON.parse(dec.decode(pt));
}

export function journalPubkey(journalSigner) {
	return Array.from(getPublicKey(journalSigner), (x) => x.toString(16).padStart(2, "0")).join("");
}

// createdAt строго растёт для одной пачки (замещаемое событие: при равных секундах
// relay выберет по id, и свежая версия могла бы проиграть).
export function buildBatchEvent(batch, journalKey, journalSigner, createdAt) {
	const content = encryptPayload({ v: PAYLOAD_VERSION, closed: !!batch.closed, ops: batch.ops }, journalKey);
	return sign({ kind: JOURNAL_KIND, tags: [["d", batch.d]], content, created_at: createdAt }, journalSigner);
}

// -> {d, closed, ops, createdAt} | null (чужой автор, не наш kind, битый шифротекст,
// неизвестная версия — рутинный случай, не ошибка).
export function parseBatchEvent(event, journalKey, expectedPubkey) {
	try {
		if (!event || event.kind !== JOURNAL_KIND || event.pubkey !== expectedPubkey) return null;
		const d = event.tags?.find((t) => t[0] === "d")?.[1];
		const id = parseBatchId(d);
		if (!id) return null;
		const payload = decryptPayload(event.content, journalKey);
		if (!payload || payload.v !== PAYLOAD_VERSION || !Array.isArray(payload.ops)) return null;
		const ops = payload.ops.map(sanitizeOp).filter(Boolean);
		return { d, ...id, closed: !!payload.closed, ops, createdAt: event.created_at };
	} catch {
		return null;
	}
}
