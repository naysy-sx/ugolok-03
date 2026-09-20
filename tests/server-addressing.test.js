import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { uploadTarget, readCandidates, registerUserServers, resetUserServers } from "../src/domain/files/servers.js";
import { resetRuntimeConfig, loadRuntimeConfig } from "../src/domain/settings/runtime-config.js";

function walk(dir, out = []) {
	for (const name of readdirSync(dir)) {
		const p = join(dir, name);
		if (statSync(p).isDirectory()) walk(p, out);
		else if (/\.(js|jsx)$/.test(name)) out.push(p);
	}
	return out;
}

test("константа сборки адреса хранилища не упоминается вне servers.js и config.js", () => {
	const allowed = new Set(["src/domain/files/servers.js", "src/config.js"]);
	const offenders = walk("src").filter((p) => !allowed.has(p) && readFileSync(p, "utf8").includes("BUILD_DEFAULT_BLOSSOM_SERVERS"));
	assert.deepEqual(offenders, []);
});

async function withConfig(blossomServers) {
	const fetchImpl = async () => ({ ok: true, json: async () => ({ blossomServers }) });
	await loadRuntimeConfig({ fetchImpl });
}

test("uploadTarget: настройки пользователя перекрывают config.json", async () => {
	resetUserServers();
	await withConfig(["https://cfg.example"]);
	assert.equal(uploadTarget(), "https://cfg.example");
	registerUserServers({ activeUrl: "https://mine.example/", urls: ["https://other.example"] });
	assert.equal(uploadTarget(), "https://mine.example");
	registerUserServers({ activeUrl: null, urls: ["https://other.example"] });
	assert.equal(uploadTarget(), "https://other.example");
	resetUserServers();
	resetRuntimeConfig();
});

test("readCandidates: подсказка, свои, config.json, без повторов", async () => {
	resetUserServers();
	await withConfig(["https://cfg.example", "https://mine.example"]);
	registerUserServers({ activeUrl: "https://mine.example", urls: ["https://mine.example", "https://b.example"] });
	assert.deepEqual(readCandidates(["https://hint.example", "https://b.example/"]).slice(0, 4), [
		"https://hint.example",
		"https://b.example",
		"https://mine.example",
		"https://cfg.example",
	]);
	assert.equal(new Set(readCandidates()).size, readCandidates().length);
	resetUserServers();
	resetRuntimeConfig();
});

import { downloadBlobRange, resetRememberedServers } from "../src/domain/files/blob.js";
import { sanitizeServerHint, resolveReadServers } from "../src/domain/files/servers.js";
import { refFromAttachment } from "../src/domain/media/media-ref.js";

function fakeFetch(map, calls) {
	return async (url) => {
		calls.push(url);
		const host = new URL(url).origin;
		const status = map[host] ?? 404;
		return { status, ok: status < 300, arrayBuffer: async () => new Uint8Array([1, 2, 3]).buffer };
	};
}
const HASH = "a".repeat(64);
const noWait = { retries: 1, backoffMs: 1 };

test("перебор: 404 на первом адресе → находит на втором, и запоминает его на сессию", async () => {
	resetRememberedServers();
	const calls = [];
	const fetchImpl = fakeFetch({ "https://a.example": 404, "https://b.example": 206 }, calls);
	const servers = ["https://a.example", "https://b.example"];
	const bytes = await downloadBlobRange(servers, HASH, 0, 2, { fetchImpl, ...noWait });
	assert.deepEqual([...bytes], [1, 2, 3]);
	calls.length = 0;
	await downloadBlobRange(servers, HASH, 0, 2, { fetchImpl, ...noWait });
	assert.deepEqual(calls, [`https://b.example/${HASH}`], "второй запрос идёт сразу на запомненный адрес");
});

test("перебор: 503 повторяется на том же адресе, затем следующий", async () => {
	resetRememberedServers();
	const calls = [];
	const fetchImpl = fakeFetch({ "https://a.example": 503, "https://b.example": 206 }, calls);
	await downloadBlobRange(["https://a.example", "https://b.example"], HASH, 0, 2, { fetchImpl, ...noWait });
	assert.deepEqual(calls, [`https://a.example/${HASH}`, `https://a.example/${HASH}`, `https://b.example/${HASH}`]);
});

test("перебор: 503 не превращается в «блоба нет», если соседний ответил 404", async () => {
	resetRememberedServers();
	const fetchImpl = fakeFetch({ "https://a.example": 503, "https://b.example": 404 }, []);
	await assert.rejects(downloadBlobRange(["https://a.example", "https://b.example"], HASH, 0, 2, { fetchImpl, ...noWait }), (err) => err.status === 503);
});

test("перебор: везде 404 — итоговая ошибка 404", async () => {
	resetRememberedServers();
	const fetchImpl = fakeFetch({}, []);
	await assert.rejects(downloadBlobRange(["https://a.example", "https://b.example"], HASH, 0, 2, { fetchImpl, ...noWait }), (err) => err.status === 404);
});

test("подсказка из чужого сообщения: только http(s), канонический вид, не больше трёх", () => {
	assert.deepEqual(sanitizeServerHint(["javascript:alert(1)", "https://ok.example/", "ftp://x", 5, "https://ok.example", "http://b.example:8080", "https://c.example", "https://d.example"]), [
		"https://ok.example",
		"http://b.example:8080",
		"https://c.example",
	]);
	assert.deepEqual(sanitizeServerHint(undefined), []);
});

test("подсказка идёт первой, явный адрес — сразу за ней", async () => {
	resetUserServers();
	await withConfig(["https://cfg.example"]);
	registerUserServers({ activeUrl: "https://mine.example", urls: [] });
	const list = resolveReadServers(["https://hint.example"], "https://explicit.example");
	assert.deepEqual(list.slice(0, 3), ["https://hint.example", "https://explicit.example", "https://mine.example"]);
	resetUserServers();
	resetRuntimeConfig();
});

test("дескриптор без подсказки открывается как раньше; ссылка на медиа несёт подсказку", () => {
	const base = { manifestDigest: "d", fileKey: btoa("k"), mime: "image/png", name: "a.png", size: 1 };
	assert.equal(refFromAttachment(base).servers, null);
	assert.deepEqual(refFromAttachment({ ...base, servers: ["https://x.example"] }).servers, ["https://x.example"]);
});
