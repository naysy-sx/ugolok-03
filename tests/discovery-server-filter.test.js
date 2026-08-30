// CONTRACTS.md §DISCOVERY-REDESIGN, Э3 — серверный write-policy плагин
// (server/strfry/whitelist-plugin.mjs) не экспортирует discoveryContentIsClean
// (приватная функция файла) — тестируется ЧЕСТНО через реальный протокол
// плагина (stdin/stdout построчный JSON, server/strfry/strfry-src/docs/
// plugins.md), тем же способом, каким его вызывает strfry. whitelist.json
// в репозитории — dev-default "*" (allow-all), поэтому whitelist-этап не
// мешает добраться до discovery-фильтра в тесте.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { getPublicKey } from "../src/core/crypto/keys.js";
import { bytesToHex } from "@noble/hashes/utils.js";
import { buildDiscoveryEvent } from "../src/domain/discovery/discovery.js";
import stopwords from "../src/domain/discovery/stopwords.json" with { type: "json" };

const HERE = dirname(fileURLToPath(import.meta.url));
const PLUGIN_PATH = join(HERE, "../server/strfry/whitelist-plugin.mjs");

const ALICE_PRIV = new Uint8Array(32).fill(13);
const ALICE_PUB = bytesToHex(getPublicKey(ALICE_PRIV));
const FAR_FUTURE = Math.floor(Date.now() / 1000) + 86400;
const BAD_WORD = stopwords[0];

let proc;
let rl;
let pending = [];

before(() => {
	proc = spawn("node", [PLUGIN_PATH], { stdio: ["pipe", "pipe", "inherit"] });
	rl = createInterface({ input: proc.stdout, terminal: false });
	rl.on("line", (line) => {
		const waiter = pending.shift();
		if (waiter) waiter(JSON.parse(line));
	});
});

after(() => {
	rl.close();
	proc.kill();
});

function askPlugin(event) {
	return new Promise((resolve) => {
		pending.push(resolve);
		proc.stdin.write(JSON.stringify({ type: "new", event }) + "\n");
	});
}

test("whitelist-plugin: discovery-событие с грязными ПРАВИЛАМИ канала -> reject (Э3)", async () => {
	const event = buildDiscoveryEvent(ALICE_PRIV, {
		visible: true,
		showChannels: true,
		showRules: true,
		channels: [{ id: "c1", name: "Канал", description: "d", rules: BAD_WORD }],
		visibleUntil: FAR_FUTURE,
	});
	const res = await askPlugin(event);
	assert.equal(res.action, "reject");
});

test("whitelist-plugin: discovery-событие с чистыми правилами -> accept (Э3, контроль — фильтр не режет всё подряд)", async () => {
	const event = buildDiscoveryEvent(ALICE_PRIV, {
		visible: true,
		showChannels: true,
		showRules: true,
		channels: [{ id: "c1", name: "Канал", description: "d", rules: "без рекламы, только на тему" }],
		visibleUntil: FAR_FUTURE,
	});
	const res = await askPlugin(event);
	assert.equal(res.action, "accept");
});
