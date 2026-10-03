// push-bridge-client.js — HTTP-клиент моста Э-PUSH (POST/PUT/DELETE
// /push/register, NIP-98 — kind 27235). ТЗ: PROCESS-DOCS/NATIVE-APPS/
// TZ-PUSH-ANDROID.md, П3.2/П3.3. Контракт сервера — agent/internal/pushbridge/
// (nip98.go/server.go), PUSH-P1-REPORT.md.
//
// Тот же паттерн, что blossom-client.js's BUD-02-авторизация (kind 24242):
// собрать событие, подписать существующим src/core/crypto/sign.js, отправить
// как заголовок "Nostr <base64>". Не переиспользует blossom-client.js
// буквально — контракт NIP-98 (теги u/method, без expiration/x) достаточно
// другой, чтобы не натягивать общую функцию на два разных протокола.
import { sign } from "../crypto/sign.js";

const NIP98_KIND = 27235;

function buildAuthEvent(method, url) {
	return {
		kind: NIP98_KIND,
		created_at: Math.floor(Date.now() / 1000),
		content: "",
		tags: [
			["u", url],
			["method", method],
		],
	};
}

function encodeAuthHeader(event) {
	const json = JSON.stringify(event);
	const base64 = typeof btoa === "undefined" ? Buffer.from(json, "utf8").toString("base64") : btoa(json);
	return "Nostr " + base64;
}

function stripTrailingSlash(url) {
	return url.endsWith("/") ? url.slice(0, -1) : url;
}

// registerUrl — точный внешний URL /push/register (config.json's pushBridge +
// "/register"), должен байт-в-байт совпадать с тегом "u", который сервер
// сверяет (agent/internal/pushbridge/nip98.go) — формируется ЗДЕСЬ, один раз,
// используется и для подписи, и для самого запроса.
function registerUrl(bridgeBaseUrl) {
	return stripTrailingSlash(bridgeBaseUrl) + "/register";
}

async function request(method, bridgeBaseUrl, privateKey, { body, fetchImpl = globalThis.fetch, signal, timeoutMs = 10000 } = {}) {
	const url = registerUrl(bridgeBaseUrl);
	const authEvent = sign(buildAuthEvent(method, url), privateKey);
	const res = await fetchImpl(url, {
		method,
		headers: {
			Authorization: encodeAuthHeader(authEvent),
			...(body ? { "Content-Type": "application/json" } : {}),
		},
		body: body ? JSON.stringify(body) : undefined,
		signal: signal ?? AbortSignal.timeout(timeoutMs),
	});
	return res;
}

// registerPush/updatePushFilters — П3.2/П3.3. groups — массив hex h-тегов MLS-
// групп владельца ключа (agent/internal/pushbridge/store.go — "groups").
// Ответ сервера: { endpoint, topic, expires_at } (registerResponse, server.go).
async function postOrPut(method, bridgeBaseUrl, groups, privateKey, options) {
	const res = await request(method, bridgeBaseUrl, privateKey, { ...options, body: { groups: groups ?? [] } });
	if (!res.ok) {
		throw new Error(`push-bridge: ${method} /push/register -> ${res.status}`);
	}
	return res.json();
}

export function registerPush(bridgeBaseUrl, groups, privateKey, options) {
	return postOrPut("POST", bridgeBaseUrl, groups, privateKey, options);
}

export function updatePushFilters(bridgeBaseUrl, groups, privateKey, options) {
	return postOrPut("PUT", bridgeBaseUrl, groups, privateKey, options);
}

// unregisterPush — П3.2 «при выходе из аккаунта и удалении аккаунта — DELETE».
// 404 ("уже не зарегистрирован") — не ошибка вызывающего кода: конечный
// результат (нет активной регистрации) тот же, что после успешного DELETE.
export async function unregisterPush(bridgeBaseUrl, privateKey, options) {
	const res = await request("DELETE", bridgeBaseUrl, privateKey, options);
	if (!res.ok && res.status !== 404) {
		throw new Error(`push-bridge: DELETE /push/register -> ${res.status}`);
	}
}
