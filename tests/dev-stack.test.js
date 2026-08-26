import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import viteConfig from "../vite.config.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

function resolveConfig(command) {
	const fn = typeof viteConfig === "function" ? viteConfig : viteConfig.default;
	return fn({ command, mode: command === "serve" ? "development" : "production" });
}

function pluginNames(cfg) {
	return cfg.plugins.flat(Infinity).filter(Boolean).map((p) => p.name);
}

function parseDefine(cfg, key) {
	return JSON.parse(cfg.define[key]);
}

test("serve поднимает трио relay+blossom+turn", async () => {
	const cfg = await resolveConfig("serve");
	const names = pluginNames(cfg);
	assert.ok(names.includes("ugolok:dev-relay"));
	assert.ok(names.includes("ugolok:dev-blossom"));
	assert.ok(names.includes("ugolok:dev-turn"));
});

test("build не спавнит dev-серверы", async () => {
	const cfg = await resolveConfig("build");
	const names = pluginNames(cfg);
	assert.ok(!names.includes("ugolok:dev-relay"));
	assert.ok(!names.includes("ugolok:dev-blossom"));
	assert.ok(!names.includes("ugolok:dev-turn"));
});

test("serve define указывает на локальные relay/blossom/coturn", async () => {
	const cfg = await resolveConfig("serve");
	assert.deepEqual(parseDefine(cfg, "__BUILD_DEFAULT_RELAYS__"), [
		"ws://127.0.0.1:7777",
	]);
	assert.deepEqual(parseDefine(cfg, "__BUILD_DEFAULT_BLOSSOM_SERVERS__"), [
		"http://127.0.0.1:8080",
	]);
	const ice = parseDefine(cfg, "__BUILD_DEFAULT_ICE_SERVERS__");
	assert.deepEqual(ice[0], { urls: "stun:127.0.0.1:3478" });
	assert.deepEqual(ice[1], {
		urls: "turn:127.0.0.1:3478",
		username: "ugolok",
		credential: "ugolok-dev",
	});
	assert.deepEqual(ice[2], { urls: "stun:stun.l.google.com:19302" });
});

test("build define не целится в localhost relay/blossom/coturn", async () => {
	const cfg = await resolveConfig("build");
	assert.deepEqual(parseDefine(cfg, "__BUILD_DEFAULT_RELAYS__"), [
		"wss://relay.example",
	]);
	assert.deepEqual(parseDefine(cfg, "__BUILD_DEFAULT_BLOSSOM_SERVERS__"), [
		"https://blossom.example",
	]);
	assert.deepEqual(parseDefine(cfg, "__BUILD_DEFAULT_ICE_SERVERS__"), [
		{ urls: "stun:stun.l.google.com:19302" },
	]);
});

test("server/coturn: setup.sh, run.sh, turnserver.conf на месте", async () => {
	const dir = join(ROOT, "server/coturn");
	for (const name of ["setup.sh", "run.sh", "turnserver.conf"]) {
		assert.ok(existsSync(join(dir, name)), name);
	}
	const run = await readFile(join(dir, "run.sh"), "utf8");
	assert.match(run, /exec\s+.*turnserver/);
	assert.match(run, /turnserver\.conf/);
	const conf = await readFile(join(dir, "turnserver.conf"), "utf8");
	assert.match(conf, /listening-ip=127\.0\.0\.1/);
	assert.match(conf, /listening-port=3478/);
	assert.match(conf, /user=ugolok:ugolok-dev/);
	assert.match(conf, /lt-cred-mech/);
});
