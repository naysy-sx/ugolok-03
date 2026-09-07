import { test } from "node:test";
import assert from "node:assert/strict";

// call-trace.js читает sessionStorage/localStorage как голые глобалы (не
// window.sessionStorage) — в node:test их нет по умолчанию, поэтому без этих
// шимов isTraceEnabled() всегда false и record() всегда no-op (что само по
// себе тоже проверяется ниже, отдельным тестом).
function makeStorage() {
	const map = new Map();
	return {
		getItem: (k) => (map.has(k) ? map.get(k) : null),
		setItem: (k, v) => map.set(k, String(v)),
		removeItem: (k) => map.delete(k),
		clear: () => map.clear(),
	};
}

globalThis.sessionStorage = makeStorage();
globalThis.localStorage = makeStorage();

const { record, getRows, isTraceEnabled, setTraceEnabled, resetTraceForTests, getTraceStats } = await import(
	"../src/core/diag/call-trace.js"
);

test.beforeEach(() => {
	resetTraceForTests();
	setTraceEnabled(false);
	globalThis.localStorage.clear();
});

// persistTimerId — реальный setInterval (unref()'нут, но лучше не полагаться
// на это в тесте) — на случай, если этот файл когда-нибудь запустят не
// последним, чистим и после всех тестов тоже.
test.after(() => {
	resetTraceForTests();
	setTraceEnabled(false);
});

test("isTraceEnabled(): false по умолчанию", () => {
	assert.equal(isTraceEnabled(), false);
});

test("record(): при выключенном флаге ничего не пишет (TZ §0.4)", () => {
	record("icecandidate", { address: "203.0.113.7" });
	assert.deepEqual(getRows(), []);
	assert.equal(globalThis.localStorage.getItem("ugolok.diag.trace.v1"), null);
});

test("record(): при включённом флаге пишет запись с t/mono/sid/ev", () => {
	setTraceEnabled(true);
	record("negotiationneeded", {});
	const rows = getRows();
	assert.equal(rows.length, 1);
	assert.equal(rows[0].ev, "negotiationneeded");
	assert.equal(typeof rows[0].t, "string");
	assert.equal(typeof rows[0].mono, "number");
	assert.equal(typeof rows[0].sid, "string");
});

test("record(): маскирует IPv4-адрес до /24 (TZ §4)", () => {
	setTraceEnabled(true);
	record("icecandidate", { address: "203.0.113.42", candidateType: "srflx" });
	assert.equal(getRows()[0].address, "203.0.113.0/24");
	assert.equal(getRows()[0].candidateType, "srflx"); // остальные поля не тронуты
});

test("record(): усекает публичные ключи до 8 символов", () => {
	setTraceEnabled(true);
	record("edge-state", { peer: "abcdef0123456789fedcba", peerPubkey: "0011223344556677" });
	const row = getRows()[0];
	assert.equal(row.peer, "abcdef01…");
	assert.equal(row.peerPubkey, "00112233…");
});

test("record(): никогда не пропускает запрещённые поля (TZ §4), даже если их передали", () => {
	setTraceEnabled(true);
	record("command", { name: "SEND_OFFER", privKey: "секрет", staticAuthSecret: "секрет", credential: "секрет", sdp: "v=0...полный текст", content: "текст сообщения" });
	const row = getRows()[0];
	assert.equal(row.privKey, undefined);
	assert.equal(row.staticAuthSecret, undefined);
	assert.equal(row.credential, undefined);
	assert.equal(row.sdp, undefined);
	assert.equal(row.content, undefined);
	assert.equal(row.name, "SEND_OFFER"); // разрешённое поле осталось
});

test("record(): вложенный объект тоже санитизируется", () => {
	setTraceEnabled(true);
	record("stats", { pair: { address: "198.51.100.9", ok: true } });
	assert.equal(getRows()[0].pair.address, "198.51.100.0/24");
	assert.equal(getRows()[0].pair.ok, true);
});

test("кольцевой буфер не растёт сверх 5000 записей (TZ §3)", () => {
	setTraceEnabled(true);
	for (let i = 0; i < 5010; i++) record("x", { i });
	const rows = getRows();
	assert.equal(rows.length, 5000);
	assert.equal(rows[0].i, 10); // десять самых старых отброшены
	assert.equal(rows[rows.length - 1].i, 5009);
});

test("восстановление буфера после 'перезагрузки' — page-reload виден в записи (TZ §3)", () => {
	setTraceEnabled(true);
	globalThis.localStorage.setItem(
		"ugolok.diag.trace.v1",
		JSON.stringify([{ t: "2026-01-01T00:00:00.000Z", mono: 0, sid: "prev-session", ev: "created", pc: "p1" }]),
	);
	// resetTraceForTests() здесь имитирует именно "новая загрузка вкладки"
	// (restoredThisLoad сброшен в false) — НЕ обычный сброс между тестами.
	resetTraceForTests();
	record("statechange", { iceConnectionState: "checking" });
	const rows = getRows();
	assert.equal(rows.length, 3);
	assert.equal(rows[0].ev, "created");
	assert.equal(rows[0].sid, "prev-session");
	assert.equal(rows[1].ev, "page-reload");
	assert.equal(rows[2].ev, "statechange");
});

test("getTraceStats(): count/fromT/toT по текущему буферу", () => {
	setTraceEnabled(true);
	assert.deepEqual(getTraceStats(), { count: 0, fromT: null, toT: null });
	record("a", {});
	record("b", {});
	const stats = getTraceStats();
	assert.equal(stats.count, 2);
	assert.equal(typeof stats.fromT, "string");
	assert.equal(typeof stats.toT, "string");
});

test("setTraceEnabled(false): выключение не трогает уже накопленные rows в памяти, но новые записи перестают идти", () => {
	setTraceEnabled(true);
	record("a", {});
	setTraceEnabled(false);
	record("b", {});
	assert.equal(getRows().length, 1);
	assert.equal(getRows()[0].ev, "a");
});
