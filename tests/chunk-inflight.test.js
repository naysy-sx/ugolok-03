import { test } from "node:test";
import assert from "node:assert/strict";
import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex } from "@noble/hashes/utils.js";
import { generateFileKey } from "../src/domain/files/crypto.js";
import { putStream, getChunk } from "../src/domain/files/content.js";

// MEDIA-PERF-TZ-6.md §6: реестр чанков «в полёте». Свой fetchImpl, без сети.

const ALICE_PRIV = new Uint8Array(32).fill(1);
const SERVER = "https://blossom.test";
const CHUNK = 256;

// Фейковый Blossom: PUT кладёт по sha256 тела, GET с Range отдаёт срез.
// gate() — необязательная задержка ответа на Range-GET, чтобы вызовы
// действительно пересеклись во времени; fail — очередь отказов.
function makeBlossom() {
	const store = new Map();
	const state = { rangeGets: 0, gate: null, failNext: 0 };
	const fetchImpl = async (url, opts = {}) => {
		if (opts.method === "PUT") {
			const body = new Uint8Array(opts.body);
			const digest = bytesToHex(sha256(body));
			store.set(digest, body);
			return { ok: true, status: 200, json: async () => ({ sha256: digest, size: body.length }), text: async () => "" };
		}
		if (opts.headers?.Range) {
			state.rangeGets++;
			if (state.gate) await state.gate;
			if (state.failNext > 0) {
				state.failNext--;
				throw new TypeError("network down");
			}
			const bytes = store.get(url.split("/").pop());
			const [, s, e] = /bytes=(\d+)-(\d+)/.exec(opts.headers.Range);
			const slice = bytes.subarray(Number(s), Number(e) + 1);
			return { ok: true, status: 206, arrayBuffer: async () => slice.buffer.slice(slice.byteOffset, slice.byteOffset + slice.byteLength) };
		}
		return { ok: false, status: 404, text: async () => "not found" };
	};
	return { fetchImpl, state };
}

async function uploadRandom(blossom, size = 700) {
	const original = new Uint8Array(size);
	crypto.getRandomValues(original); // случайный блоб => ключ реестра/кэша уникален для теста
	const { manifest, fileKey } = await putStream(original, {
		name: "x",
		mime: "application/octet-stream",
		chunkSize: CHUNK,
		serverUrl: SERVER,
		privateKey: ALICE_PRIV,
		fetchImpl: blossom.fetchImpl,
	});
	return { original, manifest, fileKey };
}

function deferred() {
	let resolve;
	const promise = new Promise((r) => (resolve = r));
	return { promise, resolve };
}

test("N одновременных getChunk одного чанка → один сетевой запрос, у всех одинаковые байты", async () => {
	const blossom = makeBlossom();
	const { original, manifest, fileKey } = await uploadRandom(blossom);
	const gate = deferred();
	blossom.state.gate = gate.promise;
	const counts = {};
	const trace = { mark() {}, count: (k, n = 1) => (counts[k] = (counts[k] ?? 0) + n) };

	const calls = Array.from({ length: 5 }, () => getChunk(manifest, fileKey, 1, { serverUrl: SERVER, fetchImpl: blossom.fetchImpl, trace }));
	gate.resolve();
	const results = await Promise.all(calls);

	assert.equal(blossom.state.rangeGets, 1);
	for (const r of results) assert.deepEqual(r, original.subarray(CHUNK, CHUNK * 2));
	assert.equal(counts.requests, 1, "requests — только у владельца запроса");
	assert.equal(counts.dedup, 4, "остальные четверо помечены dedup");
});

test("отказ сети → все ожидающие получают ошибку, следующий вызов снова идёт в сеть", async () => {
	const blossom = makeBlossom();
	const { original, manifest, fileKey } = await uploadRandom(blossom);
	const gate = deferred();
	blossom.state.gate = gate.promise;
	// Сеть лежит дольше, чем ретраи §5 (withRetry) готовы ждать, — иначе они
	// сами погасят одиночный сбой и до реестра отказ не дойдёт.
	blossom.state.failNext = 1000;
	const opts = { serverUrl: SERVER, fetchImpl: blossom.fetchImpl };

	const calls = [getChunk(manifest, fileKey, 0, opts), getChunk(manifest, fileKey, 0, opts), getChunk(manifest, fileKey, 0, opts)];
	const settled = Promise.allSettled(calls);
	gate.resolve();
	for (const r of await settled) assert.equal(r.status, "rejected");
	const getsAfterFailure = blossom.state.rangeGets;

	blossom.state.gate = null;
	blossom.state.failNext = 0;
	const ok = await getChunk(manifest, fileKey, 0, opts);
	assert.deepEqual(ok, original.subarray(0, CHUNK));
	assert.ok(blossom.state.rangeGets > getsAfterFailure, "отказ не закэширован: повтор сходил в сеть");
});

// В ТЗ этот пункт сформулирован как «два разных fileKey на один блоб → оба
// получают корректный plaintext». Так проверить нельзя: один blobSha256 — это
// один шифротекст, расшифровывающийся ровно одним ключом; перезаливка под
// ключом доли даёт ДРУГОЙ блоб (другой digest), то есть другую запись реестра.
// Поэтому проверяем то, что реестр реально гарантирует: расшифровка остаётся
// за каждым вызывающим — чужой (неверный) ключ ломает только его вызов, а
// правильные вызовы получают каждый свой независимый буфер.
test("расшифровка вне реестра: неверный ключ ломает только свой вызов, буферы независимы", async () => {
	const blossom = makeBlossom();
	const { original, manifest, fileKey } = await uploadRandom(blossom);
	const gate = deferred();
	blossom.state.gate = gate.promise;
	const opts = { serverUrl: SERVER, fetchImpl: blossom.fetchImpl };

	const good1 = getChunk(manifest, fileKey, 0, opts);
	const bad = getChunk(manifest, generateFileKey(), 0, opts);
	const good2 = getChunk(manifest, fileKey, 0, opts);
	const settledBad = Promise.allSettled([bad]);
	gate.resolve();
	const [p1, p2] = await Promise.all([good1, good2]);

	assert.equal(blossom.state.rangeGets, 1);
	assert.equal((await settledBad)[0].status, "rejected");
	assert.deepEqual(p1, original.subarray(0, CHUNK));
	assert.deepEqual(p2, original.subarray(0, CHUNK));
	assert.notEqual(p1.buffer, p2.buffer, "каждый вызывающий владеет своим plaintext");
	p1.fill(0);
	assert.deepEqual(p2, original.subarray(0, CHUNK), "правка одного буфера не задевает другой");
});

test("последовательный повтор после завершения идёт из кэша, реестр кэш не ломает", async () => {
	const blossom = makeBlossom();
	const { original, manifest, fileKey } = await uploadRandom(blossom);
	const opts = { serverUrl: SERVER, fetchImpl: blossom.fetchImpl };

	await getChunk(manifest, fileKey, 2, opts);
	const after = blossom.state.rangeGets;
	const again = await getChunk(manifest, fileKey, 2, opts);
	assert.equal(blossom.state.rangeGets, after);
	assert.deepEqual(again, original.subarray(CHUNK * 2));
});
