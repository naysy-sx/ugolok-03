import "./styles/fonts.css";
import "./styles/minimal.css";
import "./styles/prosemirror.css";
import "./styles/custom.css";
import { render } from "preact";
import App from "./app.jsx";
import WebViewOutdated from "./ui/screens/webview-outdated.jsx";
import { getPlatform } from "./platform/index.js";
import { isChromiumTooOld } from "./platform/webview-gate.js";
import { startKeyboardInsetTracking } from "./platform/keyboard-inset.js";
import { startIdleWatcher, currentUser, onLock } from "./ui/signals/auth.js";
import { createReloadScheduler } from "./ui/reload-gate.js";
import { BUILD_HASH } from "./config.js";
import { logInfo } from "./core/diag/boot-log.js";
import { applyThemeMode } from "./ui/theme/theme-mode.js";
import { getPreLoginTheme } from "./ui/theme/pre-login-theme.js";
// TZ-diag-trace.md — main.jsx не домен, импорт трассировщика напрямую
// разрешён и здесь единственно уместен (§0.3 запрещает это только домену).
import { record as traceRecord, isTraceEnabled } from "./core/diag/call-trace.js";

logInfo(`запуск, сборка ${BUILD_HASH}`);

// Применить ДО первого рендера — иначе на системной тёмной теме экран
// входа на миг мигнёт тёмным, прежде чем пользователь успеет выбрать (а на
// экране входа выбирать ещё нечего, аккаунт/его тема не расшифрованы).
// Логин переопределит на тему аккаунта (unlock.jsx: applyThemeMode(loaded.
// themeMode)) — это только дефолт ДО него.
applyThemeMode(getPreLoginTheme());

// TZ §2.6 — окружение/lifecycle. record() сам решает, писать ли (флаг может
// быть выставлен ?diag=1 чуть выше по цепочке импорта call-trace.js), поэтому
// вызывается безусловно — нет отдельной проверки isTraceEnabled() здесь.
traceRecord("env", {
	buildHash: BUILD_HASH,
	userAgent: navigator.userAgent,
	isMobile: /Android|iPhone|iPad|iPod/i.test(navigator.userAgent),
	timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
	utcOffsetMin: -new Date().getTimezoneOffset(),
});

// TZ §0.4/§2.6 — подписки создаются, только если флаг уже включён на момент
// загрузки вкладки (?diag=1 в адресе, обработанный в call-trace.js ДО этой
// строки — импорт того модуля выше уже выполнился; либо sessionStorage,
// переживший форс-релоад SW). Если флаг выключен — этих addEventListener
// не существует вообще, не "существуют, но ничего не пишут".
if (isTraceEnabled()) {
	document.addEventListener("visibilitychange", () => traceRecord("visibilitychange", { state: document.visibilityState }));
	window.addEventListener("online", () => traceRecord("online", {}));
	window.addEventListener("offline", () => traceRecord("offline", {}));
	if ("serviceWorker" in navigator) {
		navigator.serviceWorker.addEventListener("message", (e) => {
			if (typeof e.data?.type === "string" && e.data.type.startsWith("sw-trace:")) {
				traceRecord(e.data.type, {});
			}
		});
	}
}

startIdleWatcher();

// На Android/Capacitor --keyboard-inset считает и инжектит MainActivity
// из нативного WindowInsetsCompat.Type.ime() (см. MainActivity.java) —
// запускать здесь тот же трекер поверх него означало бы два источника
// одной CSS-переменной, гоняющиеся друг за другом. На вебе нативного
// источника нет, трекер остаётся единственным. Глобально и безусловно с
// самого старта (не только внутри залогиненного MainShell) — клавиатура
// нужна и на экране входа/регистрации (пароль, мнемоника). Никогда не
// отписывается — живёт всю жизнь вкладки, тот же принцип, что
// startIdleWatcher() выше.
if (__TARGET__ === "web") startKeyboardInsetTracking();

const SW_RELOAD_ONCE_KEY = "ugolok.swReloadOnce";
let refreshing = false;
// Живая проверка (прод, 2026-09-06) — только что загруженный видео-файл
// открывался, но не играл: /files-content/<хэш> (плеер, И4) уходил мимо SW
// прямо в сеть и получал SPA-фолбэк index.html вместо расшифрованных байт
// (Caddy try_files отдаёт его на любой неизвестный путь) — <video> получает
// HTML вместо видео. Причина — navigator.serviceWorker.controller оставался
// null сколько угодно долго ПОСЛЕ activate+clients.claim() (проверено —
// не гонка на миллисекунды, а стабильно null у уже загруженной страницы,
// пока её не перезагрузили вручную). Условие "hadControllerAtLoad" ниже
// как раз и исключало reload ИМЕННО в этом случае (самая первая регистрация,
// controller ещё не было) — считая, что "обновлять нечего", хотя обновить
// нужно было саму способность SW перехватывать запросы этой вкладки.
// НАЙДЕНО ПОЛЬЗОВАТЕЛЕМ (живое использование, мобильный) — reload() ниже мог
// прилететь прямо посреди набора пароля на экране разблокировки: несколько
// раз подряд экран "сам по себе" обновлялся, стирая уже набранный текст.
// Причина в мобильном браузере, не в этом коде (ОС выгружает фоновую вкладку
// под памятью и пересоздаёт её как "свежую" — controller у SW у такой
// вкладки на момент отрисовки ещё не привязан, ready-проверка ниже это
// видит и просит перезагрузиться), но МОМЕНТ reload() — уже наша забота:
// нет причины дёргать его именно во время активного ввода в поле. Если
// сейчас есть сфокусированное текстовое поле — реальный reload() откладывается
// до потери им фокуса (пользователь ушёл из поля/переключился), а не рвёт
// набор текста на середине.
function doReload() {
	refreshing = true;
	location.reload();
}

// Автоперезагрузка — только в безопасный момент (ui/reload-gate.js): не посреди регистрации,
// не при введённом тексте и не при живой сессии (тогда — после блокировки). Раньше отложенная
// перезагрузка срабатывала сразу после входа и выкидывала человека на стартовый экран.
const reloadScheduler = createReloadScheduler({
	doc: document,
	isLoggedIn: () => !!currentUser.peek(),
	onceOnLock: (fn) => {
		const off = onLock(() => {
			off();
			fn();
		});
	},
	reload: doReload,
});

function reloadForFreshServiceWorker() {
	if (refreshing) return;
	// TZ §2.6 — записать ДО перезагрузки (иначе факт теряется вместе с
	// незаписанным в localStorage хвостом буфера, TZ §3). Не меняет ничего в
	// решении "перезагружать или нет" ниже — только фиксирует то, что уже
	// произойдёт (09-FINAL-AUDIT.md, находка про location.reload() посреди
	// звонка, "не чинить" — TZ-diag-trace.md §0.1).
	traceRecord("sw-reload", { reason: "controllerchange" });
	let alreadyTried = false;
	try {
		alreadyTried = sessionStorage.getItem(SW_RELOAD_ONCE_KEY) === "1";
	} catch {
		// приватный режим/квота — считаем, что не пробовали, максимум лишний reload
	}
	if (alreadyTried) return; // не зацикливаться, если controller так и не появится
	try {
		sessionStorage.setItem(SW_RELOAD_ONCE_KEY, "1");
	} catch {
		// не критично — хуже случай: один лишний reload
	}
	reloadWhenIdle();
}

// Перезагрузка в безопасный момент — общая для обновления SW и для закрытия базы другой
// вкладкой (AUDIT-EGOROD E3).
function reloadWhenIdle() {
	if (refreshing) return;
	reloadScheduler.request();
}

// AUDIT-EGOROD E3: другая вкладка открыла базу более новой версии (обновление
// приложения) — database.js уже закрыл наше соединение, и без перезагрузки эта
// вкладка осталась бы «живой», но с молча падающими операциями (DatabaseClosedError).
// Перезагружаемся — новая вкладка уже принесла новый код через service worker.
window.addEventListener("ugolok:db-versionchange", () => {
	traceRecord("db-versionchange-reload", {});
	reloadWhenIdle();
});

// Э1/§4.2 — «в нативных режимах не эмитится service-worker.js и не выполняется
// его регистрация»: __TARGET__ !== "web" исключает саму попытку регистрации
// (файла нет в dist-capacitor/dist-tauri, см. vite.config.js), не полагаясь на
// то, что .catch(() => {}) ниже просто молча проглотит 404 — так честнее и не
// тратит сетевой запрос внутри нативной оболочки впустую.
if (__TARGET__ === "web" && "serviceWorker" in navigator) {
	navigator.serviceWorker.addEventListener("controllerchange", reloadForFreshServiceWorker);

	// НАЙДЕНО ЖИВОЙ ПРОВЕРКОЙ (этап 53-довесок, тот же класс пробела, что
	// ensureConnected до этого): регистрация раньше жила ТОЛЬКО в
	// diagnostics.jsx's useServiceWorker (ленивая — только при первом заходе
	// на "Диагностика"). Плеер (И4, задача 4.1) перехватывает Range через SW —
	// без SW /files-content/* просто улетал бы в сеть и получал 404 у ЛЮБОГО
	// пользователя, ни разу не открывавшего Диагностику. Регистрация здесь —
	// сразу при загрузке приложения, безусловно. register() идемпотентен
	// (повторный вызов с тем же scriptURL из diagnostics.jsx резолвится в ТУ
	// ЖЕ регистрацию, не создаёт вторую) — оставлен как есть, ради статуса на
	// экране диагностики.
	// Этап E, найдено живой проверкой пользователя — раньше здесь стояло
	// `if (!import.meta.env.DEV)`, потому что emitServiceWorker (vite.config.js)
	// работает только на build, и в dev регистрировать было нечего (404).
	// vite.config.js's devServiceWorkerPlugin теперь раздаёт service-worker.js
	// и в dev (с IS_DEV-веткой внутри самого SW — precache/cache-first статики
	// выключены, чтобы не сломать HMR), поэтому регистрация безусловна.
	navigator.serviceWorker
		.register(`${import.meta.env.BASE_URL}service-worker.js`)
		.then(async (registration) => {
			logInfo("service worker зарегистрирован");
			// TZ §2.6 — "обнаружена новая версия": чисто наблюдательный колбэк,
			// ничего не меняет в самой регистрации/апдейте.
			registration.addEventListener("updatefound", () => traceRecord("sw-update-found", {}));
			// controllerchange мог не успеть сработать до этой проверки (или не
			// сработать вовсе, если clients.claim() уже отработал до подписки на
			// событие) — прямой чек после готовности как подстраховка.
			await navigator.serviceWorker.ready;
			if (!navigator.serviceWorker.controller) reloadForFreshServiceWorker();
		})
		.catch(() => {});
}

const root = document.getElementById("app");
root.replaceChildren();

// Э4.4 ТЗ-NATIVE-APPS — буквально "не грузить приложение дальше": проверка
// ДО render(<App/>), не внутри неё — весь остальной код приложения (домен,
// IndexedDB, ключи) не должен инициализироваться на слишком старом движке.
// Только Android (getPlatform().os) — на iOS (Capacitor, ещё не создан, Э5)
// движок WKWebView, UA не содержит "Chrome/N" вовсе, парсер честно вернёт
// null/"слишком стар" — их сюда пускать нельзя, ТЗ (раздел 5) ограничивает
// это требование явно Android'ом.
if (__TARGET__ === "capacitor" && getPlatform().os === "android" && isChromiumTooOld(navigator.userAgent)) {
	render(<WebViewOutdated />, root);
} else {
	render(<App />, root);
}
