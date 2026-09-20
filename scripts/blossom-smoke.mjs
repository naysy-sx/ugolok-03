#!/usr/bin/env node
// Приёмка Blossom по HTTP (ТЗ-01, шаг 7): годится и для острова, и для чистого
// self-host, и для «до/после» обновления образа. Ничего не оставляет: заливает
// одноразовый блоб под случайным ключом и удаляет его же.
//
//   node scripts/blossom-smoke.mjs https://blossom.test.ugolok.tech
//
// Проверки: /.well-known/health, /stats (значения печатаются — сравнить до/после),
// HEAD /upload с audio/webm (на образе без патча 0003 — 415), PUT, Range → 206
// с верным Content-Range, полное чтение = залитому, CORS-preflight с Range,
// DELETE, повторное чтение → 404. Код выхода 1, если что-то не так.
import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex } from "@noble/hashes/utils.js";
import { uploadBlob, deleteBlob, checkUploadRequirements } from "../src/core/transport/blossom-client.js";

const url = (process.argv[2] ?? "").replace(/\/$/, "");
if (!url) {
	console.error("usage: blossom-smoke.mjs <https://blossom-host>");
	process.exit(2);
}

let failed = 0;
const ok = (name, cond, extra = "") => {
	console.log(`${cond ? "ok  " : "FAIL"} ${name}${extra ? " — " + extra : ""}`);
	if (!cond) failed++;
};

const priv = crypto.getRandomValues(new Uint8Array(32));
const SIZE = 300_000;
const body = new Uint8Array(SIZE);
for (let i = 0; i < SIZE; i += 60_000) body.set(crypto.getRandomValues(new Uint8Array(60_000)), i);
const hash = bytesToHex(sha256(body));

const health = await fetch(`${url}/.well-known/health`).catch(() => null);
ok("health", health?.status === 200, `status ${health?.status}`);

const statsBefore = await (await fetch(`${url}/stats`)).text();
console.log("stats до :", statsBefore);

const head = await checkUploadRequirements(url, { sha256Hex: hash, mime: "audio/webm", size: SIZE }, priv);
ok("HEAD /upload audio/webm принимается (патч 0003)", head.ok === true && !head.unknown, JSON.stringify(head));

let uploaded = null;
try {
	uploaded = await uploadBlob(url, body, hash, priv);
} catch (e) {
	ok("PUT /upload", false, String(e.message).slice(0, 120));
}
if (uploaded) {
	ok("PUT /upload", uploaded.sha256 === hash && uploaded.size === SIZE);

	const r = await fetch(`${url}/${hash}`, { headers: { Range: "bytes=1000-1999" } });
	const part = new Uint8Array(await r.arrayBuffer());
	ok("Range → 206", r.status === 206, `status ${r.status}`);
	ok("Content-Range", r.headers.get("content-range") === `bytes 1000-1999/${SIZE}`, r.headers.get("content-range") ?? "нет");
	ok("Range: верные байты", part.length === 1000 && part.every((b, i) => b === body[1000 + i]));

	const full = new Uint8Array(await (await fetch(`${url}/${hash}`)).arrayBuffer());
	ok("полное чтение = залитому", bytesToHex(sha256(full)) === hash);

	const pf = await fetch(`${url}/upload`, {
		method: "OPTIONS",
		headers: { Origin: "https://example.test", "Access-Control-Request-Method": "PUT", "Access-Control-Request-Headers": "authorization,range" },
	});
	const allow = (pf.headers.get("access-control-allow-headers") ?? "").toLowerCase();
	ok("CORS preflight разрешает Range", pf.status < 300 && allow.includes("range"), allow || `status ${pf.status}`);

	try {
		await deleteBlob(url, hash, priv);
		const gone = await fetch(`${url}/${hash}`);
		ok("DELETE, затем 404", gone.status === 404, `status ${gone.status}`);
	} catch (e) {
		ok("DELETE", false, String(e.message).slice(0, 120));
	}
}

console.log("stats после:", await (await fetch(`${url}/stats`)).text());
console.log(failed ? `\n${failed} проверок не прошло` : "\nвсе проверки прошли");
process.exit(failed ? 1 : 0);
