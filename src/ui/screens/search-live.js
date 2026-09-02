// Глобальный поиск, этап И3.7 (PLAN.md) — реальный движок вместо
// search.stub.js. Тот же публичный интерфейс (runSearch/cancelSearch),
// та же дисциплина runId/AbortController, что уже была протестирована в
// tests/search-engine.test.js (I-CANCEL-CLEAN) — здесь она применяется
// по-настоящему, не в тестовой репетиции.
//
// Экран (search.jsx) по контракту не обращается к Dexie/доменным модулям
// напрямую (SEARCH-UI-TASK.md §3.1) — вся эта работа живёт здесь, в
// адаптере между чистым движком (domain/search/engine.js, отдаёт только
// {type,key,sortKey,data} — И3, закрытие пробела контракта) и тем, что
// экрану нужно ПОКАЗАТЬ (человекочитаемые "кто"/"где"/"когда", а не сырые
// pubkey/unix-время).
import { searchState } from "../signals/search.js";
import { currentUser, dbKeySig } from "../signals/auth.js";
import { profiles } from "../signals/contacts.js";
import { shortPubkey } from "../format.js";
import { currentLocale, t } from "../signals/i18n.js";
import { parseQuery } from "../../domain/search/matching.js";
import { searchOverSources, SOURCES_IN_ORDER } from "../../domain/search/engine.js";
import { db } from "../../core/store/database.js";
import { fromEncryptedRow } from "../../core/store/encrypted-table.js";
import { getProfile } from "../../core/crypto/keystore.js";

const LIMIT_PER_TYPE = 100; // SEARCH-SPEC.md §6.3: 50-100 на группу

let currentController = null;
// Состояние прогона, нужное для "показать ещё" (loadMore) — тот же
// приём, что ALGO.md §5.2 обсуждает и отклоняет как излишний для v0.1
// персистентный курсор: вместо резюме источника с места остановки просто
// перезапускаем ЕГО ОДНОГО с бОльшим limitPerType. Для unordered
// источников (contacts/channels/comments) это дёшево — они и так читаются
// целиком; для recent — честный повторный обход с более высоким порогом
// раннего прекращения, не resume "неоткуда".
let runContext = null; // { myRunId, ownerPubkey, dbKey, ctx, channelNames }
const shownPerType = new Map();

export function cancelSearch() {
	if (searchState.value.status !== "running") return;
	currentController?.abort();
	searchState.value = { ...searchState.value, status: "cancelled" };
}

function isStale(myRunId) {
	return searchState.value.runId !== myRunId || searchState.value.status !== "running";
}

function formatTime(unixSeconds) {
	if (!unixSeconds) return "";
	return new Date(unixSeconds * 1000).toLocaleString(currentLocale.value, { dateStyle: "short", timeStyle: "short" });
}

function initial(name) {
	return (name || "?").trim().charAt(0).toUpperCase() || "?";
}

// "Ты"/чужое имя — тот же принцип, что nav-groups.jsx's personName, но с
// явным случаем "это я" (единственное место в поиске, где это нужно —
// у контактов/каналов автора нет вовсе).
function who(pubkey, ownerPubkey) {
	if (pubkey === ownerPubkey) return t("search.you");
	return profiles.value[pubkey]?.name || shortPubkey(pubkey);
}

// Живой фидбек: аватары (включая свой собственный) в выдаче не
// показывались — были только инициалы. Свой аватар живёт в keystore
// (account-card.jsx's паттерн — avatar/локальный превью первым, потом
// avatarUrl/Blossom), чужой — в уже загруженном сигнале profiles
// (nav-groups.jsx's PersonAvatar тем же путём). ownAvatarUrl вычисляется
// один раз на прогон (см. runSearch), не на каждое попадание.
function avatarUrlFor(pubkey, ownerPubkey, ownAvatarUrl) {
	if (pubkey === ownerPubkey) return ownAvatarUrl;
	return profiles.value[pubkey]?.picture || null;
}

async function loadChannelNames(ownerPubkey, dbKey) {
	const rows = await db.table("channels").where("ownerPubkey").equals(ownerPubkey).toArray();
	const map = new Map();
	for (const row of rows) map.set(row.id, fromEncryptedRow(row, dbKey).name ?? "");
	return map;
}

// Собирает {key, ...поля для отрисовки/навигации search.jsx} из {type,
// data} движка. channelNames — Map, догружена один раз на весь прогон
// (не на каждое попадание) — каналов десятки-сотни (SEARCH-ALGO.md §2),
// отдельное чтение на попадание было бы Θ(результатов) лишних запросов.
function toHit(type, data, ownerPubkey, channelNames, ownAvatarUrl) {
	switch (type) {
		case "contact":
			// avatarInitial отсутствовал здесь вовсе (найдено при разборе живого
			// фидбека про аватары) — карточка контакта показывала ПУСТОЙ кружок,
			// не букву, пока не найден avatarUrl.
			return { key: data.contactPubkey, contactPubkey: data.contactPubkey, name: data.name, bio: data.about, avatarInitial: initial(data.name), avatarUrl: data.picture || null };
		case "channel":
			// Аватар канала сознательно не гидратируется здесь — требует
			// того же async-декрипта+фетча через Blossom, что ChannelAvatarThumb
			// (полный объект канала, не просто id/name) — вне минимального
			// решения этой правки, инициалы остаются как есть.
			return { key: data.channelId, channelId: data.channelId, name: data.name, bio: [data.description, data.rules].filter(Boolean).join(" "), avatarInitial: initial(data.name) };
		case "post":
			return { key: data.postId, channelId: data.channelId, title: data.title, excerpt: data.text, channelName: channelNames.get(data.channelId) ?? "", time: formatTime(data.createdAt) };
		case "comment":
			return {
				key: data.commentId,
				channelId: data.channelId,
				postId: data.postId,
				who: who(data.authorPubkey, ownerPubkey),
				where: channelNames.get(data.channelId) ?? "",
				time: formatTime(data.createdAt),
				avatarInitial: initial(who(data.authorPubkey, ownerPubkey)),
				avatarUrl: avatarUrlFor(data.authorPubkey, ownerPubkey, ownAvatarUrl),
				text: data.text,
				// quote (цитата родителя) сознательно не гидратируется здесь —
				// требует отдельного чтения родительского поста/комментария,
				// вне минимального решения этой задачи (CONTRACTS.md §SEARCH).
			};
		case "channelMessage":
			return {
				key: data.messageId,
				channelId: data.channelId,
				who: who(data.authorPubkey, ownerPubkey),
				where: channelNames.get(data.channelId) ?? "",
				time: formatTime(data.createdAt),
				avatarInitial: initial(who(data.authorPubkey, ownerPubkey)),
				avatarUrl: avatarUrlFor(data.authorPubkey, ownerPubkey, ownAvatarUrl),
				text: data.text,
			};
		case "message": {
			const label = who(data.senderPubkey, ownerPubkey);
			return {
				key: data.messageId,
				contactPubkey: data.chatId,
				who: label,
				where: t("search.group.message"),
				time: formatTime(data.sentAt),
				avatarInitial: initial(label),
				avatarUrl: avatarUrlFor(data.senderPubkey, ownerPubkey, ownAvatarUrl),
				text: data.text,
			};
		}
	}
}

async function runOneSource(source, limit, signal) {
	const { ownerPubkey, dbKey, ctx, channelNames, query, ownAvatarUrl } = runContext;
	const hits = [];
	for await (const { data } of searchOverSources([source], ctx, query, { signal, limitPerType: limit })) {
		if (signal.aborted) return null;
		hits.push(toHit(source.type, data, ownerPubkey, channelNames, ownAvatarUrl));
	}
	return signal.aborted ? null : hits;
}

export async function runSearch(query) {
	const myRunId = searchState.value.runId + 1;
	const parsed = parseQuery(query);
	const ownerPubkey = currentUser.value.id;
	const dbKey = dbKeySig.value;
	const ctx = { ownerPubkey, dbKey };

	currentController?.abort();
	const controller = new AbortController();
	currentController = controller;
	shownPerType.clear();

	searchState.value = {
		runId: myRunId,
		query,
		parts: parsed.parts,
		status: "running",
		currentSource: SOURCES_IN_ORDER[0]?.type ?? null,
		groups: [],
	};

	if (parsed.isEmpty) {
		searchState.value = { ...searchState.value, status: "done", currentSource: null };
		return;
	}

	const channelNames = await loadChannelNames(ownerPubkey, dbKey);
	const ownProfile = await getProfile(ownerPubkey).catch(() => null);
	const ownAvatarUrl = ownProfile?.avatar || ownProfile?.avatarUrl || null;
	if (isStale(myRunId)) return;
	runContext = { myRunId, ownerPubkey, dbKey, ctx, channelNames, query, ownAvatarUrl };

	for (const source of SOURCES_IN_ORDER) {
		if (isStale(myRunId) || controller.signal.aborted) return;
		searchState.value = { ...searchState.value, currentSource: source.type };

		const hits = await runOneSource(source, LIMIT_PER_TYPE, controller.signal);
		if (hits === null || isStale(myRunId)) return;
		shownPerType.set(source.type, LIMIT_PER_TYPE);

		searchState.value = {
			...searchState.value,
			groups: [...searchState.value.groups, { type: source.type, hits, exhausted: hits.length < LIMIT_PER_TYPE, running: false }],
		};
	}

	if (isStale(myRunId)) return;
	searchState.value = { ...searchState.value, status: "done", currentSource: null };
}

// "Показать ещё" (SEARCH-UI-TASK.md §4.4) — перезапускает ОДИН источник с
// увеличенным порогом, заменяет его группу целиком. Не резюме с места
// остановки (см. комментарий у runContext) — следующий честный обход.
export async function loadMore(type) {
	if (!runContext || runContext.myRunId !== searchState.value.runId) return;
	const source = SOURCES_IN_ORDER.find((s) => s.type === type);
	if (!source) return;
	const myRunId = runContext.myRunId;
	const nextLimit = (shownPerType.get(type) ?? LIMIT_PER_TYPE) + LIMIT_PER_TYPE;

	const signal = currentController?.signal ?? new AbortController().signal;
	const hits = await runOneSource(source, nextLimit, signal);
	if (hits === null || searchState.value.runId !== myRunId) return;
	shownPerType.set(type, nextLimit);

	searchState.value = {
		...searchState.value,
		groups: searchState.value.groups.map((g) => (g.type === type ? { type, hits, exhausted: hits.length < nextLimit, running: false } : g)),
	};
}
