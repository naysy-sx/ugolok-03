// ТЗ-04 — квоты на клиенте: чистая логика (без сети и без Dexie).
//
// Числа (потолок, предел размера файла, режим) приходят с сервера (GET /api/quota) и меняются
// без пересборки клиента. Зашитое значение (MAX_SANITY_FILE_SIZE в attachment-validation.js)
// остаётся ТОЛЬКО крайней страховкой на случай, если сервер недоступен или квот не знает.
import { DomainError } from "../errors.js";
import { chunkSizeFor } from "../media/upload-plan.js";
import { classOf } from "../media/media-ref.js";
import { formatBytes } from "./format.js";
import { t } from "../../ui/signals/i18n.js";
import { BlossomRefusal, REFUSAL_REASONS } from "../../core/transport/blossom-client.js";

const AEAD_TAG_BYTES = 16; // тег ChaCha20-Poly1305 на каждый чанк
const MANIFEST_BASE_BYTES = 300; // JSON манифеста без списка чанков
const MANIFEST_PER_CHUNK_BYTES = 70; // sha256 hex + кавычки/запятая
// Превью картинки/видео (≈10–20 КБ) и его манифест уходят на сервер отдельными блобами и
// тоже считаются в квоту — резервируем с запасом.
const PREVIEW_RESERVE_BYTES = 40_000;

export const WARNING_RATIO = 0.85; // «ближе к потолку»; пороги живут в клиенте, не в протоколе

// -> {enabled, used, limit|null, remaining|null, maxFileSize|null, mode}
export function normalizeQuota(raw) {
	if (!raw || typeof raw !== "object") return null;
	const num = (v) => (Number.isFinite(Number(v)) && v !== null && v !== undefined ? Number(v) : null);
	const enabled = raw.enabled !== false && raw.limit !== null && raw.limit !== undefined;
	return {
		enabled,
		used: num(raw.used) ?? 0,
		limit: enabled ? num(raw.limit) : null,
		remaining: enabled ? num(raw.remaining) ?? Math.max(0, (num(raw.limit) ?? 0) - (num(raw.used) ?? 0)) : null,
		maxFileSize: num(raw.maxFileSize),
		mode: raw.mode === "readonly" ? "readonly" : "normal",
	};
}

// Сколько байт заливка файла реально займёт на сервере: шифротекст (+16 байт на чанк),
// манифест, для картинок/видео — превью с манифестом. size — размер исходного файла.
export function estimateUploadBytes(size, mime) {
	const n = Math.max(0, Number(size) || 0);
	const chunk = chunkSizeFor(n);
	const chunks = n === 0 ? 0 : Math.ceil(n / chunk);
	const content = n + AEAD_TAG_BYTES * chunks;
	const manifest = MANIFEST_BASE_BYTES + MANIFEST_PER_CHUNK_BYTES * chunks;
	const cls = mime ? classOf(mime) : "other";
	const preview = cls === "image" || cls === "video" ? PREVIEW_RESERVE_BYTES : 0;
	return { content, total: content + manifest + preview };
}

// Уровень для полосы: unlimited | normal | warning | full | readonly.
export function quotaLevel(q) {
	if (!q) return "unlimited";
	if (q.mode === "readonly") return "readonly";
	if (!q.enabled || !q.limit) return "unlimited";
	if (q.used >= q.limit) return "full";
	if (q.used / q.limit >= WARNING_RATIO) return "warning";
	return "normal";
}

export function refusalError(reason, details = {}) {
	if (reason === "file-too-large") {
		return new DomainError("файл больше предела сервера", "errors.fileTooLargeForServer", {
			name: details.name || t("storage.unnamed"),
			size: formatBytes(details.size ?? 0),
			max: formatBytes(details.max ?? 0),
		});
	}
	if (reason === "readonly") {
		return new DomainError("хранилище только для чтения", "errors.storageReadonly");
	}
	return new DomainError("не хватает места на сервере", "errors.quotaExceeded", {
		name: details.name || t("storage.unnamed"),
		need: formatBytes(details.need ?? 0),
		free: formatBytes(details.free ?? 0),
	});
}

// Проверка ПАКЕТА файлов до всякого шифрования. files: [{name, size, mime}], pendingBytes —
// уже стоящее в лотке (лоток проверяет по одному файлу). -> {ok:true} | {ok:false, reason, error}
export function checkBatch(files, quota, pendingBytes = 0) {
	if (!quota) return { ok: true };
	if (quota.mode === "readonly") return { ok: false, reason: "readonly", error: refusalError("readonly") };
	let need = pendingBytes;
	for (const f of files) {
		const est = estimateUploadBytes(f.size, f.mime);
		if (quota.maxFileSize && est.content > quota.maxFileSize) {
			return { ok: false, reason: "file-too-large", error: refusalError("file-too-large", { name: f.name, size: f.size, max: quota.maxFileSize }) };
		}
		need += est.total;
	}
	if (quota.enabled && quota.remaining !== null && need > quota.remaining) {
		const last = files[files.length - 1];
		return { ok: false, reason: "quota-exceeded", error: refusalError("quota-exceeded", { name: last?.name, need, free: quota.remaining }) };
	}
	return { ok: true };
}

export const REFUSAL_KEYS = new Set(["errors.fileTooLargeForServer", "errors.storageReadonly", "errors.quotaExceeded"]);

// Отказ ли по квоте — по ключу доменной ошибки (лоток тогда останавливается целиком).
export function isRefusalError(err) {
	return REFUSAL_KEYS.has(err?.key) || err instanceof BlossomRefusal;
}

// Сетевой отказ сервера (BlossomRefusal или результат HEAD с машинной причиной) -> понятная ошибка.
export function toDomainRefusal(err, { name, sizeBytes } = {}) {
	if (err instanceof BlossomRefusal) {
		const info = err.info ?? {};
		return refusalError(err.reason, { name, max: info.maxFileSize, free: info.remaining, need: sizeBytes, size: sizeBytes });
	}
	return err;
}

export function refusalFromRequirements(result, sizeBytes, name) {
	if (result?.ok || !REFUSAL_REASONS.has(result?.reason)) return null;
	const q = result.quota ?? {};
	return refusalError(result.reason, { name, max: q.maxFileSize, free: q.remaining, need: sizeBytes, size: sizeBytes });
}
