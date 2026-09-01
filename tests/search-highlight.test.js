// Глобальный поиск, экран результатов, задача 1.3 (SEARCH-UI-TASK.md §9,
// §3.4). buildSnippet — чистая функция, помечена [C] (интервальная
// склейка перекрывающихся вхождений + сопоставление позиций между
// нормализованным и исходным текстом требуют явного рассуждения, не
// шаблонная задача). Написано ДО реализации (orchestrate-workers, правило
// 14). Решение вопреки временной мере из §3.4 документа: там предлагалась
// упрощённая нормализация "на будущее заменить на normalize из
// matching.js" — matching.js УЖЕ существует (этап И1 закрыт до начала
// этой задачи), поэтому buildSnippet сразу использует настоящий normalize,
// без временной кривой версии.

import { test } from "node:test";
import assert from "node:assert/strict";
import { buildSnippet } from "../src/ui/search-highlight.js";
import { normalize } from "../src/domain/search/matching.js";

function plain(segments) {
	return segments.map((s) => s.text).join("");
}

function marks(segments) {
	return segments.filter((s) => s.mark).map((s) => s.text);
}

test("buildSnippet: совпадение в начале текста — без ведущего многоточия", () => {
	const text = "работа начинается с понедельника и продолжается долго";
	const segs = buildSnippet(text, [normalize("работа")], { radius: 20 });
	assert.equal(plain(segs).length <= text.length, true);
	assert.equal(segs[0].ellipsis ?? false, false, "не должно быть ведущего многоточия, если совпадение у самого начала");
	assert.deepEqual(marks(segs), ["работа"]);
});

test("buildSnippet: совпадение в середине длинного текста — многоточие с обеих сторон", () => {
	const filler = "а".repeat(300);
	const text = `${filler} деньги ${filler}`;
	const segs = buildSnippet(text, [normalize("деньги")], { radius: 20 });
	assert.equal(segs[0].ellipsis, true, "нет ведущего многоточия у длинного текста");
	assert.equal(segs[segs.length - 1].ellipsis, true, "нет хвостового многоточия у длинного текста");
	assert.deepEqual(marks(segs), ["деньги"]);
	// Окно вокруг совпадения не должно включать ВЕСЬ filler.
	assert.ok(plain(segs).length < text.length);
});

test("buildSnippet: несколько частей — обе помечены", () => {
	const text = "нужны деньги на срочную работу по дому";
	const segs = buildSnippet(text, [normalize("деньги"), normalize("работу")], { radius: 40 });
	assert.deepEqual(marks(segs).sort(), ["деньги", "работу"].sort());
});

test("buildSnippet: части внахлёст — не даёт вложенных/задвоенных сегментов", () => {
	// "работа" и "аботать" пересекаются в слове "отработать" — регион
	// перекрытия обязан склеиться в ОДИН mark-сегмент, а не в два разных
	// с повторно посчитанной серединой.
	const text = "мне нужно отработать эту смену полностью";
	const segs = buildSnippet(text, [normalize("работать"), normalize("отработ")], { radius: 40 });
	const markedText = segs.filter((s) => s.mark).map((s) => s.text).join("");
	// "отработ" (7) + "ать" — хвост слова "отработать" не входит во вторую
	// часть запроса, но входит в первую ("работать") — объединение region'ов
	// должно дать РОВНО "отработать" одним куском, не "отработ"+"работать"
	// задвоенно и не два обрезанных фрагмента.
	assert.equal(markedText, "отработать");
	// Ни один mark-сегмент не должен непосредственно граничить с другим mark-сегментом
	// (это и есть признак "не склеили перекрытие").
	for (let i = 1; i < segs.length; i++) {
		if (segs[i].mark && segs[i - 1].mark) assert.fail("два соседних mark-сегмента не склеены");
	}
});

test("buildSnippet: части не найдено вовсе — не падает, возвращает текст без пометок", () => {
	const text = "здесь ничего релевантного нет";
	const segs = buildSnippet(text, [normalize("отсутствует")], { radius: 40 });
	assert.deepEqual(marks(segs), []);
	assert.equal(plain(segs).length > 0, true);
});

test("buildSnippet: пустой массив parts — весь текст одним немаркированным сегментом", () => {
	const text = "произвольный текст";
	const segs = buildSnippet(text, [], { radius: 40 });
	assert.equal(segs.length, 1);
	assert.equal(segs[0].mark, false);
	assert.equal(segs[0].text, text);
});

// --- Диакритика: подсветка обязана находить то же, что находит движок ---
test("buildSnippet: диакритика — запрос 'еще' подсвечивает 'ещё' в исходном тексте (без искажения символов)", () => {
	const text = "это ещё не готово";
	const segs = buildSnippet(text, [normalize("еще")], { radius: 40 });
	const markedRaw = segs.filter((s) => s.mark).map((s) => s.text).join("");
	assert.equal(markedRaw, "ещё", "подсвеченный кусок обязан быть исходным 'ещё', не 'еще' и не искажённым");
	assert.equal(plain(segs), text, "реконструкция сегментов обязана давать байт-в-байт исходный текст (без урезания в этом сценарии)");
});

test("buildSnippet: реконструкция сегментов (без учёта эллипсисов) всегда равна вырезанному окну исходного текста", () => {
	const text = "деньги пришли вчера вечером, а работа началась только сегодня утром";
	const segs = buildSnippet(text, [normalize("работа")], { radius: 15 });
	const idx = text.indexOf("работа");
	const expectedStart = Math.max(0, idx - 15);
	const nonEllipsis = segs.filter((s) => !s.ellipsis).map((s) => s.text).join("");
	assert.equal(text.slice(expectedStart, expectedStart + nonEllipsis.length), nonEllipsis);
});

test("buildSnippet: не роняет regex-спецсимволы в частях запроса", () => {
	const text = "цена 5*3 руб (скидка) сегодня";
	const segs = buildSnippet(text, [normalize("5*3")], { radius: 40 });
	assert.deepEqual(marks(segs), ["5*3"]);
});
