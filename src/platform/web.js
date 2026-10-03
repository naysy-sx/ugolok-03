// Э1.2/§4.3 ТЗ-NATIVE-APPS — веб-реализация контракта платформенного адаптера.
// Повторяет текущее (до Э1) поведение приложения один в один — ничего здесь
// не должно менять то, что видит пользователь веб-версии.
import { APP_VERSION, BUILD_HASH } from "../config.js";
import { loadRuntimeConfig } from "../domain/settings/runtime-config.js";

// Грубое определение ОС для diagnostics/info() — то же семейство проверок,
// что уже есть в main.jsx (isMobile) и в probe (T19), просто шире.
function detectOs() {
	const ua = globalThis.navigator?.userAgent ?? "";
	if (/Android/i.test(ua)) return "android";
	if (/iPhone|iPad|iPod/i.test(ua)) return "ios";
	if (/Windows/i.test(ua)) return "windows";
	if (/Macintosh|Mac OS X/i.test(ua)) return "macos";
	if (/Linux/i.test(ua)) return "linux";
	return "web";
}

// Р2.2/Э1.3 — files.saveAs: тот же inline-паттерн (Blob -> ObjectURL -> временный
// <a download> -> click -> revoke), который раньше был продублирован по отдельности
// в diagnostics.jsx, attachment-view.jsx, delivery-trace.js, call-trace.js.
// `data` — Blob | Uint8Array | ArrayBuffer | string (шире контрактных Blob|Uint8Array
// буквально, т.к. Blob(...) конструктор одинаково принимает все четыре формы, а
// часть вызывающих мест отдаёт готовую JSON-строку — заворачивать её в Blob на
// каждом вызове ради формальной точности контракта было бы чистым дублированием).
async function saveAs({ name, mime, data }) {
	const blob = data instanceof Blob ? data : new Blob([data], { type: mime });
	const url = URL.createObjectURL(blob);
	try {
		const a = document.createElement("a");
		a.href = url;
		a.download = name;
		document.body.appendChild(a);
		a.click();
		a.remove();
	} finally {
		setTimeout(() => URL.revokeObjectURL(url), 1000);
	}
}

// Э1.4 — на вебе внешние ссылки открываются штатно (сам браузер), этот метод
// существует для симметрии контракта и для мест, которые захотят открыть
// внешний URL явным вызовом (а не через клик по <a>).
function openExternal(url) {
	globalThis.open?.(url, "_blank", "noopener,noreferrer");
}

// Э1.3 — lifecycle: реальная веб-реализация (visibilitychange/online/offline),
// но пока БЕЗ переноса в неё существующих потребителей (ui/signals/files.js,
// connection-endpoints.jsx, chat.jsx) — они используют document.visibilitychange
// напрямую для своей, уже проверенной логики. Перенос отложен явно (см.
// PROGRESS.md, Э1.3): у этого адаптера пока 0 реальных потребителей, миграция
// живого кода ради самого факта миграции добавляла бы риск регрессии там, где
// владелец прямо просил приоритет — надёжность, без выигрыша прямо сейчас.
function onResume(cb) {
	const handler = () => {
		if (document.visibilityState === "visible") cb();
	};
	document.addEventListener("visibilitychange", handler);
	return () => document.removeEventListener("visibilitychange", handler);
}

function onPause(cb) {
	const handler = () => {
		if (document.visibilityState === "hidden") cb();
	};
	document.addEventListener("visibilitychange", handler);
	return () => document.removeEventListener("visibilitychange", handler);
}

function onNetworkChange(cb) {
	const onOnline = () => cb(true);
	const onOffline = () => cb(false);
	globalThis.addEventListener?.("online", onOnline);
	globalThis.addEventListener?.("offline", onOffline);
	return () => {
		globalThis.removeEventListener?.("online", onOnline);
		globalThis.removeEventListener?.("offline", onOffline);
	};
}

// Э1.3 — notifications: рабочая реализация контракта §4.3, независимая от
// domain/notifications/backend.js (Этап 47). backend.js — уже собственный,
// протестированный DI-адаптер (NotificationImpl/documentImpl/AudioImpl
// конструктора, тот же принцип, что MediaRecorderImpl/WebSocketImpl по всей
// кодовой базе) — переписывать его на getPlatform() сейчас означало бы менять
// архитектуру уже рабочего, покрытого тестами пути доставки уведомлений БЕЗ
// реального нативного потребителя, который вынудил бы это сделать правильно
// (Capacitor/Tauri в Э1 — заглушки, throw). Настоящая точка, где notify()'s
// onClick неизбежно станет route-объектом (не переживает перезапуск процесса
// после настоящего push) — Э3/Э4 (первая живая нотификация на устройстве)
// либо Э9 (push). Здесь — параллельная, самостоятельно рабочая реализация
// того же контракта, готовая быть тем местом, куда backend.js переедет ТОГДА.
let clickHandlers = [];

function permission() {
	const NotificationImpl = globalThis.Notification;
	return NotificationImpl ? NotificationImpl.permission : "unsupported";
}

async function requestPermission() {
	const NotificationImpl = globalThis.Notification;
	if (!NotificationImpl) return "unsupported";
	if (NotificationImpl.permission === "granted" || NotificationImpl.permission === "denied") {
		return NotificationImpl.permission;
	}
	return NotificationImpl.requestPermission();
}

async function show({ title, body, tag, route }) {
	const NotificationImpl = globalThis.Notification;
	if (!NotificationImpl || NotificationImpl.permission !== "granted") return;
	const notification = new NotificationImpl(title, { body, tag });
	notification.onclick = () => {
		globalThis.focus?.();
		notification.close?.();
		for (const cb of clickHandlers) cb(route);
	};
}

function onClick(cb) {
	clickHandlers.push(cb);
	return () => {
		clickHandlers = clickHandlers.filter((h) => h !== cb);
	};
}

function setBadge(n) {
	const nav = globalThis.navigator;
	if (n > 0) nav?.setAppBadge?.(n)?.catch?.(() => {});
	else nav?.clearAppBadge?.()?.catch?.(() => {});
}

// Э2.4 ТЗ-NATIVE-APPS — «веб-режим продолжает использовать SW-плеер без
// изменений»: player-bridge.js/media-url.js читают медиа напрямую через
// Service Worker и НЕ вызывают этот метод на вебе вовсе (media-url.js's
// acquireMediaUrl уходит сюда только когда getPlatform().shell !== "web").
// Метод существует в контракте только для симметрии — на вебе не реализован
// НАВСЕГДА, не "пока", в отличие от capacitor.js/tauri.js, где Э2.1 его уже
// реализовал.
async function getPlayableSource() {
	throw new Error("platform.media.getPlayableSource — не реализовано на вебе (Э2.4: SW-плеер используется напрямую)");
}

// Э6 — удержание звонка в фоне. На вебе сегодня отдельного "удержания" нет
// (звонок продолжается, пока жива вкладка, WebSocket/RTCPeerConnection не
// требуют явного begin/end) — no-op сохраняет "текущее поведение 1:1".
function begin() {}
function end() {}

// Э6.3 — на вебе сегодня keepAwake не используется нигде (E1-INVENTORY.md:
// navigator.wakeLock не используется нигде в src/) — no-op, а не обёртка над
// wakeLock, чтобы не завести НОВОЕ поведение раньше времени.
function keepAwake() {}

// ui.setBackHandler/setSystemBarsTheme/setSecureScreen — все три специфичны
// для нативных оболочек (аппаратная "Назад", системные бары, FLAG_SECURE).
// На вебе аналога нет ни у одного — no-op, тем же принципом, что выше.
function setBackHandler() {
	return () => {};
}
function setSystemBarsTheme() {}
function setSecureScreen() {}

// push — Э-PUSH (TZ-PUSH-ANDROID.md, П3.1): «Веб и Tauri: available() → false,
// остальное ничего не делает». Функция целиком Android-only (foreground-
// service с постоянным соединением — веб-платформа этого не может в принципе,
// Tauri пока не в фокусе, ТЗ явно ограничивает Э-PUSH Android). status()
// возвращает форму контракта со всем false/null, а не бросает — вызывающий
// код (экран «Уведомления в фоне», П3.4) не должен ветвиться по платформе
// сам, availability уже сказала всё, что нужно знать.
function pushAvailable() {
	return false;
}
async function pushNoop() {}
async function pushStatus() {
	return { running: false, batteryExempt: false, fullScreenAllowed: false, notificationsAllowed: false, lastConnectedAt: null };
}

export function createPlatform() {
	return {
		shell: "web",
		os: detectOs(),
		info() {
			return {
				shell: "web",
				os: detectOs(),
				appVersion: APP_VERSION,
				buildHash: BUILD_HASH,
				engineVersion: globalThis.navigator?.userAgent ?? "",
			};
		},

		config: {
			load: loadRuntimeConfig,
		},

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
			onDeepLink() {
				return () => {};
			},
		},

		lifecycle: {
			onResume,
			onPause,
			onNetworkChange,
		},

		updates: {
			mode: "sw",
			// main.jsx управляет реальным циклом обновления (регистрация,
			// controllerchange, безопасный момент для reload — TZ §2.6,
			// ui/reload-gate.js) уже сейчас САМОСТОЯТЕЛЬНО, без вызова этих
			// методов: перестроить этот, уже живой и тонко настроенный по
			// живым проблемам пользователей путь на check()/apply() ради
			// формы контракта — риск регрессии без выигрыша в Э1 (см.
			// PROGRESS.md). check()/apply() — не-op заглушки на будущее.
			async check() {},
			async apply() {},
		},

		ui: {
			setBackHandler,
			setSystemBarsTheme,
			setSecureScreen,
			keepAwake,
		},

		call: {
			begin,
			end,
		},

		push: {
			available: pushAvailable,
			enable: pushNoop,
			disable: pushNoop,
			status: pushStatus,
			syncFilters: pushNoop,
			openBatterySettings: pushNoop,
			openAutostartSettings: pushNoop,
		},
	};
}
