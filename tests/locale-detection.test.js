import { test } from "node:test";
import assert from "node:assert/strict";
import { SUPPORTED_LOCALES, DEFAULT_LOCALE, detectSystemLocale } from "../src/domain/settings/locale-detection.js";

test("SUPPORTED_LOCALES: ровно 12 языков без дублей", () => {
	assert.equal(SUPPORTED_LOCALES.length, 12);
	assert.equal(new Set(SUPPORTED_LOCALES.map((l) => l.code)).size, 12);
});

test("detectSystemLocale: точное совпадение primary subtag (BCP-47)", () => {
	assert.equal(detectSystemLocale(["pt-BR"]), "pt");
	assert.equal(detectSystemLocale(["zh-Hans-CN"]), "zh");
});

test("detectSystemLocale: неподдерживаемый язык -> DEFAULT_LOCALE", () => {
	assert.equal(detectSystemLocale(["ko-KR"]), DEFAULT_LOCALE);
});

test("detectSystemLocale: пустой список -> DEFAULT_LOCALE", () => {
	assert.equal(detectSystemLocale([]), DEFAULT_LOCALE);
});

test("detectSystemLocale: без аргумента не бросает исключение в non-browser окружении (node --test)", () => {
	assert.doesNotThrow(() => detectSystemLocale());
});
