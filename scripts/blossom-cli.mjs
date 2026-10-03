#!/usr/bin/env node
// Подписанные операции с Blossom из командной строки (для приёмочных скриптов).
// Ключ владельца — BLOSSOM_KEY (64 hex); без него берётся случайный на процесс.
//   put    <url> <bytes> <seed>        залить детерминированный блоб → печатает hash
//   del    <url> <hash>                удалить
//   verify <url> <hash> <bytes> <seed> [a-b]   прочитать (целиком или Range) и сверить с эталоном
import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex, hexToBytes } from "@noble/hashes/utils.js";
import { uploadBlob, deleteBlob } from "../src/core/transport/blossom-client.js";

const [cmd, url, ...rest] = process.argv.slice(2);
const priv = process.env.BLOSSOM_KEY ? hexToBytes(process.env.BLOSSOM_KEY) : crypto.getRandomValues(new Uint8Array(32));

// Детерминированный «шифротекст»: sha256-цепочка от seed, 32 байта за шаг.
function payload(n, seed) {
	const out = new Uint8Array(n);
	let block = sha256(new TextEncoder().encode("seed:" + seed));
	for (let i = 0; i < n; i += 32) {
		out.set(block.subarray(0, Math.min(32, n - i)), i);
		block = sha256(block);
	}
	return out;
}

if (cmd === "put") {
	const [bytes, seed] = rest;
	const body = payload(Number(bytes), seed);
	const hash = bytesToHex(sha256(body));
	await uploadBlob(url, body, hash, priv, { timeoutMs: 600_000 });
	console.log(hash);
} else if (cmd === "del") {
	await deleteBlob(url, rest[0], priv);
	console.log("deleted", rest[0]);
} else if (cmd === "verify") {
	const [hash, bytes, seed, range] = rest;
	const expect = payload(Number(bytes), seed);
	let a = 0, b = expect.length - 1;
	const headers = {};
	if (range) {
		[a, b] = range.split("-").map(Number);
		headers.Range = `bytes=${a}-${b}`;
	}
	const r = await fetch(`${url}/${hash}`, { headers });
	const want = range ? 206 : 200;
	if (r.status !== want) {
		console.log(`FAIL status ${r.status}, ожидался ${want}`);
		process.exit(1);
	}
	const got = new Uint8Array(await r.arrayBuffer());
	const exp = expect.subarray(a, b + 1);
	const same = got.length === exp.length && bytesToHex(sha256(got)) === bytesToHex(sha256(exp));
	console.log(same ? `ok ${r.status} ${got.length} B` : `FAIL содержимое (${got.length} B)`);
	process.exit(same ? 0 : 1);
} else {
	console.error("usage: blossom-cli.mjs put|del|verify <url> ...");
	process.exit(2);
}
