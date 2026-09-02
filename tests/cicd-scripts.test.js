import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
	existsSync,
	readFileSync,
	writeFileSync,
	mkdirSync,
	rmSync,
	mkdtempSync,
	cpSync,
} from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const CI_CHECK = join(ROOT, "scripts/ci-check.sh");
const RELEASE_HASH = join(ROOT, "scripts/release-hash.sh");
const RELEASE_PACK = join(ROOT, "scripts/release-pack.sh");
const SERVE_UPDATES = join(ROOT, "scripts/serve-updates.sh");
const LIMIT_BYTES = 1304 * 1024;

function read(path) {
	assert.ok(existsSync(path), `нет файла ${path}`);
	return readFileSync(path, "utf8");
}

function run(script, args = [], env = {}) {
	return spawnSync("bash", [script, ...args], {
		cwd: ROOT,
		encoding: "utf8",
		env: { ...process.env, ...env },
	});
}

test("ci-check.sh — источник истины проверки, без рекурсии и без serve", () => {
	const src = read(CI_CHECK);
	assert.match(src, /set -euo pipefail/);
	assert.match(src, /npm ci --ignore-scripts/);
	assert.match(src, /npm test/);
	assert.match(src, /npm run build/);
	assert.match(src, /dist\/index\.html/);
	assert.match(src, /dist\/service-worker\.js/);
	assert.match(src, /1304/);
	assert.equal(src.includes("npx serve"), false);
	assert.equal(src.includes("playwright"), false);
	assert.equal(src.includes("pull_request_target"), false);
});

test("ci-check.sh исполняемый и не содержит лимит 280 КБ", () => {
	const src = read(CI_CHECK);
	assert.equal(src.includes("280"), false);
	const st = spawnSync("test", ["-x", CI_CHECK]);
	assert.equal(st.status, 0, "ci-check.sh должен быть исполняемым");
	assert.ok(LIMIT_BYTES === 1335296);
});

test("release-hash.sh — SKIP_BUILD+SKIP_GPG пишет SHA256SUMS на оба файла и не требует gpg", () => {
	mkdirSync(join(ROOT, "dist"), { recursive: true });
	const indexPath = join(ROOT, "dist/index.html");
	const swPath = join(ROOT, "dist/service-worker.js");
	if (!existsSync(indexPath)) writeFileSync(indexPath, "<html>cicd-fixture</html>\n");
	if (!existsSync(swPath)) writeFileSync(swPath, "/* cicd-fixture sw */\n");
	const sumsPath = join(ROOT, "dist/SHA256SUMS");
	const ascPath = join(ROOT, "dist/SHA256SUMS.asc");
	const hadAsc = existsSync(ascPath);
	if (existsSync(sumsPath)) rmSync(sumsPath);
	if (existsSync(ascPath)) rmSync(ascPath);

	const result = run(RELEASE_HASH, [], {
		SKIP_INSTALL: "1",
		SKIP_BUILD: "1",
		SKIP_GPG: "1",
	});
	assert.equal(result.status, 0, result.stderr || result.stdout);
	assert.ok(existsSync(sumsPath), "SHA256SUMS не создан");
	const sums = readFileSync(sumsPath, "utf8");
	assert.match(sums, /index\.html/);
	assert.match(sums, /service-worker\.js/);
	assert.equal(existsSync(ascPath), false, "при SKIP_GPG=1 .asc создавать нельзя");
	if (hadAsc) {
		// фикстура не восстанавливает чужую подпись — dist gitignored
	}
});

test("release-hash.sh — SKIP_BUILD без артефактов падает", () => {
	const isolated = mkdtempSync(join(tmpdir(), "ugolok-hash-"));
	mkdirSync(join(isolated, "scripts"), { recursive: true });
	cpSync(RELEASE_HASH, join(isolated, "scripts/release-hash.sh"));
	const result = spawnSync("bash", ["scripts/release-hash.sh"], {
		cwd: isolated,
		encoding: "utf8",
		env: { ...process.env, SKIP_INSTALL: "1", SKIP_BUILD: "1", SKIP_GPG: "1" },
	});
	assert.notEqual(result.status, 0);
	rmSync(isolated, { recursive: true, force: true });
});

test("release-pack.sh собирает dist-updates/latest и dist-updates/<tag>", () => {
	mkdirSync(join(ROOT, "dist"), { recursive: true });
	if (!existsSync(join(ROOT, "dist/index.html"))) {
		writeFileSync(join(ROOT, "dist/index.html"), "<html>cicd-fixture</html>\n");
	}
	if (!existsSync(join(ROOT, "dist/service-worker.js"))) {
		writeFileSync(join(ROOT, "dist/service-worker.js"), "/* cicd-fixture sw */\n");
	}
	const result = run(RELEASE_PACK, ["v0.0.0-devtest"], {
		SKIP_INSTALL: "1",
		SKIP_BUILD: "1",
		SKIP_GPG: "1",
	});
	assert.equal(result.status, 0, result.stderr || result.stdout);
	const rootDir = join(ROOT, "dist-updates");
	const latest = join(rootDir, "latest");
	const tagged = join(rootDir, "v0.0.0-devtest");
	for (const dir of [rootDir, latest, tagged]) {
		assert.ok(existsSync(dir), `нет ${dir}`);
	}
	for (const dir of [latest, tagged]) {
		for (const file of [
			"index.html",
			"service-worker.js",
			"SHA256SUMS",
			"version.json",
			"config.example.json",
		]) {
			assert.ok(existsSync(join(dir, file)), `нет ${dir}/${file}`);
		}
	}
	assert.ok(existsSync(join(rootDir, "version.json")));
	assert.ok(existsSync(join(rootDir, "changelog.md")));
	const manifest = JSON.parse(readFileSync(join(rootDir, "version.json"), "utf8"));
	assert.equal(manifest.name, "ugolok");
	assert.equal(manifest.version, "0.0.0-devtest");
	assert.equal(manifest.gitTag, "v0.0.0-devtest");
	assert.equal(typeof manifest.gitSha, "string");
	assert.ok(manifest.gitSha.length >= 7);
	assert.equal(typeof manifest.buildHash, "string");
	assert.match(manifest.buildHash, /^[0-9a-f]{64}$/);
	assert.equal(manifest.minClientVersion, "0.0.0-devtest");
	assert.equal(manifest.channels.web.url, "/index.html");
	assert.equal(manifest.updatesBaseUrl, "https://updates.ugolok.tech");
	assert.match(manifest.releasedAt, /T.*Z$/);
	assert.equal(existsSync(join(ROOT, "dist-release")), false);
});

test("serve-updates.sh слушает 8787 и не запускает CI-сервер из себя как обязательный шаг pack", () => {
	const src = read(SERVE_UPDATES);
	assert.match(src, /8787/);
	assert.match(src, /dist-updates/);
	const st = spawnSync("test", ["-x", SERVE_UPDATES]);
	assert.equal(st.status, 0);
});

test("GitHub Actions ci.yml вызывает ci-check, Node 22, без pull_request_target", () => {
	const src = read(join(ROOT, ".github/workflows/ci.yml"));
	assert.match(src, /pull_request/);
	assert.match(src, /push/);
	assert.match(src, /ubuntu-latest/);
	assert.match(src, /contents:\s*read/);
	assert.match(src, /node-version:\s*['"]?22['"]?/);
	assert.match(src, /scripts\/ci-check\.sh/);
	assert.equal(src.includes("pull_request_target"), false);
	assert.equal(src.includes("npx serve"), false);
});

test("GitHub Actions release.yml на semver-тег, pack, contents write", () => {
	const src = read(join(ROOT, ".github/workflows/release.yml"));
	assert.match(src, /v\*\.\*\.\*/);
	assert.match(src, /scripts\/ci-check\.sh/);
	assert.match(src, /scripts\/release-pack\.sh/);
	assert.match(src, /contents:\s*write/);
	assert.match(src, /actions\/checkout@v4/);
	assert.match(src, /actions\/setup-node@v4/);
	assert.equal(src.includes("npx serve"), false);
	assert.equal(src.includes("pull_request_target"), false);
});

test("Forgejo workflows копируют смысл GitHub, не второй алгоритм", () => {
	const gCi = read(join(ROOT, ".github/workflows/ci.yml"));
	const fCi = read(join(ROOT, ".forgejo/workflows/ci.yml"));
	const gRel = read(join(ROOT, ".github/workflows/release.yml"));
	const fRel = read(join(ROOT, ".forgejo/workflows/release.yml"));
	assert.match(fCi, /scripts\/ci-check\.sh/);
	assert.match(fRel, /scripts\/release-pack\.sh/);
	assert.match(gCi, /scripts\/ci-check\.sh/);
	assert.match(gRel, /scripts\/release-pack\.sh/);
	assert.equal(fCi.includes("npx serve"), false);
	assert.equal(fRel.includes("npx serve"), false);
});

test("release-hash.sh — без SKIP_GPG и без ключа не падает на set -u", () => {
	mkdirSync(join(ROOT, "dist"), { recursive: true });
	if (!existsSync(join(ROOT, "dist/index.html"))) {
		writeFileSync(join(ROOT, "dist/index.html"), "<html>cicd-fixture</html>\n");
	}
	if (!existsSync(join(ROOT, "dist/service-worker.js"))) {
		writeFileSync(join(ROOT, "dist/service-worker.js"), "/* cicd-fixture sw */\n");
	}
	const result = spawnSync("bash", [RELEASE_HASH], {
		cwd: ROOT,
		encoding: "utf8",
		env: {
			PATH: process.env.PATH,
			HOME: process.env.HOME,
			SKIP_INSTALL: "1",
			SKIP_BUILD: "1",
		},
	});
	assert.equal(result.status, 0, result.stderr || result.stdout);
	assert.match(result.stderr, /GPG-подпись пропущена/);
});

test("release-pack.sh нормализует версию без префикса v", () => {
	mkdirSync(join(ROOT, "dist"), { recursive: true });
	if (!existsSync(join(ROOT, "dist/index.html"))) {
		writeFileSync(join(ROOT, "dist/index.html"), "<html>cicd-fixture</html>\n");
	}
	if (!existsSync(join(ROOT, "dist/service-worker.js"))) {
		writeFileSync(join(ROOT, "dist/service-worker.js"), "/* cicd-fixture sw */\n");
	}
	const result = run(RELEASE_PACK, ["1.2.3"], {
		SKIP_INSTALL: "1",
		SKIP_BUILD: "1",
		SKIP_GPG: "1",
	});
	assert.equal(result.status, 0, result.stderr || result.stdout);
	const manifest = JSON.parse(readFileSync(join(ROOT, "dist-updates/version.json"), "utf8"));
	assert.equal(manifest.version, "1.2.3");
	assert.equal(manifest.gitTag, "v1.2.3");
	assert.ok(existsSync(join(ROOT, "dist-updates/v1.2.3/index.html")));
});

test("docs и скелет: dist-updates, Caddy, нет веток prod/test как модели, нет Traefik", () => {
	const delivery = read(join(ROOT, "docs/delivery.md"));
	assert.match(delivery, /dist-updates/);
	assert.match(delivery, /не заводить: долгоживущие `test`, `prod`/);
	assert.equal(delivery.includes("Traefik"), false);
	const compose = read(join(ROOT, "deploy/compose.yml"));
	assert.match(compose, /^\s+web:/m);
	assert.match(compose, /^\s+relay:/m);
	assert.match(compose, /^\s+blossom:/m);
	assert.match(compose, /^\s+turn:/m);
	assert.match(compose, /^\s+proxy:/m);
	assert.match(compose, /caddy/i);
	assert.equal(compose.toLowerCase().includes("traefik"), false);
	const gi = read(join(ROOT, ".gitignore"));
	assert.match(gi, /dist-updates\//);
	assert.match(gi, /deploy\/\.env/);
});

test("package.json — engines node>=22, allowScripts зафиксирован, version не источник релиза", () => {
	const pkg = JSON.parse(read(join(ROOT, "package.json")));
	assert.equal(pkg.engines?.node, ">=22");
	assert.equal(typeof pkg.allowScripts, "object");
	assert.equal(pkg.allowScripts.fsevents, false);
	assert.equal(pkg.version, "1.0.0");
});
