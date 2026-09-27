// Э1.2/Э2.1/§4.3 ТЗ-NATIVE-APPS — Tauri-адаптер. Реальный нативный проект
// (native/desktop) появляется в Э3/Э8 — до этого большинство методов
// сознательно бросают при первом обращении, а не притворяются рабочими
// (тихий no-op на фактически отсутствующей платформе прячет дыру до первого
// живого теста на устройстве, явный throw — нет). @tauri-apps/* импортируются
// ТОЛЬКО из этого файла (§4.2) — их здесь пока нет вовсе (media.getPlayableSource
// ниже вообще не требует native SDK, см. media-native-fallback.js).
import { notImplemented } from "./native-stub.js";
import { exceedsMediaSizeLimit, getPlayableSourceUnderLimit } from "./media-native-fallback.js";

// Лимит медиа одинаков для Windows/macOS/Linux (media-native-fallback.js) —
// точное определение ОС desktop-Tauri не нужно ради этого расчёта, поэтому
// не форсируется здесь; os ниже — плейсхолдер до реального native/desktop
// проекта (Э3/Э8), где он появится через @tauri-apps/plugin-os.
const SHELL = "tauri";
const OS = "windows";

async function getPlayableSource(fileRef, opts = {}) {
	const size = opts.size ?? fileRef?.size;
	if (exceedsMediaSizeLimit(SHELL, OS, size)) {
		// Р2.2 — владелец выбрал (А): расшифровать во временный файл, играть с
		// диска (2026-09-27, см. PROGRESS.md). Нужен @tauri-apps/plugin-fs —
		// без настоящего native/desktop проекта (Э3/Э8) не на чем проверить
		// запись на диск, поэтому не реализовано вслепую.
		throw new Error("platform.media.getPlayableSource (tauri): файл больше лимита платформы — расшифровка на диск ещё не реализована (Э3/Э8)");
	}
	return getPlayableSourceUnderLimit(fileRef, opts);
}

export function createPlatform() {
	return {
		shell: SHELL,
		os: OS,
		info: notImplemented(SHELL, "info"),

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
			openExternal: notImplemented(SHELL, "links.openExternal"),
			onDeepLink: notImplemented(SHELL, "links.onDeepLink"),
		},

		lifecycle: {
			onResume: notImplemented(SHELL, "lifecycle.onResume"),
			onPause: notImplemented(SHELL, "lifecycle.onPause"),
			onNetworkChange: notImplemented(SHELL, "lifecycle.onNetworkChange"),
		},

		updates: {
			mode: "desktop-updater",
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
