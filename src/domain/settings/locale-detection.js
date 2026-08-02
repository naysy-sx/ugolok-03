// Вынесено из ui/signals/i18n.js (этап 64) — domain/ никогда не импортирует
// из ui/ (см. CONTRACTS.md), а loadUiSettings (ui-settings.js) нужен
// detectSystemLocale() для фолбэка первого запуска. Чистая функция без
// зависимости от @preact/signals — реактивность (currentLocale signal)
// живёт только в ui/signals/i18n.js, который эти константы реэкспортирует.

// Порядок — по распространённости языка (задан пользователем) — определяет
// порядок опций в переключателе языка (settings.jsx).
export const SUPPORTED_LOCALES = [
	{ code: "en", nativeName: "English" },
	{ code: "es", nativeName: "Español" },
	{ code: "de", nativeName: "Deutsch" },
	{ code: "ja", nativeName: "日本語" },
	{ code: "fr", nativeName: "Français" },
	{ code: "pt", nativeName: "Português" },
	{ code: "ru", nativeName: "Русский" },
	{ code: "it", nativeName: "Italiano" },
	{ code: "nl", nativeName: "Nederlands" },
	{ code: "pl", nativeName: "Polski" },
	{ code: "tr", nativeName: "Türkçe" },
	{ code: "zh", nativeName: "中文" },
];

// Самый распространённый язык — честный фолбэк для системного языка,
// которого нет среди 12 поддерживаемых (а не "ru": мультиязычность именно
// затем и нужна, чтобы не показывать русский всем подряд по умолчанию).
export const DEFAULT_LOCALE = "en";

export function detectSystemLocale(
	languages = (typeof navigator !== "undefined" && (navigator.languages || (navigator.language ? [navigator.language] : []))) || [],
) {
	const supportedCodes = new Set(SUPPORTED_LOCALES.map((l) => l.code));
	for (const tag of languages) {
		const primary = String(tag).split("-")[0].toLowerCase();
		if (supportedCodes.has(primary)) return primary;
	}
	return DEFAULT_LOCALE;
}
