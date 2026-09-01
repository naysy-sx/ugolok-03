import { normalize } from "../domain/search/matching.js";

// Подсветка совпадений в выдаче поиска (SEARCH-UI-TASK.md §3.4). Чистая
// функция, без зависимостей от UI. Решение вопреки временной мере из
// документа-задания: там предполагалась упрощённая нормализация "на
// будущее заменить на normalize из matching.js" — matching.js уже
// существует (этап И1 закрыт раньше этой задачи), поэтому здесь сразу
// настоящий normalize, без временной кривой версии.
//
// `parts` — уже НОРМАЛИЗОВАННЫЕ части запроса (тот же массив, что
// searchState.parts из parseQuery(query).parts, SEARCH-UI-TASK.md §3.1) —
// вызывающий код не нормализует их повторно.
//
// Позиции ищутся в НОРМАЛИЗОВАННОМ представлении текста (иначе диакритика
// разошлась бы с движком — запрос "еще" обязан подсвечивать "ещё"), но
// сегменты возвращаются на исходном тексте. Нормализация посимвольно (по
// кодовым точкам, не по UTF-16 code units — Array.from, не строковый
// индекс) даёт карту "позиция в нормализованной строке -> индекс
// исходного символа": normalize() поверх ОДНОГО символа декомпозирует его
// на базовый + комбинирующие знаки и тут же отбрасывает комбинирующие —
// для кириллицы/латиницы это даёт 0 или 1 нормализованный символ на
// каждый исходный, что и требуется для однозначного обратного отображения.
function normalizedWithMap(text) {
	const chars = Array.from(text);
	let normalized = "";
	const map = [];
	for (let i = 0; i < chars.length; i++) {
		const piece = normalize(chars[i]);
		for (let j = 0; j < piece.length; j++) map.push(i);
		normalized += piece;
	}
	return { normalized, map, chars };
}

// Все непересекающиеся (после склейки) отрезки [start, end) исходного
// текста, покрытые хотя бы одной частью запроса.
function findMarkRanges(normalized, map, parts) {
	const raw = [];
	for (const part of parts) {
		if (!part) continue;
		let from = 0;
		while (true) {
			const idx = normalized.indexOf(part, from);
			if (idx === -1) break;
			const startChar = map[idx];
			const endChar = map[idx + part.length - 1] + 1; // исключающая граница
			raw.push([startChar, endChar]);
			from = idx + 1; // допускаем перекрывающиеся вхождения одной части
		}
	}
	if (raw.length === 0) return [];
	raw.sort((a, b) => a[0] - b[0]);
	const merged = [raw[0].slice()];
	for (let i = 1; i < raw.length; i++) {
		const last = merged[merged.length - 1];
		const [s, e] = raw[i];
		if (s <= last[1]) {
			last[1] = Math.max(last[1], e);
		} else {
			merged.push([s, e]);
		}
	}
	return merged;
}

export function buildSnippet(text, parts, { radius = 90 } = {}) {
	const cleanParts = (parts ?? []).filter(Boolean);
	const { normalized, map, chars } = normalizedWithMap(text);

	if (cleanParts.length === 0) {
		return [{ text, mark: false }];
	}

	let firstMatchChar = -1;
	for (const part of cleanParts) {
		const idx = normalized.indexOf(part);
		if (idx === -1) continue;
		const charIdx = map[idx];
		if (firstMatchChar === -1 || charIdx < firstMatchChar) firstMatchChar = charIdx;
	}

	// Ни одна часть не нашлась (не должно происходить для записи, которая
	// прошла matches() в движке, но buildSnippet — самостоятельная функция
	// со своим контрактом, обязана вести себя предсказуемо и здесь).
	if (firstMatchChar === -1) {
		const windowEnd = Math.min(chars.length, radius * 3);
		const cutTail = windowEnd < chars.length;
		const out = [{ text: chars.slice(0, windowEnd).join(""), mark: false }];
		if (cutTail) out.push({ text: "…", mark: false, ellipsis: true });
		return out;
	}

	const windowStart = Math.max(0, firstMatchChar - radius);
	const windowEnd = Math.min(chars.length, windowStart + radius * 3);
	const cutHead = windowStart > 0;
	const cutTail = windowEnd < chars.length;

	const ranges = findMarkRanges(normalized, map, cleanParts);

	const segments = [];
	if (cutHead) segments.push({ text: "…", mark: false, ellipsis: true });

	let cursor = windowStart;
	for (const [start, end] of ranges) {
		const clampedStart = Math.max(start, windowStart);
		const clampedEnd = Math.min(end, windowEnd);
		if (clampedEnd <= windowStart || clampedStart >= windowEnd) continue; // вне окна
		if (clampedStart > cursor) {
			segments.push({ text: chars.slice(cursor, clampedStart).join(""), mark: false });
		}
		segments.push({ text: chars.slice(clampedStart, clampedEnd).join(""), mark: true });
		cursor = clampedEnd;
	}
	if (cursor < windowEnd) {
		segments.push({ text: chars.slice(cursor, windowEnd).join(""), mark: false });
	}
	if (cutTail) segments.push({ text: "…", mark: false, ellipsis: true });

	return segments;
}
