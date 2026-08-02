import { signal } from "@preact/signals";
import ru from "../i18n/locales/ru.json" with { type: "json" };
import en from "../i18n/locales/en.json" with { type: "json" };
import es from "../i18n/locales/es.json" with { type: "json" };
import de from "../i18n/locales/de.json" with { type: "json" };
import ja from "../i18n/locales/ja.json" with { type: "json" };
import fr from "../i18n/locales/fr.json" with { type: "json" };
import pt from "../i18n/locales/pt.json" with { type: "json" };
import it from "../i18n/locales/it.json" with { type: "json" };
import nl from "../i18n/locales/nl.json" with { type: "json" };
import pl from "../i18n/locales/pl.json" with { type: "json" };
import tr from "../i18n/locales/tr.json" with { type: "json" };
import zh from "../i18n/locales/zh.json" with { type: "json" };
import { SUPPORTED_LOCALES, DEFAULT_LOCALE, detectSystemLocale } from "../../domain/settings/locale-detection.js";

export { SUPPORTED_LOCALES, DEFAULT_LOCALE, detectSystemLocale };

const DICTIONARIES = { ru, en, es, de, ja, fr, pt, it, nl, pl, tr, zh };

export const currentLocale = signal(detectSystemLocale());

export function setLocale(code) {
	currentLocale.value = DICTIONARIES[code] ? code : DEFAULT_LOCALE;
}

function lookup(dict, key) {
	return key.split(".").reduce((node, segment) => (node && typeof node === "object" ? node[segment] : undefined), dict);
}

function interpolate(str, vars) {
	if (!vars) return str;
	return str.replace(/\{\{(\w+)\}\}/g, (match, name) => (name in vars ? String(vars[name]) : match));
}

export function t(key, vars) {
	const value = lookup(DICTIONARIES[currentLocale.value], key) ?? lookup(DICTIONARIES[DEFAULT_LOCALE], key);
	if (value === undefined) {
		console.warn(`i18n: отсутствует перевод для ключа "${key}"`);
		return key;
	}
	return interpolate(value, vars);
}
