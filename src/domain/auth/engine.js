import { effective, can as bitsetCan } from "./bitset.js";

function groupKey(subject, resource) {
	return JSON.stringify([subject, resource]);
}

function compareRecords(a, b) {
	if (a.lamportTs !== b.lamportTs) return a.lamportTs - b.lamportTs;
	return a.eventId < b.eventId ? -1 : a.eventId > b.eventId ? 1 : 0;
}

// Свёртка журнала в эффективную маску прав — DESIGN.md, раздел "Этап 21".
// Порядок применения строго по (lamportTs, eventId), не по порядку records —
// это то, что делает revoke монотонным относительно причинного порядка
// (R6-5), а не относительно wall-clock/сетевого порядка поступления.
export function rebuildCache(records) {
	const groups = new Map();
	for (const record of records) {
		const key = groupKey(record.subject, record.resource);
		if (!groups.has(key)) groups.set(key, []);
		groups.get(key).push(record);
	}

	const cache = new Map();
	for (const [key, group] of groups) {
		const sorted = group.slice().sort(compareRecords);
		let acc = 0;
		for (const record of sorted) {
			acc = effective(acc | record.allowMask, record.denyMask);
		}
		cache.set(key, acc);
	}
	return cache;
}

export function can(cache, subject, resource, action) {
	const mask = cache.get(groupKey(subject, resource)) ?? 0;
	return bitsetCan(mask, action);
}
