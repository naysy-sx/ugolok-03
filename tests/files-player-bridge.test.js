import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { putStream } from "../src/domain/files/content.js";
import { registerPlayerFile, unregisterPlayerFile, handleRangeRequest, PLAYER_FIRST_WINDOW_BYTES } from "../src/domain/files/player-bridge.js";
import { nextAdaptiveWindow, PLAYER_MAX_WINDOW_BYTES } from "../src/domain/files/sw-timeout.js";

const ALICE_PRIV = new Uint8Array(32).fill(1);

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
		const key = parts[parts.length - 1];
		const bytes = store.get(key);
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
	return { fetchImpl };
}

function fillRandom(bytes) {
	const MAX_PER_CALL = 65536;
	for (let offset = 0; offset < bytes.length; offset += MAX_PER_CALL) {
		crypto.getRandomValues(bytes.subarray(offset, Math.min(offset + MAX_PER_CALL, bytes.length)));
	}
}

async function setupFile(fetchImpl, size, mime = "video/mp4", chunkSize = 256) {
	const original = new Uint8Array(size);
	fillRandom(original);
	const { manifest, manifestDigest, fileKey } = await putStream(original, {
		name: "clip.bin",
		mime,
		chunkSize,
		serverUrl: "https://blossom.test",
		privateKey: ALICE_PRIV,
		fetchImpl,
	});
	return { original, manifest, manifestDigest, fileKey };
}

beforeEach(() => {
	// player-bridge.js хранит реестр в модульном замыкании — явная очистка
	// между тестами через unregister избегает утечки состояния между ними
	// (сам registry не экспортирован намеренно, инкапсуляция).
});

test("handleRangeRequest: незарегистрированный digest -> unknown-digest", async () => {
	const res = await handleRangeRequest({ manifestDigest: "нет-такого-файла", start: 0, end: 10 });
	assert.equal(res.ok, false);
	assert.equal(res.error, "unknown-digest");
});

test("registerPlayerFile/handleRangeRequest: round-trip, байты совпадают с оригиналом (диапазон ВКЛЮЧИТЕЛЬНЫЙ, как HTTP Range)", async () => {
	const { fetchImpl } = makeFakeBlossom();
	const { original, manifest, manifestDigest, fileKey } = await setupFile(fetchImpl, 2000);

	registerPlayerFile(manifestDigest, { manifest, fileKey, serverUrl: "https://blossom.test", fetchImpl });
	const res = await handleRangeRequest({ manifestDigest, start: 100, end: 199 }); // включительно -> 100 байт
	assert.equal(res.ok, true);
	assert.equal(res.bytes.length, 100);
	assert.deepEqual(res.bytes, original.subarray(100, 200));
	assert.equal(res.mime, "video/mp4");
	assert.equal(res.size, 2000);

	unregisterPlayerFile(manifestDigest);
});

test("unregisterPlayerFile: после снятия регистрации запрос снова unknown-digest", async () => {
	const { fetchImpl } = makeFakeBlossom();
	const { manifest, manifestDigest, fileKey } = await setupFile(fetchImpl, 500);
	registerPlayerFile(manifestDigest, { manifest, fileKey, serverUrl: "https://blossom.test", fetchImpl });
	unregisterPlayerFile(manifestDigest);

	const res = await handleRangeRequest({ manifestDigest, start: 0, end: 10 });
	assert.equal(res.ok, false);
	assert.equal(res.error, "unknown-digest");
});

test("handleRangeRequest: границы диапазона — отрицательный start, end за пределами size, start>end -> range-out-of-bounds", async () => {
	const { fetchImpl } = makeFakeBlossom();
	const { manifest, manifestDigest, fileKey } = await setupFile(fetchImpl, 1000);
	registerPlayerFile(manifestDigest, { manifest, fileKey, serverUrl: "https://blossom.test", fetchImpl });

	assert.equal((await handleRangeRequest({ manifestDigest, start: -5, end: 10 })).error, "range-out-of-bounds");
	assert.equal((await handleRangeRequest({ manifestDigest, start: 0, end: 1000 })).error, "range-out-of-bounds"); // size=1000, индексы 0..999
	assert.equal((await handleRangeRequest({ manifestDigest, start: 50, end: 10 })).error, "range-out-of-bounds");

	unregisterPlayerFile(manifestDigest);
});

test("handleRangeRequest: открытый диапазон (end=null, 'bytes=X-' без верхней границы) разрешается в конец файла", async () => {
	const { fetchImpl } = makeFakeBlossom();
	const { original, manifest, manifestDigest, fileKey } = await setupFile(fetchImpl, 500);
	registerPlayerFile(manifestDigest, { manifest, fileKey, serverUrl: "https://blossom.test", fetchImpl });

	const res = await handleRangeRequest({ manifestDigest, start: 450, end: null });
	assert.equal(res.ok, true);
	assert.deepEqual(res.bytes, original.subarray(450, 500));
	assert.equal(res.size, 500);

	unregisterPlayerFile(manifestDigest);
});

test("handleRangeRequest: открытый диапазон на большом файле НЕ разворачивается в весь файл — окно PLAYER_FIRST_WINDOW_BYTES (регрессия S4/S5)", async () => {
	const { fetchImpl } = makeFakeBlossom();
	const size = PLAYER_FIRST_WINDOW_BYTES * 4; // заведомо больше окна
	const { original, manifest, manifestDigest, fileKey } = await setupFile(fetchImpl, size, "video/mp4", 65536);
	registerPlayerFile(manifestDigest, { manifest, fileKey, serverUrl: "https://blossom.test", fetchImpl });

	const res = await handleRangeRequest({ manifestDigest, start: 0, end: null });
	assert.equal(res.ok, true);
	assert.equal(res.bytes.length, PLAYER_FIRST_WINDOW_BYTES, "открытый диапазон обязан вернуть РОВНО окно, не весь файл");
	assert.deepEqual(res.bytes, original.subarray(0, PLAYER_FIRST_WINDOW_BYTES));
	assert.equal(res.size, size, "Content-Range обязан отражать ПОЛНЫЙ размер файла, даже если вернули только окно");

	unregisterPlayerFile(manifestDigest);
});

test("два одновременно зарегистрированных файла не пересекаются (изоляция по digest)", async () => {
	const { fetchImpl } = makeFakeBlossom();
	const fileA = await setupFile(fetchImpl, 800, "video/mp4");
	const fileB = await setupFile(fetchImpl, 900, "audio/mpeg");
	registerPlayerFile(fileA.manifestDigest, { manifest: fileA.manifest, fileKey: fileA.fileKey, serverUrl: "https://blossom.test", fetchImpl });
	registerPlayerFile(fileB.manifestDigest, { manifest: fileB.manifest, fileKey: fileB.fileKey, serverUrl: "https://blossom.test", fetchImpl });

	const resA = await handleRangeRequest({ manifestDigest: fileA.manifestDigest, start: 0, end: 49 });
	const resB = await handleRangeRequest({ manifestDigest: fileB.manifestDigest, start: 0, end: 49 });
	assert.deepEqual(resA.bytes, fileA.original.subarray(0, 50));
	assert.deepEqual(resB.bytes, fileB.original.subarray(0, 50));
	assert.equal(resA.mime, "video/mp4");
	assert.equal(resB.mime, "audio/mpeg");

	unregisterPlayerFile(fileA.manifestDigest);
	unregisterPlayerFile(fileB.manifestDigest);
});

// MEDIA-PERF-TZ.md §5.2 — было: 2.5 МиБ ОБЩИЙ бюджет на все открытые файлы
// разом; два одновременно открытых файла (например, миниатюра в очереди +
// открытый оверлей) вытесняли друг друга по кругу. Теперь бюджет растёт с
// registry.size (budgetFor) — два файла по ~2 МБ каждый (4 МБ суммарно)
// должны комфортно сосуществовать при 2 открытых файлах (2×6=12 МиБ бюджет),
// хотя старого фиксированного 2.5 МиБ на оба разом было бы мало.
test("два одновременно открытых файла по ~2 МБ не вытесняют друг друга (бюджет растёт с числом открытых файлов)", async () => {
	const { fetchImpl } = makeFakeBlossom();
	const fileA = await setupFile(fetchImpl, 2_000_000, "video/mp4", 65536);
	const fileB = await setupFile(fetchImpl, 2_000_000, "audio/mpeg", 65536);

	registerPlayerFile(fileA.manifestDigest, { manifest: fileA.manifest, fileKey: fileA.fileKey, serverUrl: "https://blossom.test", fetchImpl });
	registerPlayerFile(fileB.manifestDigest, { manifest: fileB.manifest, fileKey: fileB.fileKey, serverUrl: "https://blossom.test", fetchImpl });

	// Прогреваем ПОЧТИ весь файл A через последовательные окна.
	for (let start = 0; start < fileA.original.length; start += PLAYER_FIRST_WINDOW_BYTES) {
		await handleRangeRequest({ manifestDigest: fileA.manifestDigest, start, end: null });
	}
	// Прогреваем ПОЧТИ весь файл B — под старым фиксированным общим бюджетом
	// это вытеснило бы большую часть A.
	for (let start = 0; start < fileB.original.length; start += PLAYER_FIRST_WINDOW_BYTES) {
		await handleRangeRequest({ manifestDigest: fileB.manifestDigest, start, end: null });
	}

	// Считаем сетевые GET на повторное чтение НАЧАЛА файла A (чанк 0 — pinned,
	// уже гарантированно жив; проверяем СЕРЕДИНУ, которая pin не покрывает).
	let getCalls = 0;
	const countingFetch = async (url, opts = {}) => {
		if (!opts.method || opts.method === "GET") getCalls++;
		return fetchImpl(url, opts);
	};
	registerPlayerFile(fileA.manifestDigest, { manifest: fileA.manifest, fileKey: fileA.fileKey, serverUrl: "https://blossom.test", fetchImpl: countingFetch });
	const midStart = Math.floor(fileA.original.length / 2);
	await handleRangeRequest({ manifestDigest: fileA.manifestDigest, start: midStart, end: midStart + 99 });
	assert.equal(getCalls, 0, "середина файла A должна остаться в кэше — два файла по 2 МБ помещаются в бюджет на 2 открытых файла");

	unregisterPlayerFile(fileA.manifestDigest);
	unregisterPlayerFile(fileB.manifestDigest);
});

// MEDIA-PERF-TZ.md §5.3/§5.4 — service-worker.js сам не тестируется node --test
// (self/caches/clients — браузерные API), но его роль ("на каждый ОТКРЫТЫЙ
// диапазон вычислить конкретный end через nextAdaptiveWindow и передать сюда")
// воспроизводима: этот тест играет роль SW вручную — прогоняет
// nextAdaptiveWindow ТОЧНО как это делает handleFilesContentFetch, и кормит
// результат в handleRangeRequest (player-bridge.js), проверяя итоговые байты.
test("адаптивное окно: последовательные открытые запросы растут 512К -> 1М -> 2М -> 4М (потолок), байты корректны на каждом шаге", async () => {
	const { fetchImpl } = makeFakeBlossom();
	const size = PLAYER_MAX_WINDOW_BYTES * 3; // с запасом на несколько шагов после потолка
	const { original, manifest, manifestDigest, fileKey } = await setupFile(fetchImpl, size, "video/mp4", 65536);
	registerPlayerFile(manifestDigest, { manifest, fileKey, serverUrl: "https://blossom.test", fetchImpl });

	let swState; // то, что в service-worker.js — windowState.get(manifestDigest)
	let start = 0;
	const windows = [];
	for (let step = 0; step < 6; step++) {
		const { windowBytes } = nextAdaptiveWindow(swState, start);
		windows.push(windowBytes);
		const end = Math.min(size - 1, start + windowBytes - 1);
		const res = await handleRangeRequest({ manifestDigest, start, end });
		assert.equal(res.ok, true);
		assert.deepEqual(res.bytes, original.subarray(start, end + 1), `шаг ${step}: байты должны совпасть с оригиналом`);
		swState = { lastEnd: start + res.bytes.length - 1, windowBytes: Math.max(PLAYER_FIRST_WINDOW_BYTES, res.bytes.length) };
		start = swState.lastEnd + 1;
	}

	assert.deepEqual(windows, [
		PLAYER_FIRST_WINDOW_BYTES,
		PLAYER_FIRST_WINDOW_BYTES * 2,
		PLAYER_FIRST_WINDOW_BYTES * 4,
		PLAYER_MAX_WINDOW_BYTES,
		PLAYER_MAX_WINDOW_BYTES,
		PLAYER_MAX_WINDOW_BYTES,
	]);

	unregisterPlayerFile(manifestDigest);
});

test("адаптивное окно: перемотка (start НЕ продолжает предыдущий end) сбрасывает окно в базовое", async () => {
	const { fetchImpl } = makeFakeBlossom();
	const size = PLAYER_MAX_WINDOW_BYTES * 2;
	const { original, manifest, manifestDigest, fileKey } = await setupFile(fetchImpl, size, "video/mp4", 65536);
	registerPlayerFile(manifestDigest, { manifest, fileKey, serverUrl: "https://blossom.test", fetchImpl });

	// Разгоняем окно до потолка.
	let swState;
	let start = 0;
	for (let step = 0; step < 4; step++) {
		const { windowBytes } = nextAdaptiveWindow(swState, start);
		const end = Math.min(size - 1, start + windowBytes - 1);
		const res = await handleRangeRequest({ manifestDigest, start, end });
		swState = { lastEnd: start + res.bytes.length - 1, windowBytes: res.bytes.length };
		start = swState.lastEnd + 1;
	}
	assert.equal(swState.windowBytes, PLAYER_MAX_WINDOW_BYTES, "тестовая предпосылка: окно должно было разогнаться до потолка");

	// Перемотка в начало файла — start=0 НЕ продолжает разогнанный swState.lastEnd.
	const { windowBytes: afterSeek, sequential } = nextAdaptiveWindow(swState, 0);
	assert.equal(sequential, false);
	assert.equal(afterSeek, PLAYER_FIRST_WINDOW_BYTES, "перемотка не наследует раздутое окно — иначе маленький сбойный диапазон ждал бы таймаут окна 4 МиБ");

	unregisterPlayerFile(manifestDigest);
});

// MEDIA-PERF-TZ-4.md §5 — onChunkArrived пробрасывается в session.readRange,
// зовётся по разу на каждый реально пришедший чанк окна (startPlayerBridge
// использует это, чтобы слать SW "range-progress" раньше финального ответа).
test("handleRangeRequest: onChunkArrived зовётся один раз НА КАЖДЫЙ чанк окна", async () => {
	const { fetchImpl } = makeFakeBlossom();
	const { manifest, manifestDigest, fileKey } = await setupFile(fetchImpl, 8 * 64 * 1024, "video/mp4", 65536); // 8 чанков
	registerPlayerFile(manifestDigest, { manifest, fileKey, serverUrl: "https://blossom.test", fetchImpl });

	let arrivedCount = 0;
	const res = await handleRangeRequest({
		manifestDigest,
		start: 0,
		end: 8 * 65536 - 1,
		onChunkArrived: () => arrivedCount++,
	});
	assert.equal(res.ok, true);
	assert.equal(arrivedCount, 8, "по разу на каждый из 8 чанков окна");

	unregisterPlayerFile(manifestDigest);
});

test("handleRangeRequest: без onChunkArrived — ничего не падает (необязательный параметр)", async () => {
	const { fetchImpl } = makeFakeBlossom();
	const { manifest, manifestDigest, fileKey } = await setupFile(fetchImpl, 500);
	registerPlayerFile(manifestDigest, { manifest, fileKey, serverUrl: "https://blossom.test", fetchImpl });
	const res = await handleRangeRequest({ manifestDigest, start: 0, end: 10 });
	assert.equal(res.ok, true);
	unregisterPlayerFile(manifestDigest);
});

test("handleRangeRequest: сбой расшифровки/сети -> ok:false, decrypt-failed, не бросает исключение наружу", async () => {
	const { fetchImpl } = makeFakeBlossom();
	const { manifest, manifestDigest } = await setupFile(fetchImpl, 500);
	const wrongKey = new Uint8Array(32).fill(9); // заведомо не тот fileKey
	registerPlayerFile(manifestDigest, { manifest, fileKey: wrongKey, serverUrl: "https://blossom.test", fetchImpl });

	const res = await handleRangeRequest({ manifestDigest, start: 0, end: 10 });
	assert.equal(res.ok, false);
	assert.equal(res.error, "decrypt-failed");

	unregisterPlayerFile(manifestDigest);
});
