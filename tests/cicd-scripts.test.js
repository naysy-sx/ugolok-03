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
	assert.match(src, /check-dist-size\.sh/);
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

test("check-dist-size.sh — единственное место лимита 1304 КБ, исполняемый", () => {
	const CHECK_DIST_SIZE = join(ROOT, "scripts/check-dist-size.sh");
	const src = read(CHECK_DIST_SIZE);
	assert.match(src, /set -euo pipefail/);
	assert.match(src, /dist\/index\.html/);
	assert.match(src, /1335296/);
	assert.match(src, /1304/);
	assert.equal(src.includes("280"), false);
	const st = spawnSync("test", ["-x", CHECK_DIST_SIZE]);
	assert.equal(st.status, 0, "check-dist-size.sh должен быть исполняемым");
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
	assert.match(src, /actions\/checkout@v5/);
	assert.match(src, /actions\/setup-node@v6/);
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

test("docs и скелет: dist-updates, ветки dev/main/prod, нет Traefik", () => {
	const delivery = read(join(ROOT, "docs/delivery.md"));
	assert.match(delivery, /dist-updates/);
	assert.match(delivery, /dev` → `test\.ugolok\.tech/);
	assert.match(delivery, /prod` → `ugolok\.tech/);
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
	assert.match(gi, /deploy\/island\/coturn\.conf/);
});

test("deploy/island — боевой стек ugolok.tech без секрета TURN", () => {
	const example = read(join(ROOT, "deploy/island/coturn.conf.example"));
	assert.match(example, /static-auth-secret=CHANGE_ME/);
	assert.match(example, /use-auth-secret/);
	assert.equal(example.includes("lt-cred-mech"), false);
	assert.match(example, /min-port=49160/);
	assert.equal(existsSync(join(ROOT, "deploy/island/coturn.conf")), false);
	const caddy = read(join(ROOT, "deploy/caddy/prod.caddy"));
	assert.match(caddy, /relay\.ugolok\.tech/);
	assert.match(caddy, /alpn http\/1\.1/);
	assert.match(caddy, /header -Alt-Svc/);
	const compose = read(join(ROOT, "deploy/island/docker-compose.yml"));
	assert.match(compose, /ugolok-coturn/);
	assert.match(compose, /nobody:nogroup/);
	// db_path в blossom-config.yml — ./data/…; volume должен быть /app/data,
	// не /app/db (в образе /app/db — SQL-миграции upstream, не sqlite).
	assert.match(compose, /\/var\/lib\/ugolok\/blossom:\/app\/data/);
	assert.match(read(join(ROOT, "deploy/island/blossom-config.yml")), /database\.sqlite3/);
	assert.ok(existsSync(join(ROOT, "deploy/island/relay.Dockerfile")));
	assert.ok(existsSync(join(ROOT, "deploy/island/blossom.Dockerfile")));
});

test("security: TURN без релея во внутренние сети, Caddy admin API за сокетом, HSTS", () => {
	const coturn = read(join(ROOT, "deploy/island/coturn.conf.example"));
	// TURN раздаёт публичные креды без проверки личности (этап 6) — без явного
	// denied-peer-ip держатель кредов может попросить coturn соединить его с
	// облачной metadata (169.254/16), приватными сетями или localhost.
	assert.match(coturn, /denied-peer-ip=169\.254\.0\.0-169\.254\.255\.255/);
	assert.match(coturn, /denied-peer-ip=127\.0\.0\.0-127\.255\.255\.255/);
	assert.match(coturn, /denied-peer-ip=10\.0\.0\.0-10\.255\.255\.255/);
	assert.match(coturn, /denied-peer-ip=172\.16\.0\.0-172\.31\.255\.255/);
	assert.match(coturn, /denied-peer-ip=192\.168\.0\.0-192\.168\.255\.255/);
	assert.match(coturn, /denied-peer-ip=::1/);
	assert.match(coturn, /total-quota=\d+/);
	assert.match(coturn, /user-quota=\d+/);
	assert.match(coturn, /max-bps=\d+/);

	// 127.0.0.1:2019 (дефолт Caddy admin API) не требует аутентификации и
	// доступен любому локальному процессу/контейнеру с network_mode: host
	// (coturn — именно такой) — POST /load туда подменяет всю конфигурацию.
	const globalCaddyfile = read(join(ROOT, "deploy/caddy/Caddyfile"));
	assert.match(globalCaddyfile, /admin unix\/\/run\/caddy\/admin\.sock/);

	const prodCaddyForHsts = read(join(ROOT, "deploy/caddy/prod.caddy"));
	const testCaddyForHsts = read(join(ROOT, "deploy/caddy/test.caddy"));
	for (const site of [prodCaddyForHsts, testCaddyForHsts]) {
		const headerBlocks = site.match(/X-Content-Type-Options nosniff/g) || [];
		const hstsBlocks = site.match(/Strict-Transport-Security "max-age=31536000"/g) || [];
		assert.ok(headerBlocks.length > 0);
		assert.equal(hstsBlocks.length, headerBlocks.length, "HSTS должен стоять в каждом header {} блоке сайта");
	}
});

test("pipeline: deploy-env, test-остров, Caddy test, Forgejo deploy workflows", () => {
	const deploy = read(join(ROOT, "scripts/deploy-env.sh"));
	assert.match(deploy, /usage: \$0 test\|prod/);
	assert.match(deploy, /relay\.test\.ugolok\.tech/);
	const st = spawnSync("test", ["-x", join(ROOT, "scripts/deploy-env.sh")]);
	assert.equal(st.status, 0, "deploy-env.sh должен быть исполняемым");
	const syntax = spawnSync("bash", ["-n", join(ROOT, "scripts/deploy-env.sh")]);
	assert.equal(syntax.status, 0, syntax.stderr);
	assert.equal(spawnSync("test", ["-x", join(ROOT, "scripts/apply-caddy.sh")]).status, 0);
	assert.equal(spawnSync("bash", ["-n", join(ROOT, "scripts/apply-caddy.sh")]).status, 0);

	// Этап 1: test-ветка деплоя вызывает apply-caddy только режимом site, prod — full.
	const testBranch = deploy.slice(deploy.indexOf('if [[ "$ENV" == "test" ]]'), deploy.indexOf("else"));
	const prodBranch = deploy.slice(deploy.indexOf("else"), deploy.indexOf("ICE_JSON="));
	assert.match(testBranch, /CADDY_MODE=site/);
	assert.equal(/CADDY_MODE=full/.test(testBranch), false, "test-ветка не должна вызывать full");
	assert.match(prodBranch, /CADDY_MODE=full/);
	assert.match(deploy, /"\$APPLY_CADDY" "\$CADDY_MODE" "\$ROOT" "\$CADDY_SITE"/);
	assert.match(deploy, /sudo -n "\$APPLY_CADDY" "\$CADDY_MODE" "\$ROOT" "\$CADDY_SITE"/);

	const applyCaddy = read(join(ROOT, "scripts/apply-caddy.sh"));
	assert.match(applyCaddy, /MODE="\$\{1:\?site or full\}"/);
	assert.match(applyCaddy, /grep -qE '\^\[\[:space:\]\]\*import\[\[:space:\]\]\+\/etc\/caddy\/sites\/\\\*\\\.caddy'/);
	assert.match(applyCaddy, /сначала full/);

	// Этап 2: тесты внутри деплоя (контейнер) + проверка размера на хосте (post-контейнер).
	// ОТДЕЛЬНЫМИ строками — под set -e команда внутри "A && B && C", кроме
	// последней, не триггерит errexit (задокументированное исключение bash):
	// живая проверка (Forgejo Actions run #26) поймала именно это — npm test
	// упал, но npm run build/config.json всё равно "прошли", docker run вернул 0.
	assert.match(deploy, /set -euo pipefail\nexport BUILD_DEFAULT_ICE_SERVERS/);
	assert.match(deploy, /^npm ci --ignore-scripts$/m);
	assert.match(deploy, /^npm test$/m);
	assert.match(deploy, /^npm run build$/m);
	assert.equal(/npm (ci|test|run build) &&/.test(deploy), false, "npm-команды сборки не должны быть в одном && -списке — errexit их не ловит");
	assert.match(deploy, /bash "\$ROOT\/scripts\/check-dist-size\.sh"/);

	// Живая проверка (прод, run #30): $WWW уже существовал до этого скрипта и
	// принадлежит не ugolok — utimensat() на чужую директорию (не файл) падает
	// даже при праве записи внутрь. Без --omit-dir-times rsync копирует все
	// файлы успешно, но получает exit 23 на попытке проставить время самому
	// каталогу назначения — set -e роняет деплой ПОСЛЕ transfer, до
	// docker compose/apply-caddy.
	assert.match(deploy, /rsync -rltD --omit-dir-times --delete/);
	assert.match(deploy, /rsync -a --omit-dir-times --delete/);

	// Живая проверка (прод, run #33): --delete на island-rsync без исключения
	// turncreds.env стирал секрет оператора (не в git, живёт только на VPS,
	// как coturn.conf) в ЭТОМ ЖЕ прогоне, до docker compose up, который его
	// тут же требует через env_file.
	const islandRsyncBlock = deploy.slice(deploy.indexOf("rsync -a --omit-dir-times"), deploy.indexOf('"$ISLAND_SRC/"'));
	assert.match(islandRsyncBlock, /--exclude 'coturn\.conf'/);
	assert.match(islandRsyncBlock, /--exclude 'turncreds\.env'/);

	// Этап 3: кэш npm с хоста (не с нуля на каждый push) + лимит памяти контейнера сборки.
	assert.match(deploy, /NPM_CACHE="\$\{UGOLK_NPM_CACHE:-\/var\/cache\/ugolok-npm\}"/);
	assert.match(deploy, /NPM_CACHE_MOUNT=\(-v "\$NPM_CACHE:\/tmp\/npm"\)/);
	assert.match(deploy, /NPM_CACHE_MOUNT=\(\)/);
	assert.match(deploy, /"\$\{NPM_CACHE_MOUNT\[@\]\+"\$\{NPM_CACHE_MOUNT\[@\]\}"\}"/);
	assert.match(deploy, /--memory="\$\{UGOLK_BUILD_MEMORY:-2g\}"/);
	assert.match(deploy, /--memory-swap="\$\{UGOLK_BUILD_MEMORY_SWAP:-3g\}"/);
	const testCaddy = read(join(ROOT, "deploy/caddy/test.caddy"));
	assert.match(testCaddy, /test\.ugolok\.tech/);
	assert.match(testCaddy, /127\.0\.0\.1:7778/);
	const testCompose = read(join(ROOT, "deploy/island-test/docker-compose.yml"));
	assert.match(testCompose, /ugolok-test-relay/);
	assert.match(testCompose, /127\.0\.0\.1:7778:7777/);
	assert.equal(/^\s+coturn:/m.test(testCompose), false);
	const dt = read(join(ROOT, ".forgejo/workflows/deploy-test.yml"));
	assert.match(dt, /branches:\s*\[dev\]/);
	assert.match(dt, /deploy-env\.sh test/);
	assert.match(dt, /runs-on:\s*ugolok/);
	const dp = read(join(ROOT, ".forgejo/workflows/deploy-prod.yml"));
	assert.match(dp, /branches:\s*\[prod\]/);
	assert.match(dp, /deploy-env\.sh prod/);

	// Этап 6: пароль TURN больше не в сборке — ни секретного файла, ни username/credential в ICE_JSON.
	assert.equal(deploy.includes("TURN_USERNAME"), false);
	assert.equal(deploy.includes("TURN_PASSWORD"), false);
	assert.equal(deploy.includes("UGOLK_BUILD_ENV"), false);
	assert.equal(deploy.includes('source "$SECRETS"'), false);
	assert.match(deploy, /ICE_JSON='\[.*\]'/);
	assert.equal(/username|credential/.test(deploy.match(/ICE_JSON='(\[.*\])'/)[1]), false, "ICE_JSON не должен нести username/credential");
	assert.match(deploy, /turnCredentialsUrl:\\"\/api\/turn-credentials\\"/);

	// Этап 7: flock (два быстрых push не гонят rsync --delete параллельно),
	// BUILD_HASH с хоста, схлопнутые if/elif (было — два одинаковых блока).
	assert.match(deploy, /exec 9>"\/tmp\/ugolok-deploy-\$ENV\.lock"/);
	assert.match(deploy, /^flock 9$/m);
	assert.match(deploy, /BUILD_HASH="\$\(git -C "\$ROOT" rev-parse --short HEAD\)"/);
	assert.match(deploy, /-e BUILD_HASH="\$BUILD_HASH"/);
	assert.equal(deploy.includes("APPLY_PROD_ISLAND"), false);
	assert.equal((deploy.match(/up -d --build/g) || []).length, 1, "docker compose up -d --build — один раз, не в двух одинаковых ветках");
	// Живая проверка (прод, run #42): без --build compose переиспользует уже
	// существующий образ ugolok-turncreds-server:local как есть — тег
	// статический, свежий agent-src сам по себе рекомпиляцию не триггерит.
	assert.match(deploy, /docker compose -f "\$ISLAND_DST\/docker-compose\.yml" --project-directory "\$ISLAND_DST" up -d --build/);
	// Живая проверка (test, 415 audio/webm): патчи Blossom не подхватывались —
	// rsync исключает blossom-src, test-compose берёт готовый образ без build:.
	// При смене набора патчей — checkout pin + apply + build, затем recreate
	// контейнера blossom этого env (второй compose, не дубль up --build).
	assert.match(deploy, /\.blossom-patches\.sha/);
	assert.match(deploy, /safe\.directory=/);
	assert.match(deploy, /docker compose -f "\$PROD_COMPOSE" --project-directory "\$PROD_DIR" build blossom/);
	assert.match(deploy, /up -d --force-recreate --no-deps blossom/);
	assert.equal((deploy.match(/docker compose -f "\$ISLAND_DST\/docker-compose\.yml"/g) || []).length, 2, "up --build + force-recreate blossom, не больше");
	assert.match(deploy, /blossom rebuild не удался/);
	assert.match(deploy, /apply-caddy не применился/);
});

test("этап 6: turncreds-server — Caddy-роуты, compose, Dockerfile, coturn use-auth-secret", () => {
	const prodCaddy = read(join(ROOT, "deploy/caddy/prod.caddy"));
	const testCaddy = read(join(ROOT, "deploy/caddy/test.caddy"));
	for (const caddy of [prodCaddy, testCaddy]) {
		assert.match(caddy, /handle \/api\/turn-credentials \{/);
		assert.match(caddy, /reverse_proxy 127\.0\.0\.1:8090/);
		assert.match(caddy, /header \/api\/turn-credentials Cache-Control "no-store"/);
		// Живая проверка (test.ugolok.tech): голый try_files ВНЕ handle выполняется
		// раньше по встроенному порядку директив Caddy и переписывает путь на
		// /index.html до того, как handle /api/turn-credentials успевает
		// сработать — /api/turn-credentials отдавал SPA, не проксировался.
		// file_server/try_files обязаны быть внутри СВОЕГО handle {} (несколько
		// handle-блоков в одном сервере — единственный взаимоисключающий,
		// по-файлу-порядок в Caddy).
		assert.match(caddy, /handle \{\n\t\troot \*/);
		assert.equal(/^\troot \*/m.test(caddy), false, "root вне handle {} — try_files сработает раньше handle /api/...");
	}
	const compose = read(join(ROOT, "deploy/island/docker-compose.yml"));
	assert.match(compose, /turncreds-server:/);
	assert.match(compose, /127\.0\.0\.1:8090:8090/);
	assert.match(compose, /mem_limit: 32m/);
	assert.match(compose, /turncreds\.env/);
	// Живая проверка (прод, run #36): context: ../../agent (относительно
	// $ISLAND_DST — постоянной папки острова, НЕ временного git-клона) не
	// существует — "unable to prepare context: path /opt/agent not found".
	// agent-src — локальная подпапка $ISLAND_DST, которую deploy-env.sh сам
	// синхронизирует из клона на каждый деплой (см. ниже).
	assert.match(compose, /context:\s*\.\/agent-src/);
	assert.match(compose, /dockerfile:\s*\.\.\/turncreds-server\.Dockerfile/);
	assert.ok(existsSync(join(ROOT, "deploy/island/turncreds-server.Dockerfile")));
	assert.ok(existsSync(join(ROOT, "agent/cmd/turncreds-server/main.go")));
	const deployForAgentSrc = read(join(ROOT, "scripts/deploy-env.sh"));
	assert.match(deployForAgentSrc, /rsync -a --omit-dir-times --delete --exclude '\.git' "\$ROOT\/agent\/" "\$ISLAND_DST\/agent-src\/"/);
	const gi = read(join(ROOT, ".gitignore"));
	assert.match(gi, /deploy\/island\/turncreds\.env/);
	assert.equal(existsSync(join(ROOT, "deploy/island/turncreds.env")), false);
});

test("Forgejo ci.yml: раннер ugolok, без dev/prod, ci-check.sh внутри контейнера", () => {
	const fCi = read(join(ROOT, ".forgejo/workflows/ci.yml"));
	assert.match(fCi, /runs-on:\s*ugolok/);
	assert.match(fCi, /pull_request/);
	assert.match(fCi, /branches:\s*\[main\]/);
	assert.equal(/branches:\s*\[[^\]]*\bdev\b/.test(fCi), false, "push в dev не должен триггерить ci.yml — проверка уже в деплое");
	assert.equal(/branches:\s*\[[^\]]*\bprod\b/.test(fCi), false, "push в prod не должен триггерить ci.yml — проверка уже в деплое");
	assert.equal(fCi.includes("actions/checkout"), false);
	assert.equal(fCi.includes("actions/setup-node"), false);
	assert.match(fCi, /git\.ugolok\.tech/);
	assert.match(fCi, /node:22-bookworm/);
	assert.match(fCi, /bash scripts\/ci-check\.sh/);
});

test("Forgejo release.yml: помечен нерабочим (см. этап 5), не удалён", () => {
	const fRel = read(join(ROOT, ".forgejo/workflows/release.yml"));
	assert.match(fRel, /не запускается на Forgejo/i);
	assert.match(fRel, /этап 5/);
});

test("package.json — engines node>=22, allowScripts зафиксирован, version не источник релиза", () => {
	const pkg = JSON.parse(read(join(ROOT, "package.json")));
	assert.equal(pkg.engines?.node, ">=22");
	assert.equal(typeof pkg.allowScripts, "object");
	assert.equal(pkg.allowScripts.fsevents, false);
	assert.equal(pkg.version, "1.0.0");
});
