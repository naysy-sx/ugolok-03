import { test } from "node:test";
import assert from "node:assert/strict";
import { concatBytes } from "@noble/hashes/utils.js";
import { putStream, getRange } from "../src/domain/files/content.js";
import { createChunkCache } from "../src/domain/files/chunk-cache.js";
import { createPlayerSession } from "../src/domain/files/player-session.js";

const ALICE_PRIV = new Uint8Array(32).fill(1);

// Тот же фейковый Blossom, что files-content.test.js (продублирован намеренно —
// player-session.test.js не должен зависеть от порядка запуска/внутренностей
// соседнего файла теста, только от публичного content.js).
function makeFakeBlossom() {
	const store = new Map();
	let getCalls = 0;

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
		getCalls++;
		const parts = url.split("/");
		const sha256HexKey = parts[parts.length - 1];
		const bytes = store.get(sha256HexKey);
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

	return { fetchImpl, store, getCalls: () => getCalls };
}

async function setupFile(fetchImpl, size, chunkSize) {
	const original = new Uint8Array(size);
	crypto.getRandomValues(original);
	const { manifest, fileKey } = await putStream(original, {
		name: "video.bin",
		mime: "video/mp4",
		chunkSize,
		serverUrl: "https://blossom.test",
		privateKey: ALICE_PRIV,
		fetchImpl,
	});
	return { original, manifest, fileKey };
}

test("readRange: побитово совпадает с прямым content.getRange на тех же входах", async () => {
	const blossom = makeFakeBlossom();
	const { original, manifest, fileKey } = await setupFile(blossom.fetchImpl, 3000, 300);

	const expected = await getRange(manifest, fileKey, 500, 900, { serverUrl: "https://blossom.test", fetchImpl: blossom.fetchImpl });

	const session = createPlayerSession({ manifest, fileKey, serverUrl: "https://blossom.test", cache: createChunkCache(10_000_000), fetchImpl: blossom.fetchImpl });
	const got = await session.readRange(500, 900);
	assert.deepEqual(got, expected);
	assert.deepEqual(got, original.subarray(500, 900));
});

test("readRange: повторный запрос ТОГО ЖЕ диапазона не бьёт в сеть повторно (кэш-попадание)", async () => {
	const blossom = makeFakeBlossom();
	const { manifest, fileKey } = await setupFile(blossom.fetchImpl, 2000, 256);
	const session = createPlayerSession({ manifest, fileKey, serverUrl: "https://blossom.test", cache: createChunkCache(10_000_000), fetchImpl: blossom.fetchImpl });

	await session.readRange(100, 300);
	const callsAfterFirst = blossom.getCalls();
	await new Promise((r) => setTimeout(r, 10)); // дать фоновому prefetch (если есть) устояться
	const callsAfterPrefetchSettle = blossom.getCalls();

	await session.readRange(100, 300); // тот же диапазон — оба чанка уже в кэше
	assert.equal(blossom.getCalls(), callsAfterPrefetchSettle, "повторный readRange не должен вызывать сеть — все нужные чанки уже в кэше");
	assert.ok(callsAfterFirst >= 1);
});

test("упреждающая подкачка: следующий чанк оказывается в кэше ПОСЛЕ разрешения readRange, не блокируя его", async () => {
	const blossom = makeFakeBlossom();
	const { manifest, fileKey } = await setupFile(blossom.fetchImpl, 3000, 256); // несколько чанков
	const cache = createChunkCache(10_000_000);
	const namespace = manifest.blobSha256;

	const session = createPlayerSession({ manifest, fileKey, serverUrl: "https://blossom.test", cache, fetchImpl: blossom.fetchImpl });

	// Первый чанк [0,256) — lastIdx=0, readRange не должен ждать prefetch чанка 1.
	const readPromise = session.readRange(0, 100);
	// Сразу после (до микротаска сети) чанк 1 ещё не обязан быть в кэше —
	// проверяем именно "не блокирует", не "мгновенно готово".
	assert.equal(cache.get(`${namespace}:1`), undefined, "readRange не должен синхронно ждать завершения prefetch");
	await readPromise;

	await new Promise((r) => setTimeout(r, 20)); // дать фоновому prefetch (fire-and-forget) осесть
	assert.notEqual(cache.get(`${namespace}:1`), undefined, "чанк 1 должен оказаться в кэше после того, как prefetch устоялся");

	// Диапазон, целиком лежащий в уже прогретом чанке 1, не должен запросить
	// СЕТЕВОЙ диапазон именно чанка 1 (bytes=272-543, cipherChunkOffset(1,256)).
	// readRange САМ каскадно запускает fire-and-forget prefetch следующего
	// чанка (bytes=544-815) — это ожидаемо и не повод для провала теста,
	// поэтому проверяем конкретный Range, не сам факт вызова fetchImpl.
	const chunk1RangeRequested = { value: false };
	const spyFetch = async (url, opts = {}) => {
		if (opts.headers?.Range === "bytes=272-543") chunk1RangeRequested.value = true;
		return blossom.fetchImpl(url, opts);
	};
	const before = cache.get(`${namespace}:1`);
	const sessionSpy = createPlayerSession({ manifest, fileKey, serverUrl: "https://blossom.test", cache, fetchImpl: spyFetch });
	await sessionSpy.readRange(256, 300);
	assert.equal(chunk1RangeRequested.value, false, "чтение уже прогретого чанка 1 не должно запрашивать его диапазон по сети повторно");
	assert.notEqual(before, undefined);
});

// Этап F, F3 (DESIGN.md "Этап F, F3") — чанк 0 закреплён (pin), переживает
// вытеснение, даже когда суммарный объём последующих чанков превышает бюджет.
test("чанк 0 остаётся в кэше после загрузки многих последующих чанков, суммарно превышающих бюджет", async () => {
	const blossom = makeFakeBlossom();
	const { manifest, fileKey } = await setupFile(blossom.fetchImpl, 5000, 256); // ~20 чанков по 256 байт
	const cache = createChunkCache(700); // бюджет ~2.7 чанка — заведомо мал для всех
	const namespace = manifest.blobSha256;
	const session = createPlayerSession({ manifest, fileKey, serverUrl: "https://blossom.test", cache, fetchImpl: blossom.fetchImpl });

	await session.readRange(0, 100); // прогревает чанк 0 (закрепляется)
	// Читаем много последующих чанков подряд — суммарно СИЛЬНО больше бюджета.
	for (let offset = 300; offset < 4800; offset += 256) {
		await session.readRange(offset, offset + 50);
	}

	assert.notEqual(cache.get(`${namespace}:0`), undefined, "чанк 0 закреплён — не вытесняется, сколько бы чанков ни загрузилось после");
	// Обычный (не нулевой) чанк с той же дистанции давно вытеснен — бюджет
	// не резиновый, закрепление касается ТОЛЬКО индекса 0.
	assert.equal(cache.get(`${namespace}:1`), undefined, "обычный чанк 1 вытеснен — закрепление не распространяется на него");
});

// MEDIA-PERF-TZ.md §5.4 — было: for+await, максимум ОДИН чанк "в полёте"
// одновременно внутри readRange. После §5.1 (mapPool, как content.js::getRange)
// окно из нескольких чанков должно реально пересекаться по времени.
test("readRange: окно из 8 чанков — максимум одновременных сетевых запросов > 1 (было: строго 1, последовательно)", async () => {
	const blossom = makeFakeBlossom();
	const { manifest, fileKey } = await setupFile(blossom.fetchImpl, 8 * 256, 256); // ровно 8 чанков

	let inFlight = 0;
	let maxInFlight = 0;
	const spyFetch = async (...args) => {
		inFlight++;
		maxInFlight = Math.max(maxInFlight, inFlight);
		await new Promise((r) => setTimeout(r, 3)); // имитация сетевой задержки — без неё гонка не успевает пересечься
		inFlight--;
		return blossom.fetchImpl(...args);
	};

	const session = createPlayerSession({ manifest, fileKey, serverUrl: "https://blossom.test", cache: createChunkCache(10_000_000), fetchImpl: spyFetch });
	await session.readRange(0, 8 * 256);

	assert.ok(maxInFlight > 1, `максимум одновременных запросов должен быть больше 1, получили ${maxInFlight}`);
});

// MEDIA-PERF-TZ-5.md §4 — streamRange: тот же диапазон/геометрия, что readRange,
// но байты уходят в sink по мере готовности, строго по порядку (seq 0..N-1
// В ОКНЕ, не индекс чанка манифеста).

function chunkIndexFromRange(rangeHeader, chunkSize) {
	const m = /bytes=(\d+)-/.exec(rangeHeader);
	return Math.round(Number(m[1]) / (chunkSize + 16)); // +16 — AEAD_TAG_BYTES, cipherChunkOffset
}

test("streamRange: чанки разрешились ВРАЗНОБОЙ (2 раньше 0 и 1) — sink.chunk всё равно получает их СТРОГО по порядку 0,1,2", async () => {
	const blossom = makeFakeBlossom();
	const chunkSize = 256;
	const { manifest, fileKey } = await setupFile(blossom.fetchImpl, 3 * chunkSize, chunkSize); // ровно 3 чанка

	const delays = { 0: 30, 1: 15, 2: 0 }; // чанк 2 приходит первым, 0 — последним
	const delayedFetch = async (url, opts = {}) => {
		if (opts.headers?.Range) {
			await new Promise((r) => setTimeout(r, delays[chunkIndexFromRange(opts.headers.Range, chunkSize)] ?? 0));
		}
		return blossom.fetchImpl(url, opts);
	};

	const session = createPlayerSession({ manifest, fileKey, serverUrl: "https://blossom.test", cache: createChunkCache(10_000_000), fetchImpl: delayedFetch });

	const receivedSeq = [];
	let ended = false;
	await session.streamRange(0, 3 * chunkSize, {
		chunk: (seq) => receivedSeq.push(seq),
		end: () => {
			ended = true;
		},
		error: (err) => {
			throw err;
		},
	});

	assert.deepEqual(receivedSeq, [0, 1, 2], "порядок доставки в sink — по seq, независимо от порядка сетевого разрешения");
	assert.equal(ended, true);
});

test("streamRange: байты (после skipHead/skipTail per-чанк) побитово совпадают с original на разных диапазонах, включая границы", async () => {
	const blossom = makeFakeBlossom();
	const chunkSize = 300;
	// size НЕ кратен chunkSize — последний чанк частичный (50 байт), проверяет
	// "последнее окно файла" в том же проходе.
	const { original, manifest, fileKey } = await setupFile(blossom.fetchImpl, 3050, chunkSize);
	const session = createPlayerSession({ manifest, fileKey, serverUrl: "https://blossom.test", cache: createChunkCache(10_000_000), fetchImpl: blossom.fetchImpl });

	const cases = [
		[500, 900, "посреди чанков с обеих сторон"],
		[0, 50, "окно из ОДНОГО чанка, целиком внутри него (весь диапазон < одного chunkSize)"],
		[100, chunkSize, "окно, кончающееся РОВНО на границе чанка (skipTail===0)"],
		[3000, 3050, "последнее окно файла — частичный последний чанк"],
		[0, 3050, "весь файл целиком, через несколько чанков"],
	];

	for (const [start, end, label] of cases) {
		const parts = [];
		let errored = null;
		await session.streamRange(start, end, {
			chunk: (seq, bytes) => parts.push(bytes),
			end: () => {},
			error: (err) => {
				errored = err;
			},
		});
		assert.equal(errored, null, `${label}: не должно быть ошибки`);
		assert.deepEqual(concatBytes(...parts), original.subarray(start, end), label);
	}
});

test("streamRange: отказ на СРЕДНЕМ чанке — sink получает chunk() для уже готовых чанков, error() ПОСЛЕ них, поздние (случайно успешные) чанки после error НЕ доставляются", async () => {
	const blossom = makeFakeBlossom();
	const chunkSize = 256;
	const { manifest, fileKey } = await setupFile(blossom.fetchImpl, 5 * chunkSize, chunkSize); // 5 чанков: 0,1,2,3,4

	// 0,1 — быстро и успешно (успевают дойти до sink ДО отказа). 2 — отказывает
	// быстро (раньше 3,4). 3,4 — успешны, но ПОЗЖЕ отказа — не должны дойти.
	const delays = { 0: 1, 1: 2, 2: 3, 3: 50, 4: 55 };
	const flakyFetch = async (url, opts = {}) => {
		const idx = opts.headers?.Range ? chunkIndexFromRange(opts.headers.Range, chunkSize) : null;
		if (idx !== null) await new Promise((r) => setTimeout(r, delays[idx] ?? 0));
		if (idx === 2) throw new Error("сбой сети на чанке 2 (симуляция)");
		return blossom.fetchImpl(url, opts);
	};

	const session = createPlayerSession({ manifest, fileKey, serverUrl: "https://blossom.test", cache: createChunkCache(10_000_000), fetchImpl: flakyFetch });

	const receivedSeq = [];
	let errorCalls = 0;
	let ended = false;
	await session.streamRange(0, 5 * chunkSize, {
		chunk: (seq) => receivedSeq.push(seq),
		end: () => {
			ended = true;
		},
		error: () => {
			errorCalls++;
		},
	});

	assert.deepEqual(receivedSeq, [0, 1], "чанки, успевшие прийти ДО отказа, доставлены sink'у по порядку");
	assert.equal(errorCalls, 1, "error() вызван ровно один раз");
	assert.equal(ended, false, "end() не должен звучать после error()");

	await new Promise((r) => setTimeout(r, 60)); // дать чанкам 3/4 (заведомо успешным) доразрешиться — не должны ничего добавить
	assert.deepEqual(receivedSeq, [0, 1], "поздние чанки ПОСЛЕ error() не доставляются, даже если их сеть в итоге отвечает успехом");
});

test("ошибка prefetch не пробрасывается наружу и не роняет основной readRange", async () => {
	const blossom = makeFakeBlossom();
	const { manifest, fileKey } = await setupFile(blossom.fetchImpl, 3000, 256);

	// fetchImpl, который рвётся на ЛЮБОМ запросе ПОСЛЕ первого успешного —
	// имитирует сбой сети именно на фоновом prefetch следующего чанка.
	let calls = 0;
	const flakyFetch = async (...args) => {
		calls++;
		if (calls > 1) throw new Error("сеть недоступна (симуляция)");
		return blossom.fetchImpl(...args);
	};

	const session = createPlayerSession({ manifest, fileKey, serverUrl: "https://blossom.test", cache: createChunkCache(10_000_000), fetchImpl: flakyFetch });

	// Основной вызов обязан УСПЕШНО завершиться, даже если фоновый prefetch
	// следующего чанка (уйдёт во ВТОРОЙ вызов flakyFetch и упадёт) — не связан с ним.
	const got = await session.readRange(0, 100);
	assert.ok(got.length === 100);

	await new Promise((r) => setTimeout(r, 20)); // дать упавшему prefetch раствориться, не должно быть unhandledRejection
});
