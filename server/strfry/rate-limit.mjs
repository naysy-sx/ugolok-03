// AUDIT-EGOROD G1/G5. Лимитер записи для write-policy: чистые функции с
// инъекцией часов, состояние — только в памяти процесса плагина (strfry держит
// один процесс плагина на relay). Потеря состояния при перезапуске безвредна:
// окна короткие.
//
// Что ограничивается и почему именно так:
//  - события в минуту НА PUBKEY — основной предохранитель одного «болтливого» или
//    злого ключа;
//  - события в минуту НА IP — вторая линия против ботнета с одного адреса, но с
//    большим запасом: за мобильным CGNAT один адрес делят тысячи честных
//    пользователей, а для нашей аудитории это типовая ситуация;
//  - НОВЫХ pubkey в час на IP — единственная защита от «фермы ключей» (ключ
//    бесплатен, лимит «на пользователя» бесполезен, когда пользователей тысячи).
// Все три — фиксированные окна со счётчиком, без хранения событий.

export const DEFAULT_LIMITS = Object.freeze({
	perPubkeyPerMinute: 300, // звонок/комната шлют десятки сигнальных событий за раз
	perIpPerMinute: 1500,
	newPubkeysPerIpPerHour: 60,
});

const MAX_TRACKED_KEYS = 200_000; // потолок памяти: при переполнении чистим просроченное, а затем всё

function bump(map, key, windowMs, now) {
	let entry = map.get(key);
	if (!entry || now - entry.start >= windowMs) {
		entry = { start: now, count: 0 };
		map.set(key, entry);
	}
	entry.count += 1;
	return entry.count;
}

export function mergeLimits(raw) {
	const out = { ...DEFAULT_LIMITS };
	for (const key of Object.keys(DEFAULT_LIMITS)) {
		const v = Number(raw?.[key]);
		if (Number.isFinite(v) && v > 0) out[key] = v;
	}
	return out;
}

export function createLimiter() {
	const perPubkey = new Map();
	const perIp = new Map();
	const ipKeys = new Map(); // ip -> { start, keys:Set }
	const stats = { accepted: 0, limitedPubkey: 0, limitedIp: 0, limitedNewKeys: 0, newPubkeys: 0 };

	function sweep(now) {
		const total = perPubkey.size + perIp.size + ipKeys.size;
		if (total < MAX_TRACKED_KEYS) return;
		for (const [k, v] of perPubkey) if (now - v.start >= 60_000) perPubkey.delete(k);
		for (const [k, v] of perIp) if (now - v.start >= 60_000) perIp.delete(k);
		for (const [k, v] of ipKeys) if (now - v.start >= 3_600_000) ipKeys.delete(k);
		if (perPubkey.size + perIp.size + ipKeys.size >= MAX_TRACKED_KEYS) {
			perPubkey.clear();
			perIp.clear();
			ipKeys.clear();
		}
	}

	// Возвращает null (можно) или { reason } — причину отказа.
	function check({ ip, pubkey, now = Date.now(), limits = DEFAULT_LIMITS }) {
		sweep(now);
		if (ip) {
			let entry = ipKeys.get(ip);
			if (!entry || now - entry.start >= 3_600_000) {
				entry = { start: now, keys: new Set() };
				ipKeys.set(ip, entry);
			}
			if (!entry.keys.has(pubkey)) {
				if (entry.keys.size >= limits.newPubkeysPerIpPerHour) {
					stats.limitedNewKeys += 1;
					return { reason: "too many new keys from this address" };
				}
				entry.keys.add(pubkey);
				stats.newPubkeys += 1;
			}
			if (bump(perIp, ip, 60_000, now) > limits.perIpPerMinute) {
				stats.limitedIp += 1;
				return { reason: "too many events from this address" };
			}
		}
		if (bump(perPubkey, pubkey, 60_000, now) > limits.perPubkeyPerMinute) {
			stats.limitedPubkey += 1;
			return { reason: "too many events from this key" };
		}
		stats.accepted += 1;
		return null;
	}

	// Снимок счётчиков и сброс — для периодической строки в журнал (G5).
	function drainStats() {
		const snapshot = { ...stats, trackedKeys: perPubkey.size, trackedIps: perIp.size };
		for (const k of Object.keys(stats)) stats[k] = 0;
		return snapshot;
	}

	return { check, drainStats };
}
