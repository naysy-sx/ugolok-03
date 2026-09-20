import { test } from "node:test";
import assert from "node:assert/strict";
import { makeAdd, makeTarget, makeDel, sanitizeOp, foldOps, groupRows, classOfName } from "../src/domain/uploads/records.js";
import { appendOps, dayKey, batchId, parseBatchId, devShort, BATCH_MAX_OPS, buildBatchEvent, parseBatchEvent, JOURNAL_KIND, journalPubkey } from "../src/domain/uploads/batches.js";
import { deriveMasterSecret, deriveJournalKey, deriveJournalSigner } from "../src/core/crypto/derivation.js";
import { getPublicKey } from "../src/core/crypto/keys.js";
import { bytesToHex } from "@noble/hashes/utils.js";

const H = (n) => n.toString(16).padStart(64, "0");
const T0 = Date.UTC(2026, 8, 20, 10, 0, 0);

function add(n, over = {}) {
	return makeAdd({ hash: H(n), size: 100 + n, role: "content", purpose: "dm", target: "peer1", group: "g" + n, name: `f${n}.jpg`, server: "https://b", ...over }, T0 + n);
}

test("makeAdd: невалидное -> null, лишнее обрезается", () => {
	assert.equal(makeAdd({ hash: "zz", size: 1, role: "content", purpose: "dm" }), null);
	assert.equal(makeAdd({ hash: H(1), size: -1, role: "content", purpose: "dm" }), null);
	assert.equal(makeAdd({ hash: H(1), size: 1, role: "bogus", purpose: "dm" }), null);
	assert.equal(makeAdd({ hash: H(1), size: 1, role: "content", purpose: "bogus" }), null);
	const op = makeAdd({ hash: H(1), size: 1, role: "content", purpose: "dm", name: "x".repeat(500) });
	assert.equal(op.name.length, 120);
	assert.match(op.group, /^[0-9a-f]{16}$/);
});

test("foldOps: повторная заливка того же хеша не дублирует, обновляет at и дополняет цели", () => {
	const a = add(1);
	const again = { ...add(1), at: T0 + 5000, target: "peer2", group: "other" };
	const rows = foldOps([a, again]);
	assert.equal(rows.size, 1);
	const r = rows.get(H(1));
	assert.equal(r.at, T0 + 5000);
	assert.deepEqual(r.targets, ["peer1", "peer2"]);
	assert.equal(r.group, "g1", "группа остаётся от первой заливки");
});

test("foldOps: target добавляет цель без дублей; del удаляет; add после del воскрешает", () => {
	const ops = [add(1), makeTarget(H(1), "chan1", T0 + 10), makeTarget(H(1), "chan1", T0 + 11), makeDel(H(1), T0 + 20)];
	assert.equal(foldOps(ops).size, 0);
	const revived = foldOps([...ops, { ...add(1), at: T0 + 30 }]);
	assert.equal(revived.size, 1);
	assert.deepEqual(revived.get(H(1)).targets, ["peer1"], "воскресшая запись не тянет старые цели");
	const keep = foldOps([add(1), makeTarget(H(1), "chan1", T0 + 10), makeTarget(H(1), "chan1", T0 + 11)]);
	assert.deepEqual(keep.get(H(1)).targets, ["peer1", "chan1"]);
});

test("foldOps: результат не зависит от порядка операций в массиве", () => {
	const ops = [add(1), add(2), makeTarget(H(1), "c", T0 + 100), makeDel(H(2), T0 + 200)];
	const a = [...foldOps(ops).keys()].sort();
	const b = [...foldOps([...ops].reverse()).keys()].sort();
	assert.deepEqual(a, b);
	assert.deepEqual(a, [H(1)]);
});

test("sanitizeOp: чужой мусор отбрасывается", () => {
	assert.equal(sanitizeOp(null), null);
	assert.equal(sanitizeOp({ op: "boom" }), null);
	assert.equal(sanitizeOp({ op: "del", hash: "nope" }), null);
	assert.ok(sanitizeOp({ op: "del", hash: H(3), at: 5 }));
});

test("groupRows: четыре блоба одного вложения — одна группа, имя от content, цели объединены", () => {
	const g = "abc";
	const rows = [...foldOps([
		add(1, { group: g, role: "content", name: "video.mp4", size: 40_000_000 }),
		add(2, { group: g, role: "manifest", name: "video.mp4", size: 900 }),
		add(3, { group: g, role: "preview", name: "preview.jpg", size: 12_000 }),
		add(4, { group: g, role: "previewManifest", name: "preview.jpg", size: 300, target: "peer2" }),
	]).values()];
	const groups = groupRows(rows);
	assert.equal(groups.size, 1);
	const one = groups.get(g);
	assert.equal(one.rows.length, 4);
	assert.equal(one.size, 40_000_000 + 900 + 12_000 + 300);
	assert.equal(one.name, "video.mp4");
	assert.deepEqual(one.targets.sort(), ["peer1", "peer2"]);
});

test("classOfName", () => {
	assert.equal(classOfName("отпуск.MP4"), "video");
	assert.equal(classOfName("a.jpeg"), "image");
	assert.equal(classOfName("voice.webm"), "video", "webm неоднозначен — считаем видео; голос помечен purpose/role, а не расширением");
	assert.equal(classOfName("отчёт.pdf"), "document");
	assert.equal(classOfName("noext"), "other");
	assert.equal(classOfName(undefined), "other");
});

test("batchId/parseBatchId и devShort", () => {
	assert.equal(devShort("0123456789abcdef0123456789abcdef"), "01234567");
	const d = batchId("2026-09-20", "01234567", 3);
	assert.equal(d, "uploads-2026-09-20-01234567-3");
	assert.deepEqual(parseBatchId(d), { day: "2026-09-20", dev: "01234567", seq: 3 });
	assert.equal(parseBatchId("settings"), null);
});

test("appendOps: пачка закрывается на 100-й операции, открывается новая", () => {
	const batches = [];
	const ops = Array.from({ length: BATCH_MAX_OPS + 1 }, (_, i) => add(i + 1));
	appendOps(batches, ops, { dev: "aaaaaaaa", now: T0 });
	assert.equal(batches.length, 2);
	assert.equal(batches[0].ops.length, 100);
	assert.equal(batches[0].closed, true);
	assert.equal(batches[1].ops.length, 1);
	assert.equal(batches[1].closed, false);
	assert.equal(batches[1].seq, 2);
});

test("appendOps: на новые сутки открытая пачка закрывается, начинается новая", () => {
	const batches = [];
	appendOps(batches, [add(1)], { dev: "aaaaaaaa", now: T0 });
	const touched = appendOps(batches, [add(2)], { dev: "aaaaaaaa", now: T0 + 26 * 3600 * 1000 });
	assert.equal(batches.length, 2);
	assert.equal(batches[0].closed, true);
	assert.equal(batches[0].dirty, true);
	assert.equal(batches[1].day, dayKey(T0 + 26 * 3600 * 1000));
	assert.equal(touched.size, 2);
});

test("appendOps: пачки разных устройств не пересекаются", () => {
	const batches = [];
	appendOps(batches, [add(1)], { dev: "aaaaaaaa", now: T0 });
	appendOps(batches, [add(2)], { dev: "bbbbbbbb", now: T0 });
	assert.equal(batches.length, 2);
	assert.notEqual(batches[0].d, batches[1].d);
});

test("appendOps: пачка не разрастается по байтам сверх лимита события", () => {
	const batches = [];
	const long = "я".repeat(120);
	const ops = Array.from({ length: 90 }, (_, i) => add(i + 1, { name: long + i, target: "t".repeat(190) }));
	appendOps(batches, ops, { dev: "aaaaaaaa", now: T0 });
	for (const b of batches) assert.ok(new TextEncoder().encode(JSON.stringify(b.ops)).length <= 28_000);
	assert.ok(batches.length > 1, "по байтам должно было разбить раньше 100 операций");
});

test("событие пачки: подписано производным ключом, читается только владельцем, чужое отвергается", () => {
	const priv = new Uint8Array(32).fill(7);
	const master = deriveMasterSecret(priv);
	const key = deriveJournalKey(master);
	const signer = deriveJournalSigner(master);
	const jpub = journalPubkey(signer);
	assert.notEqual(jpub, bytesToHex(getPublicKey(priv)), "автор журнала — не основной ключ");

	const batch = { d: batchId("2026-09-20", "aaaaaaaa", 1), ops: [add(1), add(2)], closed: true };
	const ev = buildBatchEvent(batch, key, signer, 1_800_000_000);
	assert.equal(ev.kind, JOURNAL_KIND);
	assert.equal(ev.pubkey, jpub);
	assert.ok(ev.content.length < 60_000);
	assert.equal(ev.content.includes("f1.jpg"), false, "имя файла не должно быть видно в открытом виде");

	const parsed = parseBatchEvent(ev, key, jpub);
	assert.equal(parsed.ops.length, 2);
	assert.equal(parsed.closed, true);
	assert.equal(parsed.createdAt, 1_800_000_000);

	const otherKey = deriveJournalKey(deriveMasterSecret(new Uint8Array(32).fill(8)));
	assert.equal(parseBatchEvent(ev, otherKey, jpub), null, "чужой ключ расшифровки");
	assert.equal(parseBatchEvent(ev, key, "f".repeat(64)), null, "чужой автор");
	assert.equal(parseBatchEvent({ ...ev, content: "!!!" }, key, jpub), null, "битый шифротекст");
	assert.equal(parseBatchEvent({ ...ev, kind: 1 }, key, jpub), null);
});
