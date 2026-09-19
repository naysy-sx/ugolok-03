import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, statSync, chmodSync, readdirSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

// AUDIT-EGOROD H1/G4/G5: скрипты эксплуатации острова проверяются на заглушках
// docker/curl — боевой стенд для теста недоступен, но логика (снимки, ротация,
// hardlink'и, рубильник, проверка здоровья) детерминирована.

const SCRIPTS = resolve("scripts");

function sandbox() {
	const root = mkdtempSync(join(tmpdir(), "island-"));
	const bin = join(root, "bin");
	mkdirSync(bin);
	const stub = (name, body) => {
		writeFileSync(join(bin, name), `#!/usr/bin/env bash\n${body}\n`);
		chmodSync(join(bin, name), 0o755);
	};
	stub("timeout", 'shift; exec "$@"'); // macOS без coreutils
	return { root, bin, stub, env: (extra = {}) => ({ ...process.env, PATH: `${bin}:${process.env.PATH}`, ...extra }) };
}

const run = (script, args, env) => spawnSync("bash", [join(SCRIPTS, script), ...args], { env, encoding: "utf8" });

test("backup: снимок содержит события relay, sqlite и blob'ы; второй снимок делит blob'ы hardlink'ами; ротация", () => {
	const sb = sandbox();
	sb.stub("docker", 'if [ "$1" = exec ]; then echo \'{"id":"1"}\'; echo \'{"id":"2"}\'; fi');
	sb.stub("sqlite3", 'cp "$1" "$(echo "$2" | sed "s/.backup .\\(.*\\).$/\\1/")"');
	const data = join(sb.root, "data");
	mkdirSync(join(data, "blossom/blobs/ab"), { recursive: true });
	writeFileSync(join(data, "blossom/database.sqlite3"), "db");
	writeFileSync(join(data, "blossom/blobs/ab/abcdef"), "blob-content");
	const backups = join(sb.root, "backups");
	const env = sb.env({ ISLAND_DATA: data, BACKUP_DIR: backups, BACKUP_KEEP: "2", MIN_FREE_MB: "1" });

	const first = run("island-backup.sh", [], env);
	assert.equal(first.status, 0, first.stderr);
	const snaps1 = readdirSync(backups).filter((n) => n.startsWith("2"));
	assert.equal(snaps1.length, 1);
	const s1 = join(backups, snaps1[0]);
	assert.ok(existsSync(join(s1, "relay-events.jsonl.gz")));
	assert.equal(readFileSync(join(s1, "blossom.sqlite3"), "utf8"), "db");
	assert.match(readFileSync(join(s1, "MANIFEST"), "utf8"), /relay_events=2/);
	assert.match(readFileSync(join(s1, "MANIFEST"), "utf8"), /blob_files=1/);

	// второй и третий снимки (метка секундная — ждём смены)
	for (let i = 0; i < 2; i++) {
		spawnSync("sleep", ["1.1"]);
		assert.equal(run("island-backup.sh", [], env).status, 0);
	}
	const snaps = readdirSync(backups).filter((n) => n.startsWith("2")).sort();
	assert.equal(snaps.length, 2, "ротация оставила BACKUP_KEEP=2");
	const [a, b] = snaps.map((n) => statSync(join(backups, n, "blobs/ab/abcdef")));
	assert.equal(a.ino, b.ino, "blob'ы неизменяемы — снимки делят их hardlink'ом");
});

test("backup: мало свободного места — отказ, ничего не создаётся (копия не должна добить диск)", () => {
	const sb = sandbox();
	sb.stub("docker", "true");
	const backups = join(sb.root, "backups");
	const res = run("island-backup.sh", [], sb.env({ ISLAND_DATA: join(sb.root, "d"), BACKUP_DIR: backups, MIN_FREE_MB: "99999999" }));
	assert.equal(res.status, 1);
	assert.match(res.stderr, /бэкап отменён/);
	assert.equal(readdirSync(backups).filter((n) => n.startsWith("2")).length, 0);
});

test("backup: повреждённый/пустой экспорт relay не выдаётся за успешный снимок", () => {
	const sb = sandbox();
	sb.stub("docker", "exit 1");
	const res = run("island-backup.sh", [], sb.env({ ISLAND_DATA: join(sb.root, "d"), BACKUP_DIR: join(sb.root, "b"), MIN_FREE_MB: "1" }));
	assert.notEqual(res.status, 0);
	assert.equal(existsSync(join(sb.root, "b", "latest")), false);
});

test("health: все сервисы отвечают -> 0; отказ blossom -> 1 с понятной причиной", () => {
	const sb = sandbox();
	sb.stub("docker", 'cat >/dev/null; echo \'{"id":"0","action":"accept"}\'');
	sb.stub("curl", 'case "$*" in *nostr+json*) echo \'{"name":"ugolok"}\';; *) true;; esac');
	const ok = run("island-health.sh", ["prod"], sb.env({ HEALTH_TIMEOUT: "2", HEALTH_INTERVAL: "0" }));
	assert.equal(ok.status, 0, ok.stderr);

	sb.stub("curl", 'case "$*" in *nostr+json*) echo \'{"name":"ugolok"}\';; *8000/stats*) exit 22;; *) true;; esac');
	const bad = run("island-health.sh", ["prod"], sb.env({ HEALTH_TIMEOUT: "1", HEALTH_INTERVAL: "0" }));
	assert.equal(bad.status, 1);
	assert.match(bad.stderr, /blossom: \/stats не отвечает/);
	assert.doesNotMatch(bad.stderr, /relay: NIP-11/);
});

test("health: плагин политики молчит (relay поднялся, но отвергал бы все записи) -> провал", () => {
	const sb = sandbox();
	sb.stub("docker", "cat >/dev/null; exit 0"); // ничего не ответил
	sb.stub("curl", 'case "$*" in *nostr+json*) echo \'{"name":"ugolok"}\';; *) true;; esac');
	const res = run("island-health.sh", ["prod"], sb.env({ HEALTH_TIMEOUT: "1", HEALTH_INTERVAL: "0" }));
	assert.equal(res.status, 1);
	assert.match(res.stderr, /плагин политики не отвечает/);
});

const BLOSSOM_CFG = `access_control_rules:
  - action: "ALLOW"
    pubkey: "ALL"
    resource: "UPLOAD"
  - action: "ALLOW"
    pubkey: "ALL"
    resource: "GET"
`;

function watchdogBox(extra = {}) {
	const sb = sandbox();
	const island = join(sb.root, "island");
	mkdirSync(join(island, "policy-conf"), { recursive: true });
	writeFileSync(join(island, "blossom-config.yml"), BLOSSOM_CFG);
	const calls = join(sb.root, "docker.calls");
	sb.stub("docker", `echo "$@" >>"${calls}"`);
	const data = join(sb.root, "data");
	mkdirSync(data, { recursive: true });
	const env = sb.env({ ISLAND_DATA: data, ISLAND_DIR: island, WATCHDOG_STATE: join(sb.root, "state"), ...extra });
	return { sb, island, calls, env };
}

test("watchdog: диск выше порога -> policy.lock и UPLOAD=DENY (GET не тронут), blossom перезапущен; --release всё возвращает", () => {
	const { island, calls, env } = watchdogBox({ CUT_PCT: "0", WARN_PCT: "0" });
	const res = run("island-watchdog.sh", [], env);
	assert.equal(res.status, 0, res.stderr);
	assert.ok(existsSync(join(island, "policy-conf/policy.lock")), "relay уходит в read-only через маркер");
	const cfg = readFileSync(join(island, "blossom-config.yml"), "utf8");
	assert.match(cfg, /action: "DENY"\n\s+pubkey: "ALL"\n\s+resource: "UPLOAD"/);
	assert.match(cfg, /action: "ALLOW"\n\s+pubkey: "ALL"\n\s+resource: "GET"/, "скачивание продолжает работать");
	assert.match(readFileSync(calls, "utf8"), /restart ugolok-blossom/);

	// повторный проход рубильник не дёргает заново
	const before = readFileSync(calls, "utf8");
	run("island-watchdog.sh", [], env);
	assert.equal(readFileSync(calls, "utf8"), before);

	assert.equal(run("island-watchdog.sh", ["--release"], env).status, 0);
	assert.equal(existsSync(join(island, "policy-conf/policy.lock")), false);
	assert.equal(readFileSync(join(island, "blossom-config.yml"), "utf8"), BLOSSOM_CFG);
});

test("watchdog: --reapply после деплоя, перезаписавшего конфиг, возвращает закрытые загрузки", () => {
	const { island, env } = watchdogBox({ CUT_PCT: "0", WARN_PCT: "0" });
	run("island-watchdog.sh", [], env);
	writeFileSync(join(island, "blossom-config.yml"), BLOSSOM_CFG); // «деплой» вернул ALLOW
	run("island-watchdog.sh", ["--reapply"], env);
	assert.match(readFileSync(join(island, "blossom-config.yml"), "utf8"), /action: "DENY"\n\s+pubkey: "ALL"\n\s+resource: "UPLOAD"/);
});

test("watchdog: диск в норме -> ничего не закрывает, но пишет строку с цифрами в журнал", () => {
	const { island, env } = watchdogBox({ CUT_PCT: "101", WARN_PCT: "101" });
	assert.equal(run("island-watchdog.sh", [], env).status, 0);
	assert.equal(existsSync(join(island, "policy-conf/policy.lock")), false);
	const log = readFileSync(join(env.WATCHDOG_STATE, "watchdog.log"), "utf8").trim().split("\n");
	const row = JSON.parse(log.at(-1));
	assert.equal(typeof row.diskUsedPct, "number");
	assert.equal(row.cut, false);
});

test("плагин политики: policy.lock -> запись клиентов закрыта без правки JSON", () => {
	const dir = mkdtempSync(join(tmpdir(), "conf-"));
	writeFileSync(join(dir, "whitelist.json"), '["*"]');
	const req = JSON.stringify({ type: "new", event: { id: "e".repeat(64), pubkey: "a".repeat(64), kind: 1, content: "" }, sourceType: "IP4", sourceInfo: "203.0.113.1" });
	const ask = () => spawnSync("node", [resolve("server/strfry/whitelist-plugin.mjs")], { input: req + "\n", env: { ...process.env, POLICY_CONF_DIR: dir }, encoding: "utf8", timeout: 5000 });
	const open = ask();
	assert.match(open.stdout, /"action":"accept"/);
	writeFileSync(join(dir, "policy.lock"), "x");
	assert.match(ask().stdout, /read-only/);
});

// Раскладка плагина ровно как её делает deploy-env.sh (код + package.json с
// "type":"module", без корневого package.json репозитория): пробный запуск на VPS
// показал, что без этого файла Node читает wordfilter.js как CommonJS.
test("плагин работает в раскладке контейнера (без package.json репозитория)", () => {
	const deploy = readFileSync(resolve("scripts/deploy-env.sh"), "utf8");
	assert.match(deploy, /printf '\{"type":"module"\}\\n' >"\$POLICY_DST\/package\.json"/);
	const root = mkdtempSync(join(tmpdir(), "layout-"));
	const dst = join(root, "policy");
	mkdirSync(join(dst, "server/strfry"), { recursive: true });
	mkdirSync(join(dst, "src/domain/discovery"), { recursive: true });
	for (const f of ["whitelist-plugin.mjs", "write-policy.mjs", "rate-limit.mjs"]) writeFileSync(join(dst, "server/strfry", f), readFileSync(resolve("server/strfry", f)));
	for (const f of ["wordfilter.js", "stopwords.json"]) writeFileSync(join(dst, "src/domain/discovery", f), readFileSync(resolve("src/domain/discovery", f)));
	writeFileSync(join(dst, "package.json"), '{"type":"module"}\n');
	const conf = join(root, "conf");
	mkdirSync(conf);
	writeFileSync(join(conf, "whitelist.json"), '["*"]');
	const req = JSON.stringify({ type: "new", event: { id: "e".repeat(64), pubkey: "a".repeat(64), kind: 1, content: "" }, sourceType: "IP4", sourceInfo: "203.0.113.1" });
	// запуск из чужого cwd — как это делает strfry
	const res = spawnSync("node", [join(dst, "server/strfry/whitelist-plugin.mjs")], { input: req + "\n", cwd: root, env: { ...process.env, POLICY_CONF_DIR: conf }, encoding: "utf8", timeout: 5000 });
	assert.match(res.stdout, /"action":"accept"/, res.stderr);
});
