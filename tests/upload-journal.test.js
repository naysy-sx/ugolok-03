import "fake-indexeddb/auto";
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { bindJournal, unbindJournal, recordUploads, addTargetToGroupOf, removeUploads, listUploads, findBySourceDigest, flushJournal, pullJournal, getJournalSync, isJournalBound } from "../src/domain/uploads/journal.js";
import { groupRows } from "../src/domain/uploads/records.js";
import { JOURNAL_KIND, BATCH_MAX_OPS } from "../src/domain/uploads/batches.js";
import { deriveMasterSecret, deriveDbKey, deriveJournalKey, deriveJournalSigner } from "../src/core/crypto/derivation.js";
import { db } from "../src/core/store/database.js";
import { getPublicKey } from "../src/core/crypto/keys.js";
import { bytesToHex } from "@noble/hashes/utils.js";

const PRIV = new Uint8Array(32).fill(21);
const OWNER = bytesToHex(getPublicKey(PRIV));
const MASTER = deriveMasterSecret(PRIV);
const DBKEY = deriveDbKey(MASTER);
const JKEY = deriveJournalKey(MASTER);
const JSIGN = deriveJournalSigner(MASTER);
const DEV_A = "aaaaaaaa11111111aaaaaaaa11111111";
const DEV_B = "bbbbbbbb22222222bbbbbbbb22222222";
const H = (n) => n.toString(16).padStart(64, "0");
const T0 = Date.UTC(2026, 8, 20, 12, 0, 0);

// «relay»: хранит замещаемые события по (pubkey, kind, d)
function makeRelay() {
	const store = new Map();
	const relay = {
		published: [],
		fetchCalls: [],
		publish: async (ev) => {
			relay.published.push(ev);
			const d = ev.tags.find((t) => t[0] === "d")[1];
			const key = `${ev.pubkey}:${ev.kind}:${d}`;
			const prev = store.get(key);
			if (!prev || ev.created_at > prev.created_at) store.set(key, ev);
			return { ok: true };
		},
		fetchEvents: async (filter) => {
			relay.fetchCalls.push(filter);
			let evs = [...store.values()].filter((e) => filter.authors.includes(e.pubkey) && filter.kinds.includes(e.kind));
			if (filter.since !== undefined) evs = evs.filter((e) => e.created_at >= filter.since);
			if (filter.until !== undefined) evs = evs.filter((e) => e.created_at <= filter.until);
			evs.sort((a, b) => b.created_at - a.created_at);
			if (filter.limit) evs = evs.slice(0, filter.limit);
			return evs;
		},
	};
	return relay;
}

let clock;
function bind(deviceId, relay) {
	bindJournal({ ownerPubkey: OWNER, dbKey: DBKEY, journalKey: JKEY, journalSigner: JSIGN, deviceId, publish: relay.publish, now: () => clock, flushDelayMs: 3_600_000 });
}

async function wipeLocal() {
	unbindJournal();
	await db.table("uploads").clear();
	await db.table("uploadBatches").clear();
	await db.table("uploadSync").clear();
	await db.table("uploadFreed").clear();
}

beforeEach(async () => {
	clock = T0;
	await wipeLocal();
});

const attachment = (base, over = {}) => {
	const g = over.group ?? "grp" + base;
	return [
		{ hash: H(base), size: 40_000_000, role: "content", purpose: "dm", target: "peerA", group: g, name: "video.mp4", server: "https://b", ...over },
		{ hash: H(base + 1), size: 900, role: "manifest", purpose: "dm", target: "peerA", group: g, name: "video.mp4", server: "https://b", ...over },
		{ hash: H(base + 2), size: 12_000, role: "preview", purpose: "dm", target: "peerA", group: g, name: "preview.jpg", server: "https://b", ...over },
		{ hash: H(base + 3), size: 300, role: "previewManifest", purpose: "dm", target: "peerA", group: g, name: "preview.jpg", server: "https://b", ...over },
	];
};

test("без bindJournal всё — no-op и не бросает", async () => {
	assert.equal(isJournalBound(), false);
	await recordUploads(attachment(1));
	await addTargetToGroupOf(H(1), "x");
	assert.deepEqual(await listUploads(), []);
	assert.deepEqual(await removeUploads([H(1)]), { ok: true });
	assert.equal(await flushJournal(), 0);
});

test("1. отправка файла с превью: четыре записи с одним group, верные purpose и target", async () => {
	const relay = makeRelay();
	bind(DEV_A, relay);
	await recordUploads(attachment(1));
	const rows = await listUploads();
	assert.equal(rows.length, 4);
	assert.equal(new Set(rows.map((r) => r.group)).size, 1);
	assert.deepEqual(rows.map((r) => r.role).sort(), ["content", "manifest", "preview", "previewManifest"]);
	assert.ok(rows.every((r) => r.purpose === "dm" && r.targets[0] === "peerA"));
	const content = rows.find((r) => r.role === "content");
	assert.equal(content.name, "video.mp4");
	assert.equal(content.size, 40_000_000);
});

test("имена и цели в IndexedDB зашифрованы", async () => {
	bind(DEV_A, makeRelay());
	await recordUploads(attachment(1));
	const raw = JSON.stringify(await db.table("uploads").toArray());
	assert.equal(raw.includes("video.mp4"), false);
	assert.equal(raw.includes("peerA"), false);
	const rawB = JSON.stringify(await db.table("uploadBatches").toArray());
	assert.equal(rawB.includes("video.mp4"), false);
});

test("2. тот же файл вторым сообщением: новых записей нет, target дополнен у всей группы", async () => {
	bind(DEV_A, makeRelay());
	await recordUploads(attachment(1));
	clock += 60_000;
	await addTargetToGroupOf(H(1), "peerB");
	const rows = await listUploads();
	assert.equal(rows.length, 4);
	assert.ok(rows.every((r) => r.targets.includes("peerA") && r.targets.includes("peerB")));
	// повтор той же цели ничего не меняет
	await addTargetToGroupOf(H(1), "peerB");
	assert.ok((await listUploads()).every((r) => r.targets.length === 2));
});

test("повторная заливка того же хеша: не дублируется, at обновляется, цель добавляется", async () => {
	bind(DEV_A, makeRelay());
	await recordUploads(attachment(1));
	clock += 5000;
	await recordUploads([{ hash: H(1), size: 40_000_000, role: "content", purpose: "channel", target: "chan1", group: "новая", name: "video.mp4" }]);
	const rows = await listUploads();
	assert.equal(rows.length, 4);
	const r = rows.find((x) => x.hash === H(1));
	assert.equal(r.at, clock);
	assert.deepEqual(r.targets.sort(), ["chan1", "peerA"]);
	assert.equal(r.group, "grp1");
});

test("3. тот же файл заново с диска в другую беседу: четыре НОВЫЕ записи (другие блобы)", async () => {
	bind(DEV_A, makeRelay());
	await recordUploads(attachment(1));
	await recordUploads(attachment(10, { target: "peerB" }));
	const rows = await listUploads();
	assert.equal(rows.length, 8);
	assert.equal(groupRows(rows).size, 2);
});

test("4. сто одна заливка: пачка закрылась, открылась новая", async () => {
	bind(DEV_A, makeRelay());
	for (let i = 1; i <= BATCH_MAX_OPS + 1; i++) await recordUploads([{ hash: H(i), size: i, role: "content", purpose: "files", target: "f", group: "g" + i }]);
	const batches = await db.table("uploadBatches").toArray();
	assert.equal(batches.length, 2);
	assert.equal(batches.filter((b) => b.closed).length, 1);
	assert.equal((await listUploads()).length, BATCH_MAX_OPS + 1);
});

test("публикация: событие подписано производным ключом, содержимое не раскрывает имён; закрытая пачка после публикации не пере-публикуется", async () => {
	const relay = makeRelay();
	bind(DEV_A, relay);
	await recordUploads(attachment(1));
	assert.equal(await flushJournal(), 1);
	const ev = relay.published[0];
	assert.equal(ev.kind, JOURNAL_KIND);
	assert.notEqual(ev.pubkey, OWNER);
	assert.equal(ev.content.includes("video"), false);
	assert.equal(await flushJournal(), 0, "ничего не изменилось — публиковать нечего");
	clock += 1000;
	await recordUploads([{ hash: H(50), size: 1, role: "content", purpose: "files", target: "x", group: "z" }]);
	assert.equal(await flushJournal(), 1);
	assert.ok(relay.published[1].created_at > relay.published[0].created_at || relay.published[1].tags[0][1] !== relay.published[0].tags[0][1]);
});

test("5/6/7. новое устройство: догрузка только по требованию, постранично, повторно не качает", async () => {
	const relay = makeRelay();
	bind(DEV_A, relay);
	// 250 заливок -> 3 пачки (100, 100, 50), у каждой свой created_at
	for (let i = 1; i <= 250; i++) {
		clock += 1000;
		await recordUploads([{ hash: H(i), size: i, role: "content", purpose: "files", target: "f", group: "g" + i, name: `f${i}.jpg` }]);
		if (i % 100 === 0 || i === 250) await flushJournal();
	}
	assert.equal(relay.published.length, 3);

	// «второе устройство»: чистая локальная база, тот же аккаунт
	await wipeLocal();
	const relay2Fetches = relay.fetchCalls.length;
	bind(DEV_B, relay);
	assert.equal(relay.fetchCalls.length, relay2Fetches, "привязка журнала не ходит на relay (стартовая синхронизация свободна)");
	assert.deepEqual(await listUploads(), [], "до открытия экрана хранилища записей нет");

	const p1 = await pullJournal({ fetchEvents: relay.fetchEvents, pageSize: 2, maxPages: 1 });
	assert.equal(p1.pages, 1);
	assert.equal(p1.exhausted, false);
	assert.equal(p1.merged, 2);
	const afterFirst = (await listUploads()).length;
	assert.ok(afterFirst > 0 && afterFirst < 250, "первая страница: самые новые пачки");

	const p2 = await pullJournal({ fetchEvents: relay.fetchEvents, pageSize: 2, maxPages: 5 });
	assert.equal(p2.exhausted, true);
	assert.equal((await listUploads()).length, 250);
	const sync = await getJournalSync();
	assert.equal(sync.exhausted, true);

	// 7. повторное открытие: старые пачки не выкачиваются — только «новое с отметки»
	relay.fetchCalls.length = 0;
	const p3 = await pullJournal({ fetchEvents: relay.fetchEvents, pageSize: 2 });
	assert.equal(p3.pages, 0);
	assert.equal(relay.fetchCalls.length, 1);
	assert.ok(relay.fetchCalls[0].since > 0 && relay.fetchCalls[0].limit === undefined);
	assert.equal((await listUploads()).length, 250);
});

test("8. одновременные заливки с двух устройств: обе видны на обоих, ничего не потеряно", async () => {
	const relay = makeRelay();
	// устройство A
	bind(DEV_A, relay);
	await recordUploads(attachment(1, { target: "peerA" }));
	await flushJournal();
	// устройство B (чистая база) пишет своё, не зная про A
	await wipeLocal();
	bind(DEV_B, relay);
	await recordUploads(attachment(100, { target: "peerB" }));
	await flushJournal();
	// у B догрузка видит и A, и своё
	await pullJournal({ fetchEvents: relay.fetchEvents });
	const onB = (await listUploads()).map((r) => r.hash).sort();
	assert.equal(onB.length, 8);
	// вернулись на A: локальная база A пустая (имитация), догрузка даёт то же
	await wipeLocal();
	bind(DEV_A, relay);
	await pullJournal({ fetchEvents: relay.fetchEvents });
	assert.deepEqual((await listUploads()).map((r) => r.hash).sort(), onB);
	// разные d -> замещаемые события не затирают друг друга
	const ds = new Set(relay.published.map((e) => e.tags[0][1]));
	assert.ok([...ds].some((d) => d.includes("aaaaaaaa")) && [...ds].some((d) => d.includes("bbbbbbbb")));
});

test("10. освобождение места: записи убраны, закрытая пачка переписана без них, второе устройство видит удаление", async () => {
	const relay = makeRelay();
	bind(DEV_A, relay);
	await recordUploads(attachment(1));
	await recordUploads(attachment(10));
	// закрываем пачку сутками позже, чтобы она стала «закрытой»
	clock += 26 * 3600 * 1000;
	await recordUploads(attachment(20));
	await flushJournal();
	const closed = (await db.table("uploadBatches").toArray()).filter((b) => b.closed);
	assert.equal(closed.length, 1);
	const publishedBefore = relay.published.length;

	const res = await removeUploads([H(1), H(2), H(3), H(4)]);
	assert.equal(res.ok, true);
	assert.equal((await listUploads()).length, 8);
	assert.equal(await flushJournal(), 1, "закрытая пачка переписана");
	assert.equal(relay.published.length, publishedBefore + 1);
	const rewritten = relay.published.at(-1);
	assert.equal(rewritten.tags[0][1], closed[0].d);

	// второе устройство
	await wipeLocal();
	bind(DEV_B, relay);
	await pullJournal({ fetchEvents: relay.fetchEvents });
	const hashes = (await listUploads()).map((r) => r.hash);
	assert.equal(hashes.includes(H(1)), false);
	assert.equal(hashes.length, 8);
});

test("удаление записей из пачки ДРУГОГО устройства: надгробие в своей пачке", async () => {
	const relay = makeRelay();
	bind(DEV_A, relay);
	await recordUploads(attachment(1));
	await flushJournal();
	await wipeLocal();
	bind(DEV_B, relay);
	await pullJournal({ fetchEvents: relay.fetchEvents });
	assert.equal((await listUploads()).length, 4);
	clock += 1000;
	await removeUploads([H(1), H(2), H(3), H(4)]);
	assert.equal((await listUploads()).length, 0);
	await flushJournal();
	// устройство A догружает и тоже видит удаление
	await wipeLocal();
	bind(DEV_A, relay);
	await pullJournal({ fetchEvents: relay.fetchEvents });
	assert.equal((await listUploads()).length, 0, "надгробие из пачки B скрывает записи пачки A");
});

test("11. findBySourceDigest: копия «сохранить к себе» находится по исходному манифесту", async () => {
	bind(DEV_A, makeRelay());
	await recordUploads([{ hash: H(9), size: 5, role: "manifest", purpose: "files", target: "node1", group: "cp", name: "a.pdf", sourceDigest: H(77) }]);
	const found = await findBySourceDigest(H(77));
	assert.equal(found.hash, H(9));
	assert.equal(await findBySourceDigest(H(78)), null);
});

test("ошибка публикации оставляет пачку грязной — следующий сброс повторит", async () => {
	let ok = false;
	const relay = makeRelay();
	bindJournal({ ownerPubkey: OWNER, dbKey: DBKEY, journalKey: JKEY, journalSigner: JSIGN, deviceId: DEV_A, publish: async (ev) => (ok ? relay.publish(ev) : { ok: false }), now: () => clock, flushDelayMs: 3_600_000 });
	await recordUploads(attachment(1));
	assert.equal(await flushJournal(), 0);
	ok = true;
	assert.equal(await flushJournal(), 1);
});

// ---- доработки после ревью ----
import { removeUploads as _rm, listFreed, getJournalStatus } from "../src/domain/uploads/journal.js";
import { mnemonicToPrivateKey } from "../src/core/crypto/mnemonic.js";
import { journalPubkey } from "../src/domain/uploads/batches.js";
import { foldFreed, makeFreed, makeAdd } from "../src/domain/uploads/records.js";

test("освобождение места ставит метку «стёрто с сервера»; она переживает очистку пачек и видна на другом устройстве", async () => {
	const relay = makeRelay();
	bind(DEV_A, relay);
	await recordUploads(attachment(1));
	clock += 26 * 3600 * 1000; // пачка с записями станет закрытой
	await recordUploads(attachment(10));
	await flushJournal();
	await _rm([H(1), H(2), H(3), H(4)], { markFreed: true });
	assert.deepEqual((await listFreed()).sort(), [H(1), H(2), H(3), H(4)].sort());
	// имена убраны из журнала, метка (без имени) осталась в пачке
	const raw = JSON.stringify(await db.table("uploadBatches").toArray());
	assert.equal(raw.includes("video.mp4"), false);
	await flushJournal();
	// второе устройство
	await wipeLocal();
	bind(DEV_B, relay);
	assert.deepEqual(await listFreed(), []);
	await pullJournal({ fetchEvents: relay.fetchEvents });
	assert.deepEqual((await listFreed()).sort(), [H(1), H(2), H(3), H(4)].sort());
	assert.equal((await listUploads()).some((r) => r.hash === H(1)), false);
});

test("повторная заливка того же хеша снимает метку «стёрто с сервера»", async () => {
	bind(DEV_A, makeRelay());
	await recordUploads(attachment(1));
	await _rm([H(1), H(2), H(3), H(4)], { markFreed: true });
	assert.equal((await listFreed()).length, 4);
	clock += 5000;
	await recordUploads([attachment(1)[0]]);
	assert.equal((await listFreed()).includes(H(1)), false);
	assert.equal((await listFreed()).includes(H(2)), true);
});

test("foldFreed: метка перекрыта только более поздним add", () => {
	const h = H(5);
	assert.equal(foldFreed([makeFreed(h, 10)]).has(h), true);
	assert.equal(foldFreed([makeFreed(h, 10), makeAdd({ hash: h, size: 1, role: "content", purpose: "dm" }, 20)]).has(h), false);
	assert.equal(foldFreed([makeAdd({ hash: h, size: 1, role: "content", purpose: "dm", at: 5 }, 5), makeFreed(h, 10)]).has(h), true);
});

test("отказ relay не молчит: причина доступна для экрана хранилища, пачка остаётся грязной", async () => {
	bindJournal({ ownerPubkey: OWNER, dbKey: DBKEY, journalKey: JKEY, journalSigner: JSIGN, deviceId: DEV_A, publish: async () => ({ ok: false, reason: "blocked: pubkey not on whitelist" }), now: () => clock, flushDelayMs: 3_600_000, flushRetryMs: 3_600_000 });
	await recordUploads(attachment(1));
	assert.deepEqual(await getJournalStatus(), { dirty: 1, lastError: null }, "до первой попытки публикации ошибки нет, пачка ждёт отправки");
	assert.equal(await flushJournal(), 0);
	const st = await getJournalStatus();
	assert.equal(st.dirty, 1);
	assert.match(st.lastError, /whitelist/);
});

test("восстановление по сид-фразе: тот же ключ-автор журнала, старые пачки читаются на «переустановленном» устройстве", async () => {
	const phrase = "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about";
	const priv1 = await mnemonicToPrivateKey(phrase);
	const priv2 = await mnemonicToPrivateKey(phrase);
	const m1 = deriveMasterSecret(priv1), m2 = deriveMasterSecret(priv2);
	assert.equal(journalPubkey(deriveJournalSigner(m1)), journalPubkey(deriveJournalSigner(m2)));
	// журнал, записанный до «переустановки», читается ключами, выведенными заново из сид-фразы
	const relay = makeRelay();
	bindJournal({ ownerPubkey: OWNER, dbKey: deriveDbKey(m1), journalKey: deriveJournalKey(m1), journalSigner: deriveJournalSigner(m1), deviceId: DEV_A, publish: relay.publish, now: () => clock, flushDelayMs: 3_600_000 });
	await recordUploads(attachment(1));
	await flushJournal();
	await wipeLocal();
	bindJournal({ ownerPubkey: OWNER, dbKey: deriveDbKey(m2), journalKey: deriveJournalKey(m2), journalSigner: deriveJournalSigner(m2), deviceId: DEV_B, publish: relay.publish, now: () => clock, flushDelayMs: 3_600_000 });
	await pullJournal({ fetchEvents: relay.fetchEvents });
	assert.equal((await listUploads()).length, 4);
});
