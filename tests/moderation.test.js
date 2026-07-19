import "fake-indexeddb/auto";
import { test, before, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import { db } from "../src/core/store/database.js";
import { getPublicKey } from "../src/core/crypto/keys.js";
import { bytesToHex } from "@noble/hashes/utils.js";
import { unwrap as nip59Unwrap } from "../src/core/crypto/nip59.js";
import { sign } from "../src/core/crypto/sign.js";
import { encryptChannelContent } from "../src/core/crypto/channel-key.js";
import { createChannel, receiveChannelKeyGrant, receiveAllowlistUpdate } from "../src/domain/content/channel.js";
import { handleIncomingSubscribeRequest } from "../src/domain/content/channel-access.js";
import { addComment, receiveComment } from "../src/domain/content/comments.js";
import {
	CHANNEL_REPORT_KIND,
	CHANNEL_BAN_KIND,
	reportContent,
	receiveReport,
	ignoreMember,
	getIgnoredSet,
	banMember,
	receiveBanAnnouncement,
	listReports,
	markReportViewed,
	markAllReportsViewed,
	getModerationStats,
	listBannedMembers,
} from "../src/domain/content/moderation.js";

const ALICE_PRIV = new Uint8Array(32).fill(1);
const BOB_PRIV = new Uint8Array(32).fill(2);
const MALLORY_PRIV = new Uint8Array(32).fill(3);
const ALICE_PUB = bytesToHex(getPublicKey(ALICE_PRIV));
const BOB_PUB = bytesToHex(getPublicKey(BOB_PRIV));
const MALLORY_PUB = bytesToHex(getPublicKey(MALLORY_PRIV));

before(async () => {
	await db.open();
});

beforeEach(async () => {
	await db.table("channels").clear();
	await db.table("channelKeys").clear();
	await db.table("channelKeyMeta").clear();
	await db.table("commentAllowlists").clear();
	await db.table("groups").clear();
	await db.table("groupMembers").clear();
	await db.table("channelReaders").clear();
	await db.table("channelReports").clear();
	await db.table("channelIgnores").clear();
	await db.table("bannedMembers").clear();
	await db.table("comments").clear();
	await db.table("channelMessages").clear();
});

after(() => {
	db.close();
});

function capturingPublish(bucket) {
	return async (event) => {
		bucket.push(event);
		return { ok: true };
	};
}

async function setupChannel() {
	await db.table("groups").add({ owner: ALICE_PUB, id: "friends", name: "Друзья" });
	await db.table("groupMembers").add({ groupId: "friends", pubkey: BOB_PUB });
	const { channelId } = await createChannel(ALICE_PUB, ALICE_PRIV, { name: "К", description: "d", rules: "" }, ["friends"], capturingPublish([]));
	return { channelId };
}

// Боб И Mallory — оба VIEW (группа "Друзья" содержит обоих ДО создания канала, тот же
// принцип снимка-при-создании, что этап 30/31), Боб дополнительно подписан (COMMENT).
async function setupChannelWithTwoReadersOneSubscribed() {
	await db.table("groups").add({ owner: ALICE_PUB, id: "friends", name: "Друзья" });
	await db.table("groupMembers").add({ groupId: "friends", pubkey: BOB_PUB });
	await db.table("groupMembers").add({ groupId: "friends", pubkey: MALLORY_PUB });
	const aliceOutbox = [];
	const { channelId } = await createChannel(ALICE_PUB, ALICE_PRIV, { name: "К", description: "d", rules: "" }, ["friends"], capturingPublish(aliceOutbox));
	const grantEvents = aliceOutbox.filter((e) => e.kind === 30053);
	const bobGrant = grantEvents.find((e) => e.tags.find((t) => t[0] === "p")[1] === BOB_PUB);
	const malloryGrant = grantEvents.find((e) => e.tags.find((t) => t[0] === "p")[1] === MALLORY_PUB);
	await receiveChannelKeyGrant(BOB_PUB, BOB_PRIV, ALICE_PUB, bobGrant);
	await receiveChannelKeyGrant(MALLORY_PUB, MALLORY_PRIV, ALICE_PUB, malloryGrant);
	const subscribeOutbox = [];
	await handleIncomingSubscribeRequest(ALICE_PUB, ALICE_PRIV, channelId, BOB_PUB, capturingPublish(subscribeOutbox));
	// Mallory тоже должна получить обновлённый allowlist, чтобы F-EV-06 пропускал
	// комментарии Боба у неё локально (иначе тест ниже проверял бы не то, что заявлено).
	const allowlistEvent = subscribeOutbox.find((e) => e.kind === 30054);
	await receiveAllowlistUpdate(MALLORY_PUB, MALLORY_PUB, allowlistEvent);
	return { channelId };
}

test("reportContent: gift-wrap, владелец узнаёт РЕАЛЬНОГО отправителя через unwrap (не из тега)", async () => {
	const { channelId } = await setupChannel();
	const published = [];
	await reportContent(
		BOB_PRIV,
		ALICE_PUB,
		{ channelId, targetPubkey: "someone-else", contentType: "comment", contentId: "c1", contentText: "оскорбление", reason: "report" },
		capturingPublish(published),
	);

	const giftWrap = published.find((e) => e.kind === 1059);
	assert.ok(giftWrap, "жалоба — gift-wrap, не открытым текстом");
	const rumor = nip59Unwrap(giftWrap, ALICE_PRIV);
	assert.equal(rumor.kind, CHANNEL_REPORT_KIND);
	assert.equal(rumor.pubkey, BOB_PUB, "владелец узнаёт реального отправителя жалобы");
	assert.equal(rumor.content, "оскорбление");
	assert.equal(rumor.tags.find((t) => t[0] === "reason")[1], "report");
});

test("receiveReport: сохраняет жалобу локально у владельца, viewed=false по умолчанию", async () => {
	const applied = await receiveReport(ALICE_PUB, {
		reporterPubkey: BOB_PUB,
		channelId: "ch1",
		targetPubkey: "mallory-pub",
		contentType: "chat_message",
		contentId: "m1",
		contentText: "спам",
		reason: "report",
		createdAt: 1000,
	});
	assert.equal(applied, true);
	const reports = await db.table("channelReports").where("[ownerPubkey+channelId]").equals([ALICE_PUB, "ch1"]).toArray();
	assert.equal(reports.length, 1);
	assert.equal(reports[0].viewed, false);
	assert.equal(reports[0].reporterPubkey, BOB_PUB);
});

test("ignoreMember: локально добавляет в channelIgnores И отправляет авто-репорт владельцу с reason='ignore'", async () => {
	const { channelId } = await setupChannel();
	const published = [];
	await ignoreMember(
		BOB_PUB,
		BOB_PRIV,
		ALICE_PUB,
		{ channelId, targetPubkey: "mallory-pub", contentType: "comment", contentId: "c1", contentText: "грубость" },
		capturingPublish(published),
	);

	const ignored = await getIgnoredSet(BOB_PUB, channelId);
	assert.ok(ignored.has("mallory-pub"));

	const giftWrap = published.find((e) => e.kind === 1059);
	const rumor = nip59Unwrap(giftWrap, ALICE_PRIV);
	assert.equal(rumor.tags.find((t) => t[0] === "reason")[1], "ignore", "игнор порождает авто-репорт с reason=ignore");
	assert.equal(rumor.content, "грубость", "контекст (текст сообщения) передаётся владельцу");
});

test("getIgnoredSet: не путает каналы и владельцев (owner-scoped)", async () => {
	await db.table("channelIgnores").bulkAdd([
		{ ownerPubkey: BOB_PUB, channelId: "ch1", ignoredPubkey: "x" },
		{ ownerPubkey: BOB_PUB, channelId: "ch2", ignoredPubkey: "y" },
		{ ownerPubkey: ALICE_PUB, channelId: "ch1", ignoredPubkey: "z" },
	]);
	const set = await getIgnoredSet(BOB_PUB, "ch1");
	assert.deepEqual([...set], ["x"]);
});

test("ignoreMember: повторный вызов идемпотентен локально (put по составному PK, не дублирует)", async () => {
	const { channelId } = await setupChannel();
	await ignoreMember(BOB_PUB, BOB_PRIV, ALICE_PUB, { channelId, targetPubkey: "mallory-pub", contentType: "comment", contentId: "c1", contentText: "a" }, capturingPublish([]));
	await ignoreMember(BOB_PUB, BOB_PRIV, ALICE_PUB, { channelId, targetPubkey: "mallory-pub", contentType: "comment", contentId: "c2", contentText: "b" }, capturingPublish([]));
	const rows = await db.table("channelIgnores").where("[ownerPubkey+channelId]").equals([BOB_PUB, channelId]).toArray();
	assert.equal(rows.length, 1, "один и тот же ignoredPubkey не дублируется");
});

test("banMember: ротирует channelKey, реиздаёт грант ОСТАВШЕМУСЯ читателю (Mallory), НЕ забаненному (Боб)", async () => {
	const { channelId } = await setupChannelWithTwoReadersOneSubscribed();
	const published = [];
	await banMember(ALICE_PUB, ALICE_PRIV, channelId, BOB_PUB, capturingPublish(published));

	const grants = published.filter((e) => e.kind === 30053);
	assert.equal(grants.length, 1, "новый грант — только Mallory, не Бобу");
	assert.deepEqual(grants[0].tags.find((t) => t[0] === "p"), ["p", MALLORY_PUB]);

	const meta = await db.table("channelKeyMeta").get([ALICE_PUB, channelId]);
	assert.equal(meta.currentVersion, 2, "версия ключа увеличена");

	const readers = await db.table("channelReaders").where("[ownerPubkey+channelId]").equals([ALICE_PUB, channelId]).toArray();
	assert.deepEqual(readers.map((r) => r.readerPubkey), [MALLORY_PUB], "Боб удалён из channelReaders");
});

test("banMember: переиздаёт allowlist БЕЗ забаненного (если он был подписчиком)", async () => {
	const { channelId } = await setupChannelWithTwoReadersOneSubscribed();
	const published = [];
	await banMember(ALICE_PUB, ALICE_PRIV, channelId, BOB_PUB, capturingPublish(published));

	const meta = await db.table("channelKeyMeta").get([ALICE_PUB, channelId]);
	const allowlistRow = await db.table("commentAllowlists").get([ALICE_PUB, channelId, meta.currentVersion]);
	assert.ok(allowlistRow);
	assert.ok(!allowlistRow.allowedAuthors.includes(BOB_PUB), "Боб исключён из нового allowlist");
});

test("banMember: публикует kind 30064, расшифровывается ЛЮБЫМ, у кого есть v_old (включая самого забаненного)", async () => {
	const { channelId } = await setupChannelWithTwoReadersOneSubscribed();
	const published = [];
	await banMember(ALICE_PUB, ALICE_PRIV, channelId, BOB_PUB, capturingPublish(published));

	const banEvent = published.find((e) => e.kind === CHANNEL_BAN_KIND);
	assert.ok(banEvent);
	assert.deepEqual(banEvent.tags.find((t) => t[0] === "d"), ["d", `${channelId}:ban:${BOB_PUB}`]);
});

test("receiveBanAnnouncement: у ЗАБАНЕННОГО (Боб) — канал удаляется локально целиком", async () => {
	const { channelId } = await setupChannelWithTwoReadersOneSubscribed();
	const published = [];
	await banMember(ALICE_PUB, ALICE_PRIV, channelId, BOB_PUB, capturingPublish(published));
	const banEvent = published.find((e) => e.kind === CHANNEL_BAN_KIND);

	assert.ok(await db.table("channels").get([BOB_PUB, channelId]), "у Боба канал ещё существует до обработки объявления");
	const applied = await receiveBanAnnouncement(BOB_PUB, banEvent);
	assert.equal(applied, true);
	assert.equal(await db.table("channels").get([BOB_PUB, channelId]), undefined, "канал удалён локально у забаненного");
});

test("receiveBanAnnouncement: у ОСТАЛЬНЫХ (Mallory) — канал остаётся, но контент Боба скрывается локально", async () => {
	const { channelId } = await setupChannelWithTwoReadersOneSubscribed();

	// Боб успевает опубликовать комментарий ДО бана — Mallory его получает и кэширует.
	const commentPublished = [];
	await addComment(BOB_PUB, BOB_PRIV, channelId, "post-1", "post-1", "давайте жить дружно", [], capturingPublish(commentPublished));
	const commentEvent = commentPublished.find((e) => e.kind === 30062);
	await receiveComment(MALLORY_PUB, commentEvent);
	assert.equal((await db.table("comments").where("ownerPubkey").equals(MALLORY_PUB).toArray()).length, 1);

	const published = [];
	await banMember(ALICE_PUB, ALICE_PRIV, channelId, BOB_PUB, capturingPublish(published));
	const banEvent = published.find((e) => e.kind === CHANNEL_BAN_KIND);

	const applied = await receiveBanAnnouncement(MALLORY_PUB, banEvent);
	assert.equal(applied, true);
	assert.ok(await db.table("channels").get([MALLORY_PUB, channelId]), "канал у Mallory НЕ удалён (она не забанена)");
	const comments = await db.table("comments").where("ownerPubkey").equals(MALLORY_PUB).toArray();
	assert.equal(comments[0].deleted, true, "комментарий Боба скрыт локально у Mallory");
});

test("АДВЕРСАРНЫЙ: поддельное объявление о бане (не от владельца) отклоняется", async () => {
	const { channelId } = await setupChannelWithTwoReadersOneSubscribed();
	const channelRow = await db.table("channels").get([ALICE_PUB, channelId]);
	const meta = await db.table("channelKeyMeta").get([ALICE_PUB, channelId]);
	const keyRow = await db.table("channelKeys").get([ALICE_PUB, channelId, meta.currentVersion]);

	// Mallory (не владелец) подделывает бан Боба, подписывая СВОИМ ключом.
	const forged = sign(
		{
			kind: CHANNEL_BAN_KIND,
			content: encryptChannelContent(JSON.stringify({ targetPubkey: BOB_PUB }), keyRow.channelKey, meta.currentVersion),
			tags: [["d", `${channelId}:ban:${BOB_PUB}`], ["h", channelRow.channelTopic]],
			created_at: Math.floor(Date.now() / 1000),
		},
		MALLORY_PRIV,
	);

	const applied = await receiveBanAnnouncement(MALLORY_PUB, forged);
	assert.equal(applied, false, "поддельный бан от не-владельца обязан быть отклонён");
	assert.ok(await db.table("channels").get([MALLORY_PUB, channelId]), "канал не тронут");
});

test("АДВЕРСАРНЫЙ (крипто-барьер): после бана Боб НЕ может писать НОВЫЕ комментарии — v_old не годится текущим читателям", async () => {
	const { channelId } = await setupChannelWithTwoReadersOneSubscribed();
	const banOutbox = [];
	await banMember(ALICE_PUB, ALICE_PRIV, channelId, BOB_PUB, capturingPublish(banOutbox));

	// Mallory (честный клиент) получает переизданный грант v_new через свою подписку —
	// её channelKeyMeta.currentVersion переходит на v_new (тот же путь, что receiveChannelKeyGrant
	// уже покрыт тестами этапа 30, здесь он — предпосылка для проверки крипто-барьера).
	const newGrant = banOutbox.find((e) => e.kind === 30053);
	await receiveChannelKeyGrant(MALLORY_PUB, MALLORY_PRIV, ALICE_PUB, newGrant);

	// Боб — нечестный клиент, игнорирует объявление о своём бане и всё равно пытается
	// написать комментарий СВОИМ (уже устаревшим v_old) ключом.
	const published = [];
	await addComment(BOB_PUB, BOB_PRIV, channelId, "post-1", "post-1", "я всё ещё тут", [], capturingPublish(published));
	const forgedComment = published.find((e) => e.kind === 30062);

	// Mallory (получила v_new через переиздачу) пытается принять — крипто-барьер
	// (DESIGN.md): decryptChannelContent ищет ТОЛЬКО meta.currentVersion (v_new),
	// у события заголовок v_old -> null -> discard, ДО проверки allowlist.
	const applied = await receiveComment(MALLORY_PUB, forgedComment);
	assert.equal(applied, false, "комментарий забаненного с устаревшим ключом обязан быть отклонён");
});

test("listReports: сортировка по createdAt убыв., owner-scoped по каналу", async () => {
	await receiveReport(ALICE_PUB, { reporterPubkey: BOB_PUB, channelId: "ch1", targetPubkey: "x", contentType: "comment", contentId: "c1", contentText: "a", reason: "report", createdAt: 100 });
	await receiveReport(ALICE_PUB, { reporterPubkey: BOB_PUB, channelId: "ch1", targetPubkey: "x", contentType: "comment", contentId: "c2", contentText: "b", reason: "report", createdAt: 200 });
	await receiveReport(ALICE_PUB, { reporterPubkey: BOB_PUB, channelId: "ch2", targetPubkey: "x", contentType: "comment", contentId: "c3", contentText: "c", reason: "report", createdAt: 300 });

	const reports = await listReports(ALICE_PUB, "ch1");
	assert.equal(reports.length, 2);
	assert.equal(reports[0].createdAt, 200, "свежие первыми");
	assert.equal(reports[1].createdAt, 100);
});

test("markReportViewed/markAllReportsViewed", async () => {
	await receiveReport(ALICE_PUB, { reporterPubkey: BOB_PUB, channelId: "ch1", targetPubkey: "x", contentType: "comment", contentId: "c1", contentText: "a", reason: "report", createdAt: 100 });
	await receiveReport(ALICE_PUB, { reporterPubkey: BOB_PUB, channelId: "ch1", targetPubkey: "x", contentType: "comment", contentId: "c2", contentText: "b", reason: "report", createdAt: 200 });

	let reports = await listReports(ALICE_PUB, "ch1");
	await markReportViewed(ALICE_PUB, reports[0].id);
	reports = await listReports(ALICE_PUB, "ch1");
	assert.equal(reports.find((r) => r.createdAt === 200).viewed, true);
	assert.equal(reports.find((r) => r.createdAt === 100).viewed, false);

	await markAllReportsViewed(ALICE_PUB, "ch1");
	reports = await listReports(ALICE_PUB, "ch1");
	assert.ok(reports.every((r) => r.viewed === true));
});

test("getModerationStats: total/unviewed/topIgnored (уникальные жалующиеся, не повторы)", async () => {
	await receiveReport(ALICE_PUB, { reporterPubkey: BOB_PUB, channelId: "ch1", targetPubkey: "mallory", contentType: "comment", contentId: "c1", contentText: "a", reason: "ignore", createdAt: 100 });
	await receiveReport(ALICE_PUB, { reporterPubkey: "eve-pub", channelId: "ch1", targetPubkey: "mallory", contentType: "comment", contentId: "c2", contentText: "b", reason: "ignore", createdAt: 200 });
	// Боб игнорит Mallory ДВАЖДЫ (два разных сообщения) — не должен считаться дважды в topIgnored
	await receiveReport(ALICE_PUB, { reporterPubkey: BOB_PUB, channelId: "ch1", targetPubkey: "mallory", contentType: "comment", contentId: "c3", contentText: "c", reason: "ignore", createdAt: 300 });
	await receiveReport(ALICE_PUB, { reporterPubkey: BOB_PUB, channelId: "ch1", targetPubkey: "eve-pub", contentType: "comment", contentId: "c4", contentText: "жалоба", reason: "report", createdAt: 400 });
	await markReportViewed(ALICE_PUB, (await listReports(ALICE_PUB, "ch1"))[0].id);

	const stats = await getModerationStats(ALICE_PUB, "ch1");
	assert.equal(stats.total, 4);
	assert.equal(stats.unviewed, 3);
	assert.equal(stats.topIgnored[0].pubkey, "mallory");
	assert.equal(stats.topIgnored[0].count, 2, "Боб+Eve — 2 РАЗНЫХ жалующихся, повтор Боба не считается");
});

test("listBannedMembers: возвращает pubkey забаненных для канала", async () => {
	await db.table("bannedMembers").bulkAdd([
		{ ownerPubkey: ALICE_PUB, channelId: "ch1", pubkey: BOB_PUB, bannedAt: 1 },
		{ ownerPubkey: ALICE_PUB, channelId: "ch2", pubkey: MALLORY_PUB, bannedAt: 2 },
	]);
	assert.deepEqual(await listBannedMembers(ALICE_PUB, "ch1"), [BOB_PUB]);
});
