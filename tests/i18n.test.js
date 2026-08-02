import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { SUPPORTED_LOCALES, DEFAULT_LOCALE, currentLocale, detectSystemLocale, setLocale, t, tPlural } from "../src/ui/signals/i18n.js";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const LOCALES_DIR = path.join(__dirname, "..", "src", "ui", "i18n", "locales");

function collectKeyPaths(obj, prefix = "") {
	const paths = [];
	for (const [key, value] of Object.entries(obj)) {
		const fullPath = prefix ? `${prefix}.${key}` : key;
		if (value !== null && typeof value === "object" && !Array.isArray(value)) {
			paths.push(...collectKeyPaths(value, fullPath));
		} else {
			paths.push(fullPath);
		}
	}
	return paths;
}

beforeEach(() => {
	setLocale("ru");
});

test("SUPPORTED_LOCALES содержит ровно 12 языков, включая ru и en", () => {
	assert.equal(SUPPORTED_LOCALES.length, 12);
	const codes = SUPPORTED_LOCALES.map((l) => l.code);
	assert.ok(codes.includes("ru"));
	assert.ok(codes.includes("en"));
	assert.equal(new Set(codes).size, 12); // без дублей
});

test("DEFAULT_LOCALE — самый распространённый язык (en)", () => {
	assert.equal(DEFAULT_LOCALE, "en");
});

test("detectSystemLocale: точное совпадение primary subtag", () => {
	assert.equal(detectSystemLocale(["es-ES", "es", "en"]), "es");
	assert.equal(detectSystemLocale(["de-DE"]), "de");
	assert.equal(detectSystemLocale(["ja"]), "ja");
});

test("detectSystemLocale: не поддерживаемый язык -> DEFAULT_LOCALE", () => {
	assert.equal(detectSystemLocale(["ko-KR", "ko"]), DEFAULT_LOCALE);
});

test("detectSystemLocale: пустой список -> DEFAULT_LOCALE", () => {
	assert.equal(detectSystemLocale([]), DEFAULT_LOCALE);
});

test("detectSystemLocale: первый поддерживаемый язык в списке приоритетов", () => {
	assert.equal(detectSystemLocale(["ko-KR", "fr-FR", "en"]), "fr");
});

test("t(): возвращает значение по вложенному dot-path ключу для текущей локали", () => {
	setLocale("ru");
	assert.equal(t("nav.journal"), "Журнал");
	setLocale("en");
	assert.equal(t("nav.journal"), "Journal");
});

test("t(): app.name различается по правилу лого (Уголок только в ru, Ugolok везде ещё)", () => {
	setLocale("ru");
	assert.equal(t("app.name"), "Уголок");
	for (const { code } of SUPPORTED_LOCALES) {
		if (code === "ru") continue;
		setLocale(code);
		assert.equal(t("app.name"), "Ugolok", `app.name должен быть "Ugolok" для локали ${code}`);
	}
});

test("t(): интерполяция {{var}}", () => {
	setLocale("ru");
	const result = t("unlock.main.loginForm.submitButton", { appName: "Уголок" });
	assert.equal(result, "Войти в Уголок");
});

test("t(): отсутствующий ключ -> возврат самого ключа, не бросает исключение", () => {
	assert.equal(t("nonexistent.key.path"), "nonexistent.key.path");
});

test("setLocale(): обновляет currentLocale.value реактивно", () => {
	setLocale("de");
	assert.equal(currentLocale.value, "de");
	setLocale("zh");
	assert.equal(currentLocale.value, "zh");
});

test("все 12 файлов локализации имеют ИДЕНТИЧНЫЙ набор ключей (структурная полнота)", () => {
	const files = fs.readdirSync(LOCALES_DIR).filter((f) => f.endsWith(".json"));
	assert.equal(files.length, 12, "должно быть ровно 12 файлов локализации");

	const keySets = {};
	for (const file of files) {
		const content = JSON.parse(fs.readFileSync(path.join(LOCALES_DIR, file), "utf-8"));
		keySets[file] = new Set(collectKeyPaths(content));
	}

	const [firstFile, ...restFiles] = files;
	const referenceKeys = keySets[firstFile];
	for (const file of restFiles) {
		const keys = keySets[file];
		const missing = [...referenceKeys].filter((k) => !keys.has(k));
		const extra = [...keys].filter((k) => !referenceKeys.has(k));
		assert.deepEqual(missing, [], `${file} не хватает ключей (относительно ${firstFile}): ${missing.join(", ")}`);
		assert.deepEqual(extra, [], `${file} содержит лишние ключи (относительно ${firstFile}): ${extra.join(", ")}`);
	}
});

test("tPlural(): выбирает правильную CLDR-категорию для русского (one/few/many)", () => {
	setLocale("ru");
	assert.equal(tPlural("channel.repliesCount", 1), "1 ответ");
	assert.equal(tPlural("channel.repliesCount", 2), "2 ответа");
	assert.equal(tPlural("channel.repliesCount", 5), "5 ответов");
	assert.equal(tPlural("channel.repliesCount", 21), "21 ответ");
});

test("tPlural(): английский различает только one/other", () => {
	setLocale("en");
	assert.equal(tPlural("channel.repliesCount", 1), "1 reply");
	assert.equal(tPlural("channel.repliesCount", 2), "2 replies");
	assert.equal(tPlural("channel.repliesCount", 0), "0 replies");
});

test("tPlural(): китайский/японский не различают число (всегда 'other' -> одинаковый шаблон)", () => {
	setLocale("zh");
	const one = tPlural("channel.repliesCount", 1).replace("1", "{{count}}");
	const five = tPlural("channel.repliesCount", 5).replace("5", "{{count}}");
	assert.equal(one, five, "шаблон вокруг числа должен быть одинаковым для любого count в zh");
});

test("SUPPORTED_LOCALES.code соответствует ровно набору файлов локализации", () => {
	const files = fs
		.readdirSync(LOCALES_DIR)
		.filter((f) => f.endsWith(".json"))
		.map((f) => f.replace(".json", ""));
	const codes = SUPPORTED_LOCALES.map((l) => l.code);
	assert.deepEqual([...codes].sort(), [...files].sort());
});
