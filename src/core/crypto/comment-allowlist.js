import { sign } from "./sign.js";
import { opaqueDTag } from "./derivation.js";
import { encryptChannelContent, decryptChannelContent } from "./channel-key.js";

// kind 30054 (F-CH-05/§4.7.2) — allowlist комментаторов канала. d-tag — opaque HMAC
// (§4.8: logicalKey = channelId+":"+version), тег `h` для маршрутизации по topic —
// НЕ многобуквенный "channel" (TECH.md исходно предлагал его буквально): найдено живым
// прогоном против strfry — NIP-12 индексирует только однобуквенные теги, "channel"
// relay отклоняет запросом как "unindexed tag filter" (см. transport.js, этап 30).
export function buildAllowlistEvent(channelId, channelTopicHex, version, allowedAuthors, channelKeyHex, ownerPrivKey, masterSecret) {
	const content = encryptChannelContent(JSON.stringify({ channelId, version, allowedAuthors }), channelKeyHex, version);
	const dTag = opaqueDTag(masterSecret, 30054, `${channelId}:${version}`);
	return sign(
		{
			kind: 30054,
			content,
			tags: [
				["d", dTag],
				["h", channelTopicHex],
			],
			created_at: Math.floor(Date.now() / 1000),
		},
		ownerPrivKey,
	);
}

// Верификация комментатора — §4.7.2, шаги 1-5 буквально (шаг 6 верификации Schnorr-
// подписи самого СОБЫТИЯ allowlist уже делает F-EV-02/verifyBatch на приёме, до этой
// функции; здесь — проверка АВТОРСТВА allowlist и расшифровка, не подписи транспорта).
// event.pubkey !== expectedOwnerPubkey -> null СРАЗУ, без попытки расшифровать (allowlist
// не от владельца — не тратим цикл на AEAD чужого контента, F-EV-07 аналог).
// decryptChannelContent может ЛИБО вернуть null (неизвестная версия), ЛИБО бросить
// (известная версия, но ключ/контент не совпадает — AEAD-проверка) — оба случая
// означают "не смогли верифицировать", вызывающий код (channel.js) решает, ловить ли
// исключение как discard (F-EV-06 принцип) или считать это неожиданной ошибкой.
export function parseAndVerifyAllowlist(event, channelKeyHex, expectedOwnerPubkey) {
	if (event.pubkey !== expectedOwnerPubkey) return null;
	const version = readVersionForDecrypt(event.content);
	const decrypted = decryptChannelContent(event.content, { [version]: channelKeyHex });
	if (decrypted === null) return null;
	const parsed = JSON.parse(decrypted);
	return { version: parsed.version, allowedAuthors: parsed.allowedAuthors };
}

function readVersionForDecrypt(base64Content) {
	const bytes = Uint8Array.from(atob(base64Content), (c) => c.charCodeAt(0));
	return new DataView(bytes.buffer, bytes.byteOffset, 4).getUint32(0, false);
}

export function canAuthorComment(authorPubkey, verifiedAllowlist) {
	if (verifiedAllowlist === null || verifiedAllowlist === undefined) return false;
	return verifiedAllowlist.allowedAuthors.includes(authorPubkey);
}
