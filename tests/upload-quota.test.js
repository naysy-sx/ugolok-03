import { test } from "node:test";
import assert from "node:assert/strict";
import { normalizeQuota, estimateUploadBytes, checkBatch, quotaLevel, refusalError, isRefusalError, toDomainRefusal, refusalFromRequirements, WARNING_RATIO } from "../src/domain/uploads/quota.js";
import { addFiles, emptyTrayState, planUpload } from "../src/ui/hooks/attachment-tray-core.js";
import { BlossomRefusal } from "../src/core/transport/blossom-client.js";
import { errorMessage, setLocale } from "../src/ui/signals/i18n.js";

const MB = 1024 * 1024;
const GB = 1024 * MB;
const file = (name, size, type = "application/pdf") => ({ name, size, type });
const Q = (over = {}) => normalizeQuota({ enabled: true, used: 0, limit: 1 * GB, remaining: 1 * GB, maxFileSize: 300 * MB, mode: "normal", ...over });

test("normalizeQuota: ответ сервера -> состояние; выключенные квоты — без потолка", () => {
	const q = Q({ used: 100, limit: 1000, remaining: 900 });
	assert.deepEqual(q, { enabled: true, used: 100, limit: 1000, remaining: 900, maxFileSize: 300 * MB, mode: "normal" });
	const off = normalizeQuota({ enabled: false, used: 5, limit: null, remaining: null, maxFileSize: 100, mode: "normal" });
	assert.equal(off.enabled, false);
	assert.equal(off.limit, null);
	assert.equal(normalizeQuota(null), null);
	assert.equal(normalizeQuota({ used: 1, limit: 10, mode: "readonly" }).mode, "readonly");
});

test("estimateUploadBytes: шифротекст +16 байт на чанк, манифест, превью только у картинок/видео", () => {
	const doc = estimateUploadBytes(1 * MB, "application/pdf");
	assert.equal(doc.content, 1 * MB + 16 * 16); // 64 КиБ чанки -> 16 чанков
	assert.ok(doc.total > doc.content && doc.total < doc.content + 5000);
	const img = estimateUploadBytes(1 * MB, "image/jpeg");
	assert.ok(img.total - doc.total >= 40_000 - 100, "резерв под превью и его манифест");
	assert.equal(estimateUploadBytes(0, "text/plain").content, 0);
});

test("quotaLevel: норма / предупреждение / исчерпано / только чтение / без ограничений", () => {
	assert.equal(quotaLevel(null), "unlimited");
	assert.equal(quotaLevel(normalizeQuota({ enabled: false, used: 9, limit: null })), "unlimited");
	assert.equal(quotaLevel(Q({ used: 100 * MB })), "normal");
	assert.equal(quotaLevel(Q({ used: Math.ceil(WARNING_RATIO * GB) })), "warning");
	assert.equal(quotaLevel(Q({ used: GB })), "full");
	assert.equal(quotaLevel(Q({ used: 5, mode: "readonly" })), "readonly");
});

test("checkBatch: слишком крупный файл — file-too-large с размером и пределом", () => {
	setLocale("ru");
	const r = checkBatch([file("видео.mp4", 400 * MB, "video/mp4")], Q());
	assert.equal(r.ok, false);
	assert.equal(r.reason, "file-too-large");
	assert.match(errorMessage(r.error), /видео\.mp4/);
	assert.match(errorMessage(r.error), /300/);
});

test("checkBatch: не помещается в остаток — «нужно X, свободно Y»; помещается — ок", () => {
	setLocale("ru");
	const q = Q({ used: 940 * MB, remaining: 84 * MB });
	const bad = checkBatch([file("архив.pdf", 100 * MB)], q);
	assert.equal(bad.ok, false);
	assert.equal(bad.reason, "quota-exceeded");
	assert.match(errorMessage(bad.error), /свободно/);
	assert.equal(checkBatch([file("малый.pdf", 10 * MB)], q).ok, true);
	// пакет: каждый по отдельности влезает, вместе — нет
	const pair = checkBatch([file("а.pdf", 50 * MB), file("б.pdf", 50 * MB)], q);
	assert.equal(pair.ok, false);
});

test("checkBatch: readonly — отказ на любую заливку; без квоты — всё разрешено", () => {
	assert.equal(checkBatch([file("x.pdf", 1)], Q({ mode: "readonly" })).reason, "readonly");
	assert.equal(checkBatch([file("x.pdf", 900 * MB)], null).ok, true);
	assert.equal(checkBatch([file("x.pdf", 200 * MB)], normalizeQuota({ enabled: false, used: 0, limit: null, maxFileSize: 300 * MB })).ok, true);
});

test("лоток: слишком крупный файл в лоток не попадает, причина — в errors", () => {
	let s = emptyTrayState();
	s = addFiles(s, [file("огромный.mp4", 400 * MB, "video/mp4"), file("нормальный.pdf", 5 * MB)], 10, { quota: Q() });
	assert.deepEqual(s.items.map((i) => i.name), ["нормальный.pdf"]);
	assert.equal(s.errors.length, 1);
	assert.equal(s.errors[0].key, "errors.fileTooLargeForServer");
});

test("лоток: считает уже стоящее в лотке — второй файл не влезает в остаток", () => {
	let s = emptyTrayState();
	const q = Q({ used: 900 * MB, remaining: 124 * MB });
	s = addFiles(s, [file("первый.pdf", 80 * MB)], 10, { quota: q });
	assert.equal(s.items.length, 1);
	s = addFiles(s, [file("второй.pdf", 60 * MB)], 10, { quota: q });
	assert.equal(s.items.length, 1, "второй не помещается вместе с первым");
	assert.equal(s.errors[0].key, "errors.quotaExceeded");
});

test("лоток: ссылки «из хранилища» места не занимают", () => {
	let s = emptyTrayState();
	s.items.push({ id: "r", file: null, storageRef: { manifestDigest: "a", fileKey: new Uint8Array(32), manifest: { mime: "application/pdf", name: "a.pdf", size: 900 * MB } }, mime: "application/pdf", size: 900 * MB, name: "a.pdf", type: "file" });
	s = addFiles(s, [file("новый.pdf", 50 * MB)], 10, { quota: Q({ used: 900 * MB, remaining: 124 * MB }) });
	assert.equal(s.items.length, 2);
});

test("лоток: без квоты (сервер недоступен) — старое поведение, зашитая страховка 1 ГиБ", () => {
	let s = emptyTrayState();
	s = addFiles(s, [file("большой.pdf", 2 * GB), file("нормальный.pdf", 5 * MB)], 10, {});
	const big = s.items.find((i) => i.name === "большой.pdf");
	assert.ok(big.error, "зашитая страховка сработала как item.error (поведение до ТЗ-04)");
	assert.equal(s.items.length, 2);
	assert.throws(() => planUpload(s));
});

test("readonly в лотке: файлы не добавляются", () => {
	let s = emptyTrayState();
	s = addFiles(s, [file("x.pdf", 10)], 10, { quota: Q({ mode: "readonly" }) });
	assert.equal(s.items.length, 0);
	assert.equal(s.errors[0].key, "errors.storageReadonly");
});

test("отказы сервера превращаются в понятные ошибки, остальные не подменяются", () => {
	setLocale("ru");
	const e = toDomainRefusal(new BlossomRefusal(402, "quota-exceeded", { remaining: 80 * MB, maxFileSize: 300 * MB }));
	assert.equal(e.key, "errors.quotaExceeded");
	assert.equal(isRefusalError(e), true);
	const other = new Error("сеть");
	assert.equal(toDomainRefusal(other), other);
	assert.equal(isRefusalError(other), false);
	assert.equal(refusalFromRequirements({ ok: true }, 1), null);
	assert.equal(refusalFromRequirements({ ok: false, status: 415, reason: null }, 1), null);
	assert.equal(refusalFromRequirements({ ok: false, status: 413, reason: "file-too-large", quota: { maxFileSize: 100 } }, 500).key, "errors.fileTooLargeForServer");
	assert.equal(refusalError("readonly").key, "errors.storageReadonly");
});
