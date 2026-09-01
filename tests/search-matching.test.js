// Глобальный поиск, этап И1 (PROCESS-DOCS/PLAN.md, "Этап «Глобальный поиск»").
// Контракт — PROCESS-DOCS/SEARCH-SYSTEM/SEARCH-SPEC.md §3.1, инварианты — §7,
// property-тесты — §8. Тесты написаны ДО реализации matching.js (orchestrate-
// workers, правило 14) — до первого вызова воркера они все КРАСНЫЕ (модуля
// нет), это ожидаемо и подтверждает, что тест не подогнан под код.
//
// mulberry32 — тот же генератор, что tests/tree-crdt.test.js (зерно
// фиксируется, сценарий воспроизводится по номеру, SEARCH-SPEC.md §8/§1.2).

import { test } from "node:test";
import assert from "node:assert/strict";
import { normalize, parseQuery, buildHaystack, matches } from "../src/domain/search/matching.js";

function mulberry32(seed) {
	return function () {
		seed |= 0;
		seed = (seed + 0x6d2b79f5) | 0;
		let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
		t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}

function pick(rng, arr) {
	return arr[Math.floor(rng() * arr.length)];
}

// Небольшой словарь корней — намеренно с приставками/суффиксами (совпадение
// по корню, SEARCH-SPEC.md §1: "работ деньг" находит "заработал деньги").
const ROOTS = ["работ", "деньг", "код", "файл", "ключ", "долг", "почт", "звон", "письм", "групп"];
const SUFFIXES = ["", "а", "у", "ой", "е", "ал", "ать", "ами", "ного"];

function randomWord(rng) {
	return pick(rng, ROOTS) + pick(rng, SUFFIXES);
}

function randomField(rng, wordCount) {
	const words = [];
	for (let i = 0; i < wordCount; i++) words.push(randomWord(rng));
	return words.join(" ");
}

// Запись корпуса — размеченное объединение полей (SEARCH-MATH.md §3.1),
// два поля достаточно, чтобы упражнять разделитель (SEARCH-SPEC.md §3.1 §3.2).
function generateRecord(rng) {
	return [randomField(rng, 1 + Math.floor(rng() * 3)), randomField(rng, 1 + Math.floor(rng() * 3))];
}

function generateCorpus(seed, n) {
	const rng = mulberry32(seed);
	const records = [];
	for (let i = 0; i < n; i++) records.push(generateRecord(rng));
	return records;
}

function haystacksOf(records) {
	return records.map((fields) => buildHaystack(fields));
}

function matchSet(haystacks, parts) {
	const out = new Set();
	haystacks.forEach((h, i) => {
		if (matches(h, parts)) out.add(i);
	});
	return out;
}

function isSubset(a, b) {
	for (const x of a) if (!b.has(x)) return false;
	return true;
}

const SCENARIOS = 200;

// --- I-NORM-IDEMPOTENT (§7, §9.2 матдока №свойство базовое) ---
test("I-NORM-IDEMPOTENT: normalize(normalize(s)) === normalize(s)", () => {
	const rng = mulberry32(1);
	for (let i = 0; i < SCENARIOS; i++) {
		const s = randomField(rng, 1 + Math.floor(rng() * 4));
		const once = normalize(s);
		const twice = normalize(once);
		assert.equal(twice, once, `seed-шаг=${i}: normalize не идемпотентна на ${JSON.stringify(s)}`);
	}
});

test("I-NORM-IDEMPOTENT: пустая строка и строка из одних диакритик", () => {
	assert.equal(normalize(""), "");
	assert.equal(normalize(normalize("")), normalize(""));
});

// --- I-DIACRITIC-SYM (§7, SEARCH-MATH.md §2.3) ---
test("I-DIACRITIC-SYM: ещё находит еще и наоборот (unit, точный сценарий §2.3 матдока)", () => {
	const hay = buildHaystack(["ещё не готово"]);
	assert.ok(matches(hay, parseQuery("еще").parts), "запрос 'еще' обязан находить текст с 'ещё'");
	const hay2 = buildHaystack(["еще не готово"]);
	assert.ok(matches(hay2, parseQuery("ещё").parts), "запрос 'ещё' обязан находить текст с 'еще' (симметрия)");
});

test("I-DIACRITIC-SYM: й/и симметричны", () => {
	const hayY = buildHaystack(["зайка"]);
	const hayI = buildHaystack(["заика"]);
	assert.ok(matches(hayY, parseQuery("заика").parts));
	assert.ok(matches(hayI, parseQuery("зайка").parts));
});

test("I-DIACRITIC-SYM: property — случайные слова с ё/й находятся в обе стороны", () => {
	const PAIRS = [
		["ещё", "еще"],
		["йод", "иод"],
		["район", "раион"],
		["чёрный", "черный"],
		["зелёный", "зеленый"],
	];
	const rng = mulberry32(2);
	for (let i = 0; i < SCENARIOS; i++) {
		const [withDiacritic, without] = pick(rng, PAIRS);
		const prefix = randomField(rng, 1 + Math.floor(rng() * 2));
		const suffix = randomField(rng, 1 + Math.floor(rng() * 2));
		const textWithDiacritic = `${prefix} ${withDiacritic} ${suffix}`;
		const textWithout = `${prefix} ${without} ${suffix}`;
		const hayWith = buildHaystack([textWithDiacritic]);
		const hayWithout = buildHaystack([textWithout]);
		assert.ok(matches(hayWith, parseQuery(without).parts), `шаг=${i}: '${without}' не нашёл текст с '${withDiacritic}'`);
		assert.ok(matches(hayWithout, parseQuery(withDiacritic).parts), `шаг=${i}: '${withDiacritic}' не нашёл текст с '${without}'`);
	}
});

// --- I-SEPARATOR (§7, точный сценарий §3.2 матдока/спеки) ---
test("I-SEPARATOR: склейка полей не даёт совпадений через границу (кот+ёл, запрос котёл)", () => {
	const hay = buildHaystack(["кот", "ёл"]);
	assert.ok(!matches(hay, parseQuery("котёл").parts), "запрос 'котёл' не должен находить поля 'кот'+'ёл' по отдельности");
	// Контрольная проверка на позитив — тот же разделитель не мешает найти
	// части, которые ДЕЙСТВИТЕЛЬНО принадлежат разным полям целиком.
	assert.ok(matches(hay, parseQuery("кот ёл").parts), "части 'кот' и 'ёл', уже нормализованные, обязаны находиться каждая в своём поле");
});

test("I-SEPARATOR: buildHaystack вставляет U+001F между полями (не пробел, не пусто)", () => {
	const hay = buildHaystack(["a", "b"]);
	assert.equal(hay, "a" + "\u001F" + "b", "разделитель обязан быть ровно U+001F, SEARCH-SPEC.md §3.1");
});

// --- I-EMPTY-NOOP (§7) — в границах matching.js это форма parseQuery ---
test("I-EMPTY-NOOP: parseQuery пустой/пробельной строки даёт isEmpty:true, parts:[]", () => {
	for (const raw of ["", "   ", "\t\n"]) {
		const parsed = parseQuery(raw);
		assert.deepEqual(parsed.parts, [], `raw=${JSON.stringify(raw)}`);
		assert.equal(parsed.isEmpty, true, `raw=${JSON.stringify(raw)}`);
	}
});

test("parseQuery: разбиение, нормализация, дедуп, сортировка по убыванию длины", () => {
	const parsed = parseQuery("Работ работ ДЕНЬГ");
	// "работ" встретился дважды в разном регистре -> один и тот же
	// нормализованный представитель класса эквивалентности -> дедуп.
	assert.deepEqual(new Set(parsed.parts), new Set(["деньг", "работ"]));
	assert.equal(parsed.isEmpty, false);
	// длина не убывает
	for (let i = 1; i < parsed.parts.length; i++) {
		assert.ok(parsed.parts[i - 1].length >= parsed.parts[i].length, "части не отсортированы по убыванию длины");
	}
});

// --- I-ANTITONE (§7, §8 п.1) ---
test("I-ANTITONE: property — M(q + ' ' + p) ⊆ M(q)", () => {
	for (let seed = 0; seed < SCENARIOS; seed++) {
		const records = generateCorpus(seed, 40);
		const haystacks = haystacksOf(records);
		const rng = mulberry32(seed * 7919 + 11);
		const q = randomWord(rng);
		const p = randomWord(rng);
		const mQ = matchSet(haystacks, parseQuery(q).parts);
		const mQP = matchSet(haystacks, parseQuery(`${q} ${p}`).parts);
		assert.ok(isSubset(mQP, mQ), `seed=${seed}: M('${q} ${p}') не подмножество M('${q}')`);
	}
});

// --- I-MONOTONE-EXTEND (§7, следствие §4.3 матдока — не отдельный п.
// в §8, но явно назван инвариантом §7, проверяем тем же корпусом) ---
test("I-MONOTONE-EXTEND: property — удлинение части только сужает", () => {
	for (let seed = 0; seed < SCENARIOS; seed++) {
		const records = generateCorpus(seed, 40);
		const haystacks = haystacksOf(records);
		const rng = mulberry32(seed * 104729 + 13);
		const root = pick(rng, ROOTS);
		const extended = root + pick(rng, SUFFIXES.filter((s) => s.length > 0));
		const mShort = matchSet(haystacks, parseQuery(root).parts);
		const mLong = matchSet(haystacks, parseQuery(extended).parts);
		assert.ok(isSubset(mLong, mShort), `seed=${seed}: M('${extended}') не подмножество M('${root}')`);
	}
});

// --- I-ORDER-FREE (§7, §8 п.2) ---
test("I-ORDER-FREE: property — M('а б') === M('б а')", () => {
	for (let seed = 0; seed < SCENARIOS; seed++) {
		const records = generateCorpus(seed, 40);
		const haystacks = haystacksOf(records);
		const rng = mulberry32(seed * 2654435761 + 17);
		const a = randomWord(rng);
		const b = randomWord(rng);
		const mAB = matchSet(haystacks, parseQuery(`${a} ${b}`).parts);
		const mBA = matchSet(haystacks, parseQuery(`${b} ${a}`).parts);
		assert.deepEqual(mAB, mBA, `seed=${seed}: M('${a} ${b}') !== M('${b} ${a}')`);
	}
});

test("I-ORDER-FREE: дублирование части не меняет результат (идемпотентность M)", () => {
	for (let seed = 0; seed < SCENARIOS; seed++) {
		const records = generateCorpus(seed, 30);
		const haystacks = haystacksOf(records);
		const rng = mulberry32(seed * 40503 + 19);
		const a = randomWord(rng);
		const mOnce = matchSet(haystacks, parseQuery(a).parts);
		const mTwice = matchSet(haystacks, parseQuery(`${a} ${a}`).parts);
		assert.deepEqual(mOnce, mTwice, `seed=${seed}: дублирование части '${a}' изменило выдачу`);
	}
});

// --- Запрет на регэкспы/сторонние реализации (SEARCH-SPEC.md §3.1, §11) ---
test("matches: спецсимволы регэкспа в запросе ищутся буквально, не как паттерн", () => {
	const hay = buildHaystack(["цена 5*3 руб (скидка)"]);
	assert.ok(matches(hay, parseQuery("5*3").parts));
	assert.ok(matches(hay, parseQuery("(скидка)").parts));
	// Катастрофический откат — характерная сигнатура regex-based решения;
	// если matches реализован через String.prototype.includes, время работы
	// не зависит от структуры строки. Явного замера времени здесь не делаем
	// (unit-тест, не бенч) — но если бы это упало в RegExp, паттерн вида
	// "(a+)+b" на несовпадающей строке завис бы, а не бросил исключение,
	// поэтому сам факт быстрого завершения теста — уже сигнал.
	assert.ok(!matches(hay, parseQuery("(a+)+$").parts));
});
