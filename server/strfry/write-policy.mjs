// GATEWAY-TZ-1.md §2. Решение write-policy как чистая функция — без stdin/
// stdout и файлов, чтобы тестироваться без запуска strfry
// (tests/whitelist-plugin.test.js). whitelist-plugin.mjs остаётся тонкой
// обёрткой: читает файлы на каждое событие и печатает ответ.
import { isClean } from "../../src/domain/discovery/wordfilter.js";

const DISCOVERY_KIND = 30073;

// Откуда пришло событие — поле sourceType из протокола плагина
// (strfry-src/docs/plugins.md): IP4/IP6 — клиентский сокет, Import/Stored —
// локальные операции оператора, Stream/Sync — обмен с другим реле. Для
// Stream/Sync strfry кладёт в sourceInfo URL удалённого реле
// (cmd_sync.cpp/cmd_stream.cpp/cmd_router.cpp — проверено по исходникам).
// Всё, чего нет в MIRROR_SOURCES (в том числе отсутствующее поле), идёт по
// прежнему правилу для своих — поведение текущей установки не меняется.
const MIRROR_SOURCES = new Set(["Sync", "Stream"]);

export function isMirrorSource(req) {
	return MIRROR_SOURCES.has(req?.sourceType);
}

// Личная переписка и служебные события не зеркалируются НИКОГДА, что бы ни
// написали в peers.json (GATEWAY-TZ-1.md §6: адресная доставка — другой
// режим). Это страховка от опечатки в конфиге, а не основной фильтр: основной —
// явный список kind'ов в peers.json.
// 4/13/14/1059 — DM и gift wrap; 443–446, 10050, 10051 — MLS-сообщения,
// welcome, key package, зеркало истории; 20075 — сигналинг звонков; 24242/22242
// — авторизации Blossom/служебные; 29001 — объявления «Быстрой связи».
export const NEVER_MIRROR_KINDS = new Set([4, 13, 14, 1059, 443, 444, 445, 446, 10050, 10051, 20075, 22242, 24242, 29001]);

function normalizeUrl(url) {
	return String(url ?? "")
		.trim()
		.toLowerCase()
		.replace(/\/+$/, "");
}

// peers.json: { "kinds": [числа], "peers": [{ "id", "name", "url", "kinds"? }] }.
// Пустой файл, отсутствие файла, битый JSON, пустой список пиров или пустой
// список kind'ов — всё это «зеркалу нельзя ничего» (loadPeers в плагине
// превращает ошибки чтения в null).
function peerFor(req, peers) {
	if (!peers || !Array.isArray(peers.peers)) return null;
	const source = normalizeUrl(req.sourceInfo);
	if (!source) return null;
	return peers.peers.find((p) => p && p.url && normalizeUrl(p.url) === source) ?? null;
}

function mirrorKindAllowed(kind, peer, peers) {
	if (NEVER_MIRROR_KINDS.has(kind)) return false;
	const kinds = Array.isArray(peer.kinds) ? peer.kinds : peers.kinds;
	return Array.isArray(kinds) && kinds.includes(kind);
}

function discoveryContentIsClean(event, stopwords) {
	let content;
	try {
		content = JSON.parse(event.content);
	} catch {
		return true; // не наш формат — не дело этого фильтра решать
	}
	const texts = [content?.bio];
	if (Array.isArray(content?.channels)) {
		for (const c of content.channels) texts.push(c?.name, c?.description, c?.rules);
	}
	return texts.every((text) => typeof text !== "string" || isClean(text, stopwords));
}

// ctx: { whitelist: Set<string>, peers: object|null, stopwords: string[]|() => string[] }.
// stopwords — функция, чтобы читать файл только для kind 30073, как раньше.
export function decide(req, { whitelist, peers, stopwords }) {
	const res = { id: req.event.id };
	const event = req.event;

	if (isMirrorSource(req)) {
		// Зеркальный поток судится ТОЛЬКО по peers.json. Whitelist по pubkey и
		// его "*" здесь намеренно не участвуют: события чужих пользователей в
		// нём по определению нет, а "*" (dev-режим «пускать всех») не должен
		// превращаться в «принимать всё, что тянется с любого пира».
		const peer = peerFor(req, peers);
		if (!peer) {
			res.action = "reject";
			res.msg = "blocked: mirror source is not a configured peer";
			return res;
		}
		if (!mirrorKindAllowed(event.kind, peer, peers)) {
			res.action = "reject";
			res.msg = "blocked: kind not allowed from mirror";
			return res;
		}
		res.action = "accept";
	} else {
		const pubkey = (event?.pubkey ?? "").toLowerCase();
		if (whitelist.has("*") || whitelist.has(pubkey)) {
			res.action = "accept";
		} else {
			res.action = "reject";
			res.msg = "blocked: pubkey not on whitelist";
		}
	}

	if (res.action === "accept" && event.kind === DISCOVERY_KIND) {
		const words = typeof stopwords === "function" ? stopwords() : (stopwords ?? []);
		if (!discoveryContentIsClean(event, words)) {
			res.action = "reject";
			res.msg = "blocked: discovery content failed wordlist filter";
		}
	}
	return res;
}

// Какие kind'ы реально тянуть/держать у данного пира: те же правила, что в
// decide() — единый источник, чтобы фильтр тяги (mirror-pull.mjs), очистка
// (mirror-prune.mjs) и политика приёма не разошлись.
export function effectiveMirrorKinds(peer, peers) {
	const kinds = Array.isArray(peer?.kinds) ? peer.kinds : peers?.kinds;
	if (!Array.isArray(kinds)) return [];
	return kinds.filter((k) => Number.isInteger(k) && !NEVER_MIRROR_KINDS.has(k));
}
