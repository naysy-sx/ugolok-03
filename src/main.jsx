import "./styles/fonts.css";
import "./styles/minimal.css";
import "./styles/prosemirror.css";
import "./styles/custom.css";
import { render } from "preact";
import App from "./app.jsx";
import { startIdleWatcher } from "./ui/signals/auth.js";
import { BUILD_HASH } from "./config.js";
import { logInfo } from "./core/diag/boot-log.js";
// TZ-diag-trace.md — main.jsx не домен, импорт трассировщика напрямую
// разрешён и здесь единственно уместен (§0.3 запрещает это только домену).
import { record as traceRecord, isTraceEnabled } from "./core/diag/call-trace.js";

logInfo(`запуск, сборка ${BUILD_HASH}`);

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
	refreshing = true;
	location.reload();
}

if ("serviceWorker" in navigator) {
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
render(<App />, document.getElementById("app"));
