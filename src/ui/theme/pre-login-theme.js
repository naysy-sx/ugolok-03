// До входа в аккаунт тема аккаунта (DEFAULT_SETTINGS.themeMode) ещё не
// загружена и не расшифрована — показывать на экране входа/регистрации
// нечего, кроме локального, несинхронизируемого предпочтения этого
// браузера/устройства. По умолчанию — светлая (пользователь: тёмная "для
// гиков", светлая комфортнее большинству невовлечённых в тему людей),
// а не раньше бывшее "как в системе" — старт на телефоне с системной
// тёмной темой выглядел мрачным ещё до какого-либо выбора.
const KEY = "ugolok.preLoginTheme";

export function getPreLoginTheme() {
	try {
		const stored = localStorage.getItem(KEY);
		if (stored === "light" || stored === "dark") return stored;
	} catch {
		// localStorage недоступен (приватный режим и т.п.) — используем дефолт
	}
	return "light";
}

export function setPreLoginTheme(mode) {
	try {
		localStorage.setItem(KEY, mode);
	} catch {
		// не критично — просто не переживёт перезагрузку вкладки
	}
}
