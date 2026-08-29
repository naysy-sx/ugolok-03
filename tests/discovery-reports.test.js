import "fake-indexeddb/auto";
import { test, before, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import { db } from "../src/core/store/database.js";
import { getPublicKey } from "../src/core/crypto/keys.js";
import { bytesToHex } from "@noble/hashes/utils.js";
import { unwrap as nip59Unwrap } from "../src/core/crypto/nip59.js";
import {
	DISCOVERY_REPORT_KIND,
	buildDiscoveryReportRumor,
	reportDiscoveryProfile,
	hideDiscoveryProfileLocally,
	listHiddenDiscoveryPubkeys,
	receiveDiscoveryReport,
} from "../src/domain/discovery/reports.js";
import { fromEncryptedRow } from "../src/core/store/encrypted-table.js";

const ALICE_PRIV = new Uint8Array(32).fill(21); // репортующий
const BOB_PRIV = new Uint8Array(32).fill(22); // цель жалобы (не участвует напрямую)
const ADMIN_PRIV = new Uint8Array(32).fill(23);
const ALICE_PUB = bytesToHex(getPublicKey(ALICE_PRIV));
const BOB_PUB = bytesToHex(getPublicKey(BOB_PRIV));
const ADMIN_PUB = bytesToHex(getPublicKey(ADMIN_PRIV));
const DB_KEY = crypto.getRandomValues(new Uint8Array(32));

const capturingPublish = (bucket) => async (event) => {
	bucket.push(event);
	return { ok: true };
};

before(async () => {
	await db.open();
});

beforeEach(async () => {
	await db.table("discoveryHidden").clear();
	await db.table("discoveryReports").clear();
});

after(() => {
	db.close();
});

test("DISCOVERY_REPORT_KIND: 3010 (следующий свободный после 3001-3009)", () => {
	assert.equal(DISCOVERY_REPORT_KIND, 3010);
});

// ТЗ, тест №10 — buildDiscoveryReportRumor несёт снимок карточки и target.
test("buildDiscoveryReportRumor: несёт снимок карточки (snapshot) и target в теге", () => {
	const snapshot = { bio: "текст на момент жалобы", showChannels: true, channels: [{ id: "c1", name: "N", description: "D" }] };
	const rumor = buildDiscoveryReportRumor({ targetPubkey: BOB_PUB, reason: "spam", snapshot });

	assert.equal(rumor.kind, DISCOVERY_REPORT_KIND);
	assert.equal(rumor.tags.find((t) => t[0] === "target")[1], BOB_PUB);
	assert.equal(rumor.tags.find((t) => t[0] === "reason")[1], "spam");
	assert.deepEqual(JSON.parse(rumor.content), snapshot);
});

test("reportDiscoveryProfile: gift-wrap адресован admin, снимок и target доходят, отправитель узнаётся ТОЛЬКО через unwrap", () => {
	const published = [];
	const snapshot = { bio: "плохой текст", showChannels: false, channels: [] };
	return reportDiscoveryProfile(ALICE_PRIV, ADMIN_PUB, { targetPubkey: BOB_PUB, reason: "abuse", snapshot }, capturingPublish(published)).then(() => {
		const giftWrap = published.find((e) => e.kind === 1059);
		assert.ok(giftWrap, "жалоба уходит gift-wrap'ом, не открытым текстом");
		const rumor = nip59Unwrap(giftWrap, ADMIN_PRIV);
		assert.equal(rumor.kind, DISCOVERY_REPORT_KIND);
		assert.equal(rumor.pubkey, ALICE_PUB, "admin узнаёт РЕАЛЬНОГО отправителя жалобы");
		assert.deepEqual(JSON.parse(rumor.content), snapshot);
	});
});

// ТЗ, тест №11 — приём жалобы берёт reporterPubkey из rumor.pubkey, не из тега
// (подделанный тег игнорируется). Конвенция диспетчера (transport.js) — unwrap
// делает transport.js, домен получает уже готовые примитивы, тот же принцип,
// что receiveReport (moderation.js).
test("receiveDiscoveryReport: reporterPubkey берётся из аргумента, отражающего rumor.pubkey (диспетчер), не из чего-либо подделываемого", async () => {
	const snapshot = { bio: "текст", showChannels: false, channels: [] };
	await receiveDiscoveryReport(ADMIN_PUB, DB_KEY, {
		reporterPubkey: ALICE_PUB, // это то, что transport.js извлёк из rumor.pubkey
		targetPubkey: BOB_PUB,
		reason: "abuse",
		snapshot,
		createdAt: 1000,
	});
	const raw = await db.table("discoveryReports").where("ownerPubkey").equals(ADMIN_PUB).first();
	assert.equal(raw.reporterPubkey, ALICE_PUB);
	assert.equal(raw.targetPubkey, BOB_PUB);
	assert.equal("snapshot" in raw, false, "snapshot — чужой текст, обязан быть зашифрован, не лежать сырым в raw-дампе");

	const decrypted = fromEncryptedRow(raw, DB_KEY);
	assert.deepEqual(decrypted.snapshot, snapshot);
});

// ТЗ, тест №12 — локальное скрытие работает при недоступной сети: функция не
// принимает publish/сетевой параметр вовсе, чисто локальная запись.
test("hideDiscoveryProfileLocally: работает без какого-либо сетевого вызова (нет параметра publish)", async () => {
	await hideDiscoveryProfileLocally(ALICE_PUB, BOB_PUB);
	const hidden = await listHiddenDiscoveryPubkeys(ALICE_PUB);
	assert.deepEqual(hidden, [BOB_PUB]);
});

test("listHiddenDiscoveryPubkeys: скрытые ДРУГИМ владельцем не подмешиваются (владелец-изоляция)", async () => {
	await hideDiscoveryProfileLocally(ALICE_PUB, BOB_PUB);
	await hideDiscoveryProfileLocally(ADMIN_PUB, "someone-else");
	const hidden = await listHiddenDiscoveryPubkeys(ALICE_PUB);
	assert.deepEqual(hidden, [BOB_PUB]);
});
