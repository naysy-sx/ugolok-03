// Замена tests/attachments-upload.test.js (этап 53 И7, задача 7.4 — снятие
// фасада attachments, DESIGN.md "Этап 53, И7, задача 7.4"). Новое поведение:
// uploadMessageAttachment шифрует ЧАНКОВАНО через content.js's putStream (не
// целиком, как старый encryptFile), дескриптор несёт manifestDigest/fileKey
// вместо sha256/blossomUrl/encryptionKey. referenceStoredFile — НОВАЯ функция,
// дедупликация (MATH.md §7): вложение ИЗ хранилища "Файлы" ссылается на уже
// существующий блоб, без сети и без нового блоба.
import { test } from "node:test";
import assert from "node:assert/strict";
import { getManifest } from "../src/domain/files/content.js";
import { uploadMessageAttachment, downloadMessageAttachment, referenceStoredFile } from "../src/domain/messaging/attachments.js";
import { MAX_SANITY_FILE_SIZE } from "../src/domain/files/attachment-validation.js";

const ALICE_PRIV = new Uint8Array(32).fill(1);

// Тот же фейковый Blossom с поддержкой Range, что files-content.test.js —
// putStream/getManifest/getRange (используемые внутри messaging/attachments.js)
// требуют РЕАЛЬНОГО digest-адресуемого хранения, не placeholder-строк.
function makeFakeBlossom() {
	const store = new Map();

	async function sha256Hex(bytes) {
		const { sha256 } = await import("@noble/hashes/sha2.js");
		const { bytesToHex } = await import("@noble/hashes/utils.js");
		return bytesToHex(sha256(bytes));
	}

	const fetchImpl = async (url, opts = {}) => {
		if (opts.method === "PUT") {
			const body = new Uint8Array(opts.body);
			const digest = await sha256Hex(body);
			store.set(digest, body);
			return { ok: true, status: 200, json: async () => ({ sha256: digest, size: body.length }), text: async () => "" };
		}
		const parts = url.split("/");
		const digest = parts[parts.length - 1];
		const bytes = store.get(digest);
		if (!bytes) return { ok: false, status: 404, text: async () => "not found" };
		if (opts.headers?.Range) {
			const m = /bytes=(\d+)-(\d+)/.exec(opts.headers.Range);
			const start = Number(m[1]);
			const end = Number(m[2]);
			const slice = bytes.subarray(start, end + 1);
			return { ok: true, status: 206, arrayBuffer: async () => slice.buffer.slice(slice.byteOffset, slice.byteOffset + slice.byteLength) };
		}
		return { ok: true, status: 200, arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) };
	};

	return { fetchImpl, store };
}

test("uploadMessageAttachment: валидирует ДО сети — недопустимый MIME не вызывает fetch вовсе", async () => {
	let called = false;
	const fetchImpl = async () => {
		called = true;
		return { ok: true, status: 200, json: async () => ({}), text: async () => "" };
	};
	await assert.rejects(
		() => uploadMessageAttachment("https://blossom.test", new Uint8Array([1, 2, 3]), { mime: "application/x-msdownload", name: "virus.exe" }, ALICE_PRIV, { fetchImpl }),
		/тип/,
	);
	assert.equal(called, false, "validateAttachment должен отклонить ДО сетевого вызова");
});

// Этап 62 — раздельные лимиты по типу удалены из клиента (decisive-проверка
// теперь server-side, BUD-06/checkUploadRequirements); здесь остаётся только
// щедрый санити-потолок MAX_SANITY_FILE_SIZE (1 ГБ) на ВСЕ MIME — 25 MB image
// (старая граница MAX_IMAGE_FILE_SIZE) теперь ДОПУСТИМ, отказ проверяется на
// границе нового единого потолка. { length } вместо реального Uint8Array —
// validateAttachment бросает ДО обращения к самим байтам, гигабайтный буфер
// в памяти теста не нужен.
test("uploadMessageAttachment: превышение MAX_SANITY_FILE_SIZE -> throw, fetch не вызывается", async () => {
	let called = false;
	const fetchImpl = async () => {
		called = true;
		return { ok: true, status: 200, json: async () => ({}), text: async () => "" };
	};
	const big = { length: MAX_SANITY_FILE_SIZE + 1 };
	await assert.rejects(() => uploadMessageAttachment("https://blossom.test", big, { mime: "image/jpeg", name: "big.jpg" }, ALICE_PRIV, { fetchImpl }));
	assert.equal(called, false);
});

test("uploadMessageAttachment: шифрует файл перед отправкой (сервер не получает исходные байты)", async () => {
	const { fetchImpl, store } = makeFakeBlossom();
	const original = new TextEncoder().encode("секретное содержимое файла");
	await uploadMessageAttachment("https://blossom.test", original, { mime: "image/png", name: "secret.png" }, ALICE_PRIV, { fetchImpl });

	let foundPlaintext = false;
	for (const bytes of store.values()) {
		if (bytes.length === original.length && bytes.every((b, i) => b === original[i])) foundPlaintext = true;
	}
	assert.equal(foundPlaintext, false, "ни один сохранённый на сервере блоб не должен совпадать с оригиналом побайтно");
});

test("uploadMessageAttachment: дескриптор несёт manifestDigest/fileKey (не sha256/blossomUrl/encryptionKey — новая форма)", async () => {
	const { fetchImpl } = makeFakeBlossom();
	const original = new TextEncoder().encode("картинка (условно)");
	const descriptor = await uploadMessageAttachment("https://blossom.test", original, { mime: "image/jpeg", name: "photo.jpg" }, ALICE_PRIV, { fetchImpl });

	assert.equal(descriptor.type, "image");
	assert.equal(descriptor.mime, "image/jpeg");
	assert.equal(descriptor.name, "photo.jpg");
	assert.equal(typeof descriptor.manifestDigest, "string");
	assert.equal(typeof descriptor.size, "number");
	assert.doesNotThrow(() => atob(descriptor.fileKey), "fileKey — валидный base64");
	assert.equal(atob(descriptor.fileKey).length, 32, "fileKey — 32 байта (ChaCha20-Poly1305)");
});

test("type определяется по префиксу mime: video/audio/file", async () => {
	const { fetchImpl } = makeFakeBlossom();
	const bytes = new Uint8Array([1, 2, 3, 4]);
	const video = await uploadMessageAttachment("https://blossom.test", bytes, { mime: "video/mp4", name: "v.mp4" }, ALICE_PRIV, { fetchImpl });
	const audio = await uploadMessageAttachment("https://blossom.test", bytes, { mime: "audio/ogg", name: "a.ogg" }, ALICE_PRIV, { fetchImpl });
	const file = await uploadMessageAttachment("https://blossom.test", bytes, { mime: "application/pdf", name: "doc.pdf" }, ALICE_PRIV, { fetchImpl });
	assert.equal(video.type, "video");
	assert.equal(audio.type, "audio");
	assert.equal(file.type, "file");
});

test("downloadMessageAttachment: полный round-trip даёт исходные байты обратно", async () => {
	const { fetchImpl } = makeFakeBlossom();
	const original = new TextEncoder().encode("содержимое для полного цикла загрузка->скачивание");
	const descriptor = await uploadMessageAttachment("https://blossom.test", original, { mime: "image/png", name: "x.png" }, ALICE_PRIV, { fetchImpl });

	const downloaded = await downloadMessageAttachment(descriptor, { serverUrl: "https://blossom.test", fetchImpl });
	assert.deepEqual(downloaded, original);
});

test("downloadMessageAttachment: сервер вернул ПОДМЕНЁННЫЙ манифест — digest-проверка отклоняет", async () => {
	const { fetchImpl, store } = makeFakeBlossom();
	const original = new TextEncoder().encode("оригинальное содержимое");
	const descriptor = await uploadMessageAttachment("https://blossom.test", original, { mime: "image/png", name: "x.png" }, ALICE_PRIV, { fetchImpl });

	// Манифест — отдельный блоб, адресуемый manifestDigest (§3.6 MATH.md) — подменяем ЕГО.
	store.set(descriptor.manifestDigest, new TextEncoder().encode('{"подменено":true}'));

	await assert.rejects(() => downloadMessageAttachment(descriptor, { serverUrl: "https://blossom.test", fetchImpl }), /digest|подмен/i);
});

test("referenceStoredFile: БЕЗ сети — собирает дескриптор из уже известных manifest+ключа, не заливает заново (MATH.md §7 — дедупликация)", async () => {
	const { fetchImpl } = makeFakeBlossom();
	const original = new TextEncoder().encode("файл уже в хранилище «Файлы»");
	// Заливка через putStream напрямую (имитирует уже загруженный узел files.jsx) —
	// content.js's putStream, НЕ uploadMessageAttachment, ровно как узел "Файлы".
	const { putStream } = await import("../src/domain/files/content.js");
	const { manifestDigest, fileKey, manifest } = await putStream(original, {
		name: "shared.pdf",
		mime: "application/pdf",
		serverUrl: "https://blossom.test",
		privateKey: ALICE_PRIV,
		fetchImpl,
	});

	// referenceStoredFile сама по себе синхронна и не принимает fetchImpl —
	// сам факт отсутствия сетевого параметра в её сигнатуре ЭТО и доказывает,
	// проверяем явно, что вызов не бросает и не требует опций.
	const descriptor = referenceStoredFile(manifestDigest, fileKey, manifest);

	assert.equal(descriptor.manifestDigest, manifestDigest, "ссылка на ТОТ ЖЕ блоб — не новый digest");
	assert.equal(descriptor.type, "file");
	assert.equal(descriptor.mime, "application/pdf");
	assert.equal(descriptor.name, "shared.pdf");
	assert.equal(descriptor.size, original.length);

	// Дескриптор должен быть РАБОЧИМ — получатель реально расшифровывает тем же путём.
	const downloaded = await downloadMessageAttachment(descriptor, { serverUrl: "https://blossom.test", fetchImpl });
	assert.deepEqual(downloaded, original);
});

// MEDIA-PERF-TZ-5.md §3 — превью/постер, отдельный putStream. Тесты ниже
// используют options.generatePreview (DI-точка в attachments.js::withPreview) —
// не настоящий createImageBitmap/OffscreenCanvas (их нет в node --test, тот
// же класс ограничения, что thumbnails.js/raster-image.js, живая проверка
// вместо unit на сам рендеринг превью).

test("uploadMessageAttachment: без previewDigest в результате generatePreview — дескриптор БЕЗ previewDigest (старый путь)", async () => {
	const { fetchImpl } = makeFakeBlossom();
	const original = new TextEncoder().encode("документ без превью");
	const descriptor = await uploadMessageAttachment(
		"https://blossom.test",
		original,
		{ mime: "application/pdf", name: "doc.pdf" },
		ALICE_PRIV,
		{ fetchImpl, generatePreview: async () => null },
	);
	assert.equal(descriptor.previewDigest, undefined);
	assert.equal(descriptor.previewKey, undefined);
});

test("uploadMessageAttachment: с превью — дескриптор получает previewDigest/previewKey, ОТДЕЛЬНЫЙ blob (не совпадает с manifestDigest)", async () => {
	const { fetchImpl, store } = makeFakeBlossom();
	const original = new TextEncoder().encode("картинка (условно) с превью");
	const previewBytes = new Uint8Array([1, 2, 3, 4, 5]);
	const descriptor = await uploadMessageAttachment(
		"https://blossom.test",
		original,
		{ mime: "image/jpeg", name: "photo.jpg" },
		ALICE_PRIV,
		{ fetchImpl, generatePreview: async () => ({ bytes: previewBytes, mime: "image/jpeg", width: 200, height: 150 }) },
	);
	assert.equal(typeof descriptor.previewDigest, "string");
	assert.notEqual(descriptor.previewDigest, descriptor.manifestDigest, "превью — отдельный blob, не оригинал");
	assert.doesNotThrow(() => atob(descriptor.previewKey));
	assert.equal(descriptor.width, 200);
	assert.equal(descriptor.height, 150);

	// Превью реально расшифровывается СВОИМ ключом — не переиспользует fileKey оригинала.
	const { getManifest: gm, getRange } = await import("../src/domain/files/content.js");
	const previewManifest = await gm(descriptor.previewDigest, { serverUrl: "https://blossom.test", fetchImpl });
	const previewKeyBytes = Uint8Array.from(atob(descriptor.previewKey), (c) => c.charCodeAt(0));
	const decrypted = await getRange(previewManifest, previewKeyBytes, 0, previewManifest.size, { serverUrl: "https://blossom.test", fetchImpl });
	assert.deepEqual(decrypted, previewBytes);
	assert.ok(store.size >= 4, "оригинал(2 блоба: манифест+данные) + превью(2 блоба) — минимум 4 записи в хранилище");
});

test("uploadMessageAttachment: video — duration из generatePreview попадает в дескриптор", async () => {
	const { fetchImpl } = makeFakeBlossom();
	const bytes = new Uint8Array([9, 9, 9]);
	const descriptor = await uploadMessageAttachment(
		"https://blossom.test",
		bytes,
		{ mime: "video/mp4", name: "clip.mp4" },
		ALICE_PRIV,
		{ fetchImpl, generatePreview: async () => ({ bytes: new Uint8Array([1]), mime: "image/jpeg", width: 480, height: 270, duration: 12.7 }) },
	);
	assert.equal(descriptor.type, "video");
	assert.equal(descriptor.duration, 12.7);
	assert.equal(descriptor.width, 480);
	assert.equal(descriptor.height, 270);
});

test("uploadMessageAttachment: отказ ГЕНЕРАЦИИ превью (generatePreview бросает) — заливка оригинала всё равно успешна, без previewDigest", async () => {
	const { fetchImpl } = makeFakeBlossom();
	const original = new TextEncoder().encode("оригинал должен выжить при сбое превью");
	const descriptor = await uploadMessageAttachment(
		"https://blossom.test",
		original,
		{ mime: "image/jpeg", name: "photo.jpg" },
		ALICE_PRIV,
		{ fetchImpl, generatePreview: async () => { throw new Error("canvas отказал"); } },
	);
	assert.equal(typeof descriptor.manifestDigest, "string");
	assert.equal(descriptor.previewDigest, undefined);
	const downloaded = await downloadMessageAttachment(descriptor, { serverUrl: "https://blossom.test", fetchImpl });
	assert.deepEqual(downloaded, original);
});

test("uploadMessageAttachment: отказ ЗАЛИВКИ превью (сеть/сервер отклонил PUT превью) — оригинал всё равно успешен, без previewDigest", async () => {
	const { fetchImpl: baseFetch } = makeFakeBlossom();
	let putCount = 0;
	// Заливка оригинала: putStream делает 2 PUT (данные + манифест). Всё, что
	// идёт ПОСЛЕ — заливка превью (тоже 2 PUT) — роняем именно её, имитируя
	// "сеть отвалилась"/"Blossom отклонил файл превью".
	const flakyFetch = async (url, opts = {}) => {
		if (opts.method === "PUT") {
			putCount++;
			if (putCount > 2) throw new Error("сеть отвалилась на заливке превью");
		}
		return baseFetch(url, opts);
	};
	const original = new TextEncoder().encode("оригинал переживает сбой сети на превью");
	const descriptor = await uploadMessageAttachment(
		"https://blossom.test",
		original,
		{ mime: "image/jpeg", name: "photo.jpg" },
		ALICE_PRIV,
		{ fetchImpl: flakyFetch, generatePreview: async () => ({ bytes: new Uint8Array([1, 2, 3]), mime: "image/jpeg" }) },
	);
	assert.equal(typeof descriptor.manifestDigest, "string");
	assert.equal(descriptor.previewDigest, undefined, "заливка превью провалилась — дескриптор остаётся без previewDigest, не бросает наружу");
});

test("uploadMessageAttachment: options.fileKey (оверрайд оригинала) НЕ наследуется превью — свой случайный ключ (иначе пара ключ/nonce на чанк 0 повторилась бы, §9.1)", async () => {
	const { fetchImpl } = makeFakeBlossom();
	const { generateFileKey } = await import("../src/domain/files/crypto.js");
	const overrideKey = generateFileKey();
	const original = new TextEncoder().encode("оригинал под явным fileKey-оверрайдом");
	const descriptor = await uploadMessageAttachment(
		"https://blossom.test",
		original,
		{ mime: "image/jpeg", name: "photo.jpg" },
		ALICE_PRIV,
		{ fetchImpl, fileKey: overrideKey, generatePreview: async () => ({ bytes: new Uint8Array([1, 2, 3]), mime: "image/jpeg" }) },
	);
	assert.equal(descriptor.fileKey, btoa(String.fromCharCode(...overrideKey)), "оригинал реально получил оверрайд");
	assert.notEqual(descriptor.previewKey, descriptor.fileKey, "превью НЕ унаследовало оверрайд-ключ оригинала");
});

test("referenceStoredFile: адверсарная мутация — если бы функция генерировала НОВЫЙ digest вместо переиспользования переданного, это должно быть поймано", async () => {
	const { fetchImpl } = makeFakeBlossom();
	const { putStream } = await import("../src/domain/files/content.js");
	const original = new TextEncoder().encode("контроль дедупликации");
	const { manifestDigest, fileKey, manifest } = await putStream(original, {
		name: "f.txt",
		mime: "text/plain",
		serverUrl: "https://blossom.test",
		privateKey: ALICE_PRIV,
		fetchImpl,
	});

	const descriptor = referenceStoredFile(manifestDigest, fileKey, manifest);
	// Мутация "новый digest вместо переданного" сломала бы это сравнение —
	// подтверждает, что referenceStoredFile буквально прокидывает вход, не
	// перевычисляет и не подменяет значение.
	assert.equal(descriptor.manifestDigest, manifestDigest);
});
