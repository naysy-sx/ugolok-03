// Э1.2/Э2.1/§4.3 ТЗ-NATIVE-APPS — Capacitor-адаптер. Реальный нативный проект
// (native/mobile) появляется в Э3 — до этого большинство методов сознательно
// бросают при первом обращении, а не притворяются рабочими (тихий no-op на
// фактически отсутствующей платформе прячет дыру до первого живого теста на
// устройстве, явный throw — нет). @capacitor/* импортируются ТОЛЬКО из этого
// файла (§4.2) — их здесь пока нет вовсе (media.getPlayableSource ниже вообще
// не требует native SDK, см. media-native-fallback.js).
import { notImplemented } from "./native-stub.js";
import { exceedsMediaSizeLimit, getPlayableSourceUnderLimit } from "./media-native-fallback.js";
import { APP_VERSION, BUILD_HASH } from "../config.js";
import { Browser } from "@capacitor/browser";

// TODO(Э3): различать android/ios через реальный Capacitor.getPlatform() —
// недоступно без настоящего native/mobile проекта. iOS отложен владельцем
// (недостаточно диска для Xcode, см. PROGRESS.md), Android — текущий фокус.
const SHELL = "capacitor";
const OS = "android";

// НАЙДЕНО ЖИВЬЁМ на tauri.js (владелец, Mac mini, Э3, 2026-09-27) — экран
// «Диагностика» (Э1.5) вызывает platform.info() безусловно в теле рендера,
// без try/catch; notImplemented ронял отрисовку всего экрана целиком —
// пустой белый экран. Тот же баг был бы и здесь при первом же открытии
// экрана на Android — метод дешёвый, не требует native SDK, реализован
// сразу и тут, той же формы, что web.js/tauri.js.
function info() {
	return {
		shell: SHELL,
		os: OS,
		appVersion: APP_VERSION,
		buildHash: BUILD_HASH,
		engineVersion: globalThis.navigator?.userAgent ?? "",
	};
}

// Э1.4/Э4.4 — открытие URL в системном браузере (Chrome Custom Tabs, не
// собственный WebView приложения — иначе пользователь остался бы "заперт"
// внутри приложения без адресной строки и с чужими cookie/сессией). Первый
// потребитель — ссылка "Обновить WebView" на экране блокировки устаревшего
// движка (Э4.4), но перехватчик внешних ссылок в app.jsx (§4.3) использует
// тот же метод для любых markdown-ссылок.
async function openExternal(url) {
	await Browser.open({ url });
}

async function getPlayableSource(fileRef, opts = {}) {
	const size = opts.size ?? fileRef?.size;
	if (exceedsMediaSizeLimit(SHELL, OS, size)) {
		// Р2.2 — владелец выбрал (А): расшифровать во временный файл, играть с
		// диска (2026-09-27, см. PROGRESS.md). Нужен @capacitor/filesystem —
		// без настоящего native/mobile проекта (Э3) не на чем проверить запись
		// на диск, поэтому не реализовано вслепую (T13, E0-REPORT.md, напоминание
		// на будущее: <a download> с blob: в Android WebView молча ничего не
		// делает — Filesystem-плагин обязателен, не обходной путь через ссылку).
		throw new Error("platform.media.getPlayableSource (capacitor): файл больше лимита платформы — расшифровка на диск ещё не реализована (Э3)");
	}
	return getPlayableSourceUnderLimit(fileRef, opts);
}

export function createPlatform() {
	return {
		shell: SHELL,
		os: OS,
		info,

		config: { load: notImplemented(SHELL, "config.load") },

		notifications: {
			permission: notImplemented(SHELL, "notifications.permission"),
			requestPermission: notImplemented(SHELL, "notifications.requestPermission"),
			show: notImplemented(SHELL, "notifications.show"),
			onClick: notImplemented(SHELL, "notifications.onClick"),
			setBadge: notImplemented(SHELL, "notifications.setBadge"),
		},

		media: {
			getPlayableSource,
		},

		files: {
			saveAs: notImplemented(SHELL, "files.saveAs"),
		},

		links: {
			openExternal,
			onDeepLink: notImplemented(SHELL, "links.onDeepLink"),
		},

		lifecycle: {
			onResume: notImplemented(SHELL, "lifecycle.onResume"),
			onPause: notImplemented(SHELL, "lifecycle.onPause"),
			onNetworkChange: notImplemented(SHELL, "lifecycle.onNetworkChange"),
		},

		updates: {
			mode: "store",
			check: notImplemented(SHELL, "updates.check"),
			apply: notImplemented(SHELL, "updates.apply"),
		},

		ui: {
			setBackHandler: notImplemented(SHELL, "ui.setBackHandler"),
			setSystemBarsTheme: notImplemented(SHELL, "ui.setSystemBarsTheme"),
			setSecureScreen: notImplemented(SHELL, "ui.setSecureScreen"),
			keepAwake: notImplemented(SHELL, "ui.keepAwake"),
		},

		call: {
			begin: notImplemented(SHELL, "call.begin"),
			end: notImplemented(SHELL, "call.end"),
		},

		push: {
			supported: notImplemented(SHELL, "push.supported"),
			getToken: notImplemented(SHELL, "push.getToken"),
			onTokenChange: notImplemented(SHELL, "push.onTokenChange"),
			onWake: notImplemented(SHELL, "push.onWake"),
		},
	};
}
