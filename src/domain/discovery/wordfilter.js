// CONTRACTS.md §DISCOVERY, T8 — БЕЗ зависимостей от браузерного API: этот файл
// импортируется и клиентом (refreshDiscoveryProfiles/VisibilitySection), и
// серверным write-policy плагином strfry (Node, server/strfry/whitelist-plugin.mjs).
// Известный предел (задокументирован тестом): межскриптовые confusable-омографы
// (кириллическая "а" вместо латинской и т.п.) не ловятся — NFKD их не
// декомпозирует друг в друга, полная таблица Unicode confusables (TR39) —
// несоразмерная сложность для фильтра, который и так "ловит ленивых, упорных — нет".

export function normalize(text) {
	if (typeof text !== "string") return "";

	let result = text.toLowerCase();
	result = result.normalize("NFKD");
	// Combining-марки (U+0300-U+036F) — стандартный парный приём с NFKD.
	result = result.replace(/[̀-ͯ]/g, "");
	// Цифры-гомоглифы (ТЗ, буквально три примера): 0->о, 1->і, 3->е.
	result = result.replace(/0/g, "о").replace(/1/g, "і").replace(/3/g, "е");
	// Полностью убрать пробелы (не схлопнуть до одного) — иначе разрядка
	// "п и д о р" не свелась бы к "пидор".
	result = result.replace(/\s+/g, "");

	return result;
}

export function findMatches(text, dictionary) {
	const normalizedText = normalize(text);
	const matches = [];

	for (const term of dictionary) {
		const normalizedTerm = normalize(term);
		if (!normalizedTerm) continue;

		let index = normalizedText.indexOf(normalizedTerm);
		while (index !== -1) {
			matches.push({ term, index });
			index = normalizedText.indexOf(normalizedTerm, index + 1);
		}
	}

	return matches;
}

export function isClean(text, dictionary) {
	return findMatches(text, dictionary).length === 0;
}
