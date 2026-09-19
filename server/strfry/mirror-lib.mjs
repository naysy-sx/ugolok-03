// GATEWAY-TZ-1.md §3–§4. Чистые функции тяги и бюджета зеркала — без
// процессов и файлов, тестируются node --test (tests/mirror-lib.test.js).
import { effectiveMirrorKinds } from "./write-policy.mjs";

const DEFAULT_INTERVAL_SECONDS = 300;
const DEFAULT_BUDGET = { maxBytes: 2 * 1024 ** 3, retentionDays: 30 };
// Порог тишины: пока пир недоступен меньше стольких попыток подряд, в журнал
// ничего не пишем (§4 «молчит, пока не превысит порог»).
export const LOG_AFTER_FAILURES = 5;

export function pullIntervalMs(peers) {
	const s = Number(peers?.intervalSeconds);
	return (Number.isFinite(s) && s >= 10 ? s : DEFAULT_INTERVAL_SECONDS) * 1000;
}

export function budgetOf(peers) {
	const b = peers?.budget ?? {};
	const maxBytes = Number(b.maxBytes);
	const retentionDays = Number(b.retentionDays);
	return {
		maxBytes: Number.isFinite(maxBytes) && maxBytes > 0 ? maxBytes : DEFAULT_BUDGET.maxBytes,
		retentionDays: Number.isFinite(retentionDays) && retentionDays > 0 ? retentionDays : DEFAULT_BUDGET.retentionDays,
	};
}

// Тот же принцип, что computeBackoffDelay в src/core/transport/relay-pool.js
// (экспонента с потолком и разбросом), но в масштабе опроса: база — интервал
// тяги, потолок — час. Копия формулы, а не импорт: серверный скрипт не должен
// тянуть клиентский транспорт.
export function backoffDelayMs(attempt, baseMs, { maxMs = 3600_000, multiplier = 1.7, jitter = 0.3, random = Math.random } = {}) {
	const raw = Math.min(baseMs * multiplier ** attempt, maxMs);
	const spread = raw * jitter;
	return raw - spread + random() * spread * 2;
}

// Фильтр тяги для strfry sync. since — не раньше границы хранения и не раньше
// границы последней очистки по объёму: иначе тяга снова скачала бы то, что
// очистка только что удалила, и диск ходил бы кругами. null — нечего тянуть.
export function buildPullFilter(peer, peers, { nowSec, pruneCutoffSec = 0 }) {
	const kinds = effectiveMirrorKinds(peer, peers);
	if (kinds.length === 0) return null;
	const retentionCutoff = nowSec - budgetOf(peers).retentionDays * 86400;
	return { kinds, since: Math.max(retentionCutoff, pruneCutoffSec > 0 ? pruneCutoffSec + 1 : 0) };
}

// Решение очистки. events — [{id, pubkey, kind, created_at, ...}] (вывод
// `strfry scan`). Кандидат на удаление — событие, которое ОДНОВРЕМЕННО не
// своё (pubkey не в whitelist) и входит в настроенные зеркальные kind'ы. Свои
// события не вытесняются никогда, а какие-то посторонние kind'ы не трогаются
// вовсе. Сначала по сроку, затем самые старые, пока объём кандидатов не ниже
// нижней отметки (90% потолка) — чтобы не запускать очистку на каждый цикл.
//
// При whitelist "*" различить своё и чужое нельзя → отказ, а не «удалим на
// глаз»: неверное удаление своих данных необратимо.
export function selectMirrorEvictions(events, { whitelist, peers, nowSec, sizeOf = (e) => JSON.stringify(e).length }) {
	if (whitelist.has("*")) {
		return { error: "whitelist содержит '*': свои и зеркальные события неразличимы, очистка отказана" };
	}
	const mirrorKinds = new Set();
	for (const p of peers?.peers ?? []) for (const k of effectiveMirrorKinds(p, peers)) mirrorKinds.add(k);
	const { maxBytes, retentionDays } = budgetOf(peers);
	const retentionCutoff = nowSec - retentionDays * 86400;

	const candidates = events
		.filter((e) => !whitelist.has(String(e.pubkey).toLowerCase()) && mirrorKinds.has(e.kind))
		.sort((a, b) => a.created_at - b.created_at);

	const evict = [];
	const kept = [];
	let total = 0;
	for (const e of candidates) {
		if (e.created_at < retentionCutoff) evict.push(e);
		else {
			kept.push(e);
			total += sizeOf(e);
		}
	}
	let sizeCutoffSec = 0;
	const lowWater = maxBytes * 0.9;
	if (total > maxBytes) {
		let i = 0;
		while (i < kept.length && total > lowWater) {
			total -= sizeOf(kept[i]);
			sizeCutoffSec = Math.max(sizeCutoffSec, kept[i].created_at);
			evict.push(kept[i]);
			i++;
		}
	}
	return { ids: evict.map((e) => e.id), sizeCutoffSec, keptBytes: total };
}

// Состояние тяги по пирам: { [url]: { failures, nextAttemptAt, logged } }.
// Возвращает [новое состояние пира, что писать в журнал | null]. Успех после
// записанной в журнал недоступности пишет одну строку о восстановлении;
// недоступность пишется один раз, когда счётчик достиг порога, и не чаще.
export function recordAttempt(prev, ok, { nowMs, baseMs, random }) {
	const state = prev ?? { failures: 0, nextAttemptAt: 0, logged: false };
	if (ok) {
		return [{ failures: 0, nextAttemptAt: 0, logged: false }, state.logged ? "recovered" : null];
	}
	const failures = state.failures + 1;
	const next = { failures, nextAttemptAt: nowMs + backoffDelayMs(failures - 1, baseMs, { random }), logged: state.logged };
	let log = null;
	if (failures >= LOG_AFTER_FAILURES && !state.logged) {
		next.logged = true;
		log = "unreachable";
	}
	return [next, log];
}
