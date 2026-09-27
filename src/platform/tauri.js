// Э1.2/Э2.1/Э3/§4.3 ТЗ-NATIVE-APPS — Tauri-адаптер. native/desktop (Э3) —
// реальный проект, часть методов уже реализована на нём (config/notifications/
// files/links/media), остальное (lifecycle/updates/ui/call/push) сознательно
// бросает при первом обращении, а не притворяется рабочим (тихий no-op на
// непроверенной живьём возможности прячет дыру до первого реального теста —
// эти методы не проверены на реальном окне/устройстве в этой сессии, см.
// PROGRESS.md). @tauri-apps/* импортируются ТОЛЬКО из этого файла (§4.2).
import { notImplemented } from "./native-stub.js";
import { exceedsMediaSizeLimit, getPlayableSourceUnderLimit } from "./media-native-fallback.js";
import { loadRuntimeConfig } from "../domain/settings/runtime-config.js";
import { APP_VERSION, BUILD_HASH } from "../config.js";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { save as saveDialog } from "@tauri-apps/plugin-dialog";
import { writeFile } from "@tauri-apps/plugin-fs";
import { openUrl } from "@tauri-apps/plugin-opener";
import {
	sendNotification,
	requestPermission as tauriRequestPermission,
	isPermissionGranted,
	onAction,
} from "@tauri-apps/plugin-notification";

// Лимит медиа одинаков для Windows/macOS/Linux (media-native-fallback.js) —
// точное определение ОС desktop-Tauri не нужно ради этого расчёта, поэтому
// не форсируется здесь; os ниже — плейсхолдер до @tauri-apps/plugin-os
// (не установлен: единственный текущий потребитель os — сам этот расчёт,
// а он одинаков для всех трёх desktop-ОС).
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

// Р6 — config.json лежит в dist-tauri рядом с index.html (vite.config.js's
// copyNativeConfigJson) и раздаётся тем же протоколом, что и сама страница
// (tauri://localhost / https://tauri.localhost) — обычный относительный
// fetch('./config.json') работает без единого нативного вызова, тот же код,
// что и на вебе.
const config = { load: loadRuntimeConfig };

// Э3.7 — уведомления через tauri-plugin-notification. route кладём в `extra`
// (единственное поле контракта плагина под произвольные данные) и читаем его
// обратно в onAction — так же переживает то, что notification-объект долетает
// до колбэка уже сериализованным, а не тем же JS-объектом, что при show().
let actionListener = null;
const clickHandlers = [];

async function ensureActionListener() {
	if (actionListener) return;
	actionListener = await onAction((notification) => {
		const route = notification?.extra?.route;
		for (const cb of clickHandlers) cb(route);
	});
}

async function permission() {
	return (await isPermissionGranted()) ? "granted" : "default";
}

async function requestPermission() {
	const result = await tauriRequestPermission();
	return result === "granted" ? "granted" : result === "denied" ? "denied" : "default";
}

async function show({ id, title, body, tag, route }) {
	await ensureActionListener();
	sendNotification({
		id: typeof id === "number" ? id : undefined,
		title,
		body,
		group: tag,
		extra: route ? { route } : undefined,
	});
}

function onClick(cb) {
	ensureActionListener();
	clickHandlers.push(cb);
	return () => {
		const i = clickHandlers.indexOf(cb);
		if (i >= 0) clickHandlers.splice(i, 1);
	};
}

// core:window:allow-set-badge-count (capabilities/default.json) — счётчик на
// иконке Dock (macOS)/задачах (Windows); Linux — по возможностям DE [ДОК],
// не проверено живьём ни на одной ОС в этой сессии.
async function setBadge(n) {
	await getCurrentWindow().setBadgeCount(n > 0 ? n : undefined);
}

// Э3.9 — «Сохранение файлов через диалог «Сохранить как» и запись по
// выбранному пути» — НЕ через <a download> (T13, E0-REPORT.md: blob: с
// download молча ничего не делает в WebView Capacitor; на Tauri отдельно не
// проверялось, но обходить нативный диалог, который ТЗ и так требует, смысла
// нет). Пользователь отменил диалог -> path === null -> тихо ничего, тот же
// принцип, что «Отмена» в любом системном диалоге.
async function saveAs({ name, mime, data }) {
	const path = await saveDialog({ defaultPath: name });
	if (!path) return;
	const bytes = data instanceof Blob ? new Uint8Array(await data.arrayBuffer()) : data instanceof Uint8Array ? data : new Uint8Array(await new Blob([data], { type: mime }).arrayBuffer());
	await writeFile(path, bytes);
}

// Э1.4/Э3.3 — открытие URL в системном браузере (opener plugin; «никакого
// shell» — Э3.3 явно исключает произвольный доступ к процессам ОС, opener —
// узкий, специально для этого случая).
async function openExternal(url) {
	await openUrl(url);
}

// НАЙДЕНО ЖИВЬЁМ (владелец, Mac mini, 2026-09-27) — экран «Диагностика»
// (Э1.5) вызывает platform.info() БЕЗУСЛОВНО в теле рендера, без try/catch;
// пока он был notImplemented, throw ронял отрисовку всего экрана целиком —
// пустой белый экран, без видимой причины (ошибка только в консоли). Метод
// дешёвый и не требует native SDK — реализован по-настоящему, той же формы,
// что web.js.
function info() {
	return {
		shell: SHELL,
		os: OS,
		appVersion: APP_VERSION,
		buildHash: BUILD_HASH,
		engineVersion: globalThis.navigator?.userAgent ?? "",
	};
}

export function createPlatform() {
	return {
		shell: SHELL,
		os: OS,
		info,

		config,

		notifications: {
			permission,
			requestPermission,
			show,
			onClick,
			setBadge,
		},

		media: {
			getPlayableSource,
		},

		files: {
			saveAs,
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
