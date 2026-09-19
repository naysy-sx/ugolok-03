import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { decide, isMirrorSource, NEVER_MIRROR_KINDS } from "../server/strfry/write-policy.mjs";

// GATEWAY-TZ-1.md §2: политика записи различает своего и зеркало.
// Решение — чистая функция, strfry не нужен.

const OWN = "a".repeat(64);
const FOREIGN = "b".repeat(64);
const PEER_URL = "wss://peer.example";
const PEERS = { kinds: [30073, 30050], peers: [{ id: "b", name: "Инстанс Б", url: PEER_URL }] };

const ev = (pubkey, kind) => ({ id: "e".repeat(64), pubkey, kind, content: "" });
const client = (event) => ({ type: "new", event, sourceType: "IP4", sourceInfo: "203.0.113.5" });
const mirror = (event, extra = {}) => ({ type: "new", event, sourceType: "Sync", sourceInfo: PEER_URL, ...extra });
const ctx = (over = {}) => ({ whitelist: new Set([OWN]), peers: PEERS, stopwords: [], ...over });

test("1. своё событие, pubkey в whitelist → accept (поведение прежнее)", () => {
	assert.equal(decide(client(ev(OWN, 1)), ctx()).action, "accept");
	// и без peers.json вовсе, и с любым набором kind'ов — правило для своих не меняется
	assert.equal(decide(client(ev(OWN, 1)), ctx({ peers: null })).action, "accept");
});

test("2. чужое событие из клиентского сокета → reject, даже если kind разрешён для зеркала", () => {
	for (const sourceType of ["IP4", "IP6"]) {
		const res = decide({ ...client(ev(FOREIGN, 30073)), sourceType }, ctx());
		assert.equal(res.action, "reject");
		assert.match(res.msg, /whitelist/);
	}
});

test("3. чужое событие из зеркального потока, kind в списке → accept", () => {
	assert.equal(decide(mirror(ev(FOREIGN, 30050)), ctx()).action, "accept");
	assert.equal(decide(mirror(ev(FOREIGN, 30050), { sourceType: "Stream" }), ctx()).action, "accept");
	// URL пира сравнивается без учёта регистра и хвостового слэша
	assert.equal(decide(mirror(ev(FOREIGN, 30050), { sourceInfo: "WSS://Peer.Example/" }), ctx()).action, "accept");
});

test("4. чужое событие из зеркального потока, kind не в списке → reject", () => {
	const res = decide(mirror(ev(FOREIGN, 1)), ctx());
	assert.equal(res.action, "reject");
	assert.match(res.msg, /kind/);
});

test("5. peers.json отсутствует или пуст → всё зеркальное отвергается", () => {
	for (const peers of [null, {}, { kinds: [], peers: [] }, { kinds: [30050], peers: [] }, { kinds: [], peers: PEERS.peers }]) {
		assert.equal(decide(mirror(ev(FOREIGN, 30050)), ctx({ peers })).action, "reject", JSON.stringify(peers));
	}
});

test("зеркало от пира, которого нет в списке, отвергается; отключение пира правкой файла", () => {
	assert.equal(decide(mirror(ev(FOREIGN, 30050), { sourceInfo: "wss://other.example" }), ctx()).action, "reject");
	assert.equal(decide(mirror(ev(FOREIGN, 30050)), ctx({ peers: { kinds: [30050], peers: [] } })).action, "reject");
});

test("whitelist '*' (dev) не открывает зеркальный поток", () => {
	const wide = ctx({ whitelist: new Set(["*"]), peers: null });
	assert.equal(decide(client(ev(FOREIGN, 1)), wide).action, "accept", "клиентский сокет — как раньше");
	assert.equal(decide(mirror(ev(FOREIGN, 1)), wide).action, "reject");
});

test("личная переписка не зеркалируется, даже если её вписали в peers.json", () => {
	const reckless = { kinds: [...NEVER_MIRROR_KINDS], peers: [{ ...PEERS.peers[0], kinds: [...NEVER_MIRROR_KINDS] }] };
	for (const kind of NEVER_MIRROR_KINDS) {
		assert.equal(decide(mirror(ev(FOREIGN, kind)), ctx({ peers: reckless })).action, "reject", `kind ${kind}`);
	}
});

test("kinds пира перекрывают общий список", () => {
	const peers = { kinds: [30050], peers: [{ ...PEERS.peers[0], kinds: [30073] }] };
	assert.equal(decide(mirror(ev(FOREIGN, 30050)), ctx({ peers })).action, "reject");
	assert.equal(decide(mirror(ev(FOREIGN, 30073)), ctx({ peers })).action, "accept");
});

test("словарный фильтр discovery действует и на зеркальный поток", () => {
	const bad = { ...ev(FOREIGN, 30073), content: JSON.stringify({ bio: "плохоеслово" }) };
	const res = decide(mirror(bad), ctx({ stopwords: ["плохоеслово"] }));
	assert.equal(res.action, "reject");
	assert.match(res.msg, /wordlist/);
});

test("источники без sourceType (старый протокол) и Import/Stored идут по правилу для своих", () => {
	for (const sourceType of [undefined, "Import", "Stored"]) {
		assert.equal(isMirrorSource({ sourceType }), false);
	}
	assert.equal(decide({ type: "new", event: ev(FOREIGN, 1) }, ctx()).action, "reject");
	assert.equal(decide({ type: "new", event: ev(OWN, 1) }, ctx()).action, "accept");
});

// Сам плагин, реальным протоколом: в репозитории peers.json пуст, значит
// Sync-поток отвергается, а клиентский — как раньше (whitelist.json = ["*"]).
test("плагин целиком: пустой peers.json → Sync отвергнут, клиентский сокет принят", async () => {
	const HERE = dirname(fileURLToPath(import.meta.url));
	const proc = spawn("node", [join(HERE, "../server/strfry/whitelist-plugin.mjs")], { stdio: ["pipe", "pipe", "inherit"] });
	const rl = createInterface({ input: proc.stdout, terminal: false });
	const lines = [];
	const waiters = [];
	rl.on("line", (l) => (waiters.shift() ?? ((v) => lines.push(v)))(JSON.parse(l)));
	const ask = (req) =>
		new Promise((resolve) => {
			waiters.push(resolve);
			proc.stdin.write(JSON.stringify(req) + "\n");
		});
	try {
		const viaSync = await ask(mirror(ev(FOREIGN, 30050)));
		assert.equal(viaSync.action, "reject");
		const viaClient = await ask(client(ev(FOREIGN, 1)));
		assert.equal(viaClient.action, "accept");
	} finally {
		proc.kill();
	}
});
