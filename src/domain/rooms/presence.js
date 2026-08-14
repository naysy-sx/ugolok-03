// Rooms, этапы 1+4 — присутствие: CvRDT-полурешётка. Контракт: PROCESS-DOCS/CONTRACTS.md
// "Rooms — Этап 1"/"Этап 4"; формализация: ROOMS-MATH-v2.md §2/§4.3, ROOMS-ALGO.md §2/§3.1.
//
// L : Map<pubkeyHex, {a, r, nick, inVoice, joinedAt}> — a = момент последнего
// подтверждения присутствия (heartbeat), r = момент объявленного выхода. Слияние
// покомпонентно max на (a, r) — join-полурешётка (ROOMS-MATH §2.2): коммутативно,
// ассоциативно, идемпотентно, порядок доставки не имеет значения.
//
// НИ ОДНА функция не вызывает Date.now() — время всегда параметр (ROOMS-SPEC §2).

export function emptyPresence() {
	return new Map();
}

// joinedAt — деталь, не покрытая формулами MATH явно (решение реализации,
// см. CONTRACTS.md). ПЕРВАЯ версия ("сохранять joinedAt, если предыдущее
// состояние уже присутствовало") оказалась НЕ коммутативной: два heartbeat
// ОДНОГО периода (без exit между ними), доставленные в разном порядке, давали
// разный joinedAt — пойман адверсарным тестом на ассоциативность до того, как
// это стало живым багом (список участников скакал бы по-разному у разных
// наблюдателей). Исправлено на min-накопление внутри периода: joinedAt = min
// всех `at`, ЕЩЁ НЕ "закрытых" известным `r`. min коммутативен/ассоциативен
// по построению — порядок доставки heartbeat одного периода больше не важен.
// "Период закрыт" — известный `r` не меньше текущего joinedAt (т.е. exit
// пришёл ПОСЛЕ начала этого периода) — тогда следующий heartbeat стартует
// НОВЫЙ период (joinedAt = at), это и даёт требуемое "повторный вход после
// exit обновляет joinedAt". nick — LWW внутри записи по at: более старое at
// не откатывает более свежий nick (тот же принцип, что pickLatest в проекте).
// inVoice (Этап 4, CONTRACTS.md "Rooms — Этап 4" §1) — тот же LWW-по-at, что nick:
// оба поля приходят В ОДНОМ heartbeat, отдельная временная метка на inVoice не
// нужна — используется тот же nickAt-барьер (переименовывать поле — лишний churn,
// семантика "момент последнего обновления nick/inVoice вместе" не меняется).
export function mergeHeartbeat(state, { pubkey, nick, inVoice = false, at }) {
	const next = new Map(state);
	const existing = next.get(pubkey);
	if (!existing) {
		next.set(pubkey, { a: at, r: -Infinity, nick, inVoice, nickAt: at, joinedAt: at });
		return next;
	}
	const periodClosed = existing.r >= existing.joinedAt;
	const joinedAt = periodClosed ? at : Math.min(existing.joinedAt, at);
	const a = Math.max(existing.a, at);
	const nickAt = existing.nickAt ?? existing.a;
	const useNewFields = at >= nickAt;
	next.set(pubkey, {
		a,
		r: existing.r,
		nick: useNewFields ? nick : existing.nick,
		inVoice: useNewFields ? inVoice : existing.inVoice,
		nickAt: useNewFields ? at : nickAt,
		joinedAt,
	});
	return next;
}

export function mergeExit(state, { pubkey, at }) {
	const next = new Map(state);
	const existing = next.get(pubkey);
	if (!existing) {
		// Выход без предшествующего heartbeat (не должно происходить в норме, но
		// покомпонентный max обязан быть определён везде — a остаётся -Infinity,
		// предикат present() уже ложен без специального случая).
		next.set(pubkey, { a: -Infinity, r: at, nick: "", inVoice: false, joinedAt: at });
		return next;
	}
	next.set(pubkey, { ...existing, r: Math.max(existing.r, at) });
	return next;
}

// Present(t) = { d : a_d > r_d ∧ a_d ≥ t − τ } — ROOMS-MATH §2.2 буквально,
// граница НЕСТРОГАЯ (>=). Порядок — по joinedAt возрастанию, стабильный.
export function present(state, now, tau) {
	const result = [];
	for (const [pubkey, entry] of state) {
		if (entry.a > entry.r && entry.a >= now - tau) {
			result.push({ pubkey, nick: entry.nick, joinedAt: entry.joinedAt, inVoice: entry.inVoice });
		}
	}
	result.sort((x, y) => x.joinedAt - y.joinedAt);
	return result;
}

// Обрезка безопасна (ROOMS-ALGO §2.2, доказательство там же): удаление записи с
// a < now-τ наблюдательно эквивалентно её сохранению для любого будущего t' >= now.
// Условие СТРОГО по a, НЕ зависит от r — уже вышедший, но недавний (по a) участник
// не обрезается раньше срока естественного протухания аренды.
export function prune(state, now, tau) {
	const next = new Map();
	for (const [pubkey, entry] of state) {
		if (entry.a >= now - tau) next.set(pubkey, entry);
	}
	return next;
}
