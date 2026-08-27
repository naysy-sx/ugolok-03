import { db } from "../../core/store/database.js";
import { sign } from "../../core/crypto/sign.js";
import { encryptChannelContent, decryptChannelContent } from "../../core/crypto/channel-key.js";
import { buildAddressableDeletionEvent } from "../../domain/events/handlers.js";
import { transitionPost } from "./post-machine.js";
import { toEncryptedRow, fromEncryptedRow } from "../../core/store/encrypted-table.js";
import { POSTS_PLAINTEXT_FIELDS } from "../../core/store/table-fields.js";
import { isNewerVersion } from "../../core/sync/lww.js";
import { ChannelContentNotReadyError } from "./channel-content-errors.js";
import { DomainError } from "../errors.js";

async function requirePublishOk(publish, event) {
	const result = await publish(event);
	if (!result.ok) {
		if (result.reason) throw new Error(result.reason);
		throw new DomainError("relay отклонил публикацию", "errors.relayRejected");
	}
}

// DESIGN.md, "Этап 31", формализация 1 — draft НИКОГДА не публикуется, строго
// локальная запись до первого PUBLISH.
// Редизайн интерфейса, этап 1 (CONTRACTS.md) — title/linkUrl: поля создания,
// как text. dueAt/done НЕ принимаются здесь — в форме создания поля срока
// нет (REDESIGN-SPEC.md, этап 2: "в момент написания срок обычно ещё не
// известен"), оба всегда стартуют null, меняются только через
// setPostDue/setPostDone и производные ниже.
export async function createDraftPost(ownerPubkey, dbKey, channelId, { text, attachments = [], title = null, linkUrl = null, tags = [] }) {
	const postId = crypto.randomUUID();
	await db.table("posts").put(
		toEncryptedRow(
			{
				ownerPubkey,
				id: postId,
				channelId,
				authorPubkey: ownerPubkey,
				text,
				attachments,
				title,
				linkUrl,
				tags,
				dueAt: null,
				done: null,
				status: "draft",
				keyVersion: null,
				createdAt: Math.floor(Date.now() / 1000),
				deleted: false,
			},
			POSTS_PLAINTEXT_FIELDS,
			dbKey,
		),
	);
	return { postId };
}

// Локальное редактирование — до первой публикации, ИЛИ после UNPUBLISH (снова draft).
// text/attachments — sensitive поля (CONTRACTS.md, Tier 1): decrypt-merge-encrypt,
// не partial .update() (тот же класс находки, что messages/edits.js).
export async function updateDraftPost(ownerPubkey, dbKey, postId, { text, attachments }) {
	const raw = await db.table("posts").get([ownerPubkey, postId]);
	if (!raw) throw new DomainError("пост не найден", "errors.postNotFound");
	if (raw.status !== "draft") {
		throw new DomainError("редактировать можно только черновик (unpublish уже опубликованный, затем редактировать)", "errors.onlyDraftEditable");
	}
	const merged = { ...fromEncryptedRow(raw, dbKey), text, attachments };
	await db.table("posts").put(toEncryptedRow(merged, POSTS_PLAINTEXT_FIELDS, dbKey));
}

// Правка поста канала: published/archived — republish того же d-tag БЕЗ смены
// статуса (не FSM-переход). draft — только локально, как updateDraftPost.
// Сначала publish, потом локальный put — иначе при отказе relay текст уже уехал бы.
export async function editPost(ownerPubkey, ownerPrivKey, dbKey, postId, { text, attachments, title }, publish) {
	const raw = await db.table("posts").get([ownerPubkey, postId]);
	if (!raw) throw new DomainError("пост не найден", "errors.postNotFound");
	if (raw.deleted) throw new DomainError("нельзя редактировать удалённый пост", "errors.cannotEditDeletedPost");
	const row = fromEncryptedRow(raw, dbKey);
	if (row.authorPubkey !== ownerPubkey) throw new DomainError("редактировать пост может только автор", "errors.onlyAuthorCanEditPost");

	const merged = { ...row, text, attachments };
	if (title !== undefined) merged.title = title;

	if (raw.status === "draft") {
		await db.table("posts").put(toEncryptedRow(merged, POSTS_PLAINTEXT_FIELDS, dbKey));
		return { postId };
	}

	const channelRow = await db.table("channels").get([ownerPubkey, merged.channelId]);
	const meta = fromEncryptedRow(await db.table("channelKeyMeta").get([ownerPubkey, merged.channelId]), dbKey);
	const keyRow = fromEncryptedRow(await db.table("channelKeys").get([ownerPubkey, merged.channelId, meta.currentVersion]), dbKey);
	const content = encryptChannelContent(
		JSON.stringify({
			text: merged.text,
			attachments: merged.attachments,
			status: merged.status,
			dueAt: merged.dueAt,
			done: merged.done,
			title: merged.title,
			linkUrl: merged.linkUrl,
			tags: merged.tags,
		}),
		keyRow.channelKey,
		meta.currentVersion,
	);
	const event = sign(
		{
			kind: 30061,
			content,
			tags: [
				["d", `${merged.channelId}:${postId}`],
				["h", channelRow.channelTopic],
			],
			created_at: Math.floor(Date.now() / 1000),
		},
		ownerPrivKey,
	);
	await requirePublishOk(publish, event);
	await db.table("posts").put(
		toEncryptedRow(
			{
				...merged,
				keyVersion: meta.currentVersion,
				lastEventCreatedAt: event.created_at,
				lastEventId: event.id,
			},
			POSTS_PLAINTEXT_FIELDS,
			dbKey,
		),
	);
	return { eventId: event.id };
}

// Общая часть publishPost/archivePost/unpublishPost — DESIGN.md формализация 1:
// статус — ЧАСТЬ синхронизируемого payload'а, republish того же d-tag (kind 30061
// параметризованно-replaceable, NIP-01) заменяет предыдущую версию у всех читателей.
async function republishWithStatus(ownerPubkey, ownerPrivKey, dbKey, postId, fsmEvent, publish) {
	const raw = await db.table("posts").get([ownerPubkey, postId]);
	if (!raw) throw new DomainError("пост не найден", "errors.postNotFound");
	const newStatus = transitionPost(raw.status, fsmEvent); // бросает на недопустимый переход
	const row = fromEncryptedRow(raw, dbKey); // text/attachments — sensitive, нужны для republish-контента

	const channelRow = await db.table("channels").get([ownerPubkey, row.channelId]);
	const meta = fromEncryptedRow(await db.table("channelKeyMeta").get([ownerPubkey, row.channelId]), dbKey);
	const keyRow = fromEncryptedRow(await db.table("channelKeys").get([ownerPubkey, row.channelId, meta.currentVersion]), dbKey);

	// Редизайн интерфейса, этап 1 (CONTRACTS.md) — dueAt/done/title/linkUrl едут
	// в payload вместе с text/attachments/status: setPostDue/setPostDone (ниже)
	// сами ничего не публикуют (только локальная запись), поэтому именно
	// ЛЮБОЙ следующий статусный переход подхватывает и рассылает актуальные
	// локальные значения признаков подписчикам канала.
	const content = encryptChannelContent(
		JSON.stringify({
			text: row.text,
			attachments: row.attachments,
			status: newStatus,
			dueAt: row.dueAt,
			done: row.done,
			title: row.title,
			linkUrl: row.linkUrl,
			tags: row.tags,
		}),
		keyRow.channelKey,
		meta.currentVersion,
	);
	const event = sign(
		{
			kind: 30061,
			content,
			tags: [
				["d", `${row.channelId}:${postId}`],
				["h", channelRow.channelTopic],
			],
			created_at: Math.floor(Date.now() / 1000),
		},
		ownerPrivKey,
	);
	await requirePublishOk(publish, event);
	// lastEventCreatedAt/lastEventId (Этап 74 — Часть C, C-2) — без них собственная
	// строка владельца оставалась бы БЕЗ версии, и старая redelivery (resubscribe-
	// backlog на своё же ПРОШЛОЕ событие) прошла бы isNewerVersion-гейт в receivePost
	// как "нет сохранённой версии", откатив status на этом же/сиблинг-устройстве.
	await db.table("posts").update([ownerPubkey, postId], { status: newStatus, keyVersion: meta.currentVersion, lastEventCreatedAt: event.created_at, lastEventId: event.id });
	return { eventId: event.id };
}

export async function publishPost(ownerPubkey, ownerPrivKey, dbKey, postId, publish) {
	return republishWithStatus(ownerPubkey, ownerPrivKey, dbKey, postId, "PUBLISH", publish);
}

export async function archivePost(ownerPubkey, ownerPrivKey, dbKey, postId, publish) {
	return republishWithStatus(ownerPubkey, ownerPrivKey, dbKey, postId, "ARCHIVE", publish);
}

export async function unpublishPost(ownerPubkey, ownerPrivKey, dbKey, postId, publish) {
	return republishWithStatus(ownerPubkey, ownerPrivKey, dbKey, postId, "UNPUBLISH", publish);
}

// F-CH-10 — kind 5 (NIP-09), АДРЕСУЕМОЕ удаление (тег "a": kind:pubkey:d-tag) —
// переживает republish/смену event.id при статусных переходах, в отличие от
// удаления по конкретному "e"-тегу. Черновик (никогда не публиковался) — нечего
// отзывать на relay, только локальная отметка.
// ТЗ редизайн канала A — страница записи грузит пост точечно, не через
// окно ленты. null: нет строки / deleted / чужой ownerPubkey (ключ составной).
export async function getPost(ownerPubkey, dbKey, postId) {
	const raw = await db.table("posts").get([ownerPubkey, postId]);
	if (!raw || raw.deleted) return null;
	return fromEncryptedRow(raw, dbKey);
}

export async function deletePost(ownerPubkey, ownerPrivKey, postId, publish) {
	const row = await db.table("posts").get([ownerPubkey, postId]);
	if (!row) throw new DomainError("пост не найден", "errors.postNotFound");
	if (row.status !== "draft") {
		const dTag = `${row.channelId}:${postId}`;
		const event = buildAddressableDeletionEvent(ownerPrivKey, 30061, dTag);
		await requirePublishOk(publish, event);
	}
	await db.table("posts").update([ownerPubkey, postId], { deleted: true });
}

// DESIGN.md, формализация 2 (найденная адверсарная угроза) — event.pubkey ОБЯЗАН
// совпадать с channelRow.creatorPubkey: ЛЮБОЙ VIEW-держатель технически способен
// зашифровать валидный kind 30061 тем же channelKey — владение ключом ≠ авторство.
export async function receivePost(ownerPubkey, dbKey, event) {
	const hTag = event.tags.find((t) => t[0] === "h");
	if (!hTag) return false;
	const channelRow = await db
		.table("channels")
		.where("channelTopic")
		.equals(hTag[1])
		.and((r) => r.ownerPubkey === ownerPubkey)
		.first();
	// Этап 74 — найдено живой проверкой (revoke/re-grant race, тот же класс, что
	// receiveChannelMetadata, channel.js): "неизвестный канал" может быть
	// транзитным (unview ещё не сменился повторным грантом) — throw делает
	// событие ретраебельным вместо permanent silent loss.
	if (!channelRow) throw new ChannelContentNotReadyError();
	if (event.pubkey !== channelRow.creatorPubkey) return false;

	// Этап 74 — найдено живой проверкой (CONTRACTS.md/DESIGN.md "Этап 74"): throw,
	// не silent no-op — тот же приём, что receiveChannelMetadata (М3-класс для каналов).
	const meta = fromEncryptedRow(await db.table("channelKeyMeta").get([ownerPubkey, channelRow.id]), dbKey);
	if (!meta) throw new ChannelContentNotReadyError();
	const keyRowRaw = await db.table("channelKeys").get([ownerPubkey, channelRow.id, meta.currentVersion]);
	if (!keyRowRaw) throw new ChannelContentNotReadyError();
	const keyRow = fromEncryptedRow(keyRowRaw, dbKey);

	const plaintext = decryptChannelContent(event.content, { [meta.currentVersion]: keyRow.channelKey });
	if (plaintext === null) throw new ChannelContentNotReadyError();
	const parsed = JSON.parse(plaintext);

	const dTag = event.tags.find((t) => t[0] === "d");
	if (!dTag) return false;
	const postId = dTag[1].slice(dTag[1].indexOf(":") + 1); // "{channelId}:{postId}" -> postId

	// createdAt сохраняется от ПЕРВОГО приёма — republish (archive/unpublish) не должен
	// прыгать местом в хронологии ленты.
	const existing = await db.table("posts").get([ownerPubkey, postId]);
	const createdAt = existing ? existing.createdAt : event.created_at;

	// Этап 74 — Часть C, C-2 (CONTRACTS.md/DESIGN.md "Этап 74"): archivePost/
	// unpublishPost/edit republish-ят ТОТ ЖЕ d-tag — старая версия (например,
	// "published"), доставленная ПОСЛЕ архивации, не должна откатывать status/
	// text. lastEventCreatedAt — версия ПОСЛЕДНЕЙ применённой ревизии, отдельно
	// от createdAt (хронологическая позиция, не трогается republish'ем).
	if (existing && !isNewerVersion({ createdAt: event.created_at, id: event.id }, { createdAt: existing.lastEventCreatedAt, id: existing.lastEventId })) {
		return false;
	}

	// Редизайн интерфейса, этап 1 (CONTRACTS.md) — события ДО этапа 1 не несут
	// новых полей вовсе (parsed.dueAt/done/title/linkUrl === undefined) — ??,
	// не прямое присваивание, иначе приём старого события затирал бы уже
	// применённые локально признаки значением undefined.
	await db.table("posts").put(
		toEncryptedRow(
			{
				ownerPubkey,
				id: postId,
				channelId: channelRow.id,
				authorPubkey: event.pubkey,
				text: parsed.text,
				attachments: parsed.attachments,
				title: parsed.title ?? null,
				linkUrl: parsed.linkUrl ?? null,
				tags: parsed.tags ?? [],
				dueAt: parsed.dueAt ?? null,
				done: parsed.done ?? null,
				status: parsed.status,
				keyVersion: meta.currentVersion,
				createdAt,
				lastEventCreatedAt: event.created_at,
				lastEventId: event.id,
				deleted: false,
			},
			POSTS_PLAINTEXT_FIELDS,
			dbKey,
		),
	);
	return true;
}

export async function listChannelPosts(ownerPubkey, dbKey, channelId) {
	const raw = await db.table("posts").where("ownerPubkey").equals(ownerPubkey).toArray();
	return raw.filter((r) => r.channelId === channelId && !r.deleted).map((r) => fromEncryptedRow(r, dbKey));
}

// Этап 74 — найдено живой проверкой: revokeViewFromMember (channel-visibility.js)
// ротирует channelKey, но посты на relay остаются зашифрованы СТАРОЙ версией —
// повторно добавленный читатель (та же/другая группа видимости) получает ТОЛЬКО
// новую версию ключа и никогда не расшифрует историю (relay хранит replaceable-
// событие под старым конвертом навсегда, ключ к нему больше никому не выдаётся).
// Тот же приём, что revokeViewFromMember уже делает для метаданных канала (kind
// 30060) — переиздаём ЖИВЫЕ (не draft, не deleted) посты ПОД ТЕКУЩЕЙ версией
// ключа, СТАТУС не меняется (не republishWithStatus — та делает FSM-переход).
// Best-effort по каждому посту (прецедент backfillOwnChannelGrants, channel.js):
// падение одного publish не должно откатывать уже ротированный ключ выше или
// блокировать переиздачу остальных постов.
//
// КОММЕНТАРИИ НЕ переиздаются здесь и не могут быть переизданы вообще —
// подписаны АВТОРОМ комментария (не обязательно владельцем канала), у владельца
// физически нет приватного ключа автора. Это криптографическое ограничение
// модели, не пробел реализации (channel-access.js's
// buildChannelOldHistoryUnavailableRumor уведомляет об этом читателя явно).
export async function republishAllPostsUnderCurrentKey(ownerPubkey, ownerPrivKey, dbKey, channelId, publish) {
	const channelRow = await db.table("channels").get([ownerPubkey, channelId]);
	if (!channelRow) return;
	const meta = fromEncryptedRow(await db.table("channelKeyMeta").get([ownerPubkey, channelId]), dbKey);
	const keyRow = fromEncryptedRow(await db.table("channelKeys").get([ownerPubkey, channelId, meta.currentVersion]), dbKey);

	const raw = await db.table("posts").where("ownerPubkey").equals(ownerPubkey).toArray();
	const posts = raw.map((r) => fromEncryptedRow(r, dbKey)).filter((p) => p.channelId === channelId && !p.deleted && p.status !== "draft");

	for (const post of posts) {
		try {
			const content = encryptChannelContent(
				JSON.stringify({
					text: post.text,
					attachments: post.attachments,
					status: post.status,
					dueAt: post.dueAt,
					done: post.done,
					title: post.title,
					linkUrl: post.linkUrl,
					tags: post.tags,
				}),
				keyRow.channelKey,
				meta.currentVersion,
			);
			const event = sign(
				{
					kind: 30061,
					content,
					tags: [
						["d", `${channelId}:${post.id}`],
						["h", channelRow.channelTopic],
					],
					created_at: Math.floor(Date.now() / 1000),
				},
				ownerPrivKey,
			);
			await requirePublishOk(publish, event);
			await db.table("posts").update([ownerPubkey, post.id], { keyVersion: meta.currentVersion, lastEventCreatedAt: event.created_at, lastEventId: event.id });
		} catch (e) {
			console.warn("republishAllPostsUnderCurrentKey: не удалось переиздать пост, остальные всё равно переиздаются", post.id, e);
		}
	}
}

// Редизайн интерфейса, этап 1 (CONTRACTS.md) — пять новых действий над
// признаками записи. Все ЛОКАЛЬНЫЕ: частичный db.update() на plaintext-поля
// dueAt/done (тот же приём, что deletePost использует для { deleted: true }),
// без dbKey (расшифровка не нужна) и без ownerPrivKey/publish (republish на
// relay не делают — REDESIGN-SPEC.md задаёт им сигнатуры БЕЗ этих
// параметров, в отличие от publishPost/archivePost/deletePost). Актуальные
// значения долетают до relay окольным путём — они уже часть payload
// publishPost/archivePost/unpublishPost/republishAllPostsUnderCurrentKey
// выше, так что любой следующий статусный переход разошлёт их сам.
//
// Инвариант независимости признаков (REDESIGN-SPEC.md, этап 1): смена
// одного признака никогда не трогает остальные три. setPostDue/setPostDone
// пишут РОВНО одно поле частичным update() — соседние поля физически не
// упоминаются в патче, значит не могут быть задеты.

async function requirePostExists(ownerPubkey, postId) {
	const row = await db.table("posts").get([ownerPubkey, postId]);
	if (!row) throw new DomainError("пост не найден", "errors.postNotFound");
}

export async function setPostDue(ownerPubkey, postId, dueAt) {
	await requirePostExists(ownerPubkey, postId);
	await db.table("posts").update([ownerPubkey, postId], { dueAt });
}

export async function clearPostDue(ownerPubkey, postId) {
	return setPostDue(ownerPubkey, postId, null);
}

export async function setPostDone(ownerPubkey, postId, done) {
	await requirePostExists(ownerPubkey, postId);
	await db.table("posts").update([ownerPubkey, postId], { done });
}

export async function makePostTask(ownerPubkey, postId) {
	return setPostDone(ownerPubkey, postId, false);
}

export async function unmakePostTask(ownerPubkey, postId) {
	return setPostDone(ownerPubkey, postId, null);
}

// Редизайн интерфейса, этап 1-довесок (CONTRACTS.md) — tags: string[],
// зашифровано (Tier 1, как text/attachments/title/linkUrl) — decrypt-merge-
// encrypt, НЕ частичный db.update() (тот же класс, что updateDraftPost).
// В отличие от updateDraftPost — работает при ЛЮБОМ статусе (тегировать
// можно и опубликованный пост), тот же принцип, что setPostDue/setPostDone.
// НЕ публикует — актуальные теги долетают до relay окольным путём, через
// следующий статусный переход (row.tags уже часть payload republishWithStatus/
// republishAllPostsUnderCurrentKey выше).
export async function setPostTags(ownerPubkey, dbKey, postId, tags) {
	const raw = await db.table("posts").get([ownerPubkey, postId]);
	if (!raw) throw new DomainError("пост не найден", "errors.postNotFound");
	const merged = { ...fromEncryptedRow(raw, dbKey), tags };
	await db.table("posts").put(toEncryptedRow(merged, POSTS_PLAINTEXT_FIELDS, dbKey));
}

// Редизайн интерфейса, этап 4 (CONTRACTS.md) — экран "Сегодня". Читает
// СТРОГО через индекс [ownerPubkey+dueAt] (db.version(25), этап 1), без
// полного перебора таблицы — тот же приём диапазона, что chat.js:43.
// dueAt: null физически отсутствует в этом индексе (IndexedDB не
// индексирует null как ключ), поэтому записи без срока сюда не попадают
// сами по себе — отдельный фильтр "непустой срок" не нужен. done !== true
// и !deleted — plaintext-поля, фильтруются на сырых строках ДО расшифровки.
// Результат уже отсортирован индексом по возрастанию dueAt (общий префикс
// ownerPubkey, дальше — числовой порядок второй компоненты ключа).
//
// until (unix seconds, опционален) — верхняя граница: счётчик на кнопке
// зовёт С until (конец сегодня, дешевле — меньше строк на расшифровку),
// экран "Сегодня" зовёт БЕЗ until (весь список, дороже, но реже).
export async function listDueRecords(ownerPubkey, dbKey, { until } = {}) {
	const raw = await db
		.table("posts")
		.where("[ownerPubkey+dueAt]")
		.between([ownerPubkey, 0], [ownerPubkey, until ?? Number.MAX_SAFE_INTEGER], true, true)
		.toArray();
	return raw.filter((r) => !r.deleted && r.done !== true).map((r) => fromEncryptedRow(r, dbKey));
}
