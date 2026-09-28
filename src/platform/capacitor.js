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
import { App } from "@capacitor/app";
import { SystemBars, SystemBarsStyle } from "@capacitor/core";
import { LocalNotifications } from "@capacitor/local-notifications";

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

// Э4.5 — аппаратная кнопка «Назад». ОДИН нативный listener на весь жизненный
// цикл приложения (регистрируется один раз, лениво) — не по одному на каждый
// вызов setBackHandler(): app.jsx переустанавливает обработчик при каждом
// изменении sidebarOpen (замыкание должно видеть актуальный state), частое
// накопление нативных addListener-подписок дало бы то же нажатие "Назад",
// обработанное N раз одновременно. Тот же приём, что tauri.js's
// ensureActionListener/clickHandlers — одна подписка, переключаемый колбэк.
// Контракт (§4.3) — cb() -> true, если обработано; false -> сворачиваем
// приложение (App.minimizeApp(), НЕ завершаем процесс — Э4.5 буквально).
let backButtonListenerRegistered = false;
let currentBackHandler = null;

function ensureBackButtonListener() {
	if (backButtonListenerRegistered) return;
	backButtonListenerRegistered = true;
	App.addListener("backButton", () => {
		const handled = currentBackHandler ? currentBackHandler() : false;
		if (!handled) App.minimizeApp();
	});
}

function setBackHandler(cb) {
	ensureBackButtonListener();
	currentBackHandler = cb;
	return () => {
		if (currentBackHandler === cb) currentBackHandler = null;
	};
}

// Э4.6 — "цвет иконок статус-бара следует теме". SystemBars — встроенный
// core-плагин Capacitor 8 (не отдельный пакет — тот же, что уже настроен в
// capacitor.config.json's plugins.SystemBars.insetsHandling для edge-to-edge,
// найдено при разборе того бага). SystemBarsStyle.Dark — "светлые иконки НА
// тёмном фоне" (т.е. тёмная ТЕМА ПРИЛОЖЕНИЯ), Light — наоборот; сверено по
// докстрингам @capacitor/core/types/core-plugins.d.ts, не домысел.
async function setSystemBarsTheme(theme) {
	await SystemBars.setStyle({ style: theme === "dark" ? SystemBarsStyle.Dark : SystemBarsStyle.Light });
}

// Э4.8 — локальные уведомления через @capacitor/local-notifications. Только
// НЕМЕДЛЕННЫЕ (schedule опущен вовсе) — пришло сообщение, пока приложение
// свёрнуто; никаких запланированных на будущее (см. AndroidManifest.xml —
// RECEIVE_BOOT_COMPLETED/SCHEDULE_EXACT_ALARM явно убраны, они не нужны).
// PermissionState плагина ('prompt'|'prompt-with-rationale'|'granted'|
// 'denied') сводится к контракту §4.3 ('granted'|'denied'|'default'), тот
// же паттерн, что tauri.js's permission()/requestPermission().
function mapPermissionState(display) {
	if (display === "granted") return "granted";
	if (display === "denied") return "denied";
	return "default";
}

async function permission() {
	const { display } = await LocalNotifications.checkPermissions();
	return mapPermissionState(display);
}

async function requestPermission() {
	const { display } = await LocalNotifications.requestPermissions();
	return mapPermissionState(display);
}

// id обязателен у плагина (в отличие от tauri-plugin-notification, где он
// опционален) — генерируем, если вызывающий код его не передал.
let notificationIdCounter = 1;

async function show({ id, title, body, route }) {
	await LocalNotifications.schedule({
		notifications: [
			{
				id: typeof id === "number" ? id : notificationIdCounter++,
				title,
				body,
				extra: route ? { route } : undefined,
				// Найдено живьём (эмулятор) — isExactNotification по умолчанию true
				// БЕЗУСЛОВНО, даже без schedule-поля (немедленное уведомление): плагин
				// автоматически открывает системный экран "Alarms & reminders",
				// заставляя JS-промис висеть, пока пользователь не вернётся оттуда
				// вручную. Мы никогда ничего не планируем на будущее (RECEIVE_BOOT_
				// COMPLETED/SCHEDULE_EXACT_ALARM явно убраны из манифеста, Э4.8) —
				// exact alarm нам не нужен вовсе.
				isExactNotification: false,
			},
		],
	});
}

let actionListenerRegistered = false;
const clickHandlers = [];

async function ensureActionListener() {
	if (actionListenerRegistered) return;
	actionListenerRegistered = true;
	await LocalNotifications.addListener("localNotificationActionPerformed", (action) => {
		const route = action?.notification?.extra?.route;
		for (const cb of clickHandlers) cb(route);
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

// ТЗ, Э4.8 — "Бейдж — через число в уведомлении, как принято на Android":
// нет отдельного публичного API у local-notifications для счётчика на
// иконке (в отличие от tauri's setBadgeCount) — на Android бейдж формируется
// самим фактом наличия активных уведомлений, не отдельным вызовом. Тихий
// no-op, тот же принцип, что web.js для возможностей другой платформы.
async function setBadge() {}

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
			setBackHandler,
			setSystemBarsTheme,
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
