// AUDIT-EGOROD (соседняя находка J1). `picture` из kind:0 чужого автора шёл прямо
// в <img src>: любой контакт или незнакомец из «Обзора» мог вписать туда адрес
// своего сервера и узнавать IP и время просмотра у каждого, кто открыл список —
// то есть клиент ходил бы не только в свой инстанс (GATEWAY-TZ-1 §1), а туда, куда
// скажет чужой профиль. Аватар легитимно лежит на Blossom (profile.jsx →
// uploadAvatarBlob) либо data:/blob: — всё остальное отбрасывается, интерфейс
// показывает инициалы.
import { BUILD_DEFAULT_BLOSSOM_SERVERS } from "../../config.js";
import { getRuntimeConfig } from "../settings/runtime-config.js";

const extra = new Set();
const RASTER_DATA_URL = /^data:image\/(png|jpe?g|webp|gif|avif);base64,/i;

function originOf(url) {
	try {
		const u = new URL(url);
		return u.protocol === "https:" || u.protocol === "http:" ? u.origin : null;
	} catch {
		return null;
	}
}

// Пользовательский список Blossom-серверов (настройки) — регистрируется при
// загрузке/сохранении настроек.
export function registerTrustedImageOrigins(urls) {
	extra.clear();
	for (const url of urls ?? []) {
		const origin = originOf(url);
		if (origin) extra.add(origin);
	}
}

function trustedOrigins() {
	const out = new Set(extra);
	for (const url of [...(BUILD_DEFAULT_BLOSSOM_SERVERS ?? []), ...(getRuntimeConfig().blossomServers ?? [])]) {
		const origin = originOf(url);
		if (origin) out.add(origin);
	}
	return out;
}

export function isTrustedImageUrl(url) {
	if (typeof url !== "string" || url.length === 0 || url.length > 4096) return false;
	if (RASTER_DATA_URL.test(url)) return true;
	if (url.startsWith("blob:")) return true;
	const origin = originOf(url);
	return origin !== null && trustedOrigins().has(origin);
}

// Возвращает url или "" — для подстановки в профиль.
export function safePictureUrl(url) {
	return isTrustedImageUrl(url) ? url : "";
}
