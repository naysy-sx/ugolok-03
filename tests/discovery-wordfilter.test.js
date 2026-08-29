import { test } from "node:test";
import assert from "node:assert/strict";
import { normalize, findMatches, isClean } from "../src/domain/discovery/wordfilter.js";
import stopwords from "../src/domain/discovery/stopwords.json" with { type: "json" };

// Синтетический словарь ("плохоеслово" не встречается в реальном языке) — тесты
// проверяют МЕХАНИЗМ нормализации/поиска, не конкретное содержимое stopwords.json.
const DICT = ["плохоеслово"];

test("normalize: lowercase + NFKD, обычный текст не меняет смысл", () => {
	assert.equal(normalize("Привет МИР"), normalize("привет мир"));
});

// CONTRACTS.md §DISCOVERY, T8 — цифры-гомоглифы (0->о, 1->і, 3->е, буквально
// три примера ТЗ).
test("normalize: цифры-гомоглифы сводятся к той же форме, что буквы", () => {
	assert.equal(normalize("пл0х0еслов0"), normalize("плохоеслово"));
	assert.equal(normalize("плoхoеслoвo".replace(/o/g, "0")), normalize("плохоеслово"));
});

test("normalize: разрядка (пробелы между буквами) сводится к той же форме", () => {
	assert.equal(normalize("п л о х о е с л о в о"), normalize("плохоеслово"));
});

test("normalize: гомоглифы И разрядка одновременно — тоже сводятся", () => {
	assert.equal(normalize("п л 0 х 0 е с л 0 в 0"), normalize("плохоеслово"));
});

test("findMatches: находит термин внутри более длинного текста, возвращает {term,index}", () => {
	const matches = findMatches("это плохоеслово в предложении", DICT);
	assert.equal(matches.length, 1);
	assert.equal(matches[0].term, "плохоеслово");
	assert.equal(typeof matches[0].index, "number");
});

test("findMatches: несколько вхождений одного термина — все найдены", () => {
	const matches = findMatches("плохоеслово и ещё раз плохоеслово", DICT);
	assert.equal(matches.length, 2);
});

test("isClean: true, если ни один термин словаря не встречается", () => {
	assert.equal(isClean("самый обычный текст без ничего плохого", DICT), true);
});

test("isClean: ловит термин, записанный через пробелы (разрядка)", () => {
	assert.equal(isClean("это п л о х о е с л о в о в тексте", DICT), false);
});

test("isClean: ловит термин, записанный через цифры-гомоглифы", () => {
	assert.equal(isClean("пл0х0еслов0 тут", DICT), false);
});

// Честный тест-документация (ТЗ, тест №9) — известный, СОЗНАТЕЛЬНЫЙ предел:
// межскриптовый confusable (кириллическая "а" U+0430 вместо латинской "a")
// НЕ ловится — NFKD не декомпозирует разные кодпоинты друг в друга, полная
// таблица Unicode-confusables (TR39) — несоразмерная сложность для фильтра,
// который и так "ловит ленивых, упорных — нет".
test("isClean: РЕДКАЯ юникод-подстановка (кириллица вместо латиницы в другом слове) проходит фильтр — известный, задокументированный предел, не баг", () => {
	// "bad" — латиница, дословный дубль ниже — та же строка с кириллической "а" (U+0430)
	const dict = ["bad"];
	const cyrillicA = "а"; // кириллическая "а", визуально неотличима от латинской
	const evasive = `b${cyrillicA}d`;
	assert.notEqual(evasive, "bad", "строки физически разные кодпоинты, несмотря на визуальное совпадение");
	assert.equal(isClean(evasive, dict), true, "фильтр НЕ ловит межскриптовый confusable — задокументированный предел");
});

test("stopwords.json: непустой массив строк (базовая целостность файла, не проверка содержимого)", () => {
	assert.ok(Array.isArray(stopwords));
	assert.ok(stopwords.length > 0);
	assert.ok(stopwords.every((w) => typeof w === "string" && w.length > 0));
});
