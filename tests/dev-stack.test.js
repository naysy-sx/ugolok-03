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

const LOCAL_RELAYS = ["ws://127.0.0.1:7777"];
const LOCAL_BLOSSOM = ["http://127.0.0.1:8080"];
const LOCAL_ICE = [
	{ urls: "stun:127.0.0.1:3478" },
	{
		urls: "turn:127.0.0.1:3478",
		username: "ugolok",
		credential: "ugolok-dev",
	},
	{ urls: "stun:stun.l.google.com:19302" },
];

function assertLocalIslandDefines(cfg) {
	assert.deepEqual(parseDefine(cfg, "__BUILD_DEFAULT_RELAYS__"), LOCAL_RELAYS);
	assert.deepEqual(parseDefine(cfg, "__BUILD_BOOTSTRAP_RELAYS__"), LOCAL_RELAYS);
	assert.deepEqual(
		parseDefine(cfg, "__BUILD_DEFAULT_BLOSSOM_SERVERS__"),
		LOCAL_BLOSSOM,
	);
	assert.deepEqual(parseDefine(cfg, "__BUILD_DEFAULT_ICE_SERVERS__"), LOCAL_ICE);
}

test("serve define указывает на локальные relay/blossom/coturn", async () => {
	assertLocalIslandDefines(await resolveConfig("serve"));
});

test("build define — те же localhost-дефолты, что serve", async () => {
	assertLocalIslandDefines(await resolveConfig("build"));
});

test("env BUILD_DEFAULT_* переопределяет дефолт и в build, и в serve", async () => {
	const keys = [
		"BUILD_DEFAULT_RELAYS",
		"BUILD_BOOTSTRAP_RELAYS",
		"BUILD_DEFAULT_BLOSSOM_SERVERS",
		"BUILD_DEFAULT_ICE_SERVERS",
	];
	const prev = Object.fromEntries(keys.map((k) => [k, process.env[k]]));
	process.env.BUILD_DEFAULT_RELAYS = JSON.stringify(["wss://custom.relay"]);
	process.env.BUILD_BOOTSTRAP_RELAYS = JSON.stringify(["wss://custom.bootstrap"]);
	process.env.BUILD_DEFAULT_BLOSSOM_SERVERS = JSON.stringify([
		"https://custom.blossom",
	]);
	process.env.BUILD_DEFAULT_ICE_SERVERS = JSON.stringify([
		{ urls: "stun:custom:3478" },
	]);
	try {
		for (const command of ["build", "serve"]) {
			const cfg = await resolveConfig(command);
			assert.deepEqual(parseDefine(cfg, "__BUILD_DEFAULT_RELAYS__"), [
				"wss://custom.relay",
			]);
			assert.deepEqual(parseDefine(cfg, "__BUILD_BOOTSTRAP_RELAYS__"), [
				"wss://custom.bootstrap",
			]);
			assert.deepEqual(parseDefine(cfg, "__BUILD_DEFAULT_BLOSSOM_SERVERS__"), [
				"https://custom.blossom",
			]);
			assert.deepEqual(parseDefine(cfg, "__BUILD_DEFAULT_ICE_SERVERS__"), [
				{ urls: "stun:custom:3478" },
			]);
		}
	} finally {
		for (const k of keys) {
			if (prev[k] === undefined) delete process.env[k];
			else process.env[k] = prev[k];
		}
	}
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
